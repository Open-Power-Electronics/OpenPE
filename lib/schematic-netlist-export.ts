import type { Part } from './circuit';
import { projectNativeFiles } from './kicad-project';
import { partFields, propertyValue, unitGraphics } from './library';
import { pcbPinKey, schematicPCBNets } from './pcb-sync';
import type { Project } from './project';
import { child, children, val, type SExpr } from './sexpr';
import { participatesInSimulation } from './simulation-participation';
import { symbolRole } from './symbol-role';

const escapes: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
  '\t': '&#9;',
  '\n': '&#10;',
  '\r': '&#13;',
};

function xml(value: string): string {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uD800-\uDFFF\uFFFE\uFFFF]/u.test(value))
    throw new Error('Schematic netlist contains text that cannot be represented in XML 1.0.');
  return value.replace(/[&<>"'\t\n\r]/g, (character) => escapes[character]);
}

const mandatoryFields = ['Reference', 'Value', 'Footprint', 'Datasheet', 'Description'];
const assemblyFlags = [
  ['in_bom', 'no', 'exclude_from_bom'],
  ['on_board', 'no', 'exclude_from_board'],
  ['in_pos_files', 'no', 'exclude_from_pos_files'],
  ['dnp', 'yes', 'dnp'],
] as const;

function componentData(part: Part) {
  const raw = part.raw ?? [];
  const fields = partFields(part);
  for (const field of children(raw, 'property')) {
    if (child(field, 'private') || field.includes('private')) delete fields[val(field)];
  }
  return {
    fields: Object.entries(fields).sort(([a], [b]) => a.localeCompare(b, 'en')),
    flags: [
      ...assemblyFlags
        .filter(([native, excluded]) => val(child(raw, native)) === excluded)
        .map(([, , exported]) => exported),
      ...(participatesInSimulation(part) ? [] : ['exclude_from_sim']),
    ],
  };
}

function pinData(definition: SExpr) {
  const number = val(child(definition, 'number'));
  if (!number.trim() || /^\[.*\]$/s.test(number))
    throw new Error('Schematic netlist requires explicit individual symbol pin numbers.');
  return {
    number,
    name: val(child(definition, 'name')),
    type: val(definition),
  };
}

/** KiCad intermediate XML for the primary, independent schematic. */
export function exportSchematicNetlist(project: Project): string {
  const circuit = project.schematic;
  const components = new Map<string, Part[]>();
  const references = new Map<string, string>();
  const libraries = new Map<string, { lib: string; name: string; definition: SExpr }>();
  for (const part of circuit.parts) {
    const definition = circuit.libraries[part.libId];
    if (
      child(definition, 'jumper_pin_groups') ||
      val(child(definition, 'duplicate_pin_numbers_are_jumpers')) === 'yes' ||
      child(definition, 'pin_maps') ||
      child(part.raw ?? [], 'pin_map_override')
    )
      throw new Error(`${part.ref}: schematic netlist does not support jumper groups or pin maps.`);
    const ref = part.ref.toUpperCase();
    const previous = references.get(ref);
    if (previous !== undefined && previous !== part.ref)
      throw new Error(`Schematic netlist references must be unique: ${part.ref}.`);
    references.set(ref, part.ref);
    if (!components.has(part.ref)) components.set(part.ref, []);
    components.get(part.ref)!.push(part);
    const separator = part.libId.indexOf(':');
    if (!libraries.has(part.libId))
      libraries.set(part.libId, {
        lib: separator === -1 ? '' : part.libId.slice(0, separator),
        name: part.libId.slice(separator + 1),
        definition,
      });
  }

  const lines: string[] = [];
  const encoder = new TextEncoder();
  let bytes = 0;
  const write = (line: string) => {
    bytes += encoder.encode(line).byteLength + 1;
    if (bytes > 32 * 1024 * 1024) throw new Error('Schematic netlist exceeds 32 MiB.');
    lines.push(line);
  };
  const native = projectNativeFiles(project);
  // Native materialization emits the owning schematic before independent files.
  const sourceName = xml(native.files.find((file) => /\.kicad_sch$/i.test(file.name))!.name);
  const titleBlock = child(circuit.original ?? [], 'title_block') ?? [];
  write('<?xml version="1.0" encoding="UTF-8"?>');
  write('<export version="E">');
  write('  <design>');
  write(`    <source>${sourceName}</source>`);
  write('    <tool>OpenPE</tool>');
  write('    <sheet number="1" name="/" tstamps="/">');
  write('      <title_block>');
  write(`        <title>${xml(circuit.title)}</title>`);
  for (const key of ['company', 'rev', 'date']) {
    const value = val(child(titleBlock, key));
    if (value) write(`        <${key}>${xml(value)}</${key}>`);
  }
  write(`        <source>${sourceName}</source>`);
  write('      </title_block>');
  write('    </sheet>');
  write('  </design>');
  write('  <components>');

  const nodeElements = new Map<string, string>();
  const usedLibraries = new Set<string>();
  for (const [ref, units] of [...components].sort(([a], [b]) =>
    a.localeCompare(b, 'en', { numeric: true }),
  )) {
    units.sort((a, b) => (a.unit ?? 1) - (b.unit ?? 1));
    const first = units[0];
    const { lib, name, definition } = libraries.get(first.libId)!;
    const { fields, flags } = componentData(first);
    const metadata = JSON.stringify({ fields, flags });
    if (
      new Set(units.map((part) => part.unit ?? 1)).size !== units.length ||
      units
        .slice(1)
        .some(
          (part) =>
            part.libId !== first.libId ||
            part.value !== first.value ||
            JSON.stringify(componentData(part)) !== metadata,
        )
    )
      throw new Error(`${ref}: schematic netlist requires distinct units with matching metadata.`);
    const marker = ref.startsWith('#') || symbolRole(definition, first) === 'marker';
    for (const part of units) {
      const pins = unitGraphics(definition, part.unit ?? 1).flatMap((group) =>
        children(group, 'pin'),
      );
      if (children(part.raw ?? [], 'pin').some((pin) => child(pin, 'alternate')))
        throw new Error(`${ref}: schematic netlist does not support alternate pin functions.`);
      for (const pin of pins) {
        const { number, name: pinName, type } = pinData(pin);
        if (marker) continue;
        const pinKey = pcbPinKey(ref, number);
        const element = `      <node ref="${xml(ref)}" pin="${xml(number)}" pinfunction="${xml(pinName)}" pintype="${xml(type)}"/>`;
        const old = nodeElements.get(pinKey);
        if (old !== undefined && old !== element)
          throw new Error(`${ref} pin ${number}: schematic netlist has conflicting pin metadata.`);
        nodeElements.set(pinKey, element);
      }
    }
    if (marker) continue;
    if (!ref.trim() || ref.includes('?'))
      throw new Error('Annotate schematic component references before exporting the netlist.');
    usedLibraries.add(first.libId);
    write(`    <comp ref="${xml(ref)}">`);
    write(`      <value>${xml(first.value || '~')}</value>`);
    const byField = new Map(fields);
    for (const field of ['Footprint', 'Datasheet', 'Description']) {
      const value = byField.get(field);
      if (value) write(`      <${field.toLowerCase()}>${xml(value)}</${field.toLowerCase()}>`);
    }
    write('      <fields>');
    for (const [field, value] of fields)
      write(`        <field name="${xml(field)}">${xml(value)}</field>`);
    write('      </fields>');
    write(
      `      <libsource lib="${xml(lib)}" part="${xml(name)}" description="${xml(byField.get('Description') ?? '')}"/>`,
    );
    for (const [name, value] of fields) {
      if (
        !mandatoryFields.includes(name) &&
        name !== 'exclude_from_sim' &&
        !assemblyFlags.some(([, , exported]) => exported === name)
      )
        write(`      <property name="${xml(name)}" value="${xml(value)}"/>`);
    }
    for (const flag of flags) write(`      <property name="${flag}"/>`);
    write('      <sheetpath names="/" tstamps="/"/>');
    write(`      <tstamps>${units.map((part) => part.id).join(' ')}</tstamps>`);
    write('    </comp>');
  }
  write('  </components>');
  write('  <libparts>');
  for (const id of usedLibraries) {
    const { lib, name, definition } = libraries.get(id)!;
    write(`    <libpart lib="${xml(lib)}" part="${xml(name)}">`);
    const description = propertyValue(definition, 'Description');
    const docs = propertyValue(definition, 'Datasheet');
    if (description) write(`      <description>${xml(description)}</description>`);
    if (docs) write(`      <docs>${xml(docs)}</docs>`);
    write('      <pins>');
    const exported = new Set<string>();
    for (const unit of children(definition, 'symbol')) {
      if (/_\d+_2$/.test(val(unit))) continue;
      for (const pin of children(unit, 'pin')) {
        const { number, name, type } = pinData(pin);
        if (exported.has(number)) continue;
        exported.add(number);
        write(`        <pin num="${xml(number)}" name="${xml(name)}" type="${xml(type)}"/>`);
      }
    }
    write('      </pins>');
    write('    </libpart>');
  }
  write('  </libparts>');
  write('  <libraries/>');
  write('  <nets>');
  let code = 0;
  for (const net of schematicPCBNets(circuit)) {
    const nodes = net.pins.flatMap((key) => nodeElements.get(key) ?? []);
    if (!nodes.length) continue;
    write(`    <net code="${++code}" name="${xml(net.name)}">`);
    nodes.forEach(write);
    write('    </net>');
  }
  write('  </nets>');
  write('</export>');
  return lines.join('\n') + '\n';
}
