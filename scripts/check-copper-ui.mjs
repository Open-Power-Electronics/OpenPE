import { runCanvasAction } from './canvas-context-menu-test-helpers.mjs';
import {
  selectModelView,
  selectLayoutLayer,
  setLayoutVisibility,
  toggleLayoutVisualization,
} from './visualization-test-helpers.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { tsImport } from 'tsx/esm/api';

const { emptyCircuit } = await tsImport('../lib/circuit.ts', import.meta.url);
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const { filledCopperPolygons, fillCopperZones, polygonPath } = await tsImport(
  '../lib/pcb-polygons.ts',
  import.meta.url,
);
const rectangle = (x, y, w, h) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];
const board = createEmptyPCB();
const corners = rectangle(0, 0, 30, 20);
board.graphics = corners.map((start, i) => ({
  id: `edge-${i}`,
  layer: 'Edge.Cuts',
  width: 0.1,
  start,
  end: corners[(i + 1) % 4],
}));
board.graphics.push({
  id: 'cutout',
  kind: 'circle',
  layer: 'Edge.Cuts',
  width: 0.1,
  start: { x: 15, y: 10 },
  end: { x: 17, y: 10 },
});
for (const [layer, value, y] of [
  ['F.SilkS', 'FRONT', 4],
  ['B.SilkS', 'BACK', 16],
  ['F.Fab', 'FAB', 7],
])
  board.graphics.push({
    id: layer,
    kind: 'text',
    layer,
    width: 0.15,
    start: { x: 8, y },
    end: { x: 8, y },
    text: { value, rotation: 0, size: { x: 1.5, y: 1.5 }, thickness: 0.15 },
  });
board.nets = [
  { id: 'ground', name: 'GND' },
  { id: 'signal', name: 'Signal' },
];
board.tracks = [
  {
    id: 'track',
    netId: 'signal',
    layer: 'F.Cu',
    width: 0.8,
    start: { x: 5, y: 10 },
    end: { x: 25, y: 10 },
  },
];
board.zones = ['F.Cu', 'B.Cu'].map((layer) => ({
  id: layer,
  netId: 'ground',
  layer,
  outline: rectangle(-2, -2, 34, 24),
  clearance: 0.5,
  fillEnabled: true,
  minThickness: 0.1,
  thermalGap: 0.3,
  thermalBridge: 0.3,
}));
board.footprints = ['front', 'back'].map((side, i) => ({
  id: `mask-pad-${side}`,
  libraryId: 'Test:MaskPad',
  symbolId: null,
  x: i ? 22 : 8,
  y: i ? 13 : 7,
  rotation: 0,
  side,
  graphics: [],
  pads: [
    {
      id: `pad-${side}`,
      number: '1',
      x: 0,
      y: 0,
      rotation: 0,
      size: { x: 2, y: 2 },
      shape: 'rect',
      type: 'smd',
      netId: 'ground',
      solderMaskMargin: 0.2,
    },
  ],
  // Inspect surface pixels without a component body hiding the aperture.
  models: [
    {
      path: 'Test.step',
      offset: { x: 0, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      rotation: { x: 0, y: 0, z: 0 },
      hidden: true,
    },
  ],
}));
const fixture = { board, schematic: emptyCircuit() };
const original = JSON.stringify(fixture);
const fills = filledCopperPolygons(fillCopperZones(board, 0.5));
const bundle = await build({
  stdin: {
    contents: `import React,{useState,useRef} from 'react';import {createRoot} from 'react-dom/client';
      import LayoutEditor from './components/LayoutEditor';import PCBModelPreview from './components/PCBModelPreview';
      function Test(){const [view,setView]=useState('layout');const [board,setBoard]=useState(window.fixture.board);window.setTestBoard=setBoard;
        const camera=useRef(null);window.camera=camera;
        return <><nav><button onClick={()=>setView('layout')}>Test Layout</button><button onClick={()=>setView('object')}>Test Model</button></nav>
          <main><div hidden={view!=='layout'} className="test-layout"><LayoutEditor board={board}
            schematic={window.fixture.schematic} active={view==='layout'} grid={false}
            onCommit={next=>{window.commits++;window.savedBoard=next;setBoard(next);return true}}
            annotations={[]} annotationSessionId="copper" onAnnotationsChange={()=>{}}/></div>
          {view==='object'&&<PCBModelPreview board={board} schematic={window.fixture.schematic}
            viewState={camera}/>}</main></>}
      createRoot(document.getElementById('root')).render(<Test/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outdir: 'test-results/copper/bundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});
await mkdir('test-results/copper', { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) => {
    if (new URL(route.request().url()).pathname === '/api/libraries/footprints')
      return route.fulfill({ json: { footprint: ['footprint', '"MaskPad"'] } });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  await page.evaluate((fixture) => {
    window.fixture = fixture;
    window.commits = 0;
    window.openpe = { connection: async () => ({ base: 'http://localhost', token: 'test' }) };
  }, fixture);
  for (const path of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(path, 'utf8') });
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
    await page.addStyleTag({ content: file.text });
  await page.addStyleTag({
    content:
      'html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}nav{height:32px}main{position:relative;flex:1;min-height:0}.test-layout,.layout-editor{height:100%}',
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const canvas = page.getByTestId('layout-canvas');
  await canvas.waitFor();
  await runCanvasAction(page, 'Fit board to canvas');
  assert.equal(
    await canvas.locator('[data-copper-zone]').first().getAttribute('d'),
    '',
    'Zone outlines do not imply completed copper.',
  );
  // Fill each zone explicitly from Properties using the actual outline.
  for (const zone of board.zones) {
    await setLayoutVisibility(page, 'F.Cu', zone.layer === 'F.Cu');
    await setLayoutVisibility(page, 'B.Cu', zone.layer === 'B.Cu');
    await selectLayoutLayer(page, zone.layer);
    const a = zone.outline[0],
      b = zone.outline[1];
    const at = await canvas.evaluate(
      (svg, at) => {
        const p = new DOMPoint(at.x, at.y).matrixTransform(svg.getScreenCTM());
        return { x: p.x, y: p.y };
      },
      { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    );
    await page.mouse.click(at.x, at.y);
    assert.equal(
      await page.getByRole('combobox', { name: 'Zone layer', exact: true }).innerText(),
      zone.layer,
    );
    const clearance = page.getByRole('spinbutton', { name: 'Clearance (mm)', exact: true });
    await clearance.fill('0.5');
    await clearance.press('Enter');
    await page.getByRole('button', { name: 'Fill zone', exact: true }).click();
  }
  await setLayoutVisibility(page, 'F.Cu', true);
  await setLayoutVisibility(page, 'B.Cu', true);
  await selectLayoutLayer(page, 'F.Cu');
  assert.ok(await page.evaluate(() => window.savedBoard.zones.every((z) => z.clearance === 0.5)));
  assert.ok(
    await page.evaluate(() => window.savedBoard.zones.every((z) => z.filledPolygons?.length)),
    JSON.stringify(
      await page.evaluate(() =>
        window.savedBoard.zones.map(({ id, fillEnabled, clearance, filledPolygons }) => ({
          id,
          fillEnabled,
          clearance,
          count: filledPolygons?.length,
        })),
      ),
    ),
  );
  const color = (text) =>
    canvas
      .getByText(text, { exact: true })
      .last()
      .evaluate((element) => getComputedStyle(element).fill);
  assert.equal(await color('FRONT'), 'rgb(128, 101, 21)');
  assert.equal(await color('BACK'), 'rgb(153, 76, 135)');
  // Enable Fab to verify it does not borrow either silkscreen color.
  await toggleLayoutVisualization(page, 'Visible layers');
  await page.getByRole('checkbox', { name: 'F.Fab', exact: true }).check();
  assert.equal(await color('FAB'), 'rgb(95, 101, 108)');
  for (const zone of board.zones) {
    const path = canvas.locator(`[data-copper-zone="${zone.id}"]`);
    assert.equal(await path.getAttribute('d'), polygonPath(fills.get(zone.id)));
    assert.equal(await path.locator('..').getAttribute('opacity'), '0.8');
    assert.notEqual(
      await path.getAttribute('d'),
      polygonPath([{ outer: zone.outline, holes: [] }]),
    );
  }
  assert.equal(await page.getByRole('slider', { name: 'Copper opacity', exact: true }).count(), 0);
  assert.equal(
    await canvas.locator('[data-copper-zone]').last().getAttribute('data-copper-zone'),
    'F.Cu',
    'Active copper is drawn above other copper layers.',
  );
  await toggleLayoutVisualization(page, 'Visible layers');
  await canvas.screenshot({ path: 'test-results/copper/layout.png' });
  const ready = async () => {
    await page.waitForFunction(
      () =>
        document.querySelector('.pcb-model-canvas canvas')?.width > 0 &&
        !document.querySelector('.pcb-model-preview [role="status"]'),
    );
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  };
  const captures = [];
  await button('Test Model').click();
  await ready();
  assert.equal(
    await page.getByRole('slider', { name: 'Copper opacity' }).count(),
    0,
    'Model has no opacity control.',
  );
  for (const direction of ['Top view', 'Bottom view']) {
    await selectModelView(page, direction);
    await ready();
    captures.push(
      await page.locator('.pcb-model-canvas canvas').screenshot({
        path: `test-results/copper/${direction.split(' ')[0].toLowerCase()}-copper.png`,
      }),
    );
  }
  await button('Test Layout').click();
  const savedCamera = await page.evaluate(() => window.camera.current);
  for (const [i, capture] of captures.entries()) {
    const { data, info } = await sharp(capture)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const scale = (info.height / savedCamera.extent) * savedCamera.zoom;
    const pixel = (x, y) => {
      const column = Math.round(
        info.width / 2 + (i ? -1 : 1) * (x - savedCamera.target[0]) * scale,
      );
      const row = Math.round(info.height / 2 + (y + savedCamera.target[1]) * scale);
      const start = (row * info.width + column) * 4;
      return [...data.subarray(start, start + 4)];
    };
    const pad = pixel(i ? 22 : 8, i ? 13 : 7);
    assert.ok(
      pad[0] > pad[1] + 10 && pad[1] > pad[2] + 10,
      `The ${i ? 'back' : 'front'} pad remains exposed metal: ${pad}.`,
    );
    const coated = pixel(i ? 5 : 6, i ? 13 : 10);
    assert.ok(
      coated[1] > coated[0] + 15 && coated[1] > coated[2] + 10,
      `The ${i ? 'back' : 'front'} copper is green under the mask: ${coated}.`,
    );
    assert.ok(
      pixel(15, 10)
        .slice(0, 3)
        .every((channel) => channel > 245),
      'Solder mask does not paint over the board cutout.',
    );
    let white = 0;
    for (let x = 4; x <= 12; x += 0.1)
      for (let y = i ? 15 : 3; y <= (i ? 17 : 5); y += 0.1)
        if (
          pixel(x, y)
            .slice(0, 3)
            .every((channel) => channel > 220)
        )
          white++;
    assert.ok(white > 30, 'White silkscreen prints above the green coating.');
  }
  await page.evaluate(() => window.setTestBoard(window.fixture.board));
  await button('Test Model').click();
  await ready();
  for (const [i, direction] of ['Top view', 'Bottom view'].entries()) {
    await selectModelView(page, direction);
    await ready();
    const blank = await page.locator('.pcb-model-canvas canvas').screenshot({
      path: `test-results/copper/${direction.split(' ')[0].toLowerCase()}-bare.png`,
    });
    const [a, b] = await Promise.all([
      sharp(captures[i]).ensureAlpha().raw().toBuffer(),
      sharp(blank).ensureAlpha().raw().toBuffer(),
    ]);
    assert.equal(a.length, b.length);
    let changed = 0;
    for (let pixel = 0; pixel < a.length; pixel += 4)
      if (
        Math.abs(a[pixel] - b[pixel]) +
          Math.abs(a[pixel + 1] - b[pixel + 1]) +
          Math.abs(a[pixel + 2] - b[pixel + 2]) >
        30
      )
        changed++;
    assert.ok(
      changed > 5000,
      `${direction}: real copper surfaces alter ${changed} rendered pixels.`,
    );
  }
  await button('Test Layout').click();
  assert.deepEqual(
    await page.evaluate(() => window.camera.current),
    savedCamera,
    'Changing saved fills preserves the saved 3D camera.',
  );
  await page.evaluate(() => window.setTestBoard(window.savedBoard));
  await page.evaluate(() => document.documentElement.style.setProperty('--canvas', '#181818'));
  await page.waitForFunction(
    () => document.querySelector('[data-layout-editor]')?.dataset.pcbTheme === 'dark',
  );
  assert.equal(await color('FRONT'), 'rgb(242, 233, 164)');
  assert.equal(await color('BACK'), 'rgb(231, 177, 216)');
  assert.equal(await color('FAB'), 'rgb(181, 187, 192)');
  await canvas.screenshot({ path: 'test-results/copper/layout-dark.png' });
  assert.equal(await page.evaluate(() => JSON.stringify(window.fixture)), original);
  assert.equal(
    await page.evaluate(() => window.commits),
    1,
    'Only explicit manual filling edits the board.',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Silkscreen colors, solder mask on both surfaces, metallic pad apertures, clipped copper, fixed fill display, camera preservation and unchanged design data passed.',
  );
} finally {
  await browser.close();
}
