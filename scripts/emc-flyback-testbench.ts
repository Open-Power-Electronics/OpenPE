import { createHash } from 'node:crypto';
import {
  createPart,
  libraries,
  pinPositions,
  serializeCircuit,
  parseCircuit,
  snap,
  type Circuit,
} from '../lib/circuit';
import { createLibraryPart, unitGraphics } from '../lib/library';
import { moveSelection } from '../lib/schematic-edit';
import { child, children, parseSExpr, quote, val, num, writeSExpr, type SExpr } from '../lib/sexpr';

const definitions = [
  ['V1', 'Simulation_SPICE:VDC', 40.64, 'EMC_VIN', 'PGND', 'Input supply', 'dc=24'],
  ['R21', 'Device:R', 116.84, 'EMC_VIN', 'VBUS', 'Input source resistance', '10m'],
  ['V2', 'Simulation_SPICE:VDC', 193.04, 'VCC', 'PGND', 'Ideal controller supply', 'dc=12'],
  ['R22', 'Device:R', 269.24, 'VOUT', 'SGND', 'Output load', '100'],
  [
    'I1',
    'Simulation_SPICE:IPULSE',
    345.44,
    'VOUT',
    'SGND',
    'Output load step',
    'y1=0.5 y2=0 td=2m tr=10u tf=10u tw=2m per=1',
  ],
] as const;
const refs: readonly string[] = definitions.map(([ref]) => ref);
const stable = (name: string) => {
  const hash = createHash('sha256').update(`emc-flyback-testbench:${name}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
};
const wireIds = new Set(refs.flatMap((ref) => [stable(`${ref}:wire:0`), stable(`${ref}:wire:1`)]));
const labelIds = new Set(
  refs.flatMap((ref) => [stable(`${ref}:label:0`), stable(`${ref}:label:1`)]),
);
const noteIds = new Set(['title', 'subtitle', ...refs].map((ref) => stable(`note:${ref}`)));
const frameId = stable('frame');
const panelBounds: Record<string, readonly [number, number, number, number]> = {
  '1086693a-7d08-40be-999e-c202f3fb9d7d': [12.7, 22.86, 179.07, 99.06],
  '2a7fd716-60f9-4840-954b-0e152256dbae': [12.7, 101.6, 179.07, 121.92],
  '7473832d-5dc5-47bc-9d58-88a35352ba6d': [12.7, 124.46, 179.07, 200.66],
  '8a7019e2-c857-454c-b3ad-403b80149493': [181.61, 22.86, 398.78, 121.92],
  'a36c5800-1500-4d96-a3ce-d4e668e5ed1b': [181.61, 124.46, 285.75, 200.66],
  'cd418da6-d581-4f64-b096-10b7b70b373d': [288.29, 124.46, 398.78, 200.66],
};
export const isEmcCircuitFrame = (node: SExpr) =>
  node[0] === 'polyline' && Object.hasOwn(panelBounds, val(child(node, 'uuid')));
const rectanglePoints = ([left, top, right, bottom]: readonly number[]): SExpr => [
  'pts',
  ...[
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
    [left, top],
  ].map(([x, y]) => ['xy', String(x), String(y)] as SExpr),
];

/** Section 7 contains only the upstream datasheet link notes; component fields remain. */
export function isEmcDatasheetSection(node: SExpr) {
  if (node[0] === 'polyline')
    return val(child(node, 'uuid')) === '17e80f77-7e62-4766-b2dc-c453821417b6';
  const at = child(node, 'at');
  return (
    node[0] === 'text' &&
    !!at &&
    num(at) >= 12.7 &&
    num(at) <= 299.72 &&
    num(at, 2) >= 205.74 &&
    num(at, 2) <= 250.01
  );
}
function benchNotes(circuit: Circuit) {
  circuit.original = (circuit.original || ['kicad_sch']).filter(
    (node) =>
      !Array.isArray(node) ||
      (!isEmcDatasheetSection(node) &&
        !noteIds.has(val(child(node, 'uuid'))) &&
        val(child(node, 'uuid')) !== frameId),
  );
  for (const line of children(circuit.original, 'polyline')) {
    const bounds = panelBounds[val(child(line, 'uuid'))];
    if (bounds) line[line.indexOf(child(line, 'pts')!)] = rectanglePoints(bounds);
  }
  const note = (name: string, text: string, x: number, y: number, bold = false): SExpr => [
    'text',
    quote(text),
    ['at', String(x), String(y), '0'],
    [
      'effects',
      ['font', ['size', bold ? '2' : '1.27', bold ? '2' : '1.27'], ...(bold ? ['bold'] : [])],
      ['justify', 'left', 'bottom'],
    ],
    ['uuid', quote(stable(`note:${name}`))],
  ];
  circuit.original.push(
    [
      'polyline',
      [
        'pts',
        ...[
          [12.7, -30.48],
          [398.78, -30.48],
          [398.78, 20.32],
          [12.7, 20.32],
          [12.7, -30.48],
        ].map(([x, y]) => ['xy', String(x), String(y)] as SExpr),
      ],
      ['stroke', ['width', '0.15'], ['type', 'dash']],
      ['fill', ['type', 'none']],
      ['uuid', quote(frameId)],
    ],
    note('title', 'SIMULATION TESTBENCH (virtual)', 15.24, -24.13, true),
    note(
      'subtitle',
      'V1/R21 feed VBUS after EMI/protection; V2 supplies controller VCC',
      20.32,
      -19.05,
    ),
    ...definitions.map(([ref, , x, , , caption]) => note(ref, caption, snap(x - 10.16), -13.97)),
  );
}

/** Explicit native design content; only the testbench moves, never the original circuit. */
export function prepareEmcFlybackTestbench(circuit: Circuit) {
  const existing = circuit.parts.filter((part) => refs.includes(part.ref));
  if (existing.length) {
    if (existing.length !== refs.length || existing.some((part) => part.id !== stable(part.ref)))
      throw new Error(
        'EMC Flyback testbench references must identify the complete generated bench.',
      );
    for (const [ref, , x] of definitions) {
      const part = circuit.parts.find((part) => part.ref === ref)!;
      const delta = { x: snap(x - part.x), y: snap(-part.y) };
      if (!delta.x && !delta.y) continue;
      Object.assign(
        circuit,
        moveSelection(
          circuit,
          [
            part.id,
            stable(`${ref}:wire:0`),
            stable(`${ref}:wire:1`),
            stable(`${ref}:label:0`),
            stable(`${ref}:label:1`),
          ],
          delta,
        ),
      );
    }
    benchNotes(circuit);
    return;
  }
  for (const [ref, libId, x, positive, negative, caption, params] of definitions) {
    const library = circuit.libraries[libId] ?? libraries[libId];
    if (!library) throw new Error(`Missing pinned testbench symbol ${libId}.`);
    circuit.libraries[libId] = structuredClone(library);
    const part =
      libId === 'Device:R'
        ? createPart(circuit, 'R', x, 0)
        : createLibraryPart(circuit, library, x, 0);
    part.id = stable(ref);
    part.ref = ref;
    part.value = libId === 'Device:R' ? params : '${SIM.PARAMS}';
    part.fields = {
      Footprint: '',
      Description: caption,
      ...(libId === 'Device:R'
        ? {}
        : {
            'Sim.Device': ref === 'I1' ? 'I' : 'V',
            'Sim.Type': ref === 'I1' ? 'PULSE' : 'DC',
            'Sim.Pins': '1=+ 2=-',
            'Sim.Params': params,
          }),
    };
    part.excludeFromSimulation = false;
    circuit.parts.push(part);
    const positions = pinPositions(part, library);
    const pins = unitGraphics(library, 1).flatMap((unit) => children(unit, 'pin'));
    for (const [i, pin] of pins.entries()) {
      const first = val(child(pin, 'number')) === '1';
      const endpoint = { x: positions[i].x, y: snap(positions[i].y + (first ? -5.08 : 5.08)) };
      circuit.wires.push({ id: stable(`${ref}:wire:${i}`), a: positions[i], b: endpoint });
      circuit.labels.push({
        id: stable(`${ref}:label:${i}`),
        ...endpoint,
        text: first ? positive : negative,
      });
    }
  }
  benchNotes(circuit);
}

/** Reconcile only bench records and section 7 notes, retaining all other native records. */
export function prepareEmcFlybackNativeTestbench(source: string) {
  const root = parseSExpr(source),
    circuit = parseCircuit(source);
  prepareEmcFlybackTestbench(circuit);
  const added = parseSExpr(
    serializeCircuit({
      ...circuit,
      parts: circuit.parts.filter((part) => refs.includes(part.ref)),
      wires: circuit.wires.filter((wire) => wireIds.has(wire.id)),
      labels: circuit.labels.filter((label) => labelIds.has(label.id)),
      junctions: [],
      noConnects: [],
      original: undefined,
    }),
  );
  const embedded = child(root, 'lib_symbols')!;
  for (const symbol of children(child(added, 'lib_symbols')!, 'symbol'))
    if (!children(embedded, 'symbol').some((existing) => val(existing) === val(symbol)))
      embedded.push(symbol);
  for (const symbol of children(added, 'symbol')) {
    child(symbol, 'in_bom')![1] = 'no';
    child(symbol, 'on_board')![1] = 'no';
    for (const project of children(child(symbol, 'instances')!, 'project'))
      project[1] = quote('emc-flyback');
  }
  const records = added.filter(
    (node): node is SExpr =>
      Array.isArray(node) && ['symbol', 'wire', 'label'].includes(String(node[0])),
  );
  records.push(
    ...circuit.original!.filter(
      (node): node is SExpr =>
        Array.isArray(node) &&
        (noteIds.has(val(child(node, 'uuid'))) ||
          val(child(node, 'uuid')) === frameId ||
          isEmcCircuitFrame(node)),
    ),
  );
  const replacements = new Map(records.map((node) => [val(child(node, 'uuid')), node]));
  const result = root
    .filter((node) => !Array.isArray(node) || !isEmcDatasheetSection(node))
    .map((node) => {
      if (!Array.isArray(node)) return node;
      const id = val(child(node, 'uuid')),
        replacement = replacements.get(id);
      if (replacement) {
        replacements.delete(id);
        return replacement;
      }
      return node;
    });
  result.push(...replacements.values());
  return writeSExpr(result) + '\n';
}
