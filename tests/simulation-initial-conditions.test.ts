import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPart, emptyCircuit } from '../lib/circuit';
import { partFields, displayPartValue } from '../lib/library';
import { preparePartProperties } from '../lib/part-properties';
import { createProject, projectFromNativeFiles } from '../lib/project';
import { ProjectCore } from '../core/project-core';
import { createExample } from '../lib/examples';
import { createReferenceExample } from '../lib/reference-examples';
import { createHomeExample } from '../lib/create-home-example';
import { switchingStageFixture } from './fixtures/switching-stage';
import {
  storagePrimitive,
  initialConditionField,
  spiceInitialConditions,
} from '../lib/simulation-initial-conditions';
import { buildSpiceDeck, defaultTransient, type SpiceDeck } from '../lib/spice';
import { runSimulation } from '../server/spice.mjs';
import PartProperties from '../components/PartProperties';
import type { KiCadProjectFiles } from '../lib/kicad-project';
import { parseProject as serviceParse } from '../server/project-format.mjs';
import { buildSpiceDeck as serviceDeck } from '../server/spice-format.mjs';

test('every capacitor and inductor exposes its applicable optional initial condition without dirtying inspection', () => {
  for (const [kind, name, label] of [
    ['C', 'OpenPE.InitialVoltage', 'Initial voltage (V)'],
    ['L', 'OpenPE.InitialCurrent', 'Initial current (A)'],
  ] as const) {
    const circuit = emptyCircuit(),
      part = createPart(circuit, kind, 0, 0);
    circuit.parts.push(part);
    const fields = partFields(part),
      before = structuredClone(part);
    const html = renderToStaticMarkup(
      createElement(PartProperties, { part, spiceAvailable: true, onSave: () => true }),
    );
    assert.ok(html.includes(`aria-label="${label}"`));
    assert.match(html, /placeholder="Computed"/);
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
  const circuit = emptyCircuit(),
    resistor = createPart(circuit, 'R', 0, 0);
  const html = renderToStaticMarkup(
    createElement(PartProperties, { part: resistor, spiceAvailable: true, onSave: () => true }),
  );
  assert.doesNotMatch(html, /aria-label="Initial (?:voltage|current)/);
});

test('ideal, model Buck and curated compilers apply capacitor voltage and inductor current with UIC', () => {
  for (const circuit of [
    switchingStageFixture(),
    createExample('kicad-buck').schematic,
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

test('ideal and model Buck compilers preserve capacitor initial voltage while computing unspecified state', () => {
  for (const circuit of [switchingStageFixture(), createExample('kicad-buck').schematic]) {
    const capacitor = circuit.parts.find((part) => storagePrimitive(part) === 'C')!;
    capacitor.fields = { ...partFields(capacitor), 'OpenPE.InitialVoltage': '1.5' };
    const config = defaultTransient(circuit),
      deck = buildSpiceDeck(circuit, config);
    assert.match(deck.netlist, /^\.ic .*v\(\w+\)=1\.5/m);
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
