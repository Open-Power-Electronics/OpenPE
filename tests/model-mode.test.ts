import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectCore } from '../core/project-core';
import { createExample } from '../lib/examples';
import { createHomeExample } from '../lib/create-home-example';
import { createReferenceExample } from '../lib/reference-examples';
import { switchingStageFixture } from './fixtures/switching-stage';
import { partFields } from '../lib/library';
import { buildSpiceDeck, defaultTransient, simulationSupportError } from '../lib/spice';
import { parseProject, projectFromNativeFiles, serializeProject } from '../lib/project';
import type { KiCadProjectFiles } from '../lib/kicad-project';
import {
  assertSimulationModelConfiguration,
  basicSimulationAvailable,
  effectiveSimulationModelFields,
  simulationModelSource,
  reviewedSimulationDevice,
  reviewedSimulationPins,
} from '../lib/simulation-model-source';
import { parseProject as serviceParse } from '../server/project-format.mjs';
import { buildSpiceDeck as serviceDeck } from '../server/spice-format.mjs';

test('current native bindings remain unchanged while an explicit mode is independent of the retained file', () => {
  assert.equal(simulationModelSource({}), 'basic');
  assert.equal(simulationModelSource({ 'Sim.Library': 'circuits/vendor.lib' }), 'external');
  assert.equal(
    simulationModelSource({ 'OpenPE.ModelSource': 'basic', 'Sim.Library': 'circuits/vendor.lib' }),
    'basic',
  );
  assert.equal(simulationModelSource({ 'OpenPE.ModelSource': 'external' }), 'external');
  assert.throws(() => simulationModelSource({ 'OpenPE.ModelSource': 'auto' }), /basic or external/);
  const part = createExample('kicad-buck').schematic.parts.find((p) => p.ref === 'C101')!;
  const pending = { 'OpenPE.ModelSource': 'external', 'Sim.Library': 'circuits/vendor.lib' };
  assert.doesNotThrow(() => effectiveSimulationModelFields(part, pending));
  assert.throws(() => assertSimulationModelConfiguration(part, pending), /file and model name/);
  const fields = partFields(part),
    before = structuredClone(fields);
  assert.deepEqual(effectiveSimulationModelFields(part, fields), fields);
  assert.deepEqual(fields, before);
  for (const [libId, device] of [
    ['Simulation_SPICE:NPN', 'NPN'],
    ['Simulation_SPICE:PNP', 'PNP'],
    ['Simulation_SPICE:NMOS', 'NMOS'],
    ['Transistor_FET:IRF540N', 'NMOS'],
    ['Transistor_FET:IRF520N', 'NMOS'],
    ['Device:C_Polarized', 'C'],
  ])
    assert.equal(reviewedSimulationDevice({ libId }), device);
  assert.equal(reviewedSimulationDevice({ libId: 'Unreviewed:ThreePin' }), null);
  const mos = createExample('kicad-buck').schematic.parts.find(
    (part) => part.libId === 'Transistor_FET:IRF540N',
  )!;
  assert.equal(reviewedSimulationPins(mos), partFields(mos)['Sim.Pins']);
  assert.equal(reviewedSimulationPins({ libId: 'Transistor_FET:IRF520N' }), '1=G 2=D 3=S');
  assert.equal(reviewedSimulationPins({ libId: 'Unreviewed:ThreePin' }), null);
});

test('mode selection, retained model configuration, native Save/reopen and undo share the document transaction', () => {
  const project = createReferenceExample('reference-lm2596-to220-5-buck');
  const part = project.schematic.parts.find((p) => p.ref === 'L1')!;
  part.fields = {
    ...partFields(part),
    'Sim.Library': 'C:\\vendor\\coil.lib',
    'Sim.Name': 'COIL',
    'Sim.Pins': '1=P 2=N',
    'OpenPE.ModelSource': 'external',
  };
  const core = new ProjectCore(project),
    original = core.getSnapshot().source;
  const edit = (mode: 'basic' | 'external') =>
    core.execute('part.properties', {
      schematicId: project.schematic.id,
      partId: part.id,
      fields: Object.entries({
        ...partFields(core.getSnapshot().project!.schematic.parts.find((p) => p.id === part.id)!),
        'OpenPE.ModelSource': mode,
      }).map(([name, value]) => ({ name, value })),
    });
  edit('basic');
  assert.equal(core.getSnapshot().undoDepth, 1);
  const selected = partFields(
    core.getSnapshot().project!.schematic.parts.find((p) => p.id === part.id)!,
  );
  assert.equal(selected['Sim.Library'], 'C:\\vendor\\coil.lib');
  assert.equal(selected['Sim.Name'], 'COIL');
  assert.equal(selected['Sim.Pins'], '1=P 2=N');
  const native = projectFromNativeFiles(core.query('source.files') as KiCadProjectFiles);
  for (const reopened of [
    native,
    parseProject(core.getSnapshot().source),
    serviceParse(core.getSnapshot().source),
  ]) {
    const actual = partFields(reopened.schematic.parts.find((p) => p.ref === part.ref)!);
    assert.equal(actual['OpenPE.ModelSource'], 'basic');
    assert.equal(actual['Sim.Library'], selected['Sim.Library']);
    assert.equal(actual['Sim.Name'], 'COIL');
    assert.equal(actual['Sim.Pins'], '1=P 2=N');
  }
  const malformed = JSON.parse(core.getSnapshot().source);
  malformed.schematic.components.find(
    (p: { reference: string }) => p.reference === 'L1',
  ).simulation.modelSource = 'auto';
  for (const parse of [parseProject, serviceParse])
    assert.throws(() => parse(JSON.stringify(malformed)), /Invalid OpenPE project/);
  edit('external');
  assert.equal(core.getSnapshot().undoDepth, 2);
  assert.equal(
    simulationModelSource(
      partFields(core.getSnapshot().project!.schematic.parts.find((p) => p.id === part.id)!),
    ),
    'external',
  );
  core.undo();
  assert.equal(
    simulationModelSource(
      partFields(core.getSnapshot().project!.schematic.parts.find((p) => p.id === part.id)!),
    ),
    'basic',
  );
  core.undo();
  assert.equal(core.getSnapshot().source, original);
});

test('explicit intrinsic selection ignores inactive external bindings in every supported primitive compiler', () => {
  const emc = createHomeExample('emc-flyback-demo').schematic;
  const circuits = [
    switchingStageFixture(),
    createExample('kicad-buck').schematic,
    createReferenceExample('reference-lm2596-to220-5-buck').schematic,
    emc,
  ];
  for (const circuit of circuits) {
    const part =
      circuit === emc
        ? circuit.parts.find((p) => p.ref === 'C4')!
        : circuit.parts.find((p) => p.libId === 'Device:C' || p.libId === 'Device:C_Polarized')!;
    const config = defaultTransient(circuit),
      original = buildSpiceDeck(circuit, config);
    const retained = {
      ...partFields(part),
      'OpenPE.ModelSource': 'basic',
      'Sim.Library': 'C:\\vendor\\external.lib',
      'Sim.Name': 'EXTERNAL',
      'Sim.Device': 'SUBCKT',
      'Sim.Type': 'X',
      'Sim.Pins': '1=OTHER 2=PIN',
    };
    part.fields = retained;
    const before = JSON.stringify(circuit);
    const actual = buildSpiceDeck(circuit, config);
    assert.deepEqual(actual, original, part.ref);
    assert.deepEqual(serviceDeck(circuit, config), actual);
    assert.equal(JSON.stringify(circuit), before);
    part.fields = { ...retained, 'OpenPE.ModelSource': 'external', 'Sim.Name': '' };
    assert.match(simulationSupportError(circuit), /choose an external model file and model name/);
    assert.throws(
      () => buildSpiceDeck(circuit, config),
      /choose an external model file and model name/,
    );
    part.fields = { ...retained, 'OpenPE.ModelSource': 'external' };
    assert.throws(
      () => buildSpiceDeck(circuit, config),
      /unsupported|not supported|not included|external model/i,
    );
  }
});

test('complex ICs cannot select an invented basic model and current catalog bindings retain their model identity', () => {
  const project = createReferenceExample('reference-lm2596-to220-5-buck');
  const circuit = project.schematic;
  const controller = circuit.parts.find((p) =>
    partFields(p)['Sim.Library']?.startsWith('OpenPE:'),
  )!;
  assert.ok(controller);
  assert.equal(basicSimulationAvailable(controller), false);
  const baseline = serializeProject(project),
    config = defaultTransient(circuit),
    deck = buildSpiceDeck(circuit, config);
  const modeFields: Record<string, string> = {
    ...partFields(controller),
    'OpenPE.ModelSource': 'external',
  };
  controller.fields = modeFields;
  assert.deepEqual(buildSpiceDeck(circuit, config), deck);
  assert.equal(
    modeFields['Sim.Library'],
    partFields(parseProject(baseline).schematic.parts.find((p) => p.id === controller.id)!)[
      'Sim.Library'
    ],
  );
  controller.fields = { ...modeFields, 'OpenPE.ModelSource': 'basic' };
  assert.throws(() => buildSpiceDeck(circuit, config), /no basic simulation model/);
});

test('complete external bindings never fall back to intrinsic or fixed derivative models', () => {
  const cases = [
    { circuit: switchingStageFixture(), ref: '', name: 'EXTERNAL' },
    { circuit: createExample('kicad-buck').schematic, ref: 'Q1', name: 'IRF540N' },
    {
      circuit: createReferenceExample('reference-lm2596-to220-5-buck').schematic,
      ref: '',
      name: 'EXTERNAL',
    },
    { circuit: createHomeExample('emc-flyback-demo').schematic, ref: 'Q1', name: 'EMC_IRF520N' },
  ];
  for (const item of cases) {
    const part = item.ref
      ? item.circuit.parts.find((p) => p.ref === item.ref)!
      : (item.circuit.parts.find((p) => partFields(p)['Sim.Library']?.startsWith('OpenPE:')) ??
        item.circuit.parts.find((p) => p.libId === 'Device:C')!);
    assert.ok(part);
    const config = defaultTransient(item.circuit),
      fields = partFields(part);
    const retained = JSON.stringify(fields);
    for (const binding of [
      { 'Sim.Library': 'C:\\vendor\\unreviewed.lib', 'Sim.Name': fields['Sim.Name'] || item.name },
      {
        'Sim.Library': fields['Sim.Library'] || 'C:\\vendor\\unreviewed.lib',
        'Sim.Name': 'UNREVIEWED_MODEL',
      },
    ]) {
      part.fields = { ...fields, ...binding, 'OpenPE.ModelSource': 'external' };
      assert.throws(
        () => buildSpiceDeck(item.circuit, config),
        /unsupported|not supported|not included|external model|unsupported model name/i,
      );
      assert.throws(
        () => serviceDeck(item.circuit, config),
        /unsupported|not supported|not included|external model|unsupported model name/i,
      );
    }
    assert.equal(JSON.stringify(fields), retained);
  }
});
