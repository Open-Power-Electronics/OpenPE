import {
  setLayoutVisibility,
  toggleLayoutVisualization,
  selectLayoutLayer,
} from './visualization-test-helpers.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { emptyCircuit } = await tsImport('../lib/circuit.ts', import.meta.url);
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const { copperFillContour } = await tsImport('../lib/pcb-polygons.ts', import.meta.url);

// Real pointer/keyboard dispatch in a fresh isolated renderer. No Electron, service,
// providers, native files, or user workspace are opened by this check.
const bundle = await build({
  stdin: {
    contents: `import React,{useRef,useState} from 'react';import {createRoot} from 'react-dom/client';
      import LayoutEditor from './components/LayoutEditor';
      function Test(){const [board,setBoard]=useState(window.fixture.board);const [active,setActive]=useState(true);
        const context=useRef(null);window.layoutContext=context;
        window.replaceBoard=next=>{window.lastBoard=next;setBoard(next)};window.setLayoutActive=setActive;
        return <LayoutEditor board={board} schematic={window.fixture.schematic} active={active}
          agentContextRef={context}
          onCommit={next=>{window.lastBoard=next;window.commits++;setBoard(next);return true}}
          undoAction={<button aria-label="Undo" onClick={()=>{window.undoCalls++;window.lastBoard=window.fixture.board;setBoard(window.fixture.board)}}>Undo</button>}
          annotations={[]} annotationSessionId="clarification" onAnnotationsChange={()=>{}}/>}
      createRoot(document.getElementById('root')).render(<Test/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});

const rectangle = (minX, minY, maxX, maxY) => [
  { x: minX, y: minY },
  { x: maxX, y: minY },
  { x: maxX, y: maxY },
  { x: minX, y: maxY },
];
const footprint = (id, x, y) => ({
  id,
  x,
  y,
  symbolId: null,
  libraryId: 'Test:Clarification',
  reference: id,
  rotation: 0,
  side: 'front',
  pads: [
    {
      id: `${id}-pad`,
      number: '1',
      x: 0,
      y: 0,
      rotation: 0,
      type: 'smd',
      shape: 'rect',
      size: { x: 2, y: 2 },
      netId: 'signal',
    },
  ],
  graphics: [
    {
      id: `${id}-body`,
      kind: 'polygon',
      start: { x: -2, y: -2 },
      end: { x: -2, y: 2 },
      points: [
        { x: 2, y: -2 },
        { x: 2, y: 2 },
      ],
      width: 0.12,
      layer: 'F.SilkS',
    },
  ],
});
const board = {
  ...createEmptyPCB(),
  nets: [{ id: 'signal', name: 'SIGNAL' }],
  footprints: [footprint('A1', 30, 25), footprint('B2', 55, 25)],
  tracks: [
    {
      id: 'underlying-track',
      start: { x: 20, y: 25 },
      end: { x: 40, y: 25 },
      width: 0.4,
      layer: 'F.Cu',
      netId: 'signal',
    },
  ],
  vias: [{ id: 'overlapping-via', x: 30, y: 25, diameter: 1.2, drill: 0.4, netId: 'signal' }],
  graphics: [
    {
      id: 'edge',
      kind: 'polygon',
      start: { x: 0, y: 0 },
      end: { x: 0, y: 50 },
      points: [
        { x: 80, y: 0 },
        { x: 80, y: 50 },
      ],
      width: 0.1,
      layer: 'Edge.Cuts',
    },
    {
      id: 'overlapping-artwork',
      kind: 'polygon',
      start: { x: 28, y: 23 },
      end: { x: 28, y: 27 },
      points: [
        { x: 32, y: 23 },
        { x: 32, y: 27 },
      ],
      width: 0.12,
      layer: 'F.SilkS',
      fill: true,
    },
  ],
  zones: [
    {
      id: 'overlapping-zone',
      netId: 'signal',
      layer: 'F.Cu',
      outline: rectangle(10, 10, 45, 40),
      filledPolygons: [{ points: rectangle(10, 10, 45, 40) }],
      clearance: 0.25,
      minThickness: 0.2,
      thermalGap: 0.3,
      thermalBridge: 0.3,
    },
  ],
};
const overlap = { x: 30, y: 25 };
const styles = await Promise.all(
  ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'].map((file) =>
    readFile(file, 'utf8'),
  ),
);
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});

const casePattern = process.argv[2] ? new RegExp(process.argv[2]) : null;
let matchedCases = 0;
async function run(name, check, fixtureBoard = board) {
  if (casePattern && !casePattern.test(name)) return;
  matchedCases++;
  const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  await page.evaluate(
    (fixture) => {
      window.fixture = fixture;
      window.lastBoard = fixture.board;
      window.commits = 0;
      window.undoCalls = 0;
    },
    { board: fixtureBoard, schematic: emptyCircuit() },
  );
  for (const content of styles) await page.addStyleTag({ content });
  await page.addStyleTag({ content: 'html,body,#root,.layout-editor{height:100%;margin:0}' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const canvas = page.getByTestId('layout-canvas');
  await canvas.waitFor();
  await canvas.focus();
  const menu = page.getByRole('menu', { name: 'Choose layout object', exact: true });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const screen = (position) =>
    canvas.evaluate((svg, p) => {
      const at = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
      return { x: at.x, y: at.y };
    }, position);
  const point = async (position, click = false, modifiers = []) => {
    const at = await screen(position);
    for (const key of modifiers) await page.keyboard.down(key);
    await page.mouse.move(at.x, at.y);
    if (click) await page.mouse.click(at.x, at.y);
    for (const key of [...modifiers].reverse()) await page.keyboard.up(key);
  };
  const selection = () => page.evaluate(() => window.layoutContext.current.selection);
  const selectedIds = async () => (await selection()).map((item) => item.id).sort();
  const snapshot = () =>
    page.evaluate(() => ({ board: window.lastBoard, commits: window.commits }));
  const clean = async (expected = fixtureBoard) =>
    assert.deepEqual(await snapshot(), { board: expected, commits: 0 });
  try {
    await check({
      page,
      canvas,
      menu,
      button,
      screen,
      point,
      selection,
      selectedIds,
      snapshot,
      clean,
    });
    assert.deepEqual(errors, [], `${name}: no renderer errors.`);
    console.log(`Layout overlap selection: ${name}.`);
  } finally {
    await page.close();
  }
}

try {
  await run(
    'clearing every Selection category blocks interaction picks and both marquee directions',
    async ({ page, canvas, point, screen, selection, clean }) => {
      await point({ x: 55, y: 26.8 }, true);
      assert.deepEqual(await selection(), [{ kind: 'footprint', id: 'B2' }]);
      await toggleLayoutVisualization(page, 'Selection');
      const filters = page.getByRole('group', { name: 'Selection', exact: true });
      await filters.getByRole('checkbox', { name: 'All items', exact: true }).uncheck();
      assert.equal(
        await filters
          .getByRole('checkbox')
          .evaluateAll((inputs) => inputs.some((input) => input.checked || input.indeterminate)),
        false,
        'Every Selection category is visibly unchecked.',
      );
      const currentFilters = await page.evaluate(() => window.layoutContext.current.filters);
      for (const key of [
        'footprint',
        'track',
        'via',
        'graphic',
        'zone',
        'pad',
        'text',
        'dimension',
        'ruleArea',
        'locked',
      ])
        assert.equal(currentFilters[key], false, `${key} is disabled in the editor context.`);
      await toggleLayoutVisualization(page, 'Selection');
      const empty = async (action) => {
        assert.deepEqual(await selection(), [], `${action} cannot select a disabled object.`);
        assert.equal(
          await canvas.locator('[data-selection-only], .layout-footprint.selected').count(),
          0,
          `${action} leaves no retained selection paint.`,
        );
        assert.equal(
          await page.evaluate(() => window.layoutContext.current.inspectedPadId),
          '',
          `${action} cannot inspect a disabled pad.`,
        );
        await clean();
      };
      await empty('Clearing Selection');
      for (const at of [
        { x: 25, y: 25 },
        { x: 55, y: 26.8 },
        { x: 55, y: 25 },
        overlap,
        { x: 28, y: 23 },
        { x: 15, y: 29 },
        { x: 0, y: 20 },
      ]) {
        await point(at, true);
        await empty('Point picking');
        await point(at, true, ['Alt']);
        await empty('Alt point picking');
      }
      const body = await screen({ x: 55, y: 26.8 });
      await page.mouse.dblclick(body.x, body.y);
      await empty('Double-clicking');
      for (const crossing of [false, true])
        for (const modifiers of [[], ['Shift'], ['Control'], ['Control', 'Shift']]) {
          const start = await screen({ x: crossing ? 75 : 5, y: 5 });
          const end = await screen({ x: crossing ? 5 : 75, y: 45 });
          for (const key of modifiers) await page.keyboard.down(key);
          await page.mouse.move(start.x, start.y);
          await page.mouse.down();
          await page.mouse.move(end.x, end.y, { steps: 4 });
          assert.equal(
            await canvas
              .locator(`[data-selection-box="${crossing ? 'crossing' : 'window'}"]`)
              .count(),
            1,
            'The interaction gesture remains a selection rectangle.',
          );
          await page.mouse.up();
          for (const key of [...modifiers].reverse()) await page.keyboard.up(key);
          await empty(`${crossing ? 'Crossing' : 'Window'} marquee with ${modifiers.join('+')}`);
        }
      await canvas.press('Control+a');
      await empty('Select all');
    },
  );
  const thinOutline = structuredClone(board);
  thinOutline.graphics[0].width = 0.05;
  for (const [index, width] of [0.01, 0.15].entries())
    thinOutline.footprints[index].graphics.push({
      id: `footprint-edge-${index}`,
      start: { x: -3, y: -3 },
      end: { x: 3, y: -3 },
      width,
      layer: 'Edge.Cuts',
    });
  await run(
    'thin board edges and outline previews share a display floor without changing native widths',
    async ({ page, canvas, button, point, clean }) => {
      assert.equal(
        await canvas.locator('[data-selection-id="edge"] > path').getAttribute('stroke-width'),
        '0.05',
        'Pinned-style board edges retain their 0.05 mm stroke.',
      );
      const edgeTarget = canvas.locator('[data-selection-id="edge"] [data-layout-graphic-target]');
      assert.equal(
        await edgeTarget.getAttribute('data-layout-graphic-target'),
        '0.05',
        'The camera hit target retains the native width as its geometry input.',
      );
      const hitPixels = await edgeTarget.locator('path').evaluate((path) => {
        const transform = path.getScreenCTM();
        return Number(path.getAttribute('stroke-width')) * Math.hypot(transform.a, transform.b);
      });
      assert.ok(
        Math.abs(hitPixels - 6) < 1e-6,
        "The thin edge retains the camera's six-screen-pixel hit tolerance.",
      );
      for (const [index, width] of [0.05, 0.15].entries())
        assert.equal(
          await canvas
            .locator(`[data-footprint-graphic="footprint-edge-${index}"] > path`)
            .getAttribute('stroke-width'),
          String(width),
          'Footprint edges use the display floor while preserving wider native strokes.',
        );
      await clean();
      for (const shape of ['polygon', 'rectangle']) {
        await selectLayoutLayer(page, 'Edge.Cuts');
        await button(`Draw ${shape}`).click();
        assert.equal(
          await page
            .getByRole('complementary', { name: 'Region settings', exact: true })
            .getByRole('spinbutton')
            .count(),
          0,
          'Region drawing uses the default line width without a width preset.',
        );
        await point({ x: 10, y: 15 }, true);
        await point({ x: 18, y: 20 });
        assert.equal(
          await canvas.locator('[data-shape-preview]').getAttribute('stroke-width'),
          '0.05',
          `${shape} previews use the same thin display floor.`,
        );
        await canvas.press('Escape');
        assert.equal(await canvas.locator('[data-shape-preview]').count(), 0);
        await clean();
      }
    },
    thinOutline,
  );
  await run(
    'overlapping geometry is picked directly from the pointer with no object menu',
    async ({ point, menu, selection, clean }) => {
      await point({ x: 25, y: 25 }, true);
      assert.equal(await menu.count(), 0);
      assert.deepEqual(await selection(), [{ kind: 'track', id: 'underlying-track' }]);
      await point({ x: 55, y: 26.8 }, true);
      assert.equal(await menu.count(), 0);
      assert.deepEqual(await selection(), [{ kind: 'footprint', id: 'B2' }]);
      await clean();
    },
  );
  await run(
    'coincident candidates resolve stably without using previous selection as a barrier',
    async ({ page, point, menu, selection, clean }) => {
      // This ambiguity check compares selectable objects, independently of pad inspection.
      await toggleLayoutVisualization(page, 'Selection');
      await page
        .getByRole('group', { name: 'Selection', exact: true })
        .getByRole('checkbox', { name: 'Pads', exact: true })
        .uncheck();
      await toggleLayoutVisualization(page, 'Selection');
      await point(overlap, true);
      const first = await selection();
      assert.equal(first.length, 1);
      assert.equal(await menu.count(), 0);
      await point({ x: 55, y: 26.8 }, true);
      for (let i = 0; i < 3; i++) {
        await point(overlap, true);
        assert.deepEqual(await selection(), first);
        assert.equal(await menu.count(), 0);
      }
      await clean();
    },
  );
  await run(
    'disabled filters expose underlying copper without a selection dialog',
    async ({ page, point, menu, selection, clean }) => {
      await toggleLayoutVisualization(page, 'Selection');
      const filters = page.getByRole('group', { name: 'Selection', exact: true });
      for (const label of ['Footprints', 'Pads', 'Vias', 'Graphics', 'Zones'])
        await filters.getByRole('checkbox', { name: label, exact: true }).uncheck();
      await toggleLayoutVisualization(page, 'Selection');
      await point(overlap, true);
      assert.equal(await menu.count(), 0);
      assert.deepEqual(await selection(), [{ kind: 'track', id: 'underlying-track' }]);
      await clean();
    },
  );
  await run(
    'direct selection preserves add toggle subtract and Alt does not open a menu',
    async ({ point, menu, selectedIds, clean }) => {
      await point({ x: 55, y: 26.8 }, true);
      for (const [modifiers, expected] of [
        [['Shift'], ['B2', 'underlying-track']],
        [['Control'], ['B2']],
        [['Control'], ['B2', 'underlying-track']],
        [['Control', 'Shift'], ['B2']],
      ]) {
        await point({ x: 25, y: 25 }, true, modifiers);
        assert.equal(await menu.count(), 0);
        assert.deepEqual(await selectedIds(), expected);
      }
      await point({ x: 25, y: 25 }, true, ['Alt']);
      assert.equal(await menu.count(), 0);
      assert.deepEqual(await selectedIds(), ['underlying-track']);
      await clean();
    },
  );
  await run(
    'default pad inspection directly targets a pad without changing its schematic net',
    async ({ page, point, menu, selection, clean }) => {
      await toggleLayoutVisualization(page, 'Selection');
      const filters = page.getByRole('group', { name: 'Selection', exact: true });
      assert.equal(
        await filters.getByRole('checkbox', { name: 'Pads', exact: true }).isChecked(),
        true,
      );
      const all = filters.getByRole('checkbox', { name: 'All items', exact: true });
      assert.equal(await all.isChecked(), true);
      assert.equal(await all.evaluate((input) => input.indeterminate), false);
      assert.equal(
        await filters.getByRole('checkbox', { name: 'Locked items', exact: true }).isChecked(),
        false,
      );
      await toggleLayoutVisualization(page, 'Selection');
      await point({ x: 55, y: 25 }, true);
      assert.equal(await menu.count(), 0);
      assert.deepEqual(await selection(), []);
      assert.equal(
        await page.evaluate(() => window.layoutContext.current.inspectedPadId),
        'B2-pad',
      );
      await page
        .getByRole('complementary', { name: 'Layout properties' })
        .getByRole('heading', { name: 'Pad 1', exact: true })
        .waitFor();
      assert.equal(await page.getByRole('spinbutton', { name: 'Pad width (mm)' }).count(), 1);
      assert.equal(await page.getByRole('combobox', { name: 'Pad net', exact: true }).count(), 0);
      await clean();
    },
  );
  await run(
    'Appearance retains selection and allows immediate canvas interaction without a modal',
    async ({ page, point, selection, clean, canvas }) => {
      for (const section of ['Selection', 'Visible layers']) {
        await point({ x: 55, y: 26.8 }, true);
        await toggleLayoutVisualization(page, section);
        assert.deepEqual(await selection(), [{ kind: 'footprint', id: 'B2' }]);
        assert.equal(await page.getByRole('dialog').count(), 0);
        await toggleLayoutVisualization(page, section);
        assert.equal(await canvas.evaluate((svg) => document.activeElement === svg), true);
        await point({ x: 25, y: 25 }, true);
        assert.deepEqual(await selection(), [{ kind: 'track', id: 'underlying-track' }]);
        await clean();
      }
    },
  );
  const caption = structuredClone(board);
  caption.footprints[1].graphics.push({
    id: 'B2-caption',
    kind: 'text',
    start: { x: 8, y: -4 },
    end: { x: 8, y: -4 },
    width: 0.1,
    layer: 'F.SilkS',
    text: {
      value: '${REFERENCE}',
      property: 'Reference',
      rotation: 0,
      size: { x: 1.5, y: 1.5 },
      thickness: 0.1,
    },
  });
  await run(
    'visible external captions select the native text without selecting the body',
    async ({ page, canvas, point, menu, selection, snapshot, clean }) => {
      const text = canvas.locator('[data-footprint-captions="B2"] text').first();
      const bounds = await text.boundingBox();
      assert.ok(bounds);
      await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      assert.equal(await menu.count(), 0);
      assert.deepEqual(await selection(), [{ kind: 'graphic', id: 'B2-caption' }]);
      assert.equal(
        await canvas.locator('[data-footprint-text="B2-caption"] [data-selection-only]').count(),
        1,
      );
      assert.equal(
        await canvas.locator('[data-selection-id="B2"] [data-selection-only]').count(),
        0,
      );
      await page.keyboard.press('e');
      const properties = page.getByRole('complementary', { name: 'Layout properties' });
      await properties.getByText('Footprint text', { exact: true }).waitFor();
      await properties.getByText('B2', { exact: true }).waitFor();
      await toggleLayoutVisualization(page, 'Selection');
      const filters = page.getByRole('group', { name: 'Selection', exact: true });
      const textFilter = filters.getByRole('checkbox', { name: 'Text', exact: true });
      const footprintsFilter = filters.getByRole('checkbox', { name: 'Footprints', exact: true });
      await textFilter.uncheck();
      await point({ x: 63, y: 21 }, true);
      assert.deepEqual(await selection(), [{ kind: 'graphic', id: 'edge' }]);
      await clean();
      await textFilter.check();
      await footprintsFilter.uncheck();
      await point({ x: 63, y: 21 }, true);
      assert.deepEqual(await selection(), [{ kind: 'graphic', id: 'B2-caption' }]);
      await canvas.focus();
      await page.keyboard.press('m');
      await point({ x: 65, y: 21 }, true);
      const moved = await snapshot();
      assert.equal(moved.commits, 1);
      const expected = structuredClone(caption);
      const field = expected.footprints[1].graphics.at(-1);
      field.start.x += 2;
      field.end.x += 2;
      assert.deepEqual(moved.board, expected);
    },
    caption,
  );
  const holes = structuredClone(board);
  const mixed = structuredClone(caption);
  const legend = mixed.footprints[1].graphics.at(-1);
  legend.start = { x: 0, y: 0 };
  legend.end = { ...legend.start };
  mixed.tracks.push({
    id: 'caption-track',
    start: { x: 50, y: 25 },
    end: { x: 60, y: 25 },
    width: 2,
    layer: 'F.Cu',
    netId: 'signal',
  });
  await run(
    'mixed silk and copper obey active silk priority and clarify similarly sized pad and track',
    async ({ page, canvas, point, menu, selection, screen, clean }) => {
      await selectLayoutLayer(page, 'B.SilkS');
      await point({ x: 55, y: 25 }, true);
      assert.deepEqual(await selection(), [{ kind: 'graphic', id: 'B2-caption' }]);
      assert.equal(await menu.count(), 0);
      await selectLayoutLayer(page, 'F.Cu');
      await point({ x: 55, y: 25 }, true);
      await menu.waitFor();
      assert.deepEqual(await selection(), [{ kind: 'graphic', id: 'B2-caption' }]);
      await menu.getByRole('menuitem', { name: 'Pad 1 · B2' }).waitFor();
      await menu.getByRole('menuitem', { name: 'Track · F.Cu · SIGNAL' }).waitFor();
      await menu
        .locator('button')
        .first()
        .evaluate((button) => {
          button.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: 'Escape',
              bubbles: true,
              cancelable: true,
              isComposing: true,
            }),
          );
        });
      assert.equal(await menu.count(), 1);
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'hidden' });
      assert.equal(await canvas.evaluate((element) => document.activeElement === element), true);
      await point({ x: 55, y: 25 }, true);
      await menu.waitFor();
      await menu.getByRole('menuitem', { name: 'Pad 1 · B2' }).click();
      assert.equal(
        await page.evaluate(() => window.layoutContext.current.inspectedPadId),
        'B2-pad',
      );
      assert.deepEqual(await selection(), []);
      const at = await screen({ x: 55, y: 25 });
      await page.mouse.click(at.x, at.y, { button: 'right' });
      const actions = page.getByRole('menu', { name: 'Canvas actions', exact: true });
      await actions.getByRole('menuitem', { name: 'Properties', exact: true }).waitFor();
      assert.equal(await menu.count(), 0);
      await page.keyboard.press('Escape');
      await toggleLayoutVisualization(page, 'Selection');
      const pads = page
        .getByRole('group', { name: 'Selection', exact: true })
        .getByRole('checkbox', { name: 'Pads', exact: true });
      await pads.uncheck();
      await point({ x: 55, y: 25 }, true);
      assert.equal(await menu.count(), 0);
      assert.deepEqual(await selection(), [{ kind: 'track', id: 'caption-track' }]);
      await pads.check();
      await point({ x: 55, y: 25 }, true);
      await menu.waitFor();
      assert.deepEqual(await selection(), [{ kind: 'track', id: 'caption-track' }]);
      await page.keyboard.press('Escape');
      await selectLayoutLayer(page, 'F.SilkS');
      await point({ x: 55, y: 25 }, true, ['Control', 'Shift']);
      assert.deepEqual(await selection(), []);
      assert.equal(await menu.count(), 0);
      await clean();
    },
    mixed,
  );
  const hole = rectangle(18, 27, 22, 31);
  holes.zones[0].holes = [hole];
  holes.zones[0].filledPolygons = [
    { points: copperFillContour({ outer: holes.zones[0].outline, holes: [hole] }) },
  ];
  await run(
    'saved fill holes have no target while visible copper remains directly selectable',
    async ({ page, point, menu, selection, clean }) => {
      await setLayoutVisibility(page, 'Zone outlines', false);
      await setLayoutVisibility(page, 'Edge.Cuts', false);
      await point({ x: 20, y: 29 }, true);
      assert.equal(await menu.count(), 0);
      assert.deepEqual(await selection(), []);
      await point({ x: 15, y: 29 }, true);
      assert.deepEqual(await selection(), [{ kind: 'zone', id: 'overlapping-zone' }]);
      assert.equal(await menu.count(), 0);
      await clean();
    },
    holes,
  );
  await run(
    'board replacement and deactivation cancel movement without delayed writes',
    async ({ page, canvas, point, menu, selection, clean }) => {
      await point({ x: 25, y: 25 });
      await canvas.focus();
      await canvas.press('m');
      await point({ x: 25, y: 30 });
      const replacement = structuredClone(board);
      replacement.thickness = 1.8;
      await page.evaluate((next) => window.replaceBoard(next), replacement);
      await canvas.press('Enter');
      assert.equal(await menu.count(), 0);
      await clean(replacement);
      await point({ x: 25, y: 25 });
      await canvas.press('m');
      await point({ x: 25, y: 30 });
      await page.evaluate(() => window.setLayoutActive(false));
      await page.evaluate(() => window.setLayoutActive(true));
      await canvas.press('Enter');
      await clean(replacement);
    },
  );
  await run(
    'viewport changes preserve idle selection and never create an object menu',
    async ({ page, point, menu, selection, clean }) => {
      await point({ x: 25, y: 25 }, true);
      await page.setViewportSize({ width: 1000, height: 720 });
      assert.equal(await menu.count(), 0);
      assert.deepEqual(await selection(), [{ kind: 'track', id: 'underlying-track' }]);
      await clean();
    },
  );
  const dense = structuredClone(board);
  dense.footprints = [];
  dense.vias = [];
  dense.zones = [];
  dense.graphics = dense.graphics.filter((g) => g.id === 'edge');
  dense.tracks = Array.from({ length: 64 }, (_, i) => ({
    ...board.tracks[0],
    id: 'dense-' + String(i).padStart(2, '0'),
  }));
  await run(
    '64 coincident tracks choose one stable candidate directly without a menu or write',
    async ({ point, menu, selection, clean }) => {
      await point(overlap, true);
      const first = await selection();
      assert.equal(first.length, 1);
      assert.equal(first[0].kind, 'track');
      for (let i = 0; i < 3; i++) {
        await point(overlap, true);
        assert.equal(await menu.count(), 0);
        assert.deepEqual(await selection(), first);
      }
      await clean();
    },
    dense,
  );
  assert.ok(matchedCases > 0, 'The Layout clarification check must match at least one case.');
} finally {
  await browser.close();
}
