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
import { createLibraryPart, partFields, propertyValue } from '../lib/library';
import { child, children, parseSExpr, quote, val } from '../lib/sexpr';
import { createProject, projectFromNativeFiles } from '../lib/project';
import { projectNetGroups } from '../lib/project-net-groups';
import { onWire, samePoint } from '../lib/wiring';
import {
  registerWorkbenchCapabilities,
  type WorkbenchCapabilityPorts,
} from '../lib/workbench-capabilities';
import { registerLibraryCapabilities } from '../lib/library-capabilities';
import { partSchematicSection, prepareSchematicSection } from '../lib/schematic-section';

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

test('library catalog queries share authenticated host search and preserve bounded results', async () => {
  const core = new ProjectCore(createProject(emptyCircuit()));
  const host = createCapabilityHost();
  const previousWindow = (globalThis as any).window;
  const previousFetch = globalThis.fetch;
  const requests: URL[] = [];
  const page = {
    entries: [
      { id: 'Device:R', name: 'R', library: 'Device', description: 'Resistor', keywords: 'R' },
    ],
    total: 145,
    libraries: ['Device'],
  };
  const categories = {
    categories: [
      {
        id: '1737',
        name: 'Amplifiers',
        children: [{ id: '1805', name: 'Zero Drift Amplifiers', children: [] }],
      },
    ],
  };
  (globalThis as any).window = {
    openpe: { connection: async () => ({ base: 'http://127.0.0.1:1', token: 'fixture' }) },
  };
  globalThis.fetch = async (url, options) => {
    const request = new URL(String(url));
    requests.push(request);
    assert.equal((options!.headers as Record<string, string>)['X-OpenPE-Token'], 'fixture');
    assert.ok(options?.signal instanceof AbortSignal);
    return new Response(JSON.stringify(request.searchParams.has('categories') ? categories : page));
  };
  const unregister = registerLibraryCapabilities(host, core);
  try {
    assert.deepEqual(
      await host.query('library.search', {
        kind: 'symbols',
        query: 'R & resistor',
        library: 'Device',
        offset: 100,
      }),
      page,
    );
    assert.equal(requests[0].pathname, '/api/libraries/symbols');
    assert.deepEqual(Object.fromEntries(requests[0].searchParams), {
      q: 'R & resistor',
      library: 'Device',
      offset: '100',
    });
    await host.query('library.search', { kind: 'footprints' });
    assert.equal(requests[1].pathname, '/api/libraries/footprints');
    assert.deepEqual(Object.fromEntries(requests[1].searchParams), {
      q: '',
      library: '',
      offset: '0',
    });
    const categoryCapability = host
      .catalog()
      .find((capability) => capability.id === 'library.categories');
    assert.ok(categoryCapability);
    assert.equal(categoryCapability.owner, 'host');
    assert.equal(categoryCapability.kind, 'query');
    assert.equal(categoryCapability.mutation, false);
    assert.equal(categoryCapability.available, true);
    assert.deepEqual(
      await host.query(
        'library.categories',
        {
          kind: 'symbols',
          source: 'NextPCB',
        },
        { actor: 'agent', signal: new AbortController().signal },
      ),
      categories,
    );
    assert.equal(requests[2].pathname, '/api/libraries/symbols');
    assert.deepEqual(Object.fromEntries(requests[2].searchParams), { categories: 'NextPCB' });
    assert.deepEqual(
      await host.query(
        'library.search',
        {
          kind: 'symbols',
          library: 'NextPCB',
          category: '1805',
          query: 'LM/358 & β',
          offset: 100,
        },
        { actor: 'agent' },
      ),
      page,
    );
    assert.deepEqual(Object.fromEntries(requests[3].searchParams), {
      q: 'LM/358 & β',
      library: 'NextPCB',
      category: '1805',
      offset: '100',
    });
    await assert.rejects(
      host.query('library.categories', {
        kind: 'symbols',
        source: 'NextPCB&foreign=1',
      }),
      /Invalid input for library.categories/,
    );
    await assert.rejects(
      host.query('library.search', {
        kind: 'symbols',
        library: 'NextPCB',
        category: '1'.repeat(11),
      }),
      /Invalid input for library.search/,
    );
    assert.equal(
      requests.length,
      4,
      'Invalid capability arguments never enter the host transport.',
    );
    assert.equal(core.getSnapshot().undoDepth, 0);
  } finally {
    unregister();
    globalThis.fetch = previousFetch;
    (globalThis as any).window = previousWindow;
  }
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

test('host library placement retains native section intent and classifies unassigned symbols as Simulation for human and Agent callers', async () => {
  let schematic = emptyCircuit();
  const existing = createPart(schematic, 'R', 0, 0);
  existing.excludeFromSimulation = true;
  schematic.parts.push(existing);
  const symbol = schematic.libraries[existing.libId];
  children(symbol, 'property').find((node) => val(node) === 'Footprint')![2] =
    quote('Fixture:TwoPin');
  schematic = prepareSchematicSection(schematic, [existing.id], 'simulation');
  const project = createProject(schematic);
  const previousWindow = (globalThis as any).window;
  const previousFetch = globalThis.fetch;
  let requests = 0;
  let loadedSymbol = symbol;
  (globalThis as any).window = {
    openpe: { connection: async () => ({ base: 'http://127.0.0.1:1', token: 'fixture' }) },
  };
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /\/api\/libraries\/symbols\?id=Device%3AR$/);
    assert.equal((options!.headers as Record<string, string>)['X-OpenPE-Token'], 'fixture');
    requests++;
    return Response.json({ id: existing.libId, symbol: loadedSymbol, units: 1 });
  };
  try {
    for (const assigned of [true, false]) {
      loadedSymbol = structuredClone(symbol);
      children(loadedSymbol, 'property').find((node) => val(node) === 'Footprint')![2] = quote(
        assigned ? 'Fixture:TwoPin' : '',
      );
      for (const actor of ['human', 'agent'] as const)
        for (const section of [undefined, 'hardware', 'simulation'] as const) {
          const core = new ProjectCore(project);
          const host = createCapabilityHost({
            revision: () => String(core.getSnapshot().revision),
          });
          const remove = registerLibraryCapabilities(host, core);
          try {
            const baseline = core.getNativeFiles();
            const input = { schematicId: schematic.id, libraryId: existing.libId, x: 3, y: 6 };
            const requestedBefore = requests;
            await assert.rejects(
              host.execute('schematic.place', { ...input, section: 'all' }, { actor }),
              /Invalid input/,
            );
            assert.equal(
              requests,
              requestedBefore,
              'View-only All cannot reach library transport.',
            );
            const result = (await host.execute(
              'schematic.place',
              { ...input, ...(section ? { section } : {}) },
              { actor },
            )) as { id: string; reference: string; revision: string };
            const after = core.getSnapshot();
            const placed = after.project!.schematic.parts.find((part) => part.id === result.id)!;
            assert.equal(result.reference, 'R2');
            assert.equal(result.revision, String(after.revision));
            assert.equal(
              partSchematicSection(placed),
              !assigned || section === 'simulation' ? 'simulation' : 'hardware',
            );
            assert.equal(partFields(placed).Footprint ?? '', assigned ? 'Fixture:TwoPin' : '');
            assert.equal(!!placed.excludeFromSimulation, false);
            assert.equal(placed.x, 2.54);
            assert.equal(placed.y, 6.35);
            assert.equal(after.undoDepth, 1);
            const preserved = after.project!.schematic.parts.find(
              (part) => part.id === existing.id,
            )!;
            assert.equal(partSchematicSection(preserved), 'simulation');
            assert.equal(preserved.excludeFromSimulation, true);
            const native = core.getNativeFiles();
            const reopened = projectFromNativeFiles(native);
            const instance = reopened.schematic.parts.find((part) => part.id === result.id)!;
            assert.equal(
              val(child(instance.raw!, 'on_board')),
              section === 'simulation' ? 'no' : 'yes',
            );
            assert.equal(!!instance.excludeFromSimulation, !!placed.excludeFromSimulation);
            core.undo();
            assert.deepEqual(core.getNativeFiles(), baseline);
            core.redo();
            assert.deepEqual(core.getNativeFiles(), native);
          } finally {
            remove();
            host.dispose();
          }
        }
    }
    assert.equal(requests, 12);
  } finally {
    globalThis.fetch = previousFetch;
    (globalThis as any).window = previousWindow;
  }
});

test('NextPCB GUI and Agent placement preserve native symbol fields and undo to identical native files', async () => {
  const id = 'NextPCB:9728_LM358';
  const schematic = emptyCircuit();
  const existing = createPart(schematic, 'R', 0, 0);
  existing.ref = 'U1';
  schematic.parts.push(existing);
  // Synthetic native geometry exercises the online identity without vendoring a supplier asset.
  const symbol = structuredClone(schematic.libraries[existing.libId]);
  symbol[1] = quote(id);
  for (const [name, value] of [
    ['Reference', 'U'],
    ['Value', 'LM358'],
    ['Footprint', id],
  ]) {
    const property = children(symbol, 'property').find((node) => val(node) === name)!;
    property[2] = quote(value);
  }
  symbol.push([
    'property',
    quote('Manufacturer'),
    quote('Fixture Components'),
    ['at', '0', '0', '0'],
    ['effects', ['font', ['size', '1.27', '1.27']], ['hide', 'yes']],
  ]);
  const entry = {
    id,
    name: 'LM358',
    library: 'NextPCB',
    description: 'Synthetic native fixture',
    keywords: 'amplifier',
    footprint: id,
  };
  const detail = { ...entry, symbol, units: 1 };
  const project = createProject(schematic);
  const gui = new ProjectCore(project);
  const agent = new ProjectCore(project);
  const host = createCapabilityHost({ revision: () => String(agent.getSnapshot().revision) });
  const previousWindow = (globalThis as any).window;
  const previousFetch = globalThis.fetch;
  (globalThis as any).window = {
    openpe: { connection: async () => ({ base: 'http://127.0.0.1:1', token: 'fixture' }) },
  };
  globalThis.fetch = async (url, options) => {
    const request = new URL(String(url));
    assert.equal(request.pathname, '/api/libraries/symbols');
    assert.equal((options!.headers as Record<string, string>)['X-OpenPE-Token'], 'fixture');
    if (request.searchParams.has('id')) {
      assert.equal(request.searchParams.get('id'), id);
      return Response.json(detail);
    }
    assert.equal(request.searchParams.get('library'), 'NextPCB');
    assert.equal(request.searchParams.get('q'), 'LM358');
    return Response.json({ entries: [entry], total: 1, libraries: ['NextPCB'] });
  };
  const unregister = registerLibraryCapabilities(host, agent);
  try {
    const baseline = agent.getNativeFiles();
    const search = (await host.query('library.search', {
      kind: 'symbols',
      library: 'NextPCB',
      query: 'LM358',
    })) as { entries: { id: string }[] };
    assert.equal(search.entries[0].id, id);
    const loaded = (await host.query('library.detail', { kind: 'symbols', id })) as typeof detail;
    const humanSheet = structuredClone(gui.getSnapshot().project!.schematic);
    const humanPart = createLibraryPart(humanSheet, loaded.symbol, 3, 6, 1);
    humanSheet.libraries[id] = loaded.symbol;
    humanSheet.parts.push(humanPart);
    gui.replaceSchematic(humanSheet);
    const placed = (await host.execute(
      'schematic.place',
      {
        schematicId: schematic.id,
        libraryId: id,
        x: 3,
        y: 6,
      },
      { actor: 'agent' },
    )) as { id: string; reference: string };
    assert.equal(placed.reference, 'U2');
    const part = agent.getSnapshot().project!.schematic.parts[1];
    assert.equal(partFields(part).Footprint, id);
    assert.equal(partFields(part).Manufacturer, 'Fixture Components');
    assert.equal(part.x, 2.54);
    assert.equal(part.y, 6.35);
    const native = agent.getNativeFiles();
    assert.equal(
      JSON.stringify(native).replaceAll(placed.id, humanPart.id),
      JSON.stringify(gui.getNativeFiles()),
      'GUI and Agent export the same complete native files, allowing only their newly allocated component UUID.',
    );
    const sheet = parseSExpr(native.files.find((file) => file.name.endsWith('.kicad_sch'))!.source);
    const embedded = children(child(sheet, 'lib_symbols')!, 'symbol').find(
      (node) => val(node) === id,
    )!;
    assert.ok(embedded);
    assert.equal(propertyValue(embedded, 'Footprint'), id);
    assert.equal(propertyValue(embedded, 'Manufacturer'), 'Fixture Components');
    const instance = children(sheet, 'symbol').find(
      (node) => val(child(node, 'uuid')) === placed.id,
    )!;
    assert.equal(val(child(instance, 'lib_id')), id);
    assert.equal(propertyValue(instance, 'Reference'), 'U2');
    assert.equal(propertyValue(instance, 'Value'), 'LM358');
    assert.equal(agent.getSnapshot().undoDepth, 1);
    assert.equal(gui.getSnapshot().undoDepth, 1);
    assert.equal(agent.undo(), true);
    assert.equal(gui.undo(), true);
    assert.deepEqual(agent.getNativeFiles(), baseline);
    assert.deepEqual(gui.getNativeFiles(), baseline);
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
