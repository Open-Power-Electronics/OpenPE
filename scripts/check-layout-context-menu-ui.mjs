import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { emptyCircuit } = await tsImport('../lib/circuit.ts', import.meta.url);
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);

// Isolated renderer with real pointer and keyboard input. No Electron, native
// files, providers, services, or user project state is used by this check.
const bundle = await build({
  stdin: {
    contents: `import React,{useRef,useState} from 'react';import {createRoot} from 'react-dom/client';
      import LayoutEditor from './components/LayoutEditor';
      function Fixture(){const [active,setActive]=useState(true);const context=useRef(null);
        window.layoutContext=()=>context.current;window.setLayoutActive=setActive;
        return <LayoutEditor board={window.fixture.board} schematic={window.fixture.schematic} active={active}
          agentContextRef={context} onCommit={()=>{window.commits++;return false}}
          annotations={[]} annotationSessionId="pointer-navigation" onAnnotationsChange={()=>{}}/>}
      createRoot(document.getElementById('root')).render(<Fixture/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const board = {
  ...createEmptyPCB(),
  nets: [{ id: 'signal', name: 'SIGNAL' }],
  tracks: [
    {
      id: 'track',
      start: { x: 20, y: 25 },
      end: { x: 40, y: 25 },
      width: 0.4,
      layer: 'F.Cu',
      netId: 'signal',
    },
  ],
  graphics: [
    {
      id: 'edge',
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
};
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
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  await page.evaluate(
    (fixture) => {
      window.fixture = fixture;
      window.commits = 0;
    },
    { board, schematic: emptyCircuit() },
  );
  for (const content of styles) await page.addStyleTag({ content });
  await page.addStyleTag({ content: 'html,body,#root,.layout-editor{height:100%;margin:0}' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const canvas = page.getByTestId('layout-canvas');
  await canvas.waitFor();
  const frames = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  const context = () => page.evaluate(() => structuredClone(window.layoutContext()));
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
  const clean = async () => {
    assert.equal(
      await page.evaluate(() => window.commits),
      0,
      'Navigation never commits a design.',
    );
    assert.equal(await page.getByRole('menu').count(), 0, 'Right click never opens a menu.');
  };
  await point({ x: 24, y: 25 }, 'left');
  const selected = (await context()).selection;
  assert.deepEqual(selected, [{ kind: 'track', id: 'track' }]);
  const before = (await context()).viewport;
  await point({ x: 10, y: 8 }, 'right');
  assert.deepEqual((await context()).viewport, before, 'A right click leaves the camera still.');
  assert.deepEqual(
    (await context()).selection,
    selected,
    'Right click retains the existing selection.',
  );
  assert.equal(await canvas.evaluate((svg) => document.activeElement === svg), true);
  assert.equal(
    await canvas.evaluate(
      (svg) =>
        !svg.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
          }),
        ),
    ),
    true,
    'The native browser context menu is suppressed.',
  );
  await clean();
  console.log(
    'Layout pointer navigation: right click retains camera and selection without a menu.',
  );

  for (const button of ['right', 'middle']) {
    const beforePan = (await context()).viewport;
    const start = await screen({ x: 10, y: 8 });
    await page.mouse.move(start.x, start.y);
    await page.mouse.down({ button });
    await page.mouse.move(start.x + 65, start.y + 35, { steps: 4 });
    await page.mouse.up({ button });
    await frames();
    assert.notDeepEqual((await context()).viewport, beforePan, `${button} drag still pans.`);
    assert.deepEqual((await context()).selection, selected);
    await clean();
  }
  console.log('Layout pointer navigation: right and middle drags pan without editing.');

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
  await point({ x: 28, y: 29 }, 'right');
  assert.equal(
    await page.locator('.layout-canvas.is-moving').count(),
    1,
    'Right click retains Move.',
  );
  assert.deepEqual(
    await movedGeometry(),
    movePreview,
    'Right click retains the exact move preview.',
  );
  await clean();
  await canvas.press('Escape');

  await point({ x: 24, y: 25 });
  await canvas.press('x');
  await point({ x: 28, y: 29 });
  const route = canvas.locator('[data-route-preview]');
  assert.equal(await route.count(), 1);
  const routePreview = await route.getAttribute('points');
  await point({ x: 28, y: 29 }, 'right');
  assert.equal(await route.count(), 1, 'Right click retains the unfinished route.');
  assert.equal(await route.getAttribute('points'), routePreview);
  await clean();
  await canvas.press('Escape');
  console.log(
    'Layout pointer navigation: right click never commits or cancels move/route previews.',
  );

  const activeView = (await context()).viewport;
  await page.evaluate(() => window.setLayoutActive(false));
  await frames();
  const start = await screen({ x: 10, y: 8 });
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
  await clean();
  assert.deepEqual(errors, []);
  console.log('Layout pointer navigation: inactive projects remain unchanged.');
} finally {
  await browser.close();
}
