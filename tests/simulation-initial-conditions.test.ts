import { createReferenceExample } from '../lib/reference-examples';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPart, emptyCircuit } from '../lib/circuit';
import { partFields, displayPartValue } from '../lib/library';
import { val } from '../lib/sexpr';
import { preparePartProperties } from '../lib/part-properties';
import { createProject, projectFromNativeFiles } from '../lib/project';
import { ProjectCore } from '../core/project-core';
import { createHomeExample } from '../lib/create-home-example';
import { switchingStageFixture } from './fixtures/switching-stage';
import {
  storagePrimitive,
  initialConditionField,
  spiceInitialConditions,
} from '../lib/simulation-initial-conditions';
import {
  buildSpiceDeck,
  defaultTransient,
  type SpiceDeck,
} from '../plugins/spice-simulation/domain/spice';
import { runSimulation } from '../plugins/spice-simulation/host/spice.mjs';
import type { KiCadProjectFiles } from '../lib/kicad-project';
import { parseProject as serviceParse } from '../server/project-format.mjs';
import { buildSpiceDeck as serviceDeck } from '../plugins/spice-simulation/host/spice-format.mjs';

test('optional capacitor and inductor initial conditions commit and undo without storing implicit defaults', () => {
  for (const [kind, name] of [
    ['C', 'OpenPE.InitialVoltage'],
    ['L', 'OpenPE.InitialCurrent'],
  ] as const) {
    const circuit = emptyCircuit(),
      part = createPart(circuit, kind, 0, 0);
    circuit.parts.push(part);
    const fields = partFields(part),
      before = structuredClone(part);
    const rows = [
      ...Object.entries(fields).map(([name, value]) => ({ name, value })),
      { name, value: '' },
    ];
    assert.equal(preparePartProperties(part, part.ref, displayPartValue(part), rows), null);
    assert.deepEqual(part, before);
    const core = new ProjectCore(createProject(circuit));
    const baseline = core.getSnapshot().source;
    const change = preparePartProperties(
      part,
      part.ref,
      displayPartValue(part),
      rows.map((row) => (row.name === name ? { ...row, value: '2m' } : row)),
    )!;
    core.execute('part.properties', {
      schematicId: circuit.id,
      partId: part.id,
      fields: Object.entries(change.fields).map(([name, value]) => ({ name, value })),
    });
    const saved = projectFromNativeFiles(core.query('source.files') as KiCadProjectFiles);
    assert.equal(partFields(saved.schematic.parts[0])[name], '2m');
    assert.equal(
      partFields(serviceParse(core.getSnapshot().source).schematic.parts[0])[name],
      '2m',
    );
    const accepted = core.getSnapshot().project!.schematic.parts[0];
    const cleared = preparePartProperties(
      accepted,
      accepted.ref,
      displayPartValue(accepted),
      Object.entries(partFields(accepted)).map(([key, value]) => ({
        name: key,
        value: key === name ? '' : value,
      })),
    )!;
    assert.equal(cleared.fields[name], undefined);
    core.undo();
    assert.equal(core.getSnapshot().source, baseline);
  }
});

test('ideal, model Buck and curated compilers apply capacitor voltage and inductor current with UIC', () => {
  for (const circuit of [
    switchingStageFixture(),
    createReferenceExample('reference-lm2598-to220-7-buck').schematic,
    createReferenceExample('reference-lm2596-to220-5-buck').schematic,
  ]) {
    for (const kind of ['C', 'L'] as const) {
      const part = circuit.parts.find((part) => storagePrimitive(part) === kind)!;
      part.fields = {
        ...partFields(part),
        [initialConditionField(kind)]: kind === 'C' ? '1.5' : '2m',
      };
    }
    const config = defaultTransient(circuit),
      deck = buildSpiceDeck(circuit, config);
    assert.match(deck.netlist, /^C\d+ .* IC=1\.5$/m);
    assert.match(deck.netlist, /^L\d+ .* IC=0\.002$/m);
    assert.match(deck.netlist, /^tran .* uic$/m);
    assert.deepEqual(serviceDeck(circuit, config), deck);
  }
});

test('EMC applies modeled capacitor overrides and explicitly rejects omitted-device initial conditions', () => {
  const circuit = createHomeExample('emc-flyback-demo').schematic;
  const capacitor = circuit.parts.find((part) => part.ref === 'C4')!;
  capacitor.fields = { ...partFields(capacitor), 'OpenPE.InitialVoltage': '1.5' };
  const config = defaultTransient(circuit);
  assert.match(buildSpiceDeck(circuit, config).netlist, /^C4 .* IC=1\.5$/m);
  const coil = circuit.parts.find((part) => part.ref === 'L2')!;
  coil.fields = { ...partFields(coil), 'OpenPE.InitialCurrent': '2m' };
  assert.throws(() => buildSpiceDeck(circuit, config), /L2: initial conditions are not supported/);
});

test('capacitor initialization solves ground-referenced voltages without inventing a floating common mode', () => {
  assert.deepEqual(
    spiceInitialConditions([
      { kind: 'C', positive: 'b', negative: 'a', value: -2 },
      { kind: 'C', positive: 'a', negative: '0', value: 5 },
      { kind: 'C', positive: 'series', negative: 'b', value: -3, groundedSeriesNode: 'series' },
    ]),
    { lines: ['.ic v(a)=5 v(series)=0 v(b)=3'], uic: false },
  );
  assert.deepEqual(
    spiceInitialConditions([{ kind: 'C', positive: 'a', negative: 'b', value: 2 }]),
    { lines: [], uic: true },
  );
  assert.deepEqual(
    spiceInitialConditions([{ kind: 'L', positive: 'a', negative: '0', value: 2 }]),
    { lines: [], uic: true },
  );
  assert.deepEqual(
    spiceInitialConditions([{ kind: 'C', positive: 'a', negative: '0', value: 2 }], true),
    { lines: [], uic: true },
  );
  assert.throws(
    () =>
      spiceInitialConditions([
        { kind: 'C', positive: 'a', negative: '0', value: 2 },
        { kind: 'C', positive: '0', negative: 'a', value: -3 },
      ]),
    /Conflicting capacitor initial voltages/,
  );
});

test('TPS61046 retains its capacitor polarities and initial voltages while computing model bias', () => {
  const circuit = createReferenceExample('reference-tps61046-bga6-boost').schematic;
  circuit.id = 'renamed-circuit';
  circuit.parts.forEach((part, index) => {
    part.ref = `${part.ref.replace(/\d+$/, '')}${index + 100}`;
  });
  const config = defaultTransient(circuit),
    deck = buildSpiceDeck(circuit, config);
  assert.deepEqual(serviceDeck(circuit, config), deck);
  assert.doesNotMatch(deck.netlist, /^tran .* uic$/m);
  const nodes = new Map(
    [...deck.netlist.matchAll(/v\((\w+)\)=(-?[\d.]+)/g)].map((match) => [
      match[1],
      Number(match[2]),
    ]),
  );
  nodes.set('0', 0);
  const capacitors = [...deck.netlist.matchAll(/^C\d+ (\S+) (\S+) \S+ IC=(\S+)$/gm)];
  assert.equal(capacitors.length, 3);
  for (const [, positive, negative, initial] of capacitors)
    assert.equal(nodes.get(positive)! - nodes.get(negative)!, Number(initial));
  assert.match(deck.netlist, /^R\d+ \S+ 0 1000$/m);
});

test('ideal and model compilers preserve capacitor initial voltage while computing unspecified state', () => {
  for (const circuit of [
    switchingStageFixture(),
    createReferenceExample('reference-tps61046-bga6-boost').schematic,
  ]) {
    for (const part of circuit.parts) {
      const fields = partFields(part);
      delete fields['OpenPE.InitialVoltage'];
      delete fields['OpenPE.InitialCurrent'];
      part.fields = fields;
      if (part.raw)
        part.raw = part.raw.filter(
          (node) =>
            !Array.isArray(node) ||
            node[0] !== 'property' ||
            !['OpenPE.InitialVoltage', 'OpenPE.InitialCurrent'].includes(val(node)),
        );
    }
    const capacitor = circuit.parts.find((part) => storagePrimitive(part) === 'C')!;
    capacitor.fields = { ...partFields(capacitor), 'OpenPE.InitialVoltage': '1.5' };
    const config = defaultTransient(circuit),
      deck = buildSpiceDeck(circuit, config);
    const initialized = deck.netlist.match(/^C\d+ (\S+) (\S+) \S+ IC=1\.5$/m)!;
    assert.ok(initialized, 'The selected capacitor keeps its explicit device initial voltage.');
    const voltages = new Map(
      [...deck.netlist.matchAll(/v\((\w+)\)=(-?[\d.]+)/g)].map((match) => [
        match[1],
        Number(match[2]),
      ]),
    );
    voltages.set('0', 0);
    assert.equal(voltages.get(initialized[1])! - voltages.get(initialized[2])!, 1.5);
    assert.doesNotMatch(deck.netlist, /^tran .* uic$/m);
    assert.deepEqual(serviceDeck(circuit, config), deck);
  }
});

test(
  'native constrained initialization preserves charge and solves an unspecified bias node',
  {
    skip: process.env.OPENPE_TEST_NGSPICE !== '1',
  },
  async () => {
    const initialization = spiceInitialConditions([
      { kind: 'C', positive: 'out', negative: '0', value: 2 },
    ]);
    const deck: SpiceDeck = {
      stop: 0.001,
      assumptions: [],
      traces: [
        { vector: 'v(out)', label: 'Output', unit: 'V' },
        { vector: 'v(bias)', label: 'Bias', unit: 'V' },
      ],
      netlist: `Constrained capacitor and independent bias
V1 in 0 5
R1 in out 1k
C1 out 0 1u IC=2
R2 in bias 1k
R3 bias 0 1k
${initialization.lines.join('\n')}
.save v(out) v(bias)
.control
set wr_singlescale
set wr_vecnames
set numdgt=15
tran 1u 1m 0 1u${initialization.uic ? ' uic' : ''}
wrdata waveforms.txt v(out) v(bias)
quit
.endc
.end`,
    };
    const result = await runSimulation(deck, new AbortController().signal);
    assert.equal(result.time[0], 0);
    assert.ok(Math.abs(result.traces[0].values[0] - 2) < 1e-6);
    for (const [index, time] of result.time.entries()) {
      assert.ok(
        Math.abs(result.traces[0].values[index] - (5 - 3 * Math.exp(-time / 0.001))) < 0.002,
      );
      assert.ok(Math.abs(result.traces[1].values[index] - 2.5) < 1e-6);
    }
  },
);
