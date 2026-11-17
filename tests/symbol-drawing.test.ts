import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyCircuit, parseCircuit, pinPositions, serializeCircuit, uid } from '../lib/circuit';
import { createProject, parseProject, serializeProject } from '../lib/project';
import { child, children, quote, val } from '../lib/sexpr';
import { partFields } from '../lib/library';
import {
  prepareSymbolDrawing,
  readSymbolDrawing,
  type SymbolDrawing,
  type SymbolDrawingInput,
} from '../lib/symbol-drawing';

const drawing = (): SymbolDrawing => ({
  graphics: [
    {
      type: 'rectangle',
      start: { x: -2.54, y: -2.54 },
      end: { x: 2.54, y: 2.54 },
      fill: 'background',
      width: 0.254,
    },
    { type: 'circle', center: { x: 0, y: -1.27 }, radius: 0.508, fill: 'none', width: 0.254 },
    {
      type: 'polyline',
      points: [
        { x: -1.27, y: 1.27 },
        { x: 0, y: 0 },
        { x: 1.27, y: 1.27 },
      ],
      fill: 'none',
      width: 0.254,
    },
  ],
  pins: [
    {
      number: '1',
      name: 'IN',
      x: -5.08,
      y: 0,
      rotation: 0,
      length: 2.54,
      type: 'input',
      shape: 'line',
    },
    {
      number: '2',
      name: 'OUT',
      x: 5.08,
      y: 0,
      rotation: 180,
      length: 2.54,
      type: 'output',
      shape: 'line',
    },
    {
      number: '3',
      name: 'VCC',
      x: 0,
      y: -5.08,
      rotation: 270,
      length: 2.54,
      type: 'power_in',
      shape: 'line',
    },
  ],
});
const input = (): SymbolDrawingInput => ({
  name: 'Custom controller',
  referencePrefix: 'U',
  value: 'Controller',
  position: { x: 25.4, y: 25.4 },
  drawing: drawing(),
});

test('custom drawing produces native editable symbol geometry with exact terminal coordinates', () => {
  const source = emptyCircuit(),
    before = structuredClone(source);
  const result = prepareSymbolDrawing(source, input());
  assert.deepEqual(source, before);
  const part = result.circuit.parts[0],
    library = result.circuit.libraries[part.libId];
  assert.equal(part.id, result.partId);
  assert.equal(part.ref, 'U1');
  assert.equal(part.excludeFromSimulation, true);
  assert.deepEqual(pinPositions(part, library), [
    { x: 20.32, y: 25.4 },
    { x: 30.48, y: 25.4 },
    { x: 25.4, y: 20.32 },
  ]);
  const native = serializeCircuit(result.circuit);
  assert.match(native, /\(lib_symbols/);
  const reopened = parseCircuit(native);
  assert.deepEqual(readSymbolDrawing(reopened, result.partId), input());
  const project = parseProject(serializeProject(createProject(reopened)));
  assert.deepEqual(readSymbolDrawing(project.schematic, result.partId), input());
  assert.deepEqual(child(children(library, 'symbol')[0], 'circle')?.slice(1, 3), [
    ['center', '0', '1.27'],
    ['radius', '0.508'],
  ]);
});

test('editing one native instance preserves its identity, fields, model mappings and other instances', () => {
  const made = prepareSymbolDrawing(emptyCircuit(), input());
  const source = parseCircuit(serializeCircuit(made.circuit)),
    part = source.parts[0];
  part.fields = {
    Footprint: 'Package:Controller',
    'Sim.Device': 'X',
    'Sim.Pins': '1=IN 2=OUT 3=VCC',
    Private: 'keep',
  };
  part.raw!.push([
    'property',
    quote('Hidden evidence'),
    quote('reviewed'),
    ['at', '35', '35', '0'],
    ['effects', ['font', ['size', '1', '1']], 'hide'],
  ]);
  const sibling = { ...structuredClone(part), id: uid(), ref: 'U2', x: 60, raw: undefined };
  source.parts.push(sibling);
  const oldLibrary = structuredClone(source.libraries[part.libId]);
  // A copied instance shares a definition; editing it must fork that definition.
  const revised = readSymbolDrawing(source, sibling.id);
  (revised.drawing.graphics[0] as { end: { x: number; y: number } }).end.y = 3.81;
  const result = prepareSymbolDrawing(source, { ...revised, partId: sibling.id });
  const edited = result.circuit.parts[1];
  assert.equal(edited.id, sibling.id);
  assert.equal(edited.ref, 'U2');
  assert.deepEqual(partFields(edited), partFields(sibling));
  assert.deepEqual(result.circuit.parts[0], part);
  assert.deepEqual(result.circuit.libraries[part.libId], oldLibrary);
  assert.notEqual(edited.libId, part.libId);
  const editOriginal = readSymbolDrawing(source, part.id);
  (editOriginal.drawing.graphics[1] as { radius: number }).radius = 0.762;
  const originalEdited = prepareSymbolDrawing(source, { ...editOriginal, partId: part.id });
  const raw = originalEdited.circuit.parts[0].raw!;
  assert.equal(val(child(raw, 'lib_id')), val(child(part.raw!, 'lib_id')));
  assert.equal(val(child(raw, 'lib_name')), originalEdited.circuit.parts[0].libId);
  assert.equal(
    val(
      children(raw, 'property').find((p) => val(p) === 'Hidden evidence'),
      2,
    ),
    'reviewed',
  );
  const reopened = parseCircuit(serializeCircuit(originalEdited.circuit));
  assert.equal(reopened.parts[0].id, part.id);
  assert.equal(reopened.parts[0].libId, originalEdited.circuit.parts[0].libId);
  assert.deepEqual(partFields(reopened.parts[0]), partFields(part));
});

test('terminal edits cannot silently detach wire, label, junction or no-connect anchors', () => {
  for (const kind of ['wire', 'wireInterior', 'label', 'junction', 'noConnect'] as const) {
    const { circuit, partId } = prepareSymbolDrawing(emptyCircuit(), input());
    const at = pinPositions(circuit.parts[0], circuit.libraries[circuit.parts[0].libId])[0];
    if (kind === 'wire') circuit.wires.push({ id: uid(), a: at, b: { x: at.x - 5.08, y: at.y } });
    else if (kind === 'wireInterior')
      circuit.wires.push({
        id: uid(),
        a: { x: at.x - 5.08, y: at.y },
        b: { x: at.x + 5.08, y: at.y },
      });
    else if (kind === 'label') circuit.labels.push({ id: uid(), ...at, text: 'Input' });
    else if (kind === 'junction') circuit.junctions.push({ id: uid(), ...at });
    else circuit.noConnects = [{ id: uid(), ...at }];
    const before = structuredClone(circuit);
    for (const edit of ['move', 'remove', 'renumber'] as const) {
      const revised = readSymbolDrawing(circuit, partId);
      if (edit === 'move') revised.drawing.pins[0].x -= 1.27;
      else if (edit === 'remove') revised.drawing.pins.shift();
      else revised.drawing.pins[0].number = '4';
      assert.throws(() => prepareSymbolDrawing(circuit, { ...revised, partId }), /Disconnect/);
      assert.deepEqual(circuit, before);
    }
    const revised = readSymbolDrawing(circuit, partId);
    revised.drawing.pins[0].name = 'SIGNAL';
    revised.drawing.pins[0].type = 'passive';
    const accepted = prepareSymbolDrawing(circuit, { ...revised, partId });
    assert.deepEqual(
      pinPositions(
        accepted.circuit.parts[0],
        accepted.circuit.libraries[accepted.circuit.parts[0].libId],
      ),
      pinPositions(circuit.parts[0], circuit.libraries[circuit.parts[0].libId]),
    );
    assert.deepEqual(accepted.circuit.wires, circuit.wires);
  }
});

test('drawing keeps native graphic and pin styling while editing supported geometry', () => {
  const { circuit, partId } = prepareSymbolDrawing(emptyCircuit(), input());
  const library = circuit.libraries[circuit.parts[0].libId],
    group = children(library, 'symbol')[0];
  const rectangle = child(group, 'rectangle')!,
    pin = children(group, 'pin')[0];
  child(rectangle, 'stroke')!.push(['color', '0.2', '0.3', '0.4', '1']);
  child(child(child(pin, 'name')!, 'effects')!, 'font')!.push('bold');
  const revised = readSymbolDrawing(circuit, partId);
  (revised.drawing.graphics[0] as { end: { x: number; y: number } }).end.x += 1.27;
  revised.drawing.pins[0].name = 'RENAMED';
  const accepted = prepareSymbolDrawing(circuit, { ...revised, partId });
  const changed = children(
    accepted.circuit.libraries[accepted.circuit.parts[0].libId],
    'symbol',
  )[0];
  assert.deepEqual(child(child(child(changed, 'rectangle')!, 'stroke')!, 'color'), [
    'color',
    '0.2',
    '0.3',
    '0.4',
    '1',
  ]);
  assert.ok(
    child(child(child(children(changed, 'pin')[0], 'name')!, 'effects')!, 'font')!.includes('bold'),
  );
});

test('unsupported symbol primitives and multi-unit definitions reject without erasing native data', () => {
  for (const primitive of ['arc', 'text', 'multiunit']) {
    const { circuit, partId } = prepareSymbolDrawing(emptyCircuit(), input());
    const library = circuit.libraries[circuit.parts[0].libId];
    if (primitive === 'multiunit') library.push(['symbol', '"Custom_2_1"']);
    else children(library, 'symbol')[0].push([primitive]);
    const before = structuredClone(circuit);
    assert.throws(() => readSymbolDrawing(circuit, partId), /Drawing/);
    assert.throws(() => prepareSymbolDrawing(circuit, { ...input(), partId }), /Drawing/);
    assert.deepEqual(circuit, before);
  }
});

test('invalid drawings and model pin renumbering reject atomically; exact accepted edits are no-ops', () => {
  const source = emptyCircuit();
  for (const mutate of [
    (d: SymbolDrawing) => {
      d.pins[1].number = d.pins[0].number;
    },
    (d: SymbolDrawing) => {
      d.pins[0].x = Number.NaN;
    },
    (d: SymbolDrawing) => {
      d.pins[0].x = -5.08001;
    },
    (d: SymbolDrawing) => {
      d.pins[0].length = 2.54001;
    },
    (d: SymbolDrawing) => {
      d.graphics[0].width = 0.25401;
    },
    (d: SymbolDrawing) => {
      (d.graphics[1] as { radius: number }).radius = -1;
    },
    (d: SymbolDrawing) => {
      d.graphics = [];
      d.pins = [];
    },
    (d: SymbolDrawing) => {
      d.graphics.push({
        type: 'polyline',
        points: [
          { x: 0, y: 0 },
          { x: 0, y: 0 },
        ],
      });
    },
  ]) {
    const revised = input();
    mutate(revised.drawing);
    assert.throws(() => prepareSymbolDrawing(source, revised), /symbol|Symbol/);
    assert.deepEqual(source, emptyCircuitWithId(source.id));
  }
  const { circuit, partId } = prepareSymbolDrawing(source, input());
  const same = readSymbolDrawing(circuit, partId);
  assert.equal(prepareSymbolDrawing(circuit, { ...same, partId }).circuit, circuit);
  circuit.parts[0].fields = { 'Sim.Pins': '1=1 2=2 3=3' };
  const revised = readSymbolDrawing(circuit, partId);
  revised.drawing.pins[0].number = '7';
  assert.throws(
    () => prepareSymbolDrawing(circuit, { ...revised, partId }),
    /Retain existing pin numbers/,
  );
});

function emptyCircuitWithId(id: string) {
  return { ...emptyCircuit(), id };
}

test('native precision is explicit and artwork editing retains an imported off-grid instance pose', () => {
  const { circuit, partId } = prepareSymbolDrawing(emptyCircuit(), input());
  circuit.parts[0].x = 25.3;
  const revised = readSymbolDrawing(circuit, partId);
  (revised.drawing.graphics[1] as { radius: number }).radius = 0.5081;
  const accepted = prepareSymbolDrawing(circuit, { ...revised, partId });
  assert.equal(accepted.circuit.parts[0].x, 25.3);
  assert.deepEqual(
    readSymbolDrawing(parseCircuit(serializeCircuit(accepted.circuit)), partId).drawing,
    revised.drawing,
  );
  const library = circuit.libraries[circuit.parts[0].libId];
  child(child(children(library, 'symbol')[0], 'circle')!, 'radius')![1] = '0.50801';
  const before = structuredClone(circuit);
  assert.throws(() => readSymbolDrawing(circuit, partId), /Invalid symbol drawing|precision/);
  assert.throws(
    () => prepareSymbolDrawing(circuit, { ...revised, partId }),
    /Invalid symbol drawing|precision/,
  );
  assert.deepEqual(circuit, before);
});
