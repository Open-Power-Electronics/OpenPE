import { openVisualization, toggleLayoutVisualization } from './visualization-test-helpers.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { emptyCircuit, createPart, uid } = await tsImport('../lib/circuit.ts', import.meta.url);
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const { createPCBRouter } = await tsImport('../lib/pcb-routing.ts', import.meta.url);
const { layoutGridMetrics } = await tsImport('../lib/drawing-grid.ts', import.meta.url);
const { parseProject, serializeProject, createProject } = await tsImport(
  '../lib/project.ts',
  import.meta.url,
);
const board = createEmptyPCB();
const schematic = emptyCircuit();
board.nets = [
  { id: uid(), name: 'OUT' },
  { id: uid(), name: 'GND' },
];
const rectangle = (a, b, c, d) => [
  { x: a, y: b },
  { x: c, y: b },
  { x: c, y: d },
  { x: a, y: d },
];
board.graphics = [
  {
    id: uid(),
    kind: 'polygon',
    layer: 'Edge.Cuts',
    width: 0.1,
    start: { x: -4, y: -7 },
    points: [
      { x: 24, y: -7 },
      { x: 24, y: 9 },
    ],
    end: { x: -4, y: 9 },
  },
];
board.footprints = [0.123456, 20.234567].map((x, i) => {
  const part = createPart(schematic, 'Port', i * 12.7, 0);
  schematic.parts.push(part);
  return {
    id: uid(),
    symbolId: part.id,
    libraryId: 'Test:Pad',
    x,
    y: 0.654321,
    rotation: 0,
    side: 'front',
    graphics: [],
    pads: [
      {
        id: uid(),
        number: '1',
        x: 0,
        y: 0,
        rotation: 0,
        type: 'thru_hole',
        drill: 0.6,
        shape: 'rect',
        size: { x: 2, y: 2 },
        netId: board.nets[0].id,
      },
    ],
  };
});
board.tracks = [
  {
    id: uid(),
    start: { x: 10, y: -2 },
    end: { x: 10, y: 3 },
    width: 0.8,
    layer: 'F.Cu',
    netId: board.nets[1].id,
  },
];
board.zones = [
  {
    id: uid(),
    netId: board.nets[0].id,
    layer: 'F.Cu',
    outline: rectangle(-2, -5, 22, 7),
    clearance: 0.25,
    minThickness: 0.2,
    thermalGap: 0.3,
    thermalBridge: 0.3,
    // Same-net copper goes around the foreign trace rather than crossing it.
    filledPolygons: [
      {
        points: [
          { x: -1, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 5 },
          { x: 19, y: 5 },
          { x: 19, y: 0 },
          { x: 21, y: 0 },
          { x: 21, y: 7 },
          { x: -1, y: 7 },
        ],
      },
    ],
  },
];
const bundle = await build({
  stdin: {
    contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
    import LayoutEditor from './components/LayoutEditor';
    import Select from './components/Select';
    import {defaultLayoutGridSpacing,layoutGridSpacingOptions} from './lib/layout-grid';
    function Test(){const [board,setBoard]=useState(window.fixture.board);const [history,setHistory]=useState([]);
      const [grid,setGrid]=useState(true);const [spacing,setSpacing]=useState(defaultLayoutGridSpacing);
      window.replaceBoard=next=>{window.lastBoard=next;setBoard(next)};
      return <LayoutEditor board={board} schematic={window.fixture.schematic} active grid={grid} gridSpacing={spacing}
        gridControl={<Select label="Grid density" value={grid?String(spacing):'off'}
          options={[...layoutGridSpacingOptions.map(value=>({value:String(value),label:value+' mm'})),{value:'off',label:'Off'}]}
          onChange={value=>{setGrid(value!=='off');if(value!=='off')setSpacing(Number(value))}}/>}
        onCommit={next=>{window.lastBoard=next;window.commits++;setHistory([...history,board]);setBoard(next);return true}}
        undoAction={<button aria-label="Undo" onClick={()=>{window.lastBoard=history.at(-1);setBoard(history.at(-1));setHistory(history.slice(0,-1))}}>Undo</button>}
        annotations={[]} annotationSessionId="routing" onAnnotationsChange={()=>{}}/>}
    createRoot(document.getElementById('root')).render(<Test/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [
    {
      name: 'count-route-searches',
      setup(plugin) {
        plugin.onLoad({ filter: /[\\/]pcb-routing\.ts$/ }, async ({ path }) => {
          const source = await readFile(path, 'utf8');
          const signature = /function route\([\s\S]*?\): RouteResult \{/;
          assert.match(source, signature, 'Instrument the shared router entry point.');
          return {
            contents: source.replace(
              signature,
              '$&\n    window.routeSearches = (window.routeSearches || 0) + 1;',
            ),
            loader: 'ts',
          };
        });
      },
    },
  ],
});
await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  await page.evaluate(
    (fixture) => {
      window.fixture = fixture;
      window.lastBoard = fixture.board;
      window.commits = 0;
    },
    { board, schematic },
  );
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({ content: 'html,body,#root,.layout-editor{height:100%;margin:0}' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const canvas = page.getByTestId('layout-canvas');
  await canvas.waitFor();
  const button = (name) => page.getByRole('button', { name, exact: true });
  const screenPoint = (p) =>
    canvas.evaluate((svg, point) => {
      const screen = new DOMPoint(point.x, point.y).matrixTransform(svg.getScreenCTM());
      return { x: screen.x, y: screen.y };
    }, p);
  const point = async (p, click = false) => {
    const at = await screenPoint(p);
    await page.mouse.move(at.x, at.y);
    if (click) await page.mouse.click(at.x, at.y);
  };
  const replace = async (next) => {
    await page.evaluate((b) => window.replaceBoard(b), next);
    await page.waitForTimeout(50);
  };
  const commits = () => page.evaluate(() => window.commits);
  assert.equal(
    await canvas.locator('[data-airwire]').count(),
    0,
    'Saved copper suppresses already-connected airwires.',
  );
  assert.equal(await commits(), 0);
  const unfilled = structuredClone(board);
  delete unfilled.zones[0].filledPolygons;
  await replace(unfilled);
  assert.equal(await canvas.locator('[data-airwire]').count(), 1);
  const airwire = canvas.locator('[data-airwire] path').last();
  const screenStroke = () =>
    airwire.evaluate((element) => {
      const transform = getComputedStyle(element.ownerSVGElement).transform;
      const matrix = new DOMMatrixReadOnly(transform === 'none' ? undefined : transform);
      return (
        Number.parseFloat(getComputedStyle(element).strokeWidth) * Math.hypot(matrix.a, matrix.b)
      );
    });
  const stroke = await screenStroke();
  const previousZoom = await page.locator('.layout-editor .zoom-value').innerText();
  await button('Zoom in').click();
  await page.waitForFunction(
    (value) => document.querySelector('.layout-editor .zoom-value')?.textContent !== value,
    previousZoom,
  );
  assert.ok(
    Math.abs((await screenStroke()) - stroke) < 0.001,
    'Camera composition retains screen stroke width.',
  );
  assert.equal(
    await canvas.locator('[data-airwire] path').last().getAttribute('vector-effect'),
    'non-scaling-stroke',
  );
  // Keep the first pad below the compact routing card.
  const panFrom = await screenPoint({ x: 6, y: 0.65 });
  await page.mouse.move(panFrom.x, panFrom.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(panFrom.x, panFrom.y + 64, { steps: 3 });
  await page.mouse.up({ button: 'right' });
  // Hidden copper remains an obstacle to the active routing layer.
  await toggleLayoutVisualization(page, 'Visible layers');
  await page.getByRole('checkbox', { name: 'F.Cu', exact: true }).uncheck();
  await toggleLayoutVisualization(page, 'Visible layers');
  await button('Route tracks').click();
  const routingSettings = page.getByRole('complementary', { name: 'Routing settings' });
  await routingSettings.waitFor();
  await routingSettings.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  );
  assert.equal(await canvas.locator('pattern').getAttribute('width'), '0.5');
  assert.equal(await page.getByRole('complementary', { name: 'Layout properties' }).count(), 0);
  const canvasBounds = await canvas.boundingBox();
  const settingsBounds = await routingSettings.boundingBox();
  assert.equal(settingsBounds.x, canvasBounds.x + 12);
  assert.equal(settingsBounds.y, canvasBounds.y + 8);
  assert.ok(
    settingsBounds.width < canvasBounds.width - 24,
    'Routing settings fit their three parameters instead of filling the drawing width.',
  );
  assert.ok(settingsBounds.height <= 120, 'Routing settings use a shallow parameter strip.');
  assert.ok(settingsBounds.x + settingsBounds.width <= canvasBounds.x + canvasBounds.width - 11);
  assert.equal(
    await routingSettings.evaluate((element) => element.scrollWidth > element.clientWidth),
    false,
  );
  const sheetFields = await routingSettings.locator('.layout-field').evaluateAll((fields) =>
    fields.map((field) => {
      const { x, y } = field.getBoundingClientRect();
      return { x, y };
    }),
  );
  assert.deepEqual(
    await routingSettings
      .getByRole('spinbutton')
      .evaluateAll((inputs) => inputs.map((input) => input.getAttribute('aria-label'))),
    ['Track width (mm)', 'Via diameter (mm)', 'Via drill (mm)'],
    'All three routing dimensions remain available before a via transition.',
  );
  assert.equal(await routingSettings.getByRole('combobox').count(), 0);
  assert.equal(await routingSettings.getByRole('checkbox').count(), 0);
  if (settingsBounds.width >= 480)
    assert.ok(
      Math.abs(sheetFields[0].y - sheetFields[1].y) < 1 && sheetFields[1].x > sheetFields[0].x,
      'Routing parameters share a horizontal row beneath the toolbar.',
    );
  assert.equal(await routingSettings.getByText('Grid', { exact: true }).count(), 0);
  assert.equal(await routingSettings.getByRole('textbox', { name: 'New net name' }).count(), 0);
  assert.equal(await button('Route tracks').getAttribute('aria-expanded'), 'true');
  assert.equal(await commits(), 0, 'Opening routing settings leaves the project clean.');
  await point(board.footprints[0], true);
  await point(board.footprints[1]);
  const draft = canvas.locator('[data-route-preview]');
  await draft.waitFor();
  assert.equal(await draft.getAttribute('data-route-blocked'), 'false');
  const points = (await draft.getAttribute('points')).split(' ').map((s) => {
    const [x, y] = s.split(',').map(Number);
    return { x, y };
  });
  assert.ok(points.length > 2, 'The live head walks around the hidden trace.');
  assert.deepEqual(points[0], { x: board.footprints[0].x, y: board.footprints[0].y });
  assert.deepEqual(points.at(-1), { x: board.footprints[1].x, y: board.footprints[1].y });
  assert.equal(
    createPCBRouter(unfilled, {
      layer: 'F.Cu',
      width: 0.4,
      clearance: 0.25,
      netId: board.nets[0].id,
    }).validate(points),
    '',
  );
  await toggleLayoutVisualization(page, 'Visible layers');
  await page.getByRole('checkbox', { name: 'F.Cu', exact: true }).check();
  await toggleLayoutVisualization(page, 'Visible layers');
  await page.screenshot({ path: 'test-results/layout-walkaround-light.png' });
  await point(board.footprints[1], true);
  assert.equal(await commits(), 1, 'A completed route commits once.');
  const routed = await page.evaluate(() => window.lastBoard);
  assert.deepEqual(routed.tracks[0], board.tracks[0]);
  assert.equal(await canvas.locator('[data-airwire]').count(), 0);
  const project = createProject(schematic);
  project.pcb = routed;
  assert.deepEqual(
    parseProject(serializeProject(project)).pcb,
    routed,
    'Routes persist through the private project snapshot.',
  );
  await button('Undo').click();
  assert.deepEqual(
    await page.evaluate(() => window.lastBoard),
    unfilled,
    'One undo restores all segments.',
  );

  // A wall joined to the board edges leaves no legal detour.
  const wall = structuredClone(unfilled);
  wall.tracks[0].start.y = -7;
  wall.tracks[0].end.y = 9;
  await replace(wall);
  await button('Route tracks').click();
  await point(board.footprints[0], true);
  await point(board.footprints[1]);
  assert.equal(await draft.getAttribute('data-route-blocked'), 'true');
  assert.equal(await canvas.locator('[data-route-obstacle]').count(), 1);
  await point(board.footprints[1], true);
  assert.equal(await commits(), 1, 'Blocked target never commits a partial or colliding route.');
  await canvas.press('Escape');
  assert.equal(await draft.count(), 0);
  assert.deepEqual(await page.evaluate(() => window.lastBoard), wall);

  await replace(unfilled);
  await button('Route tracks').click();
  await point(board.footprints[0], true);
  await point({ x: 3.81, y: 3.81 }, true);
  await point({ x: 6.35, y: 5.08 });
  await canvas.press('Backspace');
  const reverted = (await draft.getAttribute('points'))
    .split(' ')
    .map((s) => s.split(',').map(Number));
  assert.equal(reverted[0][0], board.footprints[0].x);
  assert.ok(
    !reverted.some(([x, y]) => x === 3.81 && y === 3.81),
    'Backspace removes the locked waypoint.',
  );
  await canvas.press('/');
  assert.equal(await commits(), 1, 'Posture and waypoint changes remain transient.');
  await canvas.press('Escape');
  await button('Route tracks').click();
  await point(board.footprints[0], true);
  await point({ x: 7.62, y: 0 }, true);
  const widthInput = page.getByRole('spinbutton', { name: 'Track width (mm)', exact: true });
  await widthInput.fill('4');
  await widthInput.press('Enter');
  assert.equal(
    await draft.getAttribute('data-route-blocked'),
    'true',
    'Wider fixed segments are revalidated immediately.',
  );
  await canvas.press('Enter');
  assert.equal(await commits(), 1, 'Changing width cannot commit colliding fixed waypoints.');
  await widthInput.fill('0.4');
  await widthInput.press('Enter');
  await canvas.press('Escape');
  // A foreign pour covers both anchors and the entire route on the active layer.
  const poured = structuredClone(board);
  poured.tracks = [];
  poured.zones[0].netId = poured.nets[1].id;
  poured.zones[0].filledPolygons = [{ points: poured.zones[0].outline }];
  await replace(poured);
  await button('Route tracks').click();
  await point(board.footprints[0], true);
  await point(board.footprints[1]);
  assert.equal(await draft.getAttribute('data-route-blocked'), 'false');
  assert.equal((await draft.getAttribute('points')).split(' ').length, 2);
  assert.deepEqual(await page.evaluate(() => window.lastBoard), poured);
  const commitsBeforePourRoute = await commits();
  await point(board.footprints[1], true);
  assert.equal(await commits(), commitsBeforePourRoute + 1);
  const throughPour = await page.evaluate(() => window.lastBoard);
  assert.equal(throughPour.tracks.length, 1);
  assert.equal(
    throughPour.zones[0].filledPolygons,
    undefined,
    'New tracks invalidate saved pours.',
  );
  assert.deepEqual(throughPour.zones[0].outline, poured.zones[0].outline);
  await button('Undo').click();
  assert.deepEqual(await page.evaluate(() => window.lastBoard), poured);

  // Display density and pointer placement share one grid, including hidden dots.
  const clearBoard = structuredClone(board);
  clearBoard.tracks = [];
  clearBoard.zones = [];
  await replace(clearBoard);
  const selectGrid = async (name) => {
    await page.getByRole('combobox', { name: 'Grid density', exact: true }).click();
    await page.getByRole('option', { name, exact: true }).click();
  };
  const assertGrid = async (spacing, visible = true) => {
    const unitsPerPixel = await canvas.evaluate((svg) => {
      const transform = svg.getScreenCTM();
      return 1 / Math.hypot(transform.a, transform.b);
    });
    const displaySpacing = layoutGridMetrics(spacing, unitsPerPixel).spacing;
    assert.equal(
      await canvas.locator('pattern').getAttribute('data-layout-grid-spacing'),
      String(spacing),
    );
    assert.equal(await canvas.locator('pattern').getAttribute('width'), String(displaySpacing));
    assert.equal(await canvas.locator('pattern').getAttribute('height'), String(displaySpacing));
    assert.equal(await canvas.locator('[data-layout-grid]').count(), visible ? 1 : 0);
  };
  await button('Route tracks').click();
  const beforeSettings = await commits();
  await widthInput.fill('0.6');
  await widthInput.press('Enter');
  await selectGrid('0.25 mm');
  await assertGrid(0.25);
  assert.equal(
    await commits(),
    beforeSettings,
    'Tool geometry and grid settings are presentation state.',
  );
  await point({ x: 5.63, y: 3.63 }, true);
  await point({ x: 7.62, y: 3.63 });
  const gridPoints = () =>
    draft
      .getAttribute('points')
      .then((value) => value.split(' ').map((p) => p.split(',').map(Number)));
  assert.deepEqual((await gridPoints())[0], [5.75, 3.75]);
  assert.deepEqual((await gridPoints()).at(-1), [7.5, 3.75]);
  await selectGrid('0.5 mm');
  await assertGrid(0.5);
  await point({ x: 7.62, y: 3.63 });
  assert.deepEqual((await gridPoints()).at(-1), [7.5, 3.5]);
  await point({ x: 7.62, y: 3.63 }, true);
  await canvas.press('Enter');
  const gridRouted = await page.evaluate(() => window.lastBoard);
  assert.equal(await commits(), beforeSettings + 1);
  assert.deepEqual(gridRouted.tracks[0].start, { x: 5.75, y: 3.75 });
  assert.deepEqual(gridRouted.tracks.at(-1).end, { x: 7.5, y: 3.5 });
  assert.ok(gridRouted.tracks.every((track) => track.width === 0.6));
  await button('Undo').click();
  assert.deepEqual(await page.evaluate(() => window.lastBoard), clearBoard);

  // Precise electrical anchors still override the drawing grid.
  await button('Route tracks').click();
  await point(board.footprints[0], true);
  await point(board.footprints[1]);
  assert.deepEqual((await gridPoints())[0], [board.footprints[0].x, board.footprints[0].y]);
  assert.deepEqual((await gridPoints()).at(-1), [board.footprints[1].x, board.footprints[1].y]);
  const beforeCancel = await commits();
  await button('Close tool settings').click();
  assert.equal(await routingSettings.count(), 0);
  assert.equal(await draft.count(), 0);
  assert.equal(await canvas.evaluate((element) => document.activeElement === element), true);
  assert.equal(await commits(), beforeCancel);

  await button('Place through via').click();
  const viaSettings = page.getByRole('complementary', { name: 'Via settings' });
  await viaSettings.waitFor();
  assert.equal(await routingSettings.count(), 0);
  assert.equal((await viaSettings.boundingBox()).x, canvasBounds.x + 12);
  assert.equal(await button('Place through via').getAttribute('aria-expanded'), 'true');
  const diameter = viaSettings.getByRole('spinbutton', { name: 'Diameter (mm)', exact: true });
  const drill = viaSettings.getByRole('spinbutton', { name: 'Drill (mm)', exact: true });
  await diameter.fill('1.2');
  await diameter.press('Enter');
  await drill.fill('1.2');
  await drill.press('Enter');
  assert.equal(await drill.getAttribute('aria-invalid'), 'true');
  await drill.press('Escape');
  assert.equal(await drill.inputValue(), '0.4');
  await drill.fill('0.6');
  await drill.press('Enter');
  await selectGrid('0.2 mm');
  await assertGrid(0.2);
  await selectGrid('Off');
  await assertGrid(0.2, false);
  assert.equal(await commits(), beforeCancel);
  await point({ x: 6.31, y: 3.49 }, true);
  const viaPlaced = await page.evaluate(() => window.lastBoard);
  assert.equal(await commits(), beforeCancel + 1);
  assert.deepEqual(
    { ...viaPlaced.vias.at(-1), id: '' },
    { id: '', x: 6.4, y: 3.4, diameter: 1.2, drill: 0.6, netId: board.nets[0].id },
  );
  assert.deepEqual(parseProject(serializeProject({ ...project, pcb: viaPlaced })).pcb, viaPlaced);
  await button('Undo').click();
  assert.deepEqual(await page.evaluate(() => window.lastBoard), clearBoard);
  await button('Route tracks').click();
  assert.equal(await viaSettings.count(), 0);
  assert.equal(await widthInput.inputValue(), '0.6', 'Tool settings survive switching tools.');
  await selectGrid('0.1 mm');
  await assertGrid(0.1);
  await selectGrid('1 mm');
  await assertGrid(1);
  await point({ x: 5.63, y: 3.63 }, true);
  await point({ x: 7.62, y: 3.63 });
  assert.deepEqual((await gridPoints())[0], [6, 4]);
  assert.deepEqual((await gridPoints()).at(-1), [8, 4]);
  await canvas.press('Escape');
  await button('Route tracks').click();
  await selectGrid('0.5 mm');
  await assertGrid(0.5);
  await page.screenshot({ path: 'test-results/layout-routing-settings-light.png' });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
    document.documentElement.style.setProperty('--canvas', '#15191e');
  });
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.layout-editor').getAttribute('data-pcb-theme'), 'dark');
  await page.screenshot({ path: 'test-results/layout-routing-settings-dark.png' });
  await button('Place through via').click();
  await page.screenshot({ path: 'test-results/layout-via-settings-dark.png' });
  await canvas.press('Escape');
  assert.equal(await viaSettings.count(), 0);

  // A layer row keeps visibility independent and drives actual routing.
  await replace(unfilled);
  const beforePriority = await commits();
  await toggleLayoutVisualization(page, 'Visible layers');
  const layerPanel = page.getByRole('group', { name: 'Visible layers', exact: true });
  const priority = layerPanel.getByRole('button', { name: 'B.Cu', exact: true });
  await priority.click();
  assert.equal(await priority.getAttribute('aria-pressed'), 'true');
  assert.equal(
    await layerPanel.getByRole('combobox', { name: 'Priority layer', exact: true }).count(),
    0,
  );
  assert.equal(await layerPanel.isVisible(), true, 'Choosing a layer keeps the parent panel open.');
  assert.equal(
    await layerPanel.getByRole('checkbox', { name: 'F.Cu', exact: true }).isChecked(),
    true,
  );
  assert.equal(
    await layerPanel.getByRole('checkbox', { name: 'B.Cu', exact: true }).isChecked(),
    true,
  );
  await canvas.focus();
  assert.equal(await commits(), beforePriority, 'Priority changes leave design data clean.');
  assert.deepEqual(await page.evaluate(() => window.lastBoard), unfilled);
  await button('Route tracks').click();
  await point(board.footprints[0], true);
  await point(board.footprints[1]);
  assert.equal(
    (await gridPoints()).length,
    2,
    'Back-layer routing bypasses front-layer obstacles.',
  );
  await point(board.footprints[1], true);
  const backRouted = await page.evaluate(() => window.lastBoard);
  assert.equal(await commits(), beforePriority + 1);
  assert.deepEqual(backRouted.tracks[0], unfilled.tracks[0]);
  assert.ok(backRouted.tracks.slice(1).every((track) => track.layer === 'B.Cu'));
  await button('Undo').click();
  assert.deepEqual(await page.evaluate(() => window.lastBoard), unfilled);
  const retainedLayers = await openVisualization(page);
  await retainedLayers.getByRole('tab', { name: 'Layers', exact: true }).click();
  assert.equal(
    await priority.innerText(),
    'B.Cu',
    'Priority survives returning to the Layers tab.',
  );
  const frontLayer = layerPanel.getByRole('button', { name: 'F.Cu', exact: true });
  await frontLayer.focus();
  await frontLayer.press('Enter');
  assert.equal(
    await frontLayer.getAttribute('aria-pressed'),
    'true',
    'Layer rows support keyboard selection.',
  );
  await page.screenshot({ path: 'test-results/layout-priority-layer-dark.png' });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.style.removeProperty('--canvas');
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: 'test-results/layout-priority-layer-light.png' });
  await toggleLayoutVisualization(page, 'Visible layers');

  // Finishing includes the current live head, even before any waypoint is locked.
  await replace(clearBoard);
  await button('Route tracks').click();
  await point(board.footprints[0], true);
  await point(board.footprints[1]);
  const beforeLiveFinish = await commits();
  const liveHead = await draft.getAttribute('points');
  const searchesBeforeJitter = await page.evaluate(() => window.routeSearches);
  for (const delta of [-0.02, 0.02, -0.01, 0.01])
    await point({ x: board.footprints[1].x + delta, y: board.footprints[1].y });
  assert.equal(
    await page.evaluate(() => window.routeSearches),
    searchesBeforeJitter,
    'Pointer jitter around one magnetic pad centre retains its exact path search.',
  );
  assert.equal(await draft.getAttribute('points'), liveHead);
  await point({ x: 6, y: 5 });
  const freeHead = await draft.getAttribute('points');
  const searchesBeforeGridJitter = await page.evaluate(() => window.routeSearches);
  for (const delta of [-0.02, 0.02, -0.01, 0.01]) await point({ x: 6 + delta, y: 5 });
  assert.equal(
    await page.evaluate(() => window.routeSearches),
    searchesBeforeGridJitter,
    'Pointer jitter within one snapped grid cell retains its exact path search.',
  );
  assert.equal(await draft.getAttribute('points'), freeHead);
  await point(board.footprints[1]);
  assert.ok(
    (await page.evaluate(() => window.routeSearches)) > searchesBeforeGridJitter,
    'A changed head still searches current obstacle geometry.',
  );
  await canvas.press('x');
  assert.equal(
    await draft.getAttribute('points'),
    liveHead,
    'Reactivating routing from the keyboard preserves its active draft.',
  );
  assert.equal(await commits(), beforeLiveFinish);
  await canvas.press('Enter');
  const liveFinished = await page.evaluate(() => window.lastBoard);
  assert.equal(await commits(), beforeLiveFinish + 1, 'Enter commits the live head once.');
  assert.equal(await draft.count(), 0);
  assert.deepEqual(liveFinished.tracks[0].start, {
    x: board.footprints[0].x,
    y: board.footprints[0].y,
  });
  assert.deepEqual(liveFinished.tracks.at(-1).end, {
    x: board.footprints[1].x,
    y: board.footprints[1].y,
  });
  await canvas.press('Enter');
  assert.equal(await commits(), beforeLiveFinish + 1, 'A repeated finish cannot duplicate tracks.');
  await button('Undo').click();
  assert.deepEqual(await page.evaluate(() => window.lastBoard), clearBoard);

  // A blocked head must not turn previously locked, legal waypoints into a partial route.
  await replace(wall);
  await button('Route tracks').click();
  await point(board.footprints[0], true);
  await point({ x: 4, y: 4 }, true);
  await point(board.footprints[1]);
  assert.equal(await draft.getAttribute('data-route-blocked'), 'true');
  const beforeBlockedFinish = await commits();
  await canvas.press('Enter');
  assert.equal(
    await commits(),
    beforeBlockedFinish,
    'Enter on a blocked live head never commits earlier fixed waypoints.',
  );
  assert.deepEqual(await page.evaluate(() => window.lastBoard), wall);
  assert.equal(await draft.count(), 1, 'A blocked finish retains the editable draft.');
  await canvas.press('Escape');

  // Assigned copper supplies the route net without a separate settings control.
  const grounded = structuredClone(clearBoard);
  for (const footprint of grounded.footprints) footprint.pads[0].netId = board.nets[1].id;
  await replace(grounded);
  await button('Route tracks').click();
  await point(board.footprints[0], true);
  await point(board.footprints[1]);
  const beforeAnchorNet = await commits();
  assert.deepEqual(await page.evaluate(() => window.lastBoard), grounded);
  await canvas.press('Enter');
  const groundedRoute = await page.evaluate(() => window.lastBoard);
  assert.equal(await commits(), beforeAnchorNet + 1);
  assert.ok(groundedRoute.tracks.length > 0);
  assert.ok(groundedRoute.tracks.every((track) => track.netId === board.nets[1].id));
  await button('Undo').click();
  assert.deepEqual(await page.evaluate(() => window.lastBoard), grounded);
  await replace(clearBoard);

  // Priority changes similarly discard the active layer's unfinished geometry.
  await button('Route tracks').click();
  await point(board.footprints[0], true);
  await point(board.footprints[1]);
  const beforeActivePriority = await commits();
  await toggleLayoutVisualization(page, 'Visible layers');
  await priority.click();
  assert.equal(await priority.innerText(), 'B.Cu');
  assert.equal(await draft.count(), 0);
  assert.equal(
    await commits(),
    beforeActivePriority,
    'Changing priority layer cancels an active draft without writes.',
  );
  assert.deepEqual(await page.evaluate(() => window.lastBoard), clearBoard);
  await toggleLayoutVisualization(page, 'Visible layers');
  await point(board.footprints[0], true);
  await point(board.footprints[1]);
  await canvas.press('Enter');
  const priorityChangedRoute = await page.evaluate(() => window.lastBoard);
  assert.equal(await commits(), beforeActivePriority + 1);
  assert.ok(priorityChangedRoute.tracks.length > 0);
  assert.ok(priorityChangedRoute.tracks.every((track) => track.layer === 'B.Cu'));
  await button('Undo').click();
  assert.deepEqual(await page.evaluate(() => window.lastBoard), clearBoard);

  const unassigned = structuredClone(clearBoard);
  unassigned.footprints[0].pads[0].netId = null;
  await replace(unassigned);
  await button('Route tracks').click();
  const beforeUnassigned = await commits();
  await point(board.footprints[0], true);
  assert.match(await page.getByRole('alert').innerText(), /Connect its symbol in Schematic/);
  assert.equal(await draft.count(), 0);
  assert.equal(await commits(), beforeUnassigned);
  assert.deepEqual(await page.evaluate(() => window.lastBoard), unassigned);
  assert.deepEqual(errors, []);
  console.log(
    'Priority-layer pointer/keyboard selection and routing, compact routing/via settings, shared display/snap grid, invalid geometry, exact anchors, saved fill connectivity, live walkaround, live-head finish, blocked finish, route reactivation, source-net resolution, layer cancellation, unassigned-pad guidance, JSON and single-transaction undo passed.',
  );
} finally {
  await browser.close();
}
