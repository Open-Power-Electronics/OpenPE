import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import { createCapabilityHost } from '../api/capabilities';
import { compileCapabilitySchema } from '../api/capability-schema';
import { ProjectCore } from '../core/project-core';
import { registerProjectCapabilities } from '../core/register-project';
import { createPart, emptyCircuit, pinPositions, uid, type Circuit } from '../lib/circuit';
import { createProject } from '../lib/project';
import { projectNetGroups } from '../lib/project-net-groups';
import { onWire, samePoint } from '../lib/wiring';
import {
  registerWorkbenchCapabilities,
  type WorkbenchCapabilityPorts,
} from '../lib/workbench-capabilities';
import { registerLibraryCapabilities } from '../lib/library-capabilities';

test('Core catalog distinguishes object and operation commands from infrastructure', async () => {
  const core = new ProjectCore(createProject(emptyCircuit()));
  const host = createCapabilityHost();
  const unregister = registerProjectCapabilities(host, core);
  try {
    const catalog = host.catalog();
    for (const id of [
      'part.properties',
      'part.participation',
      'schematic.move',
      'layout.move',
      'layout.track.properties',
    ]) {
      const item = catalog.find((entry) => entry.id === id);
      assert.equal(item?.owner, 'core', id);
      assert.equal(item?.level, 'object', id);
    }
    for (const id of [
      'schematic.operations',
      'schematic.wire',
      'schematic.drag',
      'layout.route',
      'layout.fill',
    ]) {
      const item = catalog.find((entry) => entry.id === id);
      assert.equal(item?.owner, 'core', id);
      assert.equal(item?.level, 'operation', id);
    }
    for (const id of ['project.snapshot', 'project.replace', 'source.apply', 'history.undo']) {
      const item = catalog.find((entry) => entry.id === id);
      assert.equal(item?.owner, 'core', id);
      assert.equal(item?.level, undefined, id);
    }
    assert.equal(
      catalog.some((entry) => entry.level === 'task'),
      false,
    );
    assert.equal(
      catalog.some((entry) => entry.id === 'layout_power'),
      false,
    );
    await host.execute('schematic.add');
    assert.equal(core.getSnapshot().undoDepth, 1);
    await host.execute('history.undo');
    assert.equal(core.getSnapshot().undoDepth, 0);
  } finally {
    unregister();
  }
});

test('two clients share current Core state, revisions, document events and one undo history', async () => {
  const schematic = emptyCircuit();
  const part = createPart(schematic, 'R', 0, 0);
  schematic.parts.push(part);
  const core = new ProjectCore(createProject(schematic));
  const host = createCapabilityHost();
  const unregister = registerProjectCapabilities(host, core);
  const human = structuredClone(core.getSnapshot().project!.schematic);
  human.parts[0].value = '22k';
  core.replaceSchematic(human);
  const observed = (await host.query('project.snapshot', {}, { actor: 'agent' })) as {
    revision: string;
    project: any;
  };
  assert.equal(observed.project.schematic.components[0].value, '22k');
  await host.execute(
    'schematic.operations',
    { schematicId: schematic.id, operations: [{ type: 'setValue', ref: part.ref, value: '47k' }] },
    { actor: 'agent', expectedRevision: String(observed.revision) },
  );
  assert.equal(core.getSnapshot().project!.schematic.parts[0].value, '47k');
  assert.equal(core.getSnapshot().undoDepth, 2);
  await assert.rejects(
    host.execute(
      'schematic.delete',
      { schematicId: schematic.id, ids: [part.id] },
      { actor: 'agent', expectedRevision: String(observed.revision) },
    ),
    /changed/,
  );
  assert.equal(core.getSnapshot().undoDepth, 2);
  assert.equal(host.observe().events.filter((event) => event.type === 'project.changed').length, 2);
  await host.execute('history.undo', {}, { actor: 'human' });
  assert.equal(core.getSnapshot().project!.schematic.parts[0].value, '22k');
  await host.execute('source.update', { draft: '{invalid' }, { actor: 'human' });
  await assert.rejects(
    host.execute(
      'schematic.operations',
      { schematicId: schematic.id, operations: [{ type: 'removePart', ref: part.ref }] },
      { actor: 'agent' },
    ),
    /Source/,
  );
  const other = createCapabilityHost();
  const otherCore = new ProjectCore(createProject(emptyCircuit()));
  const unregisterOther = registerProjectCapabilities(other, otherCore);
  assert.equal(otherCore.getSnapshot().undoDepth, 0);
  unregister();
  await assert.rejects(host.query('project.snapshot'), /Unknown/);
  assert.ok(await other.query('project.snapshot'));
  unregisterOther();
});

test('shared connected component drag reroutes leads atomically while ordinary move leaves them in place', async () => {
  const schematic = emptyCircuit();
  schematic.parts.push(
    createPart(schematic, 'R', 25.4, 25.4),
    createPart(schematic, 'C', 76.2, 25.4),
  );
  for (const part of schematic.parts) part.rotation = 180;
  const [a, b] = schematic.parts.map(
    (part) => pinPositions(part, schematic.libraries[part.libId])[0],
  );
  schematic.wires = [
    { id: uid(), a, b: { x: a.x, y: 40.64 } },
    { id: uid(), a: { x: a.x, y: 40.64 }, b: { x: b.x, y: 40.64 } },
    { id: uid(), a: { x: b.x, y: 40.64 }, b },
  ];
  schematic.labels.push({ id: uid(), x: a.x, y: 35.56, text: 'INPUT' });
  const topology = (circuit: Circuit) =>
    projectNetGroups(circuit)
      .map((group) => [...group.pins].sort())
      .filter((pins) => pins.length)
      .sort();
  const core = new ProjectCore(createProject(schematic));
  const host = createCapabilityHost();
  const dispose = registerProjectCapabilities(host, core);
  const input = {
    schematicId: schematic.id,
    ids: [schematic.parts[0].id],
    delta: { x: 5.08, y: 0 },
  };
  try {
    const initial = core.getSnapshot();
    await host.execute('schematic.move', input, { actor: 'human', expectedRevision: '0' });
    assert.deepEqual(core.getSnapshot().project!.schematic.wires, initial.project!.schematic.wires);
    assert.notDeepEqual(topology(core.getSnapshot().project!.schematic), topology(schematic));
    await host.execute('history.undo');
    assert.equal(core.getSnapshot().project, initial.project);

    const revision = String(core.getSnapshot().revision);
    await host.execute('schematic.drag', input, { actor: 'agent', expectedRevision: revision });
    const dragged = core.getSnapshot();
    const circuit = dragged.project!.schematic;
    assert.equal(dragged.undoDepth, 1);
    assert.deepEqual(topology(circuit), topology(schematic));
    const pin = pinPositions(circuit.parts[0], circuit.libraries[circuit.parts[0].libId])[0];
    assert.ok(samePoint(pin, { x: a.x + 5.08, y: a.y }));
    assert.ok(circuit.wires.some((wire) => samePoint(wire.a, pin) || samePoint(wire.b, pin)));
    assert.ok(circuit.wires.some((wire) => onWire(circuit.labels[0], wire)));
    assert.ok(samePoint(circuit.labels[0], { x: a.x + 5.08, y: 35.56 }));
    assert.deepEqual(circuit.parts[1], initial.project!.schematic.parts[1]);
    assert.deepEqual(
      new Set(circuit.wires.map((wire) => wire.id)),
      new Set(schematic.wires.map((wire) => wire.id)),
    );

    await assert.rejects(
      host.execute('schematic.drag', input, { actor: 'human', expectedRevision: revision }),
      /changed/,
    );
    assert.equal(core.getSnapshot(), dragged);
    await host.execute('schematic.drag', { ...input, delta: { x: 0, y: 0 } });
    assert.equal(core.getSnapshot(), dragged);
    await host.execute('history.undo');
    assert.equal(core.getSnapshot().project, initial.project);
    await host.execute('history.redo');
    assert.equal(core.getSnapshot().project, dragged.project);

    core.updateSource('{ invalid');
    const pending = core.getSnapshot();
    await assert.rejects(host.execute('schematic.drag', input, { actor: 'agent' }), /Source/);
    assert.equal(core.getSnapshot(), pending);
    assert.equal(pending.project, dragged.project);
  } finally {
    dispose();
    host.dispose();
  }
});

test('capability schemas reject unsupported keywords and enforce nested choices without code generation', () => {
  assert.throws(
    () => compileCapabilitySchema({ type: 'string', format: 'unchecked' }),
    /Unsupported/,
  );
  const check = compileCapabilitySchema({
    type: 'object',
    required: ['items'],
    additionalProperties: false,
    properties: {
      items: {
        type: 'array',
        uniqueItems: true,
        items: {
          oneOf: [
            { type: 'number', exclusiveMinimum: 0 },
            { type: 'string', pattern: '^R[0-9]+$' },
          ],
        },
      },
    },
  });
  assert.equal(check({ items: [1, 'R2'] }).valid, true);
  for (const value of [
    { items: [0] },
    { items: ['X1'] },
    { items: [1, 1] },
    { items: [], extra: 1 },
    null,
  ])
    assert.equal(check(value).valid, false);
});

test('official library placement shares grid/reference rules and rejects a document changed while loading', async () => {
  const schematic = emptyCircuit();
  const existing = createPart(schematic, 'R', 0, 0);
  schematic.parts.push(existing);
  const core = new ProjectCore(createProject(schematic));
  const host = createCapabilityHost({ revision: () => String(core.getSnapshot().revision) });
  const previousWindow = (globalThis as any).window;
  const previousFetch = globalThis.fetch;
  let waiting: Promise<void> | undefined;
  let release: (() => void) | undefined;
  let loaded: (() => void) | undefined;
  (globalThis as any).window = {
    openpe: { connection: async () => ({ base: 'http://127.0.0.1:1', token: 'fixture' }) },
  };
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /^http:\/\/127\.0\.0\.1:1\/api\/libraries\/symbols\?id=/);
    assert.equal((options!.headers as Record<string, string>)['X-OpenPE-Token'], 'fixture');
    loaded?.();
    if (waiting) await waiting;
    return new Response(
      JSON.stringify({ id: existing.libId, symbol: schematic.libraries[existing.libId], units: 1 }),
    );
  };
  const unregister = registerLibraryCapabilities(host, core);
  try {
    const curated = (await host.query('library.search', {
      kind: 'symbols',
      library: 'ti-dcdc',
    })) as { entries: unknown[]; total: number };
    assert.ok(curated.total > 0);
    assert.equal(curated.entries.length, curated.total);
    const input = { schematicId: schematic.id, libraryId: existing.libId, x: 3, y: 6 };
    await host.execute('schematic.place', input, { actor: 'agent', expectedRevision: '0' });
    const placed = core.getSnapshot().project!.schematic.parts[1];
    assert.equal(placed.ref, 'R2');
    assert.equal(placed.x, 2.54);
    assert.equal(placed.y, 6.35);
    assert.equal(core.getSnapshot().undoDepth, 1);
    waiting = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      loaded = resolve;
    });
    const command = host.execute('schematic.place', input, {
      actor: 'agent',
      expectedRevision: '1',
    });
    await started;
    core.updateSource('{pending');
    release!();
    await assert.rejects(command, /changed/);
    assert.equal(core.getSnapshot().project!.schematic.parts.length, 2);
    assert.equal(core.getSnapshot().undoDepth, 1);
  } finally {
    unregister();
    globalThis.fetch = previousFetch;
    (globalThis as any).window = previousWindow;
  }
});

test('reviewed native and view commands cannot apply a newer Source draft', async () => {
  const core = new ProjectCore(createProject(emptyCircuit()));
  const host = createCapabilityHost();
  registerProjectCapabilities(host, core);
  let writes = 0;
  const ports: WorkbenchCapabilityPorts = {
    revision: () => String(core.getSnapshot().revision),
    state: () => core.query('project.snapshot'),
    view: () => !!core.applySource(),
    sheet: () => {},
    selection: () => {},
    panel: () => {},
    save: async () => {
      core.applySource();
      writes++;
      return 'saved';
    },
    export: async () => {
      core.applySource();
      writes++;
      return 'exported';
    },
    historyList: async () => null,
    historyRead: async () => '',
    historyCreate: async () => {
      writes++;
      return null;
    },
    simulation: async () => {
      core.applySource();
      return null;
    },
  };
  registerWorkbenchCapabilities(host, () => ports);
  const original = core.getSnapshot().source;
  const reviewedAt = String(core.getSnapshot().revision);
  const replacement = JSON.parse(original);
  replacement.project.name = 'Unreviewed draft';
  core.updateSource(JSON.stringify(replacement));
  for (const [id, input] of [
    ['project.save', {}],
    ['project.export', { format: 'gerber' }],
    ['workbench.view', { view: 'layout' }],
    ['simulation.show', {}],
    ['versions.create', { message: 'Unreviewed' }],
  ] as const)
    await assert.rejects(
      host.execute(id, input, { actor: 'agent', expectedRevision: reviewedAt }),
      /changed/,
    );
  assert.equal(writes, 0);
  assert.equal(core.getSnapshot().source, original);
  assert.notEqual(core.getSnapshot().sourceDraft, null);
});

test('suspending a workspace cancels in-flight work and blocks commands while reads remain usable', async () => {
  const host = createCapabilityHost();
  let aborted = false;
  host.register({
    owner: 'host',
    id: 'pending.run',
    kind: 'command',
    description: 'Pending work.',
    inputSchema: {},
    handler: (_, { signal }) =>
      new Promise((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolve(null);
          },
          { once: true },
        ),
      ),
  });
  const run = host.execute('pending.run');
  host.suspend('This project is closing.');
  await assert.rejects(run, /cancelled/);
  assert.equal(aborted, true);
  await assert.rejects(host.execute('pending.run'), /closing/);
  assert.ok(await host.query('capabilities.list'));
  host.resume();
  assert.equal(host.catalog().find((item) => item.id === 'pending.run')?.available, true);
});

test('the workspace revision gate also protects plugin commands before their handler runs', async () => {
  let revision = '1';
  let runs = 0;
  const host = createCapabilityHost({ revision: () => revision });
  host.register({
    owner: 'host',
    id: 'plugin.run',
    kind: 'command',
    description: 'Run a plugin.',
    inputSchema: {},
    handler: () => {
      runs++;
      return null;
    },
  });
  revision = '2';
  await assert.rejects(
    host.execute('plugin.run', {}, { actor: 'agent', expectedRevision: '1' }),
    /changed/,
  );
  assert.equal(runs, 0);
  await host.execute('plugin.run', {}, { actor: 'agent', expectedRevision: '2' });
  assert.equal(runs, 1);
});

test('Core and the capability registry execute with dynamic string code generation forbidden', async () => {
  const bundle = await build({
    stdin: {
      contents: `
    import { ProjectCore } from './core/project-core';
    import { createCapabilityHost } from './api/capabilities';
    import { registerProjectCapabilities } from './core/register-project';
    import { emptyCircuit } from './lib/circuit';
    import { createProject } from './lib/project';
    globalThis.checked = (async () => {
      const core = new ProjectCore(createProject(emptyCircuit()));
      const host = createCapabilityHost(); registerProjectCapabilities(host, core);
      await host.execute('schematic.add');
      return (await host.query('schematic.list')).length;
    })();`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    logLevel: 'silent',
  });
  const context = vm.createContext(
    { TextEncoder, AbortController, crypto: webcrypto },
    { codeGeneration: { strings: false, wasm: false } },
  );
  // Keep cloned JSON in the VM's realm, as it is in the single renderer realm.
  new vm.Script(
    'globalThis.structuredClone = value => JSON.parse(JSON.stringify(value));',
  ).runInContext(context);
  new vm.Script(bundle.outputFiles[0].text).runInContext(context);
  assert.equal(await context.checked, 2);
});
