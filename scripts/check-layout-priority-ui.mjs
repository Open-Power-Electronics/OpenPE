import {
  closeDisplayDrawer,
  openDisplayDrawer,
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
const { parseProject } = await tsImport('../lib/project.ts', import.meta.url);

// An isolated renderer with coordinate-based pointer input and no desktop or native access.
const bundle = await build({
  stdin: {
    contents: `import React,{useRef,useState} from 'react';import {createRoot} from 'react-dom/client';
      import LayoutEditor from './components/LayoutEditor';
      function Test(){const [board,setBoard]=useState(window.fixture.board);const context=useRef(null);
        window.layoutSelection=()=>context.current?.selection??[];
        window.layoutContext=()=>context.current;
        window.replaceBoard=next=>{window.lastBoard=next;setBoard(next)};
        return <LayoutEditor board={board} schematic={window.fixture.schematic} active grid={false}
          agentContextRef={context}
          onCommit={next=>{window.lastBoard=next;window.commits++;setBoard(next);return true}}
          annotations={[]} annotationSessionId="priority" onAnnotationsChange={()=>{}}/>}
      createRoot(document.getElementById('root')).render(<Test/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});

const board = createEmptyPCB();
board.layers = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'];
const rectangle = (x, y, width, height) => [
  { x, y },
  { x: x + width, y },
  { x: x + width, y: y + height },
  { x, y: y + height },
];
const edge = rectangle(0, 0, 48, 32);
board.graphics = edge.map((start, i) => ({
  id: `edge-${i}`,
  layer: 'Edge.Cuts',
  width: 0.1,
  start,
  end: edge[(i + 1) % edge.length],
}));
const track = (id, layer, start, end) => ({
  id,
  layer,
  start,
  end,
  netId: id,
  width: 1.2,
});
// Each crossing has the opposite source order, so neither layer can win by file order.
board.tracks = [
  track('front-first', 'F.Cu', { x: 5, y: 9 }, { x: 19, y: 9 }),
  track('back-last', 'B.Cu', { x: 12, y: 3 }, { x: 12, y: 15 }),
  track('back-first', 'B.Cu', { x: 27, y: 9 }, { x: 41, y: 9 }),
  track('front-last', 'F.Cu', { x: 34, y: 3 }, { x: 34, y: 15 }),
  track('inner1-first', 'In1.Cu', { x: 5, y: 22 }, { x: 19, y: 22 }),
  track('inner2-last', 'In2.Cu', { x: 12, y: 16 }, { x: 12, y: 28 }),
  track('inner2-first', 'In2.Cu', { x: 27, y: 22 }, { x: 41, y: 22 }),
  track('inner1-last', 'In1.Cu', { x: 34, y: 16 }, { x: 34, y: 28 }),
];
board.nets = board.tracks.map(({ id }) => ({ id, name: id }));
board.nets.push({ id: 'pour', name: 'Pour' });
board.graphics.push(
  { id: 'silk', layer: 'F.SilkS', width: 1.2, start: { x: 8, y: 9 }, end: { x: 16, y: 9 } },
  { id: 'user', layer: 'User.1', width: 1.2, start: { x: 30, y: 9 }, end: { x: 38, y: 9 } },
  {
    id: 'pad-hole-silk',
    layer: 'F.SilkS',
    width: 1.2,
    start: { x: 20, y: 27 },
    end: { x: 24, y: 27 },
  },
  {
    id: 'via-hole-silk',
    layer: 'F.SilkS',
    width: 1.2,
    start: { x: 41, y: 27 },
    end: { x: 45, y: 27 },
  },
);
board.footprints = [
  {
    id: 'part',
    symbolId: null,
    libraryId: 'Test:Layers',
    reference: 'P1',
    x: 22,
    y: 22,
    rotation: 0,
    side: 'front',
    pads: [
      {
        id: 'front-pad',
        number: '1',
        x: 0,
        y: 0,
        rotation: 0,
        type: 'smd',
        shape: 'rect',
        size: { x: 2, y: 2 },
        netId: 'pour',
        layers: ['F.Cu'],
      },
      {
        id: 'back-pad',
        number: '2',
        x: 0,
        y: 0,
        rotation: 0,
        type: 'smd',
        shape: 'rect',
        size: { x: 2, y: 2 },
        netId: 'pour',
        layers: ['B.Cu'],
      },
      {
        id: 'through-pad',
        number: '3',
        x: 0,
        y: 5,
        rotation: 0,
        type: 'thru_hole',
        shape: 'circle',
        size: { x: 2, y: 2 },
        drill: 0.8,
        netId: 'pour',
        layers: ['*.Cu'],
      },
    ],
    graphics: [
      {
        id: 'part-silk',
        layer: 'F.SilkS',
        width: 0.6,
        start: { x: -2, y: 0 },
        end: { x: 2, y: 0 },
      },
    ],
  },
];
board.vias = [{ id: 'through-via', x: 43, y: 27, diameter: 2, drill: 0.8, netId: 'pour' }];
// Saved fills exercise the complete layer group alongside tracks and outlines.
board.zones = ['F.Cu', 'B.Cu'].map((layer) => ({
  id: `zone-${layer}`,
  layer,
  netId: 'pour',
  outline: rectangle(20, 3, 4, 10),
  clearance: 0.2,
  minThickness: 0.1,
  thermalGap: 0.2,
  thermalBridge: 0.2,
  filledPolygons: [{ points: rectangle(20, 3, 4, 10) }],
}));
const input = { board, schematic: emptyCircuit() };
const styles = await Promise.all(
  ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'].map((path) =>
    readFile(path, 'utf8'),
  ),
);
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});
await mkdir('test-results', { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  await page.evaluate((fixture) => {
    window.fixture = fixture;
    window.lastBoard = fixture.board;
    window.commits = 0;
  }, input);
  for (const content of styles) await page.addStyleTag({ content });
  await page.addStyleTag({ content: 'html,body,#root,.layout-editor{height:100%;margin:0}' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const canvas = page.getByTestId('layout-canvas');
  await canvas.waitFor();
  for (const [role, name] of [
    ['combobox', 'Left button drag'],
    ['combobox', 'Mouse drag track behavior'],
    ['combobox', 'Drag obstacle mode'],
    ['spinbutton', 'Drag clearance (mm)'],
  ])
    assert.equal(await page.getByRole(role, { name, exact: true }).count(), 0);
  const filters = page.getByRole('group', { name: 'Selection', exact: true });
  await openDisplayDrawer(page, 'Selection');
  for (const name of [
    'Footprints',
    'Text',
    'Tracks',
    'Vias',
    'Pads',
    'Graphics',
    'Zones',
    'Rule areas',
    'Dimensions',
  ]) {
    const filter = filters.getByRole('checkbox', { name, exact: true });
    assert.equal(await filter.isVisible(), true);
    assert.equal(await filter.isEnabled(), true);
  }
  await closeDisplayDrawer(page, 'Selection');
  await page.getByRole('button', { name: 'Fit board to canvas', exact: true }).click();
  const point = (position) =>
    canvas.evaluate((svg, value) => {
      const screen = new DOMPoint(value.x, value.y).matrixTransform(svg.getScreenCTM());
      return { x: screen.x, y: screen.y };
    }, position);
  const selection = () =>
    page.evaluate(() =>
      window
        .layoutSelection()
        .map(({ id }) => id)
        .sort(),
    );
  const clearSelection = async () => {
    await canvas.press('Escape');
    assert.deepEqual(await selection(), []);
  };
  const clean = async () => {
    assert.deepEqual(
      await page.evaluate(() => ({ board: window.lastBoard, commits: window.commits })),
      { board, commits: 0 },
      'Priority, visibility and selection preserve the complete board without commits.',
    );
  };
  const choosePriority = async (layer) => {
    await toggleLayoutVisualization(page, 'Visible layers');
    const panel = page.getByRole('group', { name: 'Visible layers', exact: true });
    assert.equal(
      await panel.getByRole('combobox', { name: 'Priority layer', exact: true }).count(),
      0,
    );
    const priority = panel.getByRole('button', { name: layer, exact: true });
    if ((await priority.getAttribute('aria-pressed')) !== 'true') await priority.click();
    assert.equal(await priority.getAttribute('aria-pressed'), 'true');
    assert.equal(await panel.locator('button[aria-pressed="true"]').count(), 1);
    const visible = await page.evaluate(() => window.layoutContext().layers);
    if (visible[layer])
      assert.equal(
        await canvas.locator('[data-layout-layer]').last().getAttribute('data-layout-layer'),
        layer,
        'The explicitly selected complete visible layer pass paints last.',
      );
    for (const [id, shown] of [
      ['front-pad', visible['F.Cu']],
      ['back-pad', visible['B.Cu']],
      ['through-pad', board.layers.some((layer) => visible[layer])],
    ])
      assert.equal(
        await canvas.locator(`[data-pad-id="${id}"]`).count(),
        shown ? 1 : 0,
        'Pads paint once across all physical layer passes.',
      );
    assert.equal(
      await canvas.locator('[data-selection-id="through-via"][data-via-type="through"]').count(),
      board.layers.some((layer) => visible[layer]) ? 1 : 0,
      'A through via paints once across all physical layer passes.',
    );
    assert.equal(await panel.isVisible(), true);
    assert.equal(await panel.getByRole('slider', { name: 'Copper opacity' }).count(), 0);
    await toggleLayoutVisualization(page, 'Visible layers');
  };
  const clearPriority = async (layer) => {
    await toggleLayoutVisualization(page, 'Visible layers');
    const panel = page.getByRole('group', { name: 'Visible layers', exact: true });
    const current = panel.getByRole('button', { name: layer, exact: true });
    assert.equal(await current.getAttribute('aria-pressed'), 'true');
    const editingLayer = await page.evaluate(() => window.layoutContext().layer);
    await current.click();
    assert.equal(await panel.locator('button[aria-pressed="true"]').count(), 0);
    assert.equal(await page.evaluate(() => window.layoutContext().priorityLayer), null);
    assert.equal(
      await page.evaluate(() => window.layoutContext().layer),
      editingLayer,
      'Returning to the physical stack preserves the active copper tool layer.',
    );
    await toggleLayoutVisualization(page, 'Visible layers');
    await clean();
  };
  const expectTop = async (position, id) => {
    await clearSelection();
    const screen = await point(position);
    await page.mouse.move(screen.x, screen.y);
    assert.equal(
      await page.evaluate(({ x, y }) => {
        return document
          .elementFromPoint(x, y)
          ?.closest('[data-selection-id]')
          ?.getAttribute('data-selection-id');
      }, screen),
      id,
      'The preferred visible layer owns the pointer hit at the crossing.',
    );
    const color = await canvas
      .locator(`[data-selection-id="${id}"] line`)
      .last()
      .evaluate((line) => {
        return getComputedStyle(line).stroke.match(/\d+/g).slice(0, 3).map(Number);
      });
    const { data, info } = await sharp(await page.screenshot())
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const offset = (Math.round(screen.y) * info.width + Math.round(screen.x)) * 4;
    const pixel = [...data.subarray(offset, offset + 3)];
    assert.ok(
      pixel.every((value, i) => Math.abs(value - color[i]) <= 2),
      `Preferred track is painted above the crossing: ${pixel} versus ${color}.`,
    );
    await page.mouse.click(screen.x, screen.y);
    const menu = page.getByRole('menu', { name: 'Choose layout object', exact: true });
    assert.equal(await menu.count(), 0, 'Crossing tracks resolve directly without an object menu.');
    assert.deepEqual(
      await selection(),
      [id],
      'The preferred visible copper layer breaks an equal-distance crossing tie.',
    );
    await clearSelection();
    await page.mouse.move(screen.x, screen.y);
    await canvas.press('u');
    assert.equal(await menu.count(), 0, 'Hover expansion uses the same direct copper tie break.');
    assert.deepEqual(
      await selection(),
      [id],
      'Hover expansion starts from the preferred visible track at an equal-distance crossing.',
    );
    await clearSelection();
    await clean();
  };
  const rectangle = async (start, end, modifiers = []) => {
    const a = await point(start),
      b = await point(end);
    for (const modifier of modifiers) await page.keyboard.down(modifier);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await page.mouse.up();
    for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
  };
  const expectPaint = async (
    position,
    target,
    property = 'stroke',
    reason = 'The selected board layer paints above all other layer artwork.',
  ) => {
    await clearSelection();
    const screen = await point(position);
    const color = await target.evaluate(
      (node, property) => getComputedStyle(node)[property].match(/\d+/g).slice(0, 3).map(Number),
      property,
    );
    const { data, info } = await sharp(await page.screenshot())
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const offset = (Math.round(screen.y) * info.width + Math.round(screen.x)) * 4;
    const pixel = [...data.subarray(offset, offset + 3)];
    assert.ok(
      pixel.every((value, i) => Math.abs(value - color[i]) <= 2),
      `${reason} At ${position.x},${position.y}: ${pixel} versus ${color}.`,
    );
  };
  const expectDrillOpenings = async () => {
    const airwires = await page.evaluate(() => window.layoutContext().layers.airwires);
    if (airwires) await setLayoutVisibility(page, 'Airwires', false);
    const drills = canvas.locator('[data-layout-drills]');
    assert.equal(await drills.count(), 1);
    assert.equal(await drills.locator('[data-pad-drill="through-pad"]').count(), 1);
    assert.equal(await drills.locator('[data-via-drill="through-via"]').count(), 1);
    assert.equal(await canvas.locator('[data-pad-id="through-pad"]').count(), 1);
    assert.equal(
      await canvas.locator('[data-selection-id="through-via"][data-via-type="through"]').count(),
      1,
    );
    for (const [position, selector] of [
      [{ x: 22, y: 27 }, '[data-pad-drill="through-pad"]'],
      [{ x: 43, y: 27 }, '[data-via-drill="through-via"]'],
    ])
      await expectPaint(
        position,
        drills.locator(selector),
        'fill',
        'Drill openings remain visible through front-silk artwork in physical and silk-priority views.',
      );
    if (airwires) await setLayoutVisibility(page, 'Airwires', true);
  };

  assert.equal(await page.evaluate(() => window.layoutContext().priorityLayer), null);
  const defaultPaintOrder = await canvas
    .locator('[data-layout-layer]')
    .evaluateAll((groups) => groups.map((group) => group.getAttribute('data-layout-layer')));
  for (const [lower, upper] of [
    ['B.Cu', 'In2.Cu'],
    ['In2.Cu', 'In1.Cu'],
    ['In1.Cu', 'F.Cu'],
    ['F.Cu', 'F.SilkS'],
  ])
    assert.ok(
      defaultPaintOrder.includes(lower) &&
        defaultPaintOrder.includes(upper) &&
        defaultPaintOrder.indexOf(lower) < defaultPaintOrder.indexOf(upper),
      `The default top view paints ${upper} above ${lower} in physical stack order.`,
    );
  await expectPaint({ x: 12, y: 9 }, canvas.locator('[data-selection-id="silk"] path').last());
  await expectDrillOpenings();
  await choosePriority('F.SilkS');
  await expectDrillOpenings();
  await clearPriority('F.SilkS');
  await setLayoutVisibility(page, 'F.SilkS', false);
  await expectTop({ x: 12, y: 9 }, 'front-first');
  await expectTop({ x: 34, y: 9 }, 'front-last');
  await choosePriority('F.Cu');
  await clearPriority('F.Cu');
  await choosePriority('B.Cu');
  await clearPriority('B.Cu');
  assert.equal(await page.evaluate(() => window.layoutContext().layer), 'B.Cu');
  await expectTop({ x: 12, y: 9 }, 'front-first');
  await expectTop({ x: 34, y: 9 }, 'front-last');
  await rectangle({ x: 4, y: 2 }, { x: 19.8, y: 16 });
  assert.deepEqual(
    await selection(),
    ['back-last', 'front-first'],
    'Default-stack marquee selection includes every visible copper layer.',
  );
  await clearSelection();
  await clean();
  await setLayoutVisibility(page, 'F.SilkS', true);
  await choosePriority('B.Cu');
  assert.equal(
    await canvas.locator('[data-copper-layer]').last().getAttribute('data-copper-layer'),
    'B.Cu',
  );
  for (const layer of ['F.Cu', 'B.Cu']) {
    const group = canvas.locator(`[data-copper-layer="${layer}"]`);
    assert.equal(await group.locator(`[data-copper-zone="zone-${layer}"]`).count(), 1);
    assert.equal(await group.locator(`[data-selection-id="zone-${layer}"]`).count(), 2);
    assert.equal(await group.locator('[data-net-id]').count(), 2);
  }
  await expectTop({ x: 12, y: 9 }, 'back-last');
  await expectTop({ x: 34, y: 9 }, 'back-first');
  await page.screenshot({ path: 'test-results/layout-priority-tracks.png' });

  await toggleLayoutVisualization(page, 'Visible layers');
  const panel = page.getByRole('group', { name: 'Visible layers', exact: true });
  await panel.getByRole('checkbox', { name: 'B.Cu', exact: true }).uncheck();
  await toggleLayoutVisualization(page, 'Visible layers');
  await choosePriority('F.Cu');
  await choosePriority('B.Cu');
  await toggleLayoutVisualization(page, 'Visible layers');
  assert.equal(
    await panel.getByRole('checkbox', { name: 'B.Cu', exact: true }).isChecked(),
    false,
    'Choosing a hidden priority layer preserves its visibility.',
  );
  await toggleLayoutVisualization(page, 'Visible layers');
  assert.equal(await canvas.locator('[data-copper-layer="B.Cu"]').count(), 0);
  await setLayoutVisibility(page, 'F.SilkS', false);
  await expectTop({ x: 12, y: 9 }, 'front-first');
  await expectTop({ x: 34, y: 9 }, 'front-last');
  await setLayoutVisibility(page, 'F.SilkS', true);

  await choosePriority('In1.Cu');
  await expectTop({ x: 12, y: 22 }, 'inner1-first');
  await expectTop({ x: 34, y: 22 }, 'inner1-last');
  await choosePriority('In2.Cu');
  await expectTop({ x: 12, y: 22 }, 'inner2-last');
  await expectTop({ x: 34, y: 22 }, 'inner2-first');

  await setLayoutVisibility(page, 'B.Cu', true);
  await choosePriority('F.Cu');
  for (const crossing of [false, true]) {
    await clearSelection();
    await rectangle({ x: crossing ? 19.8 : 4, y: 2 }, { x: crossing ? 4 : 19.8, y: 16 });
    assert.deepEqual(await selection(), ['front-first']);
  }
  await choosePriority('B.Cu');
  await rectangle({ x: 4, y: 2 }, { x: 19.8, y: 16 }, ['Shift']);
  assert.deepEqual(
    await selection(),
    ['back-last', 'front-first'],
    'Layer changes retain the old selection and additive marquee semantics.',
  );
  await clearSelection();
  await rectangle({ x: 19.8, y: 2 }, { x: 4, y: 16 });
  assert.deepEqual(await selection(), ['back-last']);

  await choosePriority('F.SilkS');
  await expectPaint({ x: 12, y: 9 }, canvas.locator('[data-selection-id="silk"] path').last());
  await rectangle({ x: 4, y: 2 }, { x: 19.8, y: 16 });
  assert.deepEqual(await selection(), ['silk']);

  await setLayoutVisibility(page, 'User.1', true);
  await choosePriority('User.1');
  await expectPaint({ x: 34, y: 9 }, canvas.locator('[data-selection-id="user"] path').last());
  await rectangle({ x: 26, y: 2 }, { x: 42, y: 16 });
  assert.deepEqual(await selection(), ['user']);
  await choosePriority('Edge.Cuts');
  await clearSelection();
  const edgePoint = await point({ x: 24, y: 0 });
  await page.mouse.click(edgePoint.x, edgePoint.y);
  assert.deepEqual(
    await selection(),
    ['edge-0'],
    'The current board outline is directly clickable.',
  );
  await clearSelection();
  await rectangle({ x: -1, y: -1 }, { x: 49, y: 33 });
  assert.deepEqual(await selection(), ['edge-0', 'edge-1', 'edge-2', 'edge-3']);

  await setLayoutVisibility(page, 'Pad numbers', false);
  await setLayoutVisibility(page, 'Pad net names', false);
  await setLayoutVisibility(page, 'Airwires', false);
  await choosePriority('F.Cu');
  await expectPaint({ x: 22, y: 22 }, canvas.locator('[data-pad-id="front-pad"] rect'), 'fill');
  await choosePriority('B.Cu');
  await expectPaint({ x: 22, y: 22 }, canvas.locator('[data-pad-id="back-pad"] rect'), 'fill');
  await choosePriority('F.SilkS');
  await expectPaint({ x: 22, y: 22 }, canvas.locator('[data-footprint-graphic="part-silk"] path'));

  await setLayoutVisibility(page, 'B.Cu', false);
  await choosePriority('B.Cu');
  await clearSelection();
  await rectangle({ x: 4, y: 2 }, { x: 19.8, y: 16 });
  assert.deepEqual(
    await selection(),
    [],
    'Hidden current layers cannot be selected through visible layers.',
  );
  await page.screenshot({ path: 'test-results/layout-layer-rows.png' });
  assert.deepEqual(errors, [], 'No renderer errors.');
  await clean();

  const sources = JSON.parse(await readFile('lib/reference-examples.json', 'utf8'));
  const lm = parseProject(sources['reference-lm2596-to220-5-buck']).pcb;
  await page.evaluate((board) => window.replaceBoard(board), lm);
  await page.getByRole('button', { name: 'Fit board to canvas', exact: true }).click();
  await setLayoutVisibility(page, 'B.Cu', true);
  await toggleLayoutVisualization(page, 'Visible layers');
  await panel.getByRole('button', { name: 'F.Cu', exact: true }).click();
  await page.getByRole('button', { name: 'Draw copper zone', exact: true }).click();
  assert.equal(await page.evaluate(() => window.layoutContext().priorityLayer), 'F.Cu');
  assert.equal(await page.evaluate(() => window.layoutContext().layer), 'F.Cu');
  await panel.getByRole('button', { name: 'Edge.Cuts', exact: true }).click();
  assert.equal(
    await page.evaluate(() => window.layoutContext().tool),
    'select',
    'A noncopper row exits copper drawing so the outline can be selected.',
  );
  const outline = lm.graphics.find((graphic) => graphic.layer === 'Edge.Cuts');
  const points = [outline.start, ...(outline.points ?? []), outline.end];
  const at = await point({
    x: (Math.min(...points.map((p) => p.x)) + Math.max(...points.map((p) => p.x))) / 2,
    y: Math.min(...points.map((p) => p.y)),
  });
  await page.mouse.click(at.x, at.y);
  assert.deepEqual(
    await selection(),
    [outline.id],
    'The actual LM2596 polygon frame is selectable.',
  );
  await clearSelection();
  await page.getByRole('button', { name: 'Draw copper zone', exact: true }).click();
  assert.equal(
    await page.evaluate(() => window.layoutContext().priorityLayer),
    'Edge.Cuts',
    'Copper drawing cannot silently restore the back copper layer.',
  );
  assert.equal(await page.evaluate(() => window.layoutContext().tool), 'select');
  await page.getByRole('button', { name: 'Fill copper zones', exact: true }).click();
  assert.equal(await page.evaluate(() => window.layoutContext().priorityLayer), 'Edge.Cuts');
  await page.getByRole('button', { name: 'Fill zones', exact: true }).click();
  assert.equal(
    await page.getByRole('complementary', { name: 'Copper fill settings', exact: true }).count(),
    0,
    'The real refill completed successfully.',
  );
  assert.equal(
    await page.evaluate(() => window.layoutContext().priorityLayer),
    'Edge.Cuts',
    'Refilling retains the selected outline layer.',
  );
  assert.equal(await page.evaluate(() => window.layoutContext().layer), 'F.Cu');
  assert.equal(
    await canvas.locator('[data-copper-layer]').last().getAttribute('data-copper-layer'),
    'F.Cu',
    'Noncopper selection preserves the remembered front copper paint order after refill.',
  );
  assert.deepEqual(await page.evaluate(() => window.lastBoard.graphics), lm.graphics);
  await page.mouse.click(at.x, at.y);
  assert.deepEqual(
    await selection(),
    [outline.id],
    'Saved pours cannot steal a precise outline hit.',
  );
  await page.screenshot({ path: 'test-results/layout-lm2596-layer-rows.png' });
  assert.deepEqual(errors, [], 'The real native outline/fill regression has no renderer errors.');
  console.log(
    'Layout layers: physical default stack, repeat-click priority reset, retained copper tool layer, single through geometry, explicit layer paint/picking/marquees and hidden-layer behavior without native edits.',
  );
} finally {
  await browser.close();
}
