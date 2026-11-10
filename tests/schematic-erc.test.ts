import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyCircuit, type Circuit, type Part } from '../lib/circuit';
import { runSchematicERC } from '../lib/schematic-erc';
import { quote, type SExpr } from '../lib/sexpr';

const pin = (type: string, number = '1', name = 'PIN', x = 0, y = 0, hidden = false): SExpr => [
  'pin',
  type,
  'line',
  ['at', String(x), String(y), '0'],
  ['length', '2.54'],
  ['name', quote(name)],
  ['number', quote(number)],
  ...(hidden ? ['hide'] : []),
];
function symbol(type: string, marker = false, hidden = false, name = 'PIN'): SExpr {
  return [
    'symbol',
    quote(`Test:${type}`),
    ...(marker ? [['power'] as SExpr] : []),
    ['symbol', quote('Test_1_1'), pin(type, '1', name, 0, 0, hidden)],
  ];
}
function part(circuit: Circuit, type: string, x: number, y: number, options: Partial<Part> = {}) {
  const index = circuit.parts.length + 1;
  const libId = `Test:${type}`;
  circuit.libraries[libId] ??= symbol(type);
  const value: Part = {
    id: `part-${index}`,
    ref: `U${index}`,
    libId,
    value: 'test',
    x,
    y,
    rotation: 0,
    ...options,
  };
  circuit.parts.push(value);
  return value;
}
const wire = (circuit: Circuit, ax: number, ay: number, bx: number, by: number) => {
  const value = {
    id: `wire-${circuit.wires.length + 1}`,
    a: { x: ax, y: ay },
    b: { x: bx, y: by },
  };
  circuit.wires.push(value);
  return value;
};
const issues = (circuit: Circuit, ruleId: string) =>
  runSchematicERC(circuit).issues.filter((issue) => issue.ruleId === ruleId);

test('incidental crossings remain separate while explicit junctions expose output conflicts', () => {
  const circuit = emptyCircuit();
  const a = part(circuit, 'output', -10, 0),
    b = part(circuit, 'output', 0, -10);
  wire(circuit, -10, 0, 10, 0);
  wire(circuit, 0, -10, 0, 10);
  assert.equal(issues(circuit, 'erc.output-conflict').length, 0);
  circuit.junctions.push({ id: 'junction', x: 0, y: 0 });
  const result = issues(circuit, 'erc.output-conflict');
  assert.equal(result.length, 1);
  assert.equal(result[0].severity, 'error');
  assert.deepEqual(result[0].objectIds, [a.id, b.id]);
});

test('labels join disconnected geometry and simulation-excluded physical pins still drive nets', () => {
  const circuit = emptyCircuit();
  part(circuit, 'output', 0, 0, { excludeFromSimulation: true });
  part(circuit, 'input', 20, 0);
  circuit.labels.push(
    { id: 'local', text: 'SIGNAL', x: 0, y: 0 },
    { id: 'global', text: 'SIGNAL', scope: 'global', shape: 'input', x: 20, y: 0 },
  );
  assert.equal(issues(circuit, 'erc.input-undriven').length, 0);
  assert.equal(issues(circuit, 'erc.pin-unconnected').length, 0);
  assert.equal(issues(circuit, 'erc.label-dangling').length, 0);
});

test('hidden power pins join named rails and power flags supply a declared driver', () => {
  const circuit = emptyCircuit();
  const consumer = part(circuit, 'power_in', 20, 0);
  circuit.libraries[consumer.libId] = symbol('power_in', false, true, 'VCC');
  const marker = part(circuit, 'power_in', 0, 0, { ref: '#PWR1', libId: 'Test:VCC', value: 'VCC' });
  circuit.libraries[marker.libId] = symbol('power_in', true);
  assert.equal(issues(circuit, 'erc.power-undriven').length, 1);
  const flag = part(circuit, 'power_out', 0, 0, { ref: '#FLG1', libId: 'Test:PWR_FLAG' });
  circuit.libraries[flag.libId] = symbol('power_out', true);
  assert.equal(issues(circuit, 'erc.power-undriven').length, 0);
  assert.equal(issues(circuit, 'erc.net-name-conflict').length, 0);
});

test('explicit net names override hidden pin defaults without hiding conflicting explicit aliases', () => {
  const circuit = emptyCircuit();
  const hidden = part(circuit, 'power_in', 0, 0);
  circuit.libraries[hidden.libId] = symbol('power_in', false, true, 'PAD');
  const ground = part(circuit, 'power_in', 0, 0, { ref: '#PWR1', libId: 'Test:GND', value: 'GND' });
  circuit.libraries[ground.libId] = symbol('power_in', true);
  assert.equal(issues(circuit, 'erc.net-name-conflict').length, 0);
  part(circuit, 'passive', 20, 0);
  circuit.labels.push({ id: 'explicit-pad', text: 'PAD', x: 20, y: 0 });
  assert.equal(
    issues(circuit, 'erc.net-name-conflict').length,
    1,
    'implicit PAD topology still joins the remote explicit PAD to explicit GND',
  );
});

test('valid multi-unit shared physical pins are counted once and unrelated duplicate references stay separate', () => {
  const circuit = emptyCircuit();
  const library: SExpr = [
    'symbol',
    '"Multi"',
    ['symbol', '"Multi_0_1"', pin('output')],
    ['symbol', '"Multi_1_1"'],
    ['symbol', '"Multi_2_1"'],
  ];
  circuit.libraries.Multi = library;
  part(circuit, 'output', 0, 0, { libId: 'Multi', ref: 'U1', unit: 1 });
  part(circuit, 'output', 20, 0, { libId: 'Multi', ref: 'U1', unit: 2 });
  assert.equal(issues(circuit, 'erc.reference-conflict').length, 0);
  assert.equal(issues(circuit, 'erc.output-conflict').length, 0);
  circuit.parts[1].unit = 1;
  assert.equal(issues(circuit, 'erc.reference-conflict').length, 1);
  assert.equal(
    issues(circuit, 'erc.output-conflict').length,
    0,
    'bad references cannot invent a connection',
  );
  circuit.parts[1].unit = 2;
  circuit.parts[1].libId = 'Test:output';
  assert.equal(issues(circuit, 'erc.reference-conflict').length, 1);
});

test('multi-unit field equality ignores property insertion order and retains shared physical joins', () => {
  const circuit = emptyCircuit();
  circuit.libraries.Multi = ['symbol', '"Multi"', ['symbol', '"Multi_0_1"', pin('output')]];
  part(circuit, 'output', 0, 0, {
    libId: 'Multi',
    ref: 'U1',
    unit: 1,
    fields: { Manufacturer: 'Example', Description: 'Dual' },
  });
  part(circuit, 'output', 20, 0, {
    libId: 'Multi',
    ref: 'U1',
    unit: 2,
    fields: { Description: 'Dual', Manufacturer: 'Example' },
  });
  part(circuit, 'input', 20, 0);
  const result = runSchematicERC(circuit);
  assert.equal(result.complete, true);
  assert.equal(
    result.issues.filter((issue) => issue.ruleId === 'erc.reference-conflict').length,
    0,
  );
  assert.equal(result.issues.filter((issue) => issue.ruleId === 'erc.pin-unconnected').length, 0);
  assert.equal(result.issues.filter((issue) => issue.ruleId === 'erc.input-undriven').length, 0);
});

test('inconsistent shared pin types are incomplete rather than depending on component order', () => {
  const circuit = emptyCircuit();
  circuit.libraries.Multi = [
    'symbol',
    '"Multi"',
    ['symbol', '"Multi_1_1"', pin('output')],
    ['symbol', '"Multi_2_1"', pin('input')],
  ];
  const first = part(circuit, 'output', 0, 0, { libId: 'Multi', ref: 'U1', unit: 1 });
  const second = part(circuit, 'input', 20, 0, { libId: 'Multi', ref: 'U1', unit: 2 });
  part(circuit, 'output', 20, 0);
  const before = structuredClone(circuit);
  const result = runSchematicERC(circuit);
  assert.equal(result.complete, false);
  assert.equal(result.truncated, false);
  const inconsistent = result.issues.filter(
    (issue) => issue.ruleId === 'erc.pin-type-inconsistent',
  );
  assert.equal(inconsistent.length, 1);
  assert.equal(inconsistent[0].severity, 'warning');
  assert.deepEqual(inconsistent[0].objectIds, [first.id, second.id]);
  assert.equal(result.issues.filter((issue) => issue.ruleId === 'erc.output-conflict').length, 0);
  assert.ok(result.notes.some((note) => note.includes('Inconsistent physical pin')));
  assert.deepEqual(circuit, before);
  circuit.parts.reverse();
  assert.deepEqual(runSchematicERC(circuit), result);
});

test('pin geometry follows unit, rotation and mirror rather than untransformed symbol coordinates', () => {
  const circuit = emptyCircuit();
  const output = part(circuit, 'output', 10, 10, { rotation: 90, mirror: 'x' });
  circuit.libraries[output.libId] = [
    'symbol',
    '"Geometry"',
    ['symbol', '"Geometry_1_1"', pin('output', '1', 'OUT', 2.54)],
  ];
  part(circuit, 'input', 10, 12.54);
  assert.equal(issues(circuit, 'erc.pin-unconnected').length, 0);
  assert.equal(issues(circuit, 'erc.input-undriven').length, 0);
});

test('no-connect markers suppress unused active pins and diagnose misplaced or wired markers', () => {
  const circuit = emptyCircuit();
  const input = part(circuit, 'input', 0, 0);
  part(circuit, 'free', 20, 0);
  assert.equal(
    issues(circuit, 'erc.pin-unconnected').length,
    1,
    'isolated free pins are permitted',
  );
  circuit.noConnects = [
    { id: 'nc', x: 0, y: 0 },
    { id: 'misplaced', x: 50, y: 50 },
  ];
  assert.equal(issues(circuit, 'erc.pin-unconnected').length, 0);
  assert.deepEqual(issues(circuit, 'erc.no-connect-misplaced')[0].objectIds, ['misplaced']);
  assert.equal(issues(circuit, 'erc.no-connect-misplaced')[0].severity, 'warning');
  wire(circuit, 0, 0, 20, 0);
  const connected = issues(circuit, 'erc.no-connect-connected');
  assert.equal(connected.length, 1);
  assert.equal(connected[0].severity, 'error');
  assert.ok(connected[0].objectIds.includes(input.id));
  const forbidden = part(circuit, 'no_connect', 20, 0);
  const noConnectFindings = issues(circuit, 'erc.no-connect-connected');
  assert.equal(noConnectFindings.length, 2);
  assert.ok(noConnectFindings.some((issue) => issue.objectIds.includes(forbidden.id)));
  assert.deepEqual(
    noConnectFindings.map((issue) => issue.severity),
    ['error', 'error'],
  );
  assert.deepEqual(
    runSchematicERC(circuit, { 'erc.no-connect-connected': 'warning' })
      .issues.filter((issue) => issue.ruleId === 'erc.no-connect-connected')
      .map((issue) => issue.severity),
    ['warning', 'warning'],
  );
});

test('unconnected resistor, connector and unspecified pins error unless marked no-connect', () => {
  const circuit = emptyCircuit();
  const resistor = part(circuit, 'passive', 0, 0, { ref: 'R1', libId: 'Test:R', value: '1k' });
  circuit.libraries[resistor.libId] = [
    'symbol',
    '"R"',
    ['symbol', '"R_1_1"', pin('passive', '1'), pin('passive', '2', 'B', 5.08)],
  ];
  const connector = part(circuit, 'passive', 20, 0, { ref: 'J1' });
  const unspecified = part(circuit, 'unspecified', 40, 0);
  part(circuit, 'free', 60, 0);
  wire(circuit, 0, 0, 0, 10);
  const unconnected = issues(circuit, 'erc.pin-unconnected');
  assert.equal(unconnected.length, 3);
  assert.deepEqual(
    unconnected.map((issue) => issue.objectIds[0]).sort(),
    [connector.id, resistor.id, unspecified.id].sort(),
  );
  assert.ok(unconnected.every((issue) => issue.severity === 'error'));
  assert.ok(unconnected.some((issue) => issue.message.includes('R1 pin 2 (passive)')));
  circuit.noConnects = [
    { id: 'resistor-nc', x: 5.08, y: 0 },
    { id: 'connector-nc', x: 20, y: 0 },
    { id: 'unspecified-nc', x: 40, y: 0 },
  ];
  assert.equal(issues(circuit, 'erc.pin-unconnected').length, 0);
  assert.equal(issues(circuit, 'erc.input-undriven').length, 0);
  assert.equal(issues(circuit, 'erc.no-connect-connected').length, 0);
});

test('a no-connect on one shared multi-unit physical pin detects a connection at its other instance', () => {
  const circuit = emptyCircuit();
  circuit.libraries.Multi = ['symbol', '"Multi"', ['symbol', '"Multi_0_1"', pin('input')]];
  part(circuit, 'input', 0, 0, { ref: 'U1', libId: 'Multi', unit: 1 });
  part(circuit, 'input', 20, 0, { ref: 'U1', libId: 'Multi', unit: 2 });
  circuit.noConnects = [{ id: 'nc', x: 0, y: 0 }];
  wire(circuit, 20, 0, 30, 0);
  assert.equal(issues(circuit, 'erc.no-connect-connected').length, 1);
});

test('passive pins satisfy signal drive but power nets require a power output', () => {
  const circuit = emptyCircuit();
  part(circuit, 'input', 0, 0);
  const driver = part(circuit, 'input', 10, 0);
  wire(circuit, 0, 0, 10, 0);
  const input = issues(circuit, 'erc.input-undriven');
  assert.equal(input.length, 1);
  assert.equal(input[0].severity, 'error');
  circuit.libraries['Test:passive'] = symbol('passive');
  driver.libId = 'Test:passive';
  assert.equal(issues(circuit, 'erc.input-undriven').length, 0);
  const power = part(circuit, 'power_in', 10, 0, { ref: '#PWR1', value: 'VIN' });
  circuit.libraries[power.libId] = symbol('power_in', true);
  const undriven = issues(circuit, 'erc.power-undriven');
  assert.equal(undriven.length, 1);
  assert.equal(undriven[0].severity, 'error');
  assert.deepEqual(undriven[0].objectIds, [power.id]);
  assert.equal(issues(circuit, 'erc.input-undriven').length, 0);
  part(circuit, 'power_out', 0, 0);
  assert.deepEqual(issues(circuit, 'erc.power-undriven'), []);
});

test('open-collector buses and tri-state buses are not treated as multiple strong outputs', () => {
  for (const type of ['open_collector', 'open_emitter', 'tri_state']) {
    const circuit = emptyCircuit();
    part(circuit, type, 0, 0);
    part(circuit, type, 0, 0);
    assert.equal(issues(circuit, 'erc.output-conflict').length, 0, type);
    part(circuit, 'output', 0, 0);
    assert.equal(issues(circuit, 'erc.output-conflict')[0].severity, 'error');
  }
  const mixed = emptyCircuit();
  part(mixed, 'open_collector', 0, 0);
  part(mixed, 'open_emitter', 0, 0);
  assert.deepEqual(issues(mixed, 'erc.output-conflict'), []);
  const triState = part(mixed, 'tri_state', 0, 0);
  assert.equal(issues(mixed, 'erc.output-conflict')[0].severity, 'error');
  const powerOut = part(mixed, 'power_out', 0, 0);
  const conflict = issues(mixed, 'erc.output-conflict')[0];
  assert.equal(conflict.severity, 'error');
  assert.deepEqual(conflict.objectIds, [triState.id, powerOut.id].sort());
  const warning = runSchematicERC(mixed, { 'erc.output-conflict': 'warning' }).issues.find(
    (issue) => issue.ruleId === 'erc.output-conflict',
  );
  assert.deepEqual(warning, { ...conflict, severity: 'warning' });
});

test('unspecified pin type warns when sharing a network with an electrical pin', () => {
  const circuit = emptyCircuit();
  const unknown = part(circuit, 'unspecified', 0, 0);
  part(circuit, 'free', 0, 0);
  assert.deepEqual(issues(circuit, 'erc.pin-conflict'), []);
  const passive = part(circuit, 'passive', 0, 0);
  const conflict = issues(circuit, 'erc.pin-conflict');
  assert.equal(conflict.length, 1);
  assert.equal(conflict[0].severity, 'warning');
  assert.deepEqual(conflict[0].objectIds, [unknown.id, passive.id]);
});

test('conflicting physical net names and locally unattached labels are reported independently', () => {
  const circuit = emptyCircuit();
  wire(circuit, 0, 0, 10, 0);
  circuit.labels.push(
    { id: 'a', text: 'VCC', x: 0, y: 0 },
    { id: 'b', text: 'GND', x: 10, y: 0 },
    { id: 'floating', text: 'VCC', x: 40, y: 40 },
  );
  assert.deepEqual(issues(circuit, 'erc.net-name-conflict')[0].objectIds, ['a', 'b', 'floating']);
  assert.deepEqual(issues(circuit, 'erc.label-dangling')[0].objectIds, ['floating']);
  assert.equal(issues(circuit, 'erc.wire-dangling').length, 0);
});

test('dangling endpoints and zero-length wires use object identities and precise locations', () => {
  const circuit = emptyCircuit();
  wire(circuit, 0, 0, 10, 0);
  wire(circuit, 10, 0, 20, 0);
  wire(circuit, 30, 0, 30, 0);
  const dangling = issues(circuit, 'erc.wire-dangling');
  assert.equal(dangling.length, 2);
  assert.deepEqual(
    dangling.map((issue) => issue.location),
    [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
    ],
  );
  assert.equal(issues(circuit, 'erc.wire-zero-length').length, 1);
});

test('dense wire buckets stop searching endpoints once a continuing wire is found', () => {
  const circuit = emptyCircuit();
  for (let index = 0; index < 1100; index++) wire(circuit, 0, 0, 1, 0);
  const report = runSchematicERC(circuit);
  assert.equal(report.complete, true);
  assert.deepEqual(report.issues, []);
});

test('no-connect markers search across bucket edges and still require the exact distance tolerance', () => {
  const circuit = emptyCircuit();
  part(circuit, 'passive', -1, -1);
  const unconnected = part(circuit, 'passive', 0, 0);
  circuit.noConnects = [
    { id: 'near', x: -1.00003, y: -1.00003 },
    { id: 'outside-tolerance', x: -0.00008, y: -0.00008 },
  ];
  const report = runSchematicERC(circuit);
  assert.deepEqual(
    report.issues.map(({ ruleId, objectIds }) => ({ ruleId, objectIds })),
    [
      { ruleId: 'erc.no-connect-misplaced', objectIds: ['outside-tolerance'] },
      { ruleId: 'erc.pin-unconnected', objectIds: [unconnected.id] },
    ],
  );
});

test('unknown pin types make coverage incomplete, and all checks remain deterministic and read-only', () => {
  const circuit = emptyCircuit();
  part(circuit, 'future_pin_type', 0, 0);
  const before = structuredClone(circuit);
  const first = runSchematicERC(circuit);
  assert.equal(first.complete, false);
  assert.equal(first.truncated, false);
  assert.equal(first.issues[0].ruleId, 'erc.pin-type-unsupported');
  assert.ok(first.notes.some((note) => note.includes('future_pin_type')));
  assert.deepEqual(runSchematicERC(circuit), first);
  assert.deepEqual(circuit, before);
});

test('oversized reports are explicitly incomplete and unsupported geometry fails before publishing a result', () => {
  const circuit = emptyCircuit();
  for (let index = 0; index < 1100; index++) part(circuit, 'input', index * 2, 0);
  const result = runSchematicERC(circuit);
  assert.equal(result.issues.length, 1000);
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
  const malformed = emptyCircuit();
  part(malformed, 'input', Number.NaN, 0);
  assert.throws(() => runSchematicERC(malformed), /finite schematic coordinates/);
  malformed.parts[0].x = 0;
  malformed.libraries = {};
  assert.throws(() => runSchematicERC(malformed), /embedded symbol/);
  const excessive = emptyCircuit();
  excessive.wires = Array.from({ length: 10001 }, (_, index) => ({
    id: String(index),
    a: { x: 0, y: 0 },
    b: { x: 1, y: 0 },
  }));
  assert.throws(() => runSchematicERC(excessive), /10,000 wires/);
});
