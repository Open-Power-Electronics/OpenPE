import {
  runCanvasAction,
  exportCanvasImage,
  openCanvasContextMenu,
} from './canvas-context-menu-test-helpers.mjs';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { readNativeFiles, fillNativeProject } from './source-editor-test-helpers.mjs';
import { parseProject } from '../server/project-format.mjs';
import {
  closeDisplayDrawer,
  openDisplayDrawer,
  selectModelView,
} from './visualization-test-helpers.mjs';
// Isolated renderer regression: no Electron, real CLIs, native dialogs or user data.
await mkdir('test-results', { recursive: true });
const source = await readFile('tests/fixtures/rc-filter.openpe.json', 'utf8');
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
const sent = [],
  errors = [];
const bundle = await build({
  stdin: {
    contents:
      "import React from 'react'; import {createRoot} from 'react-dom/client'; import Workspace from './components/DesktopWorkspace'; createRoot(document.getElementById('root')).render(<Workspace/>);",
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outdir: 'test-results/annotations-ui-bundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', (e) => {
    errors.push(e.message);
    console.log('ERROR', e.message);
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
      exportImage: async (image) => {
        (window.exportedImages ||= []).push(image);
        if (window.imageExportMode === 'cancel') return null;
        if (window.imageExportMode === 'error') throw new Error('Simulated PNG save failure.');
        return { name: 'schematic.png' };
      },
    };
  });
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/state') {
      if (route.request().method() === 'POST') state = route.request().postDataJSON();
      return route.fulfill({ json: state });
    }
    if (url.pathname === '/api/appearance') return route.fulfill({ json: null });
    if (url.pathname === '/api/agents')
      return route.fulfill({ json: [{ id: 'codex', available: true, version: 'mock' }] });
    if (url.pathname === '/api/models')
      return route.fulfill({ json: { models: [], defaultModel: '' } });
    if (url.pathname === '/api/libraries/footprints')
      return route.fulfill({ json: { footprint: ['footprint', '"Test"'] } });
    if (/^\/(brand|agents)\/[\w.-]+\.(svg|png)$/.test(url.pathname))
      return route.fulfill({
        contentType: url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        body: await readFile('public' + url.pathname),
      });
    if (url.pathname === '/api/chat') {
      sent.push(route.request().postDataJSON());
      return route.fulfill({
        contentType: 'text/event-stream',
        body: 'data: {"type":"text-delta","delta":"Mock response"}\n\ndata: {"type":"done","outcome":"completed"}\n\n',
      });
    }
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  async function mount() {
    await page.goto('http://localhost');
    await page.addStyleTag({ content: await readFile('app/globals.css', 'utf8') });
    await page.addStyleTag({ content: await readFile('app/workspace.css', 'utf8') });
    await page.addStyleTag({ content: await readFile('app/layout-editor.css', 'utf8') });
    for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
      await page.addStyleTag({ content: file.text });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByTestId('schematic-canvas').waitFor();
  }
  await mount();
  const button = (name) => page.getByRole('button', { name, exact: true });
  await button('Source').click();
  const nativeBaseline = await readNativeFiles(page);
  await button('Schematic').click();
  await page.getByTestId('part-R1').click();
  await exportCanvasImage(page);
  await page.getByText('Exported schematic.png', { exact: true }).waitFor();
  const schematicImage = await page.evaluate(() => window.exportedImages[0]);
  assert.ok(schematicImage.width > 100 && schematicImage.height > 100);
  assert.ok(schematicImage.width <= 4096 && schematicImage.height <= 4096);
  const sharp = (await import('sharp')).default;
  const schematicBytes = Buffer.from(schematicImage.dataUrl.split(',')[1], 'base64');
  const pixels = await sharp(schematicBytes).removeAlpha().raw().toBuffer();
  assert.ok(
    pixels.some((channel) => channel < 100),
    'The exported image contains actual schematic ink.',
  );
  await writeFile('test-results/schematic-export.png', schematicBytes);
  await page.getByTestId('schematic-canvas').press('Escape');
  const comment = page.getByRole('textbox', { name: 'Annotation comment' });
  const pendingAttachments = page.getByLabel('Pending annotations', { exact: true });
  const annotationToolbar = page.getByRole('toolbar', { name: 'Annotation tools', exact: true });
  const queuedAnnotations = () => state.documents[0].sessions[0].annotations ?? [];
  const chooseTheme = async (theme) => {
    await button('Settings').click();
    await page.getByRole('radio', { name: theme, exact: true }).check();
    await button('Done').click();
  };
  const selectedGeometryPaint = (target) =>
    target.locator('[data-selection-only] *').evaluateAll((nodes) =>
      nodes
        .filter((node) =>
          ['path', 'line', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'text'].includes(
            node.tagName,
          ),
        )
        .map((node) => {
          const style = getComputedStyle(node);
          return {
            kind: node.tagName,
            stroke: style.stroke,
            strokeWidth: style.strokeWidth,
            fill: style.fill,
            opacity: style.opacity,
            fillOpacity: style.fillOpacity,
            strokeOpacity: style.strokeOpacity,
            strokeDasharray: style.strokeDasharray,
          };
        }),
    );
  const elementMarks = () =>
    page.locator(
      '.canvas-annotations:not([hidden]) .annotation-marks rect, .canvas-annotations:not([hidden]) .annotation-marks polyline',
    );
  const waitQueuedAnnotations = async (predicate) => {
    const deadline = Date.now() + 10000;
    while (!predicate(state.documents[0].sessions[0].annotations ?? [])) {
      assert.ok(Date.now() < deadline, 'Annotation recovery reaches the expected state.');
      await page.waitForTimeout(50);
    }
    return structuredClone(state.documents[0].sessions[0].annotations ?? []);
  };
  const annotationFilters = async (mode, canvas, target, masterName, category) => {
    await button(mode).click();
    await button('Annotation mode').click();
    await button('Select elements').click();
    const filters = page.getByRole('group', { name: 'Selection', exact: true });
    const setAll = async (checked) => {
      await openDisplayDrawer(page, 'Selection');
      const master = filters.getByRole('checkbox', { name: masterName, exact: true });
      if (!checked && (await master.evaluate((input) => input.indeterminate))) await master.check();
      await master.setChecked(checked);
      await closeDisplayDrawer(page, 'Selection');
    };
    const clickTarget = async () => {
      const bounds = await target.boundingBox();
      assert.ok(bounds, `${mode} annotation target has visible geometry.`);
      await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    };
    await setAll(false);
    await clickTarget();
    assert.equal(await comment.count(), 0, `${mode} cannot annotate a disabled element.`);
    const bounds = await target.boundingBox();
    await page.mouse.move(bounds.x - 10, bounds.y - 10);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width + 10, bounds.y + bounds.height + 10, {
      steps: 5,
    });
    await page.mouse.up();
    assert.equal(
      await comment.count(),
      0,
      `${mode} element marquee cannot capture disabled objects.`,
    );
    assert.equal(await page.locator('.annotation-pin:visible').count(), 0);
    assert.equal(await page.locator('.annotation-marks rect:visible').count(), 0);

    await button('Draw rectangle').click();
    await page.mouse.move(bounds.x - 10, bounds.y - 10);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width + 10, bounds.y + bounds.height + 10, {
      steps: 5,
    });
    await page.mouse.up();
    await comment.fill(`Filtered ${mode} region.`);
    await button('Add').click();
    const region = (await waitQueuedAnnotations((items) => items.length === 1))[0];
    assert.equal(region.markup.kind, 'rectangle');
    assert.deepEqual(region.elements, [], `${mode} region capture excludes disabled objects.`);
    await button('Clear annotations').click();
    await waitQueuedAnnotations((items) => items.length === 0);
    await button('Select elements').click();

    await openDisplayDrawer(page, 'Selection');
    await filters.getByRole('checkbox', { name: category, exact: true }).check();
    await closeDisplayDrawer(page, 'Selection');
    let interactionPaint;
    if (mode === 'Schematic') {
      await button('Interaction mode').click();
      await clickTarget();
      await target.locator('[data-selection-only]').first().waitFor({ state: 'attached' });
      interactionPaint = await selectedGeometryPaint(target);
      assert.ok(interactionPaint.length > 0, 'The symbol has selected geometry paint.');
      await button('Annotation mode').click();
      await button('Select elements').click();
    }
    await clickTarget();
    await comment.fill(`Retain ${mode} snapshot.`);
    if (interactionPaint)
      assert.deepEqual(
        await selectedGeometryPaint(target),
        interactionPaint,
        'Schematic element annotations use the same geometry highlight as Interaction.',
      );
    await canvas.locator('[data-annotation-selection-outline]').waitFor({ state: 'attached' });
    assert.equal(
      await canvas.locator('[data-annotation-selection-outline] [data-selection-id]').count(),
      0,
      'Annotation contours add no picking identities.',
    );
    assert.equal(await elementMarks().count(), 0, `${mode} adds no element bounding-box paint.`);
    assert.equal(await page.locator('.annotation-pin:visible').count(), 1);
    assert.deepEqual(queuedAnnotations(), [], `${mode} comment typing stays local until Add.`);
    assert.equal(await pendingAttachments.count(), 0);
    await button('Add').click();
    const captured = await waitQueuedAnnotations((items) => items.length === 1);
    assert.equal(captured[0].markup, undefined, 'Element annotations retain no region markup.');
    assert.ok(captured[0].elements.length > 0, `${mode} allows the enabled object category.`);
    await setAll(false);
    assert.equal(
      await canvas
        .locator('.part.is-selected, .layout-footprint.selected, [data-selection-only]')
        .count(),
      0,
      `${mode} filter changes clear live object selection paint.`,
    );
    assert.equal(await page.locator('.annotation-pin:visible').count(), 1);
    assert.deepEqual(
      await waitQueuedAnnotations((items) => items.length === 1),
      captured,
      'Saved annotation images and comments remain immutable when eligibility changes.',
    );
    if (await comment.count()) await comment.press('Escape');
    await button('Clear annotations').click();
    await waitQueuedAnnotations((items) => items.length === 0);

    await openDisplayDrawer(page, 'Selection');
    await filters.getByRole('checkbox', { name: category, exact: true }).check();
    await closeDisplayDrawer(page, 'Selection');
    await page.evaluate(() => {
      const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
      window.pendingAnnotationImages = [];
      window.releaseAnnotationImages = async () => {
        Object.defineProperty(HTMLImageElement.prototype, 'src', descriptor);
        await Promise.all(
          window.pendingAnnotationImages.map(
            ([image, value]) =>
              new Promise((resolve, reject) => {
                image.addEventListener('load', resolve, { once: true });
                image.addEventListener('error', reject, { once: true });
                descriptor.set.call(image, value);
              }),
          ),
        );
      };
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        ...descriptor,
        set(value) {
          if (value.startsWith('blob:')) window.pendingAnnotationImages.push([this, value]);
          else descriptor.set.call(this, value);
        },
      });
    });
    await clickTarget();
    await page.waitForFunction(() => window.pendingAnnotationImages.length > 0);
    await setAll(false);
    await page.evaluate(() => window.releaseAnnotationImages());
    assert.equal(
      await comment.count(),
      0,
      `${mode} rejects a capture from old Selection settings.`,
    );
    assert.equal(await page.locator('.annotation-pin:visible').count(), 0);
    await setAll(true);
    await button('Interaction mode').click();
  };
  await annotationFilters(
    'Schematic',
    page.getByTestId('schematic-canvas'),
    page.getByTestId('part-R1'),
    'All',
    'Symbols',
  );
  const fixture = parseProject(source);
  const resistor = fixture.schematic.parts.find((part) => part.ref === 'R1');
  const resistorFootprint = fixture.pcb.footprints.find((item) => item.symbolId === resistor.id);
  await annotationFilters(
    'Layout',
    page.getByTestId('layout-canvas'),
    page
      .getByTestId('layout-canvas')
      .locator(`[data-selection-id="${resistorFootprint.id}"]`)
      .first(),
    'All items',
    'Footprints',
  );
  // A nearby physical trace remains pickable beyond its painted/fixed DOM stroke.
  // Both modes must resolve the same object at the same screen-space tolerance.
  const layoutCanvas = page.getByTestId('layout-canvas');
  const track = fixture.pcb.tracks[0];
  const layoutFilters = page.getByRole('group', { name: 'Selection', exact: true });
  await openDisplayDrawer(page, 'Selection');
  await layoutFilters.getByRole('checkbox', { name: 'All items', exact: true }).uncheck();
  await layoutFilters.getByRole('checkbox', { name: 'Tracks', exact: true }).check();
  await closeDisplayDrawer(page, 'Selection');
  const nearTrack = () =>
    layoutCanvas.evaluate((svg, track) => {
      const matrix = svg.getScreenCTM();
      const start = new DOMPoint(track.start.x, track.start.y).matrixTransform(matrix);
      const end = new DOMPoint(track.end.x, track.end.y).matrixTransform(matrix);
      const dx = end.x - start.x,
        dy = end.y - start.y,
        length = Math.hypot(dx, dy);
      const scale = length / Math.hypot(track.end.x - track.start.x, track.end.y - track.start.y);
      const offset = Math.max(3.75, (track.width * scale) / 2 + 2);
      const point = {
        x: (start.x + end.x) / 2 - (dy / length) * offset,
        y: (start.y + end.y) / 2 + (dx / length) * offset,
      };
      return {
        ...point,
        directlyHit: document
          .elementsFromPoint(point.x, point.y)
          .some(
            (node) =>
              node.closest('[data-selection-id]')?.getAttribute('data-selection-id') === track.id,
          ),
      };
    }, track);
  assert.equal(await page.locator('.layout-editor .zoom-controls').count(), 0);
  await runCanvasAction(page, 'Actual size (100%)');
  for (const zoom of [100, 144]) {
    if (zoom !== 100) {
      await runCanvasAction(page, 'Zoom in');
      await runCanvasAction(page, 'Zoom in');
    }
    await page.waitForFunction((zoom) => {
      const matrix = document.querySelector('[data-testid="layout-canvas"]')?.getScreenCTM();
      return matrix && Math.round((Math.hypot(matrix.a, matrix.b) / (96 / 25.4)) * 100) === zoom;
    }, zoom);
    await button('Interaction mode').click();
    const interactionPoint = await nearTrack();
    assert.equal(interactionPoint.directlyHit, false, 'The pointer misses the trace DOM stroke.');
    await page.mouse.click(interactionPoint.x, interactionPoint.y);
    await layoutCanvas
      .locator(`[data-selection-id="${track.id}"] [data-selection-only]`)
      .waitFor({ state: 'attached' });
    const trackTarget = layoutCanvas.locator(`[data-selection-id="${track.id}"]`);
    const interactionPaint = await selectedGeometryPaint(trackTarget);
    assert.ok(interactionPaint.length > 0, 'The trace has selected geometry paint.');
    await button('Annotation mode').click();
    await button('Select elements').click();
    const annotationPoint = await nearTrack();
    assert.equal(annotationPoint.directlyHit, false);
    await page.mouse.click(annotationPoint.x, annotationPoint.y);
    await comment.fill(`Trace tolerance at ${zoom}% zoom.`);
    assert.deepEqual(
      await selectedGeometryPaint(trackTarget),
      interactionPaint,
      'Layout annotation and Interaction retain the same trace colour, width and opacity.',
    );
    assert.equal(await elementMarks().count(), 0, 'Trace annotations add no blue bounding box.');
    await button('Add').click();
    const captured = (await waitQueuedAnnotations((items) => items.length === 1))[0];
    assert.deepEqual(
      captured.elements.map((element) => element.id),
      [track.id],
      'Annotation uses the same nearby trace target as Interaction.',
    );
    await button('Clear annotations').click();
    await waitQueuedAnnotations((items) => items.length === 0);
    await openDisplayDrawer(page, 'Selection');
    await layoutFilters.getByRole('checkbox', { name: 'Tracks', exact: true }).uncheck();
    await closeDisplayDrawer(page, 'Selection');
    const disabledPoint = await nearTrack();
    await page.mouse.click(disabledPoint.x, disabledPoint.y);
    assert.equal(await comment.count(), 0, 'Pick tolerance never bypasses Selection eligibility.');
    assert.equal(await page.locator('.annotation-pin:visible').count(), 0);
    await openDisplayDrawer(page, 'Selection');
    await layoutFilters.getByRole('checkbox', { name: 'Tracks', exact: true }).check();
    await closeDisplayDrawer(page, 'Selection');
  }
  const traceMarquee = async (crossing) => {
    const positions = await layoutCanvas.evaluate(
      (svg, { track, crossing }) => {
        const x = (track.start.x + track.end.x) / 2,
          y = (track.start.y + track.end.y) / 2;
        const matrix = svg.getScreenCTM();
        const start = new DOMPoint(x + (crossing ? 0.5 : -0.5), y - 0.75).matrixTransform(matrix);
        const end = new DOMPoint(x + (crossing ? -0.5 : 0.5), y + 0.75).matrixTransform(matrix);
        return { start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y } };
      },
      { track, crossing },
    );
    await page.mouse.move(positions.start.x, positions.start.y);
    await page.mouse.down();
    await page.mouse.move(positions.end.x, positions.end.y, { steps: 5 });
    await page.mouse.up();
  };
  await traceMarquee(false);
  assert.equal(await comment.count(), 0, 'An element window must contain the complete trace.');
  await traceMarquee(true);
  await comment.fill('Crossing selects the touched trace.');
  await button('Add').click();
  const crossed = (await waitQueuedAnnotations((items) => items.length === 1))[0];
  assert.deepEqual(
    crossed.elements.map((element) => element.id),
    [track.id],
  );
  assert.equal(crossed.markup, undefined, 'Element marquees retain geometry-only highlights.');
  assert.equal(await elementMarks().count(), 0);
  await button('Clear annotations').click();
  await waitQueuedAnnotations((items) => items.length === 0);
  await openDisplayDrawer(page, 'Selection');
  await layoutFilters.getByRole('checkbox', { name: 'All items', exact: true }).check();
  await closeDisplayDrawer(page, 'Selection');
  await runCanvasAction(page, 'Fit board to canvas');
  await button('Interaction mode').click();
  await button('Source').click();
  assert.deepEqual(await readNativeFiles(page), nativeBaseline);
  await button('Schematic').click();
  await button('Annotation mode').click();
  await page.getByTestId('part-R1').click();
  await comment.fill('Check R1.');
  assert.equal(await page.locator('dialog[open]').count(), 0);
  await page.waitForTimeout(900);
  assert.deepEqual(
    queuedAnnotations(),
    [],
    'Typing a new comment does not enter session recovery.',
  );
  assert.equal(await pendingAttachments.count(), 0, 'A local draft is not a composer attachment.');
  assert.equal(sent.length, 0, 'Typing never submits a provider request.');
  assert.equal(
    await annotationToolbar.getByRole('button', { name: 'Send', exact: true }).count(),
    0,
  );
  assert.equal(await button('Add').innerText(), 'Add');
  await button('Add').click();
  const firstAdded = await waitQueuedAnnotations((items) => items.length === 1);
  assert.equal(await comment.count(), 0);
  assert.equal(await pendingAttachments.locator('.annotation-attachment').count(), 1);
  assert.equal(sent.length, 0, 'Add queues the capture without sending it.');
  await page.getByTestId('part-C1').click();
  await comment.fill('Check C1.');
  await button('Add').click();
  const beforeEdit = await waitQueuedAnnotations((items) => items.length === 2);
  assert.equal(await page.locator('.annotation-pin').count(), 2);
  assert.equal(await button('Annotation mode').getAttribute('aria-pressed'), 'true');
  await button('Edit canvas annotation 1').click();
  await comment.fill('Discard this draft.');
  await page.waitForTimeout(900);
  assert.deepEqual(
    queuedAnnotations(),
    beforeEdit,
    'Editing leaves the queued snapshot unchanged.',
  );
  await comment.press('Escape');
  assert.equal(await comment.count(), 0);
  assert.deepEqual(queuedAnnotations(), beforeEdit, 'Escape discards only the local edit.');
  await button('Edit canvas annotation 1').click();
  assert.equal(await comment.inputValue(), 'Check R1.');
  await comment.fill('Check the resistor value.');
  assert.equal(await button('Update').innerText(), 'Update');
  assert.deepEqual(queuedAnnotations(), beforeEdit);
  await button('Update').click();
  const updated = await waitQueuedAnnotations(
    (items) => items.length === 2 && items[0].comment === 'Check the resistor value.',
  );
  assert.deepEqual(updated[0], { ...firstAdded[0], comment: 'Check the resistor value.' });
  assert.equal(sent.length, 0, 'Update replaces one queued comment without sending.');
  const r = await page.getByTestId('part-R1').boundingBox();
  const c = await page.getByTestId('part-C1').boundingBox();
  await button('Draw rectangle').click();
  await page.mouse.move(Math.min(r.x, c.x) - 25, Math.min(r.y, c.y) - 35);
  await page.mouse.down();
  await page.mouse.move(
    Math.max(r.x + r.width, c.x + c.width) + 30,
    Math.max(r.y + r.height, c.y + c.height) + 25,
    { steps: 12 },
  );
  await page.mouse.up();
  await comment.fill('Review this whole stage.');
  await button('Add').click();
  await button('Draw freehand').click();
  const canvas = page.getByTestId('schematic-canvas');
  const bounds = await canvas.boundingBox();
  const x = bounds.x + bounds.width - 140,
    y = bounds.y + 65;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 30, y + 15, { steps: 5 });
  await page.mouse.move(x + 60, y - 8, { steps: 5 });
  await page.mouse.move(x + 80, y + 30, { steps: 5 });
  await page.mouse.up();
  await comment.fill(
    'Place a test point here and verify the nearby clearance before changing the board.',
  );
  await page.screenshot({ path: 'test-results/agent-annotation-inline.png' });
  await button('Add').click();
  await page.waitForTimeout(900);
  const queued = structuredClone(state.documents[0].sessions[0].annotations);
  assert.equal(queued.length, 4);
  assert.equal(queued[0].comment, 'Check the resistor value.');
  assert.equal(queued[0].elements[0].label, 'R1');
  assert.equal(queued[2].markup.kind, 'rectangle');
  assert.ok(queued[2].elements.some((e) => e.label === 'R1'));
  assert.ok(queued[2].elements.some((e) => e.label === 'C1'));
  assert.equal(queued[3].markup.kind, 'freehand');
  assert.equal(queued[3].elements.length, 0);
  assert.equal(
    await page.locator('.canvas-annotations:not([hidden]) .annotation-marks rect').count(),
    1,
    'Only the explicit rectangle keeps a blue region mark.',
  );
  assert.equal(
    await page.locator('.canvas-annotations:not([hidden]) .annotation-marks polyline').count(),
    1,
    'The explicit freehand stroke remains visible.',
  );
  assert.equal(state.documents[0].dirty, false);
  assert.equal(sent.length, 0);
  const sidebar = page.locator('.chat-panel:visible');
  const composerStack = sidebar.locator('.composer-stack');
  const divider = page.getByRole('separator', { name: 'Resize conversation and schematic' });
  const originalTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  const originalSidebarWidth = (await sidebar.boundingBox()).width;
  await divider.press('Home');
  await page.waitForFunction(
    () =>
      Math.abs(
        document.querySelector('.chat-panel:not([hidden])').getBoundingClientRect().width - 328,
      ) < 1,
  );
  for (const theme of ['Light', 'Dark']) {
    await chooseTheme(theme);
    await pendingAttachments.evaluate((element) => {
      element.scrollTop = 0;
    });
    const geometry = await pendingAttachments.evaluate((element) => {
      const rect = (node) => node.getBoundingClientRect().toJSON();
      const chat = element.closest('.chat-panel');
      const composer = element.closest('.composer-stack').querySelector('.composer');
      return {
        sidebar: rect(chat),
        sidebarFits: chat.scrollWidth <= chat.clientWidth + 1,
        row: rect(element),
        outsideComposer: element.closest('.composer') === null,
        composer: rect(composer),
        overflowY: getComputedStyle(element).overflowY,
        maxHeight: parseFloat(getComputedStyle(element).maxHeight),
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        scrollWidth: element.scrollWidth,
        clientWidth: element.clientWidth,
        input: rect(composer.querySelector('textarea')),
        cards: [...element.querySelectorAll('.annotation-attachment')].map((card) => {
          const label = card.querySelector('.annotation-attachment-preview strong');
          return {
            bounds: rect(card),
            image: rect(card.querySelector('img')),
            remove: rect(card.querySelector('.annotation-attachment-remove')),
            label: rect(label),
            whiteSpace: getComputedStyle(label).whiteSpace,
            textOverflow: getComputedStyle(label).textOverflow,
            lineHeight: parseFloat(getComputedStyle(label).lineHeight),
            clipped: label.scrollWidth > label.clientWidth,
            loaded:
              card.querySelector('img').complete && card.querySelector('img').naturalWidth > 0,
          };
        }),
      };
    });
    assert.ok(Math.abs(geometry.sidebar.width - 328) < 1);
    assert.equal(geometry.cards.length, 4);
    assert.equal(
      geometry.sidebarFits,
      true,
      'Attachments remain within the narrow conversation panel.',
    );
    assert.equal(geometry.outsideComposer, true, 'Pending rows sit above the composer input card.');
    assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1);
    assert.equal(geometry.overflowY, 'auto');
    assert.ok(geometry.maxHeight > 0 && geometry.row.height <= geometry.maxHeight + 1);
    assert.ok(
      geometry.row.top < geometry.composer.top && geometry.row.bottom <= geometry.input.top + 1,
    );
    assert.ok(
      geometry.cards.some((card) => card.clipped),
      'Long comments visibly truncate in the compact row.',
    );
    for (const [index, card] of geometry.cards.entries()) {
      assert.ok(Math.abs(card.image.width - 40) < 1 && Math.abs(card.image.height - 40) < 1);
      if (index) assert.ok(card.bounds.top >= geometry.cards[index - 1].bounds.bottom - 1);
      assert.equal(card.whiteSpace, 'nowrap');
      assert.equal(card.textOverflow, 'ellipsis');
      assert.ok(card.label.height <= card.lineHeight + 1);
      assert.equal(card.loaded, true);
      assert.ok(
        card.remove.left >= card.label.right - 1 &&
          card.remove.right <= card.bounds.right + 1 &&
          card.remove.top >= card.bounds.top - 1 &&
          card.remove.bottom <= card.bounds.bottom + 1,
        'Each row keeps its right-side remove action reachable without covering the comment.',
      );
    }
    await composerStack.screenshot({
      path: `test-results/agent-attachments-328-${theme.toLowerCase()}.png`,
    });
    await pendingAttachments
      .getByRole('button', { name: 'Preview annotation 4', exact: true })
      .scrollIntoViewIfNeeded();
    if (geometry.scrollHeight > geometry.clientHeight) {
      // The final row can already be visible while only the tray's overlap padding overflows.
      await pendingAttachments.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      assert.ok(await pendingAttachments.evaluate((element) => element.scrollTop > 0));
    }
  }
  await pendingAttachments
    .getByRole('button', { name: 'Preview annotation 4', exact: true })
    .click();
  const attachmentDialog = page.getByRole('dialog', { name: 'Edit annotation', exact: true });
  await attachmentDialog.waitFor();
  assert.equal(
    await attachmentDialog.locator('.agent-annotation-preview img').getAttribute('src'),
    queued[3].image.dataUrl,
  );
  assert.equal(
    await attachmentDialog.getByRole('textbox', { name: 'Annotation comment' }).inputValue(),
    queued[3].comment,
  );
  await attachmentDialog.screenshot({ path: 'test-results/agent-attachment-preview-dark.png' });
  await attachmentDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.deepEqual(
    queuedAnnotations(),
    queued,
    'Preview and cancellation preserve every queued snapshot.',
  );
  assert.equal(sent.length, 0);
  await chooseTheme(originalTheme === 'dark' ? 'Dark' : 'Light');
  await divider.dblclick();
  await page.waitForFunction(
    (width) =>
      Math.abs(
        document.querySelector('.chat-panel:not([hidden])').getBoundingClientRect().width - width,
      ) < 1,
    originalSidebarWidth,
  );
  await writeFile(
    'test-results/agent-annotation-crop.png',
    Buffer.from(queued[2].image.dataUrl.split(',')[1], 'base64'),
  );
  await button('Select elements').click();
  await page.getByTestId('part-C1').click();
  await page.getByRole('alert').filter({ hasText: 'up to 4' }).waitFor();
  await button('Dismiss annotation error').click();
  await button('Hide annotations').click();
  assert.equal(await page.locator('.annotation-pin').count(), 0);
  await button('Show annotations').click();
  assert.equal(await page.locator('.annotation-pin').count(), 4);
  // Pan and zoom carry the marks in schematic coordinates, never move components.
  const pin = await button('Edit canvas annotation 1').boundingBox();
  await page.mouse.move(bounds.x + 70, bounds.y + 80);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(bounds.x + 90, bounds.y + 100);
  await page.mouse.up({ button: 'right' });
  const movedPin = await button('Edit canvas annotation 1').boundingBox();
  assert.ok(Math.abs(movedPin.x - pin.x - 20) < 2);
  assert.ok(Math.abs(movedPin.y - pin.y - 20) < 2);
  await canvas.press('Delete');
  await canvas.press('r');
  await exportCanvasImage(page);
  await page.waitForFunction(() => window.exportedImages.length === 2);
  const pannedImage = await page.evaluate(() => window.exportedImages[1]);
  await writeFile(
    'test-results/schematic-export-panned.png',
    Buffer.from(pannedImage.dataUrl.split(',')[1], 'base64'),
  );
  assert.deepEqual(
    { width: pannedImage.width, height: pannedImage.height },
    { width: schematicImage.width, height: schematicImage.height },
    'Pan and annotations preserve complete PNG bounds.',
  );
  const pannedPixels = await sharp(Buffer.from(pannedImage.dataUrl.split(',')[1], 'base64'))
    .removeAlpha()
    .raw()
    .toBuffer();
  let changedPixels = 0,
    maxDelta = 0;
  for (let i = 0; i < pixels.length; i += 3) {
    const delta =
      Math.abs(pixels[i] - pannedPixels[i]) +
      Math.abs(pixels[i + 1] - pannedPixels[i + 1]) +
      Math.abs(pixels[i + 2] - pannedPixels[i + 2]);
    if (delta) changedPixels++;
    maxDelta = Math.max(maxDelta, delta);
  }
  assert.ok(
    // Camera matrix rounding can shift a few antialiasing channels by one level.
    changedPixels <= 64 && maxDelta <= 6,
    `Export omits overlays and preserves ink after pan, allowing only subpixel raster rounding (${changedPixels} pixels, delta ${maxDelta}).`,
  );
  await page.evaluate(() => {
    window.imageExportMode = 'cancel';
  });
  await exportCanvasImage(page);
  await page.waitForFunction(() => window.exportedImages.length === 3);
  await page.evaluate(() => {
    window.imageExportMode = 'error';
  });
  await exportCanvasImage(page);
  await page.getByText('Simulated PNG save failure.', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.imageExportMode = undefined;
  });
  assert.equal(
    await (
      await openCanvasContextMenu(page)
    )
      .getByRole('menuitem', { name: 'Export image', exact: true })
      .isEnabled(),
    true,
    'Failed/cancelled saves release export state.',
  );
  await page.keyboard.press('Escape');
  await button('Source').click();
  assert.deepEqual(await readNativeFiles(page), nativeBaseline);
  await button('Schematic').click();
  // Pending annotations are session-local, and survive project switches and recovery.
  await page
    .locator('.project-navigation > span')
    .first()
    .locator('.project-folder > button')
    .click();
  assert.equal(await page.locator('.annotation-pin').count(), 0);
  await page.locator('.project-navigation .project-session').last().click();
  await button('Annotation mode').click();
  assert.equal(await page.locator('.annotation-pin').count(), 4);
  await page.locator('.nav-rail').getByRole('button', { name: 'New project', exact: true }).click();
  assert.equal(await page.getByLabel('Pending annotations', { exact: true }).count(), 0);
  await page.locator('.project-navigation .project-session').first().click();
  await page.getByLabel('Pending annotations', { exact: true }).waitFor();
  await page.waitForTimeout(900);
  await mount();
  await button('Annotation mode').click();
  assert.equal(await page.locator('.annotation-pin').count(), 4);
  await button('Source').click();
  const changed = structuredClone(parseProject(source));
  changed.schematic.parts[0].value = '2k';
  await fillNativeProject(page, changed);
  // Hidden schematic tools retain their last presentation until reveal. Assert
  // the current Source draft and the absence of interactive annotation tools.
  await page
    .getByRole('region', { name: 'Project source', exact: true })
    .getByRole('button', { name: 'Apply', exact: true })
    .click({ trial: true });
  assert.equal(await page.getByRole('button', { name: 'Annotation mode', exact: true }).count(), 0);
  assert.equal(
    await page.getByRole('toolbar', { name: 'Annotation tools', exact: true }).count(),
    0,
  );
  assert.deepEqual(state.documents[0].sessions[0].annotations, queued);
  await button('Apply').click();
  const staleBadges = pendingAttachments.getByText('Earlier capture', { exact: true });
  assert.equal(await staleBadges.count(), 4);
  for (const badge of await staleBadges.all())
    assert.equal(await badge.getAttribute('aria-description'), 'Captured before latest edits');
  await button('Schematic').click();
  await button('Annotation mode').click();
  assert.equal(await page.locator('.annotation-pin').count(), 0);
  await button('Interaction mode').click();
  await button('Undo').click();
  await button('Annotation mode').click();
  assert.equal(await page.locator('.annotation-pin').count(), 4);
  await button('Settings').click();
  await page.getByRole('radio', { name: 'Dark', exact: true }).check();
  await button('Done').click();
  await page.setViewportSize({ width: 1000, height: 680 });
  await button('View annotations').click();
  await page.screenshot({ path: 'test-results/agent-annotation-compact-dark.png' });
  const toolbar = await page.getByRole('toolbar', { name: 'Annotation tools' }).boundingBox();
  assert.ok(
    toolbar.x >= 0 &&
      toolbar.y >= 0 &&
      toolbar.x + toolbar.width <= 1000 &&
      toolbar.y + toolbar.height <= 680,
  );
  await button('View annotations').click();
  // A single explicit send includes all four immutable image/metadata snapshots.
  await button('Send message').click();
  await page.getByText('Mock response', { exact: true }).waitFor();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].annotations, queued);
  assert.equal(await page.locator('.annotation-pin').count(), 0);
  assert.equal(await page.getByLabel('Pending annotations', { exact: true }).count(), 0);
  assert.equal(await page.getByLabel('Message annotations', { exact: true }).count(), 1);
  const sentAttachments = page.getByLabel('Message annotations', { exact: true });
  assert.match(await sentAttachments.innerText(), /Check the resistor value\./);
  assert.equal(await sentAttachments.locator('.annotation-attachment-remove').count(), 0);
  assert.doesNotMatch(
    await sentAttachments.getAttribute('class'),
    /annotation-attachments-pending/,
  );
  assert.equal(await page.locator('.file-tab .dirty-dot').count(), 0);
  // Cancellation and removal never create another provider request.
  // Resizing preserves drawing scale/origin; bring the test target back inside the compact canvas.
  await runCanvasAction(page, 'Fit to canvas');
  await button('Select elements').click();
  await page.getByTestId('part-C1').click();
  await comment.waitFor();
  await comment.fill('Cancel this capture.');
  await comment.dispatchEvent('keydown', { key: 'Escape', code: 'Escape', isComposing: true });
  assert.equal(await comment.count(), 1, 'IME Escape leaves the local comment open.');
  await comment.press('Escape');
  assert.equal(await comment.count(), 0);
  await waitQueuedAnnotations((items) => items.length === 0);
  assert.equal(await pendingAttachments.count(), 0);
  await page.getByTestId('part-C1').click();
  await comment.fill('Cancel from the editor button.');
  await button('Cancel annotation').click();
  assert.equal(await comment.count(), 0);
  assert.deepEqual(queuedAnnotations(), []);
  assert.equal(await pendingAttachments.count(), 0);
  await page.getByTestId('part-C1').click();
  await comment.fill('Remove me');
  await comment.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  assert.equal(await comment.count(), 1, 'IME Enter must not finish the comment.');
  await comment.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229 });
  assert.equal(await comment.count(), 1, 'IME key code 229 never commits a comment.');
  await comment.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', repeat: true });
  assert.equal(await comment.count(), 1, 'A repeated Enter never commits a comment.');
  assert.deepEqual(queuedAnnotations(), []);
  assert.equal(await pendingAttachments.count(), 0);
  assert.equal(sent.length, 1);
  await comment.press('Shift+Enter');
  assert.equal(await comment.count(), 1, 'Shift+Enter adds a line without queueing the draft.');
  await comment.press('Enter');
  assert.equal(await comment.count(), 0);
  const entered = await waitQueuedAnnotations((items) => items.length === 1);
  assert.equal(entered[0].comment, 'Remove me');
  assert.equal(await pendingAttachments.locator('.annotation-attachment').count(), 1);
  assert.equal(
    sent.length,
    1,
    'Enter adds one attachment and leaves provider submission explicit.',
  );
  await button('Edit canvas annotation 1').click();
  await button('Delete annotation').click();
  await waitQueuedAnnotations((items) => items.length === 0);
  assert.equal(await page.locator('.annotation-pin').count(), 0);
  await button('Draw rectangle').click();
  const smallCanvas = await canvas.boundingBox();
  await page.mouse.move(smallCanvas.x + 30, smallCanvas.y + 40);
  await page.mouse.down();
  await page.mouse.move(smallCanvas.x + 100, smallCanvas.y + 100, { steps: 5 });
  await page.mouse.up();
  await comment.fill('An empty area');
  await comment.press('Enter');
  await button('Exit annotation mode').click();
  await page.getByLabel('Pending annotations', { exact: true }).waitFor();
  await pendingAttachments
    .getByRole('button', { name: 'Remove annotation 1', exact: true })
    .click();
  await waitQueuedAnnotations((items) => items.length === 0);
  await button('Annotation mode').click();
  assert.equal(await page.locator('.annotation-pin').count(), 0);
  assert.equal(await page.getByLabel('Pending annotations', { exact: true }).count(), 0);
  await button('Source').click();
  assert.deepEqual(await readNativeFiles(page), nativeBaseline);
  // A capture completing after navigation cannot reopen an obsolete local editor.
  await button('Schematic').click();
  await button('Annotation mode').click();
  await button('Select elements').click();
  await page.evaluate(() => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    window.restoreAnnotationImage = () =>
      Object.defineProperty(HTMLImageElement.prototype, 'src', descriptor);
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      ...descriptor,
      set(value) {
        if (value.startsWith('blob:')) setTimeout(() => descriptor.set.call(this, value), 350);
        else descriptor.set.call(this, value);
      },
    });
  });
  await page.getByTestId('part-C1').click();
  await button('Source').click();
  await page.waitForTimeout(500);
  await page.evaluate(() => window.restoreAnnotationImage());
  await button('Schematic').click();
  await button('Annotation mode').click();
  assert.equal(await comment.count(), 0);
  assert.equal(await page.getByLabel('Pending annotations', { exact: true }).count(), 0);
  assert.equal(sent.length, 1);
  // Model shares the mode toolbar and comment UI, capturing WebGL rather than an SVG substitute.
  await page.setViewportSize({ width: 1440, height: 960 });
  await button('Interaction mode').click();
  const schematicModeBox = await button('Annotation mode').boundingBox();
  assert.equal(await page.locator('.schematic-drawing .zoom-controls').count(), 0);
  await button('Model').click();
  try {
    await page.waitForFunction(
      () =>
        document.querySelector('.pcb-model-canvas canvas')?.width > 0 &&
        !document.querySelector('.pcb-model-preview .pcb-model-status'),
    );
  } catch (error) {
    console.log(await page.locator('.pcb-3d-surface').innerText());
    console.log(
      await page.locator('.pcb-model-canvas').evaluate((node) => ({
        width: node.clientWidth,
        height: node.clientHeight,
        html: node.innerHTML,
      })),
    );
    await page.screenshot({ path: 'test-results/agent-annotation-object-failure.png' });
    throw error;
  }
  assert.equal(await page.getByText('3D board', { exact: true }).count(), 0);
  assert.equal(await button('Interaction mode').getAttribute('aria-pressed'), 'true');
  const objectModeBox = await button('Annotation mode').boundingBox();
  assert.equal(objectModeBox.width, schematicModeBox.width);
  assert.equal(objectModeBox.height, schematicModeBox.height);
  assert.equal(await page.locator('.pcb-model-preview .zoom-controls').count(), 0);
  const boardCanvas = page.locator('.pcb-model-canvas canvas');
  const readModelScale = () => page.locator('.pcb-model-preview .model-spatial-scale').innerHTML();
  const beforeActualSize = await page
    .locator('.pcb-model-canvas')
    .getAttribute('data-render-count');
  await runCanvasAction(page, 'Actual size (100%)');
  await page.waitForFunction(
    (before) =>
      Number(document.querySelector('.pcb-model-canvas')?.dataset.renderCount) > Number(before),
    beforeActualSize,
  );
  const actualScale = await readModelScale();
  const unzoomed = await boardCanvas.screenshot();
  await runCanvasAction(page, 'Zoom in');
  await page.waitForFunction(
    (previous) =>
      document.querySelector('.pcb-model-preview .model-spatial-scale')?.innerHTML !== previous,
    actualScale,
  );
  assert.ok(
    !unzoomed.equals(await boardCanvas.screenshot()),
    'Zoom changes the rendered board scale.',
  );
  await runCanvasAction(page, 'Zoom out');
  await page.waitForFunction(
    (previous) =>
      document.querySelector('.pcb-model-preview .model-spatial-scale')?.innerHTML === previous,
    actualScale,
  );
  await boardCanvas.hover();
  await page.mouse.wheel(0, -200);
  await page.waitForFunction(
    (previous) =>
      document.querySelector('.pcb-model-preview .model-spatial-scale')?.innerHTML !== previous,
    actualScale,
  );
  const retainedScale = await readModelScale();
  await button('Source').click();
  await button('Model').click();
  assert.equal(await readModelScale(), retainedScale, 'Model retains zoom through view switches.');
  assert.equal(await page.locator('.pcb-model-preview .zoom-controls').count(), 0);
  await runCanvasAction(page, 'Fit 3D board');
  assert.equal(
    await page
      .getByRole('group', { name: 'Model tools' })
      .getByRole('button', { name: 'Fit 3D board', exact: true })
      .count(),
    0,
  );
  await selectModelView(page, 'Top view');
  await button('Annotation mode').click();
  const objectCanvas = page.getByLabel('3D annotation canvas', { exact: true });
  const element = objectCanvas.locator('[data-selection-id]').first();
  await element.waitFor();
  const body = await element.boundingBox();
  await openDisplayDrawer(page, 'Selection');
  const objectFilters = page.getByRole('group', { name: 'Selection', exact: true });
  await objectFilters.getByRole('checkbox', { name: 'Solids', exact: true }).uncheck();
  await closeDisplayDrawer(page, 'Selection');
  await page.waitForFunction(
    () => document.querySelector('.pcb-model-canvas').dataset.modelsSelectable === 'false',
  );
  assert.equal(
    await objectCanvas.locator('[data-selection-id]').count(),
    0,
    'Disabled solid selection removes component rectangle-selection candidates in Model.',
  );
  await page.mouse.click(body.x + body.width / 2, body.y + body.height / 2);
  assert.equal(
    await comment.count(),
    0,
    'Disabled solid selection prevents component raycast selection without hiding the Model.',
  );
  await openDisplayDrawer(page, 'Selection');
  await objectFilters.getByRole('checkbox', { name: 'Solids', exact: true }).check();
  await closeDisplayDrawer(page, 'Selection');
  await element.waitFor();
  await page.mouse.click(body.x + body.width / 2, body.y + body.height / 2);
  await comment.fill('Check this package in 3D.');
  await button('Add').click();
  assert.equal(await page.locator('.pcb-object-annotations .annotation-pin').count(), 1);
  await page.waitForTimeout(900);
  const objectAnnotation = structuredClone(state.documents[0].sessions[0].annotations[0]);
  assert.equal(objectAnnotation.target, 'object');
  assert.equal(objectAnnotation.elements[0].kind, 'footprint');
  const objectPixels = await sharp(
    Buffer.from(objectAnnotation.image.dataUrl.split(',')[1], 'base64'),
  )
    .removeAlpha()
    .raw()
    .toBuffer();
  assert.ok(
    objectPixels.some(
      (channel, i) =>
        i % 3 === 2 && channel > objectPixels[i - 2] + 60 && channel > objectPixels[i - 1] + 30,
    ),
    'Model element captures retain their blue silhouette.',
  );
  assert.match(objectAnnotation.viewBasis, /^\d+:\d+:\d+$/);
  await openDisplayDrawer(page, 'Selection');
  await objectFilters.getByRole('checkbox', { name: 'Solids', exact: true }).uncheck();
  await closeDisplayDrawer(page, 'Selection');
  assert.equal(
    await page.locator('.pcb-object-annotations .annotation-pin').count(),
    1,
    'Selection filtering preserves saved annotation pins in an unchanged rendered view.',
  );
  await button('Selection').click();
  await objectFilters.getByRole('checkbox', { name: 'Solids', exact: true }).check();
  await objectFilters.getByRole('button', { name: 'Selection', exact: true }).click();
  await writeFile(
    'test-results/agent-annotation-object-crop.png',
    Buffer.from(objectAnnotation.image.dataUrl.split(',')[1], 'base64'),
  );
  await selectModelView(page, 'Bottom view');
  await page.waitForFunction(
    () => !document.querySelector('.pcb-object-annotations .annotation-pin'),
  );
  await button('View annotations').click();
  await page.getByText('Captured from another view', { exact: true }).waitFor();
  await button('View annotations').click();
  await button('Draw rectangle').click();
  const objectBounds = await objectCanvas.boundingBox();
  await page.mouse.move(objectBounds.x + 40, objectBounds.y + 40);
  await page.mouse.down();
  await page.mouse.move(objectBounds.x + 140, objectBounds.y + 100, { steps: 5 });
  await page.mouse.up();
  await comment.fill('Check the board clearance here.');
  await comment.press('Enter');
  await button('Draw freehand').click();
  await page.mouse.move(objectBounds.x + 50, objectBounds.y + 150);
  await page.mouse.down();
  await page.mouse.move(objectBounds.x + 100, objectBounds.y + 175, { steps: 5 });
  await page.mouse.move(objectBounds.x + 150, objectBounds.y + 150, { steps: 5 });
  await page.mouse.up();
  await comment.fill('Inspect this edge.');
  await comment.press('Enter');
  await page.screenshot({ path: 'test-results/agent-annotation-object.png' });
  await button('Layout').click();
  await button('Annotation mode').click();
  assert.equal(
    await page.locator('.annotation-pin:visible').count(),
    0,
    'Model screen marks never appear on Layout.',
  );
  await button('Schematic').click();
  await button('Annotation mode').click();
  assert.equal(
    await page.locator('.annotation-pin:visible').count(),
    0,
    'Model screen marks never appear on Schematic.',
  );
  await button('Source').click();
  assert.deepEqual(await readNativeFiles(page), nativeBaseline);
  await page.waitForTimeout(900);
  assert.equal(state.documents[0].dirty, false);
  const objectQueued = structuredClone(state.documents[0].sessions[0].annotations);
  assert.equal(objectQueued.length, 3);
  assert.equal(objectQueued[1].markup.kind, 'rectangle');
  assert.equal(objectQueued[2].markup.kind, 'freehand');
  await mount();
  await button('Model').click();
  await button('Annotation mode').click();
  await button('View annotations').click();
  await page.getByText('Check this package in 3D.', { exact: true }).last().waitFor();
  await button('View annotations').click();
  await button('Send message').click();
  await page.waitForFunction(
    () => !document.querySelector('.annotation-attachments[aria-label="Pending annotations"]'),
  );
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].annotations, objectQueued);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: complete schematic PNG export, overlay-free pixels, cancellation/errors, shared mode controls, context-menu/wheel zoom without floating controls, Model annotations, recovery and clean project data.',
  );
} finally {
  await browser.close();
}
