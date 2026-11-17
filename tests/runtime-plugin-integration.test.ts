import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer } from '../server/index.mjs';
import { createCapabilityHost, emptyCapabilityInput } from '../api/capabilities';
import { registerRuntimePluginCapabilities } from '../plugins/runtime/client';
import { loadWorkbenchPlugins, changeWorkbenchPlugin } from '../lib/workbench-plugins';
import { readPluginPackage } from '../plugins/runtime/host.mjs';

const { registerPluginInstaller } = createRequire(import.meta.url)(
  '../electron/plugin-installer.cjs',
);
const example = JSON.parse(await readFile('docs/examples/project-summary.openpe-plugin', 'utf8'));

test('native installation requires a trusted picker and approval of the exact package', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openpe-plugin-installer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'summary.openpe-plugin');
  await writeFile(file, JSON.stringify(example));
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
  let approve = false;
  let picked = 0;
  let installed: unknown;
  registerPluginInstaller({
    ipcMain: {
      handle: (id: string, handler: (...args: any[]) => Promise<unknown>) =>
        handlers.set(id, handler),
    },
    authorize: (event: string) => {
      if (event !== 'trusted') throw new Error('Unauthorized window.');
    },
    getWindow: () => ({}),
    dialog: {
      showOpenDialog: async () => {
        picked++;
        return { canceled: false, filePaths: [file] };
      },
      showMessageBox: async (_window: unknown, options: { detail: string }) => {
        assert.match(options.detail, /Read the current project/);
        // Replacing the selected file after preview cannot swap code/permissions.
        await writeFile(file, JSON.stringify({ ...example, source: 'changed after preview' }));
        return { response: approve ? 1 : 0 };
      },
    },
    service: {
      previewPluginPackage: readPluginPackage,
      installPluginPackage: async (pkg: unknown) => {
        installed = pkg;
        return { id: example.manifest.id };
      },
    },
  });
  const invoke = handlers.get('openpe:install-plugin')!;
  await assert.rejects(invoke('foreign'), /Unauthorized/);
  assert.equal(picked, 0);
  assert.equal(await invoke('trusted'), null);
  assert.equal(installed, undefined);
  approve = true;
  await writeFile(file, JSON.stringify(example));
  assert.deepEqual(await invoke('trusted'), { id: example.manifest.id });
  assert.deepEqual(installed, example);
});

test('an installed plugin appears in GUI/Agent discovery and uses only its originating project', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openpe-plugin-service-'));
  const server = await startServer({ port: 0, dataDir: root });
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      openpe: { connection: async () => ({ base: server.base, token: server.token }) },
    },
  });
  const host = createCapabilityHost();
  t.after(async () => {
    host.dispose();
    server.close();
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
    await rm(root, { recursive: true, force: true });
  });
  const input = example.manifest.contributes.commands[0];
  const headers = { 'X-OpenPE-Token': server.token, 'Content-Type': 'application/json' };
  assert.equal(
    (await fetch(server.base + '/api/runtime-plugins/run', { method: 'POST', body: '{}' })).status,
    401,
  );
  assert.equal(
    (
      await fetch(server.base + '/api/runtime-plugins/run', {
        method: 'POST',
        headers: { ...headers, Origin: 'https://foreign.example' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(server.base + '/api/runtime-plugins/install', {
        method: 'POST',
        headers,
        body: '{}',
      })
    ).status,
    404,
  );
  host.register({
    owner: 'core',
    id: 'project.get',
    kind: 'query',
    description: 'Read this project',
    inputSchema: emptyCapabilityInput,
    handler: () => ({
      project: { name: 'Origin' },
      schematic: { components: [{ reference: 'R2' }] },
    }),
  });
  const remove = registerRuntimePluginCapabilities(host);
  t.after(remove);
  await server.installPluginPackage(example);
  await loadWorkbenchPlugins(true);
  assert.equal(host.catalog().find(({ id }) => id === input.id)?.plugin, example.manifest.id);
  const expected = { name: 'Origin', components: 1, references: ['R2'] };
  assert.deepEqual(
    await host.query(input.id, { includeReferences: true }, { actor: 'human' }),
    expected,
  );
  assert.deepEqual(
    await host.query(input.id, { includeReferences: true }, { actor: 'agent' }),
    expected,
  );
  await changeWorkbenchPlugin('disable', example.manifest.id);
  assert.equal(host.catalog().find(({ id }) => id === input.id)?.available, false);
  await assert.rejects(host.query(input.id), /enable/);
  await changeWorkbenchPlugin('enable', example.manifest.id);
  assert.deepEqual(await host.query(input.id, { includeReferences: true }), expected);
  await changeWorkbenchPlugin('uninstall', example.manifest.id);
  assert.equal(
    host.catalog().some(({ id }) => id === input.id),
    false,
  );
});
