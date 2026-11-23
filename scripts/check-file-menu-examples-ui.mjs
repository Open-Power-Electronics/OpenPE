import { formatTestProjectSource } from './format-test-project.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { parseProject } from '../server/project-format.mjs';
import { readOriginalExamples } from './original-example-test-helpers.mjs';
import { bundledWorkbenchCatalog } from '../server/workbench-plugins.mjs';
import { defaultAgentPreferences } from '../server/workspace-format.mjs';
import { fillSource, readSource, selectSourceFile } from './source-editor-test-helpers.mjs';

// Real workspace/Core with in-memory native ports. No Electron, providers,
// solvers, native project writes or user profiles are used.
const manifest = JSON.parse(await readFile('resources/example-catalog/home-manifest.json', 'utf8'));
const recent = manifest.recent[0];
const example = manifest.examples[0];
const originals = await readOriginalExamples();
const examples = await Promise.all(
  [recent, example].map(async (item, index) => {
    const { source, filename } = originals.find((entry) => entry.key === `example:${item.id}`);
    return {
      key: `example:${item.id}`,
      id: `00000000-0000-4000-8000-00000000020${index}`,
      source,
      filename,
      title: parseProject(source).name,
    };
  }),
);
const rcSource = formatTestProjectSource();
const preferences = {
  provider: 'codex',
  effort: 'low',
  approvalMode: 'review',
  models: { ...defaultAgentPreferences.models },
};
// Host listings: catalog discovery by resource root and the pinned EMC shortcut.
const home = {
  examples: [...manifest.recent, ...manifest.examples].map(({ id, title, description, root }) => ({
    id,
    title,
    description,
    section: root,
  })),
  recent: manifest.recent.map(({ id, title, directory, file }) => ({
    id,
    title,
    description: `/fixture/examples/project/${directory}/${file}.kicad_pro`,
    pinned: true,
  })),
};
await mkdir('test-results', { recursive: true });
const bundle = await build({
  stdin: {
    contents: `import React from 'react';import{createRoot}from'react-dom/client';
      import Workspace from './components/DesktopWorkspace';
      createRoot(document.getElementById('root')).render(<React.StrictMode><Workspace/></React.StrictMode>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outdir: 'test-results/file-menu-examples-ui-bundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});

function documentState(id, source, extra = {}) {
  return {
    id,
    source,
    sourceDraft: null,
    dirty: false,
    filename: 'project.kicad_pro',
    sessions: [{ id: `session-${id}`, messages: [], draft: '' }],
    activeSessionId: `session-${id}`,
    ...extra,
  };
}

async function mount(titleBarOverlay, atLimit = false) {
  const page = await browser.newPage({ viewport: { width: 1120, height: 760 } });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const documents = atLimit
    ? [
        documentState(examples[1].id, examples[1].source, {
          exampleKey: examples[1].key,
          localExample: true,
          filename: examples[1].filename,
        }),
        ...Array.from({ length: 11 }, (_, index) =>
          documentState(
            `00000000-0000-4000-8000-0000000003${String(index).padStart(2, '0')}`,
            rcSource,
          ),
        ),
      ]
    : [];
  let recovery = {
    version: 2,
    documents,
    activeDocumentId: documents[0]?.id ?? null,
    ...preferences,
  };
  await page.addInitScript(
    ({ titleBarOverlay, examples, home }) => {
      window.exampleMenuCalls = { opens: [], saves: [], allocations: 0, releases: [] };
      window.openpe = {
        titleBarOverlay,
        titleBarInset: false,
        writeWorkspaceRecovery: async (content) => {
          await fetch('http://localhost/api/state', {
            method: content === null ? 'DELETE' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: content ?? undefined,
          });
        },
        connection: async () => ({ base: 'http://localhost', token: 'test' }),
        newFile: async () => {
          window.exampleMenuCalls.allocations++;
          return crypto.randomUUID();
        },
        listExamples: async () => ({ entries: home.examples, warnings: [] }),
        listRecent: async () => ({ initialized: true, entries: home.recent, warnings: [] }),
        onRecentChanged: () => () => {},
        projectDirectory: async () => ({ entries: [], truncated: false }),
        releaseFile: async (id) => window.exampleMenuCalls.releases.push(id),
        setDirty: async () => {},
        onCloseRequested: () => () => {},
        openDefaultExample: async (key) => {
          window.exampleMenuCalls.opens.push(key);
          const item = examples.find((entry) => entry.key === key);
          if (!item) throw new Error('Unexpected example in the isolated File menu check.');
          return {
            id: item.id,
            source: item.source,
            fileId: `grant-${item.id}`,
            filename: item.filename,
          };
        },
        save: async (options) => {
          window.exampleMenuCalls.saves.push(options);
          return { name: options.name };
        },
      };
    },
    { titleBarOverlay, examples, home },
  );
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/state') {
      if (route.request().method() === 'POST') recovery = route.request().postDataJSON();
      return route.fulfill({ json: recovery });
    }
    if (url.pathname === '/api/agent-settings')
      return route.fulfill({ json: { followUpMode: 'queue' } });
    if (url.pathname === '/api/appearance') return route.fulfill({ json: null });
    if (url.pathname === '/api/agents') return route.fulfill({ json: [] });
    if (url.pathname === '/api/models')
      return route.fulfill({ json: { models: [], defaultModel: '' } });
    if (url.pathname === '/api/workbench-plugins')
      return route.fulfill({ json: bundledWorkbenchCatalog() });
    if (url.pathname.startsWith('/api/')) return route.fulfill({ json: {} });
    if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(url.pathname))
      return route.fulfill({
        contentType: url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        body: await readFile('public' + url.pathname),
      });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
    await page.addStyleTag({ content: file.text });
  await page.addScriptTag({
    content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
  });
  const file = page.getByRole('combobox', { name: 'File', exact: true });
  await file.waitFor();
  if (atLimit) await page.getByTestId('schematic-canvas').waitFor();
  else await page.getByRole('textbox', { name: 'Describe your circuit', exact: true }).waitFor();
  return { page, file, errors };
}

const menu = (page, name) => page.getByRole('listbox', { name, exact: true });
const projects = (page) => page.locator('.project-navigation:visible [data-project-id]');
const calls = (page) => page.evaluate(() => structuredClone(window.exampleMenuCalls));

async function showBranch(page, name) {
  await page.getByRole('combobox', { name: 'File', exact: true }).click();
  await menu(page, 'File').getByRole('option', { name, exact: true }).hover();
  await menu(page, name).waitFor();
  return menu(page, name);
}

async function chooseExample(page, branch, title) {
  await (await showBranch(page, branch)).getByRole('option', { name: title, exact: true }).click();
}

async function boundsWithinViewport(page, popup) {
  const bounds = await popup.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(bounds && viewport);
  assert.ok(bounds.x >= 0 && bounds.y >= 0, 'The submenu remains inside the viewport.');
  assert.ok(bounds.x + bounds.width <= viewport.width + 1);
  assert.ok(bounds.y + bounds.height <= viewport.height + 1);
}

async function waitForBrandImages(page) {
  await page.waitForFunction(() => {
    const images = [...document.images].filter((image) =>
      /^\/(brand|agents)\//.test(image.getAttribute('src') ?? ''),
    );
    return images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0);
  });
}

async function focusBranchWithKeyboard(page, file, name) {
  await file.click();
  const labels = (await menu(page, 'File').getByRole('option').allTextContents()).map((value) =>
    value.trim(),
  );
  const index = labels.indexOf(name);
  assert.ok(index >= 0);
  await page.keyboard.press('Home');
  for (let step = 0; step < index; step++) await page.keyboard.press('ArrowDown');
}

async function composing(page, file, key, keyCode = 0, isComposing = true) {
  await file.evaluate(
    (element, init) =>
      element.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
      ),
    { key, code: key, keyCode, isComposing },
  );
}

try {
  for (const titleBarOverlay of [true, false]) {
    const { page, file, errors } = await mount(titleBarOverlay);
    assert.equal(await file.count(), 1, 'Caption and fallback surfaces expose one File menu.');
    assert.equal(await page.getByRole('heading', { name: 'Example', exact: true }).count(), 1);
    assert.equal(await page.getByRole('heading', { name: 'Examples', exact: true }).count(), 0);

    const recentMenu = await showBranch(page, 'Recent');
    const fileMenu = menu(page, 'File');
    assert.deepEqual(await fileMenu.getByRole('option').allTextContents(), [
      'New project',
      'Open project',
      'Recent',
      'Example',
    ]);
    for (const popup of [fileMenu, recentMenu]) {
      assert.ok((await popup.boundingBox()).width >= 140);
      const labels = await popup.locator('.select-option strong').evaluateAll((elements) =>
        elements.map((element) => ({
          whiteSpace: getComputedStyle(element).whiteSpace,
          fits:
            element.scrollWidth <= element.clientWidth + 1 &&
            element.scrollHeight <= element.clientHeight + 1,
        })),
      );
      assert.ok(
        labels.length > 0 && labels.every((label) => label.whiteSpace === 'nowrap' && label.fits),
        'Menu labels display their complete single-line text.',
      );
    }
    assert.deepEqual(
      (await recentMenu.getByRole('option').allTextContents()).map((value) => value.trim()),
      manifest.recent.map((item) => item.title),
    );
    await boundsWithinViewport(page, recentMenu);
    await page.keyboard.press('Escape');
    assert.equal(await menu(page, 'Recent').count(), 0);
    assert.equal(await file.getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape');
    assert.equal(await file.getAttribute('aria-expanded'), 'false');
    assert.equal(await file.evaluate((element) => document.activeElement === element), true);

    const examplesMenu = await showBranch(page, 'Example');
    assert.deepEqual(
      (await examplesMenu.getByRole('option').allTextContents()).map((value) => value.trim()),
      manifest.examples.map((item) => item.title),
      'File retains all Home Example in their catalog order.',
    );
    await boundsWithinViewport(page, examplesMenu);
    await waitForBrandImages(page);
    await page.screenshot({
      path: `test-results/file-menu-example-home-${titleBarOverlay ? 'caption' : 'fallback'}.png`,
    });
    await page.setViewportSize({ width: 1100, height: 740 });
    await page.waitForFunction(
      () =>
        document
          .querySelector('[role="combobox"][aria-label="File"]')
          ?.getAttribute('aria-expanded') === 'false',
    );
    assert.equal(
      await file.getAttribute('aria-expanded'),
      'false',
      'Resize dismisses the menu tree.',
    );
    await boundsWithinViewport(page, await showBranch(page, 'Example'));
    await page
      .getByRole('region', { name: 'Welcome to OpenPE', exact: true })
      .getByRole('heading', { level: 1 })
      .click();
    assert.equal(
      await file.getAttribute('aria-expanded'),
      'false',
      'Outside interaction dismisses both lists.',
    );

    await file.click();
    const touchedParent = menu(page, 'File').getByRole('option', { name: 'Example', exact: true });
    await touchedParent.dispatchEvent('click');
    await menu(page, 'Example').waitFor();
    await page.keyboard.press('ArrowLeft');
    assert.equal(await menu(page, 'Example').count(), 0);
    assert.equal(
      await file.getAttribute('aria-activedescendant'),
      await touchedParent.getAttribute('id'),
      'A parent activated without pointer hover remains the current keyboard row.',
    );
    await page.keyboard.press('ArrowRight');
    await menu(page, 'Example').waitFor();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    await focusBranchWithKeyboard(page, file, 'Example');
    await composing(page, file, 'Enter');
    await composing(page, file, 'Enter', 229, false);
    assert.equal(await menu(page, 'Example').count(), 0, 'IME cannot open a branch.');
    await page.keyboard.press('ArrowRight');
    await menu(page, 'Example').waitFor();
    await composing(page, file, 'Enter');
    await composing(page, file, 'Escape');
    await composing(page, file, 'Enter', 229, false);
    await composing(page, file, 'Escape', 229, false);
    assert.equal(
      await menu(page, 'Example').count(),
      1,
      'IME cannot choose or dismiss a child list.',
    );
    assert.deepEqual((await calls(page)).opens, []);
    await page.keyboard.press('ArrowLeft');
    assert.equal(await menu(page, 'Example').count(), 0);
    assert.equal(await file.getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Enter');
    await menu(page, 'Example').waitFor();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    await chooseExample(page, 'Recent', recent.title);
    await page.getByTestId('schematic-canvas').waitFor();
    assert.equal(await projects(page).count(), 1);
    assert.deepEqual((await calls(page)).opens, [examples[0].key]);
    await page
      .getByRole('textbox', { name: 'Message your agent', exact: true })
      .fill('Keep this conversation draft.');
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    await selectSourceFile(page, examples[0].filename);
    const accepted = await readSource(page);
    const invalid = '{unfinished File menu draft';
    await fillSource(page, invalid);
    await page.waitForFunction(() =>
      Boolean(document.querySelector('.project-navigation .dirty-dot')),
    );

    await chooseExample(page, 'Example', example.title);
    await page.getByTestId('schematic-canvas').waitFor();
    assert.equal(await projects(page).count(), 2);
    assert.deepEqual((await calls(page)).opens, [examples[0].key, examples[1].key]);
    assert.equal(
      await page.getByRole('dialog').count(),
      0,
      'Opening another project does not validate or discard the original Source.',
    );
    await chooseExample(page, 'Recent', recent.title);
    await page.getByRole('region', { name: 'Project source', exact: true }).waitFor();
    assert.equal(
      await readSource(page),
      invalid,
      'Returning to an open example retains the exact invalid native draft.',
    );
    assert.equal(
      await page.getByRole('textbox', { name: 'Message your agent', exact: true }).inputValue(),
      'Keep this conversation draft.',
    );
    assert.deepEqual(
      (await calls(page)).opens,
      [examples[0].key, examples[1].key],
      'An already open example activates without another native open.',
    );
    assert.equal(await projects(page).count(), 2);
    assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 1);
    assert.deepEqual((await calls(page)).saves, []);

    await fillSource(page, accepted);
    await page.getByRole('button', { name: 'Schematic', exact: true }).click();
    await page.getByRole('button', { name: 'Home', exact: true }).click();
    await chooseExample(page, 'Example', example.title);
    await page.getByTestId('schematic-canvas').waitFor();
    assert.equal(await projects(page).count(), 2);
    assert.deepEqual(
      (await calls(page)).opens,
      [examples[0].key, examples[1].key],
      'The Home File menu also selects the existing workspace.',
    );
    await showBranch(page, 'Example');
    await waitForBrandImages(page);
    assert.deepEqual(errors, []);
    await page.screenshot({
      path: `test-results/file-menu-examples-${titleBarOverlay ? 'caption' : 'fallback'}.png`,
    });
    await page.close();

    const limit = await mount(titleBarOverlay, true);
    assert.equal(await projects(limit.page).count(), 12);
    assert.deepEqual((await calls(limit.page)).opens, [examples[1].key]);
    await chooseExample(limit.page, 'Recent', recent.title);
    await limit.page.getByRole('status').filter({ hasText: 'maximum 12' }).waitFor();
    assert.equal(await projects(limit.page).count(), 12);
    assert.deepEqual(
      (await calls(limit.page)).opens,
      [examples[1].key],
      'Project admission rejects a new example before native opening at the limit.',
    );
    await limit.page.getByRole('button', { name: 'Home', exact: true }).click();
    await chooseExample(limit.page, 'Example', example.title);
    await limit.page.getByTestId('schematic-canvas').waitFor();
    assert.equal(await projects(limit.page).count(), 12);
    assert.deepEqual(
      (await calls(limit.page)).opens,
      [examples[1].key],
      'An existing example remains selectable at the project limit.',
    );
    assert.deepEqual(limit.errors, []);
    await limit.page.close();
  }
  console.log(
    'File Recent/Example passed: caption/fallback, Home/workspace, catalog order, nested keyboard/IME, viewport dismissal, native-open deduplication, retained Source/conversation drafts and project admission limit.',
  );
} finally {
  await browser.close();
}
