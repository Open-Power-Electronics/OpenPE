import { createReferenceExample } from '../lib/reference-examples';
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectCore } from '../core/project-core';
import { createHomeExample } from '../lib/create-home-example';
import { switchingStageFixture } from './fixtures/switching-stage';
import { partFields } from '../lib/library';
import { prepareSimulationModelSelection } from '../lib/model-resource-preparation';
import {
  buildSpiceDeck,
  defaultTransient,
  simulationSupportError,
} from '../plugins/spice-simulation/domain/spice';
import { parseProject, projectFromNativeFiles, serializeProject } from '../lib/project';
import type { KiCadProjectFiles } from '../lib/kicad-project';
import {
  assertSimulationModelConfiguration,
  basicSimulationAvailable,
  effectiveSimulationModelFields,
  simulationModelSource,
  passiveConnectorSymbol,
  reviewedSimulationDevice,
  reviewedSimulationPins,
} from '../lib/simulation-model-source';
import { parseProject as serviceParse } from '../server/project-format.mjs';
import { buildSpiceDeck as serviceDeck } from '../plugins/spice-simulation/host/spice-format.mjs';

test('choosing another passive model changes the solver device in all bounded compilers', () => {
  const emc = createHomeExample('emc-flyback-demo').schematic;
  for (const circuit of [
    switchingStageFixture(),
    createReferenceExample('reference-lm2598-to220-7-buck').schematic,
    createReferenceExample('reference-lm2596-to220-5-buck').schematic,
    emc,
  ]) {
    const part = circuit.parts.find(
      (p) => p.libId === 'Device:R' && (circuit !== emc || p.ref === 'R2'),
    )!;
    part.value = part.value.replace(/^\S+/, '1m');
    for (const passiveModel of ['L', 'C', 'R'] as const) {
      part.fields = prepareSimulationModelSelection(circuit, part, partFields(part), {
        source: 'basic',
        passiveModel,
      });
      const config = defaultTransient(circuit);
      const deck = buildSpiceDeck(circuit, config);
      const trace = deck.traces.find((item) =>
        item.targets?.some((target) => target.kind === 'current' && target.id === part.id),
      );
      assert.ok(trace);
      assert.match(
        trace.vector,
        passiveModel === 'L' ? /^i\(l/ : new RegExp(`^@${passiveModel.toLowerCase()}`),
      );
      assert.deepEqual(serviceDeck(circuit, config), deck);
    }
  }
});

test('a two-pin connector can switch passive models and return to Unassigned without changing its participation or PCB', () => {
  const project = createReferenceExample('reference-lm25017-wson8-flybuck');
  const connector = project.schematic.parts.find((part) => part.libId === passiveConnectorSymbol)!;
  const core = new ProjectCore(project);
  const before = core.getSnapshot();
  const assign = (passiveModel: 'R' | 'C' | 'L' | null) => {
    const schematic = core.getSnapshot().project!.schematic;
    const current = schematic.parts.find((part) => part.id === connector.id)!;
    const fields = prepareSimulationModelSelection(schematic, current, partFields(current), {
      source: 'basic',
      passiveModel,
    });
    core.execute('part.properties', {
      schematicId: schematic.id,
      partId: connector.id,
      fields: Object.entries(fields).map(([name, value]) => ({ name, value })),
    });
  };
  assign('R');
  const chosen = core.getSnapshot();
  assert.equal(chosen.undoDepth, 1);
  assert.deepEqual(chosen.project!.pcb, before.project!.pcb);
  const native = projectFromNativeFiles(core.getNativeFiles());
  const nativeConnector = native.schematic.parts.find((part) => part.id === connector.id)!;
  assert.equal(partFields(nativeConnector)['OpenPE.PassiveModel'], 'R');
  assert.equal(nativeConnector.excludeFromSimulation, connector.excludeFromSimulation);
  nativeConnector.value = '100';
  nativeConnector.excludeFromSimulation = false;
  const deck = buildSpiceDeck(native.schematic, defaultTransient(native.schematic));
  assert.ok(
    deck.traces.some(
      (trace) =>
        /^@r/.test(trace.vector) &&
        trace.targets?.some((target) => target.kind === 'current' && target.id === connector.id),
    ),
  );
  assign('L');
  assert.equal(core.getSnapshot().undoDepth, 2);
  assign(null);
  const cleared = core
    .getSnapshot()
    .project!.schematic.parts.find((part) => part.id === connector.id)!;
  assert.equal(partFields(cleared)['OpenPE.PassiveModel'], undefined);
  assert.equal(cleared.excludeFromSimulation, connector.excludeFromSimulation);
  core.undo();
  assert.equal(
    partFields(
      core.getSnapshot().project!.schematic.parts.find((part) => part.id === connector.id)!,
    )['OpenPE.PassiveModel'],
    'L',
  );
});

test('current native bindings remain unchanged while an explicit mode is independent of the retained file', () => {
  assert.equal(simulationModelSource({}), 'basic');
  assert.equal(simulationModelSource({ 'Sim.Library': 'models/vendor.lib' }), 'external');
  assert.equal(
    simulationModelSource({
      'OpenPE.ModelSource': 'basic',
      'Sim.Library': 'models/vendor.lib',
    }),
    'basic',
  );
  assert.equal(simulationModelSource({ 'OpenPE.ModelSource': 'external' }), 'external');
  assert.throws(() => simulationModelSource({ 'OpenPE.ModelSource': 'auto' }), /basic or external/);
  const part = createReferenceExample('reference-lm2598-to220-7-buck').schematic.parts.find(
    (p) => p.ref === 'C1',
  )!;
  const pending = {
    'OpenPE.ModelSource': 'external',
    'Sim.Library': 'models/vendor.lib',
  };
  assert.doesNotThrow(() => effectiveSimulationModelFields(part, pending));
  assert.throws(() => assertSimulationModelConfiguration(part, pending), /file and model name/);
  const fields = partFields(part),
    before = structuredClone(fields);
  assert.deepEqual(effectiveSimulationModelFields(part, fields), fields);
  assert.deepEqual(fields, before);
  for (const [libId, device] of [
    ['Transistor_FET:IRF540N', 'NMOS'],
    ['Transistor_FET:IRF520N', 'NMOS'],
    ['Device:C_Polarized', 'C'],
  ])
    assert.equal(reviewedSimulationDevice({ libId }), device);
  assert.equal(reviewedSimulationDevice({ libId: 'Unreviewed:ThreePin' }), null);
  assert.equal(reviewedSimulationPins({ libId: 'Transistor_FET:IRF540N' }), '1=D 2=G 3=S');
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
    createReferenceExample('reference-lm2598-to220-7-buck').schematic,
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
