import {
  createPart,
  emptyCircuit,
  libraries as bundledSymbols,
  parseCircuit,
  pinPositions,
  serializeCircuit,
  uid,
  type Circuit,
  type Part,
} from '../../../lib/circuit';
import {
  findSchematic,
  projectSchematics,
  replaceSchematic,
  serializeProject,
  type Project,
} from '../../../lib/project';
import { symbolUnits, unitGraphics } from '../../../lib/library';
import { fieldId, moveSelection, moveText, saveLabel } from '../../../lib/schematic-edit';
import { child, children, val } from '../../../lib/sexpr';
import { symbolBodyBounds } from '../../../lib/symbol-bounds';
import { commitWireRoutes } from '../../../lib/wiring';
import { parasiticsStudyOffset } from './study-placement';
import { prepareStudyConnection } from './study-connection';
import { parasiticPhysicalModels } from '../../../lib/parasitic-model';
import {
  analyzeLayoutParasitics,
  type LayoutParasiticsResult,
  type ParasiticsInput,
} from './analysis';

export type ParasiticsStudyInput = ParasiticsInput & { boardId: string; schematicId: string };
export type ParasiticsStudyValues = {
  resistanceOhm: number;
  partialInductanceNh: number | null;
};
export type ParasiticsStudy = {
  project: Project;
  schematicId: string;
  labels: { start: string; end: string };
  references: { resistor: string; inductor: string | null };
  values: ParasiticsStudyValues;
  omittedInductance: boolean;
  blockIds: string[];
};

/** Preserve measured precision; an unavailable inductance is never replaced by zero. */
export function parasiticsStudyValues(
  result: Pick<LayoutParasiticsResult, 'equivalentResistanceOhm' | 'shortestPartialInductanceNh'>,
): ParasiticsStudyValues {
  const resistanceOhm = result.equivalentResistanceOhm;
  const partialInductanceNh = result.shortestPartialInductanceNh;
  if (!Number.isFinite(resistanceOhm) || resistanceOhm <= 0)
    throw new Error('The measured DC resistance must be positive and finite.');
  if (
    partialInductanceNh !== null &&
    (!Number.isFinite(partialInductanceNh) ||
      partialInductanceNh <= 0 ||
      !Number.isFinite(partialInductanceNh * 1e-9) ||
      partialInductanceNh * 1e-9 <= 0)
  )
    throw new Error(
      'The measured partial inductance must be positive and finite or outside model.',
    );
  return { resistanceOhm, partialInductanceNh };
}

/** Native component Values use two decimal places in a supported SI unit. */
export function parasiticsComponentValue(value: number, unit: 'Ω' | 'H'): string {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error('The parasitic component value must be positive and finite.');
  const units = [
    ['G', 1e9],
    ['M', 1e6],
    ['k', 1e3],
    ['', 1],
    ['m', 1e-3],
    ['µ', 1e-6],
    ['n', 1e-9],
    ['p', 1e-12],
    ['f', 1e-15],
  ] as const;
  let index = units.findIndex(([, factor]) => value / factor >= 1 && value / factor < 1000);
  if (index >= 0 && Number((value / units[index][1]).toFixed(2)) >= 1000) index--;
  const text = index < 0 ? value.toExponential(2) : (value / units[index][1]).toFixed(2);
  const rounded = Number(text) * (index < 0 ? 1 : units[index][1]);
  if (!Number.isFinite(rounded) || rounded <= 0)
    throw new Error('The rounded parasitic component value must be positive and finite.');
  return `${text}${index < 0 ? '' : units[index][0]}${unit}`;
}

function freshReference(project: Project, prefix: string) {
  const used = new Set(
    projectSchematics(project).flatMap((sheet) =>
      sheet.parts.map((part) => part.ref.toLowerCase()),
    ),
  );
  let index = 1;
  while (used.has(`${prefix}${index}`.toLowerCase())) index++;
  return `${prefix}${index}`;
}

function studyEndpoints(project: Project, input: ParasiticsStudyInput) {
  const board = project.pcb!;
  const parts = new Map(project.schematic.parts.map((part) => [part.id, part]));
  const candidates: { id: string; name: string; description: string; qualify: boolean }[] = [];
  for (const footprint of board.footprints) {
    const reference = parts.get(footprint.symbolId ?? '')?.ref ?? footprint.reference ?? '';
    for (const pad of footprint.pads) {
      const name = `${reference.trim() || 'Pad'}.${pad.number.trim() || 'unnumbered'}`;
      candidates.push({
        id: pad.id,
        name: name.replace(/\s+/g, '_'),
        description: `${reference || `Footprint ${footprint.id}`}.${pad.number || '(unnumbered pad)'}`,
        qualify: !reference.trim() || !pad.number.trim() || /\s/.test(reference + pad.number),
      });
    }
  }
  for (const via of board.vias) {
    const name = `Via(${via.x},${via.y})mm`;
    candidates.push({ id: via.id, name, description: name, qualify: false });
  }
  const counts = new Map<string, number>();
  for (const endpoint of candidates)
    counts.set(endpoint.name, (counts.get(endpoint.name) ?? 0) + 1);
  const identities = candidates.map(({ id }) => id.replaceAll('-', '').toLowerCase());
  const resolve = (id: string) => {
    const endpoint = candidates.find((candidate) => candidate.id === id);
    if (!endpoint) throw new Error('A selected PCB terminal is no longer available.');
    let name = endpoint.name;
    if (endpoint.qualify || counts.get(name)! > 1) {
      const identity = id.replaceAll('-', '').toLowerCase();
      let tag = '';
      for (let length = 8; length <= identity.length; length++) {
        const prefix = identity.slice(0, length);
        if (identities.filter((candidate) => candidate.startsWith(prefix)).length === 1) {
          tag = prefix;
          break;
        }
      }
      if (!tag) throw new Error('The selected PCB terminal identifiers are not unique.');
      name += `_${tag}`;
    }
    return { id, name, description: endpoint.description };
  };
  const start = resolve(input.startId);
  const end = resolve(input.endId);
  if (start.name === end.name)
    throw new Error('The selected PCB terminals need distinct endpoint labels.');
  return { start, end };
}

function terminalLabels(project: Project, endpoints: ReturnType<typeof studyEndpoints>) {
  const used = new Set([
    ...projectSchematics(project).flatMap((sheet) => [
      ...sheet.labels.map((label) => label.text),
      ...sheet.parts.flatMap((part) => {
        const library = sheet.libraries[part.libId];
        const definitions = unitGraphics(library, part.unit || 1).flatMap((unit) =>
          children(unit, 'pin'),
        );
        return definitions.flatMap((pin) =>
          val(pin) !== 'power_in'
            ? []
            : child(library, 'power') && definitions.length === 1
              ? [part.value]
              : pin.includes('hide') || val(child(pin, 'hide')) === 'yes'
                ? [val(child(pin, 'name'))]
                : [],
        );
      }),
    ]),
    ...project.pcb!.nets.map((net) => net.name),
  ]);
  let index = 1;
  while (true) {
    const suffix = index === 1 ? '' : `_S${index}`;
    const labels = {
      start: `LP_${endpoints.start.name}${suffix}`,
      end: `LP_${endpoints.end.name}${suffix}`,
    };
    if (!used.has(labels.start) && !used.has(labels.end)) return labels;
    index++;
  }
}

function horizontalPins(circuit: Circuit, part: Part) {
  const library = circuit.libraries[part.libId];
  if (
    children(library, 'property').some((property) =>
      /^(?:spice|sim[._]|OpenPE\.(?:ModelSource|PassiveModel|SourceType|InitialVoltage|InitialCurrent)$)/i.test(
        val(property),
      ),
    )
  )
    throw new Error(`The embedded ${part.libId} symbol has unsupported study simulation defaults.`);
  const definitions = unitGraphics(library, 1).flatMap((unit) => children(unit, 'pin'));
  const signature = (pins: typeof definitions) =>
    pins
      .map((pin) =>
        JSON.stringify([
          val(child(pin, 'number')),
          child(pin, 'at')?.slice(1),
          child(pin, 'length')?.slice(1),
          pin[1],
        ]),
      )
      .sort()
      .join('|');
  const canonical = unitGraphics(bundledSymbols[part.libId], 1).flatMap((unit) =>
    children(unit, 'pin'),
  );
  const body = symbolBodyBounds(library);
  if (
    child(library, 'power') ||
    symbolUnits(library) !== 1 ||
    definitions.length !== 2 ||
    definitions.some((pin) => val(pin) !== 'passive') ||
    signature(definitions) !== signature(canonical) ||
    definitions
      .map((pin) => val(child(pin, 'number')))
      .sort()
      .join() !== '1,2' ||
    !body ||
    [body.x, body.y, body.x + body.width, body.y + body.height].some(
      (coordinate) => Math.abs(coordinate) > 7.62,
    )
  )
    throw new Error(`The embedded ${part.libId} symbol is outside the supported study geometry.`);
  const points = pinPositions(part, circuit.libraries[part.libId]).sort((a, b) => a.x - b.x);
  if (
    points.length !== 2 ||
    Math.abs(points[0].y - part.y) > 0.0001 ||
    Math.abs(points[1].y - part.y) > 0.0001 ||
    points[0].x >= part.x ||
    points[1].x <= part.x ||
    points.some((point) => Math.abs(point.x - part.x) > 7.62)
  )
    throw new Error(
      `The embedded ${part.libId} symbol needs two bounded horizontal study terminals.`,
    );
  return points as [(typeof points)[number], (typeof points)[number]];
}

/** Insert an editable native series model at the selected End terminal in one project candidate. */
export function prepareParasiticsStudy(
  project: Project,
  input: ParasiticsStudyInput,
): ParasiticsStudy {
  if (!project.pcb || project.pcb.id !== input.boardId)
    throw new Error('This PCB layout is no longer in the project.');
  const target = findSchematic(project, input.schematicId);
  if (!target) throw new Error('This schematic file is no longer in the project.');
  const measurement = analyzeLayoutParasitics(project.pcb, input);
  const values = parasiticsStudyValues(measurement);
  const endpoints = studyEndpoints(project, input);
  const labels = terminalLabels(project, endpoints);
  const connected = prepareStudyConnection(project, target, input.startId, input.endId, labels);
  const provenance = {
    'OpenPE.Parasitics.BoardId': project.pcb.id,
    'OpenPE.Parasitics.StartId': input.startId,
    'OpenPE.Parasitics.EndId': input.endId,
    'OpenPE.Parasitics.Start': endpoints.start.description,
    'OpenPE.Parasitics.End': endpoints.end.description,
    'OpenPE.Parasitics.Connection': 'series',
    'OpenPE.Parasitics.GroupId': uid(),
    'OpenPE.Parasitics.StartLabel': labels.start,
    'OpenPE.Parasitics.EndLabel': labels.end,
  };
  let circuit = emptyCircuit();
  circuit.id = target.id;
  circuit.title = target.title;
  // Existing native definitions are authoritative. createPart supplies a pinned
  // official symbol only when this sheet does not already own that library ID.
  for (const id of ['Device:R', 'Device:L'])
    if (target.libraries[id]) circuit.libraries[id] = target.libraries[id];

  const resistor = createPart(circuit, 'R', 22.86, 12.7);
  resistor.ref = freshReference(project, 'R');
  resistor.value = parasiticsComponentValue(values.resistanceOhm, 'Ω');
  resistor.rotation = 90;
  resistor.excludeFromSimulation = false;
  resistor.fields = {
    ...resistor.fields,
    Footprint: '',
    ...provenance,
    'OpenPE.Parasitics.Role': 'resistor',
  };
  circuit.parts.push(resistor);
  let inductor: Part | null = null;
  if (values.partialInductanceNh !== null) {
    inductor = createPart(circuit, 'L', 43.18, 12.7);
    inductor.ref = freshReference(project, 'L');
    inductor.value = parasiticsComponentValue(values.partialInductanceNh * 1e-9, 'H');
    inductor.rotation = 90;
    inductor.excludeFromSimulation = false;
    inductor.fields = {
      ...inductor.fields,
      Footprint: '',
      ...provenance,
      'OpenPE.Parasitics.Role': 'inductor',
    };
    circuit.parts.push(inductor);
  }
  const [left, right] = horizontalPins(circuit, resistor);
  const start = { x: 12.7, y: 12.7 };
  const end = { x: inductor ? 53.34 : 33.02, y: start.y };
  const routes = [[start, left]];
  if (inductor) {
    const [inductorLeft, inductorRight] = horizontalPins(circuit, inductor);
    routes.push([right, inductorLeft], [inductorRight, end]);
  } else routes.push([right, end]);
  circuit = commitWireRoutes(circuit, routes);
  circuit = saveLabel(circuit, { text: labels.start, position: start }).circuit;
  circuit = saveLabel(circuit, { text: labels.end, position: end }).circuit;

  // Reuse normal symbol materialization before changing only native instance
  // manufacturing flags. These virtual elements never create PCB packages.
  circuit = parseCircuit(serializeCircuit(circuit));
  for (const part of circuit.parts) {
    for (const name of ['in_bom', 'on_board']) {
      const flag = child(part.raw!, name);
      if (!flag) throw new Error('The study symbol is missing a native manufacturing flag.');
      flag[1] = 'no';
    }
  }
  // Keep component Values readable above/below the compact series chain through
  // the same native field-position edits used by GUI.
  for (const part of [...circuit.parts]) {
    circuit = moveText(circuit, fieldId(part.id, 'Reference'), { x: part.x, y: 7.62 });
    circuit = moveText(circuit, fieldId(part.id, 'Value'), { x: part.x, y: 17.78 });
  }
  const offset = parasiticsStudyOffset(
    project.pcb,
    connected,
    circuit,
    input.startId,
    input.endId,
    measurement.netId,
  );
  circuit = moveSelection(
    circuit,
    [...circuit.parts, ...circuit.wires, ...circuit.labels, ...circuit.junctions].map(
      (object) => object.id,
    ),
    offset,
  );
  const merged: Circuit = {
    ...connected,
    parts: [...connected.parts, ...circuit.parts],
    wires: [...connected.wires, ...circuit.wires],
    labels: [...connected.labels, ...circuit.labels],
    junctions: [...connected.junctions, ...circuit.junctions],
    libraries: { ...circuit.libraries, ...target.libraries },
  };
  const next = replaceSchematic(project, merged);
  parasiticPhysicalModels(merged);
  serializeProject(next);
  return {
    project: next,
    schematicId: circuit.id,
    labels,
    references: { resistor: resistor.ref, inductor: inductor?.ref ?? null },
    values,
    omittedInductance: values.partialInductanceNh === null,
    blockIds: [...circuit.parts, ...circuit.wires, ...circuit.labels, ...circuit.junctions].map(
      (object) => object.id,
    ),
  };
}
