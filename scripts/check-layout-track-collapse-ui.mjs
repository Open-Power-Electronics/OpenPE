import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { emptyCircuit, uid } = await tsImport('../lib/circuit.ts', import.meta.url);
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);

// Real pointer/keyboard events in an isolated renderer; no native or user files.
const bundle = await build({
  stdin: {
    contents: `import React,{useRef,useState} from 'react';import {createRoot} from 'react-dom/client';
      import LayoutEditor from './components/LayoutEditor';
      function Test(){const [board,setBoard]=useState(window.fixture.board);const [history,setHistory]=useState([]);
        const context=useRef(null);
        return <LayoutEditor leftButtonDrag="drag-any" board={board} schematic={window.fixture.schematic} active agentContextRef={context}
          onCommit={next=>{window.lastBoard=next;window.commits++;setHistory([...history,board]);setBoard(next);return true}}
          undoAction={<button aria-label="Undo" disabled={!history.length} onClick={()=>{const next=history.at(-1);window.lastBoard=next;setBoard(next);setHistory(history.slice(0,-1))}}>Undo</button>}
          annotations={[]} annotationSessionId="track-collapse" onAnnotationsChange={()=>{}}/>}
      createRoot(document.getElementById('root')).render(<Test/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});

function fixture(kind = 'simple') {
  const board = createEmptyPCB();
  const ids = Object.fromEntries(
    ['out', 'gnd', 'short', 'selected', 'right', 'foreign'].map((name) => [name, uid()]),
  );
  board.nets = [
    { id: ids.out, name: 'OUT' },
    { id: ids.gnd, name: 'GND' },
  ];
  const points = [
    { x: 20, y: 16 },
    { x: 24, y: 20 },
    { x: 28, y: 20 },
    { x: 28, y: 28 },
  ];
  board.tracks = ['short', 'selected', 'right'].map((name, index) => ({
    id: ids[name],
    start: points[index],
    end: points[index + 1],
    width: 0.4,
    layer: 'F.Cu',
    netId: ids.out,
  }));
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
  if (kind === 'locked-selected') board.tracks[1].locked = true;
  if (kind === 'locked-neighbour') board.tracks[0].locked = true;
  if (kind === 'locked-foreign')
    board.tracks.push({
      id: ids.foreign,
      start: { x: 22, y: 16 },
      end: { x: 30, y: 16 },
      width: 0.4,
      layer: 'F.Cu',
      netId: ids.gnd,
      locked: true,
    });
  return {
    board,
    schematic: emptyCircuit(),
    ids,
    pickup: { x: 26, y: 20 },
    target: { x: 26, y: 16 },
  };
}

const geometry = (tracks) =>
  tracks
    .map(({ id, start, end, width }) => ({ id, start, end, width }))
    .sort((a, b) => a.id.localeCompare(b.id));
const styles = await Promise.all(
  ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'].map((path) =>
    readFile(path, 'utf8'),
  ),
);
await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});

async function run(name, input, check) {
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
  const point = async (position, click = false) => {
    const at = await canvas.evaluate((svg, p) => {
      const screen = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
      return { x: screen.x, y: screen.y };
    }, position);
    await page.mouse.move(at.x, at.y);
    if (click) await page.mouse.click(at.x, at.y);
  };
  const state = () => page.evaluate(() => ({ board: window.lastBoard, commits: window.commits }));
  const marker = canvas.locator('[data-track-drag-preview]');
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
  const clean = async () => assert.deepEqual(await state(), { board: input.board, commits: 0 });
  const start = async () => {
    await point(input.pickup);
    await canvas.press('d');
    await marker.waitFor({ state: 'attached' });
  };
  try {
    await check({ ...input, page, canvas, point, state, marker, preview, clean, start });
    assert.deepEqual(errors, [], `${name}: no renderer errors.`);
    console.log(`Layout track collapse: ${name}.`);
  } finally {
    await page.close();
  }
}

try {
  for (const pointer of [false, true]) {
    const input = fixture();
    await run(
      `${pointer ? 'Pointer' : 'D'} contracts a short neighbour with exact preview, one commit and undo`,
      input,
      async ({
        page,
        canvas,
        point,
        state,
        marker,
        preview,
        clean,
        start,
        ids,
        target,
        pickup,
        board,
      }) => {
        if (pointer) {
          await point(pickup);
          await page.mouse.down();
        } else await start();
        await point(target);
        await marker.waitFor({ state: 'attached' });
        assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
        await clean();
        const displayed = await preview();
        assert.equal(displayed.length, 2);
        assert.equal(
          displayed.some((track) => track.id === ids.short),
          false,
        );
        assert.deepEqual(
          displayed.find((track) => track.id === ids.selected),
          { id: ids.selected, start: { x: 20, y: 16 }, end: { x: 28, y: 16 }, width: 0.4 },
        );
        if (pointer) await page.mouse.up();
        else await canvas.press('Enter');
        const after = await state();
        assert.equal(after.commits, 1);
        assert.deepEqual(geometry(after.board.tracks), displayed);
        await page.getByRole('button', { name: 'Undo', exact: true }).click();
        assert.deepEqual((await state()).board, board);
      },
    );
  }

  await run(
    'reverse cursor holds the checked contraction boundary and Escape cancels without writes',
    fixture(),
    async ({ canvas, point, marker, preview, clean, start, target }) => {
      await start();
      await point(target);
      assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
      const boundary = await preview();
      await point({ ...target, y: 15 });
      assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
      assert.equal(await marker.getAttribute('data-track-drag-constrained'), 'true');
      assert.deepEqual(await preview(), boundary);
      await clean();
      await canvas.press('Escape');
      assert.equal(await marker.count(), 0);
      await clean();
    },
  );

  await run(
    'locked selected track rejects D placement without a commit',
    fixture('locked-selected'),
    async ({ canvas, point, marker, pickup, clean }) => {
      await point(pickup);
      await canvas.press('d');
      if (await marker.count()) {
        assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'true');
        await canvas.press('Enter');
        await canvas.press('Escape');
      }
      await clean();
    },
  );

  await run(
    'locked same-net neighbour is retained by its checked reconnect',
    fixture('locked-neighbour'),
    async ({ canvas, point, state, marker, start, target, ids, board }) => {
      await start();
      await point(target);
      assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
      await canvas.press('Enter');
      const after = await state();
      assert.equal(after.commits, 1);
      assert.deepEqual(
        after.board.tracks.find((track) => track.id === ids.short),
        board.tracks[0],
      );
      assert.ok(after.board.tracks.length > 3);
    },
  );

  await run(
    'locked foreign copper stops shove before contraction and remains fixed',
    fixture('locked-foreign'),
    async ({ page, canvas, point, marker, preview, state, clean, start, target, ids, board }) => {
      await start();
      await point({ ...target, y: 17 });
      assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
      await point(target);
      assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
      assert.equal(await marker.getAttribute('data-track-drag-constrained'), 'true');
      await clean();
      const displayed = await preview();
      await canvas.press('Enter');
      const after = await state();
      assert.equal(after.commits, 1);
      assert.deepEqual(geometry(after.board.tracks), displayed);
      assert.deepEqual(
        after.board.tracks.find((track) => track.id === ids.foreign),
        board.tracks.find((track) => track.id === ids.foreign),
      );
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      assert.deepEqual((await state()).board, board);
    },
  );
} finally {
  await browser.close();
}
