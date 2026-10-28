import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { emptyCircuit, uid } = await tsImport('../lib/circuit.ts', import.meta.url);
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const { createPCBRouter } = await tsImport('../lib/pcb-routing.ts', import.meta.url);

// Isolated headless renderer with real pointer coordinates; no desktop instance or user files.
const bundle = await build({
  stdin: {
    contents: `import React,{useState,useRef} from 'react';import {createRoot} from 'react-dom/client';
      import LayoutEditor from './components/LayoutEditor';
      function Test(){const [board,setBoard]=useState(window.fixture.board);const [history,setHistory]=useState([]);
        const [active,setActive]=useState(true);window.setLayoutActive=setActive;
        const context=useRef(null);window.layoutContext=()=>context.current;
        return <LayoutEditor leftButtonDrag="drag-any" board={board} schematic={window.fixture.schematic} active={active} agentContextRef={context}
          onCommit={next=>{window.lastBoard=next;window.commits++;setHistory([...history,board]);setBoard(next);return true}}
          undoAction={<button aria-label="Undo" disabled={!history.length} onClick={()=>{const next=history.at(-1);window.lastBoard=next;setBoard(next);setHistory(history.slice(0,-1))}}>Undo</button>}
          annotations={[]} annotationSessionId="track-shove" onAnnotationsChange={()=>{}}/>}
      createRoot(document.getElementById('root')).render(<Test/>);`,
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
function fixture(fixed = false, chain = false) {
  const board = createEmptyPCB();
  const schematic = emptyCircuit();
  const ids = Object.fromEntries(
    ['out', 'ground', 'main', 'neighbour', 'island', 'left', 'right'].map((key) => [key, uid()]),
  );
  board.nets = [
    { id: ids.out, name: 'OUT' },
    { id: ids.ground, name: 'GND' },
  ];
  board.graphics = [
    {
      id: uid(),
      kind: 'polygon',
      layer: 'Edge.Cuts',
      width: 0.1,
      start: { x: 0, y: 0 },
      points: [
        { x: 75, y: 0 },
        { x: 75, y: 50 },
      ],
      end: { x: 0, y: 50 },
    },
  ];
  const track = (id, netId, start, end) => ({ id, netId, start, end, width: 0.4, layer: 'F.Cu' });
  board.tracks = [
    track(ids.main, ids.out, { x: 20, y: 20 }, { x: 40, y: 20 }),
    track(ids.neighbour, ids.ground, { x: 10, y: 24 }, { x: 50, y: 24 }),
    track(ids.island, ids.out, { x: 52, y: 35 }, { x: 60, y: 35 }),
  ];
  if (chain) {
    board.tracks[1].start = { x: 20, y: 24 };
    board.tracks[1].end = { x: 40, y: 24 };
    board.tracks.push(
      track(ids.left, ids.ground, { x: 10, y: 34 }, { x: 20, y: 24 }),
      track(ids.right, ids.ground, { x: 40, y: 24 }, { x: 50, y: 34 }),
    );
  }
  if (fixed)
    board.vias = [{ id: uid(), netId: ids.ground, x: 30, y: 24, diameter: 0.8, drill: 0.3 }];
  return { board, schematic, ids, pickup: { x: 30, y: 20 }, target: { x: 30, y: 24 } };
}
const geometry = (tracks) =>
  tracks
    .map(({ id, start, end, width }) => ({ id, start, end, width }))
    .sort((a, b) => a.id.localeCompare(b.id));
function verify(before, after, ids) {
  assert.notDeepEqual(
    after.tracks.find((track) => track.id === ids.neighbour),
    before.tracks[1],
  );
  assert.deepEqual(
    after.tracks.find((track) => track.id === ids.island),
    before.tracks[2],
  );
  assert.deepEqual(after.footprints, before.footprints);
  assert.deepEqual(after.vias, before.vias);
  assert.deepEqual(after.graphics, before.graphics);
  assert.deepEqual(after.nets, before.nets);
  assert.deepEqual(
    after.tracks.slice(0, before.tracks.length).map((track) => track.id),
    before.tracks.map((track) => track.id),
  );
  for (const track of after.tracks)
    assert.equal(
      createPCBRouter(after, {
        layer: track.layer,
        netId: track.netId,
        width: track.width,
        clearance: 0.25,
      }).validate([track.start, track.end]),
      '',
      'Every committed track keeps clearance.',
    );
}
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});
const casePattern = process.argv[2] ? new RegExp(process.argv[2]) : null;
async function run(name, input, check) {
  if (casePattern && !casePattern.test(name)) return;
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  await page.evaluate((value) => {
    window.fixture = value;
    window.lastBoard = value.board;
    window.commits = 0;
  }, input);
  for (const content of styles) await page.addStyleTag({ content });
  await page.addStyleTag({ content: 'html,body,#root,.layout-editor{height:100%;margin:0}' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const canvas = page.getByTestId('layout-canvas');
  await canvas.waitFor();
  await canvas.focus();
  const point = async (p, click = false) => {
    const at = await canvas.evaluate((svg, position) => {
      const screen = new DOMPoint(position.x, position.y).matrixTransform(svg.getScreenCTM());
      return { x: screen.x, y: screen.y };
    }, p);
    await page.mouse.move(at.x, at.y);
    if (click) await page.mouse.click(at.x, at.y);
  };
  const state = () => page.evaluate(() => ({ board: window.lastBoard, commits: window.commits }));
  const clean = async () => assert.deepEqual(await state(), { board: input.board, commits: 0 });
  const marker = canvas.locator('[data-track-drag-preview]').first();
  const preview = async () =>
    geometry(
      await canvas.evaluate((svg) =>
        [...svg.querySelectorAll('[data-selection-id][data-net-id]')].flatMap((group) => {
          const line = [...group.querySelectorAll('line')].at(-1);
          return line
            ? [
                {
                  id: group.getAttribute('data-selection-id'),
                  start: { x: Number(line.getAttribute('x1')), y: Number(line.getAttribute('y1')) },
                  end: { x: Number(line.getAttribute('x2')), y: Number(line.getAttribute('y2')) },
                  width: Number(line.getAttribute('stroke-width')),
                },
              ]
            : [];
        }),
      ),
    );
  const start = async () => {
    await point(input.pickup);
    await canvas.press('d');
    await marker.waitFor({ state: 'attached' });
  };
  try {
    await check({ ...input, page, canvas, point, state, clean, marker, preview, start });
    assert.deepEqual(errors, [], `${name}: no renderer errors.`);
    console.log(`Layout track shove: ${name}.`);
  } finally {
    await page.close();
  }
}
try {
  await run(
    'D previews neighbouring copper and commits that exact shove once with undo',
    fixture(),
    async (input) => {
      const { board, ids, page, canvas, point, state, clean, marker, preview, start, target } =
        input;
      await start();
      await point(target);
      await clean();
      assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
      const displayed = await preview();
      assert.notDeepEqual(
        displayed.find((track) => track.id === ids.neighbour),
        geometry(board.tracks).find((track) => track.id === ids.neighbour),
      );
      await canvas.press('Enter');
      const result = await state();
      assert.equal(result.commits, 1);
      assert.deepEqual(geometry(result.board.tracks), displayed);
      verify(board, result.board, ids);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      assert.deepEqual((await state()).board, board);
    },
  );
  await run(
    'D shoves an equal-span neighbouring trace and both attached bends in the same preview',
    fixture(false, true),
    async ({ board, ids, canvas, point, state, clean, marker, preview, start, target }) => {
      await start();
      await point(target);
      await clean();
      assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
      const displayed = await preview();
      await canvas.press('Enter');
      const result = await state();
      assert.equal(result.commits, 1);
      assert.deepEqual(geometry(result.board.tracks), displayed);
      verify(board, result.board, ids);
    },
  );
  const floating = fixture();
  floating.board.tracks[1].start = { x: 25, y: 24 };
  floating.board.tracks[1].end = { x: 35, y: 24 };
  await run(
    'D pushes a shorter floating neighbour ahead while preserving its identity',
    floating,
    async ({ board, ids, canvas, point, state, clean, marker, preview, start, target }) => {
      await start();
      await point(target);
      await clean();
      assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
      const displayed = await preview();
      await canvas.press('Enter');
      const result = await state();
      assert.equal(result.commits, 1);
      assert.deepEqual(geometry(result.board.tracks), displayed);
      verify(board, result.board, ids);
      const neighbour = result.board.tracks.find((track) => track.id === ids.neighbour);
      assert.ok(neighbour.start.y >= 24.65 && neighbour.end.y >= 24.65);
    },
  );
  await run(
    'a fixed via stops shove at checked clearance and places that exact boundary once',
    fixture(true),
    async ({ board, page, canvas, point, state, clean, marker, preview, start, target }) => {
      await start();
      await point(target);
      assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
      assert.equal(await marker.getAttribute('data-track-drag-constrained'), 'true');
      const displayed = await preview();
      const moved = displayed.find((track) => track.id === board.tracks[0].id);
      assert.ok(moved.start.y > 20 && moved.start.y <= 23.148);
      await clean();
      await canvas.press('Enter');
      assert.equal((await state()).commits, 1);
      assert.deepEqual(geometry((await state()).board.tracks), displayed);
      assert.deepEqual((await state()).board.vias, board.vias);
      assert.equal(await marker.count(), 0);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      assert.deepEqual((await state()).board, board);
    },
  );
  await run(
    'pointer drag shoves tracks on release and commits its displayed preview once',
    fixture(),
    async ({ board, ids, page, point, state, clean, marker, preview, pickup, target }) => {
      await point(pickup);
      await page.mouse.down();
      await point(target);
      await marker.waitFor({ state: 'attached' });
      await clean();
      assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
      const displayed = await preview();
      await page.mouse.up();
      const result = await state();
      assert.equal(result.commits, 1);
      assert.deepEqual(geometry(result.board.tracks), displayed);
      verify(board, result.board, ids);
    },
  );
  await run(
    'constrained pointer release commits its current boundary instead of an earlier valid preview',
    fixture(true),
    async ({ page, canvas, point, state, marker, preview, pickup, target }) => {
      await point(pickup);
      await page.mouse.down();
      await point({ x: pickup.x, y: 22 });
      await marker.waitFor({ state: 'attached' });
      assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
      const earlier = await preview();
      await point(target);
      assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
      assert.equal(await marker.getAttribute('data-track-drag-constrained'), 'true');
      const displayed = await preview();
      assert.notDeepEqual(displayed, earlier);
      await page.mouse.up();
      assert.equal(await marker.count(), 0);
      assert.equal((await state()).commits, 1);
      assert.deepEqual(geometry((await state()).board.tracks), displayed);
      await canvas.press('Enter');
      assert.equal((await state()).commits, 1);
    },
  );
  const leap = fixture(true);
  leap.board.tracks = leap.board.tracks.filter((track) => track.id !== leap.ids.neighbour);
  leap.target = { x: 30, y: 28 };
  await run(
    'a large pointer step cannot leap across a fixed via to a clear final track position',
    leap,
    async ({ board, ids, page, canvas, point, state, marker, preview, pickup, target }) => {
      await point(pickup);
      await page.mouse.down();
      await point(target);
      await marker.waitFor({ state: 'attached' });
      assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
      assert.equal(await marker.getAttribute('data-track-drag-constrained'), 'true');
      const displayed = await preview();
      const moved = displayed.find((track) => track.id === ids.main);
      assert.ok(moved.start.y > pickup.y && moved.start.y <= 23.148);
      await page.mouse.up();
      await canvas.press('Enter');
      assert.equal((await state()).commits, 1);
      assert.deepEqual(geometry((await state()).board.tracks), displayed);
      assert.deepEqual((await state()).board.vias, board.vias);
    },
  );
  for (const kind of ['keyboard', 'pointer'])
    await run(
      `${kind} shove cancellation preserves all tracks without writes`,
      fixture(),
      async ({ page, canvas, point, clean, marker, start, pickup, target }) => {
        if (kind === 'keyboard') await start();
        else {
          await point(pickup);
          await page.mouse.down();
        }
        await point(target);
        await marker.waitFor({ state: 'attached' });
        await canvas.press('Escape');
        if (kind === 'pointer') await page.mouse.up();
        assert.equal(await marker.count(), 0);
        await canvas.press('Enter');
        await clean();
      },
    );
  for (const kind of ['lost pointer capture', 'project deactivation'])
    await run(
      `${kind} cancels a pointer shove without writes`,
      fixture(),
      async ({ page, canvas, point, clean, marker, pickup, target }) => {
        await canvas.evaluate((svg) =>
          svg.addEventListener(
            'pointerdown',
            (event) => {
              window.pointerId = event.pointerId;
            },
            { once: true },
          ),
        );
        await point(pickup);
        await page.mouse.down();
        await point(target);
        await marker.waitFor({ state: 'attached' });
        if (kind === 'lost pointer capture') {
          await canvas.evaluate((svg) => svg.releasePointerCapture(window.pointerId));
          await point({ x: target.x + 1, y: target.y });
        } else {
          await page.evaluate(() => window.setLayoutActive(false));
          await marker.waitFor({ state: 'detached' });
          await page.evaluate(() => window.setLayoutActive(true));
        }
        await marker.waitFor({ state: 'detached' });
        await page.mouse.up();
        await canvas.press('Enter');
        await clean();
      },
    );
  await run(
    'M keeps independent movement while ordinary direct dragging uses shove',
    fixture(),
    async ({ board, ids, canvas, point, state, pickup, target }) => {
      await point(pickup);
      await canvas.press('m');
      await point(target);
      await canvas.press('Enter');
      const result = await state();
      assert.equal(result.commits, 1);
      assert.deepEqual(
        result.board.tracks.find((track) => track.id === ids.neighbour),
        board.tracks[1],
      );
      assert.equal(result.board.tracks[0].start.y, target.y);
    },
  );
} finally {
  await browser.close();
}
