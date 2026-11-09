import assert from 'node:assert/strict';
import test from 'node:test';
import { createCapabilityHost } from '../api/capabilities';
import { ProjectCore } from '../core/project-core';
import { createPart, uid } from '../lib/circuit';
import { createExample } from '../lib/examples';
import { displayPartValue, partFields } from '../lib/library';
import {
  registerLibraryCapabilities,
  type LibraryCapabilityPorts,
  type SpiceModelCatalog,
} from '../lib/library-capabilities';
import {
  prepareFootprintModelSelection,
  prepareSimulationLibrarySelection,
  prepareSimulationModelSelection,
} from '../lib/model-resource-preparation';
import { createEmptyPCB } from '../lib/pcb-layout';
import {
  createProject,
  projectFromNativeFiles,
  projectNativeFiles,
  type Project,
} from '../lib/project';
import { simulationSourceProperties } from '../lib/part-properties';
import { prepareSourceConversion } from '../lib/simulation-source-conversion';

function fixture() {
  const project = createProject();
  const part = createPart(project.schematic, 'R', 0, 0);
  part.fields = {
    'Sim.Library': 'circuits/resistor.lib',
    'Sim.Name': 'OLD',
    'Sim.Device': 'R',
    'Sim.Pins': '1=+ 2=-',
    'OpenPE.ModelSource': 'basic',
    Manufacturer: 'Retained evidence',
  };
  project.schematic.parts.push(part);
  const board = createEmptyPCB();
  board.footprints.push({
    id: uid(),
    symbolId: null,
    libraryId: 'Fixture:Mount',
    reference: 'MH1',
    value: 'Mount',
    x: 10,
    y: 10,
    rotation: 0,
    side: 'front',
    graphics: [],
    pads: [],
    models: [
      {
        path: '${KIPRJMOD}/models/old.step',
        offset: { x: 1, y: 2, z: 3 },
        rotation: { x: 10, y: 20, z: 30 },
        scale: { x: 1, y: 2, z: 3 },
        hidden: true,
        opacity: 0.4,
      },
    ],
  });
  project.pcb = board;
  return project;
}

function harness(project = fixture(), ports: LibraryCapabilityPorts = {}) {
  const core = new ProjectCore(project);
  const host = createCapabilityHost({ revision: () => String(core.getSnapshot().revision) });
  const unregister = registerLibraryCapabilities(host, core, {
    available: () => true,
    spiceAvailable: () => true,
    getFileId: () => 'fixture-grant',
    ...ports,
  });
  return {
    core,
    host,
    dispose: () => {
      unregister();
      host.dispose();
    },
  };
}

const partInput = (project: Project) => ({
  schematicId: project.schematic.id,
  partId: project.schematic.parts[0].id,
});
const modelInput = (project: Project) => ({
  boardId: project.pcb!.id,
  footprintId: project.pcb!.footprints[0].id,
});
const fieldRows = (fields: Record<string, string>) =>
  Object.entries(fields).map(([name, value]) => ({ name, value }));

function assertOneUndoParity(
  agent: ProjectCore,
  gui: ProjectCore,
  baseline: ReturnType<ProjectCore['getNativeFiles']>,
) {
  assert.deepEqual(agent.getNativeFiles(), gui.getNativeFiles());
  projectFromNativeFiles(agent.getNativeFiles());
  assert.equal(agent.getSnapshot().undoDepth, 1);
  assert.equal(gui.getSnapshot().undoDepth, 1);
  agent.undo();
  assert.deepEqual(agent.getNativeFiles(), baseline);
}

test('native STEP selection shares GUI preparation, preserves transforms and changes one native undo', async (t) => {
  const project = fixture(),
    gui = new ProjectCore(project);
  const path = '${KIPRJMOD}/models/prepared.step';
  let calls = 0;
  const h = harness(project, {
    chooseComponentModel: async (fileId) => {
      assert.equal(fileId, 'fixture-grant');
      calls++;
      return { path };
    },
  });
  t.after(h.dispose);
  const baseline = h.core.getNativeFiles();
  const footprint = gui.getSnapshot().project!.pcb!.footprints[0];
  gui.execute('layout.footprint.properties', {
    ...modelInput(project),
    changes: { models: prepareFootprintModelSelection(footprint, 0, path) },
  });
  const result = (await h.host.execute('layout.model.import', {
    ...modelInput(project),
    index: 0,
  })) as any;
  assert.equal(calls, 1);
  assert.equal(result.status, 'applied');
  assert.deepEqual(result.models[0], { ...footprint.models![0], path });
  assertOneUndoParity(h.core, gui, baseline);
  await assert.rejects(
    h.host.execute('layout.model.import', { ...modelInput(project), path: 'C:/private.step' }),
    /Invalid input/,
  );
  assert.equal(calls, 1);
});

test('official model preparation accepts only catalog identity/index and shares append preparation', async (t) => {
  const previousWindow = globalThis.window,
    previousFetch = globalThis.fetch;
  t.after(() => {
    globalThis.window = previousWindow;
    globalThis.fetch = previousFetch;
  });
  globalThis.window = {
    openpe: { connection: async () => ({ base: 'http://fixture', token: 'fixture' }) },
  } as unknown as Window & typeof globalThis;
  const path = '${KIPRJMOD}/models/official.step';
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(String(url), 'http://fixture/api/component-model/library');
    assert.deepEqual(JSON.parse(String(options!.body)), { id: 'Package:Official', index: 0 });
    return new Response(JSON.stringify({ path }), { status: 200 });
  };
  const project = fixture(),
    gui = new ProjectCore(project),
    h = harness(project);
  t.after(h.dispose);
  const baseline = h.core.getNativeFiles();
  const footprint = gui.getSnapshot().project!.pcb!.footprints[0];
  gui.execute('layout.footprint.properties', {
    ...modelInput(project),
    changes: { models: prepareFootprintModelSelection(footprint, 1, path) },
  });
  await h.host.execute('layout.model.library', {
    ...modelInput(project),
    libraryId: 'Package:Official',
    modelIndex: 0,
  });
  assert.equal(calls, 1);
  assertOneUndoParity(h.core, gui, baseline);
});

test('cancelled, stale, inactive, closing and destination-changed picker results cannot edit', async (t) => {
  for (const outcome of [
    'cancel',
    'revision',
    'inactive',
    'closing',
    'destination',
    'abort',
    'source',
  ] as const) {
    const project = fixture();
    let release!: (value: { path: string } | null) => void;
    let available = true,
      fileId = 'fixture-grant';
    const h = harness(project, {
      available: () => available || 'Activate the originating editor.',
      getFileId: () => fileId,
      chooseComponentModel: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    t.after(h.dispose);
    const before = h.core.getNativeFiles(),
      control = new AbortController();
    const pending = h.host.execute('layout.model.import', modelInput(project), {
      signal: control.signal,
    });
    const rejected = outcome === 'cancel' ? null : assert.rejects(pending);
    if (outcome === 'revision') h.core.execute('project.rename', { name: 'Changed' });
    if (outcome === 'inactive') available = false;
    if (outcome === 'closing') h.core.setEditingBlocked('This project is closing.');
    if (outcome === 'destination') fileId = 'other-grant';
    if (outcome === 'abort') control.abort();
    if (outcome === 'source') h.core.updateSource(h.core.getSnapshot().source + '\n');
    release(outcome === 'cancel' ? null : { path: '${KIPRJMOD}/models/new.step' });
    if (rejected) await rejected;
    else assert.deepEqual(await pending, { status: 'cancelled' });
    assert.equal(h.core.getSnapshot().project!.pcb!.footprints[0].models!.length, 1);
    assert.equal(h.core.getSnapshot().undoDepth, outcome === 'revision' ? 1 : 0);
    if (outcome !== 'revision') assert.deepEqual(h.core.getNativeFiles(), before);
  }
});

test('model preparation discovery rejects unavailable grants/plugins and locked footprints before I/O', async (t) => {
  const project = fixture();
  project.pcb!.footprints[0].locked = true;
  let calls = 0;
  const h = harness(project, {
    chooseComponentModel: async () => {
      calls++;
      return null;
    },
    spiceAvailable: () => 'SPICE disabled.',
  });
  t.after(h.dispose);
  await assert.rejects(h.host.execute('layout.model.import', modelInput(project)), /Unlock/);
  await assert.rejects(
    h.host.execute('part.spiceModel.bind', { ...partInput(project), source: 'basic' }),
    /disabled/,
  );
  assert.equal(calls, 0);
  const unsaved = harness(fixture(), {
    getFileId: () => undefined,
    chooseComponentModel: async () => null,
  });
  t.after(unsaved.dispose);
  assert.equal(
    unsaved.host.catalog().find((item) => item.id === 'layout.model.import')!.available,
    false,
  );
});

test('SPICE choose updates library fields with shared GUI rules and exposes declaration metadata only', async (t) => {
  const project = fixture(),
    gui = new ProjectCore(project);
  const catalog: SpiceModelCatalog & { bytes: string; logs: string } = {
    path: 'circuits/selected.lib',
    models: [{ name: 'SELECTED', kind: 'model', device: 'R', pins: [] }],
    issues: [],
    bytes: 'private model body',
    logs: 'private log body',
  };
  const h = harness(project, {
    chooseSpiceModel: async (fileId, library) => {
      assert.equal(fileId, 'fixture-grant');
      assert.equal(library, 'circuits/resistor.lib');
      return catalog;
    },
  });
  t.after(h.dispose);
  const baseline = h.core.getNativeFiles(),
    part = gui.getSnapshot().project!.schematic.parts[0];
  gui.execute('part.properties', {
    ...partInput(project),
    fields: fieldRows(
      prepareSimulationLibrarySelection(part, partFields(part), catalog.path, catalog.models),
    ),
  });
  const result = (await h.host.execute('part.spiceModel.choose', partInput(project))) as any;
  assert.equal(result.status, 'available');
  assert.equal(result.models[0].name, 'SELECTED');
  assert.equal('bytes' in result, false);
  assert.equal('logs' in result, false);
  assert.equal(partFields(h.core.getSnapshot().project!.schematic.parts[0])['Sim.Name'], undefined);
  assertOneUndoParity(h.core, gui, baseline);
});

test('SPICE inspected observations are immutable, part/revision bound and require complete explicit mappings', async (t) => {
  const project = fixture(),
    gui = new ProjectCore(project);
  const catalog: SpiceModelCatalog = {
    path: 'circuits/resistor.lib',
    models: [{ name: 'SUB', kind: 'subcircuit', pins: ['INPUT', 'RETURN'] }],
    issues: [],
  };
  const h = harness(project, { inspectSpiceModel: async () => catalog });
  t.after(h.dispose);
  const baseline = h.core.getNativeFiles();
  const observation = (await h.host.query('part.spiceModel.inspect', partInput(project))) as any;
  assert.equal(h.core.getSnapshot().undoDepth, 0);
  assert.equal(observation.bindings[0].mapping, null);
  const args = {
    ...partInput(project),
    source: 'external',
    observationId: observation.observationId,
    name: 'SUB',
  };
  await assert.rejects(h.host.execute('part.spiceModel.bind', args), /Confirm.*mapping/);
  await assert.rejects(
    h.host.execute('part.spiceModel.bind', { ...args, mapping: { INPUT: '1', RETURN: '1' } }),
    /different symbol pin/,
  );
  observation.models[0].name = 'FORGED';
  catalog.models[0].name = 'CHANGED';
  await assert.rejects(
    h.host.execute('part.spiceModel.bind', { ...args, name: 'FORGED' }),
    /not declared/,
  );
  const mapping = { INPUT: '2', RETURN: '1' };
  const part = gui.getSnapshot().project!.schematic.parts[0];
  gui.execute('part.properties', {
    ...partInput(project),
    fields: fieldRows(
      prepareSimulationModelSelection(project.schematic, part, partFields(part), {
        source: 'external',
        name: 'SUB',
        declarations: [{ name: 'SUB', kind: 'subcircuit', pins: ['INPUT', 'RETURN'] }],
        mapping,
      }),
    ),
  });
  await h.host.execute('part.spiceModel.bind', { ...args, mapping });
  assert.equal(partFields(h.core.getSnapshot().project!.schematic.parts[0])['Sim.Pins'], '2=1 1=2');
  assertOneUndoParity(h.core, gui, baseline);
  await assert.rejects(h.host.execute('part.spiceModel.bind', { ...args, mapping }), /stale/);
  await assert.rejects(
    h.host.query('part.spiceModel.inspect', { ...partInput(project), path: 'secret.lib' }),
    /Invalid input/,
  );
});

test('switching retained intrinsic/external bindings preserves inactive fields and one-edit undo', async (t) => {
  for (const source of ['basic', 'external'] as const) {
    const project = fixture();
    project.schematic.parts[0].fields!['OpenPE.ModelSource'] =
      source === 'basic' ? 'external' : 'basic';
    const gui = new ProjectCore(project),
      h = harness(project);
    t.after(h.dispose);
    const baseline = h.core.getNativeFiles(),
      part = gui.getSnapshot().project!.schematic.parts[0];
    const fields = prepareSimulationModelSelection(
      project.schematic,
      part,
      partFields(part),
      source === 'basic' ? { source } : { source, name: 'OLD' },
    );
    gui.execute('part.properties', { ...partInput(project), fields: fieldRows(fields) });
    await h.host.execute('part.spiceModel.bind', { ...partInput(project), source });
    const accepted = partFields(h.core.getSnapshot().project!.schematic.parts[0]);
    assert.equal(accepted['OpenPE.ModelSource'], source);
    assert.equal(accepted['Sim.Name'], 'OLD');
    assert.equal(accepted.Manufacturer, 'Retained evidence');
    assertOneUndoParity(h.core, gui, baseline);
  }
});

test('the SPICE binding capability selects a passive model and clears it without a file', async (t) => {
  const project = fixture();
  const part = project.schematic.parts[0];
  part.fields = { Manufacturer: 'Retained evidence' };
  const h = harness(project);
  t.after(h.dispose);
  const baseline = h.core.getNativeFiles();
  const bind = (passiveModel: string | null) =>
    h.host.execute('part.spiceModel.bind', {
      ...partInput(project),
      source: 'basic',
      passiveModel,
    });
  await assert.rejects(bind('D'));
  assert.deepEqual(h.core.getNativeFiles(), baseline);
  await bind('C');
  const chosen = h.core.getSnapshot();
  assert.equal(chosen.undoDepth, 1);
  assert.deepEqual(partFields(chosen.project!.schematic.parts[0]), {
    ...partFields(part),
    'OpenPE.ModelSource': 'basic',
    'OpenPE.PassiveModel': 'C',
  });
  await bind(null);
  assert.deepEqual(h.core.getNativeFiles(), baseline);
  h.core.undo();
  assert.equal(
    partFields(h.core.getSnapshot().project!.schematic.parts[0])['OpenPE.PassiveModel'],
    'C',
  );
});

test('source waveform capability matches GUI parameter-row conversion in native files and undo', async (t) => {
  const project = createExample('kicad-buck'),
    part = project.schematic.parts.find((item) => item.ref === 'V102')!;
  const gui = new ProjectCore(project),
    h = harness(project);
  t.after(h.dispose);
  const baseline = h.core.getNativeFiles();
  const rows = [
    ...fieldRows(partFields(part)).filter((row) => row.name !== 'Sim.Params'),
    ...simulationSourceProperties(part)!.rows,
  ];
  const change = prepareSourceConversion(part, part.ref, displayPartValue(part), rows, 'SIN')!;
  const args = { schematicId: project.schematic.id, partId: part.id };
  gui.execute('part.properties', {
    ...args,
    reference: change.ref,
    value: change.value,
    fields: fieldRows(change.fields),
  });
  await h.host.execute('part.sourceType', { ...args, type: 'SIN' });
  assertOneUndoParity(h.core, gui, baseline);
});

test('host resource command results never expose retained native model bodies to Agents', async (t) => {
  const secret = '* PRIVATE_RESOURCE_BODY_7621\n.subckt model 1 2\nR1 1 2 1\n.ends\n';
  for (const command of ['part.spiceModel.bind', 'part.footprint', 'part.sourceType']) {
    const initial = command === 'part.sourceType' ? createExample('kicad-buck') : fixture();
    const native = projectNativeFiles(initial);
    native.files.push({ name: 'circuits/private-resource.lib', source: secret });
    const project = projectFromNativeFiles(native);
    const h = harness(project);
    t.after(h.dispose);
    const part =
      command === 'part.sourceType'
        ? project.schematic.parts.find((item) => item.ref === 'V102')!
        : project.schematic.parts[0];
    const args = {
      schematicId: project.schematic.id,
      partId: part.id,
      ...(command === 'part.sourceType'
        ? { type: 'SIN' }
        : command === 'part.footprint'
          ? { libraryId: '' }
          : { source: 'external' }),
    };
    const result = await h.host.execute(command, args, { actor: 'agent' });
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_RESOURCE_BODY_7621|nativeFiles/);
    assert.equal(
      h.core.getNativeFiles().files.find((file) => file.name === 'circuits/private-resource.lib')
        ?.source,
      secret,
    );
  }
});
