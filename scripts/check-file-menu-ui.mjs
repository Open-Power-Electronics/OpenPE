import { formatTestProjectSource } from './format-test-project.mjs';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fileMenuAction } from './file-menu-test-helpers.mjs';
import {
  fillSource,
  fillNativeProject,
  readNativeFiles,
  readSource,
} from './source-editor-test-helpers.mjs';
import { waitForAsync } from './async-browser-test-helpers.mjs';
import { parseProject, projectNativeFiles } from '../server/project-format.mjs';
const orderedNativeFiles = (bundle) => ({
  ...bundle,
  files: bundle.files.toSorted((a, b) => a.name.localeCompare(b.name)),
});
const editOnly = process.argv.includes('--edit');

async function checkEditMenu(page) {
  const edit = page.getByRole('combobox', { name: 'Edit', exact: true });
  const menu = page.getByRole('listbox', { name: 'Edit', exact: true });
  const action = (name) => menu.getByRole('option', { name, exact: true });
  const choose = async (name) => {
    await edit.click();
    await action(name).click();
    await menu.waitFor({ state: 'hidden' });
  };
  const canvas = page.getByTestId('schematic-canvas');
  const sourceTab = page.getByRole('button', { name: 'Source', exact: true });
  const schematicTab = page.getByRole('button', { name: 'Schematic', exact: true });
  await sourceTab.click();
  const nativeBaseline = await readNativeFiles(page);
  await schematicTab.click();
  await canvas.focus();
  const initialCount = await canvas.locator('[data-selection-id]').count();
  assert.ok(initialCount > 0);
  const count = (expected) =>
    waitForAsync(
      page,
      (expected) =>
        document.querySelectorAll('[data-testid="schematic-canvas"] [data-selection-id]').length ===
        expected,
      expected,
    );
  const menuTypography = (row) =>
    row.locator('strong').evaluate((label) => {
      const { fontFamily, fontSize, fontWeight, lineHeight } = getComputedStyle(label);
      return { fontFamily, fontSize, fontWeight, lineHeight };
    });
  const file = page.getByRole('combobox', { name: 'File', exact: true });
  await file.click();
  const fileLabel = await menuTypography(
    page.getByRole('option', { name: 'New project', exact: true }),
  );
  await file.press('Escape');
  await edit.click();
  assert.equal(await action('Find').getAttribute('aria-keyshortcuts'), 'Control+F');
  assert.doesNotMatch(await menu.textContent(), /\b(?:Ctrl|Cmd|Control|Meta)\+/);
  const label = await menuTypography(action('Find'));
  assert.deepEqual(label, fileLabel, 'Edit and File use the same menu typography.');
  await page.evaluate(() => document.documentElement.style.setProperty('--font-step', '2px'));
  const largerLabel = await menuTypography(action('Find'));
  assert.equal(parseFloat(largerLabel.fontSize), parseFloat(label.fontSize) + 2);
  await page.evaluate(() => document.documentElement.style.removeProperty('--font-step'));
  assert.equal(await action('Cut').getAttribute('aria-disabled'), 'true');
  assert.equal(await action('Select all').getAttribute('aria-keyshortcuts'), 'Control+A');
  await action('Select all').click();
  await waitForAsync(
    page,
    () => document.activeElement?.getAttribute('data-testid') === 'schematic-canvas',
  );
  await canvas.press('Control+x');
  await waitForAsync(
    page,
    (count) =>
      document.querySelectorAll('[data-testid="schematic-canvas"] [data-selection-id]').length <
      count,
    initialCount,
  );
  const cutCount = await canvas.locator('[data-selection-id]').count();
  await canvas.press('Control+z');
  await count(initialCount);
  await choose('Redo');
  await count(cutCount);
  await choose('Paste');
  await count(initialCount);
  await canvas.press('Control+z');
  await count(cutCount);
  await canvas.press('Control+z');
  await count(initialCount);
  await canvas.press('Control+y');
  await count(cutCount);
  await choose('Undo');
  await count(initialCount);
  await choose('Find');
  const previewFind = page.getByRole('search', { name: 'Find in Preview', exact: true });
  await previewFind.getByRole('searchbox').press('Escape');
  await previewFind.waitFor({ state: 'hidden' });

  const draft = page.getByRole('textbox', { name: 'Message your agent', exact: true });
  await draft.fill('Draft');
  await draft.dispatchEvent('compositionstart');
  await page.keyboard.press('Control+,');
  await edit.click();
  assert.equal(await menu.count(), 0);
  assert.equal(await draft.evaluate((element) => document.activeElement === element), true);
  await draft.dispatchEvent('compositionend');
  await choose('Find');
  const find = page.getByRole('search', { name: 'Find in Agent', exact: true });
  await find.waitFor();
  await find.getByRole('searchbox').press('Escape');
  assert.equal(await draft.evaluate((element) => document.activeElement === element), true);
  await choose('Select all');
  await waitForAsync(page, () => document.activeElement?.selectionEnd === 5);
  await draft.evaluate((element) => {
    if (element.selectionStart !== 0) throw Error('The draft was not selected.');
    navigator.clipboard.readText = async () => 'Pasted draft';
  });
  await choose('Paste');
  await waitForAsync(page, () => document.activeElement?.value === 'Pasted draft');
  await choose('Undo');
  await waitForAsync(page, () => document.activeElement?.value === 'Draft');
  await choose('Redo');
  await waitForAsync(page, () => document.activeElement?.value === 'Pasted draft');
  await choose('Select all');
  await waitForAsync(page, () => document.activeElement?.selectionEnd === 12);
  await choose('Delete');
  await waitForAsync(page, () => document.activeElement?.value === '');
  assert.equal(await canvas.locator('[data-selection-id]').count(), initialCount);
  await page.keyboard.press('Control+,');
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await settings.waitFor();
  await page.keyboard.press('Escape');
  await settings.waitFor({ state: 'hidden' });

  await sourceTab.click();
  assert.deepEqual(
    orderedNativeFiles(await readNativeFiles(page)),
    orderedNativeFiles(nativeBaseline),
  );
  const source = page.getByRole('textbox', { name: 'Project file source', exact: true });
  const baseline = await readSource(page);
  await source.press('Control+End');
  await source.press('Enter');
  await choose('Undo');
  await waitForAsync(page, () => document.activeElement?.classList.contains('cm-content'));
  assert.equal(await readSource(page), baseline);
  await source.focus();
  await choose('Redo');
  await waitForAsync(page, () => document.activeElement?.classList.contains('cm-content'));
  assert.equal(await readSource(page), `${baseline}\n`);
  await source.press('Control+z');
  await schematicTab.click();
  await canvas.waitFor();
}

// Isolated renderer: native save/export boundaries are mocked; no Electron or file writes.
await mkdir('test-results', { recursive: true });
const source = formatTestProjectSource();
const bundle = await build({
  stdin: {
    contents:
      "import React from 'react'; import {createRoot} from 'react-dom/client'; import Workspace from './components/DesktopWorkspace'; createRoot(document.getElementById('root')).render(<Workspace/>);",
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outdir: 'test-results/file-menu-ui-bundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  for (const titleBarOverlay of editOnly ? [true] : [true, false]) {
    const page = await browser.newPage({ viewport: { width: 1120, height: 760 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.setDefaultTimeout(10000);
    await page.addInitScript(
      ({ titleBarOverlay }) => {
        window.fileCalls = { saves: [], exports: [], exportOutcome: 'success' };
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
          newFile: async () => 'fixture-grant',
          listExamples: async () => ({ entries: [], warnings: [] }),
          listRecent: async () => ({ initialized: true, entries: [], warnings: [] }),
          onRecentChanged: () => () => {},
          projectDirectory: async () => ({ entries: [], truncated: false }),
          releaseFile: async () => {},
          setDirty: async () => {},
          onCloseRequested: () => () => {},
          save: async (options) => {
            window.fileCalls.saves.push(options);
            if (window.fileCalls.saves.length === 1)
              await new Promise((resolve) => (window.fileCalls.finishSave = resolve));
            return { name: options.saveAs ? 'copy.kicad_pro' : 'saved.kicad_pro' };
          },
          exportProject: async (options) => {
            window.fileCalls.exports.push(options);
            if (window.fileCalls.exportOutcome === 'cancel') return null;
            if (window.fileCalls.exportOutcome === 'error')
              throw new Error('Export fixture failed');
            return { name: 'export-bom.csv', format: options.format };
          },
        };
      },
      { titleBarOverlay },
    );
    await page.route('http://localhost/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/state')
        return route.fulfill({
          json: {
            version: 2,
            documents: [
              {
                id: '00000000-0000-4000-8000-000000000001',
                source,
                dirty: false,
                sourceDraft: null,
                filename: 'rc.kicad_pro',
                sessions: [{ id: 'session-one', messages: [], draft: '' }],
                activeSessionId: 'session-one',
              },
            ],
            activeDocumentId: '00000000-0000-4000-8000-000000000001',
            provider: 'codex',
            effort: 'low',
            approvalMode: 'review',
            models: { codex: '', claude: '', deepseek: '', pi: '', cursor: '' },
          },
        });
      if (url.pathname === '/api/agent-settings')
        return route.fulfill({ json: { followUpMode: 'queue' } });
      if (url.pathname === '/api/appearance') return route.fulfill({ json: null });
      if (url.pathname === '/api/agents') return route.fulfill({ json: [] });
      if (url.pathname === '/api/models')
        return route.fulfill({ json: { models: [], defaultModel: '' } });
      if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(url.pathname))
        return route.fulfill({
          contentType: url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
          body: await readFile('public' + url.pathname),
        });
      return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    });
    await page.goto('http://localhost');
    for (const path of ['app/globals.css', 'app/workspace.css'])
      await page.addStyleTag({ content: await readFile(path, 'utf8') });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page
      .getByTestId('schematic-canvas')
      .waitFor({ timeout: 30000 })
      .catch(async (error) => {
        console.error({ errors, screen: await page.locator('body').innerText() });
        throw error;
      });
    const fileMenu = page.getByRole('combobox', { name: 'File', exact: true });
    await fileMenu.waitFor().catch(async (error) => {
      console.error({ titleBarOverlay, errors, screen: await page.locator('body').innerText() });
      throw error;
    });
    assert.equal(await fileMenu.count(), 1, 'File is available with or without a native caption.');
    if (editOnly) {
      await checkEditMenu(page);
      assert.deepEqual(errors, []);
      await page.close();
      continue;
    }
    for (const name of ['Save', 'Save as', 'Export'])
      assert.equal(
        await page.locator('.app-header').getByRole('button', { name, exact: true }).count(),
        0,
      );
    await fileMenuAction(page, 'Save');
    await page.waitForFunction(() => typeof window.fileCalls.finishSave === 'function');
    await fileMenuAction(page, ['Export', 'BOM']);
    await page
      .getByRole('status')
      .filter({ hasText: 'A project file operation is already in progress.' })
      .waitFor();
    assert.equal(await page.evaluate(() => window.fileCalls.exports.length), 0);
    await page.evaluate(() => window.fileCalls.finishSave());
    await page.getByRole('status').filter({ hasText: 'Save project' }).waitFor();
    await fileMenuAction(page, 'Save as');
    await page.waitForFunction(() => window.fileCalls.saves.length === 2);
    const saves = await page.evaluate(() => window.fileCalls.saves);
    assert.deepEqual(
      saves.map((entry) => entry.saveAs),
      [false, true],
    );
    assert.equal(saves[0].fileId, saves[1].fileId);
    const savedProject = JSON.parse(saves[0].source);
    assert.deepEqual(
      { ...savedProject, nativeFiles: undefined },
      { ...JSON.parse(source), nativeFiles: undefined },
    );
    assert.deepEqual(
      savedProject.nativeFiles,
      projectNativeFiles(parseProject(source), 'rc.kicad_pro'),
      'Save carries the complete native file set as well as the unchanged design snapshot.',
    );
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    const exportBaseline = await readNativeFiles(page);
    await page.getByRole('button', { name: 'Schematic', exact: true }).click();
    await fileMenu.click();
    await fileMenu.press('End');
    await fileMenu.press('ArrowUp');
    await fileMenu.press('ArrowRight');
    const formats = page.getByRole('listbox', { name: 'Export', exact: true });
    await formats.waitFor();
    assert.deepEqual(await formats.getByRole('option').allTextContents(), [
      'Schematic netlist (XML)',
      'Board outline (DXF)',
      'Gerbers',
      'Excellon drill files',
      'Stencil Gerbers',
      'JLCPCB',
      'BOM',
      'CPL',
    ]);
    await fileMenu.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
    assert.equal(await page.evaluate(() => window.fileCalls.exports.length), 0);
    await fileMenu.press('Escape');
    assert.equal(await formats.count(), 0, 'Escape returns to the File menu.');
    await fileMenu.press('ArrowRight');
    await formats.waitFor();
    await page.screenshot({
      path: `test-results/file-menu-formats-${titleBarOverlay ? 'caption' : 'fallback'}.png`,
    });
    await fileMenu.press('b');
    await fileMenu.press('o');
    await fileMenu.press('m');
    await fileMenu.press('Enter');
    const panel = page.getByRole('dialog', { name: 'Export', exact: true });
    await page.waitForFunction(() => window.fileCalls.exports.length === 1);
    assert.equal(await panel.count(), 0, 'Export goes straight to the native bridge.');
    assert.equal(await page.evaluate(() => window.fileCalls.exports[0].format), 'bom');
    assert.deepEqual(
      orderedNativeFiles(
        projectNativeFiles(
          parseProject(await page.evaluate(() => window.fileCalls.exports[0].source)),
          'copy.kicad_pro',
        ),
      ),
      orderedNativeFiles(exportBaseline),
    );
    assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
    await page.screenshot({
      path: `test-results/file-menu-${titleBarOverlay ? 'caption' : 'fallback'}.png`,
    });
    assert.equal(await fileMenu.evaluate((el) => el === document.activeElement), true);
    await page.evaluate(() => {
      window.fileCalls.exportOutcome = 'cancel';
    });
    await fileMenuAction(page, ['Export', 'BOM']);
    await page.waitForFunction(() => window.fileCalls.exports.length === 2);
    assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
    await page.evaluate(() => {
      window.fileCalls.exportOutcome = 'error';
    });
    await fileMenuAction(page, ['Export', 'BOM']);
    await page.getByRole('status').filter({ hasText: 'Export fixture failed' }).waitFor();
    await page.evaluate(() => {
      window.fileCalls.exportOutcome = 'success';
    });
    await page.getByRole('button', { name: 'Source', exact: true }).click();
    const changed = parseProject(source);
    changed.schematic.title = 'Edited before export';
    await fillNativeProject(page, changed);
    await fileMenuAction(page, ['Export', 'Schematic netlist (XML)']);
    await page.waitForFunction(() => window.fileCalls.exports.length === 4);
    assert.equal(await page.evaluate(() => window.fileCalls.exports[3].format), 'netlist');
    assert.equal(
      parseProject(await page.evaluate(() => window.fileCalls.exports[3].source)).schematic.title,
      changed.schematic.title,
    );
    assert.equal(
      await page.locator('.project-navigation .dirty-dot').count(),
      1,
      'Export keeps valid Source changes unsaved.',
    );
    await fillSource(page, '{invalid');
    await fileMenuAction(page, 'Save');
    await page
      .getByRole('status')
      .filter({ hasText: 'Fix the source errors before saving' })
      .waitFor();
    await fileMenuAction(page, ['Export', 'Schematic netlist (XML)']);
    await page
      .getByRole('status')
      .filter({ hasText: 'Fix the source errors before exporting' })
      .waitFor();
    assert.equal(await panel.count(), 0, 'Invalid Source cannot open export.');
    assert.equal(await page.evaluate(() => window.fileCalls.saves.length), 2);
    assert.equal(await page.evaluate(() => window.fileCalls.exports.length), 4);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    editOnly
      ? 'Edit menu: drawing and text commands, shortcuts, focus, Find and Source history passed.'
      : 'File menus: Save, Save as, export, Source protection, focus and caption/fallback access passed.',
  );
} finally {
  await browser.close();
}
