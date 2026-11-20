import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import fileSystem from 'node:fs/promises';
import {
  link,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProjectSpiceStore } from '../server/project-spice-files.mjs';
import { startServer } from '../server/index.mjs';
import { createProject, serializeProject } from '../lib/project';
import {
  buildSpiceDeck,
  defaultTransient,
  type SimulationResult,
  type SpiceDeck,
} from '../plugins/spice-simulation/domain/spice';
import { switchingStageFixture } from './fixtures/switching-stage';
import { liveSpiceNetlist } from '../plugins/spice-simulation/host/spice-raw.mjs';
import { withAnalysisFiles } from '../server/flat-analysis-files.mjs';

const { FileGrants } = createRequire(import.meta.url)('../electron/file-grants.cjs');
const signal = () => new AbortController().signal;
const key = 'a'.repeat(64);
const flat = (root: string, name: string, stem = 'buck') =>
  path.join(root, 'spice-simulation', stem + '.' + name);
const deck: SpiceDeck = {
  netlist: '* test',
  stop: 1,
  assumptions: [],
  traces: [{ vector: 'v(out)', unit: 'V', label: 'Output' }],
};
const result: SimulationResult = {
  time: [0, 1],
  traces: [{ ...deck.traces[0], values: [0, 5] }],
  version: 'ngspice fixture',
  log: 'completed',
};
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openpe-project-spice-'));
  const source = path.join(root, 'temporary-run');
  await mkdir(source);
  for (const name of ['circuit.cir', 'waveforms.raw', 'waveforms.txt', 'solver.log'])
    await writeFile(path.join(source, name), name);
  return { root, source };
}

test('project SPICE records survive a fresh store, isolate projects, and preserve native files', async () => {
  const { root, source } = await fixture();
  try {
    const file = path.join(root, 'buck.kicad_pro');
    await writeFile(file, 'native bytes');
    const store = createProjectSpiceStore(() => file);
    assert.equal(await store.read(key, deck, signal()), null);
    await store.write(
      key,
      source,
      result,
      signal(),
      deck,
      { ...defaultTransient(switchingStageFixture()), stop: deck.stop },
      { identityVersion: 2, solverSha256: 'f'.repeat(64) },
    );
    assert.deepEqual(
      (await readdir(path.join(root, 'spice-simulation'))).sort(),
      [
        'circuit.cir',
        'manifest.json',
        'result.json',
        'solver.log',
        'waveforms.raw',
        'waveforms.txt',
      ].map((name) => 'buck.' + name),
    );
    assert.equal(await readFile(flat(root, 'waveforms.raw'), 'utf8'), 'waveforms.raw');
    assert.deepEqual(await createProjectSpiceStore(() => file).read(key, deck, signal()), result);
    assert.equal(await store.read('b'.repeat(64), deck, signal()), null);
    assert.equal(
      await createProjectSpiceStore(() => path.join(root, 'other.kicad_pro')).read(
        key,
        deck,
        signal(),
      ),
      null,
    );
    assert.equal(await readFile(file, 'utf8'), 'native bytes');
    await assert.rejects(
      store.write(
        key,
        source,
        result,
        signal(),
        deck,
        { ...defaultTransient(switchingStageFixture()), stop: deck.stop },
        { identityVersion: 2, solverSha256: 'f'.repeat(64) },
      ),
      /already exists/,
    );
    await assert.rejects(store.read('../outside', deck, signal()), /identity/);
    await assert.rejects(store.read(key, { ...deck, stop: 2 }, signal()), /Incomplete/);
    await writeFile(flat(root, 'result.json'), JSON.stringify({ ...result, time: [0, 2] }));
    await assert.rejects(store.read(key, deck, signal()), /integrity/);
    assert.match(await readFile(flat(root, 'result.json'), 'utf8'), /\[0,2\]/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('saved SPICE reads reject files replaced between inspection and opening', async (context) => {
  const { root, source } = await fixture();
  const originalOpen = fileSystem.open;
  try {
    const store = createProjectSpiceStore(() => path.join(root, 'buck.kicad_pro'));
    await store.write(
      key,
      source,
      result,
      signal(),
      deck,
      { ...defaultTransient(switchingStageFixture()), stop: deck.stop },
      { identityVersion: 2, solverSha256: 'f'.repeat(64) },
    );
    const manifest = flat(root, 'manifest.json');
    const bytes = await readFile(manifest);
    let replaced = false;
    context.mock.method(fileSystem, 'open', async (...args: Parameters<typeof fileSystem.open>) => {
      if (!replaced && (await realpath(String(args[0]))) === (await realpath(manifest))) {
        replaced = true;
        await rename(manifest, `${manifest}.previous`);
        await writeFile(manifest, bytes);
      }
      return originalOpen(...args);
    });
    syncBuiltinESMExports();
    await assert.rejects(store.read(key, deck, signal()), /changed while opening/);
    assert.equal(replaced, true);
    assert.deepEqual(await readFile(manifest), bytes);
    assert.deepEqual(await readFile(`${manifest}.previous`), bytes);
  } finally {
    context.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test('saved SPICE hard links cannot be loaded or pruned as owned records', async () => {
  const { root, source } = await fixture();
  try {
    const store = createProjectSpiceStore(() => path.join(root, 'buck.kicad_pro'));
    await store.write(
      key,
      source,
      result,
      signal(),
      deck,
      { ...defaultTransient(switchingStageFixture()), stop: deck.stop },
      { identityVersion: 2, solverSha256: 'f'.repeat(64) },
    );
    const shared = path.join(root, 'shared-result.json');
    await link(flat(root, 'result.json'), shared);
    await assert.rejects(store.read(key, deck, signal()), /without links/);
    await assert.rejects(
      store.write(
        'b'.repeat(64),
        source,
        result,
        signal(),
        deck,
        { ...defaultTransient(switchingStageFixture()), stop: deck.stop },
        { identityVersion: 2, solverSha256: 'f'.repeat(64) },
      ),
      /without links/,
    );
    assert.deepEqual(JSON.parse(await readFile(shared, 'utf8')), result);
    assert.deepEqual(JSON.parse(await readFile(flat(root, 'result.json'), 'utf8')), result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('saved settings reject corruption, unknown fields, linked decks and cancelled or revoked reads', async () => {
  const { root, source } = await fixture();
  try {
    const config = { ...defaultTransient(switchingStageFixture()), stop: 1, step: 0.1 };
    let file: string | null = path.join(root, 'buck.kicad_pro');
    const store = createProjectSpiceStore(() => file);
    assert.equal(await store.readSettings(signal()), null);
    for (const invalid of [
      { ...config, step: 0 },
      { ...config, directory: root },
      { ...config, inputId: 1 },
    ])
      await assert.rejects(
        store.write(key, source, result, signal(), deck, invalid, {
          identityVersion: 2,
          solverSha256: 'f'.repeat(64),
        }),
        /transient settings/,
      );
    assert.equal((await readdir(root)).includes('spice-simulation'), false);
    await writeFile(path.join(source, 'circuit.cir'), '.tran 0.1 1 0 0.1\n');
    await store.write(key, source, result, signal(), deck, config, {
      identityVersion: 2,
      solverSha256: 'f'.repeat(64),
    });
    assert.deepEqual(await createProjectSpiceStore(() => file).readSettings(signal()), {
      key,
      config,
    });
    await assert.rejects(store.readSettings(AbortSignal.abort()), /abort/i);
    const manifestFile = flat(root, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    for (const retired of [
      { ...manifest, format: 'openpe-spice-v1' },
      { ...manifest, identityVersion: undefined, solverSha256: undefined },
      { ...manifest, identityVersion: 1 },
    ]) {
      const bytes = JSON.stringify(retired);
      await writeFile(manifestFile, bytes);
      await assert.rejects(store.read(key, deck, signal()), /saved simulation manifest/);
      assert.equal(await readFile(manifestFile, 'utf8'), bytes);
    }
    await writeFile(
      manifestFile,
      JSON.stringify({ ...manifest, config: { ...config, command: 'ignored' } }),
    );
    await assert.rejects(store.readSettings(signal()), /transient settings/);
    delete manifest.config;
    await writeFile(manifestFile, JSON.stringify(manifest));
    await assert.rejects(store.readSettings(signal()), /transient settings/);
    manifest.config = config;
    await writeFile(manifestFile, JSON.stringify(manifest));
    await rm(flat(root, 'circuit.cir'));
    await symlink(
      source,
      flat(root, 'circuit.cir'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(store.readSettings(signal()), /without links/);
    file = null;
    await assert.rejects(store.readSettings(signal()), /destination changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('saved SPICE heat windows retain original timing through rounded endpoints and current reads', async () => {
  const { root, source } = await fixture();
  try {
    const config = { ...defaultTransient(switchingStageFixture()), stop: 0.01, step: 0.001 };
    const currentDeck: SpiceDeck = {
      netlist:
        '* heat fixture\n.control\ntran 0.001 0.01 0 0.001\nwrdata waveforms.txt v(out) @rload[i]\n.endc\n.end\n',
      stop: config.stop,
      assumptions: [],
      traces: [
        { vector: 'v(out)', unit: 'V', label: 'Output' },
        {
          vector: '@rload[i]',
          unit: 'A',
          label: 'Load current',
          targets: [{ kind: 'current', id: 'original-resistor' }],
          dissipation: {
            positivePin: '1',
            negativePin: '2',
            positiveNode: 'out',
            negativeNode: '0',
            method: 'resistor',
          },
        },
      ],
    };
    const completed: SimulationResult = {
      time: [0, 0.01000000000000035],
      traces: currentDeck.traces.map((trace) => ({ ...trace, values: [0, 1] })),
      version: 'ngspice fixture',
      log: 'completed',
      dissipation: {
        startS: config.stop * 0.8,
        endS: config.stop,
        sampleCount: 1000,
        powers: [{ vector: '@rload[i]', powerW: 0.25 }],
      },
    };
    const file = path.join(root, 'buck.kicad_pro');
    await writeFile(path.join(source, 'circuit.cir'), liveSpiceNetlist(currentDeck));
    const store = createProjectSpiceStore(() => file);
    await store.write(key, source, completed, signal(), currentDeck, config, {
      identityVersion: 2,
      solverSha256: 'f'.repeat(64),
    });
    const fresh = createProjectSpiceStore(() => file);
    const settings = await fresh.readSettings(signal());
    assert.deepEqual(settings, {
      key,
      config,
    });
    const retargeted: SpiceDeck = {
      ...currentDeck,
      traces: currentDeck.traces.map((trace) => ({
        ...trace,
        ...(trace.targets ? { targets: [{ kind: 'current', id: 'current-resistor' }] } : {}),
      })),
    };
    const loaded = await fresh.read(key, retargeted, signal());
    assert.deepEqual(loaded, {
      ...completed,
      traces: completed.traces.map((trace, index) => ({ ...trace, ...retargeted.traces[index] })),
    });
    const manifestFile = flat(root, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    const invalid = JSON.stringify({
      ...completed,
      dissipation: { ...completed.dissipation, endS: completed.time.at(-1) },
    });
    await writeFile(flat(root, 'result.json'), invalid);
    await writeFile(
      manifestFile,
      JSON.stringify({
        ...manifest,
        resultSha256: createHash('sha256').update(invalid).digest('hex'),
      }),
    );
    await assert.rejects(fresh.readSettings(signal()), /full-resolution SPICE heat summary/);
    await writeFile(flat(root, 'result.json'), JSON.stringify(completed));
    await writeFile(manifestFile, JSON.stringify(manifest));
    await store.write('b'.repeat(64), source, completed, signal(), currentDeck, config, {
      identityVersion: 2,
      solverSha256: 'f'.repeat(64),
    });
    assert.equal(
      JSON.parse(await readFile(flat(root, 'manifest.json'), 'utf8')).key,
      'b'.repeat(64),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('SPICE storage rejects unsaved/revoked/moved grants and linked folders without touching targets', async () => {
  const { root, source } = await fixture();
  try {
    const grants = new FileGrants();
    const id = grants.create();
    assert.throws(() => createProjectSpiceStore(() => grants.get(id)), /Save the project/);
    const file = path.join(root, 'buck.kicad_pro');
    grants.assign(id, file);
    const store = createProjectSpiceStore(() => grants.get(id));
    grants.assign(id, path.join(root, 'other.kicad_pro'));
    await assert.rejects(
      store.write(
        key,
        source,
        result,
        signal(),
        deck,
        { ...defaultTransient(switchingStageFixture()), stop: deck.stop },
        { identityVersion: 2, solverSha256: 'f'.repeat(64) },
      ),
      /destination changed/,
    );
    grants.release(id);
    await assert.rejects(store.read(key, deck, signal()), /grant/);
    const outside = path.join(root, 'untouched');
    await mkdir(outside);
    await symlink(
      outside,
      path.join(root, 'spice-simulation'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const linked = createProjectSpiceStore(() => file);
    await assert.rejects(linked.read(key, deck, signal()), /without links/);
    await assert.rejects(linked.write(key, source, result, signal(), deck), /without links/);
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('SPICE storage rejects a project parent replaced by a link after use', async () => {
  const { root, source } = await fixture();
  try {
    const parent = path.join(root, 'project');
    const moved = path.join(root, 'original-project');
    const outside = path.join(root, 'untouched');
    await mkdir(parent);
    await mkdir(outside);
    const store = createProjectSpiceStore(() => path.join(parent, 'buck.kicad_pro'));
    await store.write(
      key,
      source,
      result,
      signal(),
      deck,
      { ...defaultTransient(switchingStageFixture()), stop: deck.stop },
      { identityVersion: 2, solverSha256: 'f'.repeat(64) },
    );
    await rename(parent, moved);
    await symlink(outside, parent, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(store.read(key, deck, signal()), /project directory changed/);
    await assert.rejects(
      store.write(
        'b'.repeat(64),
        source,
        result,
        signal(),
        deck,
        { ...defaultTransient(switchingStageFixture()), stop: deck.stop },
        { identityVersion: 2, solverSha256: 'f'.repeat(64) },
      ),
      /project directory changed/,
    );
    assert.deepEqual(await readdir(outside), []);
    assert.deepEqual(
      await createProjectSpiceStore(() => path.join(moved, 'buck.kicad_pro')).read(
        key,
        deck,
        signal(),
      ),
      result,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('incomplete or cancelled SPICE writes never publish a completed record', async () => {
  const { root, source } = await fixture();
  try {
    const store = createProjectSpiceStore(() => path.join(root, 'buck.kicad_pro'));
    await rm(path.join(source, 'waveforms.raw'));
    await assert.rejects(
      store.write(
        key,
        source,
        result,
        signal(),
        deck,
        { ...defaultTransient(switchingStageFixture()), stop: deck.stop },
        { identityVersion: 2, solverSha256: 'f'.repeat(64) },
      ),
      /regular/,
    );
    assert.deepEqual(await readdir(path.join(root, 'spice-simulation')), []);
    await assert.rejects(
      store.write(
        key,
        source,
        result,
        AbortSignal.abort(),
        deck,
        { ...defaultTransient(switchingStageFixture()), stop: deck.stop },
        { identityVersion: 2, solverSha256: 'f'.repeat(64) },
      ),
      /abort/i,
    );
    assert.deepEqual(await readdir(path.join(root, 'spice-simulation')), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('cancelled queued SPICE lookups reject even when no saved directory exists', async () => {
  for (const method of ['readSettings', 'read'] as const) {
    const { root } = await fixture();
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const held = withAnalysisFiles(path.join(root, 'spice-simulation'), () => gate);
      const controller = new AbortController();
      const store = createProjectSpiceStore(() => path.join(root, 'buck.kicad_pro'));
      const pending =
        method === 'readSettings'
          ? store.readSettings(controller.signal)
          : store.read(key, deck, controller.signal);
      controller.abort();
      release();
      await held;
      await assert.rejects(pending, /abort/i);
      assert.equal((await readdir(root)).includes('spice-simulation'), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('flat SPICE publication isolates projects in one folder and protects sidecars and unknown collisions', async () => {
  const { root, source } = await fixture();
  try {
    const store = createProjectSpiceStore(() => path.join(root, 'buck.kicad_pro'));
    const other = createProjectSpiceStore(() => path.join(root, 'other.kicad_pro'));
    await store.write(
      key,
      source,
      result,
      signal(),
      deck,
      { ...defaultTransient(switchingStageFixture()), stop: deck.stop },
      { identityVersion: 2, solverSha256: 'f'.repeat(64) },
    );
    await other.write(
      key,
      source,
      result,
      signal(),
      deck,
      { ...defaultTransient(switchingStageFixture()), stop: deck.stop },
      { identityVersion: 2, solverSha256: 'f'.repeat(64) },
    );
    await writeFile(path.join(root, 'spice-simulation/notes.txt'), 'personal sidecar');
    const next = 'b'.repeat(64);
    await store.write(
      next,
      source,
      result,
      signal(),
      deck,
      { ...defaultTransient(switchingStageFixture()), stop: deck.stop },
      { identityVersion: 2, solverSha256: 'f'.repeat(64) },
    );
    assert.equal(await store.read(key, deck, signal()), null);
    assert.deepEqual(await store.read(next, deck, signal()), result);
    assert.deepEqual(await other.read(key, deck, signal()), result);
    assert.equal(
      await readFile(path.join(root, 'spice-simulation/notes.txt'), 'utf8'),
      'personal sidecar',
    );
    assert.ok(
      (await readdir(path.join(root, 'spice-simulation'), { withFileTypes: true })).every((entry) =>
        entry.isFile(),
      ),
    );
    const unknown = flat(root, 'ti-model.lib');
    await writeFile(unknown, 'personal model');
    await writeFile(path.join(source, 'ti-model.lib'), 'prepared model');
    await assert.rejects(
      store.write(
        'c'.repeat(64),
        source,
        result,
        signal(),
        { ...deck, modelId: 'fixture' },
        {
          ...defaultTransient(switchingStageFixture()),
          stop: { ...deck, modelId: 'fixture' }.stop,
        },
        { identityVersion: 2, solverSha256: 'f'.repeat(64) },
      ),
      /unknown analysis file/,
    );
    assert.equal(await readFile(unknown, 'utf8'), 'personal model');
    assert.deepEqual(await store.read(next, deck, signal()), result);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('retired nested SPICE records are ignored without reading or rewriting them', async () => {
  const { root, source } = await fixture();
  try {
    const store = createProjectSpiceStore(() => path.join(root, 'buck.kicad_pro'));
    await store.write(
      key,
      source,
      result,
      signal(),
      deck,
      { ...defaultTransient(switchingStageFixture()), stop: deck.stop },
      { identityVersion: 2, solverSha256: 'f'.repeat(64) },
    );
    const manifest = JSON.parse(await readFile(flat(root, 'manifest.json'), 'utf8'));
    const target = path.join(root, 'spice-simulation/buck', key);
    await mkdir(target, { recursive: true });
    for (const file of manifest.files)
      await rename(path.join(root, 'spice-simulation', file.file), path.join(target, file.name));
    delete manifest.project;
    delete manifest.files;
    manifest.format = 'openpe-spice-v1';
    const bytes = JSON.stringify(manifest);
    await writeFile(path.join(target, 'manifest.json'), bytes);
    await rm(flat(root, 'manifest.json'));
    const pointer = path.join(root, 'spice-simulation/buck/latest.json');
    await writeFile(pointer, JSON.stringify({ format: 'openpe-spice-latest-v1', key }));
    assert.equal(await store.read(key, deck, signal()), null);
    assert.equal(await store.readSettings(signal()), null);
    await rm(pointer);
    assert.equal(await store.read(key, deck, signal()), null);
    assert.equal(await readFile(path.join(target, 'manifest.json'), 'utf8'), bytes);
    assert.equal(
      (await readdir(path.join(root, 'spice-simulation'))).includes('buck.manifest.json'),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('saved-result HTTP lookup never runs a solver or downloads models and respects grants and plugin state', async () => {
  const { root } = await fixture();
  const grants = new FileGrants();
  const id = grants.create(path.join(root, 'buck.kicad_pro'));
  const schematic = switchingStageFixture();
  const currentDeck = buildSpiceDeck(schematic, defaultTransient(schematic));
  const lookupResult = {
    ...result,
    time: [0, currentDeck.stop],
    traces: currentDeck.traces.map((trace) => ({ ...trace, values: [0, 5] })),
  };
  let lookups = 0,
    runs = 0,
    downloads = 0,
    checkModels = false;
  const server = await startServer({
    dataDir: root,
    simulationModelFetcher: async () => {
      downloads++;
      throw new Error('No downloads during lookup.');
    },
    simulationResultFiles: {
      forProject: (fileId: string) => createProjectSpiceStore(() => grants.get(fileId)),
    },
    simulationResultLoader: async (
      _deck: SpiceDeck,
      signal: AbortSignal,
      models: (id: string, signal: AbortSignal) => Promise<Buffer>,
    ) => {
      lookups++;
      if (checkModels) await models('lm2596-5', signal);
      return lookups === 1 ? lookupResult : null;
    },
    simulationRunner: async () => {
      runs++;
      return result;
    },
  });
  try {
    const body = {
      source: serializeProject(createProject(schematic)),
      config: defaultTransient(schematic),
      fileId: id,
    };
    const headers = { 'X-OpenPE-Token': server.token, 'Content-Type': 'application/json' };
    const request = (extra = {}, authenticated = true) =>
      fetch(server.base + '/api/simulation/result', {
        method: 'POST',
        headers: authenticated ? headers : { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, ...extra }),
      });
    assert.equal((await request({}, false)).status, 401);
    assert.equal((await request({ directory: root })).status, 400);
    assert.deepEqual((await (await request()).json()).result, lookupResult);
    assert.equal((await (await request()).json()).result, null);
    checkModels = true;
    assert.equal((await request()).status, 422);
    assert.equal(downloads, 0);
    assert.equal(runs, 0);
    grants.release(id);
    assert.equal((await request()).status, 400);
    const count = lookups;
    await fetch(server.base + '/api/workbench-plugins', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action: 'disable', id: 'spice-simulation@openpe' }),
    });
    assert.equal((await request()).status, 403);
    assert.equal(lookups, count);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('simulation API binds result storage to opaque grants and rejects missing grants or renderer paths', async () => {
  const { root } = await fixture();
  const grants = new FileGrants();
  const id = grants.create(path.join(root, 'buck.kicad_pro'));
  let calls = 0;
  const store = createProjectSpiceStore(() => grants.get(id));
  const server = await startServer({
    dataDir: root,
    simulationResultFiles: {
      forProject: (fileId: string) => {
        grants.get(fileId);
        assert.equal(fileId, id);
        return store;
      },
    },
    simulationRunner: async (
      _deck: unknown,
      _signal: AbortSignal,
      _models: unknown,
      _root: unknown,
      _samples: unknown,
      files: unknown,
    ) => {
      calls++;
      assert.equal(files, store);
      return result;
    },
  });
  try {
    const schematic = switchingStageFixture();
    const body = {
      source: serializeProject(createProject(schematic)),
      config: defaultTransient(schematic),
    };
    const request = (extra: object) =>
      fetch(server.base + '/api/simulation/transient', {
        method: 'POST',
        headers: { 'X-OpenPE-Token': server.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, ...extra }),
      });
    assert.match((await (await request({})).json()).error, /Save the project/);
    assert.equal((await request({ fileId: id, directory: root })).status, 400);
    assert.equal(calls, 0);
    assert.equal((await request({ fileId: id })).status, 200);
    assert.equal(calls, 1);
    grants.release(id);
    assert.equal((await request({ fileId: id })).status, 400);
    assert.equal(calls, 1);
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('SPICE storage allows a /var ancestor and rejects a replaced path component', async () => {
  const { root, source } = await fixture();
  const alias = path.join(path.dirname(root), `${path.basename(root)}-alias`);
  try {
    if (process.platform === 'darwin') {
      const canonical = await realpath(root);
      assert.notEqual(path.resolve(root), canonical);
      assert.match(path.resolve(root), /^\/var\//);
      assert.match(canonical, /^\/private\/var\//);
    }
    const file = path.join(root, 'buck.kicad_pro');
    await writeFile(file, 'native bytes');
    const store = createProjectSpiceStore(() => file);
    await store.write(
      key,
      source,
      result,
      signal(),
      deck,
      { ...defaultTransient(switchingStageFixture()), stop: deck.stop },
      { identityVersion: 2, solverSha256: 'f'.repeat(64) },
    );
    assert.equal((await store.read(key, deck, signal()))?.log, 'completed');
    await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const linked = createProjectSpiceStore(() => path.join(alias, 'buck.kicad_pro'));
    await assert.rejects(linked.read(key, deck, signal()), /without links/);
  } finally {
    await rm(alias, { force: true });
    await rm(root, { recursive: true, force: true });
  }
});
