import test from 'node:test';
import assert from 'node:assert/strict';
import { createPart, emptyCircuit, type Part } from '../lib/circuit';
import { createHomeExample } from '../lib/create-home-example';
import { quote, type SExpr } from '../lib/sexpr';
import { partFields } from '../lib/library';
import {
  externalModelBinding,
  externalModelBindingFields,
  validateExternalModelMapping,
  type ExternalModelDeclaration,
} from '../lib/simulation-model-binding';

function symbolFixture(pins: [string, string][]) {
  const circuit = emptyCircuit();
  const library: SExpr = [
    'symbol',
    quote('Fixture'),
    [
      'symbol',
      quote('Fixture_1_1'),
      ...pins.map(([number, name]): SExpr => [
        'pin',
        'passive',
        'line',
        ['at', '0', '0', '0'],
        ['length', '0'],
        ['name', quote(name)],
        ['number', quote(number)],
      ]),
    ],
  ];
  const part: Part = {
    id: 'symbol-instance',
    libId: 'Test:Fixture',
    ref: 'U1',
    value: 'Fixture',
    x: 0,
    y: 0,
    rotation: 0,
    unit: 1,
  };
  circuit.libraries[part.libId] = library;
  circuit.parts.push(part);
  return { circuit, part };
}

test('reselecting a named subcircuit preserves its explicit native ordinal mapping only for that model', () => {
  const { circuit, part } = symbolFixture([
    ['1', '~'],
    ['2', '~'],
    ['3', '~'],
  ]);
  part.fields = { 'Sim.Device': 'SUBCKT', 'Sim.Name': 'REVIEWED', 'Sim.Pins': '3=1 1=2 2=3' };
  const declaration: ExternalModelDeclaration = {
    name: 'REVIEWED',
    kind: 'subcircuit',
    pins: ['K', 'A', 'REF'],
  };
  assert.equal(externalModelBindingFields(circuit, part, declaration)['Sim.Pins'], '3=1 1=2 2=3');
  assert.equal(
    externalModelBinding(circuit, part, { ...declaration, name: 'OTHER' }).mapping,
    null,
  );
});

test('primitive model mapping uses established symbol polarity and preserves other fields', () => {
  const circuit = emptyCircuit(),
    capacitor = createPart(circuit, 'C', 0, 0);
  circuit.parts.push(capacitor);
  const declaration: ExternalModelDeclaration = {
    name: 'CAP_MODEL',
    kind: 'model',
    device: 'C',
    pins: ['1', '2'],
  };
  const before = JSON.stringify(circuit);
  const binding = externalModelBinding(circuit, capacitor, declaration);
  assert.deepEqual(binding.mapping, { '+': '1', '-': '2' });
  assert.deepEqual(externalModelBindingFields(circuit, capacitor, declaration), {
    'Sim.Device': 'C',
    'Sim.Type': undefined,
    'Sim.Name': 'CAP_MODEL',
    'Sim.Pins': '1=+ 2=-',
  });
  assert.equal(JSON.stringify(circuit), before);
  const diode = createPart(circuit, 'D', 0, 0);
  const diodeBinding = externalModelBinding(circuit, diode, {
    name: 'D_VENDOR',
    kind: 'model',
    device: 'D',
    pins: [],
  });
  assert.deepEqual(diodeBinding.mapping, { A: '2', K: '1' });
});

test('native electrical role mappings retain their authority over drawn pin names', () => {
  const circuit = createHomeExample('emc-flyback-demo').schematic;
  const part = circuit.parts.find((part) => part.ref === 'Q1')!;
  part.fields = { ...partFields(part), 'Sim.Pins': '1=D 2=G 3=S' };
  const before = JSON.stringify(partFields(part));
  const declaration: ExternalModelDeclaration = {
    name: 'CUSTOM_MOS',
    kind: 'model',
    device: 'VDMOS',
    pins: [],
  };
  const binding = externalModelBinding(circuit, part, declaration);
  assert.deepEqual(binding.mapping, { D: '1', G: '2', S: '3' });
  assert.deepEqual(externalModelBindingFields(circuit, part, declaration), {
    'Sim.Device': 'NMOS',
    'Sim.Type': 'VDMOS',
    'Sim.Name': 'CUSTOM_MOS',
    'Sim.Pins': '1=D 2=G 3=S',
  });
  assert.equal(JSON.stringify(partFields(part)), before);
  const macro: ExternalModelDeclaration = {
    name: 'MACRO',
    kind: 'subcircuit',
    pins: ['D', 'G', 'S'],
  };
  const updates = externalModelBindingFields(circuit, part, macro);
  const switched = { ...part, fields: { ...partFields(part) } };
  for (const [name, value] of Object.entries(updates)) {
    if (value === undefined) delete switched.fields[name];
    else switched.fields[name] = value;
  }
  assert.equal(switched.fields['Sim.Device'], 'SUBCKT');
  assert.deepEqual(externalModelBinding(circuit, switched, declaration).mapping, {
    D: '1',
    G: '2',
    S: '3',
  });
  assert.equal(externalModelBindingFields(circuit, switched, declaration)['Sim.Device'], 'NMOS');
  assert.equal(externalModelBindingFields(circuit, switched, declaration)['Sim.Type'], 'VDMOS');
});

test('named subcircuit ports use unique semantic matches and numeric ports use exact IDs', () => {
  const { circuit, part } = symbolFixture([
    ['1', 'G'],
    ['2', 'D'],
    ['3', 'S'],
  ]);
  const model: ExternalModelDeclaration = {
    name: 'MOS_CIRCUIT',
    kind: 'subcircuit',
    pins: ['DRAIN', 'GATE', 'SOURCE'],
  };
  assert.deepEqual(externalModelBinding(circuit, part, model).mapping, {
    DRAIN: '2',
    GATE: '1',
    SOURCE: '3',
  });
  const numeric = { ...model, pins: ['3', '1', '2'] };
  assert.deepEqual(externalModelBinding(circuit, part, numeric).mapping, {
    '3': '3',
    '1': '1',
    '2': '2',
  });
  assert.equal(externalModelBindingFields(circuit, part, numeric)['Sim.Pins'], '3=1 1=2 2=3');
});

test('equal pin counts do not invent mappings and explicit mappings must be complete and bijective', () => {
  const { circuit, part } = symbolFixture([
    ['1', 'A'],
    ['2', 'B'],
    ['3', 'C'],
  ]);
  const declaration: ExternalModelDeclaration = {
    name: 'CUSTOM',
    kind: 'subcircuit',
    pins: ['VIN', 'VOUT', 'GND'],
  };
  const binding = externalModelBinding(circuit, part, declaration);
  assert.equal(binding.compatible, true);
  assert.equal(binding.mapping, null);
  assert.deepEqual(binding.missing, ['VIN', 'VOUT', 'GND']);
  assert.throws(
    () => externalModelBindingFields(circuit, part, declaration),
    /Confirm the model pin mapping/,
  );
  const invalidMappings: Record<string, string>[] = [
    { VIN: '1' },
    { VIN: '1', VOUT: '2', GND: '2' },
    { VIN: '1', VOUT: '2', GND: '4' },
    { VIN: '1', VOUT: '2', OTHER: '3' },
  ];
  for (const mapping of invalidMappings)
    assert.throws(() => validateExternalModelMapping(binding, mapping), /Map every model terminal/);
  const mapping = { VIN: '2', VOUT: '1', GND: '3' };
  assert.equal(validateExternalModelMapping(binding, mapping), '2=1 1=2 3=3');
  assert.deepEqual(externalModelBindingFields(circuit, part, declaration, mapping), {
    'Sim.Device': 'SUBCKT',
    'Sim.Type': undefined,
    'Sim.Name': 'CUSTOM',
    'Sim.Pins': '2=1 1=2 3=3',
  });
});

test('external declarations update device metadata while retaining Value and parameters', () => {
  const { circuit, part } = symbolFixture([
    ['1', 'C'],
    ['2', 'B'],
    ['3', 'E'],
  ]);
  part.fields = { 'Sim.Device': 'NPN', 'Sim.Type': 'GUMMELPOON', 'Sim.Params': 'BF=150' };
  const original = JSON.stringify(part);
  const npn: ExternalModelDeclaration = {
    name: 'NPN_VENDOR',
    kind: 'model',
    device: 'NPN',
    pins: ['C', 'B', 'E'],
  };
  assert.deepEqual(externalModelBindingFields(circuit, part, npn), {
    'Sim.Name': 'NPN_VENDOR',
    'Sim.Pins': '1=C 2=B 3=E',
    'Sim.Device': 'NPN',
    'Sim.Type': undefined,
  });
  assert.equal(externalModelBinding(circuit, part, { ...npn, device: 'PNP' }).compatible, false);
  const subcircuit: ExternalModelDeclaration = {
    name: 'MACRO',
    kind: 'subcircuit',
    pins: ['C', 'B', 'E'],
  };
  assert.deepEqual(externalModelBindingFields(circuit, part, subcircuit), {
    'Sim.Name': 'MACRO',
    'Sim.Pins': '1=1 2=2 3=3',
    'Sim.Device': 'SUBCKT',
    'Sim.Type': undefined,
  });
  assert.equal(JSON.stringify(part), original);
  const unknown = symbolFixture([
    ['1', 'C'],
    ['2', 'B'],
    ['3', 'E'],
  ]);
  const binding = externalModelBinding(unknown.circuit, unknown.part, npn);
  assert.equal(binding.compatible, false);
  assert.match(binding.reason!, /polarity is ambiguous/);
});

test('incompatible primitive families and terminal counts remain blocked even with a manual mapping', () => {
  const circuit = emptyCircuit(),
    capacitor = createPart(circuit, 'C', 0, 0);
  circuit.parts.push(capacitor);
  const diode = externalModelBinding(circuit, capacitor, {
    name: 'DIODE',
    kind: 'model',
    device: 'D',
    pins: [],
  });
  assert.equal(diode.compatible, false);
  assert.match(diode.reason!, /device type/);
  assert.throws(() => validateExternalModelMapping(diode, { A: '1', K: '2' }), /device type/);
  const { circuit: mosCircuit, part } = symbolFixture([
    ['1', 'D'],
    ['2', 'G'],
    ['3', 'S'],
  ]);
  const mos = externalModelBinding(mosCircuit, part, {
    name: 'MOS',
    kind: 'model',
    device: 'NMOS',
    pins: [],
  });
  assert.equal(mos.compatible, false);
  assert.match(mos.reason!, /4 terminals; the symbol has 3 pins/);
  assert.throws(
    () =>
      externalModelBinding(mosCircuit, part, {
        name: 'BAD',
        kind: 'subcircuit',
        pins: ['D', 'd', 'S'],
      }),
    /duplicate terminals/,
  );
  assert.throws(
    () =>
      externalModelBinding(mosCircuit, part, {
        name: 'BAD',
        kind: 'model',
        device: 'UNKNOWN',
        pins: [],
      }),
    /no supported pin definition/,
  );
});

test('ambiguous symbol definitions, declarations and mappings cannot mutate dictionary prototypes', () => {
  const { circuit, part } = symbolFixture([['1', '__proto__']]);
  const binding = externalModelBinding(circuit, part, {
    name: 'MODEL',
    kind: 'subcircuit',
    pins: ['__proto__'],
  });
  assert.equal(Object.getPrototypeOf(binding.suggested), null);
  assert.equal(binding.mapping?.__proto__, '1');
  assert.equal(validateExternalModelMapping(binding, binding.mapping!), '1=1');
  const ambiguous = symbolFixture([
    ['1', 'A'],
    ['1', 'B'],
  ]);
  assert.throws(
    () =>
      externalModelBinding(ambiguous.circuit, ambiguous.part, {
        name: 'X',
        kind: 'subcircuit',
        pins: ['A'],
      }),
    /ambiguous/,
  );
  assert.throws(
    () =>
      externalModelBinding(circuit, part, {
        name: 'BAD\n.include',
        kind: 'subcircuit',
        pins: ['P'],
      }),
    /Invalid external/,
  );
});
