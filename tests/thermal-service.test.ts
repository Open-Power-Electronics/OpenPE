import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { uid } from '../lib/circuit';
import { createProject, parseProject, serializeProject } from '../lib/project';
import { createEmptyPCB } from '../lib/pcb-layout';
import {
  defaultThermalConfig,
  prepareThermalModel,
  type ThermalModel,
  type ThermalResult,
} from '../lib/thermal';
import { startServer } from '../server/index.mjs';
import {
  createWorkbenchPlugins,
  bundledWorkbenchCatalog,
  spicePluginId,
  thermalPluginId,
} from '../server/workbench-plugins.mjs';

function fixture() {
  const project = createProject();
  const pcb = createEmptyPCB();
  const corners = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];
  pcb.graphics = corners.map((start, i) => ({
    id: uid(),
    start,
    end: corners[(i + 1) % 4],
    width: 0.1,
    layer: 'Edge.Cuts',
  }));
  pcb.footprints = [
    {
      id: uid(),
      symbolId: null,
      libraryId: 'Test:Heater',
      reference: 'U1',
      value: 'Heater',
      x: 5,
      y: 5,
      rotation: 0,
      side: 'front',
      graphics: [],
      pads: [
        {
          id: uid(),
          number: '1',
          x: 0,
          y: 0,
          rotation: 0,
          type: 'smd',
          shape: 'rect',
          size: { x: 2, y: 2 },
          netId: null,
        },
      ],
    },
  ];
  project.pcb = pcb;
  const config = defaultThermalConfig(pcb);
  config.heatSources = [{ footprintId: pcb.footprints[0].id, powerW: 1 }];
  return { source: serializeProject(project), config };
}

function completedResult(model: ThermalModel): ThermalResult {
  return {
    version: 1,
    status: 'completed',
    basis: model.basis,
    solver: { gmsh: 'fixture-gmsh', elmer: 'fixture-elmer' },
    points: [
      { x: 0, y: 0, z: 0, temperatureC: 30 },
      { x: 10, y: 0, z: 0, temperatureC: 30 },
      { x: 0, y: 10, z: 0, temperatureC: 30 },
    ],
    triangles: [[0, 1, 2]],
    statistics: {
      minC: 30,
      maxC: 30,
      meanC: 30,
      inputPowerW: 1,
      outputPowerW: 1,
      energyImbalanceRelative: 0,
      nodeCount: 3,
      elementCount: 1,
    },
    assumptions: model.assumptions,
    diagnostics: [],
  };
}

test('current complete lifecycle preserves independent SPICE and Layout Thermal flags', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openpe-thermal-lifecycle-'));
  const filename = path.join(directory, 'workbench-plugins-v1.json');
  try {
    const bytes = JSON.stringify({
      version: 1,
      plugins: bundledWorkbenchCatalog().plugins.map(({ id }: { id: string }) => ({
        id,
        installed: true,
        enabled: id !== spicePluginId,
      })),
    });
    await writeFile(filename, bytes);
    const service = createWorkbenchPlugins(directory);
    const catalog = await service.list();
    assert.equal(
      catalog.plugins.find((p: { id: string }) => p.id === spicePluginId)?.enabled,
      false,
    );
    const thermal = catalog.plugins.find((p: { id: string }) => p.id === thermalPluginId);
    assert.equal(thermal?.name, 'Layout Thermal');
    assert.equal(thermal?.enabled, true);
    await service.requireThermal();
    await assert.rejects(service.requireSpice(), /SPICE/);
    assert.equal(await readFile(filename, 'utf8'), bytes);
    await service.change('disable', thermalPluginId);
    await assert.rejects(service.requireThermal(), /Layout Thermal/);
    const saved = JSON.parse(await readFile(filename, 'utf8'));
    assert.deepEqual(
      saved.plugins.map((plugin: { id: string }) => plugin.id),
      catalog.plugins.map((plugin: { id: string }) => plugin.id),
    );
    assert.equal(saved.plugins.find((p: { id: string }) => p.id === spicePluginId).enabled, false);
    await writeFile(
      filename,
      JSON.stringify({
        version: 1,
        plugins: [{ id: thermalPluginId, installed: true, enabled: true }],
      }),
    );
    await assert.rejects(createWorkbenchPlugins(directory).list(), /preserved/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('thermal routes authenticate, reject executable inputs and cancel only their own lifecycle', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openpe-thermal-service-'));
  let detections = 0;
  let calls = 0;
  let signal: AbortSignal | undefined;
  let release!: () => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const server = await startServer({
    dataDir: directory,
    thermalDetector: async () => {
      detections++;
      return { available: true, gmsh: 'fixture', elmer: 'fixture', identity: 'a'.repeat(64) };
    },
    thermalRunner: async (_model: unknown, requestSignal: AbortSignal) => {
      calls++;
      signal = requestSignal;
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
        requestSignal.addEventListener('abort', () => resolve(), { once: true });
      });
      requestSignal.throwIfAborted();
      throw new Error('fixture stop');
    },
  });
  const headers = { 'X-OpenPE-Token': server.token, 'Content-Type': 'application/json' };
  const payload = fixture();
  const post = (route: string, body: unknown) =>
    fetch(server.base + route, { method: 'POST', headers, body: JSON.stringify(body) });
  const change = (id: string, action: string) => post('/api/workbench-plugins', { id, action });
  try {
    assert.equal((await fetch(server.base + '/api/thermal/status')).status, 401);
    assert.equal(
      (
        await fetch(server.base + '/api/thermal/status', {
          headers: { ...headers, Origin: 'https://untrusted.example' },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(server.base + '/api/thermal/status?path=solver', { headers })).status,
      400,
    );
    assert.equal((await fetch(server.base + '/api/thermal/status', { headers })).status, 200);
    assert.equal(detections, 1);
    for (const extra of [
      { executable: 'cmd.exe' },
      { mesh: 'script' },
      { path: '../outside' },
      { url: 'https://untrusted.example' },
    ])
      assert.equal((await post('/api/thermal/run', { ...payload, ...extra })).status, 400);
    assert.equal(calls, 0);
    const pending = post('/api/thermal/run', payload);
    await running;
    assert.equal((await post('/api/thermal/run', payload)).status, 409);
    await change(spicePluginId, 'disable');
    assert.equal(signal?.aborted, false);
    await change(thermalPluginId, 'disable');
    assert.equal((await pending).status, 409);
    assert.equal(signal?.aborted, true);
    assert.equal((await post('/api/thermal/run', payload)).status, 403);
    assert.equal((await fetch(server.base + '/api/thermal/status', { headers })).status, 403);
    assert.equal(calls, 1);
    assert.equal(detections, 1);
  } finally {
    release?.();
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('thermal results publish through live grants and restore matching inputs without running a solver', async () => {
  await mkdir('test-results', { recursive: true });
  const directory = await mkdtemp(path.resolve('test-results/thermal-results-service-'));
  const payload = fixture();
  const fileId = '00000000-0000-4000-8000-000000000001';
  const solver = { gmsh: 'fixture-gmsh', elmer: 'fixture-elmer', identity: 'a'.repeat(64) };
  type Saved = { model: ThermalModel; result: ThermalResult; solver: typeof solver };
  let saved: Saved | null = null;
  let live = true;
  let runs = 0;
  let reads = 0;
  let writes = 0;
  let detections = 0;
  let resourceIdentity = solver.identity;
  let saveFailure = false;
  let readFailure = false;
  const server = await startServer({
    dataDir: directory,
    thermalResultFiles: {
      forProject: (id: string) => {
        assert.equal(id, fileId);
        return live
          ? {
              read: async (signal: AbortSignal) => {
                reads++;
                signal.throwIfAborted();
                if (readFailure) throw new Error('Saved thermal file failed its integrity check.');
                return saved;
              },
              write: async (
                stage: string,
                model: ThermalModel,
                result: ThermalResult,
                identity: typeof solver,
                signal: AbortSignal,
              ) => {
                assert.equal(stage, 'trusted-runtime-stage');
                signal.throwIfAborted();
                if (saveFailure) throw new Error('Disk full.');
                saved = structuredClone({ model, result, solver: identity });
                writes++;
              },
            }
          : null;
      },
    },
    thermalDetector: async () => {
      detections++;
      return { available: true, ...solver, identity: resourceIdentity };
    },
    thermalRunner: async (
      model: ThermalModel,
      signal: AbortSignal,
      _root: unknown,
      _progress: unknown,
      onCompleted: (output: {
        directory: string;
        result: ThermalResult;
        solver: typeof solver;
      }) => Promise<void>,
    ) => {
      runs++;
      const result = completedResult(model);
      signal.throwIfAborted();
      await onCompleted({ directory: 'trusted-runtime-stage', result, solver });
      return result;
    },
  });
  const headers = { 'X-OpenPE-Token': server.token, 'Content-Type': 'application/json' };
  const post = (route: string, body: unknown) =>
    fetch(server.base + route, { method: 'POST', headers, body: JSON.stringify(body) });
  const lookup = (extra: Record<string, unknown> = {}) =>
    post('/api/thermal/result', { source: payload.source, fileId, ...extra });
  try {
    assert.equal(
      (await fetch(server.base + '/api/thermal/result', { method: 'POST' })).status,
      401,
    );
    assert.equal((await post('/api/thermal/result', { source: payload.source })).status, 400);
    assert.deepEqual(await (await lookup()).json(), { result: null });
    assert.equal(runs, 0);
    assert.equal(detections, 0);
    assert.equal((await post('/api/thermal/run', payload)).status, 400);
    live = false;
    assert.equal((await post('/api/thermal/run', { ...payload, fileId })).status, 400);
    assert.deepEqual(await (await lookup()).json(), { result: null });
    live = true;
    for (const extra of [
      { fileId: '../outside' },
      { directory: 'C:/outside' },
      { mesh: 'untrusted' },
      { executable: 'cmd.exe' },
    ]) {
      assert.equal((await lookup(extra)).status, 400);
      assert.equal((await post('/api/thermal/run', { ...payload, fileId, ...extra })).status, 400);
    }
    assert.equal(runs, 0);
    const response = await post('/api/thermal/run', { ...payload, fileId });
    assert.equal(response.status, 200);
    const { result } = await response.json();
    assert.equal(runs, 1);
    assert.equal(writes, 1);
    assert.deepEqual(await (await lookup()).json(), { result, config: payload.config });
    assert.deepEqual(await (await lookup({ config: payload.config })).json(), {
      result,
      config: payload.config,
    });
    assert.equal(runs, 1, 'Loading a saved result never executes the runner.');
    const changedConfig = { ...payload.config, ambientC: payload.config.ambientC + 1 };
    assert.deepEqual(await (await lookup({ config: changedConfig })).json(), { result: null });
    const changedProject = parseProject(payload.source);
    changedProject.pcb!.thickness += 0.1;
    assert.deepEqual(await (await lookup({ source: serializeProject(changedProject) })).json(), {
      result: null,
    });
    const unrelatedProject = parseProject(payload.source);
    unrelatedProject.schematic.title = 'Unrelated schematic title';
    assert.deepEqual(await (await lookup({ source: serializeProject(unrelatedProject) })).json(), {
      result,
      config: payload.config,
    });
    resourceIdentity = 'b'.repeat(64);
    assert.deepEqual(await (await lookup()).json(), { result: null });
    resourceIdentity = solver.identity;
    readFailure = true;
    const damaged = await lookup();
    assert.equal(damaged.status, 422);
    assert.match((await damaged.json()).error, /integrity/);
    readFailure = false;
    saveFailure = true;
    const failedSave = await post('/api/thermal/run', { ...payload, fileId });
    assert.equal(failedSave.status, 422);
    const saveError = (await failedSave.json()).error;
    assert.match(saveError, /Could not save.*available disk space/);
    assert.doesNotMatch(saveError, /Disk full/);
    assert.equal(writes, 1);
    assert.deepEqual(await (await lookup()).json(), { result, config: payload.config });
    const before = { reads, detections };
    await post('/api/workbench-plugins', { id: thermalPluginId, action: 'disable' });
    assert.equal((await lookup()).status, 403);
    assert.equal((await post('/api/thermal/run', { ...payload, fileId })).status, 403);
    assert.deepEqual({ reads, detections }, before);
    assert.equal(runs, 2);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('thermal service keeps native diagnostics private across run, detection and saved-result failures', async () => {
  await mkdir('test-results', { recursive: true });
  const directory = await mkdtemp(path.resolve('test-results/thermal-public-errors-'));
  const sentinel = 'PRIVATE_THERMAL_SENTINEL .subckt PRIVATE_MODEL 1 2 C:/private/solver.log';
  let failure = new Error(`Gmsh could not mesh this PCB. ${sentinel}`),
    calls = 0,
    detectionThrows = false;
  const server = await startServer({
    dataDir: directory,
    thermalRunner: async () => {
      calls++;
      throw failure;
    },
    thermalDetector: async () => {
      if (detectionThrows) throw new Error(sentinel);
      return { available: false, diagnostic: sentinel, log: sentinel };
    },
    thermalResultFiles: {
      forProject: () => ({
        read: async () => {
          throw new Error(sentinel);
        },
        write: async () => {
          throw new Error(sentinel);
        },
      }),
    },
  });
  const headers = { 'X-OpenPE-Token': server.token, 'Content-Type': 'application/json' };
  const payload = { ...fixture(), fileId: uid() };
  const post = (route: string, body: unknown) =>
    fetch(server.base + route, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    for (const [prefix, expected] of [
      ['Gmsh could not mesh this PCB. ', /Gmsh.*Mesh size/],
      ['Elmer did not converge. ', /Elmer did not converge/],
      [
        'Elmer did not produce exactly one steady temperature result. ',
        /invalid or incomplete temperature field/,
      ],
      ['Unknown runtime failure: ', /Thermal analysis could not complete/],
    ] as [string, RegExp][]) {
      failure = new Error(prefix + sentinel);
      const response = await post('/api/thermal/run', payload),
        body = await response.json();
      assert.equal(response.status, 422);
      assert.match(body.error, expected);
      assert.doesNotMatch(JSON.stringify(body), /PRIVATE_|\.subckt|C:\/private|solver\.log/);
      assert.equal(failure.message, prefix + sentinel);
    }
    const unavailable = await fetch(server.base + '/api/thermal/status', { headers });
    const status = await unavailable.json();
    assert.equal(status.available, false);
    assert.match(status.error, /thermal:prepare/);
    assert.equal(status.diagnostic, status.error);
    assert.equal(Object.hasOwn(status, 'log'), false);
    assert.doesNotMatch(JSON.stringify(status), /PRIVATE_/);
    detectionThrows = true;
    const failedDetection = await fetch(server.base + '/api/thermal/status', { headers });
    assert.equal(failedDetection.status, 503);
    assert.doesNotMatch(JSON.stringify(await failedDetection.json()), /PRIVATE_/);
    const lookup = await post('/api/thermal/result', {
      source: payload.source,
      fileId: payload.fileId,
    });
    assert.equal(lookup.status, 422);
    assert.match((await lookup.json()).error, /integrity/);
    const invalid = await post('/api/thermal/run', {
      ...payload,
      config: { ...payload.config, ambientC: null },
    });
    assert.equal(invalid.status, 400);
    assert.match((await invalid.json()).error, /Invalid thermal settings/);
    const project = parseProject(payload.source);
    project.pcb!.graphics = [];
    const openBoard = await post('/api/thermal/run', {
      ...payload,
      source: serializeProject(project),
    });
    assert.equal(openBoard.status, 400);
    assert.match((await openBoard.json()).error, /closed board outline/);
    assert.equal(calls, 4, 'Input validation remains before solver execution.');
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('thermal saved-result lookups cancel on plugin removal and client disconnect', async () => {
  await mkdir('test-results', { recursive: true });
  const directory = await mkdtemp(path.resolve('test-results/thermal-lookup-cancel-'));
  const payload = fixture();
  const model = prepareThermalModel(parseProject(payload.source).pcb!, payload.config);
  const solver = { gmsh: 'fixture-gmsh', elmer: 'fixture-elmer', identity: 'a'.repeat(64) };
  let lookupSignal: AbortSignal | undefined;
  let started!: () => void;
  let startedPromise = new Promise<void>((resolve) => (started = resolve));
  let runs = 0;
  const server = await startServer({
    dataDir: directory,
    thermalResultFiles: {
      forProject: () => ({
        read: async (signal: AbortSignal) => {
          lookupSignal = signal;
          started();
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener('abort', () => resolve(), { once: true });
          });
          signal.throwIfAborted();
          return { model, result: completedResult(model), solver };
        },
        write: async () => assert.fail('A result lookup must never write.'),
      }),
    },
    thermalDetector: async () => assert.fail('Cancelled lookup must not detect resources.'),
    thermalRunner: async () => {
      runs++;
      assert.fail('A result lookup must not run a solver.');
    },
  });
  const headers = { 'X-OpenPE-Token': server.token, 'Content-Type': 'application/json' };
  const lookup = (signal?: AbortSignal) =>
    fetch(server.base + '/api/thermal/result', {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        source: payload.source,
        fileId: '00000000-0000-4000-8000-000000000001',
      }),
    });
  const change = (action: string) =>
    fetch(server.base + '/api/workbench-plugins', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: thermalPluginId, action }),
    });
  try {
    const pending = lookup();
    await startedPromise;
    await change('uninstall');
    assert.equal((await pending).status, 409);
    assert.equal(lookupSignal?.aborted, true);
    await change('install');
    startedPromise = new Promise<void>((resolve) => (started = resolve));
    const control = new AbortController();
    const disconnected = lookup(control.signal);
    await startedPromise;
    const aborted = new Promise<void>((resolve) =>
      lookupSignal!.addEventListener('abort', () => resolve(), { once: true }),
    );
    control.abort();
    await assert.rejects(disconnected, /abort/i);
    await aborted;
    assert.equal(lookupSignal?.aborted, true);
    assert.equal(runs, 0);
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
