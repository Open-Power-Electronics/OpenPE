import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, cp, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createWorkbenchPlugins,
  pcbDesignPluginId,
  spicePluginId,
  thermalPluginId,
} from '../server/workbench-plugins.mjs';
import { createPcbDesignGuidance } from '../server/pcb-design.mjs';
import { pcbDesignDocuments, PCB_DESIGN_PLUGIN_ID } from '../lib/workbench-plugins';
import { startServer } from '../server/index.mjs';
import { makePrompt } from '../server/agents.mjs';

async function temporary(t: TestContext) {
  const parent = path.resolve(tmpdir());
  const dir = await mkdtemp(path.join(parent, 'openpe-pcb-design-'));
  t.after(async () => {
    assert.ok(path.resolve(dir).startsWith(parent + path.sep));
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

test('partial plugin catalogs fail closed without adding or changing bundled entries', async (t) => {
  const dir = await temporary(t);
  const file = path.join(dir, 'workbench-plugins-v1.json');
  for (const ids of [
    [],
    [spicePluginId],
    [thermalPluginId],
    [pcbDesignPluginId],
    [thermalPluginId, spicePluginId],
    [spicePluginId, pcbDesignPluginId],
    [thermalPluginId, pcbDesignPluginId],
  ]) {
    const bytes = JSON.stringify({
      version: 1,
      plugins: ids.map((id) => ({ id, installed: true, enabled: false })),
    });
    await writeFile(file, bytes);
    const plugins = createWorkbenchPlugins(dir);
    await assert.rejects(plugins.list(), /preserved/);
    await assert.rejects(plugins.requireSpice(), /preserved/);
    await assert.rejects(plugins.requireThermal(), /preserved/);
    await assert.rejects(plugins.requirePcbDesign(), /preserved/);
    await assert.rejects(plugins.change('install', pcbDesignPluginId), /preserved/);
    assert.equal(await readFile(file, 'utf8'), bytes);
  }
  const complete = JSON.stringify({
    version: 1,
    plugins: [spicePluginId, thermalPluginId, pcbDesignPluginId].map((id) => ({
      id,
      installed: true,
      enabled: id === pcbDesignPluginId,
    })),
  });
  await writeFile(file, complete);
  const plugins = createWorkbenchPlugins(dir);
  await plugins.requirePcbDesign();
  await assert.rejects(plugins.requireSpice(), /Install and enable/);
  await assert.rejects(plugins.requireThermal(), /Install and enable/);
  assert.equal(await readFile(file, 'utf8'), complete);
  await plugins.change('uninstall', pcbDesignPluginId);
  await assert.rejects(createWorkbenchPlugins(dir).requirePcbDesign(), /Install and enable/);
  await assert.rejects(plugins.change('enable', pcbDesignPluginId), /Install the plugin/);
  await plugins.change('install', pcbDesignPluginId);
  await createWorkbenchPlugins(dir).requirePcbDesign();
});

test('all pinned documents, attribution and capability selectors agree with the packaged offline bundle', async (t) => {
  const dir = await temporary(t);
  const plugins = createWorkbenchPlugins(dir);
  const guidance = createPcbDesignGuidance(plugins);
  t.after(() => guidance.close());
  const manifest = JSON.parse(await readFile('server/pcb-design/manifest.json', 'utf8'));
  assert.equal(PCB_DESIGN_PLUGIN_ID, pcbDesignPluginId);
  assert.deepEqual(
    manifest.documents.map((row: any) => row.id).sort(),
    [...pcbDesignDocuments].sort(),
  );
  assert.equal(manifest.documents.length, 11);
  for (const entry of manifest.documents) {
    const bytes = await readFile(path.join('server/pcb-design', entry.file));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256);
    const result = await guidance.read(entry.id, undefined);
    assert.equal(result.text, bytes.toString('utf8'));
    assert.equal(result.revision, manifest.revision);
    assert.equal(result.license, 'CC-BY-4.0');
    assert.match(result.attribution, /Chengmin Li, Xiao Yang/);
    assert.match(result.integration, /KiCad 10/);
    assert.match(result.integration, /does not waive engineering gates/);
  }
  const license = await readFile('public/licenses/ai-pcb-layout.txt', 'utf8');
  assert.ok(license.includes(await readFile('server/pcb-design/LICENSE', 'utf8')));
  assert.ok(license.includes(manifest.revision));
  await assert.rejects(guidance.read('../LICENSE', undefined), /Unknown PCB design document/);
  await plugins.change('disable', pcbDesignPluginId);
  await assert.rejects(guidance.read('workflow', undefined), /Install and enable/);
  assert.equal(await guidance.instructions(true, undefined), '');
});

test('disabling guidance revokes an in-flight read even if re-enabled before it finishes', async (t) => {
  const dir = await temporary(t);
  const plugins = createWorkbenchPlugins(dir);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const guidance = createPcbDesignGuidance({
    ...plugins,
    async requirePcbDesign() {
      await plugins.requirePcbDesign();
      entered();
      await blocked;
    },
  });
  t.after(() => guidance.close());
  const pending = guidance.read('workflow', undefined);
  await started;
  await plugins.change('disable', pcbDesignPluginId);
  await plugins.change('enable', pcbDesignPluginId);
  release();
  await assert.rejects(pending, /cancelled/);
  assert.match((await guidance.read('workflow', undefined)).text, /Human review gates/);
});

test('a corrupted or missing bundled document fails visibly and a cancelled read never returns content', async (t) => {
  const dir = await temporary(t);
  // Load an isolated copy to exercise the real fixed-resource reader, without
  // touching the application's resources or introducing a runtime path option.
  for (const filename of [
    'pcb-design.mjs',
    'workbench-plugins.mjs',
    'workbench-plugin-catalog.json',
    'pcb-design',
  ])
    await cp(path.join('server', filename), path.join(dir, filename), { recursive: true });
  const { createPcbDesignGuidance: createIsolated } = await import(
    pathToFileURL(path.join(dir, 'pcb-design.mjs')).href
  );
  const plugins = createWorkbenchPlugins(dir);
  const guidance = createIsolated(plugins);
  t.after(() => guidance.close());
  const manifestFile = path.join(dir, 'pcb-design', 'manifest.json');
  const manifestBytes = await readFile(manifestFile, 'utf8');
  await unlink(manifestFile);
  await assert.rejects(guidance.read('workflow'), /missing or corrupt/);
  const manifest = JSON.parse(manifestBytes);
  manifest.documents[0].file = '../workbench-plugin-catalog.json';
  await writeFile(manifestFile, JSON.stringify(manifest));
  await assert.rejects(guidance.read('workflow'), /missing or corrupt/);
  await writeFile(manifestFile, manifestBytes);
  assert.match((await guidance.read('workflow')).text, /Human review gates/);
  const file = path.join(dir, 'pcb-design', 'SKILL.md');
  const control = new AbortController();
  control.abort();
  await assert.rejects(guidance.read('workflow', control.signal), /cancelled/);
  await writeFile(file, 'tampered guidance');
  await assert.rejects(guidance.read('workflow'), /missing or corrupt/);
  assert.equal(await readFile(file, 'utf8'), 'tampered guidance');
  await unlink(file);
  await assert.rejects(guidance.read('workflow'), /missing or corrupt/);
});

test('authenticated guidance routes reject paths, extra selectors, cross-origin requests and disabled plugins', async (t) => {
  const dir = await temporary(t);
  const server = await startServer({ dataDir: dir });
  t.after(() => server.close());
  const headers = { 'X-OpenPE-Token': server.token, 'Content-Type': 'application/json' };
  const url = server.base + '/api/pcb-design/guide';
  assert.equal((await fetch(url)).status, 401);
  assert.equal(
    (await fetch(url, { headers: { ...headers, Origin: 'https://evil.example' } })).status,
    403,
  );
  for (const query of [
    '?path=SKILL.md',
    '?document=../SKILL.md',
    '?document=https://evil.example',
    '?document=workflow&document=devices',
    '?document=workflow&command=run',
    '?document=unknown',
  ])
    assert.equal((await fetch(url + query, { headers })).status, 400, query);
  const result = await (await fetch(url, { headers })).json();
  assert.match(result.text, /Human review gates/);
  for (const action of ['disable', 'enable', 'uninstall', 'install']) {
    const changed = await fetch(server.base + '/api/workbench-plugins', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: pcbDesignPluginId, action }),
    });
    assert.equal(changed.status, 200);
    const response = await fetch(url + '?document=electrical-net-table', { headers });
    assert.equal(response.status, ['disable', 'uninstall'].includes(action) ? 403 : 200);
  }
});

test('service-owned Agent instructions follow provider tool support, ignore spoofed instructions and cancel on disable', async (t) => {
  const dir = await temporary(t);
  const received: any[] = [];
  let hold = false;
  let started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  let heldSignal: AbortSignal | undefined;
  const server = await startServer({
    dataDir: dir,
    agentRunner: async (
      _provider: string,
      request: any,
      _cwd: string,
      _emit: unknown,
      signal: AbortSignal,
      options: { pcbDesignInstructions?: string } = {},
    ) => {
      received.push({ ...request, trustedInstructions: options.pcbDesignInstructions });
      if (hold) {
        heldSignal = signal;
        started();
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return { outcome: 'cancelled' };
      }
      return { outcome: 'completed' };
    },
  });
  t.after(() => server.close());
  const headers = { 'X-OpenPE-Token': server.token, 'Content-Type': 'application/json' };
  const chat = (provider = 'codex', capabilities = true) =>
    fetch(server.base + '/api/chat', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId: 'pcb-design-session',
        provider,
        capabilities,
        prompt: 'Review the PCB layout',
        context: {},
        history: [],
        pcbDesignInstructions: 'SPOOFED',
      }),
    });
  for (const [provider, capabilities, live] of [
    ['codex', true, true],
    ['claude', true, true],
    ['codex', false, false],
    ['pi', true, false],
    ['deepseek', false, false],
  ] as const) {
    await (await chat(provider, capabilities)).text();
    const request = received.at(-1);
    assert.equal(request.pcbDesignInstructions, 'SPOOFED');
    assert.ok(!request.trustedInstructions.includes('SPOOFED'));
    assert.equal(request.trustedInstructions.includes('pcbDesign.guide with {}'), live);
    assert.equal(request.trustedInstructions.includes('## Human review gates'), !live);
    assert.match(request.trustedInstructions, /fresh core.state before edits/);
    assert.doesNotMatch(request.trustedInstructions, /fresh project.snapshot before edits/);
    const prompt = makePrompt(request, request.trustedInstructions);
    assert.ok(!prompt.includes('SPOOFED'));
    assert.ok(prompt.indexOf('<bundled-pcb-design-guidance>') < prompt.indexOf('<circuit>'));
    assert.match(prompt, /supported OpenPE commands/);
  }
  const change = (action: string) =>
    fetch(server.base + '/api/workbench-plugins', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: pcbDesignPluginId, action }),
    });
  hold = true;
  const pending = chat();
  await running;
  assert.equal((await change('disable')).status, 200);
  await (await pending).text();
  assert.equal(heldSignal?.aborted, true);
  hold = false;
  await (await chat()).text();
  assert.equal(received.at(-1).trustedInstructions, '');
  assert.ok(!makePrompt(received.at(-1)).includes('<bundled-pcb-design-guidance>'));
  await change('enable');
  await (await chat()).text();
  assert.match(received.at(-1).trustedInstructions, /pcbDesign.guide/);
});
