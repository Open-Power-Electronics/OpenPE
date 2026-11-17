import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { bundledWorkbenchCatalog, createWorkbenchPlugins } from '../server/workbench-plugins.mjs';
import { SPICE_PLUGIN_ID as spicePluginId } from '../plugins/catalog.mjs';
import { createProjectSpiceStore } from '../server/project-spice-files.mjs';
import { startServer } from '../server/index.mjs';
import { switchingStageFixture } from './fixtures/switching-stage';
import { createProject, serializeProject } from '../lib/project';
import { defaultTransient } from '../plugins/spice-simulation/domain/spice';

test('bundled SPICE lifecycle persists independently of projects and reinstalls without provider commands', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openpe-workbench-plugins-'));
  try {
    const plugins = createWorkbenchPlugins(dir);
    assert.equal((await plugins.list()).plugins[0].name, 'SPICE Simulation');
    await plugins.require('spice-simulation@openpe');
    assert.deepEqual(await readdir(dir), [], 'Default initialization does not write settings.');
    const events: boolean[] = [];
    plugins.subscribe((_id: string, state: { enabled: boolean }) => events.push(state.enabled));
    await plugins.change('disable', spicePluginId);
    await assert.rejects(plugins.require('spice-simulation@openpe'), /Plugins > Marketplace/);
    const reopened = createWorkbenchPlugins(dir);
    assert.equal((await reopened.list()).plugins[0].enabled, false);
    await plugins.change('enable', spicePluginId);
    await plugins.require('spice-simulation@openpe');
    await plugins.change('uninstall', spicePluginId);
    assert.equal((await plugins.list()).plugins[0].installed, false);
    assert.equal((await createWorkbenchPlugins(dir).list()).plugins[0].installed, false);
    await assert.rejects(plugins.change('enable', spicePluginId), /Install/);
    await plugins.change('install', spicePluginId);
    await plugins.require('spice-simulation@openpe');
    assert.deepEqual(events, [false, true, false, true]);
    assert.deepEqual(await readdir(dir), ['workbench-plugins-v1.json']);
    const cancelled = new AbortController();
    cancelled.abort();
    const before = await readFile(path.join(dir, 'workbench-plugins-v1.json'), 'utf8');
    await assert.rejects(plugins.change('uninstall', spicePluginId, cancelled.signal), /cancelled/);
    assert.equal(await readFile(path.join(dir, 'workbench-plugins-v1.json'), 'utf8'), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('invalid plugin settings and failed writes preserve bytes and never enable a disabled solver', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openpe-workbench-plugin-errors-'));
  const file = path.join(dir, 'workbench-plugins-v1.json');
  try {
    const rows = bundledWorkbenchCatalog().plugins.map(({ id }: { id: string }) => ({
      id,
      installed: true,
      enabled: true,
    }));
    for (const invalid of [
      '{broken',
      JSON.stringify({ version: 0, plugins: rows }),
      JSON.stringify({ version: 1, plugins: rows.slice(0, -1) }),
      JSON.stringify({ version: 1, plugins: [rows[0], rows[0], rows[2]] }),
      JSON.stringify({ version: 1, plugins: [{ ...rows[0], id: 'unknown' }, ...rows.slice(1)] }),
      JSON.stringify({ version: 1, plugins: [{ id: rows[0].id }, ...rows.slice(1)] }),
      JSON.stringify({
        version: 1,
        plugins: [{ id: spicePluginId, installed: false, enabled: true }],
      }),
      'x'.repeat(16385),
    ]) {
      await writeFile(file, invalid);
      const plugins = createWorkbenchPlugins(dir);
      await assert.rejects(plugins.list(), /preserved/);
      await assert.rejects(plugins.require('spice-simulation@openpe'), /preserved/);
      await assert.rejects(plugins.change('install', spicePluginId), /preserved/);
      assert.equal(await readFile(file, 'utf8'), invalid);
    }
    const disabled = JSON.stringify({
      version: 1,
      plugins: bundledWorkbenchCatalog().plugins.map(({ id }: { id: string }) => ({
        id,
        installed: true,
        enabled: id !== spicePluginId,
      })),
    });
    await writeFile(file, disabled);
    const plugins = createWorkbenchPlugins(dir, {
      write: async () => {
        throw new Error('disk full');
      },
    });
    await assert.rejects(plugins.change('enable', spicePluginId), /disk full/);
    await assert.rejects(plugins.require('spice-simulation@openpe'), /Marketplace/);
    assert.equal(await readFile(file, 'utf8'), disabled);
    assert.deepEqual(await readdir(dir), ['workbench-plugins-v1.json']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('plugin observers cannot mutate confirmed gates or interrupt other lifecycle notifications', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openpe-workbench-plugin-observers-'));
  try {
    const plugins = createWorkbenchPlugins(dir);
    plugins.subscribe((_id: string, state: { installed: boolean; enabled: boolean }) => {
      state.installed = true;
      state.enabled = true;
      throw new Error('Observer failed after the lifecycle write');
    });
    const notified: { installed: boolean; enabled: boolean }[] = [];
    plugins.subscribe((_id: string, state: { installed: boolean; enabled: boolean }) => {
      notified.push({ installed: state.installed, enabled: state.enabled });
    });
    await plugins.change('disable', spicePluginId);
    await assert.rejects(plugins.require('spice-simulation@openpe'), /Plugins > Marketplace/);
    assert.equal((await plugins.list()).plugins[0].enabled, false);
    await plugins.change('uninstall', spicePluginId);
    await assert.rejects(plugins.require('spice-simulation@openpe'), /Plugins > Marketplace/);
    assert.deepEqual(notified, [
      { installed: true, enabled: false },
      { installed: false, enabled: false },
    ]);
    assert.equal((await createWorkbenchPlugins(dir).list()).plugins[0].installed, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('workbench plugin API rejects injection, gates solver calls and cancels active runs and detection', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openpe-workbench-plugin-api-'));
  let calls = 0;
  let detections = 0;
  let holdDetection = false;
  let runStarted!: () => void;
  let detectionStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    runStarted = resolve;
  });
  const detecting = new Promise<void>((resolve) => {
    detectionStarted = resolve;
  });
  const signals: AbortSignal[] = [];
  const server = await startServer({
    dataDir: dir,
    simulationRunner: async (_deck: unknown, signal: AbortSignal) => {
      calls++;
      signals.push(signal);
      runStarted();
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
      );
    },
    simulationDetector: async (signal: AbortSignal) => {
      detections++;
      if (!holdDetection)
        return { available: true, version: 'fixture', executable: '/fixture/ngspice' };
      signals.push(signal);
      detectionStarted();
      return new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
      );
    },
  });
  const headers = { 'X-OpenPE-Token': server.token, 'Content-Type': 'application/json' };
  const url = server.base + '/api/workbench-plugins';
  const change = (action: string, extra = {}) =>
    fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: spicePluginId, action, ...extra }),
    });
  const circuit = switchingStageFixture();
  const run = () =>
    fetch(server.base + '/api/simulation/transient', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        source: serializeProject(createProject(circuit)),
        config: defaultTransient(circuit),
      }),
    });
  const status = () => fetch(server.base + '/api/simulation/status', { headers });
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal(
      (await fetch(url, { headers: { ...headers, Origin: 'https://evil.example' } })).status,
      403,
    );
    assert.equal((await fetch(url + '?path=anything', { headers })).status, 400);
    for (const payload of [
      { path: 'cmd.exe' },
      { provider: 'codex' },
      { id: 'spice@evil' },
      { id: '../spice' },
      { command: 'run' },
    ])
      assert.equal((await change('install', payload)).status, 400);
    assert.equal((await change('execute')).status, 400);
    assert.equal((await status()).status, 200);
    assert.equal((await change('disable')).status, 200);
    assert.equal((await status()).status, 403);
    assert.equal((await run()).status, 403);
    assert.equal(calls, 0);
    assert.equal(detections, 1);
    await change('enable');
    const pendingRun = run();
    await started;
    holdDetection = true;
    const pendingDetection = status();
    await detecting;
    assert.equal((await change('uninstall')).status, 200);
    await Promise.all([pendingRun, pendingDetection]);
    assert.ok(signals.every((signal) => signal.aborted));
    assert.equal((await run()).status, 403);
    assert.equal(calls, 1);
    await change('install');
    holdDetection = false;
    assert.equal((await status()).status, 200);
    assert.equal((await (await fetch(url, { headers })).json()).plugins[0].enabled, true);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('disabling SPICE finishes a cancelled load-only lookup even when its loader returns a miss', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'openpe-plugin-result-cancellation-'));
  let lookupStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    lookupStarted = resolve;
  });
  const resultStore = createProjectSpiceStore(() => path.join(dir, 'fixture.kicad_pro'));
  const server = await startServer({
    dataDir: dir,
    simulationResultFiles: { forProject: () => resultStore },
    simulationResultLoader: async (_deck: unknown, signal: AbortSignal) => {
      lookupStarted();
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      return null;
    },
  });
  const headers = { 'X-OpenPE-Token': server.token, 'Content-Type': 'application/json' };
  try {
    const circuit = switchingStageFixture();
    const pending = fetch(server.base + '/api/simulation/result', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        source: serializeProject(createProject(circuit)),
        config: defaultTransient(circuit),
        fileId: randomUUID(),
      }),
      signal: AbortSignal.timeout(3000),
    });
    await started;
    const disabled = await fetch(server.base + '/api/workbench-plugins', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: spicePluginId, action: 'disable' }),
    });
    assert.equal(disabled.status, 200);
    const response = await pending;
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /lookup cancelled/);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
