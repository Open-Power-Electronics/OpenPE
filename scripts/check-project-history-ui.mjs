import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { defaultAgentPreferences } from '../server/workspace-format.mjs';
import { readSource, fillSource } from './source-editor-test-helpers.mjs';
import { fileMenuAction } from './file-menu-test-helpers.mjs';
import {
  appendSchematic,
  parseProject,
  projectNativeFiles,
  projectFromNativeFiles,
  serializeProject,
} from '../server/project-format.mjs';

// Isolated renderer regression: no Electron, Git, providers or native filesystem access.
await mkdir('test-results', { recursive: true });
let fixture = parseProject(await readFile('tests/fixtures/rc-filter.openpe.json', 'utf8'));
for (const footprint of fixture.pcb.footprints) {
  const part = fixture.schematic.parts.find((part) => part.id === footprint.symbolId);
  (part.fields ??= {}).Footprint = footprint.libraryId;
}
for (const net of fixture.pcb.nets) {
  if (net.name === '/IN' || net.name === '/OUT') net.name = net.name.slice(1);
}
fixture = projectFromNativeFiles(projectNativeFiles(fixture, 'rc.kicad_pro'));
const source = serializeProject(fixture);
const project = JSON.parse(source);
const changed = structuredClone(project);
changed.schematic.components[0].value = '4.7k';
const changedSource = serializeProject(parseProject(JSON.stringify(changed)));
const nativeBefore = new Map(
  projectNativeFiles(parseProject(source), 'rc.kicad_pro').files.map((file) => [
    file.name,
    file.source,
  ]),
);
const changedNames = projectNativeFiles(parseProject(changedSource), 'rc.kicad_pro')
  .files.filter((file) => nativeBefore.get(file.name) !== file.source)
  .map((file) => file.name);
const nativeSchematic = (text) =>
  projectNativeFiles(parseProject(text), 'rc.kicad_pro').files.find((file) =>
    file.name.endsWith('.kicad_sch'),
  ).source;
const multiple = appendSchematic(parseProject(source));
multiple.schematic.title = 'Auxiliary';
multiple.schematic.libraries['Device:R'] = fixture.schematic.libraries['Device:R'];
multiple.schematic.parts.push({
  id: randomUUID(),
  libId: 'Device:R',
  ref: 'R9',
  value: '22k',
  x: 25.4,
  y: 25.4,
  rotation: 0,
});
const replacedLabelId = randomUUID();
multiple.project.schematic.labels[0].id = replacedLabelId;
delete multiple.project.schematic.labels[0].raw;
const multiSource = serializeProject(multiple.project);
let state = {
  version: 2,
  documents: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      source,
      sourceDraft: null,
      dirty: false,
      filename: 'rc.kicad_pro',
      sessions: [{ id: 'session-one', messages: [], draft: '' }],
      activeSessionId: 'session-one',
    },
  ],
  activeDocumentId: '00000000-0000-4000-8000-000000000001',
  provider: 'codex',
  effort: 'low',
  approvalMode: 'review',
  models: { ...defaultAgentPreferences.models },
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
  outdir: 'test-results/project-history-ui-bundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
let page;
let errors = [];
try {
  page = await browser.newPage({ viewport: { width: 1120, height: 760 } });
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(15000);
  await page.addInitScript(
    ({ source, changedSource }) => {
      const versions = [
        {
          id: 'b'.repeat(40),
          date: '2026-10-13T12:30:00+08:00',
          message: 'Tune resistor',
          source: changedSource,
        },
        {
          id: 'a'.repeat(40),
          date: '2026-10-13T12:00:00+08:00',
          message: 'Initial design',
          source,
        },
      ];
      window.testHistory = {
        versions,
        creates: [],
        fail: false,
        unavailableVersion: '',
        needsSave: false,
        saveCancelled: true,
      };
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
        listExamples: async () => ({ entries: [], warnings: [] }),
        listRecent: async () => ({ initialized: true, entries: [], warnings: [] }),
        onRecentChanged: () => () => {},
        projectDirectory: async () => ({ entries: [], truncated: false }),
        releaseFile: async () => {},
        setDirty: async () => {},
        onCloseRequested: () => () => {},
        save: async ({ saveAs }) => {
          if (window.testHistory.saveCancelled) return null;
          window.testHistory.needsSave = false;
          if (saveAs) versions.length = 0;
          return { name: 'rc.kicad_pro', path: 'fixture/rc.kicad_pro' };
        },
        historyList: async ({ offset = 0 }) => {
          if (window.testHistory.fail)
            throw new Error(
              'Git was not found. Install Git and restart OpenPE to use version history.',
            );
          if (window.testHistory.needsSave)
            return { version: '', commits: [], more: false, needsSave: true };
          return {
            version: 'git version fixture',
            commits: versions.slice(offset, offset + 2),
            more: offset + 2 < versions.length,
          };
        },
        historyRead: async ({ id }) => {
          if (id === window.testHistory.unavailableVersion)
            throw new Error('The selected version is no longer reachable.');
          return versions.find((entry) => entry.id === id).source;
        },
        historyCreate: async ({ source, message }) => {
          window.testHistory.creates.push(source);
          const entry = { id: 'c'.repeat(40), date: '2026-10-13T13:00:00+08:00', message, source };
          versions.unshift(entry);
          return { id: entry.id };
        },
      };
    },
    { source, changedSource },
  );
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/state') {
      if (route.request().method() === 'POST') state = route.request().postDataJSON();
      return route.fulfill({ json: state });
    }
    if (url.pathname === '/api/agent-settings')
      return route.fulfill({ json: { followUpMode: 'queue' } });
    if (url.pathname === '/api/appearance') return route.fulfill({ json: null });
    if (url.pathname === '/api/agents') return route.fulfill({ json: [] });
    if (url.pathname === '/api/models')
      return route.fulfill({ json: { models: [], defaultModel: '' } });
    if (/^\/(brand|agents)\/[\w.-]+\.(svg|png)$/.test(url.pathname))
      return route.fulfill({
        contentType: url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        body: await readFile('public' + url.pathname),
      });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  await page.addStyleTag({ content: await readFile('app/globals.css', 'utf8') });
  await page.addStyleTag({ content: await readFile('app/workspace.css', 'utf8') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page
    .getByTestId('schematic-canvas')
    .waitFor()
    .catch(async (error) => {
      await page.screenshot({ path: 'test-results/project-history-failure.png' });
      console.error(await page.locator('body').innerText(), errors);
      throw error;
    });
  const button = (name) => page.getByRole('button', { name, exact: true });
  async function checkGitPlacement() {
    await button('Git').waitFor();
    assert.equal(
      await button('Git').evaluate((el) => el.previousElementSibling?.getAttribute('aria-label')),
      'List',
      'Git immediately follows List.',
    );
    const parts = await button('List').boundingBox();
    const git = await button('Git').boundingBox();
    assert.ok(git.x >= parts.x + parts.width && Math.abs(git.y - parts.y) < 1);
    assert.equal(await page.locator('.editor-view-switch-host > button').count(), 0);
  }
  await checkGitPlacement();

  await button('Git').click();
  const history = page.getByRole('region', { name: 'Git', exact: true });
  const comparison = history.getByRole('region', { name: 'Schematic comparison', exact: true });
  await history.getByLabel(changedNames.length + ' changed files', { exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog', { name: 'Git', exact: true }).count(), 1);
  assert.equal(await button('Git').getAttribute('aria-expanded'), 'true');
  assert.equal(await button('Schematic').getAttribute('aria-pressed'), 'true');
  assert.equal(
    await page.getByRole('group', { name: 'Editor view', exact: true }).getByRole('button').count(),
    4,
  );
  const closeGit = () =>
    page
      .getByRole('dialog', { name: 'Git', exact: true })
      .getByRole('button', { name: 'Close dialog', exact: true })
      .click();
  assert.equal(
    await history
      .getByRole('button', { name: 'Worktree Current project' })
      .getAttribute('aria-current'),
    'true',
  );
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  const sidebar = await history.locator('.history-sidebar').boundingBox();
  const content = await history.locator('.history-comparison').boundingBox();
  assert.ok(
    sidebar.x + sidebar.width <= content.x + 1,
    'The worktree and versions stay left of the comparison.',
  );
  const panes = comparison.locator('.schematic-compare-pane');
  const drawings = panes.locator('svg[role="img"]');
  async function checkSchematicComparison(theme) {
    assert.equal(await drawings.count(), 2, 'Both revisions render actual schematic geometry.');
    await comparison.getByText('Changed 1', { exact: true }).waitFor();
    const id = project.schematic.components[0].id;
    for (let side = 0; side < 2; side++) {
      const part = panes.nth(side).locator('[data-compare-id="' + id + '"]');
      assert.equal(await part.getAttribute('data-change'), 'changed');
      assert.equal(await part.locator('.symbol-graphic').count(), 1);
      const highlight = panes.nth(side).locator('.compare-object-highlight');
      assert.equal(await highlight.count(), 1);
      assert.ok(
        await highlight.evaluate((el) => el.width.baseVal.value > 3 && el.height.baseVal.value > 3),
      );
      const colour = await highlight.evaluate((el) => getComputedStyle(el).stroke);
      assert.ok(colour !== 'none' && colour !== 'rgba(0, 0, 0, 0)');
    }
    const initialView = await drawings.nth(0).getAttribute('viewBox');
    await comparison.getByRole('button', { name: 'Zoom in comparison', exact: true }).click();
    assert.notEqual(await drawings.nth(0).getAttribute('viewBox'), initialView);
    assert.equal(
      await drawings.nth(0).getAttribute('viewBox'),
      await drawings.nth(1).getAttribute('viewBox'),
    );
    const bounds = await drawings.nth(1).boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 + 40, bounds.y + bounds.height / 2 + 20, {
      steps: 4,
    });
    await page.mouse.up();
    assert.equal(
      await drawings.nth(0).getAttribute('viewBox'),
      await drawings.nth(1).getAttribute('viewBox'),
    );
    await comparison.getByRole('button', { name: 'Fit comparison', exact: true }).click();
    assert.equal(await drawings.nth(0).getAttribute('viewBox'), initialView);
    await page.screenshot({ path: 'test-results/project-history-' + theme + '.png' });
  }
  await checkSchematicComparison('light');
  const files = history.getByRole('navigation', { name: 'Changed files' });
  const versionsPanel = history.getByRole('navigation', { name: 'Project versions' });
  assert.deepEqual(
    await files.locator('button strong').allTextContents(),
    [...changedNames].sort((a, b) => a.localeCompare(b)),
  );
  const fileBounds = await files.boundingBox(),
    versionBounds = await versionsPanel.boundingBox();
  const composerBounds = await history.locator('.history-create').boundingBox();
  assert.ok(
    composerBounds.y + composerBounds.height <= fileBounds.y + 1,
    'Commit composer sits above the changed files.',
  );
  assert.ok(
    (await history.locator('.history-graph-node').count()) >= 2,
    'Local history renders a commit timeline.',
  );
  assert.ok(
    fileBounds.y + fileBounds.height <= versionBounds.y + 1,
    'Changed files appear above history.',
  );
  const fileRows = await files.getByRole('button').all();
  for (let index = 0; index < fileRows.length; index++) {
    const row = await fileRows[index].boundingBox();
    assert.ok(
      row.width > fileBounds.width - 20 && row.height <= 36,
      'Each file uses one compact full-width row.',
    );
    if (index) {
      const previous = await fileRows[index - 1].boundingBox();
      assert.ok(row.y >= previous.y + previous.height, 'Files stack vertically.');
    }
  }
  const worktreeRow = await versionsPanel
    .getByRole('button', { name: 'Worktree Current project' })
    .boundingBox();
  assert.ok(worktreeRow.width > versionBounds.width - 20, 'History entries use full-width rows.');
  assert.equal(
    await button('Restore details').count(),
    0,
    'Restore help and its control are removed.',
  );
  await files.getByRole('button', { name: 'Modified · rc.kicad_sch', exact: true }).click();
  const fileComparison = history.getByRole('region', { name: 'File comparison', exact: true });
  await fileComparison.waitFor();
  assert.equal(await fileComparison.locator('.history-file-pane').count(), 2);
  assert.ok((await fileComparison.locator('.history-line-number').count()) > 0);
  assert.ok(
    (await fileComparison.locator('.history-diff-line[data-change="removed"]').count()) > 0,
  );
  assert.ok((await fileComparison.locator('.history-diff-line[data-change="added"]').count()) > 0);
  assert.ok(
    (await fileComparison.getByRole('region', { name: 'Before file' }).innerText()).includes(
      '4.7k',
    ),
  );
  assert.ok(
    (await fileComparison.getByRole('region', { name: 'After file' }).innerText()).includes('1k'),
  );
  await page.screenshot({ path: 'test-results/project-history-files-light.png' });
  await button('Source comparison').click();
  assert.equal(
    await fileComparison.locator('.history-file-heading strong').innerText(),
    'rc.kicad_sch',
  );
  await button('Schematic comparison').click();
  const versionName = history.getByLabel('Commit message');
  await versionName.fill('Composition draft');
  await versionName.dispatchEvent('compositionstart');
  await versionName.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, keyCode: 229 });
  await page.keyboard.press('Escape');
  assert.equal(await history.isVisible(), true, 'IME Escape keeps the Git window open.');
  for (const key of ['Enter', 'Escape', 's'])
    await versionName.dispatchEvent('keydown', { key, keyCode: 229, ctrlKey: key === 's' });
  assert.equal(await page.evaluate(() => window.testHistory.creates.length), 0);
  assert.equal(await versionName.inputValue(), 'Composition draft');
  await versionName.dispatchEvent('compositionend');
  assert.equal(
    await versionName.evaluate((input) =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          keyCode: 229,
          bubbles: true,
          cancelable: true,
        }),
      ),
    ),
    false,
    'Key code 229 Escape is consumed even without a composition event.',
  );
  const versions = history.getByRole('navigation', { name: 'Project versions' });
  await versions.getByRole('button').filter({ hasText: 'Tune resistor' }).click();
  await versions
    .locator('button[aria-current="true"]')
    .filter({ hasText: 'Tune resistor' })
    .waitFor();
  await history.getByLabel(changedNames.length + ' changed files', { exact: true }).waitFor();
  await page.evaluate(() => (window.testHistory.unavailableVersion = 'b'.repeat(40)));
  await button('Restore version').click();
  await history
    .getByRole('alert')
    .filter({ hasText: 'The selected version is no longer reachable.' })
    .waitFor();
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  await page.evaluate(() => (window.testHistory.unavailableVersion = ''));
  await button('Restore version').click();
  await history.getByText('Version restored. Save to write it to disk.', { exact: true }).waitFor();
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 1);
  if (await history.isVisible()) await closeGit();
  await button('Source').click();
  await page
    .getByRole('navigation', { name: 'Project files', exact: true })
    .getByRole('button', { name: 'rc.kicad_sch', exact: true })
    .click();
  assert.equal(await readSource(page), nativeSchematic(changedSource));
  await button('Schematic').click();
  await button('Undo').click();
  if (await history.isVisible()) await closeGit();
  await button('Source').click();
  assert.equal(await readSource(page), nativeSchematic(source));
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  await fillSource(page, '(kicad_sch (unfinished');
  await button('Git').click();
  assert.equal(await button('Source').getAttribute('aria-pressed'), 'true');
  assert.equal(await history.isVisible(), false, 'Invalid Source blocks entering Git.');
  assert.equal(await readSource(page), '(kicad_sch (unfinished');
  await fillSource(page, nativeSchematic(source));
  if (await button('Apply').isEnabled()) await button('Apply').click();
  await button('Git').click();
  await history.getByLabel(changedNames.length + ' changed files', { exact: true }).waitFor();
  await versions.getByRole('button', { name: 'Worktree Current project' }).click();
  await versionName.fill('Documented baseline');
  await versionName.press('Control+Enter');
  await history.getByText('Version created.', { exact: true }).waitFor();
  await history.getByLabel('0 changed files', { exact: true }).waitFor();
  await button('Source comparison').click();
  await history.getByText('No file changes', { exact: true }).waitFor();
  await page.screenshot({ path: 'test-results/project-history-empty-light.png' });
  await button('Schematic comparison').click();
  assert.equal(await page.evaluate(() => window.testHistory.creates.length), 1);
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  await closeGit();
  await button('Settings').click();
  await page.getByRole('radio', { name: 'Dark', exact: true }).check();
  await button('Done').click();
  await button('Git').click();
  await button('Source comparison').click();
  await history.getByText('No file changes', { exact: true }).waitFor();
  await page.screenshot({ path: 'test-results/project-history-empty-dark.png' });
  await versions.getByRole('button').filter({ hasText: 'Tune resistor' }).click();
  await files.getByRole('button', { name: 'Modified · rc.kicad_sch', exact: true }).click();
  await fileComparison.waitFor();
  await page.screenshot({ path: 'test-results/project-history-files-dark.png' });
  await button('Schematic comparison').click();
  await checkSchematicComparison('dark');
  await comparison.getByRole('button', { name: 'Zoom in comparison', exact: true }).click();
  const retainedView = await drawings.nth(0).getAttribute('viewBox');
  await versionName.fill('Retained draft');
  if (await history.isVisible()) await closeGit();
  await button('Source').click();
  await button('Git').click();
  await history
    .getByRole('button', { name: 'Refresh version history' })
    .waitFor({ state: 'visible' });
  await page.waitForFunction(
    () => document.querySelector('.project-history-view').getAttribute('aria-busy') === 'false',
  );
  assert.equal(await versionName.inputValue(), 'Retained draft');
  assert.equal(await drawings.nth(0).getAttribute('viewBox'), retainedView);
  assert.equal(await versions.locator('[aria-current="true"] strong').innerText(), 'Tune resistor');
  await page.evaluate(() => {
    window.testHistory.fail = true;
  });
  await button('Refresh version history').click();
  await history.getByRole('alert').filter({ hasText: 'Install Git' }).waitFor();
  await page.evaluate(() => {
    window.testHistory.fail = false;
    window.testHistory.needsSave = true;
  });
  await button('Refresh version history').click();
  await history.getByText('Save to start version history.', { exact: true }).waitFor();
  await button('Save project').click();
  await history.getByText('Save to start version history.', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.testHistory.saveCancelled = false;
  });
  await button('Save project').click();
  await comparison.waitFor();
  await page.evaluate((source) => {
    window.testHistory.versions.unshift({
      id: 'd'.repeat(40),
      date: '2026-10-13T14:00:00+08:00',
      message: 'Auxiliary circuit',
      source,
    });
  }, multiSource);
  await button('Refresh version history').click();
  await versions.getByRole('button').filter({ hasText: 'Auxiliary circuit' }).click();
  await comparison.getByText('Added 1', { exact: true }).waitFor();
  await comparison.getByText('Removed 1', { exact: true }).waitFor();
  assert.equal(
    await comparison
      .getByRole('region', { name: 'After schematic', exact: true })
      .locator('[data-compare-id="' + replacedLabelId + '"]')
      .getAttribute('data-change'),
    'added',
  );
  assert.equal(
    await comparison.locator('.compare-object-highlight[data-change="added"]').count(),
    1,
  );
  assert.equal(
    await comparison.locator('.compare-object-highlight[data-change="removed"]').count(),
    1,
  );
  await comparison.getByRole('combobox', { name: 'Compare schematic file', exact: true }).click();
  await page.getByRole('option', { name: 'Auxiliary', exact: true }).click();
  await comparison
    .getByText('Schematic file not present in this version.', { exact: true })
    .waitFor();
  assert.equal(await comparison.locator('svg[role="img"]').count(), 1);
  assert.equal(
    await comparison.locator('[data-compare-part]').getAttribute('data-change'),
    'added',
  );
  await page.screenshot({ path: 'test-results/project-history-missing-sheet.png' });
  await comparison.getByRole('combobox', { name: 'Compare schematic file', exact: true }).click();
  await page.keyboard.press('Escape');
  assert.equal(
    await comparison.isVisible(),
    true,
    'Escape dismisses the file selector without leaving Git.',
  );
  await page.setViewportSize({ width: 1480, height: 920 });
  await page.screenshot({ path: 'test-results/project-history-wide.png' });
  assert.equal(await history.evaluate((el) => el.scrollWidth > el.clientWidth), false);
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  await closeGit();
  await fileMenuAction(page, 'Save as');
  await button('Git').click();
  await history.getByText('No versions yet.', { exact: true }).waitFor();
  assert.equal(await versions.locator('[aria-current="true"] strong').innerText(), 'Worktree');
  assert.equal(
    await history.getByLabel('Commit message').inputValue(),
    '',
    'Save as resets destination-bound history even when its filename is unchanged.',
  );
  await page.keyboard.press('Escape');
  assert.equal(await history.isVisible(), false, 'Escape closes Git.');
  assert.equal(
    await button('Git').evaluate((el) => el === document.activeElement),
    true,
    'Closing restores focus to Git.',
  );
  assert.equal(
    await button('Source').getAttribute('aria-pressed'),
    'true',
    'Git preserves the underlying Source mode.',
  );
  await button('Git').click();
  await history.getByRole('button', { name: 'Refresh version history' }).waitFor();
  await page.mouse.click(8, 8);
  assert.equal(await history.isVisible(), false, 'Backdrop click closes Git.');
  for (const view of ['Schematic', 'Layout', 'Model', 'Source']) {
    await button(view).click();
    await checkGitPlacement();
  }
  assert.deepEqual(errors, []);
  console.log(
    'PASS: top-right Git window, close/Escape/backdrop/focus, preserved editor mode, worktree/version selection, direct light/dark schematic comparisons, native changed-file list above history, paired native excerpts and empty states, synchronized camera, retained view/drafts, restore/undo, Source gate, IME, Save and retry.',
  );
} catch (error) {
  if (page) {
    await page.screenshot({ path: 'test-results/project-history-failure.png' });
    console.error(await page.locator('body').innerText(), errors);
  }
  throw error;
} finally {
  await browser.close();
}
