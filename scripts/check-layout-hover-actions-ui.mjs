import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { setLayoutVisibility, toggleLayoutVisualization } from './visualization-test-helpers.mjs';

const { emptyCircuit } = await tsImport('../lib/circuit.ts', import.meta.url);
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);

// Real pointer/keyboard dispatch in an isolated renderer: no native access,
// services, user projects or persistent history. Every accepted edit is counted.
const bundle = await build({
  stdin: {
    contents: `import React,{useRef,useState} from 'react';import {createRoot} from 'react-dom/client';
      import LayoutEditor from './components/LayoutEditor';
      function Test(){const [board,setBoard]=useState(window.fixture.board);
        const [active,setActive]=useState(true);const [history,setHistory]=useState([]);
        const context=useRef(null);window.layoutContext=()=>context.current;
        window.setLayoutActive=setActive;
        window.replaceBoard=next=>{window.lastBoard=next;setBoard(next)};
        return <LayoutEditor board={board} schematic={window.fixture.schematic} active={active} agentContextRef={context}
          onCommit={next=>{window.lastBoard=next;window.commits++;setHistory([...history,board]);setBoard(next);return true}}
          undoAction={<button aria-label="Undo" disabled={!history.length} onClick={()=>{const next=history.at(-1);window.lastBoard=next;setBoard(next);setHistory(history.slice(0,-1));window.undos++}}>Undo</button>}
          annotations={[]} annotationSessionId="hover-actions" onAnnotationsChange={()=>{}}/>}
      createRoot(document.getElementById('root')).render(<Test/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const rectangle = (left, top, right, bottom) => [
  { x: left, y: top },
  { x: right, y: top },
  { x: right, y: bottom },
  { x: left, y: bottom },
];
const footprint = (id, x, y) => ({
  id,
  x,
  y,
  symbolId: null,
  libraryId: 'Test:HoverActions',
  reference: id,
  rotation: 0,
  side: 'front',
  pads: [
    {
      id: `${id}-pad`,
      number: '1',
      x: -1.3,
      y: -1.3,
      rotation: 0,
      type: 'smd',
      shape: 'rect',
      size: { x: 0.6, y: 0.6 },
      netId: 'signal',
    },
  ],
  graphics: [
    {
      id: `${id}-body`,
      kind: 'polygon',
      layer: 'F.SilkS',
      width: 0.12,
      start: { x: -2, y: -2 },
      end: { x: -2, y: 2 },
      points: [
        { x: 2, y: -2 },
        { x: 2, y: 2 },
      ],
    },
  ],
});
const zone = (id, outline) => ({
  id,
  netId: 'signal',
  layer: 'F.Cu',
  outline,
  filledPolygons: [{ points: outline }],
  clearance: 0.25,
  minThickness: 0.2,
  thermalGap: 0.3,
  thermalBridge: 0.3,
});
const board = {
  ...createEmptyPCB(),
  nets: [
    { id: 'signal', name: 'SIGNAL' },
    { id: 'aux', name: 'AUX' },
  ],
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
  vias: [],
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
  zones: [zone('pour', rectangle(10, 10, 45, 40))],
};
const overlap = { x: 31, y: 25 };
const styles = await Promise.all(
  ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'].map((path) =>
    readFile(path, 'utf8'),
  ),
);
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});

async function run(name, check, fixtureBoard = board) {
  const filters = process.argv.slice(2);
  if (filters.length && !filters.some((filter) => name.includes(filter))) return;
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
      window.undos = 0;
      window.inspectorFocuses = 0;
      document.addEventListener('focusin', (event) => {
        if (event.target.closest('.layout-inspector-content')) window.inspectorFocuses++;
      });
    },
    { board: fixtureBoard, schematic: emptyCircuit() },
  );
  for (const content of styles) await page.addStyleTag({ content });
  await page.addStyleTag({ content: 'html,body,#root,.layout-editor{height:100%;margin:0}' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const canvas = page.getByTestId('layout-canvas');
  await canvas.waitFor();
  const menu = page.getByRole('menu', { name: 'Choose layout object', exact: true });
  const point = async (position, click = false, modifiers = []) => {
    const at = await canvas.evaluate((svg, p) => {
      const screen = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
      return { x: screen.x, y: screen.y };
    }, position);
    for (const key of modifiers) await page.keyboard.down(key);
    await page.mouse.move(at.x, at.y);
    if (click) await page.mouse.click(at.x, at.y);
    for (const key of [...modifiers].reverse()) await page.keyboard.up(key);
  };
  const hoverAction = async (key, position = overlap) => {
    await point(position);
    await canvas.focus();
    await canvas.press(key);
  };
  const selected = () =>
    page.evaluate(() =>
      window
        .layoutContext()
        .selection.map((s) => s.id)
        .sort(),
    );
  const snapshot = () =>
    page.evaluate(() => ({ board: window.lastBoard, commits: window.commits }));
  const clean = async (expected = fixtureBoard) =>
    assert.deepEqual(await snapshot(), { board: expected, commits: 0 });
  const undo = async () => {
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    assert.deepEqual(
      (await snapshot()).board,
      fixtureBoard,
      'One Undo restores the complete board.',
    );
    assert.equal(await page.evaluate(() => window.undos), 1);
    assert.equal(await page.getByRole('button', { name: 'Undo', exact: true }).isEnabled(), false);
  };
  try {
    await check({
      page,
      canvas,
      menu,
      point,
      hoverAction,
      selected,
      snapshot,
      clean,
      undo,
    });
    assert.deepEqual(errors, [], `${name}: no renderer errors.`);
    console.log(`Layout hover actions: ${name}.`);
  } finally {
    await page.close();
  }
}

try {
  await run(
    'M resolves the hovered track directly and retains the original pickup',
    async ({ canvas, hoverAction, selected, point, snapshot, clean, undo, menu }) => {
      await hoverAction('m');
      assert.equal(await menu.count(), 0);
      assert.deepEqual(await selected(), ['underlying-track']);
      await canvas.press('Enter');
      await clean();
      await hoverAction('m');
      await point({ x: 35, y: 30 });
      await canvas.press('Enter');
      const result = await snapshot();
      assert.equal(result.commits, 1);
      assert.deepEqual(result.board.tracks[0].start, { x: 24, y: 30 });
      assert.deepEqual(result.board.tracks[0].end, { x: 44, y: 30 });
      assert.deepEqual(result.board.footprints, board.footprints);
      await undo();
    },
  );
  await run(
    'M attaches the footprint origin to its pointer pickup and commits the exact preview',
    async ({ canvas, hoverAction, clean, snapshot, undo, menu }) => {
      await hoverAction('m', { x: 31, y: 26.2 });
      assert.equal(await menu.count(), 0);
      await clean();
      assert.equal(
        await canvas
          .locator('.layout-footprint[data-selection-id="A1"] > g[transform]:not([data-pad-id])')
          .getAttribute('transform'),
        'translate(31 26) rotate(0)',
      );
      await canvas.press('Enter');
      const result = await snapshot();
      assert.equal(result.commits, 1);
      assert.equal(result.board.footprints[0].x, 31);
      assert.equal(result.board.footprints[0].y, 26);
      assert.deepEqual(result.board.footprints[0].pads, board.footprints[0].pads);
      assert.deepEqual(result.board.tracks, board.tracks);
      await undo();
    },
  );
  await run(
    'M retains an off-grid pad reference without changing package geometry',
    async ({ canvas, hoverAction, point, clean, snapshot, menu }) => {
      await hoverAction('m', { x: 28.7, y: 23.7 });
      assert.equal(await menu.count(), 0);
      await clean();
      assert.equal(
        await canvas
          .locator('.layout-footprint[data-selection-id="A1"] > g[transform]:not([data-pad-id])')
          .getAttribute('transform'),
        'translate(29.8 24.8) rotate(0)',
      );
      await point({ x: 33.5, y: 28.5 });
      await canvas.press('Enter');
      const result = await snapshot();
      assert.equal(result.commits, 1);
      assert.equal(result.board.footprints[0].x, 34.8);
      assert.equal(result.board.footprints[0].y, 29.8);
      assert.deepEqual(result.board.footprints[0].pads, board.footprints[0].pads);
      assert.deepEqual(result.board.tracks, board.tracks);
    },
  );
  const overlappingPads = structuredClone(board);
  const selectedOwner = footprint('A1', 20, 20);
  selectedOwner.pads[0] = { ...selectedOwner.pads[0], x: 1.23, y: 0.67 };
  const laterOwner = footprint('B2', 21.23, 20.67);
  laterOwner.pads[0] = { ...laterOwner.pads[0], x: 0, y: 0 };
  overlappingPads.footprints = [selectedOwner, laterOwner];
  await run(
    'M uses the selected-owner pad anchor when a later footprint pad overlaps it',
    async ({ canvas, point, hoverAction, selected, snapshot, clean, menu, undo }) => {
      await point({ x: 18, y: 20 }, true);
      assert.deepEqual(await selected(), ['A1']);
      await hoverAction('m', { x: 21.23, y: 20.67 });
      assert.equal(await menu.count(), 0);
      assert.deepEqual(await selected(), ['A1']);
      await clean();
      await point({ x: 24, y: 23 });
      await canvas.press('Enter');
      const result = await snapshot();
      assert.equal(result.commits, 1);
      const moved = result.board.footprints[0];
      assert.equal(Number((moved.x + moved.pads[0].x).toFixed(6)), 24);
      assert.equal(Number((moved.y + moved.pads[0].y).toFixed(6)), 23);
      assert.equal(moved.x, 22.77);
      assert.equal(moved.y, 22.33);
      assert.deepEqual(moved.pads, selectedOwner.pads);
      assert.deepEqual(result.board.footprints[1], laterOwner);
      assert.deepEqual(result.board.tracks, overlappingPads.tracks);
      await undo();
    },
    overlappingPads,
  );
  for (const [key, rotation] of [
    ['r', 90],
    ['Shift+r', 270],
  ]) {
    await run(
      key + ' immediately rotates the footprint nearest the pointer without changing copper',
      async ({ hoverAction, snapshot, selected, undo, menu }) => {
        await hoverAction(key, { x: 31, y: 26.2 });
        assert.equal(await menu.count(), 0);
        const result = await snapshot();
        assert.equal(result.commits, 1);
        assert.deepEqual(await selected(), ['A1']);
        assert.equal(result.board.footprints[0].rotation, rotation);
        assert.equal(result.board.footprints[0].x, 30);
        assert.equal(result.board.footprints[0].y, 25);
        assert.deepEqual(result.board.footprints[0].pads, board.footprints[0].pads);
        assert.deepEqual(result.board.footprints[1], board.footprints[1]);
        assert.deepEqual(result.board.tracks, board.tracks);
        await undo();
      },
    );
  }
  await run(
    'E directly inspects the hovered track and focuses Properties exactly once',
    async ({ page, hoverAction, selected, clean, menu }) => {
      await hoverAction('e');
      assert.equal(await menu.count(), 0);
      await page.waitForFunction(() =>
        document.activeElement?.closest('.layout-inspector-content'),
      );
      assert.deepEqual(await selected(), ['underlying-track']);
      assert.equal(
        await page
          .getByRole('complementary', { name: 'Layout properties' })
          .locator('header strong')
          .textContent(),
        'Properties',
      );
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      assert.equal(await page.evaluate(() => window.inspectorFocuses), 1);
      await clean();
    },
  );
  await run(
    'Delete directly removes the hovered track in one undoable edit',
    async ({ hoverAction, snapshot, selected, undo, menu }) => {
      await hoverAction('Delete');
      assert.equal(await menu.count(), 0);
      const result = await snapshot();
      assert.equal(result.commits, 1);
      assert.deepEqual(result.board.tracks, []);
      assert.deepEqual(result.board.footprints, board.footprints);
      assert.deepEqual(await selected(), []);
      await undo();
    },
  );
  await run(
    'existing selection retains priority over hover for keyboard rotation and inspection',
    async ({ page, point, hoverAction, menu, snapshot, selected }) => {
      await point({ x: 55, y: 26 }, true);
      await hoverAction('r');
      assert.equal(await menu.count(), 0);
      assert.deepEqual(await selected(), ['B2']);
      const result = await snapshot();
      assert.equal(result.commits, 1);
      assert.equal(result.board.footprints[1].rotation, 90);
      assert.deepEqual(result.board.footprints[0], board.footprints[0]);
      assert.deepEqual(result.board.tracks, board.tracks);
      await hoverAction('e');
      assert.equal(await menu.count(), 0);
      await page.waitForFunction(() =>
        document.activeElement?.closest('.layout-inspector-content'),
      );
      assert.deepEqual(await selected(), ['B2']);
      assert.equal((await snapshot()).commits, 1);
    },
  );
  await run(
    'F resolves only footprints even with copper under the pointer',
    async ({ hoverAction, menu, selected, snapshot }) => {
      await hoverAction('f');
      assert.equal(await menu.count(), 0);
      assert.deepEqual(await selected(), ['A1']);
      const result = await snapshot();
      assert.equal(result.commits, 1);
      assert.equal(result.board.footprints[0].side, 'back');
      assert.deepEqual(result.board.tracks, board.tracks);
    },
  );
  const viaOverlap = structuredClone(board);
  viaOverlap.vias = [
    { id: 'overlapping-via', x: 31, y: 25, diameter: 1, drill: 0.4, netId: 'aux' },
  ];
  await run(
    'U and net highlighting directly resolve the nearest eligible copper and pad',
    async ({ page, canvas, hoverAction, menu, selected, clean }) => {
      await hoverAction('u', { x: 31, y: 25.3 });
      assert.equal(await menu.count(), 0);
      assert.deepEqual(await selected(), ['overlapping-via']);
      await canvas.press('Escape');
      await hoverAction('`', { x: 31, y: 25.3 });
      assert.equal(await menu.count(), 0);
      assert.deepEqual(await page.evaluate(() => window.layoutContext().highlightNets), ['aux']);
      await clean();
      await canvas.press('Escape');
      await toggleLayoutVisualization(page, 'Selection');
      await page
        .getByRole('group', { name: 'Selection', exact: true })
        .getByRole('checkbox', { name: 'Pads', exact: true })
        .check();
      await toggleLayoutVisualization(page, 'Selection');
      await hoverAction('`', { x: 28.7, y: 23.7 });
      assert.equal(await menu.count(), 0);
      assert.deepEqual(await page.evaluate(() => window.layoutContext().highlightNets), ['signal']);
      await clean();
    },
    viaOverlap,
  );
  await run(
    'disabled footprint selection passes hover rotation directly to tracks',
    async ({ page, hoverAction, menu, selected, snapshot }) => {
      await toggleLayoutVisualization(page, 'Selection');
      await page
        .getByRole('group', { name: 'Selection', exact: true })
        .getByRole('checkbox', { name: 'Footprints', exact: true })
        .uncheck();
      await toggleLayoutVisualization(page, 'Selection');
      await hoverAction('r');
      assert.equal(await menu.count(), 0);
      assert.deepEqual(await selected(), ['underlying-track']);
      const result = await snapshot();
      assert.equal(result.commits, 1);
      assert.deepEqual(result.board.tracks[0].start, { x: 30, y: 35 });
      assert.deepEqual(result.board.tracks[0].end, { x: 30, y: 15 });
      assert.deepEqual(result.board.footprints, board.footprints);
    },
  );
  for (const key of ['m', 'd', 'g']) {
    await run(
      'Escape cancels direct hover ' + key + ' preview without writing',
      async ({ page, canvas, hoverAction, point, menu, selected, clean }) => {
        await hoverAction(key);
        assert.equal(await menu.count(), 0);
        assert.deepEqual(await selected(), ['underlying-track']);
        await point({ x: 31, y: 29 });
        await canvas.press('Escape');
        assert.equal(await canvas.locator('[data-track-drag-preview]').count(), 0);
        assert.equal(await page.locator('.layout-canvas.is-moving').count(), 0);
        await canvas.press('Enter');
        await clean();
      },
    );
  }
  for (const event of ['board replacement', 'deactivation']) {
    await run(
      event + ' discards direct hover movement before a late Enter',
      async ({ page, canvas, hoverAction, menu, clean }) => {
        await hoverAction('m');
        assert.equal(await menu.count(), 0);
        const expected = structuredClone(board);
        if (event === 'board replacement') {
          expected.thickness = 1.8;
          await page.evaluate((next) => window.replaceBoard(next), expected);
        } else await page.evaluate(() => window.setLayoutActive(false));
        if (event === 'deactivation') await page.evaluate(() => window.setLayoutActive(true));
        await canvas.press('Enter');
        await clean(expected);
      },
    );
  }
  const embedded = structuredClone(board);
  embedded.zones = [];
  embedded.footprints[0].zones = [zone('embedded-fill', rectangle(8, 8, 16, 16))];
  embedded.tracks.push({
    ...embedded.tracks[0],
    id: 'embedded-track',
    start: { x: 39, y: 36 },
    end: { x: 45, y: 36 },
  });
  await run(
    'embedded fill fallback and hidden owners are resolved directly without Alt menus',
    async ({ page, canvas, point, menu, selected, clean }) => {
      for (const modifiers of [[], ['Alt']]) {
        await point({ x: 42, y: 36 }, true, modifiers);
        assert.equal(await menu.count(), 0);
        assert.deepEqual(await selected(), ['embedded-track']);
        await canvas.press('Escape');
      }
      await point({ x: 42, y: 39 }, true);
      assert.equal(await menu.count(), 0);
      assert.deepEqual(await selected(), ['A1']);
      await canvas.press('Escape');
      await setLayoutVisibility(page, 'Footprints', false);
      for (const modifiers of [[], ['Alt']]) {
        await point({ x: 42, y: 39 }, true, modifiers);
        assert.equal(await menu.count(), 0);
        assert.deepEqual(await selected(), []);
      }
      await point({ x: 42, y: 36 }, true);
      assert.deepEqual(await selected(), ['embedded-track']);
      await clean();
    },
    embedded,
  );
} finally {
  await browser.close();
}
