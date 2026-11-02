import { runCanvasAction, exportCanvasImage } from './canvas-context-menu-test-helpers.mjs';
import {
  readModelVisibility,
  toggleModelVisibility,
  selectModelView,
  toggleLayoutVisualization,
  selectLayoutLayer,
} from './visualization-test-helpers.mjs';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseSExpr } from '../lib/sexpr.ts';
import {
  fillSource,
  readSource,
  readNativeProject,
  selectSourceFile,
} from './source-editor-test-helpers.mjs';
import { tsImport } from 'tsx/esm/api';
import { BoxGeometry } from 'three';
const { parseProject, serializeProject, projectFromNativeFiles, projectNativeFiles } =
  await tsImport('../lib/project.ts', import.meta.url);
const { partFields } = await tsImport('../lib/library.ts', import.meta.url);
const { footprintModels } = await tsImport('../lib/pcb-models.ts', import.meta.url);

// Isolated full workspace: no Electron, provider, solver or native file access.
const fixture = parseProject(await readFile('tests/fixtures/rc-filter.openpe.json', 'utf8'));
// This manual-edit regression starts with the shared, schematic-derived names.
fixture.pcb.nets.forEach((net) => {
  if (net.name === '/IN' || net.name === '/OUT') net.name = net.name.slice(1);
});
const source = serializeProject(fixture);
let original;
const withoutPCB = parseProject(source);
withoutPCB.pcb = null;
const footprintId = 'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical';
const footprint = parseSExpr(
  await readFile(
    'resources/kicad/10.0.0/footprints/Connector_PinHeader_2.54mm.pretty/PinHeader_1x02_P2.54mm_Vertical.kicad_mod',
    'utf8',
  ),
);
const footprintEntry = {
  id: footprintId,
  name: 'PinHeader_1x02_P2.54mm_Vertical',
  library: 'Connector_PinHeader_2.54mm',
  description: 'Official two-pin header',
  keywords: '',
};
// The lifecycle fixture uses embedded two-pad packages. Its mocked official
// details must use their actual anchors so model fallback can verify alignment.
const footprintDetail = (id) => {
  const embedded = fixture.pcb.footprints.find((f) => f.libraryId === id);
  if (!embedded) return footprint;
  return [
    ...footprint.filter((node) => !Array.isArray(node) || node[0] !== 'pad'),
    ...embedded.pads.map((pad) => [
      'pad',
      JSON.stringify(pad.number),
      pad.type,
      pad.shape,
      ['at', String(pad.x), String(pad.y)],
    ]),
  ];
};
let saved = source;
let modelRequests = 0;
const images = [];
const geometry = new BoxGeometry(3, 2, 1);
const model = {
  meshes: [
    {
      color: [0.3, 0.3, 0.3],
      attributes: {
        position: { array: Array.from(geometry.attributes.position.array) },
        normal: { array: Array.from(geometry.attributes.normal.array) },
      },
      index: { array: Array.from(geometry.index.array) },
    },
  ],
};
geometry.dispose();
let state = {
  version: 2,
  documents: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      source,
      sourceDraft: null,
      dirty: false,
      filename: 'layout.kicad_pro',
      sessions: [{ id: 'layout-session', messages: [], draft: '' }],
      activeSessionId: 'layout-session',
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      source: serializeProject(withoutPCB),
      sourceDraft: null,
      dirty: false,
      filename: 'boardless.kicad_pro',
      sessions: [{ id: 'boardless-session', messages: [], draft: '' }],
      activeSessionId: 'boardless-session',
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
  plugins: [
    {
      name: 'isolated-home-data',
      setup(plugin) {
        // This workspace test does not exercise the generated Home catalog.
        plugin.onResolve(
          { filter: /(?:reference-examples\.json|pebench\/manifest\.json)$/ },
          (args) => ({ path: args.path, namespace: 'home-fixture' }),
        );
        plugin.onLoad({ filter: /.*/, namespace: 'home-fixture' }, (args) => ({
          contents: JSON.stringify(args.path.includes('manifest') ? { examples: [] } : {}),
          loader: 'json',
        }));
      },
    },
  ],
  write: false,
  outdir: 'test-results/layout-ui-bundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1460, height: 900 } });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.exposeFunction('writeLayoutSave', (value) => {
    saved = value;
  });
  await page.exposeFunction('writeLayoutImage', (value) => {
    images.push(value);
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
      setDirty: async () => {},
      onCloseRequested: () => () => {},
      save: async ({ source, name }) => {
        await window.writeLayoutSave(source);
        return { name };
      },
      exportImage: async (image) => {
        await window.writeLayoutImage(image);
        return { name: 'layout.png' };
      },
      historyList: async () => ({ version: '', commits: [], more: false, needsSave: true }),
    };
  });
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
    if (url.pathname === '/api/library-model') {
      modelRequests++;
      return route.fulfill({ json: model });
    }
    if (url.pathname === '/api/libraries/footprints')
      return route.fulfill({
        json: url.searchParams.has('id')
          ? {
              ...footprintEntry,
              footprint: footprintDetail(url.searchParams.get('id')),
              pads: ['1', '2'],
              models: footprintModels(footprintDetail(url.searchParams.get('id'))),
            }
          : { entries: [footprintEntry], libraries: ['Connector_PinHeader_2.54mm'], total: 1 },
      });
    if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(url.pathname))
      return route.fulfill({
        contentType: url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        body: await readFile('public' + url.pathname),
      });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  for (const path of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(path, 'utf8') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const button = (name) => page.getByRole('button', { name, exact: true });
  await page.getByTestId('schematic-canvas').waitFor();
  await button('Layout').click();
  const canvas = page.getByTestId('layout-canvas');
  await canvas.waitFor();
  const assertScale = async () => {
    const scale = await canvas.evaluate((el) => {
      const m = el.getScreenCTM();
      return { x: Math.hypot(m.a, m.b), y: Math.hypot(m.c, m.d) };
    });
    assert.ok(Math.abs(scale.x - scale.y) < 1e-6, 'PCB uses equal X/Y millimetre scale.');
    return scale.x;
  };
  await button('Actual size (100%)').click();
  assert.ok(Math.abs((await assertScale()) - 96 / 25.4) < 1e-4);
  await page.setViewportSize({ width: 1280, height: 750 });
  await page.waitForTimeout(100);
  assert.ok(Math.abs((await assertScale()) - 96 / 25.4) < 1e-4, 'Resizing preserves mm scale.');
  await page.setViewportSize({ width: 1460, height: 900 });
  await page.waitForTimeout(100);
  await assertScale();
  await button('Fit board to canvas').click();
  const fittedBoard = await canvas.getAttribute('viewBox');
  assert.equal(
    await canvas.locator('[data-airwire]').count(),
    0,
    'Routed pads do not retain topology-guide airwires.',
  );
  await exportCanvasImage(page);
  await page.waitForFunction(() =>
    document.querySelector('.layout-status')?.textContent.includes('Exported'),
  );
  assert.equal(images[0].width, 600);
  assert.equal(images[0].height, 400);
  assert.match(images[0].dataUrl, /^data:image\/png;base64,/);
  assert.equal(
    await canvas.getAttribute('viewBox'),
    fittedBoard,
    'Image export leaves the interactive camera unchanged.',
  );
  await writeFile(
    'test-results/layout-export.png',
    Buffer.from(images[0].dataUrl.split(',')[1], 'base64'),
  );
  await toggleLayoutVisualization(page, 'Net visibility');
  await page.getByRole('checkbox', { name: 'Show airwires for OUT', exact: true }).uncheck();
  await button('Highlight OUT').click();
  assert.ok((await canvas.locator('[data-net-id][opacity="0.2"]').count()) > 0);
  await button('Clear net highlight').click();
  await page.getByRole('checkbox', { name: 'Show airwires for OUT', exact: true }).check();
  await page.getByRole('textbox', { name: 'Search nets' }).press('Escape');
  assert.equal(
    await page.locator('section.layout-appearance[aria-label="Appearance"]').isVisible(),
    true,
    'The Appearance dock remains available after leaving net search.',
  );
  await toggleLayoutVisualization(page, 'Visible layers');
  const layerPanel = page.getByRole('group', { name: 'Visible layers', exact: true });
  await layerPanel.getByRole('checkbox', { name: 'B.Cu', exact: true }).uncheck();
  const backSilkC1 = canvas.locator('text[data-pcb-layer="B.SilkS"]').filter({ hasText: /^C1$/ });
  assert.ok((await backSilkC1.count()) > 0, 'Copper visibility does not hide silkscreen.');
  await layerPanel.getByRole('checkbox', { name: 'B.SilkS', exact: true }).uncheck();
  assert.equal(await backSilkC1.count(), 0);
  await layerPanel.getByRole('checkbox', { name: 'B.Cu', exact: true }).check();
  await layerPanel.getByRole('checkbox', { name: 'B.SilkS', exact: true }).check();
  await toggleLayoutVisualization(page, 'Visible layers');
  await toggleLayoutVisualization(page, 'Selection');
  await page.getByRole('checkbox', { name: 'Pads' }).check();
  await toggleLayoutVisualization(page, 'Selection');
  await canvas.locator('[data-pad-id]').first().click();
  assert.match(
    await page.getByRole('complementary', { name: 'Layout properties' }).innerText(),
    /Pad number\s+1/,
  );
  await canvas.press('Delete');
  await canvas.press('r');
  await toggleLayoutVisualization(page, 'Selection');
  await page.getByRole('checkbox', { name: 'Pads' }).uncheck();
  await toggleLayoutVisualization(page, 'Selection');
  assert.equal(
    await page.getByRole('complementary', { name: 'Layout properties' }).count(),
    0,
    'Disabling pad inspection clears its inspector.',
  );
  await button('Fit board to canvas').click();
  await canvas.press('Space');
  await button('Fit board to canvas').click();
  assert.equal(modelRequests, 0, 'Models remain deferred before opening 3D.');
  await button('Model').click();
  await page.waitForFunction(
    () =>
      document.querySelector('.pcb-model-canvas canvas')?.width > 0 &&
      !document.querySelector('.pcb-model-preview [role="status"]'),
  );
  assert.ok(modelRequests > 0);
  assert.equal(
    await readModelVisibility(page, 'Show silkscreen'),
    true,
    'Silkscreen is visible on first Model entry.',
  );
  assert.equal(await button('Enhanced rendering').count(), 0);
  await selectModelView(page, 'Top view');
  await selectModelView(page, 'Bottom view');
  await runCanvasAction(page, 'Fit 3D board');
  await page.waitForFunction(
    () => document.querySelector('.pcb-model-canvas')?.dataset.modelsVisible === 'true',
  );
  assert.ok(
    Number(await page.locator('.pcb-model-canvas').getAttribute('data-model-instances')) > 0,
    'Loaded models or estimates remain visible.',
  );
  await page.waitForTimeout(150);
  const idleRenderCount = await page.locator('.pcb-model-canvas').getAttribute('data-render-count');
  await page.waitForTimeout(150);
  assert.equal(
    await page.locator('.pcb-model-canvas').getAttribute('data-render-count'),
    idleRenderCount,
    'An idle 3D view does not continuously render.',
  );
  await selectModelView(page, 'Bottom view');
  const boardCanvas = page.locator('.pcb-model-canvas canvas');
  const visibleSilk = await boardCanvas.screenshot();
  const visibleSilkRenderCount = await page
    .locator('.pcb-model-canvas')
    .getAttribute('data-render-count');
  await toggleModelVisibility(page, 'Show silkscreen');
  assert.equal(await readModelVisibility(page, 'Show silkscreen'), false);
  await page.waitForFunction(
    (previous) => document.querySelector('.pcb-model-canvas')?.dataset.renderCount !== previous,
    visibleSilkRenderCount,
  );
  const hiddenSilk = await boardCanvas.screenshot();
  assert.ok(!visibleSilk.equals(hiddenSilk), 'Default silkscreen changes actual board pixels.');
  await button('Source').click();
  await button('Model').click();
  await page.waitForFunction(
    () =>
      document.querySelector('.pcb-model-canvas canvas')?.width > 0 &&
      !document.querySelector('.pcb-model-preview [role="status"]'),
  );
  assert.equal(
    await readModelVisibility(page, 'Show silkscreen'),
    false,
    'An explicit silkscreen choice survives view switches.',
  );
  await toggleModelVisibility(page, 'Show silkscreen');
  await runCanvasAction(page, 'Fit 3D board');
  await exportCanvasImage(page);
  await page.waitForFunction(() =>
    document.querySelector('.pcb-model-status')?.textContent.includes('Exported'),
  );
  assert.equal(images.length, 2);
  assert.ok(images[1].width > 0 && images[1].height > 0);
  const sharp = (await import('sharp')).default;
  const pixels = await sharp(Buffer.from(images[1].dataUrl.split(',')[1], 'base64'))
    .raw()
    .toBuffer();
  assert.equal(pixels[3], 0, '3D PNG background retains alpha transparency.');
  await writeFile(
    'test-results/pcb-3d-export.png',
    Buffer.from(images[1].dataUrl.split(',')[1], 'base64'),
  );
  await page.screenshot({ path: 'test-results/pcb-3d-components.png' });
  await toggleModelVisibility(page, 'Show component models');
  assert.equal(await readModelVisibility(page, 'Show component models'), false);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/pcb-3d.png' });
  await button('Source').click();
  original = await readNativeProject(page);
  assert.deepEqual(
    original,
    projectFromNativeFiles(projectNativeFiles(fixture, 'layout.kicad_pro')),
    'Independent 3D viewing preserves native project data.',
  );
  assert.equal(
    await page.locator('.pcb-model-canvas canvas').count(),
    1,
    'Leaving 3D retains its scene.',
  );
  assert.equal(await page.locator('.pcb-model-canvas').isVisible(), false);
  const warmModelRequests = modelRequests;
  await button('Model').click();
  await page.locator('.pcb-model-canvas canvas').waitFor();
  assert.equal(
    await readModelVisibility(page, 'Show component models'),
    false,
    '3D visibility survives view switches.',
  );
  assert.equal(
    modelRequests,
    warmModelRequests,
    'Returning to the retained scene does not refetch models.',
  );
  await button('Source').click();
  assert.deepEqual(
    await readNativeProject(page),
    original,
    'Retained Model state never changes project bytes.',
  );
  await button('Layout').click();
  const gridDensity = page.getByRole('combobox', { name: 'Grid density', exact: true });
  const assertGridLabel = async (value) =>
    assert.equal((await gridDensity.innerText()).replace(/\s+/g, ' ').trim(), `Grid ${value}`);
  const chooseGrid = async (value) => {
    await gridDensity.click();
    await page.getByRole('option', { name: value, exact: true }).click();
    await assertGridLabel(value);
  };
  await assertGridLabel('0.5 mm');
  assert.equal(await canvas.locator('pattern').getAttribute('width'), '0.5');
  await gridDensity.click();
  assert.deepEqual(await page.getByRole('option').allTextContents(), [
    '0.1 mm',
    '0.2 mm',
    '0.25 mm',
    '0.5 mm',
    '1 mm',
    'Off',
  ]);
  await page.getByRole('option', { name: '1 mm', exact: true }).click();
  assert.equal(await canvas.locator('pattern').getAttribute('width'), '1');
  await button('Schematic').click();
  await assertGridLabel('2 mm');
  await chooseGrid('5 mm');
  await button('Model').click();
  await page.locator('.pcb-model-canvas canvas').waitFor();
  await assertGridLabel('0.5 mm');
  await gridDensity.click();
  assert.deepEqual(await page.getByRole('option').allTextContents(), [
    '0.5 mm',
    '1 mm',
    '2 mm',
    '5 mm',
    '10 mm',
    'Off',
  ]);
  await page.getByRole('option', { name: '10 mm', exact: true }).click();
  await assertGridLabel('10 mm');
  await button('Schematic').click();
  await assertGridLabel('5 mm');
  await button('Layout').click();
  await assertGridLabel('1 mm');
  await button('Model').click();
  await assertGridLabel('10 mm');
  await chooseGrid('Off');
  await button('Layout').click();
  await assertGridLabel('Off');
  assert.equal(await canvas.locator('rect[fill^="url(#layout-grid-"]').count(), 0);
  await button('Schematic').click();
  await assertGridLabel('Off');
  await chooseGrid('2 mm');
  await button('Model').click();
  await assertGridLabel('10 mm');
  await chooseGrid('0.5 mm');
  await button('Layout').click();
  await assertGridLabel('1 mm');
  assert.equal(await canvas.locator('pattern').getAttribute('width'), '1');
  assert.equal(await canvas.locator('rect[fill^="url(#layout-grid-"]').count(), 1);
  assert.equal(modelRequests, warmModelRequests, 'Grid choices retain loaded Model resources.');
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  assert.equal(await button('Undo').isEnabled(), false, 'Grid choices create no design history.');
  await button('Source').click();
  assert.deepEqual(
    await readNativeProject(page),
    original,
    'Opening Layout preserves project content.',
  );
  await selectSourceFile(page, 'layout.kicad_sch');
  const originalSchematicSource = await readSource(page);
  await fillSource(page, '(kicad_sch invalid layout draft');
  await button('Model').click();
  assert.equal(
    await page.locator('.pcb-model-canvas').isVisible(),
    false,
    'Invalid Source blocks 3D.',
  );
  await button('Layout').click();
  assert.equal(await canvas.isVisible(), false, 'Invalid source blocks Layout.');
  assert.equal(await readSource(page), '(kicad_sch invalid layout draft');
  await fillSource(page, originalSchematicSource);
  await button('Layout').click();
  await canvas.waitFor();
  const pad = canvas.locator(`[data-pad-id="${original.pcb.footprints[0].pads[0].id}"]`);
  await pad.click();
  const start = await pad.boundingBox();
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 48, start.y + start.height / 2 + 24, {
    steps: 8,
  });
  await page.mouse.up();
  await button('Source').click();
  let moved = await readNativeProject(page);
  assert.notDeepEqual(moved.pcb.footprints[0], original.pcb.footprints[0]);
  assert.deepEqual(
    moved.schematic,
    original.schematic,
    'Layout gestures do not edit the schematic.',
  );
  assert.equal(moved.pcb.footprints[0].id, original.pcb.footprints[0].id);
  await button('Layout').click();
  await button('Undo').click();
  await button('Source').click();
  assert.deepEqual(await readNativeProject(page), original, 'One undo reverses the full drag.');
  await button('Layout').click();
  await button('Redo').click();
  await canvas.press('Control+s');
  await page.getByText('Save project', { exact: true }).waitFor();
  assert.deepEqual(
    parseProject(saved).extensions,
    fixture.extensions,
    'Native save IPC retains private provenance.',
  );
  assert.deepEqual(
    projectFromNativeFiles(projectNativeFiles(parseProject(saved), 'layout.kicad_pro')),
    moved,
  );
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  // Save materializes the validated native files. Use those written bytes as
  // the baseline for later view/annotation preservation checks.
  await button('Source').click();
  moved = await readNativeProject(page);
  await button('Layout').click();
  await button('Annotation mode').click();
  await pad.click();
  const comment = page.getByRole('textbox', { name: 'Annotation comment' });
  await comment.fill('Review this footprint placement.');
  await button('Add').click();
  assert.equal(await page.locator('.file-editor-surface:not([hidden]) .annotation-pin').count(), 1);
  const layoutPin = page.locator('.file-editor-surface:not([hidden]) .annotation-pin').first();
  const pinBeforePan = await layoutPin.boundingBox();
  const cameraBox = await canvas.boundingBox();
  await page.mouse.move(cameraBox.x + cameraBox.width / 2, cameraBox.y + cameraBox.height / 2);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(
    cameraBox.x + cameraBox.width / 2 + 20,
    cameraBox.y + cameraBox.height / 2 + 10,
    { steps: 3 },
  );
  await page.mouse.up({ button: 'middle' });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const pinAfterPan = await layoutPin.boundingBox();
  assert.ok(
    Math.abs(pinAfterPan.x - pinBeforePan.x - 20) < 1,
    'Pan carries annotation pins with the exact vector camera.',
  );
  assert.ok(Math.abs(pinAfterPan.y - pinBeforePan.y - 10) < 1);
  await button('Zoom in').click();
  await page.waitForFunction(
    () => {
      const surface = document.querySelector('.file-editor-surface:not([hidden])');
      const drawing = surface?.querySelector('[data-testid="layout-canvas"]')?.getScreenCTM();
      const marks = surface?.querySelector('.annotation-marks')?.getScreenCTM();
      return (
        drawing &&
        marks &&
        ['a', 'b', 'c', 'd', 'e', 'f'].every((key) => Math.abs(drawing[key] - marks[key]) < 0.01)
      );
    },
    undefined,
    { timeout: 15000 },
  );
  await button('Zoom out').click();

  await canvas.press('Delete');
  await canvas.press('r');
  await button('Source').click();
  assert.deepEqual(
    await readNativeProject(page),
    moved,
    'Annotation gestures never change the board.',
  );
  await button('Schematic').click();
  await button('Annotation mode').click();
  assert.equal(
    await page.locator('.schematic-surface .annotation-pin').count(),
    0,
    'Layout pins do not appear on the schematic.',
  );
  await button('Layout').click();
  assert.equal(await page.locator('.file-editor-surface:not([hidden]) .annotation-pin').count(), 1);
  await button('Draw rectangle').click();
  const region = await pad.boundingBox();
  await page.mouse.move(region.x - 18, region.y - 18);
  await page.mouse.down();
  await page.mouse.move(region.x + region.width + 18, region.y + region.height + 18, { steps: 8 });
  await page.mouse.up();
  await comment.fill('Review this board region.');
  await button('Add').click();
  await button('Draw freehand').click();
  const area = await canvas.boundingBox();
  await page.mouse.move(area.x + 70, area.y + 80);
  await page.mouse.down();
  await page.mouse.move(area.x + 110, area.y + 95, { steps: 6 });
  await page.mouse.move(area.x + 150, area.y + 70, { steps: 6 });
  await page.mouse.up();
  await comment.fill('Keep this region clear.');
  await button('Add').click();
  assert.equal(await page.locator('.file-editor-surface:not([hidden]) .annotation-pin').count(), 3);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/layout-annotations.png' });
  const crop = await page.locator('.annotation-attachments img').first().getAttribute('src');
  if (crop)
    await writeFile(
      'test-results/layout-annotation-crop.png',
      Buffer.from(crop.split(',')[1], 'base64'),
    );
  await button('Interaction mode').click();
  await canvas.press('Escape');
  const point = async (x, y) =>
    canvas.evaluate(
      (svg, p) => {
        const transformed = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
        return { x: transformed.x, y: transformed.y };
      },
      { x, y },
    );
  const clickPoint = async (x, y) => {
    const p = await point(x, y);
    await page.mouse.click(p.x, p.y);
  };
  await button('Draw polygon').click();
  // The zone intentionally extends beyond the original board; make it visible.
  await button('Zoom out').click();
  await button('Zoom out').click();
  await button('Zoom out').click();
  for (const [x, y] of [
    [2.54, 2.54],
    [17.78, 2.54],
    [17.78, 12.7],
    [2.54, 12.7],
  ])
    await clickPoint(x, y);
  await button('Finish region').click();
  await canvas.locator('[data-copper-zone]').first().waitFor({ state: 'attached' });
  assert.equal(await canvas.locator('[data-copper-zone]').last().getAttribute('d'), '');
  await page.getByRole('spinbutton', { name: 'Clearance (mm)', exact: true }).fill('0.5');
  await page.getByRole('spinbutton', { name: 'Clearance (mm)', exact: true }).press('Enter');
  await button('Source').click();
  const poured = await readNativeProject(page);
  assert.equal(poured.pcb.zones.length, moved.pcb.zones.length + 1);
  assert.equal(poured.pcb.zones.at(-1).clearance, 0.5);
  assert.equal(poured.pcb.zones.at(-1).filledPolygons, undefined);
  assert.deepEqual(poured.schematic, moved.schematic);
  await button('Layout').click();
  await page.getByRole('checkbox', { name: 'Filled', exact: true }).check();
  await button('Source').click();
  const filled = await readNativeProject(page);
  assert.ok(filled.pcb.zones.at(-1).filledPolygons.length);
  await button('Layout').click();
  await button('Undo').click();
  await button('Undo').click();
  await button('Undo').click();
  await button('Source').click();
  assert.deepEqual(
    await readNativeProject(page),
    moved,
    'Zone creation and properties are whole-project undo transactions.',
  );
  await button('Layout').click();
  await button('Route tracks').click();
  await clickPoint(15.24, 15.24);
  await clickPoint(20.32, 17.78);
  await clickPoint(22.86, 25.4);
  await canvas.press('Enter');
  await button('Source').click();
  const routed = await readNativeProject(page);
  assert.ok(
    routed.pcb.tracks.length > moved.pcb.tracks.length,
    'Waypoints commit real track segments.',
  );
  assert.deepEqual(routed.schematic, original.schematic);
  for (const track of routed.pcb.tracks.slice(moved.pcb.tracks.length)) {
    assert.equal(track.layer, 'F.Cu');
    assert.equal(track.netId, original.pcb.nets[0].id);
    assert.ok(track.width > 0);
  }
  await button('Layout').click();
  await button('Undo').click();
  await button('Source').click();
  assert.deepEqual(
    await readNativeProject(page),
    moved,
    'A complete route is one undo transaction.',
  );
  await button('Layout').click();
  await button('Redo').click();
  await button('Place through via').click();
  await clickPoint(22.86, 25.4);
  await selectLayoutLayer(page, 'Edge.Cuts');
  await button('Draw rectangle').click();
  await button('Zoom out').click();
  await button('Zoom out').click();
  await clickPoint(10.16, 10.16);
  await clickPoint(45.72, 40.64);
  await button('Source').click();
  const drawn = await readNativeProject(page);
  assert.equal(drawn.pcb.vias.length, moved.pcb.vias.length + 1);
  assert.equal(drawn.pcb.graphics.length, moved.pcb.graphics.length + 1);
  assert.equal(drawn.pcb.graphics.at(-1).kind, 'polygon');
  assert.equal(drawn.pcb.graphics.at(-1).layer, 'Edge.Cuts');
  await button('Layout').click();
  await canvas.press('Control+s');
  await page.getByText('Save project', { exact: true }).waitFor();
  assert.deepEqual(
    projectFromNativeFiles(projectNativeFiles(parseProject(saved), 'layout.kicad_pro')),
    drawn,
  );
  await button('Git').click();
  const history = page.getByRole('region', { name: 'Git', exact: true });
  await history.waitFor();
  assert.equal(await button('Git').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.getByRole('dialog').count(), 0);
  await button('Layout').click();
  await button('Fit board to canvas').click();
  await page.waitForFunction(
    () => document.querySelectorAll('.project-navigation .dirty-dot').length === 0,
  );
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/layout-light.png' });
  await button('Settings').click();
  await page.getByRole('radio', { name: 'Dark', exact: true }).check();
  await button('Done').click();
  const pixelsPerMM = await canvas.evaluate((svg) => svg.getScreenCTM().a);
  await page.setViewportSize({ width: 1000, height: 720 });
  await page.waitForFunction(
    (scale) =>
      Math.abs(document.querySelector('[data-testid="layout-canvas"]').getScreenCTM().a - scale) <
      0.001,
    pixelsPerMM,
  );
  await page.mouse.move(100, 100);
  await page.screenshot({ path: 'test-results/layout-dark-compact.png' });
  const tools = await page.locator('.layout-toolbar').boundingBox();
  const lastAction = await button('Toggle right sidebar').boundingBox();
  const gridBounds = await gridDensity.boundingBox();
  const statusBounds = await page.locator('.layout-status').boundingBox();
  assert.ok(
    gridBounds.x + gridBounds.width <= statusBounds.x + statusBounds.width,
    'Grid density remains visible in compact windows.',
  );
  assert.ok(
    lastAction.x + lastAction.width <= tools.x + tools.width + 1,
    'All toolbar actions fit compact windows.',
  );
  await page.setViewportSize({ width: 1460, height: 900 });
  await page
    .locator('.project-navigation [data-project-id="00000000-0000-4000-8000-000000000002"]')
    .click();
  await button('Model').click();
  await page.getByText('No PCB layout in this project.', { exact: true }).waitFor();
  assert.equal(await page.locator('.pcb-model-canvas canvas').count(), 0);
  await button('Open Layout').click();
  await button('Layout').click();
  await canvas.press('Control+s');
  await page.getByText('Save project', { exact: true }).waitFor();
  assert.equal(
    parseProject(saved).pcb,
    null,
    'Entering a project without PCB does not create a board.',
  );
  const placeFootprint = page
    .locator('.layout-toolbar')
    .getByRole('button', { name: 'Place footprint', exact: true });
  await placeFootprint.click();
  const placementDialog = page.getByRole('dialog', { name: 'Footprint placement', exact: true });
  await placementDialog.waitFor();
  const placementBounds = await placementDialog.boundingBox();
  assert.ok(placementBounds.width <= 840);
  assert.ok(Math.abs(placementBounds.x + placementBounds.width / 2 - 730) <= 1);
  assert.equal(await placementDialog.getAttribute('aria-modal'), 'true');
  assert.equal(await page.getByRole('complementary', { name: 'Placement settings' }).count(), 0);
  assert.equal(
    await placementDialog.getByRole('combobox', { name: 'Schematic component' }).count(),
    1,
  );
  assert.equal(await placeFootprint.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  await placementDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  assert.equal(await placementDialog.count(), 0, 'Closing the chooser cancels initial placement.');
  assert.equal(await placeFootprint.getAttribute('aria-pressed'), 'false');
  await placeFootprint.click();
  await placementDialog.getByRole('button', { name: 'Place footprint', exact: true }).click();
  assert.equal(await placementDialog.count(), 0);
  assert.equal(await canvas.evaluate((element) => document.activeElement === element), true);
  const placementPreview = canvas.locator('.layout-footprint.is-placement > g').first();
  const beforeRotation = await placementPreview.getAttribute('transform');
  await page.keyboard.press('r');
  assert.notEqual(await placementPreview.getAttribute('transform'), beforeRotation);
  await page.screenshot({ path: 'test-results/layout-placement-settings.png' });
  await canvas.press('Escape');
  assert.equal(await placementDialog.count(), 0);
  assert.equal(await canvas.locator('.is-placement').count(), 0);
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  await button('Source').click();
  assert.equal(
    (await readNativeProject(page)).pcb,
    null,
    'Cancelling placement never creates a board.',
  );
  await button('Layout').click();
  await placeFootprint.click();
  await placementDialog.getByRole('button', { name: 'Place footprint', exact: true }).click();
  await button('Route tracks').click();
  assert.equal(
    await canvas.locator('.is-placement').count(),
    0,
    'Switching tools cancels placement.',
  );
  await placeFootprint.click();
  await placementDialog.getByRole('button', { name: 'Place footprint', exact: true }).click();
  await clickPoint(25.4, 25.4);
  assert.equal(
    await placeFootprint.getAttribute('aria-pressed'),
    'false',
    'Successful placement exits its tool.',
  );
  await button('Source').click();
  const placed = await readNativeProject(page);
  assert.equal(placed.pcb.footprints.length, 1);
  assert.equal(placed.pcb.footprints[0].libraryId, footprintId);
  assert.equal(placed.pcb.footprints[0].pads.length, 2);
  assert.ok(placed.pcb.footprints[0].pads.every((p) => p.netId !== null));
  const linked = placed.schematic.parts.find((p) => p.id === placed.pcb.footprints[0].symbolId);
  assert.equal(
    partFields(linked).Footprint,
    footprintId,
    'Placement updates the shared schematic assignment.',
  );
  assert.deepEqual(placed.schematic.wires, withoutPCB.schematic.wires);
  await button('Layout').click();
  await button('Undo').click();
  await button('Source').click();
  assert.equal(
    (await readNativeProject(page)).pcb,
    null,
    'One undo removes the first footprint and implicit board together.',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Layout scale, copper zones/edit/undo, retained 3D, Source protections, footprint placement/drag, route/via/outline, save, annotations, history and compact themes passed.',
  );
} finally {
  await browser.close();
}
