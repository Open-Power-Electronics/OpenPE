// Actual workspace/settings/picker with mocked local services and recovery.
// No Electron, installed Agent, external service or solver is launched.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { bundledWorkbenchCatalog } from '../server/workbench-plugins.mjs';

const { agentProviders, agentProviderIds } = await tsImport(
  '../lib/agent-providers.ts',
  import.meta.url,
);
const { createProject, serializeProject } = await tsImport('../lib/project.ts', import.meta.url);
const source = serializeProject(createProject());
const documentId = '00000000-0000-4000-8000-000000000001';
const originalModels = Object.fromEntries(agentProviderIds.map((id) => [id, `fixture/${id}`]));
let state = {
  version: 2,
  documents: [
    {
      id: documentId,
      source,
      sourceDraft: null,
      dirty: false,
      filename: 'agent-providers.kicad_pro',
      sessions: [{ id: 'provider-session', messages: [], draft: '' }],
      activeSessionId: 'provider-session',
    },
  ],
  activeDocumentId: documentId,
  provider: 'deepseek',
  effort: 'low',
  approvalMode: 'review',
  models: originalModels,
};
const bundle = await build({
  stdin: {
    contents:
      "import React from 'react'; import {createRoot} from 'react-dom/client'; import Workspace from './components/DesktopWorkspace'; createRoot(document.getElementById('root')).render(<Workspace/>);",
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outdir: 'test-results/agent-providers-ui-bundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const workbench = bundledWorkbenchCatalog();
const modelRequests = [];
let detections = 0;
let chats = 0;
const waitUntil = async (condition, message) => {
  const deadline = Date.now() + 10000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.exposeFunction('persistWorkspaceRecovery', (content) => {
    state = content === null ? null : JSON.parse(content);
  });
  await page.addInitScript(() => {
    window.openpe = {
      titleBarOverlay: false,
      connection: async () => ({ base: 'http://localhost', token: 'fixture' }),
      writeWorkspaceRecovery: (content) => window.persistWorkspaceRecovery(content),
      newFile: async () => crypto.randomUUID(),
      releaseFile: async () => {},
      setDirty: async () => {},
      onCloseRequested: () => () => {},
    };
  });
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/state') {
      assert.equal(route.request().method(), 'GET', 'Recovery writes use the native bridge.');
      return route.fulfill({ json: state });
    }
    if (url.pathname === '/api/appearance') return route.fulfill({ json: null });
    if (url.pathname === '/api/agents') {
      detections++;
      return route.fulfill({
        json: agentProviderIds.map((id) =>
          id === 'codex'
            ? {
                id,
                installed: true,
                available: true,
                version: 'codex-cli 1.2.3',
                path: 'fixture/codex',
                auth: 'unknown',
                supportsEffort: true,
                supportsCapabilities: true,
              }
            : {
                id,
                installed: false,
                available: false,
                error: `${id} CLI was not detected.`,
                auth: 'unknown',
              },
        ),
      });
    }
    if (url.pathname === '/api/models') {
      const provider = url.searchParams.get('provider');
      modelRequests.push(provider);
      return route.fulfill({
        json: {
          models: [
            { id: `fixture/${provider}`, label: `fixture/${provider}` },
            { id: `fixture/${provider}-other`, label: 'Codex alternate' },
          ],
          defaultModel: null,
        },
      });
    }
    if (url.pathname === '/api/workbench-plugins')
      return route.fulfill({ json: { ...workbench, updatedAt: Date.now() } });
    if (url.pathname === '/api/chat') {
      chats++;
      return route.fulfill({ status: 500, json: { error: 'Unexpected provider request.' } });
    }
    if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(url.pathname))
      return route.fulfill({
        contentType: url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        body: await readFile('public' + url.pathname),
      });
    if (url.pathname.startsWith('/api/')) throw new Error(`Unexpected API call: ${url.pathname}`);
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  const mount = async () => {
    await page.goto('http://localhost');
    for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
      await page.addStyleTag({ content: await readFile(file, 'utf8') });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByTestId('schematic-canvas').waitFor();
  };
  const button = (name) => page.getByRole('button', { name, exact: true });
  const picker = page.getByRole('combobox', { name: 'Choose agent', exact: true });
  const modelPicker = page.getByRole('combobox', { name: 'Choose model', exact: true });
  const composer = page.getByRole('textbox', { name: 'Message your agent', exact: true });
  const selectProvider = async (provider) => {
    await picker.click();
    const option = page
      .getByRole('option')
      .filter({ has: page.getByText(provider.name, { exact: true }) });
    assert.equal(await option.getAttribute('aria-disabled'), null);
    if (['deepseek', 'pi', 'cursor'].includes(provider.id)) {
      assert.match(await option.getAttribute('class'), /muted/);
      assert.match(await option.innerText(), /CLI not detected/);
    }
    await option.click();
    await page.waitForFunction(
      (name) =>
        document.querySelector('[aria-label="Choose agent"]')?.getAttribute('aria-description') ===
        name,
      provider.name,
    );
    assert.equal(await picker.getAttribute('title'), 'Choose agent');
    assert.equal(await composer.getAttribute('placeholder'), `Work with ${provider.name}`);
    await waitUntil(() => state.provider === provider.id, 'Selected Agent was not persisted.');
  };
  await mount();
  assert.equal(await picker.getAttribute('aria-description'), 'DeepSeek Harness');
  assert.equal(await composer.getAttribute('placeholder'), 'Work with DeepSeek Harness');
  assert.equal(await modelPicker.innerText(), originalModels.deepseek);

  await button('Settings').click();
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Agents', exact: true }).click();
  assert.equal(await settings.locator('.connection-item').count(), 5);
  for (const provider of agentProviders) {
    const row = settings
      .locator('.connection-item')
      .filter({ has: page.getByText(provider.settingsName, { exact: true }) });
    assert.equal(await row.locator('.agent-brand').evaluate((logo) => logo.tagName), 'IMG');
    assert.equal(await row.locator('small').count(), 0, 'Settings omits installation hint lines.');
    if (provider.id === 'codex') {
      assert.match(await row.innerText(), /codex-cli 1\.2\.3/);
      assert.equal(
        await row
          .getByRole('img', { name: 'CLI detected; sign-in not verified', exact: true })
          .count(),
        1,
      );
    } else {
      await row.getByText('Not installed', { exact: true }).waitFor();
    }
  }
  const beforeDetect = detections;
  await settings.getByRole('button', { name: 'Detect agents', exact: true }).click();
  await waitUntil(() => detections > beforeDetect, 'Detect agents did not refresh local status.');
  await settings.getByRole('button', { name: 'Detect agents', exact: true }).waitFor();
  assert.equal(await settings.locator('.connection-item').count(), 5);
  await page.waitForFunction(() =>
    [...document.images].every((image) => image.complete && image.naturalWidth > 0),
  );
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/openpe-agent-providers-settings.png' });
  await settings.getByRole('button', { name: 'Done', exact: true }).click();

  await picker.click();
  assert.equal(await page.getByRole('option').count(), 5);
  assert.doesNotMatch(
    await page.getByRole('listbox', { name: 'Choose agent' }).innerText(),
    /Install CLI to use/,
  );
  assert.match(
    await page.getByRole('listbox', { name: 'Choose agent' }).innerText(),
    /CLI detected · 1\.2\.3/,
  );
  await page.screenshot({ path: 'test-results/openpe-agent-providers-picker.png' });
  await page.keyboard.press('Escape');

  for (const provider of agentProviders.filter((provider) =>
    ['deepseek', 'pi', 'cursor'].includes(provider.id),
  )) {
    await selectProvider(provider);
    assert.equal(await modelPicker.innerText(), originalModels[provider.id]);
    assert.deepEqual(state.models, originalModels);
  }
  await selectProvider(agentProviders.find((provider) => provider.id === 'codex'));
  await modelPicker.click();
  await page.getByRole('option', { name: 'Codex alternate', exact: true }).click();
  await waitUntil(
    () => state.models.codex === 'fixture/codex-other',
    'The selected provider model was not persisted.',
  );
  const expectedModels = { ...originalModels, codex: 'fixture/codex-other' };
  await selectProvider(agentProviders.find((provider) => provider.id === 'pi'));
  assert.equal(await modelPicker.innerText(), originalModels.pi);
  assert.deepEqual(state.models, expectedModels);

  // Reload through actual workspace recovery, then return to another provider.
  await mount();
  assert.equal(await picker.getAttribute('aria-description'), 'Pi');
  assert.equal(await modelPicker.innerText(), originalModels.pi);
  await selectProvider(agentProviders.find((provider) => provider.id === 'codex'));
  await modelPicker.getByText('Codex alternate', { exact: true }).waitFor();
  assert.deepEqual(state.models, expectedModels);
  await selectProvider(agentProviders.find((provider) => provider.id === 'cursor'));
  await composer.fill('Retain this draft while the CLI is missing');
  await button('Send message').click();
  await settings.waitFor();
  await settings.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await composer.inputValue(), 'Retain this draft while the CLI is missing');
  assert.equal(chats, 0, 'Missing Agents never send provider requests.');
  assert.ok(modelRequests.every((provider) => provider === 'codex'));
  assert.equal(state.documents[0].source, source);
  assert.equal(state.documents[0].dirty, false);

  const setTheme = async (theme) => {
    await button('Settings').click();
    await settings
      .getByRole('radiogroup', { name: 'Theme', exact: true })
      .getByRole('radio', { name: theme, exact: true })
      .check();
    await settings.getByRole('button', { name: 'Done', exact: true }).click();
    await page.waitForFunction(
      (value) => document.documentElement.dataset.theme === value,
      theme.toLowerCase(),
    );
  };
  const assertPopupBounds = async (popup) => {
    const bounds = await popup.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(bounds.x >= 7 && bounds.y >= 7, 'Popup keeps its top/left viewport margin.');
    assert.ok(bounds.x + bounds.width <= viewport.width - 7, 'Popup fits the viewport width.');
    assert.ok(bounds.y + bounds.height <= viewport.height - 7, 'Popup fits the viewport height.');
    assert.ok(
      await popup.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      'Popup text and controls do not cause horizontal overflow.',
    );
  };
  const captureMenu = async (name) => {
    const viewport = page.viewportSize();
    const height = Math.min(420, viewport.height);
    await page.screenshot({
      path: `test-results/openpe-${name}.png`,
      clip: { x: 0, y: viewport.height - height, width: 420, height },
    });
  };
  for (const [size, viewport] of [
    ['normal', { width: 1440, height: 1000 }],
    ['short', { width: 1100, height: 420 }],
  ]) {
    await page.setViewportSize(viewport);
    for (const theme of ['Light', 'Dark']) {
      await setTheme(theme);
      const suffix = `${theme.toLowerCase()}-${size}`;
      await picker.click();
      const menu = page.getByRole('listbox', { name: 'Choose agent', exact: true });
      assert.equal(await menu.getByRole('option').count(), 5);
      assert.doesNotMatch(await menu.innerText(), /Install CLI to use/);
      await page.waitForFunction(() => {
        const logos = [...document.querySelectorAll('[role="listbox"] .agent-brand')];
        return logos.length === 5 && logos.every((logo) => logo.complete && logo.naturalWidth > 0);
      });
      assert.ok(
        await menu
          .locator('.agent-brand')
          .evaluateAll(
            (logos) =>
              logos.length === 5 &&
              logos.every(
                (logo) => logo.tagName === 'IMG' && logo.complete && logo.naturalWidth > 0,
              ),
          ),
      );
      await assertPopupBounds(menu);
      await menu.getByRole('option').last().scrollIntoViewIfNeeded();
      await assertPopupBounds(menu);
      await captureMenu(`agent-menu-${suffix}`);
      await picker.press('End');
      assert.equal(
        await picker.getAttribute('aria-activedescendant'),
        await menu.getByRole('option').last().getAttribute('id'),
      );
      await picker.press('Home');
      assert.equal(
        await picker.getAttribute('aria-activedescendant'),
        await menu.getByRole('option').first().getAttribute('id'),
      );
      await page.keyboard.press('Escape');
      assert.equal(await menu.count(), 0);

      await button('Settings').click();
      await settings.waitFor();
      for (const name of ['Reset appearance', 'Copy appearance', 'Export appearance'])
        assert.equal(await settings.getByRole('button', { name, exact: true }).count(), 0);
      assert.equal(await button('Settings').getAttribute('aria-haspopup'), null);
      assert.equal(await page.getByRole('menu', { name: 'OpenPE menu', exact: true }).count(), 0);
      await assertPopupBounds(settings);
      await page.screenshot({ path: `test-results/openpe-settings-${suffix}.png` });
      await page.keyboard.press('Escape');
      assert.equal(await settings.count(), 0);
      assert.equal(
        await button('Settings').evaluate((element) => document.activeElement === element),
        true,
      );
      for (const key of ['Enter', 'Space']) {
        await button('Settings').press(key);
        await settings.waitFor();
        await page.keyboard.press('Escape');
        assert.equal(await settings.count(), 0);
      }
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    'Five Agent identities, truthful missing status, preference recovery, draft retention and light/dark normal/short rail menus passed.',
  );
} finally {
  await browser.close();
}
