import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { parseProject, serializeProject } from '../server/project-format.mjs';
import { bundledWorkbenchCatalog } from '../server/workbench-plugins.mjs';
import { waitForAsync } from './async-browser-test-helpers.mjs';

// Real workspace and analysis docks with isolated services; no Electron,
// user files, providers, native grants or solver execution.
const project = parseProject(await readFile('tests/fixtures/rc-filter.openpe.json', 'utf8'));
for (const footprint of project.pcb.footprints) {
  const part = project.schematic.parts.find((part) => part.id === footprint.symbolId);
  (part.fields ??= {}).Footprint = footprint.libraryId;
}
const source = serializeProject(project);
const { defaultAgentPreferences, restoreWorkspace } = await tsImport(
  '../lib/workspace-state.ts',
  import.meta.url,
);
let state = {
  version: 2,
  documents: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      source,
      sourceDraft: null,
      dirty: false,
      filename: 'sidebar-resize.kicad_pro',
      sessions: [{ id: 'sidebar-resize-session', messages: [], draft: '' }],
      activeSessionId: 'sidebar-resize-session',
    },
  ],
  activeDocumentId: '00000000-0000-4000-8000-000000000001',
  ...defaultAgentPreferences,
};
state = restoreWorkspace(state);
const bundle = await build({
  stdin: {
    contents:
      "import React from 'react';import {createRoot} from 'react-dom/client';import Workspace from './components/DesktopWorkspace';createRoot(document.getElementById('root')).render(<Workspace/>);",
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outdir: 'test-results/analysis-sidebar-resize/bundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [
    {
      name: 'observe-sidebar-resize-core',
      setup(plugin) {
        plugin.onLoad({ filter: /[\\/]components[\\/]Workbench\.tsx$/ }, async ({ path: file }) => {
          const contents = await readFile(file, 'utf8');
          const marker = 'const { project, sourceDraft, sourceError } = coreSnapshot;';
          assert.ok(contents.includes(marker), 'Observe the real Workbench Core.');
          return {
            contents: contents.replace(marker, marker + '\nwindow.sidebarResizeCore = core;'),
            resolveDir: path.dirname(file),
            loader: 'tsx',
          };
        });
      },
    },
  ],
});
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  const executionRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.openpe = {
      titleBarOverlay: false,
      connection: async () => ({ base: 'http://localhost', token: 'fixture' }),
      newFile: async () => crypto.randomUUID(),
      releaseFile: async () => {},
      projectDirectory: async () => ({ entries: [], truncated: false }),
      setDirty: async () => {},
      onCloseRequested: () => () => {},
      writeWorkspaceRecovery: async (content) => {
        await fetch('http://localhost/api/state', {
          method: content === null ? 'DELETE' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: content ?? undefined,
        });
      },
    };
  });
  await page.route('http://localhost/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/state') {
      if (route.request().method() === 'POST') state = route.request().postDataJSON();
      return route.fulfill({ json: state });
    }
    if (pathname === '/api/appearance') return route.fulfill({ json: null });
    if (pathname === '/api/workbench-plugins')
      return route.fulfill({ json: bundledWorkbenchCatalog() });
    if (pathname === '/api/agents') return route.fulfill({ json: [] });
    if (pathname === '/api/models')
      return route.fulfill({ json: { models: [], defaultModel: '' } });
    if (pathname === '/api/plugins')
      return route.fulfill({
        json: {
          controlsVersion: 1,
          plugins: [],
          actions: [],
          browse: true,
          warning: '',
          updatedAt: Date.now(),
        },
      });
    if (pathname === '/api/simulation/status')
      return route.fulfill({ json: { available: true, version: 'isolated fixture' } });
    if (pathname === '/api/thermal/status')
      return route.fulfill({
        json: { available: true, gmsh: 'isolated fixture', elmer: 'isolated fixture' },
      });
    if (['/api/simulation/result', '/api/thermal/result'].includes(pathname))
      return route.fulfill({ json: { result: null } });
    if (['/api/simulation/transient', '/api/thermal/run'].includes(pathname)) {
      executionRequests.push(pathname);
      return route.fulfill({
        status: 500,
        json: { error: 'This resize check must not run solvers.' },
      });
    }
    if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(pathname))
      return route.fulfill({
        contentType: pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        body: await readFile('public' + pathname),
      });
    return route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><div id="root"></div>',
    });
  });
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  for (const output of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
    await page.addStyleTag({ content: output.text });
  await page.addScriptTag({
    content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
  });
  await page.getByTestId('schematic-canvas').waitFor();
  const button = (name) => page.getByRole('button', { name, exact: true });
  const snapshot = () =>
    page.evaluate(() => {
      const core = window.sidebarResizeCore;
      const { source, sourceDraft, undoDepth, redoDepth } = core.getSnapshot();
      return { source, sourceDraft, undoDepth, redoDepth, native: core.getNativeFiles() };
    });
  const baseline = await snapshot();
  const frame = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  async function assertGutter(panel, handleName, name) {
    await panel.waitFor();
    const split = panel.locator('..');
    const handle = split.getByRole('button', { name: handleName, exact: true });
    const drawing = split.locator(':scope > .editor-drawing-region');
    await frame();
    const [panelBox, drawingBox, handleBox] = await Promise.all([
      panel.boundingBox(),
      drawing.boundingBox(),
      handle.boundingBox(),
    ]);
    const near = (actual, expected, message) =>
      assert.ok(
        Math.abs(actual - expected) < 1.5,
        `${name}: ${message} (${actual} vs ${expected}).`,
      );
    near(
      panelBox.x - drawingBox.x - drawingBox.width,
      12,
      'The drawing and dock retain a 12px gap',
    );
    near(handleBox.width, 12, 'The resize target fills the gap');
    near(
      handleBox.x,
      drawingBox.x + drawingBox.width,
      'The resize target starts after the drawing',
    );
    near(handleBox.x + handleBox.width, panelBox.x, 'The resize target ends before the dock');
    near(handleBox.y, panelBox.y, 'The resize target aligns with the dock top');
    near(handleBox.height, panelBox.height, 'The resize target spans the dock height');
    const grip = await handle.evaluate((element) => {
      const style = getComputedStyle(element);
      const mark = getComputedStyle(element, '::after');
      return {
        cursor: style.cursor,
        x: parseFloat(mark.left) + parseFloat(mark.width) / 2,
        y: parseFloat(mark.top) + parseFloat(mark.height) / 2,
      };
    });
    assert.ok(
      grip.cursor.includes('/cursors/resize-horizontal.svg'),
      `${name} uses the compact custom horizontal resize cursor.`,
    );
    assert.match(grip.cursor, /12 12,\s*col-resize$/, `${name} keeps the cursor hotspot centered.`);
    near(grip.x, handleBox.width / 2, 'The visible grip is centered horizontally in the gap');
    near(grip.y, handleBox.height / 2, 'The visible grip is centered vertically');
    return handle;
  }
  async function exercise({
    selector,
    canvasId,
    ordinary,
    handleName,
    openName,
    closeName,
    minimum,
    ordinaryHandleName,
  }) {
    await ordinary.waitFor();
    await assertGutter(ordinary, ordinaryHandleName, 'Ordinary sidebar');
    const initial = (await ordinary.boundingBox()).width;
    await button(openName).click();
    const panel = page.locator(selector);
    await panel.waitFor();
    const handle = await assertGutter(panel, handleName, openName);
    const canvas = page.getByTestId(canvasId);
    await frame();
    const scale = await canvas.evaluate((svg) => {
      const { a, b, c, d } = svg.getScreenCTM();
      return [a, b, c, d];
    });
    const expectWidth = async (width) => {
      await waitForAsync(
        page,
        ({ selector, canvasId, width, scale }) => {
          const panel = document.querySelector(selector);
          const svg = document.querySelector(`[data-testid="${canvasId}"]`);
          if (!panel || !svg) return false;
          const { a, b, c, d } = svg.getScreenCTM();
          return (
            Math.abs(panel.getBoundingClientRect().width - width) < 1.5 &&
            [a, b, c, d].every((value, i) => Math.abs(value - scale[i]) < 0.001)
          );
        },
        { selector, canvasId, width, scale },
        { timeout: 15000 },
      );
    };
    const drag = async (dx, release = true) => {
      const box = await handle.boundingBox();
      const x = box.x + box.width / 2;
      const y = box.y + Math.min(80, box.height / 2);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx, y, { steps: 6 });
      if (release) await page.mouse.up();
      await frame();
    };
    await expectWidth(initial);
    await drag(-48);
    await expectWidth(initial + 48);
    await handle.press('ArrowLeft');
    await expectWidth(initial + 64);
    await handle.press('ArrowRight');
    await expectWidth(initial + 48);
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      await handle.evaluate((element, composition) => {
        element.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, ...composition }),
        );
      }, composition);
      await frame();
      await expectWidth(initial + 48);
    }
    await drag(-40, false);
    await expectWidth(initial + 88);
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true }));
    });
    await frame();
    await expectWidth(initial + 88);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await expectWidth(initial + 48);
    await button(closeName).click();
    await ordinary.waitFor();
    await assertGutter(ordinary, ordinaryHandleName, 'Restored ordinary sidebar');
    assert.ok(Math.abs((await ordinary.boundingBox()).width - initial - 48) < 1.5);
    await button(openName).click();
    await expectWidth(initial + 48);
    const maximum = await panel.evaluate((element) =>
      Math.min(480, element.parentElement.clientWidth - 172),
    );
    await drag(-1000);
    await expectWidth(maximum);
    assert.ok((await canvas.boundingBox()).width >= 159, `${openName} retains drawing space.`);
    await drag(1000);
    await expectWidth(Math.min(minimum, maximum));
    await handle.dblclick();
    await expectWidth(initial);
    await handle.press('ArrowLeft');
    await handle.press('Home');
    await expectWidth(initial);
    await button(closeName).click();
    await ordinary.waitFor();
  }
  await exercise({
    selector: '.simulation-settings-host:not([hidden])',
    canvasId: 'schematic-canvas',
    ordinary: page.getByTestId('schematic-properties-panel'),
    handleName: 'Resize simulation settings width',
    openName: 'SPICE Simulation',
    closeName: 'Close simulation settings',
    minimum: 280,
    ordinaryHandleName: 'Resize properties width',
  });
  await button('Layout').click();
  await page.getByTestId('layout-canvas').waitFor();
  await exercise({
    selector: '.layout-analysis-dock:not([hidden])',
    canvasId: 'layout-canvas',
    ordinary: page.getByRole('complementary', { name: 'Layout sidebar', exact: true }),
    handleName: 'Resize layout sidebar width',
    openName: 'Thermal FEM',
    closeName: 'Close Thermal',
    minimum: 224,
    ordinaryHandleName: 'Resize layout sidebar width',
  });
  await button('Model').click();
  const modelSidebar = page.getByRole('complementary', { name: 'Model sidebar', exact: true });
  const modelHandle = await assertGutter(modelSidebar, 'Resize model properties width', 'Model');
  const modelWidth = (await modelSidebar.boundingBox()).width;
  await modelHandle.press('ArrowLeft');
  await frame();
  assert.ok(Math.abs((await modelSidebar.boundingBox()).width - modelWidth - 16) < 1.5);
  await assertGutter(modelSidebar, 'Resize model properties width', 'Resized Model');
  await modelHandle.press('Home');
  await button('Toggle right sidebar').click();
  assert.equal(await modelSidebar.isVisible(), false, 'Hiding Model removes its dock.');
  assert.equal(await modelHandle.isVisible(), false, 'Hiding Model removes the gap and grip.');
  await button('Toggle right sidebar').click();
  await assertGutter(modelSidebar, 'Resize model properties width', 'Reopened Model');
  assert.deepEqual(
    await snapshot(),
    baseline,
    'Resizing never changes native files or Core history.',
  );
  assert.deepEqual(executionRequests, [], 'Resizing and reopening never execute a solver.');
  assert.deepEqual(errors, [], 'The analysis docks remain free of renderer errors.');
  console.log(
    'Sidebar resize passed: centered 12px gutters and compact custom cursors in Schematic/Layout/Model/SPICE/Thermal; analysis pointer and keyboard resize, IME guards, Escape rollback, retained widths, bounds/reset, camera scale and native cleanliness.',
  );
} finally {
  await browser.close();
}
