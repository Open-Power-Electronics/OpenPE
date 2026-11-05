import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { toggleLayoutVisualization } from './visualization-test-helpers.mjs';

const { emptyCircuit } = await tsImport('../lib/circuit.ts', import.meta.url);
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const { parseProject } = await tsImport('../lib/project.ts', import.meta.url);
const { parseKiCadPCB } = await tsImport('../lib/kicad-pcb.ts', import.meta.url);

// Coordinate-based pointer input in an isolated renderer, without native access,
// services or user projects. Selection and cancelled previews must stay clean.
const bundle = await build({
  stdin: {
    contents: `import React,{useRef,useState} from 'react';import {createRoot} from 'react-dom/client';
      import LayoutEditor from './components/LayoutEditor';
      function Test(){const [board,setBoard]=useState(window.fixture.board);const [history,setHistory]=useState([]);
        const context=useRef(null);window.layoutContext=()=>context.current;
        return <LayoutEditor leftButtonDrag="drag-any" board={board} schematic={window.fixture.schematic} active agentContextRef={context}
          onCommit={next=>{window.lastBoard=next;window.commits++;setHistory([...history,board]);setBoard(next);return true}}
          undoAction={<button aria-label="Undo" disabled={!history.length} onClick={()=>{const next=history.at(-1);window.lastBoard=next;setBoard(next);setHistory(history.slice(0,-1))}}>Undo</button>}
          annotations={[]} annotationSessionId="picking" onAnnotationsChange={()=>{}}/>}
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
  libraryId: 'Test:Picking',
  reference: id,
  rotation: 0,
  side: 'front',
  pads: [
    {
      id: `${id}-pad`,
      number: '1',
      x: -1.4,
      y: -1.4,
      rotation: 0,
      type: 'smd',
      shape: 'rect',
      size: { x: 0.5, y: 0.5 },
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
  vias: [{ id: 'via', x: 55, y: 35, diameter: 1.2, drill: 0.4, netId: 'signal' }],
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
  zones: [
    {
      id: 'pour',
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

async function run(name, check, fixtureBoard = board, fixtureSchematic = emptyCircuit()) {
  if (process.argv[2] && !name.includes(process.argv[2])) return;
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
    },
    { board: fixtureBoard, schematic: fixtureSchematic },
  );
  for (const content of styles) await page.addStyleTag({ content });
  await page.addStyleTag({ content: 'html,body,#root,.layout-editor{height:100%;margin:0}' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const canvas = page.getByTestId('layout-canvas');
  await canvas.waitFor();
  const menu = page.getByRole('menu', { name: 'Choose layout object', exact: true });
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
  const drag = async (from, to) => {
    await point(from);
    await page.mouse.down();
    const at = await screen(to);
    await page.mouse.move(at.x, at.y, { steps: 4 });
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
  const clean = async () => assert.deepEqual(await snapshot(), { board: fixtureBoard, commits: 0 });
  const captureDetail = async (position, path) => {
    const at = await screen(position);
    const bounds = await canvas.boundingBox();
    assert.ok(bounds);
    await page.mouse.move(at.x, at.y);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, { steps: 4 });
    await page.mouse.up({ button: 'right' });
    for (let i = 0; i < 10; i++) {
      await page.mouse.wheel(0, -120);
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
    }
    await mkdir('test-results', { recursive: true });
    await canvas.screenshot({ path });
  };
  const disableFootprints = async () => {
    await toggleLayoutVisualization(page, 'Selection');
    await page.getByRole('checkbox', { name: 'Footprints', exact: true }).uncheck();
    await toggleLayoutVisualization(page, 'Selection');
  };
  try {
    await check({
      page,
      canvas,
      menu,
      screen,
      point,
      drag,
      selected,
      snapshot,
      clean,
      captureDetail,
      disableFootprints,
    });
    assert.deepEqual(errors, [], `${name}: no renderer errors.`);
    console.log(`Layout picking: ${name}.`);
  } finally {
    await page.close();
  }
}

try {
  await run(
    'pointer position directly chooses footprint body or underlying track without a menu',
    async ({ point, menu, selected, clean, canvas }) => {
      await point({ x: 30, y: 26.2 }, true);
      assert.deepEqual(await selected(), ['A1']);
      await point(overlap, true);
      assert.equal(await menu.count(), 0);
      assert.deepEqual(await selected(), ['underlying-track']);
      await point({ x: 30, y: 26.2 }, true);
      assert.deepEqual(await selected(), ['A1']);
      assert.equal(await canvas.evaluate((svg) => document.activeElement === svg), true);
      await clean();
    },
  );
  const adjacent = structuredClone(board);
  adjacent.tracks.push({
    ...adjacent.tracks[0],
    id: 'adjacent-track',
    start: { x: 20, y: 25.6 },
    end: { x: 40, y: 25.6 },
  });
  await run(
    'adjacent tracks are resolved from pointer location independently of prior selection',
    async ({ point, menu, selected, clean }) => {
      for (const [p, id] of [
        [{ x: 25, y: 25.05 }, 'underlying-track'],
        [{ x: 25, y: 25.55 }, 'adjacent-track'],
        [{ x: 25, y: 25.05 }, 'underlying-track'],
      ]) {
        await point(p, true);
        assert.equal(await menu.count(), 0);
        assert.deepEqual(await selected(), [id]);
      }
      await clean();
    },
    adjacent,
  );
  await run(
    'directly selected track dragging uses connected drag and one undo edit',
    async ({ page, canvas, point, drag, selected, snapshot, clean, menu }) => {
      await point(overlap, true);
      assert.deepEqual(await selected(), ['underlying-track']);
      await drag(overlap, { x: 31, y: 29 });
      const preview = canvas.locator('[data-track-drag-preview]');
      await preview.waitFor({ state: 'attached' });
      assert.equal(await menu.count(), 0);
      assert.equal(await preview.getAttribute('data-track-drag-mode'), 'connected');
      assert.equal(await preview.getAttribute('data-track-drag-blocked'), 'false');
      await clean();
      await page.mouse.up();
      const result = await snapshot();
      assert.equal(result.commits, 1);
      assert.deepEqual(result.board.tracks[0].start, { x: 20, y: 29 });
      assert.deepEqual(result.board.tracks[0].end, { x: 40, y: 29 });
      assert.deepEqual(result.board.footprints, board.footprints);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      assert.deepEqual((await snapshot()).board, board);
      assert.equal(
        await page.getByRole('button', { name: 'Undo', exact: true }).isEnabled(),
        false,
      );
    },
  );
  await run(
    'disabled footprints pass ordinary clicks and hover shortcuts through to copper',
    async ({ canvas, point, selected, clean, disableFootprints, menu }) => {
      await disableFootprints();
      await point(overlap, true);
      assert.deepEqual(await selected(), ['underlying-track']);
      await canvas.press('Escape');
      await point(overlap);
      await canvas.press('m');
      assert.deepEqual(await selected(), ['underlying-track']);
      assert.equal(await menu.count(), 0);
      await point({ x: 33, y: 27 });
      await canvas.press('Escape');
      await canvas.press('Escape');
      await point(overlap);
      await canvas.press('d');
      await canvas.locator('[data-track-drag-preview]').waitFor({ state: 'attached' });
      assert.deepEqual(await selected(), ['underlying-track']);
      assert.equal(await menu.count(), 0);
      await canvas.press('Escape');
      await clean();
    },
  );
  await run(
    'Escape cancels pointer track drag and late release cannot commit it',
    async ({ page, canvas, point, drag, selected, clean, menu }) => {
      await point(overlap, true);
      await drag(overlap, { x: 31, y: 29 });
      await canvas.locator('[data-track-drag-preview]').waitFor({ state: 'attached' });
      await canvas.press('Escape');
      await page.mouse.up();
      assert.equal(await menu.count(), 0);
      assert.equal(await canvas.locator('[data-track-drag-preview]').count(), 0);
      assert.deepEqual(await selected(), ['underlying-track']);
      await clean();
    },
  );
  for (const [key, mode] of [
    ['d', 'connected'],
    ['g', 'corner'],
  ]) {
    await run(
      'hover ' + key.toUpperCase() + ' reaches underlying tracks without a menu',
      async ({ canvas, point, selected, clean, menu }) => {
        await point(overlap);
        await canvas.focus();
        await canvas.press(key);
        const preview = canvas.locator('[data-track-drag-preview]');
        await preview.waitFor({ state: 'attached' });
        assert.equal(await preview.getAttribute('data-track-drag-mode'), mode);
        assert.equal(await menu.count(), 0);
        assert.deepEqual(await selected(), ['underlying-track']);
        await canvas.press('Escape');
        await clean();
      },
    );
    const crossed = structuredClone(board);
    crossed.tracks.push({
      ...crossed.tracks[0],
      id: 'crossing-track',
      layer: 'B.Cu',
      start: { x: 31, y: 20 },
      end: { x: 31, y: 30 },
    });
    await run(
      'hover ' + key.toUpperCase() + ' uses the nearer crossing track',
      async ({ canvas, point, selected, menu, clean }) => {
        await point({ x: 31, y: 24.3 });
        await canvas.focus();
        await canvas.press(key);
        const preview = canvas.locator('[data-track-drag-preview]');
        await preview.waitFor({ state: 'attached' });
        assert.equal(await preview.getAttribute('data-track-drag-mode'), mode);
        assert.equal(await menu.count(), 0);
        assert.deepEqual(await selected(), ['crossing-track']);
        await canvas.press('Escape');
        await clean();
      },
      crossed,
    );
  }
  await run(
    'direct picks retain add toggle subtract and Escape semantics',
    async ({ canvas, point, selected, clean, menu }) => {
      await point({ x: 55, y: 26.2 }, true);
      for (const [modifiers, expected] of [
        [['Shift'], ['B2', 'underlying-track']],
        [['Control'], ['B2']],
        [['Control'], ['B2', 'underlying-track']],
        [['Control', 'Shift'], ['B2']],
      ]) {
        await point(overlap, true, modifiers);
        assert.equal(await menu.count(), 0);
        assert.deepEqual(await selected(), expected);
      }
      await canvas.press('Escape');
      assert.deepEqual(await selected(), []);
      await clean();
    },
  );
  await run(
    'Alt also picks directly and saved copper fills remain fallback targets',
    async ({ point, menu, selected, clean }) => {
      await point({ x: 25, y: 25 }, true, ['Alt']);
      assert.equal(await menu.count(), 0);
      assert.deepEqual(await selected(), ['underlying-track']);
      await point({ x: 15, y: 15 }, true);
      assert.equal(await menu.count(), 0);
      assert.deepEqual(await selected(), ['pour']);
      await clean();
    },
  );

  await run(
    'an ordinary click collapses a group to the object under the pointer without editing',
    async ({ point, menu, selected, clean }) => {
      await point({ x: 55, y: 26.2 }, true);
      await point(overlap, true, ['Shift']);
      assert.deepEqual(await selected(), ['B2', 'underlying-track']);
      await point(overlap, true);
      assert.equal(await menu.count(), 0);
      assert.deepEqual(await selected(), ['underlying-track']);
      await clean();
    },
  );

  await run(
    'dragging a selected group preserves its members and commits one undoable translation',
    async ({ page, point, drag, selected, snapshot, menu }) => {
      await point({ x: 55, y: 26.2 }, true);
      await point(overlap, true, ['Shift']);
      await drag({ x: 55, y: 26.2 }, { x: 57, y: 28.2 });
      assert.equal(await menu.count(), 0);
      assert.deepEqual(await selected(), ['B2', 'underlying-track']);
      await page.mouse.up();
      const result = await snapshot();
      assert.equal(result.commits, 1);
      assert.equal(result.board.footprints[1].x, 57);
      assert.equal(result.board.footprints[1].y, 27);
      assert.deepEqual(result.board.footprints[0], board.footprints[0]);
      assert.deepEqual(result.board.tracks[0].start, { x: 22, y: 27 });
      assert.deepEqual(result.board.tracks[0].end, { x: 42, y: 27 });
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      assert.deepEqual((await snapshot()).board, board);
      assert.equal(
        await page.getByRole('button', { name: 'Undo', exact: true }).isEnabled(),
        false,
      );
    },
  );
  await run(
    'pad inspection is direct and disabling pads restores owner selection',
    async ({ page, canvas, point, menu, selected, clean }) => {
      await toggleLayoutVisualization(page, 'Selection');
      await page
        .getByRole('group', { name: 'Selection', exact: true })
        .getByRole('checkbox', { name: 'Pads', exact: true })
        .check();
      await toggleLayoutVisualization(page, 'Selection');
      await point({ x: 28.6, y: 23.6 }, true);
      assert.equal(await menu.count(), 0);
      assert.deepEqual(await selected(), []);
      assert.equal(await page.evaluate(() => window.layoutContext().inspectedPadId), 'A1-pad');
      await canvas.press('Escape');
      await toggleLayoutVisualization(page, 'Selection');
      await page
        .getByRole('group', { name: 'Selection', exact: true })
        .getByRole('checkbox', { name: 'Pads', exact: true })
        .uncheck();
      await toggleLayoutVisualization(page, 'Selection');
      await point({ x: 28.6, y: 23.6 }, true);
      assert.deepEqual(await selected(), ['A1']);
      assert.equal(await menu.count(), 0);
      await clean();
    },
  );
  for (const [name, from, to, expected] of [
    ['footprint', { x: 30.249, y: 26.2 }, { x: 30.251, y: 26.2 }, 'A1'],
    ['track', { x: 25, y: 25.249 }, { x: 25, y: 25.251 }, 'underlying-track'],
    ['via', { x: 55.249, y: 35 }, { x: 55.251, y: 35 }, 'via'],
  ]) {
    await run(
      'subpixel ' + name + ' jitter across a grid boundary never moves geometry',
      async ({ page, point, screen, selected, clean, menu }) => {
        await point(from);
        await page.mouse.down();
        const end = await screen(to);
        await page.mouse.move(end.x, end.y);
        await page.mouse.up();
        assert.equal(await menu.count(), 0);
        assert.deepEqual(await selected(), [expected]);
        await clean();
      },
    );
  }
  await run(
    'empty canvas rectangle selection remains available',
    async ({ page, drag, selected, clean, canvas }) => {
      await drag({ x: 52, y: 20 }, { x: 58, y: 28 });
      assert.equal(await canvas.locator('[data-selection-box="window"]').count(), 1);
      await page.mouse.up();
      assert.deepEqual(await selected(), ['B2']);
      await clean();
    },
  );

  const emc = parseProject(await readFile('lib/emc-flyback-example.json', 'utf8'));
  emc.pcb = parseKiCadPCB(
    await readFile('tests/fixtures/emc-track-drag-kicad10-source.kicad_pcb', 'utf8'),
    emc.schematic,
    'emc-flyback-demo',
  ).board;
  const mechanical = emc.pcb.footprints.find((footprint) => footprint.reference === 'MECH1');
  const actualTrack = emc.pcb.tracks.find(
    (track) =>
      Math.hypot(track.start.x - 64.8625, track.start.y - 53.8) < 0.00001 &&
      Math.hypot(track.end.x - 61, track.end.y - 57.6625) < 0.00001,
  );
  assert.ok(
    mechanical && actualTrack,
    'The pinned EMC fixture retains the mechanical owner and trace.',
  );
  await run(
    'real EMC copper remains directly selectable beneath the selected MECH1 enclosure footprint',
    async ({ point, selected, menu, clean, captureDetail }) => {
      await point({ x: 44, y: 80 }, true);
      assert.deepEqual(await selected(), [mechanical.id]);
      await point({ x: 63, y: 55.6625 }, true);
      assert.equal(await menu.count(), 0);
      assert.deepEqual(await selected(), [actualTrack.id]);
      await clean();
      await captureDetail({ x: 63, y: 55.6625 }, 'test-results/layout-emc-direct-native-track.png');
      await clean();
    },
    emc.pcb,
    emc.schematic,
  );

  // This private regression fixture uses the user's reported moved shape on the
  // real EMC board. The pinned example's original copper is checked above.
  const movedShape = structuredClone(emc.pcb);
  movedShape.tracks = [
    { ...actualTrack, start: { x: 64.8625, y: 53.8 }, end: { x: 59.563, y: 53.8 } },
    {
      ...actualTrack,
      id: 'c179698b-7fe5-4f43-a297-c0b299295cec',
      start: { x: 59.563, y: 53.8 },
      end: { x: 58.35, y: 55.013 },
    },
  ];
  await run(
    'EMC moved-shape fixture resolves both trace legs directly despite the MECH1 body target',
    async ({ point, selected, menu, clean, captureDetail }) => {
      for (const [position, track] of [
        [{ x: 62.2, y: 53.8 }, movedShape.tracks[0]],
        [{ x: 58.95, y: 54.413 }, movedShape.tracks[1]],
      ]) {
        await point({ x: 44, y: 80 }, true);
        assert.deepEqual(await selected(), [mechanical.id]);
        await point(position, true);
        assert.equal(await menu.count(), 0);
        assert.deepEqual(await selected(), [track.id]);
        await clean();
      }
      await captureDetail({ x: 61, y: 54 }, 'test-results/layout-emc-direct-moved-shape.png');
      await clean();
    },
    movedShape,
    emc.schematic,
  );
} finally {
  await browser.close();
}
