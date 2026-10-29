import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readSource, fillSource } from './source-editor-test-helpers.mjs';
import { checkInspectorResize, checkPanelResize } from './schematic-panel-test-helpers.mjs';
import {
  appendSchematic,
  parseProject,
  projectNativeFiles,
  serializeProject,
} from '../server/project-format.mjs';

// Isolated renderer regression: no Electron, Git, providers or native filesystem access.
await mkdir('test-results', { recursive: true });
const fixture = parseProject(await readFile('tests/fixtures/rc-filter.openpe.json', 'utf8'));
for (const footprint of fixture.pcb.footprints) {
  const part = fixture.schematic.parts.find((part) => part.id === footprint.symbolId);
  (part.fields ??= {}).Footprint = footprint.libraryId;
}
for (const net of fixture.pcb.nets) {
  if (net.name === '/IN' || net.name === '/OUT') net.name = net.name.slice(1);
}
const source = serializeProject(fixture);
const project = JSON.parse(source);
const changed = structuredClone(project);
changed.schematic.components[0].value = '4.7k';
changed.extensions.historyTest = { revision: 2 };
const changedSource = JSON.stringify(changed, null, 2);
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
const replacedLabelId = multiple.project.schematic.labels[0].id;
multiple.project.schematic.labels[0].id = randomUUID();
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
  models: {},
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
try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 760 } });
  const errors = [];
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
        releaseFile: async () => {},
        setDirty: async () => {},
        onCloseRequested: () => () => {},
        save: async () => {
          if (window.testHistory.saveCancelled) return null;
          window.testHistory.needsSave = false;
          return { name: 'rc.kicad_pro', path: 'fixture/rc.kicad_pro' };
        },
        historyList: async () => {
          if (window.testHistory.fail)
            throw new Error(
              'Git was not found. Install Git and restart OpenPE to use version history.',
            );
          if (window.testHistory.needsSave)
            return { version: '', commits: [], more: false, needsSave: true };
          return { version: 'git version fixture', commits: [...versions], more: false };
        },
        historyRead: async ({ id }) => versions.find((entry) => entry.id === id).source,
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
  await page.getByTestId('schematic-canvas').waitFor();
  const button = (name) => page.getByRole('button', { name, exact: true });
  await page.getByTestId('part-R1').click();
  await checkInspectorResize(page, page.getByRole('complementary', { name: 'Object properties' }));
  await page.getByTestId('schematic-canvas').press('Escape');
  for (const [name, width] of [
    ['Parts list', 720],
    ['Selection'],
    ['Visible layers'],
    ['Version history', 840],
  ])
    await checkPanelResize(page, name, width);
  await button('Source').click();
  await page
    .getByRole('navigation', { name: 'Project files', exact: true })
    .getByRole('button', { name: 'rc.kicad_sch', exact: true })
    .click();
  assert.equal(
    await readSource(page),
    nativeSchematic(source),
    'Panel resizing never edits the project',
  );
  await button('Schematic').click();
  const history = page.getByRole('dialog', { name: 'Version history', exact: true });
  await button('Version history').click();
  await history.getByText('2 changes', { exact: true }).waitFor();
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  await page.screenshot({ path: 'test-results/project-history-light.png' });
  const comparison = page.getByRole('dialog', { name: 'Compare schematics', exact: true });
  async function checkSchematicComparison(theme) {
    await history.getByRole('button', { name: 'Compare schematics', exact: true }).click();
    await comparison.waitFor();
    const panes = comparison.locator('.schematic-compare-pane');
    const drawings = panes.locator('svg[role="img"]');
    assert.equal(await drawings.count(), 2, 'Both revisions render actual schematic geometry.');
    await comparison.getByText('Changed 1', { exact: true }).waitFor();
    const id = project.schematic.components[0].id;
    for (let side = 0; side < 2; side++) {
      const part = panes.nth(side).locator(`[data-compare-id="${id}"]`);
      assert.equal(await part.getAttribute('data-change'), 'changed');
      assert.equal(await part.locator('.symbol-graphic').count(), 1);
      const highlight = panes.nth(side).locator('.compare-object-highlight');
      assert.equal(await highlight.count(), 1);
      assert.ok(
        await highlight.evaluate(
          (element) => element.width.baseVal.value > 3 && element.height.baseVal.value > 3,
        ),
        'Highlights enclose the drawn part and annotations.',
      );
      const colour = await highlight.evaluate((element) => getComputedStyle(element).stroke);
      assert.ok(
        colour !== 'none' && colour !== 'rgba(0, 0, 0, 0)',
        'Difference highlights have a visible colour.',
      );
    }
    assert.equal(
      await drawings.nth(0).getAttribute('viewBox'),
      await drawings.nth(1).getAttribute('viewBox'),
    );
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
    await page.screenshot({ path: `test-results/schematic-compare-${theme}.png` });
    await page.keyboard.press('Escape');
    await comparison.waitFor({ state: 'hidden' });
    assert.ok(await history.isVisible(), 'Closing comparison retains the history selection.');
    assert.equal(
      await history
        .getByRole('button', { name: 'Compare schematics', exact: true })
        .evaluate((el) => document.activeElement === el),
      true,
    );
  }
  await checkSchematicComparison('light');
  assert.equal(
    await page.locator('.project-navigation .dirty-dot').count(),
    0,
    'Comparison never edits the project.',
  );
  const footer = await history.locator('.dialog-footer').boundingBox();
  assert.ok(footer.y + footer.height <= 760, 'History footer remains in the viewport.');
  const panelBounds = await history.boundingBox();
  const viewport = page.viewportSize();
  assert.ok(
    Math.abs(panelBounds.width - 840) < 2,
    'History has room for versions and differences.',
  );
  assert.ok(
    Math.abs(panelBounds.x + panelBounds.width / 2 - viewport.width / 2) < 2,
    'History opens as an independent centered window.',
  );
  assert.ok(
    panelBounds.y >= 23 && panelBounds.y + panelBounds.height <= viewport.height - 23,
    'History keeps its content and footer within the viewport.',
  );
  assert.equal(await history.getAttribute('aria-modal'), 'true');
  assert.equal(
    await history.evaluate((el) => el.classList.contains('surface-dialog-anchored')),
    false,
  );
  const versionsBounds = await history.locator('.history-entries').boundingBox();
  const differencesBounds = await history.locator('.history-comparison').boundingBox();
  assert.ok(
    versionsBounds.x + versionsBounds.width <= differencesBounds.x &&
      Math.abs(versionsBounds.y - differencesBounds.y) < 2,
    'Versions and differences occupy separate columns.',
  );
  await history.getByLabel('Version name').fill('Composition draft');
  await history.getByLabel('Version name').dispatchEvent('compositionstart');
  await history
    .getByLabel('Version name')
    .dispatchEvent('keydown', { key: 'Escape', keyCode: 229 });
  assert.ok(await history.isVisible(), 'Composing Escape does not dismiss version history.');
  await history.getByLabel('Version name').dispatchEvent('compositionend');
  for (const [name, hint] of [
    ['Create version', 'Create version'],
    ['Refresh version history', 'Refresh history'],
    ['Restore version', 'Restore version'],
    ['Restore details', 'Restore details'],
  ]) {
    assert.equal(
      (await button(name).innerText()).trim(),
      '',
      `${name} uses an icon with an accessible name.`,
    );
    assert.equal(await button(name).getAttribute('aria-label'), name);
    assert.equal(await button(name).getAttribute('title'), hint);
  }
  assert.equal(await history.evaluate((el) => el.scrollWidth > el.clientWidth), false);
  await button('Restore version').click();
  await history.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 1);
  await button('Source').click();
  await page
    .getByRole('navigation', { name: 'Project files', exact: true })
    .getByRole('button', { name: 'rc.kicad_sch', exact: true })
    .click();
  assert.equal(await readSource(page), nativeSchematic(changedSource));
  await button('Schematic').click();
  await button('Undo').click();
  await button('Source').click();
  assert.equal(await readSource(page), nativeSchematic(source));
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  await fillSource(page, '{ invalid');
  await button('Version history').click();
  await history.getByText('2 changes', { exact: true }).waitFor();
  await history.getByLabel('Version name').fill('Blocked draft');
  assert.equal(await button('Create version').isDisabled(), true);
  assert.equal(await button('Restore version').isDisabled(), true);
  await button('Close dialog').click();
  assert.equal(await readSource(page), '{ invalid');
  await fillSource(page, nativeSchematic(source));
  if (await button('Apply').isEnabled()) await button('Apply').click();
  await button('Version history').click();
  await history.getByText('2 changes', { exact: true }).waitFor();
  await history.getByLabel('Version name').fill('Documented baseline');
  await button('Create version').click();
  await history.getByText('Version created.', { exact: true }).waitFor();
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  assert.equal(await page.evaluate(() => window.testHistory.creates.length), 1);
  await button('Close dialog').click();
  await button('Settings').click();
  await page.getByRole('radio', { name: 'Dark', exact: true }).check();
  await button('Done').click();
  await button('Version history').click();
  await history.getByText('0 changes', { exact: true }).waitFor();
  await history.locator('.history-entries > button').filter({ hasText: 'Tune resistor' }).click();
  await history
    .locator('.history-entries > button[aria-current="true"]')
    .filter({ hasText: 'Tune resistor' })
    .waitFor();
  await history.getByText('2 changes', { exact: true }).waitFor();
  await history.getByRole('combobox', { name: 'Compare version with' }).click();
  await page.getByRole('option').filter({ hasText: 'Initial design' }).click();
  await history.getByText('Tune resistor → Initial design', { exact: true }).waitFor();
  assert.equal(await button('Restore version').isEnabled(), true);
  await page.screenshot({ path: 'test-results/project-history-dark.png' });
  await checkSchematicComparison('dark');
  await button('Close dialog').click();
  assert.equal(
    await button('Version history').evaluate((el) => el === document.activeElement),
    true,
  );
  await page.evaluate(() => {
    window.testHistory.fail = true;
  });
  await button('Version history').click();
  await history.getByRole('alert').filter({ hasText: 'Install Git' }).waitFor();
  assert.equal(await button('Restore version').count(), 0);
  await button('Close dialog').click();
  await page.evaluate(() => {
    window.testHistory.fail = false;
    window.testHistory.needsSave = true;
  });
  await button('Version history').click();
  await history.getByText('Save to start version history.', { exact: true }).waitFor();
  const emptyBounds = await history.boundingBox();
  assert.ok(
    Math.abs(emptyBounds.width - 840) < 2 &&
      emptyBounds.y >= 23 &&
      emptyBounds.y + emptyBounds.height <= viewport.height - 23,
    'Unsaved projects retain the independent history window with a bounded empty state.',
  );
  assert.equal(await history.locator('.dialog-footer').count(), 0);
  assert.equal(await button('Create version').count(), 0);
  assert.equal((await button('Save project').innerText()).trim(), '');
  await page.screenshot({ path: 'test-results/project-history-empty-dark.png' });
  await button('Save project').click();
  await history.getByText('Save to start version history.', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.testHistory.saveCancelled = false;
  });
  await button('Save project').click();
  await history.getByRole('button', { name: 'Compare schematics', exact: true }).waitFor();
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  await page.keyboard.press('Escape');
  await history.waitFor({ state: 'hidden' });
  await button('Version history').click();
  await history.getByRole('button', { name: 'Compare schematics', exact: true }).waitFor();
  await page.mouse.click(100, 400);
  await history.waitFor({ state: 'hidden' });
  await page.evaluate((source) => {
    window.testHistory.versions.unshift({
      id: 'd'.repeat(40),
      date: '2026-10-13T14:00:00+08:00',
      message: 'Auxiliary circuit',
      source,
    });
  }, multiSource);
  await button('Version history').click();
  await history.getByRole('button', { name: 'Compare schematics', exact: true }).click();
  await comparison.getByText('Added 1', { exact: true }).waitFor();
  await comparison.getByText('Removed 1', { exact: true }).waitFor();
  assert.equal(
    await comparison
      .getByRole('region', { name: 'After schematic', exact: true })
      .locator(`[data-compare-id="${replacedLabelId}"]`)
      .getAttribute('data-change'),
    'added',
  );
  assert.equal(
    await comparison.locator('.compare-object-highlight[data-change="added"]').count(),
    1,
    'Added labels retain a visible contour beside unchanged green wiring.',
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
  await comparison.getByText('Removed 1', { exact: true }).waitFor();
  assert.equal(await comparison.locator('svg[role="img"]').count(), 1);
  assert.equal(
    await comparison.locator('[data-compare-part]').getAttribute('data-change'),
    'removed',
  );
  await comparison.getByRole('combobox', { name: 'Compare schematic file', exact: true }).click();
  await page.keyboard.press('Escape');
  assert.ok(await comparison.isVisible(), 'Escape dismisses the file menu before comparison.');
  await page.screenshot({ path: 'test-results/schematic-compare-missing-sheet.png' });
  await page.keyboard.press('Escape');
  await comparison.waitFor({ state: 'hidden' });
  await history.getByRole('button', { name: 'Close dialog', exact: true }).click();
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: split light/dark schematics, stable-ID highlights, synchronized pan/zoom, missing sheets, independent history/Parts windows, sidebar drawers, restore/undo, native Source protection, dismissal and focus.',
  );
} finally {
  await browser.close();
}
