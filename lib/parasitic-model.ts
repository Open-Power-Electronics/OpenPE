import { libraries, type Circuit, type Part } from './circuit';
import { isOwnedCircuit } from './immutable-project';
import { partFields, partFootprint, symbolUnits, unitGraphics } from './library';
import type { PCB, Footprint, Pad } from './pcb';
import { documentPinKey, projectNetGroups } from './project-net-groups';
import { activePassiveModel, simulationModelSource } from './simulation-model-source';
import { child, children, val, type SExpr } from './sexpr';

export type ParasiticPhysicalModel = {
  parts: Part[];
  startLabel: string;
  endLabel: string;
};

const prefix = 'OpenPE.Parasitics.';
const modelKeys = ['Connection', 'GroupId', 'Role', 'StartLabel', 'EndLabel'] as const;
const sharedKeys = [
  'Connection',
  'GroupId',
  'StartLabel',
  'EndLabel',
  'BoardId',
  'StartId',
  'EndId',
  'Start',
  'End',
] as const;
const identityKeys = ['GroupId', 'BoardId', 'StartId', 'EndId'] as const;
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ownedModels = new WeakMap<Circuit, ParasiticPhysicalModel[]>();
const copy = (models: ParasiticPhysicalModel[]) =>
  models.map((model) => ({ ...model, parts: [...model.parts] }));

function fail(reason: string): never {
  throw new Error(`Invalid series parasitic model: ${reason}`);
}

function pinSignature(pins: SExpr[]) {
  return pins
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
}

function assertPrimitive(circuit: Circuit, part: Part, kind: 'R' | 'L') {
  const expectedId = `Device:${kind}`;
  const library = circuit.libraries[part.libId];
  const pins = library
    ? unitGraphics(library, part.unit || 1).flatMap((unit) => children(unit, 'pin'))
    : [];
  const canonical = unitGraphics(libraries[expectedId], 1).flatMap((unit) => children(unit, 'pin'));
  if (
    part.libId !== expectedId ||
    (part.unit || 1) !== 1 ||
    !library ||
    symbolUnits(library) !== 1 ||
    child(library, 'power') ||
    pins.length !== 2 ||
    pins.some((pin) => val(pin) !== 'passive') ||
    pins
      .map((pin) => val(child(pin, 'number')))
      .sort()
      .join(',') !== '1,2' ||
    pinSignature(pins) !== pinSignature(canonical)
  )
    fail(`${part.ref} requires the canonical two-terminal ${expectedId} pins.`);
  if (partFootprint(part)) fail(`${part.ref} must not have a Footprint.`);
  for (const name of ['on_board', 'in_bom']) {
    const flags = children(part.raw ?? [], name);
    if (flags.length !== 1 || flags[0].length !== 2 || val(flags[0]) !== 'no')
      fail(`${part.ref} requires native ${name} no.`);
  }
  const fields = {
    ...Object.fromEntries(
      children(library, 'property').map((field) => [val(field), val(field, 2)]),
    ),
    ...partFields(part),
  };
  if (
    simulationModelSource(fields) !== 'basic' ||
    (activePassiveModel(fields) !== undefined && activePassiveModel(fields) !== kind)
  )
    fail(`${part.ref} must retain its basic ${kind} model.`);
}

function assertBoardEndpoints(circuit: Circuit, board: PCB, models: ParasiticPhysicalModel[]) {
  if (!models.length) return;
  const selectedIds = new Set(
    models.flatMap((model) => {
      const fields = partFields(model.parts[0]);
      if (fields[prefix + 'BoardId'] !== board.id)
        fail('The originating PCB is no longer current.');
      return [fields[prefix + 'StartId'], fields[prefix + 'EndId']];
    }),
  );
  const pads = new Map<string, { footprint: Footprint; pad: Pad; numberCount: number }>();
  for (const footprint of board.footprints) {
    const numbers = new Map<string, number>();
    for (const pad of footprint.pads) numbers.set(pad.number, (numbers.get(pad.number) ?? 0) + 1);
    for (const pad of footprint.pads) {
      if (!selectedIds.has(pad.id)) continue;
      if (pads.has(pad.id)) fail('The originating PCB pad identities are ambiguous.');
      pads.set(pad.id, { footprint, pad, numberCount: numbers.get(pad.number)! });
    }
  }
  const parts = new Map(circuit.parts.map((part) => [part.id, part]));
  const modelParts = new Set(models.flatMap((model) => model.parts.map((part) => part.id)));
  const physicalKey = (part: Part, number: string) =>
    JSON.stringify([part.ref, part.libId, number]);
  const pins = new Map<string, string[]>();
  for (const part of circuit.parts) {
    const library = circuit.libraries[part.libId];
    for (const unit of unitGraphics(library, part.unit || 1))
      for (const pin of children(unit, 'pin')) {
        const number = val(child(pin, 'number'));
        const key = physicalKey(part, number);
        const matches = pins.get(key) ?? [];
        matches.push(documentPinKey(part.id, number));
        pins.set(key, matches);
      }
  }
  const networks = projectNetGroups(circuit);
  const byPin = new Map(
    networks.flatMap((group, index) => group.pins.map((pin) => [pin, index] as const)),
  );
  const byLabel = new Map(
    networks.flatMap((group, index) =>
      group.labels.map((label) => [circuit.labels[label].text, index] as const),
    ),
  );
  const netIds = new Set(board.nets.map((net) => net.id));
  for (const model of models) {
    const fields = partFields(model.parts[0]);
    let netId: string | null = null;
    for (const [terminal, label] of [
      ['StartId', model.startLabel],
      ['EndId', model.endLabel],
    ] as const) {
      const found = pads.get(fields[prefix + terminal]);
      const owner = found && parts.get(found.footprint.symbolId ?? '');
      if (!found || !owner || modelParts.has(owner.id) || !found.pad.number.trim())
        fail('A PCB endpoint no longer resolves to an exact original schematic pad.');
      if (found.numberCount !== 1) fail('A PCB endpoint no longer has one unambiguous pad number.');
      if (
        !found.pad.netId ||
        !netIds.has(found.pad.netId) ||
        (netId !== null && found.pad.netId !== netId)
      )
        fail('The originating PCB pads no longer share one assigned net.');
      netId = found.pad.netId;
      const matches = pins.get(physicalKey(owner, found.pad.number)) ?? [];
      if (matches.length !== 1) fail('A PCB endpoint no longer has one unambiguous schematic pin.');
      if (byPin.get(matches[0]) !== byLabel.get(label))
        fail('A PCB endpoint no longer connects to its declared LP outer net.');
    }
  }
}

/** Explicit native series groups are ideal interconnects only for the PCB
 * projection. Their R/L Values and participation remain independent SPICE data.
 * A supplied PCB revalidates exact pad ownership and outer-net association on
 * every call; structural caches never grant authority to another board. */
export function parasiticPhysicalModels(circuit: Circuit, board?: PCB): ParasiticPhysicalModel[] {
  const owned = isOwnedCircuit(circuit);
  const cached = owned ? ownedModels.get(circuit) : undefined;
  if (cached) {
    if (board) assertBoardEndpoints(circuit, board, cached);
    return copy(cached);
  }
  const groups = new Map<string, { parts: Part[]; fields: Record<string, string> }>();
  const labels = new Set<string>();
  for (const part of circuit.parts) {
    const fields = partFields(part);
    if (!modelKeys.some((key) => Object.hasOwn(fields, prefix + key))) continue;
    if (fields[prefix + 'Connection'] !== 'series')
      fail(`${part.ref} has no supported Connection.`);
    for (const key of sharedKeys) {
      const value = fields[prefix + key];
      if (!value?.trim() || value.length > 4096 || /[\u0000-\u001f]/.test(value))
        fail(`${part.ref} has invalid ${key}.`);
    }
    for (const key of identityKeys)
      if (!uuid.test(fields[prefix + key])) fail(`${part.ref} has invalid ${key}.`);
    if (fields[prefix + 'StartId'].toLowerCase() === fields[prefix + 'EndId'].toLowerCase())
      fail(`${part.ref} needs two distinct PCB terminal identities.`);
    const start = fields[prefix + 'StartLabel'],
      end = fields[prefix + 'EndLabel'];
    if (
      !start.startsWith('LP_') ||
      start.length <= 3 ||
      !end.startsWith('LP_') ||
      end.length <= 3 ||
      start === end
    )
      fail(`${part.ref} needs two distinct LP endpoint labels.`);
    const role = fields[prefix + 'Role'];
    if (role !== 'resistor' && role !== 'inductor') fail(`${part.ref} has invalid Role.`);
    assertPrimitive(circuit, part, role === 'resistor' ? 'R' : 'L');
    const id = fields[prefix + 'GroupId'].toLowerCase();
    const group = groups.get(id);
    if (group) {
      if (sharedKeys.some((key) => fields[prefix + key] !== group.fields[prefix + key]))
        fail(`${part.ref} disagrees with its group endpoint metadata.`);
      group.parts.push(part);
    } else {
      if (labels.has(start) || labels.has(end))
        fail('Different groups share an LP endpoint label.');
      labels.add(start);
      labels.add(end);
      groups.set(id, { parts: [part], fields });
    }
  }
  if (!groups.size) {
    if (owned) ownedModels.set(circuit, []);
    return [];
  }
  const networks = projectNetGroups(circuit);
  const byPin = new Map(
    networks.flatMap((group, index) => group.pins.map((pin) => [pin, index] as const)),
  );
  const byLabel = new Map(
    networks.flatMap((group, index) =>
      group.labels.map((label) => [circuit.labels[label].text, index] as const),
    ),
  );
  const modelPins = new Set(
    [...groups.values()].flatMap((group) =>
      group.parts.flatMap((part) => ['1', '2'].map((pin) => documentPinKey(part.id, pin))),
    ),
  );
  const models: ParasiticPhysicalModel[] = [];
  for (const group of groups.values()) {
    const resistor = group.parts.filter((part) => partFields(part)[prefix + 'Role'] === 'resistor');
    const inductor = group.parts.filter((part) => partFields(part)[prefix + 'Role'] === 'inductor');
    if (resistor.length !== 1 || inductor.length > 1)
      fail('A group requires one resistor and at most one inductor.');
    const startLabel = group.fields[prefix + 'StartLabel'],
      endLabel = group.fields[prefix + 'EndLabel'];
    if (
      circuit.labels.some(
        (label) => [startLabel, endLabel].includes(label.text) && label.scope === 'global',
      )
    )
      fail('LP endpoints require local labels.');
    const start = byLabel.get(startLabel),
      end = byLabel.get(endLabel);
    if (start === undefined || end === undefined || start === end)
      fail('LP endpoints are missing or joined by an ideal bypass.');
    const nodes = (part: Part) => ['1', '2'].map((pin) => byPin.get(documentPinKey(part.id, pin))!);
    const r = nodes(resistor[0]);
    if (new Set(r).size !== 2 || !r.includes(start))
      fail('The resistor must connect to the declared start endpoint.');
    if (inductor.length) {
      const l = nodes(inductor[0]);
      const middle = r.find((node) => node !== start)!;
      if (new Set(l).size !== 2 || middle === end || !l.includes(end) || !l.includes(middle))
        fail('The resistor and inductor must form one series chain between the LP endpoints.');
      const expected = new Set([
        documentPinKey(resistor[0].id, String(r.indexOf(middle) + 1)),
        documentPinKey(inductor[0].id, String(l.indexOf(middle) + 1)),
      ]);
      const actual = networks[middle].pins.filter((pin) => !pin.startsWith('physical:'));
      if (
        actual.some((pin) => !expected.has(pin)) ||
        new Set(actual).size !== 2 ||
        networks[middle].labels.length
      )
        fail('The R/L intermediate node must have only its two model pins and no labels.');
    } else if (!r.includes(end)) fail('The resistor must join both declared LP endpoints.');
    for (const node of [start, end])
      if (!networks[node].pins.some((pin) => !pin.startsWith('physical:') && !modelPins.has(pin)))
        fail('Both LP endpoints must connect to existing component pins.');
    models.push({ parts: [resistor[0], ...inductor], startLabel, endLabel });
  }
  if (owned) ownedModels.set(circuit, models);
  if (board) assertBoardEndpoints(circuit, board, models);
  return copy(models);
}
