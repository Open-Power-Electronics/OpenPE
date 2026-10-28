import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import {
  fillSource,
  readSource,
  readNativeProject,
  fillNativeProject,
} from './source-editor-test-helpers.mjs';
import { readOriginalExamples } from './original-example-test-helpers.mjs';

// Isolated renderer with an in-memory native bridge; never launches Electron.
const source = await readFile('tests/fixtures/rc-filter.openpe.json', 'utf8');
const manifest = JSON.parse(await readFile('resources/example-catalog/manifest.json', 'utf8'));
const firstExampleButton = `Open ${manifest.examples[0].title} example`;
const secondExampleButton = `Open ${manifest.examples[1].title} example`;
const defaults = await readOriginalExamples();
const firstOriginal = defaults.find((entry) => entry.key === `example:${manifest.examples[0].id}`);
const bundle = await build({
  stdin: {
    contents:
      "import React from 'react'; import {createRoot} from 'react-dom/client'; import Workspace from './components/DesktopWorkspace'; createRoot(document.getElementById('root')).render(<Workspace/>);",
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outdir: 'test-results/project-reopen-ui-bundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  let recovery = null;
  const page = await browser.newPage({ viewport: { width: 1250, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.addInitScript(
    ({ source, defaults }) => {
      window.grants = [];
      window.revealedFiles = [];
      window.savedFiles = [];
      window.saveCalls = [];
      window.cancelSave = true;
      window.exampleCalls = [];
      window.openResult = { source, name: 'rc.kicad_pro', native: true };
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
        newFile: async () => {
          const id = crypto.randomUUID();
          window.grants.push(id);
          await new Promise((resolve) => setTimeout(resolve, 50));
          return id;
        },
        openDefaultExample: async (key) => {
          const entry = defaults.find((entry) => entry.key === key);
          if (!entry) throw new Error('Unknown default example.');
          window.exampleCalls.push({ ...entry, exampleKey: key });
          const fileId = await window.openpe.newFile();
          window.savedFiles.push(fileId);
          return { ...entry, fileId };
        },
        releaseFile: async (id) => {
          window.grants = window.grants.filter((v) => v !== id);
        },
        revealFile: async (id) => {
          if (id !== 'native' && !window.savedFiles.includes(id)) return { status: 'needs-save' };
          window.revealedFiles.push(id);
          return { status: 'revealed' };
        },
        save: async (options) => {
          window.saveCalls.push(options);
          if (window.cancelSave) return null;
          window.savedFiles.push(options.fileId);
          return { name: 'saved.kicad_pro' };
        },
        open: async () => window.openResult,
        acceptOpen: async () => {
          window.grants.push('native');
          return 'native';
        },
        setDirty: async () => {},
        onCloseRequested: () => () => {},
      };
    },
    { source, defaults },
  );
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
  const button = (name) => page.getByRole('button', { name, exact: true });
  const projects = () => page.locator('.project-navigation [data-project-id]');
  const expectProjects = async (count) => {
    await page.waitForFunction(
      (count) =>
        document.querySelectorAll('.project-navigation [data-project-id]').length === count,
      count,
    );
  };
  await button(firstExampleButton).evaluate((el) => {
    el.click();
    el.click();
  });
  await page.getByTestId('schematic-canvas').waitFor();
  await expectProjects(1);
  assert.equal(
    await page.evaluate(() => window.grants.length),
    1,
    'Concurrent opens share one local example.',
  );
  assert.equal(
    await page.evaluate(() => window.exampleCalls.length),
    1,
    'Repeated activation does not allocate another example grant.',
  );
  const firstId = await projects().first().getAttribute('data-project-id');
  await page.getByLabel('Message your agent', { exact: true }).fill('Keep this conversation draft');
  await button('Source').click();
  const changed = await readNativeProject(page);
  changed.schematic.title = 'Renamed Reference schematic';
  await fillNativeProject(page, changed);
  await button('Apply').click();
  await fillSource(page, '{unfinished source');
  await button('Home').click();
  await projects().first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Show in File Explorer', exact: true }).click();
  await page.waitForFunction(() => window.revealedFiles.length === 1);
  assert.equal(
    await page.evaluate(() => window.saveCalls.length),
    0,
    'Examples reveal their local directory without a save dialog, even with pending Source.',
  );
  await page.evaluate(() => {
    window.revealedFiles = [];
  });
  assert.equal(
    await page.locator('.workspace[hidden]').isVisible(),
    false,
    'The retained editor must not participate in the Home layout.',
  );
  await button(firstExampleButton).click();
  await page.getByRole('textbox', { name: 'Project file source', exact: true }).waitFor();
  assert.equal(await readSource(page), '{unfinished source');
  assert.equal(await projects().first().getAttribute('data-project-id'), firstId);
  assert.equal(
    await page.getByLabel('Message your agent', { exact: true }).inputValue(),
    'Keep this conversation draft',
  );
  await expectProjects(1);
  await button('Home').click();
  await button(secondExampleButton).click();
  await expectProjects(2);
  await button('Home').click();
  await button(firstExampleButton).click();
  assert.equal(
    await readSource(page),
    '{unfinished source',
    'Reopening from another project retains pending Source.',
  );
  await fillNativeProject(page, changed);
  await button('Apply').click();
  await projects().first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Reference review');
  await button('Rename').click();
  await expectProjects(2);
  await button('Home').click();
  await button(firstExampleButton).click();
  await expectProjects(2);
  assert.equal((await readNativeProject(page)).schematic.title, 'Renamed Reference schematic');
  await button('Open project').click();
  await expectProjects(3);
  await button('Source').click();
  await fillSource(page, '{native draft');
  await button('Home').click();
  await page
    .locator('.project-navigation:visible [data-project-id]')
    .last()
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Show in File Explorer', exact: true }).click();
  await page.waitForFunction(() => window.revealedFiles.length === 1);
  assert.deepEqual(await page.evaluate(() => window.revealedFiles), ['native']);
  assert.equal(
    await page.getByRole('textbox', { name: 'Project file source', exact: true }).isVisible(),
    false,
  );
  await page.evaluate(() => {
    window.openResult = { fileId: 'native' };
  });
  await button('Open project').click();
  assert.equal(await readSource(page), '{native draft');
  await page
    .locator('.project-navigation:visible [data-project-id]')
    .last()
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Show in File Explorer', exact: true }).click();
  await page.waitForFunction(() => window.revealedFiles.length === 2);
  assert.equal(
    await readSource(page),
    '{native draft',
    'Revealing preserves invalid pending Source.',
  );
  await expectProjects(3);
  await button('New project').click();
  await expectProjects(4);
  const revealLastProject = async () => {
    await page
      .locator('.project-navigation:visible [data-project-id]')
      .last()
      .click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Show in File Explorer', exact: true }).click();
  };
  await revealLastProject();
  await page.waitForFunction(() => window.saveCalls.length === 1);
  assert.equal(
    await page.evaluate(() => window.revealedFiles.length),
    2,
    'Cancel does not reveal a file.',
  );
  await page.evaluate(() => {
    window.cancelSave = false;
  });
  await revealLastProject();
  await page.waitForFunction(() => window.revealedFiles.length === 3);
  assert.equal(await page.evaluate(() => window.saveCalls.length), 2);
  assert.equal(
    await page.evaluate(() => window.revealedFiles[2] === window.saveCalls[1].fileId),
    true,
  );
  await revealLastProject();
  await page.waitForFunction(() => window.revealedFiles.length === 4);
  assert.equal(
    await page.evaluate(() => window.saveCalls.length),
    2,
    'Saved projects reveal without saving again.',
  );
  await button('New project').click();
  await expectProjects(5);
  for (let count = 6; count <= 12; count++) {
    await button('New project').click();
    await expectProjects(count);
  }
  await button('Home').click();
  await button(firstExampleButton).click();
  assert.equal((await readNativeProject(page)).schematic.title, 'Renamed Reference schematic');
  await expectProjects(12);
  await projects().first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Close project', exact: true }).click();
  await button("Don't save").click();
  await expectProjects(11);
  await button('Home').click();
  await button(firstExampleButton).click();
  await expectProjects(12);
  assert.equal(
    await projects().last().getAttribute('data-project-id'),
    firstId,
    'Reopening uses the default example folder identity.',
  );
  // Current clean recovery reconnects the original native example destination.
  await page.waitForResponse(
    (response) => response.url().endsWith('/api/state') && response.request().method() === 'POST',
  );
  const retained = recovery.documents.at(-1);
  recovery = { ...recovery, documents: [retained], activeDocumentId: retained.id };
  await page.reload();
  for (const path of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(path, 'utf8') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.getByTestId('schematic-canvas').waitFor();
  assert.equal(await page.evaluate(() => window.exampleCalls[0].exampleKey), firstOriginal.key);
  assert.equal(await page.evaluate(() => window.exampleCalls[0].id), retained.id);
  // Keep a non-default canvas scale and compare every painted return frame.
  await button('Zoom in').click();
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 150)));
  const canvasBefore = await page.getByTestId('schematic-canvas').getAttribute('viewBox');
  await button('Home').click();
  await page.evaluate(() => {
    window.returnFrames = [];
    window.captureReturn = true;
    const frame = () => {
      const canvas = document.querySelector('[data-testid="schematic-canvas"]');
      const bounds = canvas?.getBoundingClientRect();
      if (bounds?.width && bounds.height)
        window.returnFrames.push({
          viewBox: canvas.getAttribute('viewBox'),
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          scrollY: window.scrollY,
        });
      if (window.captureReturn) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  await button(firstExampleButton).click();
  await page.getByTestId('schematic-canvas').waitFor();
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
  const frames = await page.evaluate(() => {
    window.captureReturn = false;
    return window.returnFrames;
  });
  await expectProjects(1);
  assert.equal(await projects().first().getAttribute('data-project-id'), retained.id);
  assert.ok(frames.length > 3);
  // Resize compensation can differ by a floating-point ULP; compare geometry
  // within 1e-9 mm while still checking every painted frame for a real jump.
  const expectedBox = canvasBefore.split(' ').map(Number);
  assert.ok(
    frames.every((frame) =>
      frame.viewBox
        .split(' ')
        .map(Number)
        .every((value, index) => Math.abs(value - expectedBox[index]) < 1e-9),
    ),
    'Reopen preserves zoom in every painted frame.',
  );
  assert.equal(
    new Set(frames.map(({ viewBox, ...bounds }) => JSON.stringify(bounds))).size,
    1,
    'Canvas bounds and page scroll stay stable on return.',
  );
  await page.evaluate(() => {
    window.cancelSave = false;
  });
  await projects().first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Save as', exact: true }).click();
  await page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/state') &&
      response.request().method() === 'POST' &&
      response.request().postDataJSON().documents[0].localExample === false,
  );
  await page.reload();
  for (const path of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(path, 'utf8') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.getByTestId('schematic-canvas').waitFor();
  assert.equal(
    await page.evaluate(() => window.exampleCalls.length),
    0,
    'Save as recovery does not reconnect the original example folder.',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Project reopen: examples, concurrent opens, native files, Source and conversation preservation, renaming and new projects passed.',
  );
} finally {
  await browser.close();
}
