import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntimePlugins, validatePluginPackage } from '../plugins/runtime/host.mjs';
import { createPluginCatalog } from '../plugins/runtime/manifest.mjs';
import { bundledPlugins } from '../plugins/catalog.mjs';
import { createPluginScope } from '../plugins/runtime/capabilities';
import { createWorkbenchPlugins } from '../server/workbench-plugins.mjs';
import { createCapabilityHost } from '../api/capabilities';
import type { PluginManifest } from '../api/plugins';

const example = JSON.parse(await readFile('docs/examples/project-summary.openpe-plugin', 'utf8'));
const id = example.manifest.id;
const command = example.manifest.contributes.commands[0].id;
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'openpe-runtime-plugin-'));
  const plugins = createRuntimePlugins(root);
  t.after(async () => {
    plugins.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, plugins };
}

test('a fifth built-in plugin uses the same catalog contract without changing platform IDs', () => {
  const fifth = {
    ...bundledPlugins[0],
    id: 'utility@example',
    projectDirectory: 'utility',
    contributes: { capabilities: ['utility.calculate'] },
  };
  assert.equal(createPluginCatalog([...bundledPlugins, fifth]).length, 5);
  assert.throws(
    () => createPluginCatalog([...bundledPlugins, { ...fifth, projectDirectory: 'models' }]),
    /directory/,
  );
  assert.throws(() => createPluginCatalog([...bundledPlugins, fifth, fifth]), /Duplicate/);
  assert.throws(
    () =>
      createPluginCatalog([
        ...bundledPlugins,
        { ...fifth, contributes: bundledPlugins[0].contributes },
      ]),
    /Duplicate/,
  );
});

test('a damaged local package cannot block built-in host permission gates', async () => {
  const plugins = createWorkbenchPlugins(null, {
    runtime: {
      list: async () => {
        throw new Error('Damaged local package');
      },
    },
  });
  await plugins.require('spice-simulation@openpe');
  await plugins.require('pcb-thermal@openpe');
  await assert.rejects(plugins.list(), /Damaged/);
});

test('local packages reject ambient authority, namespace collisions and unsafe schemas before installation', () => {
  for (const mutate of [
    (pkg: any) => {
      pkg.manifest.apiVersion = 2;
    },
    (pkg: any) => {
      pkg.manifest.entry = '../main.js';
    },
    (pkg: any) => {
      pkg.manifest.permissions = ['shell'];
    },
    (pkg: any) => {
      pkg.manifest.runtime = 'builtin';
    },
    (pkg: any) => {
      pkg.manifest.contributes.commands[0].id = 'project.replace';
    },
    (pkg: any) => {
      pkg.manifest.contributes.commands[0].inputSchema = { type: 'string', pattern: '(a+)+$' };
    },
    (pkg: any) => {
      pkg.manifest.contributes.commands[0].inputSchema = { $ref: 'https://example.com/schema' };
    },
    (pkg: any) => {
      pkg.source = 'x'.repeat(1024 * 1024 + 1);
    },
  ]) {
    const pkg = structuredClone(example);
    mutate(pkg);
    assert.throws(() => validatePluginPackage(pkg));
  }
  assert.equal(validatePluginPackage(example).manifest.id, id);
});

test('installed JavaScript runs after restart, shares bounded project input, and has no host globals', async (t) => {
  const { root, plugins } = await fixture(t);
  await plugins.install(example);
  const state = (await plugins.list())[0];
  const project = { project: { name: 'Test' }, schematic: { components: [{ reference: 'R1' }] } };
  const reopened = createRuntimePlugins(root);
  t.after(() => reopened.close());
  assert.deepEqual(
    await reopened.run(id, command, { includeReferences: true }, { project }, state.sha256),
    {
      name: 'Test',
      components: 1,
      references: ['R1'],
    },
  );
  await assert.rejects(
    plugins.run(id, command, { extra: true }, null, state.sha256),
    /Invalid plugin command input/,
  );
  await assert.rejects(plugins.run(id, command, {}, null, 'changed'), /changed/);
  await assert.rejects(plugins.install(example), /Uninstall/);
  await plugins.change('uninstall', id);
  const pkg = structuredClone(example);
  pkg.manifest.permissions = [];
  pkg.source =
    'registerPlugin({summarize() { return [typeof process, typeof require, typeof fetch, typeof window]; }});';
  await plugins.install(pkg);
  const installed = (await plugins.list())[0];
  assert.deepEqual(await plugins.run(id, command, {}, null, installed.sha256), [
    'undefined',
    'undefined',
    'undefined',
    'undefined',
  ]);
  await assert.rejects(plugins.run(id, command, {}, { project }, installed.sha256), /permission/);
  await plugins.change('disable', id);
  await assert.rejects(plugins.run(id, command, {}, null, installed.sha256), /Enable/);
  assert.equal((await createRuntimePlugins(root).list())[0].enabled, false);
  await plugins.change('uninstall', id);
  assert.deepEqual(await plugins.list(), []);
});

test('sandbox preserves JSON context fields and requires explicitly registered handlers', async (t) => {
  const { plugins } = await fixture(t);
  const pkg = structuredClone(example);
  pkg.manifest.contributes.commands[0].inputSchema = { type: 'object' };
  pkg.source =
    'registerPlugin({summarize(input, context) { return {input:Object.keys(input), context:Object.keys(context.project)}; }});';
  await plugins.install(pkg);
  const state = (await plugins.list())[0];
  assert.deepEqual(
    await plugins.run(
      id,
      command,
      { 'literal-key': 1 },
      { project: JSON.parse('{"__proto__":{"x":1}}') },
      state.sha256,
    ),
    { input: ['literal-key'], context: ['__proto__'] },
  );
  await plugins.change('uninstall', id);
  pkg.manifest.contributes.commands[0].handler = 'constructor';
  pkg.source = 'registerPlugin({});';
  await plugins.install(pkg);
  const invalid = (await plugins.list())[0];
  await assert.rejects(plugins.run(id, command, {}, null, invalid.sha256), /execution failed/);
});

test('disable cancels an in-flight untrusted handler and bounded execution stops infinite loops', async (t) => {
  const { plugins } = await fixture(t);
  const pkg = structuredClone(example);
  pkg.source = 'registerPlugin({summarize() { while (true) {} }});';
  await plugins.install(pkg);
  const state = (await plugins.list())[0];
  const pending = plugins.run(id, command, {}, null, state.sha256);
  const rejected = assert.rejects(pending, /cancelled|limits|time limit/);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await plugins.change('disable', id);
  await rejected;
  await plugins.change('enable', id);
  await assert.rejects(plugins.run(id, command, {}, null, state.sha256), /limits|time limit/);
});

test('tampered packages and linked plugin directories fail closed while preserving original bytes', async (t) => {
  const { root, plugins } = await fixture(t);
  await plugins.install(example);
  const file = path.join(root, 'plugins', id, 'package.json');
  const record = JSON.parse(await readFile(file, 'utf8'));
  record.package.source += '\n// tampered';
  const bytes = JSON.stringify(record);
  await writeFile(file, bytes);
  await assert.rejects(plugins.list(), /preserved/);
  assert.equal(await readFile(file, 'utf8'), bytes);
  if (process.platform === 'win32') return;
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  await symlink(outside, path.join(root, 'plugins', 'linked@example'));
  await assert.rejects(plugins.list(), /links|preserved/);
});

test('a plugin scope rejects undeclared capabilities and cancels only its own requests on disable', async () => {
  const host = createCapabilityHost();
  const manifest: PluginManifest = {
    ...bundledPlugins[0],
    contributes: { capabilities: ['utility.calculate'] },
  };
  let enabled = true;
  let listener = () => {};
  const scope = createPluginScope(host, manifest, {
    available: () => enabled || 'Plugin disabled.',
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = () => {};
      };
    },
  });
  let finish!: (value: number) => void;
  const definition = {
    owner: 'plugin' as const,
    plugin: manifest.id,
    id: 'utility.calculate',
    kind: 'query' as const,
    description: 'Compute',
    inputSchema: { type: 'object' },
    handler: () =>
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
  };
  scope.register(definition);
  assert.throws(() => scope.register({ ...definition, id: 'other.calculate' }), /declared/);
  host.register({
    owner: 'host',
    id: 'unrelated.query',
    kind: 'query',
    description: 'Unrelated',
    inputSchema: { type: 'object' },
    handler: () => 7,
  });
  const pending = host.query('utility.calculate');
  const rejected = assert.rejects(pending, /cancel|unregister/i);
  await Promise.resolve();
  enabled = false;
  listener();
  finish(42);
  await rejected;
  assert.equal(await host.query('unrelated.query'), 7);
  await assert.rejects(host.query('utility.calculate'), /disabled/);
  scope.dispose();
  scope.dispose();
  host.dispose();
});
