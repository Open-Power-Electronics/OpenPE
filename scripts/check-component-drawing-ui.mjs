import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { waitForAsync } from './async-browser-test-helpers.mjs';

// Isolated renderer with actual Core/capability/native-file implementations.
// No Electron, kernel or service runs.
const bundle = await build({
  stdin: {
    contents: `import React,{useState,useSyncExternalStore}from'react';
import{createRoot}from'react-dom/client';
import Editor from'./components/ComponentDrawingEditor';
import{ProjectCore}from'./core/project-core';
import{registerProjectCapabilities}from'./core/register-project';
import{createCapabilityHost}from'./api/capabilities';
import{createProject,projectNativeFiles,projectFromNativeFiles}from'./lib/project';
import{createEmptyPCB}from'./lib/pcb-layout';
import{readFootprintDrawing}from'./lib/footprint-drawing';
let project=createProject();project.pcb=createEmptyPCB();
const core=new ProjectCore(project),host=createCapabilityHost({revision:()=>String(core.getSnapshot().revision)});
registerProjectCapabilities(host,core);
function Harness(){const snapshot=useSyncExternalStore(listener=>core.subscribe(listener),()=>core.getSnapshot());
const[opened,setOpened]=useState({tab:'symbol',key:0}),[shown,setShown]=useState(true);
window.componentDrawing={core,host,open:tab=>{setOpened(old=>({tab,key:old.key+1}));setShown(true);},
state:()=>({project:core.getSnapshot().project,revision:core.getSnapshot().revision,undo:core.getSnapshot().undoDepth}),
native:()=>projectNativeFiles(core.getSnapshot().project).files,
reopened:()=>projectFromNativeFiles(projectNativeFiles(core.getSnapshot().project)),
change:()=>core.execute('project.rename',{name:'External change'}),
changeTarget:()=>{const board=core.getSnapshot().project.pcb,target=board.footprints[0],drawing=readFootprintDrawing(target);
drawing.graphics[0].width=0.23;return core.execute('layout.footprint.draw',{boardId:board.id,footprintId:target.id,name:'Existing',drawing});},
applied:window.componentDrawing?.applied??[]};
return shown?<Editor key={opened.key} project={snapshot.project} schematic={snapshot.project.schematic}
capabilityHost={host} revision={String(snapshot.revision)} initialTab={opened.tab}
onClose={()=>setShown(false)} onApplied={(kind,id)=>window.componentDrawing.applied.push({kind,id})}
/>:<button onClick={()=>setShown(true)}>Reopen editor</button>;}
createRoot(document.getElementById('root')).render(<Harness/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outfile: 'test-results/component-drawing-ui.js',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
});
await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/', async (route) => {
    return route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body><div id="root"></div></body></html>',
    });
  });
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
    await page.addStyleTag({ content: file.text });
  await page.addScriptTag({
    content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
  });
  const dialog = page.getByRole('dialog', { name: 'Draw component', exact: true });
  const button = (name) => dialog.getByRole('button', { name, exact: true });
  const typeTab = (name) => dialog.getByRole('tab', { name, exact: true });
  const inspector = dialog.getByRole('complementary', { name: 'Drawing properties', exact: true });
  const placement = dialog
    .locator('details')
    .filter({ has: page.locator('summary[aria-label="Placement"]') });
  const canvas = dialog.locator('svg[aria-label$="drawing canvas"]');
  const objects = (kind) => canvas.locator(`[data-drawing-kind="${kind}"]`);
  const viewBox = () => canvas.getAttribute('viewBox');
  const state = () => page.evaluate(() => window.componentDrawing.state());
  const open = async (tab) => {
    await page.evaluate((tab) => window.componentDrawing.open(tab), tab);
    await dialog.waitFor();
  };
  async function screenPoint(x, y) {
    return canvas.evaluate(
      (svg, point) => {
        const target = new DOMPoint(point.x, point.y).matrixTransform(svg.getScreenCTM());
        return { x: target.x, y: target.y };
      },
      { x, y },
    );
  }
  async function clickDrawing(x, y) {
    const coordinate = await screenPoint(x, y);
    await page.mouse.click(coordinate.x, coordinate.y);
  }
  async function dragDrawing(from, to) {
    const start = await screenPoint(...from),
      end = await screenPoint(...to);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 6 });
    await page.mouse.up();
  }
  async function panDrawing(mouseButton = 'middle') {
    const box = await canvas.boundingBox();
    const start = { x: box.x + box.width * 0.45, y: box.y + box.height * 0.45 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down({ button: mouseButton });
    await page.mouse.move(start.x + 45, start.y + 25, { steps: 5 });
    await page.mouse.up({ button: mouseButton });
  }
  async function wheelZoom(deltaY) {
    const bounds = await canvas.boundingBox();
    await canvas.dispatchEvent('wheel', {
      deltaY,
      clientX: bounds.x + bounds.width * 0.6,
      clientY: bounds.y + bounds.height * 0.4,
    });
  }
  async function assertZoomScale(action, factor, label) {
    const before = (await viewBox()).split(' ').map(Number);
    await action();
    await canvas.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    const after = (await viewBox()).split(' ').map(Number);
    assert.ok(Math.abs(after[2] / before[2] - factor) < 0.000001, label);
    if (factor === 1) assert.deepEqual(after, before, `${label}: no camera drift at the limit.`);
  }
  async function assertViewport(label) {
    await waitForAsync(page, () => {
      const svg = document.querySelector('svg[aria-label$="drawing canvas"]');
      const box = svg.getBoundingClientRect(),
        view = svg.viewBox.baseVal;
      return (
        box.width > 0 &&
        box.height > 0 &&
        Math.abs(view.width / view.height - box.width / box.height) < 0.001
      );
    });
    const metrics = await canvas.evaluate((svg) => {
      const box = svg.getBoundingClientRect(),
        view = svg.viewBox.baseVal;
      const matrix = svg.getScreenCTM();
      const project = (x, y) => {
        const point = new DOMPoint(x, y).matrixTransform(matrix);
        return { x: point.x, y: point.y };
      };
      const background = svg.querySelector('[data-drawing-background]');
      const pattern = svg.querySelector('[data-drawing-grid]');
      const dot = pattern.querySelector('circle');
      const origin = svg.querySelector('[data-drawing-origin]');
      const backgroundBox = background.getBBox();
      const scale = Math.hypot(matrix.a, matrix.b);
      const axisStart = origin.getPointAtLength(0);
      const axisRight = origin.getPointAtLength(view.width);
      const axisBottom = origin.getPointAtLength(origin.getTotalLength());
      return {
        viewport: { x: box.x, y: box.y, width: box.width, height: box.height },
        view: { x: view.x, y: view.y, width: view.width, height: view.height },
        scaleX: scale,
        scaleY: Math.hypot(matrix.c, matrix.d),
        topLeft: project(view.x, view.y),
        bottomRight: project(view.x + view.width, view.y + view.height),
        backgroundTopLeft: project(backgroundBox.x, backgroundBox.y),
        backgroundBottomRight: project(
          backgroundBox.x + backgroundBox.width,
          backgroundBox.y + backgroundBox.height,
        ),
        axisStart: project(axisStart.x, axisStart.y),
        axisRight: project(axisRight.x, axisRight.y),
        axisBottom: project(axisBottom.x, axisBottom.y),
        axisLength: origin.getTotalLength(),
        axisStroke: Number(getComputedStyle(origin).strokeWidth.replace('px', '')),
        axisEffect: getComputedStyle(origin).vectorEffect,
        grid: {
          spacing: pattern.width.baseVal.value,
          pixels: pattern.width.baseVal.value * scale,
          radiusPixels: dot.r.baseVal.value * scale,
          radius: dot.r.baseVal.value,
          x: pattern.x.baseVal.value,
          y: pattern.y.baseVal.value,
          cx: dot.cx.baseVal.value,
          cy: dot.cy.baseVal.value,
          height: pattern.height.baseVal.value,
        },
      };
    });
    const near = (actual, expected, message, tolerance = 0.1) =>
      assert.ok(
        Math.abs(actual - expected) <= tolerance,
        `${label}: ${message} (${actual} versus ${expected})`,
      );
    const { viewport, view, grid } = metrics;
    near(metrics.scaleX, metrics.scaleY, 'world X/Y have the same scale', 0.000001);
    for (const point of [metrics.topLeft, metrics.backgroundTopLeft]) {
      near(point.x, viewport.x, 'drawing/grid reaches the left edge');
      near(point.y, viewport.y, 'drawing/grid reaches the top edge');
    }
    for (const point of [metrics.bottomRight, metrics.backgroundBottomRight]) {
      near(point.x, viewport.x + viewport.width, 'drawing/grid reaches the right edge');
      near(point.y, viewport.y + viewport.height, 'drawing/grid reaches the bottom edge');
    }
    near(metrics.axisStart.x, viewport.x, 'horizontal origin axis starts at the viewport edge');
    near(
      metrics.axisRight.x,
      viewport.x + viewport.width,
      'horizontal origin axis ends at the viewport edge',
    );
    near(
      metrics.axisBottom.y,
      viewport.y + viewport.height,
      'vertical origin axis ends at the viewport edge',
    );
    near(
      metrics.axisLength,
      view.width + view.height,
      'origin axes cover both viewport spans',
      (view.width + view.height) * 0.000001,
    );
    assert.equal(
      metrics.axisEffect,
      'non-scaling-stroke',
      `${label}: origin strokes stay in screen pixels`,
    );
    near(metrics.axisStroke, 1, 'origin stroke stays one pixel');
    assert.ok(
      grid.radiusPixels > 0 && grid.radiusPixels <= 0.81,
      `${label}: bounded grid dots (${grid.radiusPixels}px)`,
    );
    assert.ok(
      grid.pixels >= 5.99,
      `${label}: zooming out thins displayed grid dots (${grid.pixels}px)`,
    );
    assert.ok(
      grid.cx > grid.radius &&
        grid.cy > grid.radius &&
        grid.cx + grid.radius < grid.spacing &&
        grid.cy + grid.radius < grid.height,
      `${label}: dots stay inside pattern cells instead of being clipped into quarter circles`,
    );
    near(grid.x + grid.cx, 0, 'grid remains anchored to world X = 0', 0.000001);
    near(grid.y + grid.cy, 0, 'grid remains anchored to world Y = 0', 0.000001);
    return metrics;
  }
  const apply = async () => {
    await button('Apply drawing').click();
    await dialog.waitFor({ state: 'hidden' });
  };
  await dialog.waitFor();
  const initialState = await state();
  assert.equal(await dialog.getByRole('tab').count(), 2);
  assert.equal(
    await typeTab('3D model').count(),
    0,
    'Drawing types contain only symbols and footprints.',
  );
  for (const name of [
    'Select',
    'Rectangle',
    'Circle',
    'Line',
    'Pin',
    'Reset drawing',
    'Cancel',
    'Apply drawing',
  ]) {
    assert.equal(
      (await button(name).textContent()).trim(),
      '',
      `${name} uses an icon without repeated text.`,
    );
    assert.equal(
      await button(name).getAttribute('title'),
      name,
      `${name} remains identifiable on hover.`,
    );
  }
  assert.equal(await inspector.count(), 0, 'The empty editor gives its full width to the canvas.');
  assert.equal(await placement.count(), 0, 'Placement is not a prerequisite for drawing.');
  assert.equal(await dialog.getByLabel('Placement X', { exact: true }).isVisible(), false);
  const initialNative = await page.evaluate(() => window.componentDrawing.native());
  const wideViewport = await assertViewport('Wide empty canvas');
  assert.ok(wideViewport.viewport.width > wideViewport.viewport.height);
  await panDrawing('right');
  await assertViewport('Panned empty canvas');
  const originalDialogStyle = await dialog.getAttribute('style');
  for (let index = 0; index < 16; index++) await button('Zoom in drawing').click();
  await assertViewport('Maximum zoom in');
  await dialog.evaluate((element) => {
    element.style.height = '500px';
  });
  const shrunkViewport = await assertViewport('Shrunk canvas beyond the zoom-in limit');
  assert.ok(Math.min(shrunkViewport.view.width, shrunkViewport.view.height) / 2 < 1);
  await assertZoomScale(
    () => button('Zoom in drawing').click(),
    1,
    'Zoom in does not reverse after shrinking at the limit',
  );
  await assertZoomScale(
    () => wheelZoom(-100),
    1,
    'Wheel zoom in does not reverse after shrinking at the limit',
  );
  await assertZoomScale(
    () => button('Zoom out drawing').click(),
    1.5,
    'Zoom out remains smooth below the normal lower extent limit',
  );
  await assertZoomScale(
    () => wheelZoom(100),
    Math.exp(0.2),
    'Wheel zoom out remains smooth below the normal lower extent limit',
  );
  for (let index = 0; index < 64; index++) await button('Zoom out drawing').click();
  await assertViewport('Maximum zoom out');
  await dialog.evaluate((element, style) => {
    if (style === null) element.removeAttribute('style');
    else element.setAttribute('style', style);
  }, originalDialogStyle);
  const enlargedViewport = await assertViewport('Enlarged canvas beyond the zoom-out limit');
  assert.ok(Math.min(enlargedViewport.view.width, enlargedViewport.view.height) / 2 > 100000);
  await assertZoomScale(
    () => button('Zoom out drawing').click(),
    1,
    'Zoom out does not reverse after enlarging at the limit',
  );
  await assertZoomScale(
    () => wheelZoom(100),
    1,
    'Wheel zoom out does not reverse after enlarging at the limit',
  );
  await assertZoomScale(
    () => button('Zoom in drawing').click(),
    1 / 1.5,
    'Zoom in remains smooth above the normal upper extent limit',
  );
  await assertZoomScale(
    () => wheelZoom(-100),
    Math.exp(-0.2),
    'Wheel zoom in remains smooth above the normal upper extent limit',
  );
  await button('Fit drawing').click();
  const originalTheme = await page.locator('html').getAttribute('data-theme');
  await page.locator('html').evaluate((element) => element.setAttribute('data-theme', 'dark'));
  for (let index = 0; index < 3; index++) await button('Zoom in drawing').click();
  await panDrawing('right');
  await assertViewport('Dark zoomed and panned canvas');
  await dialog.screenshot({ path: 'test-results/component-drawing-dark-zoom-ui.png' });
  await page.locator('html').evaluate((element, theme) => {
    if (theme === null) element.removeAttribute('data-theme');
    else element.setAttribute('data-theme', theme);
  }, originalTheme);
  await button('Fit drawing').click();
  await dialog.evaluate((element) => {
    element.style.width = '420px';
    element.style.height = '900px';
  });
  const portraitViewport = await assertViewport('Portrait empty canvas');
  assert.ok(portraitViewport.viewport.height > portraitViewport.viewport.width);
  await panDrawing();
  await assertViewport('Panned portrait canvas');
  await dialog.screenshot({ path: 'test-results/component-drawing-portrait-ui.png' });
  await dialog.evaluate((element, style) => {
    if (style === null) element.removeAttribute('style');
    else element.setAttribute('style', style);
  }, originalDialogStyle);
  await button('Fit drawing').click();
  await assertViewport('Restored wide canvas');
  assert.deepEqual(await state(), initialState, 'Zoom, pan and resize never change Core.');
  assert.deepEqual(
    await page.evaluate(() => window.componentDrawing.native()),
    initialNative,
    'Viewport changes preserve native bytes.',
  );
  await dialog.screenshot({ path: 'test-results/component-drawing-empty-ui.png' });
  await typeTab('Symbol').focus();
  await typeTab('Symbol').press('ArrowRight');
  assert.equal(await typeTab('Footprint').getAttribute('aria-selected'), 'true');
  await typeTab('Footprint').press('ArrowRight');
  assert.equal(await typeTab('Symbol').getAttribute('aria-selected'), 'true');
  await typeTab('Symbol').press('End');
  assert.equal(await typeTab('Footprint').getAttribute('aria-selected'), 'true');
  await typeTab('Footprint').press('Home');
  assert.equal(await typeTab('Symbol').getAttribute('aria-selected'), 'true');
  const tabImeConsumed = await typeTab('Symbol').evaluate((element) => {
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowRight',
      keyCode: 229,
      which: 229,
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(tabImeConsumed, true);
  assert.equal(
    await typeTab('Symbol').getAttribute('aria-selected'),
    'true',
    'IME cannot switch drawing types.',
  );
  assert.deepEqual(await state(), initialState, 'Type navigation never changes Core.');
  assert.equal(await button('Apply drawing').isDisabled(), true, 'Empty drawings cannot apply.');
  await panDrawing('right');
  const beforeInspector = await assertViewport('Off-center canvas before selection');
  await button('Rectangle').click();
  await dragDrawing([-5.08, -3.81], [5.08, 3.81]);
  assert.equal(await objects('graphic').count(), 1, 'Dragging creates one shape.');
  assert.equal(await inspector.isVisible(), true, 'An accepted selection opens its properties.');
  const afterInspector = await assertViewport('Selected drawing with inspector');
  assert.ok(
    Math.abs(beforeInspector.scaleX - afterInspector.scaleX) < 0.000001,
    'Opening properties preserves the drawing scale.',
  );
  for (const [offset, size] of [
    ['x', 'width'],
    ['y', 'height'],
  ]) {
    assert.ok(
      Math.abs(
        beforeInspector.view[offset] +
          beforeInspector.view[size] / 2 -
          (afterInspector.view[offset] + afterInspector.view[size] / 2),
      ) < 0.000001,
      `Opening properties preserves the off-center ${offset} camera position.`,
    );
  }
  assert.equal(
    await placement.count(),
    1,
    'New drawings expose optional placement after geometry exists.',
  );
  assert.equal(await dialog.getByLabel('Placement X', { exact: true }).isVisible(), false);
  assert.equal((await placement.locator('summary').textContent()).trim(), '');
  assert.equal(await placement.locator('summary').getAttribute('title'), 'Placement');
  await placement.locator('summary').click();
  const placementX = dialog.getByLabel('Placement X', { exact: true });
  await placementX.fill('-');
  assert.equal(
    await button('Apply drawing').isDisabled(),
    true,
    'Invalid optional placement remains retryable.',
  );
  await placement.locator('summary').click();
  await placementX.waitFor({ state: 'visible' });
  assert.equal(await placementX.inputValue(), '-', 'Invalid placement cannot be hidden.');
  await placementX.dispatchEvent('compositionstart');
  await placementX.dispatchEvent('keydown', {
    key: 'Enter',
    keyCode: 229,
    isComposing: true,
    bubbles: true,
  });
  assert.equal(await dialog.isVisible(), true, 'Footer composition cannot apply the draft.');
  assert.deepEqual(await state(), initialState);
  await placementX.dispatchEvent('compositionend');
  await placementX.press('Escape');
  assert.equal(Number(await placementX.inputValue()), 50);
  await placement.locator('summary').focus();
  await placement.locator('summary').press('Escape');
  assert.equal(await placementX.isVisible(), false, 'Escape closes optional placement first.');
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await button('Apply drawing').isEnabled(), true, 'Drag release leaves no anchor.');
  await canvas.press('Control+z');
  assert.equal(await objects('graphic').count(), 0);
  assert.equal(await typeTab('Footprint').isEnabled(), true, 'Undo to the baseline unlocks tabs.');
  assert.equal(await inspector.count(), 0, 'Undo clears the selection inspector.');
  assert.equal(await placement.count(), 0, 'Undo to empty hides optional placement.');
  assert.equal(await dialog.getByLabel('Drawing target', { exact: true }).isEnabled(), true);
  await canvas.press('Control+y');
  assert.equal(await objects('graphic').count(), 1);
  await button('Undo drawing').click();
  await canvas.focus();
  await canvas.press('Control+Shift+z');
  assert.equal(await objects('graphic').count(), 1);
  await button('Reset drawing').click();
  assert.equal(await objects('graphic').count(), 0);
  assert.equal(await button('Redo drawing').isDisabled(), true);
  await dialog.getByLabel('Name', { exact: true }).fill('Unsaved name');
  assert.equal(
    await typeTab('Footprint').isDisabled(),
    true,
    'Metadata changes also retain the draft.',
  );
  await typeTab('Symbol').dispatchEvent('keydown', { key: 'ArrowRight', bubbles: true });
  assert.equal(
    await typeTab('Symbol').getAttribute('aria-selected'),
    'true',
    'Keyboard tabs retain an unapplied draft.',
  );
  await button('Reset drawing').click();
  assert.equal(await typeTab('Footprint').isEnabled(), true);

  await button('Line').click();
  await clickDrawing(-5.08, 0);
  assert.equal(await button('Undo drawing').isEnabled(), true, 'First click starts a stroke.');
  await canvas.press('Escape');
  assert.equal(await button('Line').getAttribute('aria-pressed'), 'true');
  assert.equal(await objects('graphic').count(), 0);
  await canvas.press('Escape');
  assert.equal(await button('Select').getAttribute('aria-pressed'), 'true');
  assert.equal(
    await dialog.isVisible(),
    true,
    'Escape cancels the tool before closing the editor.',
  );
  const repeatEscapeConsumed = await canvas.evaluate((element) => {
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      code: 'Escape',
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  });
  assert.equal(
    repeatEscapeConsumed,
    true,
    'Held Escape cannot trigger native dialog cancellation.',
  );
  assert.equal(await dialog.isVisible(), true);
  await button('Circle').click();
  await dragDrawing([0, 0], [3.81, 0]);
  assert.equal(await objects('graphic').count(), 1);
  assert.equal(Number(await dialog.getByLabel('Radius', { exact: true }).inputValue()), 3.81);
  await canvas.press('Delete');
  assert.equal(await objects('graphic').count(), 0);
  assert.equal(
    await button('Reset drawing').isDisabled(),
    true,
    'Deleting back to the baseline is clean.',
  );
  await dragDrawing([0, 0], [3.81, 0]);
  await dialog.getByLabel('Radius', { exact: true }).fill('1e308');
  await dialog.getByLabel('Center X', { exact: true }).fill('1e308');
  const beforeOverflowFit = await viewBox();
  await button('Fit drawing').click();
  await dialog.getByRole('alert').filter({ hasText: 'The drawing is too large to fit' }).waitFor();
  assert.equal(
    await viewBox(),
    beforeOverflowFit,
    'Overflowing Fit retains the previous viewport.',
  );
  assert.ok((await viewBox()).split(' ').map(Number).every(Number.isFinite));
  assert.equal(Number(await dialog.getByLabel('Radius', { exact: true }).inputValue()), 1e308);
  assert.equal(Number(await dialog.getByLabel('Center X', { exact: true }).inputValue()), 1e308);
  assert.equal(await dialog.getByLabel('Radius', { exact: true }).isEditable(), true);
  await button('Reset drawing').click();
  assert.equal(await objects('graphic').count(), 0);
  assert.equal(await dialog.getByRole('alert').count(), 0, 'Reset clears a retryable Fit error.');
  assert.equal(await typeTab('Footprint').isEnabled(), true);
  await button('Line').click();
  const cancelledStart = await screenPoint(-5.08, 0),
    cancelledEnd = await screenPoint(5.08, 0);
  await page.mouse.move(cancelledStart.x, cancelledStart.y);
  await page.mouse.down();
  await page.mouse.move(cancelledEnd.x, cancelledEnd.y, { steps: 4 });
  await canvas.press('Escape');
  await page.mouse.up();
  assert.equal(await objects('graphic').count(), 0, 'Releasing an escaped drag cannot commit it.');
  assert.equal(await button('Apply drawing').isDisabled(), true);
  await canvas.press('Escape');
  assert.equal(
    await button('Select').getAttribute('aria-pressed'),
    'true',
    'Escaped drag leaves no new anchor.',
  );
  assert.deepEqual(await state(), initialState, 'Local drawing history never changes Core.');

  await button('Line').click();
  const resizedStart = await screenPoint(-5.08, 0),
    resizedEnd = await screenPoint(5.08, 0);
  await page.mouse.move(resizedStart.x, resizedStart.y);
  await page.mouse.down();
  await page.mouse.move(resizedEnd.x, resizedEnd.y, { steps: 4 });
  await dialog.evaluate((element) => {
    element.style.width = '900px';
  });
  await assertViewport('Resize during a held drawing gesture');
  await page.mouse.up();
  assert.equal(await objects('graphic').count(), 0, 'Resize cancels a held drawing gesture.');
  assert.equal(await button('Apply drawing').isDisabled(), true);
  assert.equal(await button('Undo drawing').isDisabled(), true, 'Resize creates no history entry.');
  await dialog.evaluate((element, style) => {
    if (style === null) element.removeAttribute('style');
    else element.setAttribute('style', style);
  }, originalDialogStyle);
  await assertViewport('Restored canvas after a cancelled drawing gesture');

  await dialog.getByLabel('Name', { exact: true }).fill('UICustom');
  await button('Rectangle').click();
  await dragDrawing([-5.08, -3.81], [5.08, 3.81]);
  await button('Pin').click();
  await clickDrawing(-7.62, 0);
  await clickDrawing(7.62, 0);
  await button('Select').click();
  const heldStart = await screenPoint(7.62, 0),
    heldEnd = await screenPoint(10.16, 1.27);
  await page.mouse.move(heldStart.x, heldStart.y);
  await page.mouse.down();
  await page.mouse.move(heldEnd.x, heldEnd.y, { steps: 6 });
  const heldView = await viewBox();
  for (const action of ['Zoom in drawing', 'Zoom out drawing', 'Fit drawing']) {
    await button(action).evaluate((element) => element.click());
    assert.equal(await viewBox(), heldView, `${action} cannot change a held gesture's camera.`);
  }
  await page.mouse.wheel(0, -240);
  assert.equal(await viewBox(), heldView, 'Wheel zoom cannot change a held gesture camera.');
  await button('Apply drawing').evaluate((element) => {
    element.focus();
    element.click();
  });
  assert.equal(await dialog.isVisible(), true, 'Apply cannot commit an unfinished selection drag.');
  assert.deepEqual(await state(), initialState, 'Applying a held drag cannot mutate Core.');
  await page.mouse.up();
  assert.equal(await button('Apply drawing').isEnabled(), true, 'Releasing the drag allows Apply.');
  assert.equal(Number(await dialog.getByLabel('Pin X', { exact: true }).inputValue()), 10.16);
  assert.equal(Number(await dialog.getByLabel('Pin Y', { exact: true }).inputValue()), 1.27);
  await canvas.press('Control+z');
  assert.equal(await objects('pin').count(), 2);
  await button('Fit drawing').click();
  const fittedView = await viewBox();
  const zoomScreen = await screenPoint(2.54, 1.27);
  const zoomPoint = { x: Math.round(zoomScreen.x), y: Math.round(zoomScreen.y) };
  const worldAt = () =>
    canvas.evaluate((svg, screen) => {
      const point = new DOMPoint(screen.x, screen.y).matrixTransform(svg.getScreenCTM().inverse());
      return { x: point.x, y: point.y };
    }, zoomPoint);
  const worldBefore = await worldAt();
  await page.mouse.move(zoomPoint.x, zoomPoint.y);
  await page.mouse.wheel(0, -240);
  await waitForAsync(
    page,
    (previous) =>
      document.querySelector('svg[aria-label$="drawing canvas"]').getAttribute('viewBox') !==
      previous,
    fittedView,
  );
  const worldAfter = await worldAt();
  assert.ok(
    Math.hypot(worldAfter.x - worldBefore.x, worldAfter.y - worldBefore.y) < 0.001,
    `Wheel zoom preserves the world point beneath the cursor: ${JSON.stringify({ worldBefore, worldAfter })}`,
  );
  await assertViewport('Cursor-anchored wheel zoom');
  for (const mouseButton of ['middle', 'right']) {
    const beforePan = await viewBox();
    await panDrawing(mouseButton);
    assert.notEqual(await viewBox(), beforePan, `${mouseButton} drag pans the canvas.`);
    await assertViewport(`${mouseButton} pan with geometry`);
  }
  await canvas.press('Home');
  assert.equal(await viewBox(), fittedView, 'Fit restores the drawing bounds after pan and zoom.');
  await canvas.press('+');
  assert.notEqual(await viewBox(), fittedView);
  await canvas.press('Space');
  assert.equal(await viewBox(), fittedView);
  assert.deepEqual(
    await state(),
    initialState,
    'Navigation and local edits preserve Core until Apply.',
  );
  await placement.locator('summary').click();
  await dialog.getByLabel('Placement X', { exact: true }).fill('60.96');
  await dialog.getByLabel('Placement Y', { exact: true }).fill('71.12');
  await placement.locator('summary').click();
  await dialog.screenshot({ path: 'test-results/component-drawing-wide-ui.png' });
  await canvas.press('Enter');
  await dialog.waitFor({ state: 'hidden' });
  let snapshot = await state();
  assert.equal(snapshot.project.schematic.parts.length, 1);
  assert.equal(snapshot.project.schematic.parts[0].x, 60.96);
  assert.equal(snapshot.project.schematic.parts[0].y, 71.12);
  assert.equal(snapshot.undo, 1);
  const partId = snapshot.project.schematic.parts[0].id;
  const nativeSymbol = await page.evaluate(() => window.componentDrawing.native());
  assert.ok(
    nativeSymbol.some(
      (file) => file.name.endsWith('.kicad_sch') && file.source.includes('UICustom'),
    ),
  );
  assert.equal(
    (await page.evaluate(() => window.componentDrawing.reopened())).schematic.parts.length,
    1,
  );

  const beforeStandalone = await state();
  const reopenedBeforeStandalone = await page.evaluate(() => window.componentDrawing.reopened());
  await open('footprint');
  const optionalComponent = dialog.getByLabel('Schematic component', { exact: true });
  assert.equal(await optionalComponent.inputValue(), '');
  assert.equal(await optionalComponent.locator('option:checked').textContent(), 'None');
  await dialog.getByLabel('Name', { exact: true }).fill('StandalonePackage');
  await button('Pad').click();
  await clickDrawing(-2.5, 0);
  await clickDrawing(2.5, 0);
  await button('Rectangle').click();
  await dragDrawing([-4, -2], [4, 2]);
  assert.equal(await optionalComponent.inputValue(), '', 'Drawing never selects a component.');
  assert.equal(await button('Apply drawing').isEnabled(), true);
  await apply();
  snapshot = await state();
  assert.equal(snapshot.undo, beforeStandalone.undo + 1);
  assert.equal(snapshot.project.pcb.footprints.length, 1);
  const standalone = snapshot.project.pcb.footprints[0];
  assert.equal(standalone.symbolId, null);
  assert.equal(standalone.pads.length, 2);
  assert.deepEqual(snapshot.project.schematic, beforeStandalone.project.schematic);
  const standaloneNative = await page.evaluate(() => window.componentDrawing.native());
  assert.ok(
    standaloneNative.some(
      (file) => file.name.endsWith('.kicad_pcb') && file.source.includes('StandalonePackage'),
    ),
  );
  const reopenedStandalone = await page.evaluate(() => window.componentDrawing.reopened());
  assert.equal(reopenedStandalone.pcb.footprints[0].id, standalone.id);
  assert.equal(reopenedStandalone.pcb.footprints[0].symbolId, null);
  assert.deepEqual(reopenedStandalone.schematic, reopenedBeforeStandalone.schematic);
  await page.evaluate(() =>
    window.componentDrawing.host.execute('history.undo', {}, { actor: 'human' }),
  );
  snapshot = await state();
  assert.equal(snapshot.undo, beforeStandalone.undo);
  assert.deepEqual(snapshot.project, beforeStandalone.project);
  assert.deepEqual(await page.evaluate(() => window.componentDrawing.native()), nativeSymbol);

  await open('footprint');
  await optionalComponent.selectOption(partId);
  await optionalComponent.selectOption('');
  await button('Pad').click();
  await clickDrawing(0, 0);
  await apply();
  snapshot = await state();
  assert.equal(
    snapshot.project.pcb.footprints[0].symbolId,
    null,
    'Returning the component selector to None clears the association before Apply.',
  );
  assert.deepEqual(snapshot.project.schematic, beforeStandalone.project.schematic);
  await page.evaluate(() =>
    window.componentDrawing.host.execute('history.undo', {}, { actor: 'human' }),
  );
  assert.deepEqual(await page.evaluate(() => window.componentDrawing.native()), nativeSymbol);

  await open('footprint');
  await dialog.getByLabel('Name', { exact: true }).fill('UIPackage');
  await dialog.getByLabel('Schematic component', { exact: true }).selectOption(partId);
  await button('Pad').click();
  await clickDrawing(-2.5, 0);
  await clickDrawing(2.5, 0);
  await button('Rectangle').click();
  await clickDrawing(-4, -2);
  await clickDrawing(4, 2);
  await page.setViewportSize({ width: 540, height: 760 });
  await placement.locator('summary').click();
  const placementBounds = await placement.locator('div').first().boundingBox();
  assert.ok(placementBounds && placementBounds.x >= 0 && placementBounds.y >= 0);
  assert.ok(placementBounds.x + placementBounds.width <= 540);
  assert.ok(placementBounds.y + placementBounds.height <= 760);
  assert.equal(await dialog.getByLabel('Placement X', { exact: true }).isEditable(), true);
  await dialog.screenshot({ path: 'test-results/component-drawing-placement-ui.png' });
  await placement.locator('summary').click();
  await page.setViewportSize({ width: 1280, height: 1000 });
  await apply();
  snapshot = await state();
  assert.equal(snapshot.undo, 2);
  assert.equal(snapshot.project.pcb.footprints.length, 1);
  let footprint = snapshot.project.pcb.footprints[0];
  const footprintId = footprint.id;
  const padIds = footprint.pads.map((pad) => pad.id);
  assert.equal(footprint.symbolId, partId);
  assert.equal(footprint.pads.length, 2);
  assert.equal(footprint.graphics.length, 4);
  assert.equal(snapshot.project.schematic.parts[0].fields.Footprint, 'OpenPE:UIPackage');
  assert.equal(
    (await page.evaluate(() => window.componentDrawing.reopened())).pcb.footprints[0].id,
    footprintId,
  );

  await open('footprint');
  await dialog.getByLabel('Drawing target', { exact: true }).selectOption(footprintId);
  assert.equal(
    await placement.count(),
    0,
    'Editing an existing package does not ask for new placement.',
  );
  assert.equal(
    await button('Apply drawing').isDisabled(),
    true,
    'An unchanged target cannot apply.',
  );
  await dragDrawing([-2.5, 0], [-2, 0.75]);
  assert.equal(Number(await dialog.getByLabel('Pad X', { exact: true }).inputValue()), -2);
  assert.equal(Number(await dialog.getByLabel('Pad Y', { exact: true }).inputValue()), 0.75);
  await canvas.press('Control+z');
  assert.equal(await button('Apply drawing').isDisabled(), true);
  await clickDrawing(0, -2);
  await dialog.getByLabel('Stroke width', { exact: true }).fill('0.2');
  await apply();
  snapshot = await state();
  footprint = snapshot.project.pcb.footprints[0];
  assert.equal(snapshot.undo, 3);
  assert.deepEqual(
    footprint.pads.map((pad) => pad.id),
    padIds,
  );
  assert.equal(footprint.graphics[0].width, 0.2);

  await open('footprint');
  await dialog.getByLabel('Drawing target', { exact: true }).selectOption(footprintId);
  await clickDrawing(-2.5, 0);
  const width = dialog.getByLabel('Size X', { exact: true });
  await width.fill('-');
  assert.equal(await button('Apply drawing').isDisabled(), true);
  assert.equal(await button('Rectangle').isDisabled(), true);
  await clickDrawing(0, -2);
  assert.equal(await width.inputValue(), '-', 'Selecting another shape retains an invalid field.');
  const beforeInvalidPan = await viewBox();
  await panDrawing();
  assert.notEqual(
    await viewBox(),
    beforeInvalidPan,
    'Invalid fields do not block view navigation.',
  );
  assert.equal(await width.inputValue(), '-');
  await width.press('Escape');
  assert.equal(Number(await width.inputValue()), 1.5, 'Escape restores the focused field value.');
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await button('Apply drawing').isDisabled(), true);
  await width.fill('-');
  const beforeIme = await state();
  await width.dispatchEvent('compositionstart');
  for (const key of ['Enter', 'Escape'])
    await width.evaluate(
      (element, key) =>
        element.dispatchEvent(
          new KeyboardEvent('keydown', {
            key,
            code: key,
            keyCode: 229,
            which: 229,
            isComposing: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
      key,
    );
  assert.equal(await dialog.isVisible(), true);
  assert.deepEqual(await state(), beforeIme);
  await width.dispatchEvent('compositionend');
  await width.fill('1.75');
  await width.evaluate((element) =>
    element.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        keyCode: 229,
        which: 229,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  assert.equal(await dialog.isVisible(), true);
  assert.equal(await button('Apply drawing').isEnabled(), true);
  await page.setViewportSize({ width: 540, height: 760 });
  await width.scrollIntoViewIfNeeded();
  await assertViewport('Compact footprint canvas');
  const compactLayout = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const apply = element
      .querySelector('button[aria-label="Apply drawing"]')
      .getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      applyBottom: apply.bottom,
      applyRight: apply.right,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
    };
  });
  assert.ok(compactLayout.left >= 0 && compactLayout.right <= compactLayout.viewportWidth);
  assert.ok(compactLayout.bottom <= compactLayout.viewportHeight);
  assert.ok(
    compactLayout.scrollWidth <= compactLayout.clientWidth + 1,
    'Compact editor has no horizontal overflow.',
  );
  assert.ok(
    compactLayout.applyBottom <= compactLayout.viewportHeight &&
      compactLayout.applyRight <= compactLayout.viewportWidth,
    'Apply remains reachable in the compact editor.',
  );
  assert.equal(await width.inputValue(), '1.75');
  await dialog.screenshot({ path: 'test-results/component-drawing-narrow-ui.png' });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await apply();
  assert.equal((await state()).undo, 4);

  await open('footprint');
  await dialog.getByLabel('Drawing target', { exact: true }).selectOption(footprintId);
  await clickDrawing(0, -2);
  await dialog.getByLabel('Stroke width', { exact: true }).fill('0.22');
  await page.evaluate(() => window.componentDrawing.change());
  await dialog.getByRole('alert').filter({ hasText: 'Your draft is retained' }).waitFor();
  assert.equal(await button('Apply drawing').isDisabled(), true);
  assert.equal(await dialog.getByLabel('Stroke width', { exact: true }).inputValue(), '0.22');
  await dialog.screenshot({ path: 'test-results/component-drawing-stale-ui.png' });
  const beforeRefresh = await state();
  await button('Refresh revision').click();
  await dialog
    .getByRole('alert')
    .filter({ hasText: 'Your draft is retained' })
    .waitFor({ state: 'hidden' });
  assert.equal(await dialog.getByLabel('Stroke width', { exact: true }).inputValue(), '0.22');
  assert.equal(await button('Apply drawing').isEnabled(), true);
  assert.deepEqual(await state(), beforeRefresh, 'Refreshing only adopts the current revision.');
  await apply();
  snapshot = await state();
  assert.equal(snapshot.undo, beforeRefresh.undo + 1);
  assert.equal(snapshot.project.name, 'External change');
  assert.equal(snapshot.project.pcb.footprints[0].graphics[0].width, 0.22);

  await open('footprint');
  await dialog.getByLabel('Drawing target', { exact: true }).selectOption(footprintId);
  await clickDrawing(0, -2);
  await dialog.getByLabel('Stroke width', { exact: true }).fill('0.24');
  await page.evaluate(() => window.componentDrawing.changeTarget());
  await dialog.getByRole('alert').filter({ hasText: 'Your draft is retained' }).waitFor();
  const beforeConflict = await state();
  await button('Refresh revision').click();
  await dialog.getByRole('alert').filter({ hasText: 'The target footprint changed' }).waitFor();
  assert.equal(await button('Apply drawing').isDisabled(), true);
  assert.equal(await dialog.getByLabel('Stroke width', { exact: true }).inputValue(), '0.24');
  assert.deepEqual(await state(), beforeConflict, 'A target conflict cannot mutate the document.');
  await dialog.screenshot({ path: 'test-results/component-drawing-target-conflict-ui.png' });
  await button('Cancel').click();
  await dialog.waitFor({ state: 'hidden' });

  assert.deepEqual(errors, []);
  console.log(
    'PASS: component drawing GUI exposes only Symbol and Footprint tabs, with keyboard navigation, selection-only properties, optional placement, drag/two-click creation, selection movement, local undo/redo/reset, keyboard cancellation/apply, aspect-correct cursor zoom/pan/fit, full-viewport grid/origin axes, held-gesture zoom/resize guards and compact layout; creates/edits native symbols and footprints through Core with stable identities/undo; retains invalid/IME/stale drafts and rejects target conflicts. Screenshots: test-results/component-drawing-{empty,dark-zoom,portrait,placement,wide,narrow,stale,target-conflict}-ui.png',
  );
} finally {
  await browser.close();
}
