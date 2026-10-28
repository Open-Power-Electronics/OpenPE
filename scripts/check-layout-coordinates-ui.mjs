import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { emptyCircuit, uid } = await tsImport('../lib/circuit.ts', import.meta.url);
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const board = createEmptyPCB(),
  netId = uid();
board.nets = [{ id: netId, name: 'OUT' }];
board.tracks = [
  { id: uid(), start: { x: 20, y: 20 }, end: { x: 40, y: 20 }, width: 0.4, layer: 'F.Cu', netId },
  { id: uid(), start: { x: 100, y: 70 }, end: { x: 115, y: 70 }, width: 0.4, layer: 'F.Cu', netId },
];
board.graphics = [
  {
    id: uid(),
    kind: 'polygon',
    layer: 'Edge.Cuts',
    width: 0.1,
    start: { x: 0, y: 0 },
    points: [
      { x: 60, y: 0 },
      { x: 60, y: 50 },
    ],
    end: { x: 0, y: 50 },
  },
];

// Isolated retained Layout with real keyboard/pointer events, no native files or service.
const bundle = await build({
  stdin: {
    contents: `import React,{useRef,useState} from 'react';import {createRoot} from 'react-dom/client';
      import LayoutEditor from './components/LayoutEditor';
      function Fixture(){const [active,setActive]=useState(true);const [probing,setProbing]=useState(false);const context=useRef(null);
        window.setLayoutActive=setActive;window.setLayoutProbing=setProbing;window.layoutContext=()=>context.current;
        return <><input aria-label="Outside input" style={{position:'fixed',top:0,left:0,width:100,zIndex:100}}/>
          <LayoutEditor board={window.fixture.board} schematic={window.fixture.schematic} active={active}
            agentContextRef={context} onCommit={()=>{window.commits++;return false}}
            onAnalysisProbe={probing ? ()=>{} : undefined}
            annotations={[]} annotationSessionId="coordinates" onAnnotationsChange={()=>{}}/></>}
      createRoot(document.getElementById('root')).render(<Fixture/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [
    {
      name: 'count-coordinate-isolation',
      setup(plugin) {
        plugin.onLoad(
          { filter: /[\\/](LayoutEditor|CanvasCoordinates)\.tsx$/ },
          async ({ path: file }) => {
            let contents = await readFile(file, 'utf8');
            const editor = path.basename(file) === 'LayoutEditor.tsx';
            const marker = editor
              ? '  const pcb = board ?? empty;'
              : '  const snapshot = relative ? coordinates.getRelativeSnapshot : coordinates.getSnapshot;';
            assert.ok(contents.includes(marker), `Instrumentation finds ${path.basename(file)}.`);
            contents = contents.replace(
              marker,
              `  window.coordinateWork.${editor ? 'editors' : 'readouts'}++;\n${marker}`,
            );
            return { contents, loader: 'tsx', resolveDir: path.dirname(file) };
          },
        );
      },
    },
  ],
});
const browser = await chromium.launch({
  headless: true,
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
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
      window.coordinateWork = { editors: 0, readouts: 0 };
    },
    { board, schematic: emptyCircuit() },
  );
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({ content: 'html,body,#root,.layout-editor{height:100%;margin:0}' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const canvas = page.getByTestId('layout-canvas'),
    readout = page.locator('.status-coordinate');
  await canvas.waitFor();
  await canvas.focus();
  const frames = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  const point = async (p, click = false) => {
    const at = await canvas.evaluate((svg, p) => {
      const at = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
      return { x: at.x, y: at.y };
    }, p);
    await page.mouse.move(at.x, at.y);
    if (click) await page.mouse.click(at.x, at.y);
    await frames();
  };
  const work = () => page.evaluate(() => structuredClone(window.coordinateWork));
  const view = () => canvas.getAttribute('viewBox');
  const selection = () => page.evaluate(() => structuredClone(window.layoutContext().selection));
  const expectReadout = async (x, y) =>
    assert.equal(await readout.innerText(), `X ${x.toFixed(2)} Y ${y.toFixed(2)} mm`);
  const clean = async () => assert.equal(await page.evaluate(() => window.commits), 0);

  await point({ x: 26, y: 20 }, true);
  const beforeSelection = await selection(),
    beforeView = await view();
  await point({ x: 30, y: 25 });
  await canvas.press('Space');
  await frames();
  await expectReadout(30, 25);
  const boardView = await view();
  assert.notEqual(boardView, beforeView, 'Space fits board edges without off-board copper.');
  assert.deepEqual(await selection(), beforeSelection, 'Fitting preserves selection.');
  const afterFit = await work();
  await point({ x: 33, y: 21 });
  await expectReadout(33, 21);
  await point({ x: 27, y: 29 });
  await expectReadout(27, 29);
  assert.equal(
    (await work()).editors,
    afterFit.editors,
    'Idle measurement does not render Layout.',
  );
  await clean();
  console.log('Layout coordinates: absolute X/Y only and readout-only pointer renders.');

  await canvas.press('m');
  await point({ x: 32, y: 24 });
  await canvas.press('Control+Home');
  await frames();
  const moveGeometry = () =>
    canvas
      .locator('[data-layout-track-target]')
      .evaluateAll((nodes) =>
        nodes.map((node) => ['x1', 'y1', 'x2', 'y2'].map((name) => node.getAttribute(name))),
      );
  const movedTracks = await moveGeometry();
  const moveView = await view();
  await canvas.press('Space');
  await frames();
  await expectReadout(32, 24);
  assert.equal(await page.locator('.layout-canvas.is-moving').count(), 1);
  assert.notEqual(await view(), moveView, 'Space returns to the board during Move.');
  assert.equal(await view(), boardView);
  assert.deepEqual(await moveGeometry(), movedTracks);
  await clean();
  await canvas.press('Escape');

  await canvas.press('Home');
  await frames();
  await point({ x: 25, y: 20 });
  await canvas.press('x');
  const route = canvas.locator('[data-route-preview]');
  assert.equal(await route.count(), 1, 'Hover X starts the route at the existing track.');
  await clean();
  await point({ x: 38, y: 25 });
  await canvas.press('Control+Home');
  await frames();
  const routeGeometry = await route.getAttribute('points'),
    routeView = await view();
  await canvas.press('Space');
  await frames();
  await expectReadout(38, 25);
  assert.equal(await route.count(), 1);
  assert.equal(await route.getAttribute('points'), routeGeometry);
  assert.notEqual(await view(), routeView, 'Space returns to the board during routing.');
  assert.equal(await view(), boardView);
  await clean();
  await canvas.press('Escape');
  console.log('Layout coordinates: Space retains active move and routing previews.');

  await canvas.press('Home');
  await frames();
  assert.equal(await view(), boardView);
  await canvas.press('Control+Home');
  await frames();
  const allView = await view();
  assert.ok(
    Number(allView.split(' ')[2]) > Number(boardView.split(' ')[2]),
    'Fit all includes off-board copper.',
  );
  await canvas.press('Home');
  assert.equal(await view(), boardView);
  await canvas.press('Meta+Home');
  assert.equal(await view(), allView);
  for (const shortcut of ['Control+Space', 'Meta+Space', 'Alt+Space']) {
    await canvas.press(shortcut);
    assert.equal(await view(), allView, `${shortcut} leaves the camera unchanged.`);
  }
  for (const event of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }]) {
    await canvas.dispatchEvent('keydown', { key: ' ', code: 'Space', ...event });
    assert.equal(await view(), allView, 'Repeat and composition cannot fit the board.');
  }
  await page.evaluate(() => window.setLayoutProbing(true));
  await frames();
  await canvas.press('Space');
  assert.equal(await view(), boardView, 'Space also fits the board while probing thermal results.');
  await page.evaluate(() => window.setLayoutProbing(false));
  await frames();
  await canvas.press('Control+Home');
  await point({ x: 30, y: 25 });
  const protectedReadout = await readout.innerText(),
    protectedView = await view();
  await page.getByRole('textbox', { name: 'Outside input' }).focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('Home');
  await page.keyboard.press('Control+Home');
  assert.equal(await readout.innerText(), protectedReadout);
  assert.equal(await view(), protectedView);
  await canvas.focus();
  await page.evaluate(() => {
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.id = 'test-open-menu';
    document.body.append(menu);
  });
  await canvas.press('Space');
  await canvas.press('Home');
  await canvas.press('Control+Home');
  assert.equal(await readout.innerText(), protectedReadout);
  assert.equal(await view(), protectedView);
  await page.evaluate(() => document.getElementById('test-open-menu').remove());
  await page.evaluate(() => window.setLayoutActive(false));
  await frames();
  await canvas.press('Space');
  await canvas.press('Home');
  await canvas.press('Control+Home');
  assert.equal(await readout.innerText(), protectedReadout);
  assert.equal(await view(), protectedView);
  await clean();
  assert.deepEqual(errors, []);
  console.log(
    'Layout coordinates: board/all fits, text focus, overlays and inactive project gates.',
  );
} finally {
  await browser.close();
}
