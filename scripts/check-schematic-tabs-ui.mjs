import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { parseProject, projectNativeFiles } from '../server/project-format.mjs';
import {
  fillSource,
  readSource,
  readNativeFiles,
  selectSourceFile,
} from './source-editor-test-helpers.mjs';

// Isolated renderer with private IPC snapshots and native Source files in memory.
const source = await readFile('tests/fixtures/rc-filter.openpe.json', 'utf8');
const bundle = await build({
  stdin: {
    contents:
      "import React from 'react'; import {createRoot} from 'react-dom/client'; import Workspace from './components/DesktopWorkspace'; createRoot(document.getElementById('root')).render(<Workspace/>);",
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outdir: 'test-results/schematic-tabs-ui-bundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});
try {
  let recovery = null;
  let saved = source;
  const page = await browser.newPage({ viewport: { width: 1250, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.exposeFunction('readSaved', () => saved);
  await page.exposeFunction('writeSaved', (value) => {
    saved = value;
  });
  await page.addInitScript(() => {
    window.openpe = {
      titleBarOverlay: false,
      writeWorkspaceRecovery: async (content) => {
        await fetch('http://localhost/api/state', {
          method: content === null ? 'DELETE' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: content ?? undefined,
        });
      },
      connection: async () => ({ base: 'http://localhost', token: 'test' }),
      newFile: async () => crypto.randomUUID(),
      releaseFile: async () => {},
      open: async () => ({
        source: await window.readSaved(),
        name: 'tabs.kicad_pro',
        native: true,
      }),
      acceptOpen: async () => crypto.randomUUID(),
      save: async ({ source }) => {
        await window.writeSaved(source);
        return { name: 'tabs.kicad_pro' };
      },
      setDirty: async () => {},
      onCloseRequested: () => () => {},
    };
  });
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/state') {
      if (route.request().method() === 'POST') recovery = route.request().postDataJSON();
      if (route.request().method() === 'DELETE') recovery = null;
      return route.fulfill({ json: recovery });
    }
    if (url.pathname === '/api/appearance') return route.fulfill({ json: null });
    if (url.pathname === '/api/agents') return route.fulfill({ json: [] });
    if (url.pathname === '/api/models')
      return route.fulfill({ json: { models: [], defaultModel: '' } });
    if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(url.pathname))
      return route.fulfill({ body: await readFile('public' + url.pathname) });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  const mount = async () => {
    for (const path of ['app/globals.css', 'app/workspace.css'])
      await page.addStyleTag({ content: await readFile(path, 'utf8') });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
  };
  await page.goto('http://localhost');
  await mount();
  const button = (name) => page.getByRole('button', { name, exact: true });
  const tabs = () => page.getByRole('tablist', { name: 'Schematic files' });
  const closeTab = (name) =>
    tabs()
      .getByRole('button', { name: `Close ${name}`, exact: true })
      .click();
  const reopen = async (name) => {
    await page.getByRole('combobox', { name: 'Open file', exact: true }).click();
    await page.getByRole('option', { name, exact: true }).click();
  };
  await button('Open project').click();
  await button('New file').click();
  const first = await tabs().getByRole('tab').first().innerText();
  const second = await tabs().getByRole('tab', { selected: true }).innerText();
  await page.locator('.project-navigation [data-project-id]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Save', exact: true }).click();
  await page.getByText('Save project', { exact: true }).waitFor();
  const baseline = saved;
  assert.ok(JSON.parse(baseline).pcb, 'The fixture keeps its linked PCB.');
  await button('Source').click();
  const baselineNative = await readNativeFiles(page);
  await button('Schematic').click();
  await closeTab(first);
  assert.equal(await tabs().getByRole('tab').count(), 1);
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  await button('Source').click();
  assert.deepEqual(
    await readNativeFiles(page),
    baselineNative,
    'Closing the primary tab preserves its schematic, PCB and all project bytes.',
  );
  await button('Schematic').click();
  await reopen(first);
  assert.equal(await tabs().getByRole('tab').count(), 2);
  await button('Source').click();
  await selectSourceFile(page, baselineNative.entry);
  await fillSource(page, '{unfinished');
  await closeTab(first);
  assert.equal(
    await tabs().getByRole('tab').count(),
    2,
    'Invalid Source prevents switching away from the active tab.',
  );
  assert.equal(await readSource(page), '{unfinished');
  await closeTab(second);
  assert.equal(
    await tabs().getByRole('tab').count(),
    1,
    'A background tab can close without touching pending Source.',
  );
  await closeTab(first);
  await page.getByRole('dialog', { name: 'Save changes?', exact: true }).waitFor();
  await button('Cancel').click();
  assert.equal(await readSource(page), '{unfinished');
  const persisted = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/state') &&
      response.request().method() === 'POST' &&
      response.request().postDataJSON().documents[0]?.closedSchematicIds?.length === 1 &&
      response.request().postDataJSON().documents[0]?.sourceDraft === null,
  );
  await fillSource(
    page,
    baselineNative.files.find((file) => file.name === baselineNative.entry).source,
  );
  await button('Schematic').click();
  await persisted;
  await page.reload();
  await mount();
  await tabs().getByRole('tab').waitFor();
  assert.equal(await tabs().getByRole('tab').count(), 1, 'Recovery retains closed views.');
  assert.deepEqual(
    projectNativeFiles(parseProject(recovery.documents[0].source), 'tabs.kicad_pro'),
    baselineNative,
  );
  await closeTab(first);
  await page.getByRole('region', { name: 'Welcome to OpenPE', exact: true }).waitFor();
  assert.equal(
    await page.locator('.project-navigation [data-project-id]').count(),
    0,
    'Closing the last clean tab closes its project.',
  );
  assert.equal(saved, baseline);
  await button('Open project').click();
  await tabs().getByRole('tab').first().waitFor();
  assert.equal(
    await tabs().getByRole('tab').count(),
    2,
    'Reopening the saved project shows both retained schematics.',
  );
  await closeTab(first);
  await button('Source').click();
  await fillSource(page, '{discard this draft');
  await closeTab(second);
  await button("Don't save").click();
  await page.getByRole('region', { name: 'Welcome to OpenPE', exact: true }).waitFor();
  assert.equal(saved, baseline, 'Discarding a project never deletes its saved file.');
  assert.deepEqual(errors, []);
  console.log(
    'Schematic tabs: non-destructive close/reopen, PCB preservation, clean state, draft protection, recovery and last-tab project close passed.',
  );
} finally {
  await browser.close();
}
