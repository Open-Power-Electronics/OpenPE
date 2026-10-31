// Isolated renderer with fixtures: no Electron, provider CLI or real plugin mutations.
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { bundledWorkbenchCatalog } from '../server/workbench-plugins.mjs';

await mkdir('test-results', { recursive: true });
const bundle = await build({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import PluginsPage from './components/PluginsPage';
      const root = createRoot(document.getElementById('root'));
      window.mountPlugins = () => root.render(<PluginsPage onBack={() => root.render(null)}/>);
      window.mountPlugins();`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
const plugin = (name, origin = 'agent', extra = {}) => ({
  id: 'shared@fixture',
  name,
  origin,
  scope: 'user',
  marketplace: 'fixture',
  description: 'Tools for local engineering workflows.',
  version: '1.0',
  installed: true,
  enabled: true,
  managed: false,
  ...extra,
});
const entries = {
  codex: [plugin('Design tools'), plugin('Circuit notes', 'openpe', { id: 'notes@fixture' })],
  claude: [plugin('Design tools'), plugin('Circuit notes', 'openpe', { id: 'notes@fixture' })],
};
const reads = { codex: 0, claude: 0 };
const mutations = [];
const workbench = bundledWorkbenchCatalog();
const nativeCount = workbench.plugins.length;
const nativeMutations = [];
let failClaude = false;
let codexControlsVersion = 1;
let unsupportedClaude = false;
let releaseClaude;
let holdClaude = new Promise((resolve) => {
  releaseClaude = resolve;
});
try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 760 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.addInitScript(() => {
    window.openpe = { connection: async () => ({ base: 'http://localhost', token: 'fixture' }) };
  });
  await page.route('http://localhost/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/workbench-plugins') {
      if (request.method() === 'POST') {
        const operation = request.postDataJSON();
        nativeMutations.push(operation);
        const entry = workbench.plugins.find((plugin) => plugin.id === operation.id);
        assert.ok(entry);
        assert.equal(operation.provider, undefined);
        entry.installed = operation.action !== 'uninstall';
        entry.enabled = ['enable', 'install'].includes(operation.action);
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ json: { ...workbench, updatedAt: Date.now() } });
    }
    if (url.pathname === '/api/plugins') {
      if (request.method() === 'POST') {
        const operation = request.postDataJSON();
        mutations.push(operation);
        const entry = entries[operation.provider].find((item) => item.id === operation.id);
        assert.ok(entry);
        if (operation.action === 'uninstall') entry.installed = false;
        else entry.enabled = operation.action === 'enable';
        return route.fulfill({ json: { ok: true } });
      }
      const provider = url.searchParams.get('provider');
      reads[provider]++;
      if (provider === 'claude') {
        if (holdClaude) await holdClaude;
        if (failClaude)
          return route.fulfill({ status: 500, json: { error: 'CLI unavailable. Retry refresh.' } });
      }
      return route.fulfill({
        json: {
          controlsVersion: provider === 'codex' ? codexControlsVersion : 1,
          plugins: provider === 'claude' && unsupportedClaude ? [] : entries[provider],
          browse: !(provider === 'claude' && unsupportedClaude),
          actions: ['uninstall', 'enable', 'disable'],
          warning:
            provider === 'claude' && unsupportedClaude ? 'Update your CLI to list plugins.' : '',
          updatedAt: Date.now(),
        },
      });
    }
    if (/^\/(brand|agents)\/[\w.-]+\.(svg|png)$/.test(url.pathname)) {
      return route.fulfill({
        contentType: url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        body: await readFile('public' + url.pathname),
      });
    }
    return route.fulfill({
      contentType: 'text/html',
      body: '<div id="root" style="display:flex;height:100vh;padding:12px"></div>',
    });
  });
  await page.goto('http://localhost');
  await page.addStyleTag({ content: await readFile('app/globals.css', 'utf8') });
  await page.addStyleTag({ content: await readFile('app/workspace.css', 'utf8') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const nav = page.getByRole('complementary', { name: 'Plugin navigation' });
  const category = (name) => page.getByRole('region', { name: `${name} plugins`, exact: true });
  const choose = (name) => nav.getByRole('button', { name: new RegExp(`^${name} `) }).click();
  const count = (name) =>
    nav
      .getByRole('button', { name: new RegExp(`^${name} `) })
      .locator('.plugins-count')
      .innerText();
  await category('Codex').getByRole('button', { name: 'View Design tools' }).waitFor();
  assert.equal(await count('Claude Code'), '0');
  await category('OpenPE').getByRole('button', { name: 'View SPICE Simulation' }).waitFor();
  assert.equal(await count('All plugins'), String(nativeCount + 2));
  // Native plugin management remains usable while a provider list is pending.
  await choose('Marketplace');
  const pcbCard = category('OpenPE')
    .locator('.plugin-card')
    .filter({ has: page.getByRole('button', { name: 'View PE Layout Skill' }) });
  assert.equal(await pcbCard.locator('svg.plugin-logo').count(), 1);
  await pcbCard.getByRole('button', { name: 'View PE Layout Skill' }).click();
  await page.getByText('Bundled workflow and references', { exact: true }).waitFor();
  assert.match(await page.locator('.plugin-detail').innerText(), /CC BY 4.0/);
  await page.screenshot({ path: 'test-results/plugins-pcb-design.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'Disable', exact: true }).click();
  await page.getByRole('button', { name: 'Enable', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.getByRole('button', { name: 'Enable', exact: true }).click();
  await page.getByRole('button', { name: 'Disable', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Uninstall plugin?' })
    .getByRole('button', { name: 'Uninstall', exact: true })
    .click();
  await page.getByRole('button', { name: 'Install', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await page.getByRole('button', { name: 'Disable', exact: true }).waitFor();
  assert.deepEqual(
    nativeMutations.map((row) => row.action),
    ['disable', 'enable', 'uninstall', 'install'],
  );
  assert.ok(nativeMutations.every((row) => row.id === 'ai-pcb-layout@openpe'));
  nativeMutations.length = 0;
  await page.getByRole('button', { name: 'Back to plugins', exact: true }).click();
  await category('OpenPE').getByRole('switch', { name: 'SPICE Simulation enabled' }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="SPICE Simulation enabled"]')
        ?.getAttribute('aria-checked') === 'false',
  );
  assert.equal(await page.getByRole('dialog').count(), 0);
  await category('OpenPE').getByRole('button', { name: 'View SPICE Simulation' }).click();
  await page.getByRole('button', { name: 'Enable', exact: true }).click();
  await page.getByText('Enabled', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Uninstall', exact: true }).click();
  const nativeDialog = page.getByRole('dialog', { name: 'Uninstall plugin?' });
  assert.match(await nativeDialog.innerText(), /Project design data and model files are kept/);
  await nativeDialog.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await page.getByRole('button', { name: 'Install', exact: true }).waitFor();
  assert.equal(
    await count('Marketplace'),
    String(nativeCount),
    'Uninstalled native tools stay discoverable.',
  );
  assert.equal(await count('All plugins'), String(nativeCount + 1));
  await page.getByRole('button', { name: 'Back to plugins', exact: true }).click();
  await category('OpenPE').getByRole('button', { name: 'Install', exact: true }).click();
  await category('OpenPE').getByRole('switch', { name: 'SPICE Simulation enabled' }).waitFor();
  assert.deepEqual(
    nativeMutations.map((row) => row.action),
    ['disable', 'enable', 'uninstall', 'install'],
  );
  assert.deepEqual(mutations, [], 'Native tools never run provider commands.');
  await choose('All plugins');
  releaseClaude();
  holdClaude = null;
  await category('Claude Code').getByRole('button', { name: 'View Design tools' }).waitFor();
  assert.equal(await count('All plugins'), String(nativeCount + 4));
  assert.equal(await count('OpenPE'), String(nativeCount + 2));
  assert.equal(await count('Codex'), '1');
  assert.equal(await count('Claude Code'), '1');
  await page.waitForFunction(() =>
    [...document.images].every((image) => image.complete && image.naturalWidth),
  );
  await page.screenshot({ path: 'test-results/plugins-light.png', animations: 'disabled' });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.screenshot({ path: 'test-results/plugins-dark.png', animations: 'disabled' });
  for (const width of [1120, 800]) {
    await page.setViewportSize({ width, height: 760 });
    const fits = await nav.evaluate((element) =>
      [...element.querySelectorAll('.plugins-nav-item')].every((row) => {
        const label = row.querySelector('.plugins-nav-label').getBoundingClientRect();
        const badge = row.querySelector('.plugins-count').getBoundingClientRect();
        return label.right <= badge.left && row.scrollWidth <= row.clientWidth;
      }),
    );
    assert.ok(fits, `Navigation overlaps at ${width}px`);
  }
  await page.setViewportSize({ width: 1120, height: 760 });
  await choose('Claude Code');
  assert.equal(await category('Codex').count(), 0);
  const toggle = category('Claude Code').getByRole('switch', { name: 'Design tools enabled' });
  await toggle.click();
  await page.waitForFunction(
    () => document.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'false',
  );
  assert.deepEqual(mutations[0], { provider: 'claude', id: 'shared@fixture', action: 'disable' });
  assert.equal(entries.codex[0].enabled, true);
  assert.equal(await page.getByRole('dialog').count(), 0);
  await choose('OpenPE');
  const claudeNotes = category('OpenPE').locator('.plugin-card').filter({ hasText: 'Claude Code' });
  await claudeNotes.getByRole('button', { name: 'View Circuit notes' }).click();
  await page.getByRole('button', { name: 'Uninstall', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Uninstall plugin?' });
  assert.match(await dialog.innerText(), /shared Claude Code setup/);
  await dialog.getByRole('button', { name: 'Uninstall', exact: true }).click();
  await category('OpenPE').getByRole('button', { name: 'View Circuit notes' }).waitFor();
  assert.deepEqual(mutations[1], { provider: 'claude', id: 'notes@fixture', action: 'uninstall' });
  assert.equal(entries.codex[1].installed, true);
  assert.equal(await count('OpenPE'), String(nativeCount + 1));
  await choose('All plugins');
  const search = page.getByRole('textbox', { name: 'Search plugins' });
  await search.fill('Circuit notes');
  assert.equal(await page.locator('.plugin-card').count(), 1);
  assert.equal(await count('All plugins'), String(nativeCount + 3));
  await search.fill('');
  const before = { ...reads };
  await page.getByRole('button', { name: 'Return to workspace' }).click();
  await page.getByRole('region', { name: 'Plugins', exact: true }).waitFor({ state: 'detached' });
  await page.evaluate(() => window.mountPlugins());
  await category('Claude Code').getByRole('button', { name: 'View Design tools' }).waitFor();
  assert.deepEqual(reads, before);
  failClaude = true;
  await page.getByRole('button', { name: 'Refresh plugins' }).click();
  await page.getByRole('alert').filter({ hasText: 'Claude Code: CLI unavailable' }).waitFor();
  assert.equal(await page.locator('.plugin-card').count(), nativeCount + 3);
  // A failed provider cannot erase the other's catalog or redirect its operations.
  await category('Codex').getByRole('switch', { name: 'Design tools enabled' }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="Codex plugins"] [role="switch"]')
        ?.getAttribute('aria-checked') === 'false',
  );
  assert.equal(mutations[2].provider, 'codex');
  failClaude = false;
  entries.claude[0].origin = 'unknown';
  for (const version of [undefined, 99]) {
    codexControlsVersion = version;
    await page.getByRole('button', { name: 'Refresh plugins' }).click();
    await page.getByRole('alert').filter({ hasText: 'Codex plugin controls need' }).waitFor();
    await category('Unknown origin').getByRole('button', { name: 'View Design tools' }).waitFor();
    assert.equal(await category('Codex').getByRole('switch').isDisabled(), true);
    assert.equal(await category('Unknown origin').getByRole('switch').isEnabled(), true);
  }
  // An unsupported empty provider must not hide the available list's counts.
  codexControlsVersion = 1;
  unsupportedClaude = true;
  entries.codex = Array.from({ length: 16 }, (_, index) =>
    plugin(`Codex tool ${index + 1}`, 'agent', { id: `tool-${index}@fixture` }),
  );
  await page.getByRole('button', { name: 'Refresh plugins' }).click();
  await category('Codex')
    .getByRole('button', { name: 'View Codex tool 16', exact: true })
    .waitFor();
  await category('Unknown origin').waitFor({ state: 'detached' });
  assert.equal(await count('All plugins'), String(nativeCount + 16));
  assert.equal(await count('OpenPE'), String(nativeCount));
  assert.equal(await count('Codex'), '16');
  assert.equal(await count('Claude Code'), '0');
  assert.equal(await category('OpenPE').locator('.plugins-count').innerText(), String(nativeCount));
  assert.equal(await category('Claude Code').locator('.plugins-count').innerText(), '0');
  assert.match(
    await page.getByRole('button', { name: 'Refresh plugins' }).getAttribute('aria-description'),
    /Claude Code: Update your CLI/,
  );
  assert.deepEqual(errors, []);
  console.log(
    'Plugin renderer checks passed: categories, counts, provider isolation, mutations, cache, errors and layout.',
  );
} finally {
  releaseClaude();
  await browser.close();
}
