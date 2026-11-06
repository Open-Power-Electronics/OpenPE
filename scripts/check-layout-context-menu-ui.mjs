import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { waitForAsync } from './async-browser-test-helpers.mjs';

const { emptyCircuit, uid } = await tsImport('../lib/circuit.ts', import.meta.url);
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const { createProject } = await tsImport('../lib/project.ts', import.meta.url);

const ids = {
  net: uid(),
  track: uid(),
  edge: uid(),
  zone: uid(),
  footprint: uid(),
  pad: uid(),
  body: uid(),
};
const project = createProject(emptyCircuit());
project.pcb = {
  ...createEmptyPCB(),
  nets: [{ id: ids.net, name: 'SIGNAL' }],
  tracks: [
    {
      id: ids.track,
      start: { x: 20, y: 25 },
      end: { x: 40, y: 25 },
      width: 0.4,
      layer: 'F.Cu',
      netId: ids.net,
    },
  ],
  footprints: [
    {
      id: ids.footprint,
      symbolId: null,
      libraryId: 'Test:Mechanical',
      reference: 'MH1',
      value: 'Mounting hole',
      x: 60,
      y: 12,
      rotation: 0,
      side: 'front',
      pads: [
        {
          id: ids.pad,
          number: '1',
          x: 0,
          y: 0,
          rotation: 0,
          type: 'np_thru_hole',
          shape: 'circle',
          size: { x: 2, y: 2 },
          drill: 1.5,
          netId: null,
        },
      ],
      graphics: [
        {
          id: ids.body,
          kind: 'polygon',
          layer: 'F.SilkS',
          width: 0.15,
          start: { x: -3, y: -2 },
          points: [
            { x: 3, y: -2 },
            { x: 3, y: 2 },
          ],
          end: { x: -3, y: 2 },
        },
      ],
    },
  ],
  graphics: [
    {
      id: ids.edge,
      kind: 'polygon',
      layer: 'Edge.Cuts',
      width: 0.1,
      start: { x: 0, y: 0 },
      end: { x: 0, y: 50 },
      points: [
        { x: 80, y: 0 },
        { x: 80, y: 50 },
      ],
    },
  ],
  zones: [
    {
      id: ids.zone,
      netId: ids.net,
      layer: 'F.Cu',
      outline: [
        { x: 45, y: 32 },
        { x: 65, y: 32 },
        { x: 65, y: 45 },
        { x: 45, y: 45 },
      ],
      clearance: 0.25,
      minThickness: 0.2,
      thermalGap: 0.3,
      thermalBridge: 0.3,
      fillEnabled: false,
    },
  ],
};

// Actual Core/renderer, pointer and keyboard input in an isolated browser. No
// Electron, native pickers, services, providers, solvers or user files are used.
const bundle = await build({
  stdin: {
    contents: `import React,{useRef,useState,useSyncExternalStore} from 'react';import {createRoot} from 'react-dom/client';
      import LayoutEditor from './components/LayoutEditor';import {ProjectCore} from './core/project-core';
      import {createCapabilityHost} from './api/capabilities';import {registerProjectCapabilities} from './core/register-project';
      function Fixture(){const [active,setActive]=useState(true),[core]=useState(()=>new ProjectCore(window.fixture));const context=useRef(null);
        const [host]=useState(()=>{const host=createCapabilityHost({revision:()=>String(core.getSnapshot().revision)});registerProjectCapabilities(host,core);return host});
        const state=useSyncExternalStore(core.subscribe,core.getSnapshot);
        window.layoutContext=()=>context.current;window.setLayoutActive=setActive;
        window.readState=()=>({board:core.getSnapshot().project.pcb,revision:core.getSnapshot().revision,undoDepth:core.getSnapshot().undoDepth,files:core.getNativeFiles()});
        return <LayoutEditor board={state.project.pcb} schematic={state.project.schematic} active={active} capabilityHost={host}
          agentContextRef={context} onCommit={board=>core.replaceBoard(board)} getRevision={()=>core.getSnapshot().revision} projectSource={state.source}
          undoAction={<button aria-label="Undo" disabled={!state.canUndo} onClick={()=>core.undo()}>Undo</button>}
          annotations={[]} annotationSessionId="context-menu" onAnnotationsChange={()=>{}}/>}
      createRoot(document.getElementById('root')).render(<Fixture/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const styles = await Promise.all(
  ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'].map((file) =>
    readFile(file, 'utf8'),
  ),
);
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 860 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  await page.evaluate((fixture) => {
    window.fixture = fixture;
  }, project);
  for (const content of styles) await page.addStyleTag({ content });
  await page.addStyleTag({ content: 'html,body,#root,.layout-editor{height:100%;margin:0}' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const canvas = page.getByTestId('layout-canvas');
  const menu = page.getByRole('menu', { name: 'Canvas actions', exact: true });
  try {
    await canvas.waitFor();
  } catch (error) {
    assert.deepEqual(errors, [], 'The isolated real editor mounts without renderer errors.');
    throw error;
  }
  const frames = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  const context = () => page.evaluate(() => structuredClone(window.layoutContext()));
  const state = () => page.evaluate(() => window.readState());
  const screen = (point) =>
    canvas.evaluate((svg, p) => {
      const at = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
      return { x: at.x, y: at.y };
    }, point);
  const point = async (position, button) => {
    const at = await screen(position);
    await page.mouse.move(at.x, at.y);
    if (button) await page.mouse.click(at.x, at.y, { button });
    await frames();
  };
  const unchanged = async (before = initial) => {
    const current = await state();
    assert.deepEqual(
      current.board,
      before.board,
      'Navigation and menus never change design geometry.',
    );
    assert.equal(current.undoDepth, before.undoDepth, 'Navigation and menus never add undo.');
    assert.deepEqual(current.files, before.files, 'Navigation and menus preserve native files.');
  };
  const open = async (position) => {
    await point(position, 'right');
    await menu.waitFor();
    return menu;
  };
  const close = async () => {
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
  };
  const compactSelectionMenu = async () => {
    assert.equal(
      await menu
        .getByRole('menuitem', { name: /^(Fit |Actual size|Zoom |Export image$|Select all$)/ })
        .count(),
      0,
      'Object menus omit camera, export and Select all commands.',
    );
    assert.equal(
      await menu.getByRole('menuitem', { name: 'Clear selection', exact: true }).count(),
      0,
    );
    assert.equal(
      (await menu.getByRole('menuitem').last().textContent()).trim(),
      'Delete selection',
      'Delete stays last in the selected-object menu.',
    );
  };
  const compactToolMenu = async () => {
    assert.equal(
      await menu
        .getByRole('menuitem', {
          name: /^(Fit |Actual size|Zoom |Export image$|Select all$|Clear selection$|Properties$|Move selection$|Rotate selection$|Delete selection$)/,
        })
        .count(),
      0,
      'Tool menus omit camera and unrelated object or selection commands.',
    );
    assert.equal(await menu.getByRole('menuitem', { name: 'Cancel tool', exact: true }).count(), 1);
  };
  const initial = await state();

  await open({ x: -2, y: 8 });
  assert.equal(
    await menu.getByRole('menuitem', { name: 'Fillet corners', exact: true }).count(),
    0,
    'Empty selection has no region operation.',
  );
  assert.equal(
    await menu.getByRole('menuitem', { name: /Delete/ }).count(),
    0,
    'Empty selection has no object deletion.',
  );
  assert.equal(
    await menu.getByRole('menuitem', { name: 'Fit board to canvas', exact: true }).isEnabled(),
    true,
  );
  for (const name of ['Zoom in', 'Zoom out', 'Export image', 'Select all'])
    assert.equal(await menu.getByRole('menuitem', { name, exact: true }).isEnabled(), true);
  assert.equal(
    await menu.getByRole('menuitem', { name: 'Clear selection', exact: true }).count(),
    0,
  );
  await page.evaluate(() => {
    const neighbor = document.createElement('div');
    neighbor.id = 'neighbor-scroll';
    document.body.append(neighbor);
    neighbor.dispatchEvent(new Event('scroll'));
    neighbor.remove();
  });
  assert.equal(await menu.count(), 1, 'Scrolling a neighboring panel retains the menu.');
  await close();
  assert.equal(
    await canvas.evaluate((svg) => document.activeElement === svg),
    true,
    'Closing restores canvas focus.',
  );

  await point({ x: 24, y: 25 }, 'left');
  const selected = (await context()).selection;
  assert.deepEqual(selected, [{ kind: 'track', id: ids.track }]);
  const beforeView = (await context()).viewport;
  await open({ x: -2, y: 8 });
  assert.deepEqual(
    (await context()).viewport,
    beforeView,
    'Stationary right click retains the camera.',
  );
  assert.deepEqual(
    (await context()).selection,
    selected,
    'Empty-space right click retains selection.',
  );
  assert.equal(
    await menu.getByRole('menuitem', { name: 'Fillet corners', exact: true }).count(),
    0,
    'Tracks have no region fillet.',
  );
  assert.equal(
    await menu.getByRole('menuitem', { name: 'Drag connected tracks', exact: true }).count(),
    1,
    'Tracks expose their drag operation.',
  );
  assert.equal(
    await menu.getByRole('menuitem', { name: /Flip/i }).count(),
    0,
    'Tracks have no footprint flip.',
  );
  await compactSelectionMenu();
  await close();
  assert.equal(
    await canvas.evaluate(
      (svg) =>
        !svg.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })),
    ),
    true,
    'Native browser context menu is suppressed.',
  );
  await unchanged();

  // Keyboard opening and menu ownership include legacy IME key code 229.
  for (const key of ['ContextMenu', 'Shift+F10']) {
    await canvas.dispatchEvent('keydown', {
      key: key === 'ContextMenu' ? 'ContextMenu' : 'F10',
      shiftKey: key !== 'ContextMenu',
      keyCode: 229,
      isComposing: true,
    });
    assert.equal(await menu.count(), 0, 'Composition cannot open canvas commands.');
    await canvas.press(key);
    await menu.waitFor();
    await compactSelectionMenu();
    const first = await page.evaluate(() => document.activeElement?.textContent);
    await page.keyboard.press('ArrowDown');
    assert.notEqual(
      await page.evaluate(() => document.activeElement?.textContent),
      first,
      'Arrow keys move menu focus.',
    );
    await menu.dispatchEvent('keydown', { key: 'Escape', keyCode: 229, isComposing: true });
    assert.equal(await menu.count(), 1, 'Composition cannot dismiss commands.');
    await close();
  }
  await unchanged();
  await canvas.press('Escape');
  assert.deepEqual((await context()).selection, [], 'Canvas Escape still clears the selection.');
  await open({ x: -2, y: 8 });
  assert.equal(
    await menu.getByRole('menuitem', { name: 'Clear selection', exact: true }).count(),
    0,
  );
  assert.equal(
    await menu.getByRole('menuitem', { name: 'Select all', exact: true }).isEnabled(),
    true,
  );
  await close();
  await point({ x: 24, y: 25 }, 'left');
  assert.deepEqual((await context()).selection, selected);
  await open({ x: -2, y: 8 });
  await canvas.evaluate((svg) => svg.parentElement.dispatchEvent(new Event('scroll')));
  await menu.waitFor({ state: 'hidden' });
  await canvas.focus();
  console.log(
    'Layout context menu: stationary and keyboard openings, object actions, focus and IME are guarded.',
  );

  for (const button of ['right', 'middle']) {
    const beforePan = (await context()).viewport;
    const start = await screen({ x: -2, y: 8 });
    await page.mouse.move(start.x, start.y);
    await page.mouse.down({ button });
    await page.mouse.move(start.x + 65, start.y + 35, { steps: 4 });
    await page.mouse.up({ button });
    await frames();
    assert.notDeepEqual((await context()).viewport, beforePan, `${button} drag still pans.`);
    assert.deepEqual((await context()).selection, selected);
    assert.equal(await menu.count(), 0, 'A pan never opens commands.');
    await unchanged();
  }

  await canvas.press('Home');
  await point({ x: 24, y: 25 });
  await canvas.press('m');
  await point({ x: 28, y: 29 });
  const movedGeometry = () =>
    canvas
      .locator('[data-layout-track-target]')
      .evaluateAll((nodes) =>
        nodes.map((node) => ['x1', 'y1', 'x2', 'y2'].map((name) => node.getAttribute(name))),
      );
  const movePreview = await movedGeometry();
  await open({ x: 28, y: 29 });
  await compactToolMenu();
  assert.equal(
    await page.locator('.layout-canvas.is-moving').count(),
    1,
    'Opening commands retains Move.',
  );
  assert.deepEqual(await movedGeometry(), movePreview, 'Commands retain the exact move preview.');
  await unchanged();
  await close();
  await canvas.press('Escape');

  await point({ x: 24, y: 25 });
  await canvas.press('x');
  await point({ x: 28, y: 29 });
  const route = canvas.locator('[data-route-preview]');
  assert.equal(await route.count(), 1);
  const routePreview = await route.getAttribute('points');
  await open({ x: 28, y: 29 });
  await compactToolMenu();
  assert.equal(
    await route.getAttribute('points'),
    routePreview,
    'Commands retain the unfinished route.',
  );
  await unchanged();
  await close();
  await canvas.press('Escape');
  await canvas.press('Escape');
  console.log(
    'Layout context menu: drags pan without menus; opening commands preserves Move and route previews.',
  );

  // Direct right click changes inspection using the same geometric picker as left click.
  await open({ x: 58, y: 10 });
  assert.deepEqual((await context()).selection, [{ kind: 'footprint', id: ids.footprint }]);
  assert.equal(
    await menu.getByRole('menuitem', { name: 'Flip footprint', exact: true }).count(),
    1,
    'Footprints expose Flip.',
  );
  assert.equal(
    await menu.getByRole('menuitem', { name: 'Fillet corners', exact: true }).count(),
    0,
  );
  await compactSelectionMenu();
  await close();
  await open({ x: 55, y: 38 });
  assert.deepEqual(
    (await context()).selection,
    [{ kind: 'zone', id: ids.zone }],
    'Region interiors are right-click targets.',
  );
  assert.equal(
    await menu.getByRole('menuitem', { name: 'Fillet corners', exact: true }).isEnabled(),
    true,
  );
  await compactSelectionMenu();
  await mkdir('test-results', { recursive: true });
  await menu.screenshot({ path: 'test-results/layout-region-context-menu.png' });
  await menu.getByRole('menuitem', { name: 'Fillet corners', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Fillet corners', exact: true });
  await dialog.waitFor();
  const radius = dialog.getByRole('textbox', { name: 'Radius (mm)', exact: true });
  const apply = dialog.getByRole('button', { name: 'Apply', exact: true });
  assert.equal(
    await dialog.getByRole('button', { name: 'Close dialog', exact: true }).evaluate(
      (button) =>
        !button.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            keyCode: 229,
            isComposing: true,
            bubbles: true,
            cancelable: true,
          }),
        ),
    ),
    true,
    'Composition prevents the header Close button default activation.',
  );
  assert.equal(await dialog.count(), 1);
  await radius.fill('1000');
  if (await apply.isEnabled()) await apply.click();
  await unchanged();
  assert.equal(await dialog.count(), 1, 'Excessive radius remains retryable.');
  assert.equal(await radius.inputValue(), '1000');
  await radius.fill('2');
  await radius.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  await unchanged();
  await radius.dispatchEvent('keydown', { key: 'Escape', keyCode: 229, isComposing: true });
  assert.equal(await dialog.count(), 1, 'Composition cannot discard the radius.');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await unchanged();

  await open({ x: 55, y: 38 });
  await menu.getByRole('menuitem', { name: 'Fillet corners', exact: true }).click();
  await radius.fill('2');
  await mkdir('test-results', { recursive: true });
  await dialog.screenshot({ path: 'test-results/layout-region-fillet-dialog.png' });
  await apply.click();
  await waitForAsync(page, () => window.readState().undoDepth === 1);
  await dialog.waitFor({ state: 'hidden' });
  const rounded = await state();
  const zone = rounded.board.zones.find((item) => item.id === ids.zone);
  assert.ok(zone.outline.length > 4, 'Fillet is accepted native polygon geometry.');
  assert.equal(zone.id, ids.zone);
  assert.deepEqual(rounded.board.tracks, initial.board.tracks);
  assert.deepEqual(rounded.board.footprints, initial.board.footprints);
  assert.equal(rounded.undoDepth, 1, 'Fillet is exactly one whole-project undo edit.');
  assert.notDeepEqual(
    rounded.files,
    initial.files,
    'The native file set contains the accepted fillet.',
  );
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await waitForAsync(page, () => window.readState().undoDepth === 0);
  await unchanged();
  console.log(
    'Layout context menu: selected region fillet rejects invalid/IME input, cancels cleanly, commits once and undoes native geometry.',
  );

  const activeView = (await context()).viewport;
  await page.evaluate(() => window.setLayoutActive(false));
  await frames();
  const start = await screen({ x: -2, y: 8 });
  await page.mouse.click(start.x, start.y, { button: 'right' });
  await page.mouse.move(start.x, start.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(start.x + 60, start.y + 30, { steps: 3 });
  await page.mouse.up({ button: 'right' });
  await page.evaluate(() => window.setLayoutActive(true));
  await frames();
  assert.deepEqual(
    (await context()).viewport,
    activeView,
    'Inactive projects ignore pointer navigation.',
  );
  assert.equal(await menu.count(), 0, 'Inactive projects never open canvas commands.');
  await unchanged();
  assert.deepEqual(errors, []);
  console.log('Layout context menu: inactive projects remain unchanged.');
} finally {
  await browser.close();
}
