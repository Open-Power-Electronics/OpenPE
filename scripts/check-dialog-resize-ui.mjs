import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { waitForAsync } from './async-browser-test-helpers.mjs';

// Shared renderer-only dialogs: no Electron, native files, providers or solvers.
const bundle = await build({
  stdin: {
    contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import Dialog from './components/Dialog';
      const root = createRoot(document.getElementById('root'));
      const anchor = {current:document.getElementById('anchor')};
      let state = {kind:'standard', open:true, large:false, controlled:false, size:{}};
      const classes = {git:'project-history-dialog', settings:'settings-dialog', library:'library-chooser', near:'waveform-axis-dialog'};
      const changes = [];
      function render(next={}) {
        state = {...state,...next};
        const anchored = ['below','above','near'].includes(state.kind);
        Object.assign(anchor.current.style, {left:'260px',top:state.kind==='above'?'650px':'150px',width:'600px',height:'44px'});
        const body = <div className="fixture-body" style={{minWidth:0,flex:1,overflow:'auto'}}>
          <label>Draft <input aria-label="Dialog draft" defaultValue="Retained input"/></label>
          {Array.from({length:state.large?90:6},(_,i)=><p key={i}>Dialog content row {i+1}</p>)}
        </div>;
        flushSync(()=>root.render(<Dialog key={state.kind} title="Resize fixture" open={state.open}
          compact={state.kind==='compact'||state.kind==='near'} wide={state.kind==='library'}
          className={classes[state.kind]||''} modal={!anchored}
          anchorRef={anchored?anchor:undefined} anchorPlacement={anchored?state.kind:undefined}
          minWidth={state.controlled?240:undefined}
          size={state.controlled?state.size:undefined}
          onResize={state.controlled?size=>{changes.push(size);render({size});}:undefined}
          onClose={()=>render({open:false})}
          footer={<button className="dialog-button secondary" onClick={()=>render({open:false})}>Done</button>}>
          {body}
        </Dialog>));
      }
      window.resizeFixture = {render, changes, state:()=>state};
      render();
    `,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
});
let page;
const errors = [];
try {
  page = await browser.newPage({ viewport: { width: 1800, height: 1200 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body><button id="anchor" style="position:fixed">Popup anchor</button><div id="root"></div></body></html>',
    }),
  );
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const dialog = page.getByRole('dialog', { name: 'Resize fixture', exact: true });
  const handle = dialog.getByRole('button', {
    name: 'Resize resize fixture bottom right',
    exact: true,
  });
  const edges = [
    { direction: 'n', label: 'top', cursor: 'ns-resize', dx: 0, dy: -28 },
    { direction: 'ne', label: 'top right', cursor: 'nesw-resize', dx: 40, dy: -28 },
    { direction: 'e', label: 'right', cursor: 'ew-resize', dx: 40, dy: 0 },
    { direction: 'se', label: 'bottom right', cursor: 'nwse-resize', dx: 40, dy: 28 },
    { direction: 's', label: 'bottom', cursor: 'ns-resize', dx: 0, dy: 28 },
    { direction: 'sw', label: 'bottom left', cursor: 'nesw-resize', dx: -40, dy: 28 },
    { direction: 'w', label: 'left', cursor: 'ew-resize', dx: -40, dy: 0 },
    { direction: 'nw', label: 'top left', cursor: 'nwse-resize', dx: -40, dy: -28 },
  ];
  const resizeEdge = (label) =>
    dialog.getByRole('button', { name: `Resize resize fixture ${label}`, exact: true });
  const header = dialog.locator('.dialog-header');
  const maximize = dialog.getByRole('button', { name: 'Maximize dialog', exact: true });
  const restore = dialog.getByRole('button', { name: 'Restore dialog', exact: true });
  async function frame() {
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  }
  async function render(next) {
    await page.evaluate((next) => window.resizeFixture.render(next), next);
    await dialog.waitFor({ state: next.open === false ? 'hidden' : 'visible' });
    await frame();
  }
  function near(actual, expected, message, tolerance = 1.5) {
    assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} versus ${expected}`);
  }
  function sameBox(actual, expected, message) {
    for (const field of ['x', 'y', 'width', 'height'])
      near(actual[field], expected[field], `${message} (${field})`);
  }
  async function dragEdge(edge, dx, dy, release = true) {
    const box = await edge.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 5 });
    if (release) await page.mouse.up();
    await frame();
  }
  async function drag(dx, dy, release = true) {
    await dragEdge(handle, dx, dy, release);
  }
  async function dragTitle(dx, dy, release = true) {
    const box = await header.boundingBox();
    const x = box.x + 45;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx, y + dy, { steps: 5 });
    if (release) await page.mouse.up();
    await frame();
  }
  async function assertMaximized() {
    assert.equal(await dialog.getAttribute('data-maximized'), 'true');
    assert.equal(
      await dialog.locator('.dialog-resize-edge').count(),
      0,
      'Maximized dialogs omit all resize edges and corners.',
    );
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize();
    const titlebar = await dialog.evaluate(
      (element) =>
        parseFloat(getComputedStyle(element).getPropertyValue('--desktop-titlebar-height')) || 0,
    );
    near(box.x, 0, 'Maximized dialog starts at the viewport left');
    near(box.y, titlebar, 'Maximized dialog starts below the desktop titlebar');
    near(box.width, viewport.width, 'Maximized dialog spans the viewport width');
    near(
      box.height,
      viewport.height - titlebar,
      'Maximized dialog spans the available viewport height',
    );
    assert.equal(
      await dialog.evaluate((element) => getComputedStyle(element).borderTopLeftRadius),
      '0px',
      'Maximized windows have square corners.',
    );
  }
  async function assertCorner() {
    assert.equal(
      await dialog.locator('.dialog-resize-edge').count(),
      8,
      'Every dialog has four resize edges and four corners.',
    );
    const box = await dialog.boundingBox();
    for (const edge of edges) {
      const target = resizeEdge(edge.label);
      assert.equal(await target.getAttribute('data-direction'), edge.direction);
      assert.equal(
        await target.evaluate((element) => getComputedStyle(element).cursor),
        edge.cursor,
      );
      assert.equal(
        await target.locator('svg').count(),
        0,
        'Window resize hit areas have no corner glyph.',
      );
      assert.equal(
        (await target.innerText()).trim(),
        '',
        'Window resize hit areas have no visible text.',
      );
      const bounds = await target.boundingBox();
      const centerX = bounds.x + bounds.width / 2;
      const centerY = bounds.y + bounds.height / 2;
      if (edge.direction.includes('w'))
        near(centerX, box.x, `${edge.label} sits at the left edge`, 12);
      else if (edge.direction.includes('e'))
        near(centerX, box.x + box.width, `${edge.label} sits at the right edge`, 12);
      else near(centerX, box.x + box.width / 2, `${edge.label} spans the horizontal midpoint`);
      if (edge.direction.includes('n'))
        near(centerY, box.y, `${edge.label} sits at the top edge`, 12);
      else if (edge.direction.includes('s'))
        near(centerY, box.y + box.height, `${edge.label} sits at the bottom edge`, 12);
      else near(centerY, box.y + box.height / 2, `${edge.label} spans the vertical midpoint`);
    }
  }
  async function assertInViewport() {
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(box.x >= 7 && box.y >= 7, 'Dialog origin stays within the viewport.');
    assert.ok(
      box.x + box.width <= viewport.width - 7,
      'Dialog right edge stays within the viewport.',
    );
    assert.ok(
      box.y + box.height <= viewport.height - 7,
      'Dialog bottom edge stays within the viewport.',
    );
  }
  let defaultBox;
  for (const kind of [
    'standard',
    'compact',
    'library',
    'settings',
    'git',
    'below',
    'above',
    'near',
    'controlled',
  ]) {
    await render({
      kind,
      open: true,
      large: false,
      controlled: kind === 'controlled',
      size: kind === 'controlled' ? { width: 440, height: 300 } : {},
    });
    await assertCorner();
    const initial = await dialog.boundingBox();
    if (kind === 'standard') defaultBox = initial;
    const defaultSize = kind === 'controlled' ? defaultBox : initial;
    if (kind === 'above' || kind === 'near') {
      await handle.press('Home');
      await frame();
      sameBox(await dialog.boundingBox(), initial, `${kind}: untouched Home preserves anchoring`);
      await handle.dblclick();
      await frame();
      sameBox(
        await dialog.boundingBox(),
        initial,
        `${kind}: untouched double click preserves anchoring`,
      );
      const grip = await handle.boundingBox();
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.keyboard.press('Escape');
      await page.mouse.up();
      await frame();
      assert.equal(
        await dialog.isVisible(),
        true,
        `${kind}: no-move resize Escape keeps the dialog open`,
      );
      sameBox(
        await dialog.boundingBox(),
        initial,
        `${kind}: no-move resize Escape preserves anchoring`,
      );
    }
    if (kind === 'near') {
      await handle.dispatchEvent('keydown', { key: 'Escape', keyCode: 229 });
      assert.equal(
        await dialog.isVisible(),
        true,
        'IME key code 229 does not close the nonmodal resize grip.',
      );
      await handle.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
      assert.equal(
        await dialog.isVisible(),
        true,
        'Composing Escape does not close the nonmodal resize grip.',
      );
      const draft = dialog.getByRole('textbox', { name: 'Dialog draft', exact: true });
      await draft.dispatchEvent('compositionstart');
      await handle.press('Escape');
      assert.equal(
        await dialog.isVisible(),
        true,
        'Active composition blocks Escape even without native composition flags.',
      );
      assert.equal(
        await draft.inputValue(),
        'Retained input',
        'IME Escape retains the local draft.',
      );
      await draft.dispatchEvent('compositionend');
      await handle.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      await render({ open: true });
      sameBox(
        await dialog.boundingBox(),
        initial,
        'Ending composition restores ordinary nonmodal Escape dismissal.',
      );
    }
    await drag(70, 48);
    const resized = await dialog.boundingBox();
    near(resized.x, initial.x, `${kind}: resizing holds the left edge`);
    near(resized.y, initial.y, `${kind}: resizing holds the top edge`);
    near(resized.width, initial.width + 70, `${kind}: dragging right increases width`);
    near(resized.height, initial.height + 48, `${kind}: dragging down increases height`);
    await handle.focus();
    await handle.dispatchEvent('keydown', { key: 'Home', keyCode: 229 });
    sameBox(await dialog.boundingBox(), resized, `${kind}: IME Home does not reset`);
    await handle.press('ArrowRight');
    await handle.press('ArrowDown');
    const keyboard = await dialog.boundingBox();
    near(keyboard.width, resized.width + 16, `${kind}: keyboard resizes width`);
    near(keyboard.height, resized.height + 16, `${kind}: keyboard resizes height`);
    assert.equal(await maximize.count(), 1, `${kind}: maximize is available in the header`);
    await maximize.click();
    await frame();
    await assertMaximized();
    await restore.click();
    await frame();
    sameBox(
      await dialog.boundingBox(),
      keyboard,
      `${kind}: restore returns the exact previous size and position`,
    );
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await render({ open: true });
    sameBox(await dialog.boundingBox(), keyboard, `${kind}: close/reopen retains size and origin`);
    assert.equal(
      await dialog.getByRole('textbox', { name: 'Dialog draft', exact: true }).inputValue(),
      'Retained input',
    );
    await handle.press('Home');
    const reset = await dialog.boundingBox();
    sameBox(reset, defaultSize, `${kind}: Home resets size and placement`);
    await drag(40, 24);
    await handle.dblclick();
    sameBox(await dialog.boundingBox(), defaultSize, `${kind}: double click resets size`);
    if (kind === 'near' || kind === 'above') {
      await dragTitle(35, 25);
      const moved = await dialog.boundingBox();
      near(
        moved.x,
        initial.x + 35,
        `${kind}: title dragging preserves manual horizontal placement`,
      );
      near(moved.y, initial.y + 25, `${kind}: title dragging preserves manual vertical placement`);
      await handle.press('Home');
      sameBox(
        await dialog.boundingBox(),
        initial,
        `${kind}: reset restores the original anchored placement`,
      );
    }
    await render({ open: false });
  }
  await render({ kind: 'edges', open: true, large: false, controlled: false, size: {} });
  const defaultEdges = await dialog.boundingBox();
  function assertOppositeEdges(current, original, direction, message) {
    if (direction.includes('w'))
      near(
        current.x + current.width,
        original.x + original.width,
        `${message}: right edge stays fixed`,
      );
    else near(current.x, original.x, `${message}: left edge stays fixed`);
    if (direction.includes('n'))
      near(
        current.y + current.height,
        original.y + original.height,
        `${message}: bottom edge stays fixed`,
      );
    else near(current.y, original.y, `${message}: top edge stays fixed`);
  }
  for (const edge of edges) {
    await dragEdge(resizeEdge(edge.label), edge.dx, edge.dy);
    const grown = await dialog.boundingBox();
    near(
      grown.width,
      defaultEdges.width + Math.abs(edge.dx),
      `${edge.label}: active horizontal edge resizes width`,
    );
    near(
      grown.height,
      defaultEdges.height + Math.abs(edge.dy),
      `${edge.label}: active vertical edge resizes height`,
    );
    assertOppositeEdges(grown, defaultEdges, edge.direction, `${edge.label}: resizing`);
    await handle.press('Home');
    sameBox(await dialog.boundingBox(), defaultEdges, `${edge.label}: reset restores original box`);
    await dragEdge(
      resizeEdge(edge.label),
      edge.dx ? -Math.sign(edge.dx) * 1000 : 0,
      edge.dy ? -Math.sign(edge.dy) * 1000 : 0,
    );
    const minimum = await dialog.boundingBox();
    near(minimum.width, edge.dx ? 224 : defaultEdges.width, `${edge.label}: minimum width`);
    near(minimum.height, edge.dy ? 160 : defaultEdges.height, `${edge.label}: minimum height`);
    assertOppositeEdges(minimum, defaultEdges, edge.direction, `${edge.label}: minimum constraint`);
    await handle.press('Home');
    await dragEdge(resizeEdge(edge.label), Math.sign(edge.dx) * 5000, Math.sign(edge.dy) * 5000);
    const bounded = await dialog.boundingBox();
    await assertInViewport();
    assertOppositeEdges(
      bounded,
      defaultEdges,
      edge.direction,
      `${edge.label}: viewport constraint`,
    );
    await handle.press('Home');
  }
  await dragEdge(resizeEdge('top left'), -35, -25, false);
  const resizingTopLeft = await dialog.boundingBox();
  await resizeEdge('top left').dispatchEvent('keydown', {
    key: 'Escape',
    keyCode: 229,
    isComposing: true,
  });
  sameBox(
    await dialog.boundingBox(),
    resizingTopLeft,
    'IME Escape does not cancel opposite-anchor resizing',
  );
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.equal(await dialog.isVisible(), true, 'Top-left resize Escape keeps the dialog open.');
  sameBox(
    await dialog.boundingBox(),
    defaultEdges,
    'Escape restores both origin and dimensions after top-left resizing',
  );
  const composingDraft = dialog.getByRole('textbox', { name: 'Dialog draft', exact: true });
  await composingDraft.fill('Composition resize draft');
  await composingDraft.dispatchEvent('compositionstart');
  await dragEdge(resizeEdge('top left'), -35, -25, false);
  const composingFrame = await dialog.boundingBox();
  await page.keyboard.press('Escape');
  assert.equal(
    await dialog.isVisible(),
    true,
    'Active composition blocks native Escape while resizing.',
  );
  sameBox(
    await dialog.boundingBox(),
    composingFrame,
    'Composition state blocks plain Escape without native composition flags',
  );
  await resizeEdge('top left').dispatchEvent('keydown', { key: 'Home' });
  sameBox(
    await dialog.boundingBox(),
    composingFrame,
    'Composition state blocks plain Home on the active resize edge',
  );
  assert.equal(
    await composingDraft.inputValue(),
    'Composition resize draft',
    'Resizing IME guards preserve the local draft.',
  );
  await composingDraft.dispatchEvent('compositionend');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.equal(
    await dialog.isVisible(),
    true,
    'Ending composition restores resize cancellation before dismissal.',
  );
  sameBox(
    await dialog.boundingBox(),
    defaultEdges,
    'Ending composition restores ordinary Escape resize rollback',
  );
  await render({ kind: 'below', open: true, large: true, controlled: false, size: {} });
  const tallAnchored = await dialog.boundingBox();
  assert.ok(
    tallAnchored.height > 800,
    'The tall anchored fixture is limited by available viewport height.',
  );
  await dragTitle(0, -80);
  const tallMoved = await dialog.boundingBox();
  near(tallMoved.y, tallAnchored.y - 80, 'A tall anchored dialog moves upward');
  near(
    tallMoved.width,
    tallAnchored.width,
    'Moving a tall anchored dialog preserves its measured width',
  );
  near(
    tallMoved.height,
    tallAnchored.height,
    'Moving a tall anchored dialog preserves its measured height',
  );
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await render({ open: true });
  sameBox(
    await dialog.boundingBox(),
    tallMoved,
    'Tall anchored size and moved position survive reopening',
  );
  await render({ open: false });
  await page.evaluate(() => document.body.style.setProperty('--desktop-titlebar-height', '40px'));
  await render({ kind: 'standard', open: true, large: false, controlled: false, size: {} });
  const beforeMove = await dialog.boundingBox();
  for (const control of [
    maximize,
    dialog.getByRole('button', { name: 'Close dialog', exact: true }),
  ]) {
    const box = await control.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 40, box.y + box.height / 2 + 30, { steps: 3 });
    await page.mouse.up();
    await frame();
    assert.equal(
      await dialog.isVisible(),
      true,
      'Dragging a title-bar control does not dismiss the window.',
    );
    assert.equal(
      await maximize.count(),
      1,
      'Dragging a title-bar control does not maximize the window.',
    );
    sameBox(
      await dialog.boundingBox(),
      beforeMove,
      'Title-bar controls do not initiate window dragging',
    );
  }
  await dragTitle(100, 70);
  const moved = await dialog.boundingBox();
  near(moved.x, beforeMove.x + 100, 'Title dragging moves the dialog horizontally');
  near(moved.y, beforeMove.y + 70, 'Title dragging moves the dialog vertically');
  near(moved.width, beforeMove.width, 'Title dragging preserves width');
  near(moved.height, beforeMove.height, 'Title dragging preserves height');
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await render({ open: true });
  sameBox(await dialog.boundingBox(), moved, 'Closing and reopening retains the moved position');
  await dragTitle(55, 35, false);
  const moving = await dialog.boundingBox();
  await header.dispatchEvent('keydown', { key: 'Escape', keyCode: 229, isComposing: true });
  sameBox(await dialog.boundingBox(), moving, 'IME Escape does not cancel a title drag');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.equal(await dialog.isVisible(), true, 'Escape cancels title dragging before closing');
  sameBox(await dialog.boundingBox(), moved, 'Escape restores the pre-drag position');
  await dragTitle(45, 30, false);
  await header.dispatchEvent('pointercancel', { pointerId: 1, bubbles: true });
  await page.mouse.up();
  await frame();
  sameBox(await dialog.boundingBox(), moved, 'Pointer cancellation restores the pre-drag position');
  await dragTitle(5000, 5000);
  await assertInViewport();
  await dragTitle(-5000, -5000);
  await assertInViewport();
  await page.setViewportSize({ width: 1000, height: 720 });
  await frame();
  const ordinaryBelowTitlebar = await dialog.boundingBox();
  assert.ok(
    ordinaryBelowTitlebar.y >= 40,
    'Ordinary dialog viewport clamping respects the body-scoped Electron titlebar.',
  );
  await assertInViewport();
  await page.setViewportSize({ width: 1800, height: 1200 });
  await frame();
  const beforeMaximize = await dialog.boundingBox();
  await maximize.click();
  await frame();
  await assertMaximized();
  const maximized = await dialog.boundingBox();
  await dragTitle(100, 70);
  sameBox(
    await dialog.boundingBox(),
    maximized,
    'Maximized title dragging leaves the maximized window in place',
  );
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await render({ open: true });
  await assertMaximized();
  await page.setViewportSize({ width: 1000, height: 720 });
  await frame();
  await assertMaximized();
  await restore.click();
  await frame();
  sameBox(
    await dialog.boundingBox(),
    beforeMaximize,
    'Restore preserves the pre-maximized window after viewport resize',
  );
  await page.setViewportSize({ width: 1800, height: 1200 });
  await page.evaluate(() => document.body.style.removeProperty('--desktop-titlebar-height'));
  await render({ kind: 'fresh', open: true, large: false, controlled: false, size: {} });
  await render({ kind: 'standard', open: true, large: false, controlled: false, size: {} });
  const initial = await dialog.boundingBox();
  await drag(90, 60, false);
  const dragging = await dialog.boundingBox();
  await handle.dispatchEvent('keydown', { key: 'Escape', keyCode: 229, isComposing: true });
  assert.equal(await dialog.isVisible(), true, 'IME Escape does not close a resizing dialog.');
  sameBox(await dialog.boundingBox(), dragging, 'IME Escape does not cancel a drag');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.equal(
    await dialog.isVisible(),
    true,
    'Escape cancels resizing before closing the dialog.',
  );
  sameBox(await dialog.boundingBox(), initial, 'Escape restores original size and position');
  await drag(-1000, -1000);
  const minimum = await dialog.boundingBox();
  near(minimum.width, 224, 'Default minimum width');
  near(minimum.height, 160, 'Default minimum height');
  await render({ large: true });
  await waitForAsync(page, () => {
    const content = document.querySelector('dialog[open] > .dialog-content');
    return content.scrollHeight > content.clientHeight;
  });
  assert.ok(
    await dialog.locator('.dialog-header').isVisible(),
    'Header remains visible with overflowing content.',
  );
  assert.ok(
    await dialog.locator('.dialog-footer').isVisible(),
    'Footer remains visible with overflowing content.',
  );
  await drag(2000, 2000);
  await assertInViewport();
  await page.setViewportSize({ width: 900, height: 620 });
  await frame();
  await assertInViewport();
  await assertCorner();
  await page.screenshot({ path: 'test-results/dialog-resize-viewport.png' });
  assert.deepEqual(errors, []);
  console.log(
    'PASS: shared dialog variants support all eight invisible resize edges/corners, maximize/restore and bounded title dragging, retaining opposite anchors and size/position with keyboard/reset/Escape/IME and viewport behavior.',
  );
} catch (error) {
  if (page) {
    await page.screenshot({ path: 'test-results/dialog-resize-failure.png' });
    console.error(await page.locator('body').innerText(), errors);
  }
  throw error;
} finally {
  await browser.close();
}
