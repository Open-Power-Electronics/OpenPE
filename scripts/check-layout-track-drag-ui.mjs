import {
  closeDisplayDrawer,
  openDisplayDrawer,
  toggleLayoutVisualization,
} from './visualization-test-helpers.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { tsImport } from 'tsx/esm/api';

const { emptyCircuit, createPart, uid } = await tsImport('../lib/circuit.ts', import.meta.url);
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const { analyzePCBConnectivity } = await tsImport('../lib/pcb-connectivity.ts', import.meta.url);
const { createProject, parseProject, serializeProject } = await tsImport(
  '../lib/project.ts',
  import.meta.url,
);
const { serializePCB } = await tsImport('../lib/pcb.ts', import.meta.url);
const { parseSExpr, children, child, val, num } = await tsImport(
  '../lib/sexpr.ts',
  import.meta.url,
);

// Isolated SVG renderer and real coordinate pointer events; no Electron, providers or user files.
const bundle = await build({
  stdin: {
    contents: `import React,{useState,useRef} from 'react';import {createRoot} from 'react-dom/client';
      import LayoutEditor from './components/LayoutEditor';
      function Test(){const [board,setBoard]=useState(window.fixture.board);const [history,setHistory]=useState([]);
        const [active,setActive]=useState(true);const context=useRef(null);
        window.layoutContext=()=>context.current;
        window.replaceBoard=next=>{window.lastBoard=next;setBoard(next)};window.setLayoutActive=setActive;
        return <LayoutEditor leftButtonDrag="drag-any" board={board} schematic={window.fixture.schematic} active={active} agentContextRef={context}
          onCommit={next=>{if(window.rejectCommit)return false;window.lastBoard=next;window.commits++;setHistory([...history,board]);setBoard(next);return true}}
          undoAction={<button aria-label="Undo" disabled={!history.length} onClick={()=>{const next=history.at(-1);window.lastBoard=next;setBoard(next);setHistory(history.slice(0,-1))}}>Undo</button>}
          annotations={[]} annotationSessionId="track-drag" onAnnotationsChange={()=>{}}/>}
      createRoot(document.getElementById('root')).render(<Test/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});

function fixture(kind = 'horizontal') {
  const board = createEmptyPCB();
  const schematic = emptyCircuit();
  const ids = Object.fromEntries(
    [
      'out',
      'gnd',
      'left',
      'main',
      'right',
      'next',
      'branch',
      'foreign',
      'island',
      'viaForeign',
      'viaBranch',
      'viaEnd',
    ].map((name) => [name, uid()]),
  );
  board.nets = [
    { id: ids.out, name: 'OUT' },
    { id: ids.gnd, name: 'GND' },
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
  let points = [
    { x: 20, y: 10 },
    { x: 20, y: 20 },
    { x: 40, y: 20 },
    { x: 40, y: 10 },
  ];
  let names = ['left', 'main', 'right'];
  let pickup = { x: 30, y: 20 },
    target = { x: 33, y: 24.2 };
  if (kind === 'vertical') {
    points = [
      { x: 10, y: 20 },
      { x: 20, y: 20 },
      { x: 20, y: 40 },
      { x: 10, y: 40 },
    ];
    pickup = { x: 20, y: 30 };
    target = { x: 24.2, y: 33 };
  } else if (kind === 'diagonal') {
    points = [
      { x: 10, y: 20 },
      { x: 20, y: 20 },
      { x: 30, y: 30 },
      { x: 30, y: 40 },
    ];
    pickup = { x: 25, y: 25 };
    target = { x: 25, y: 29 };
  } else if (kind === 'group') {
    points = [
      { x: 15, y: 20 },
      { x: 25, y: 20 },
      { x: 35, y: 20 },
      { x: 35, y: 30 },
      { x: 45, y: 30 },
    ];
    names = ['left', 'main', 'next', 'right'];
    pickup = { x: 35, y: 25 };
    target = { x: 38, y: 29 };
  } else if (kind === 'anchors') {
    pickup = { x: 25, y: 20 };
    target = { x: 25, y: 16 };
  } else if (kind === 'pad-end') {
    points = [
      { x: 20, y: 20 },
      { x: 40, y: 20 },
      { x: 50, y: 10 },
    ];
    names = ['main', 'right'];
    target = { x: 30, y: 24 };
  }
  board.footprints = [points[0], points.at(-1)].map((at, i) => {
    const part = createPart(schematic, 'Port', i * 12.7, 0);
    schematic.parts.push(part);
    return {
      id: uid(),
      symbolId: part.id,
      libraryId: 'Test:DragAnchor',
      ...at,
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
          type: 'smd',
          shape: 'rect',
          size: { x: 1, y: 1 },
          netId: ids.out,
          layers: ['F.Cu'],
        },
      ],
    };
  });
  const track = (name, start, end, netId = ids.out) => ({
    id: ids[name],
    start,
    end,
    width: 0.4,
    layer: 'F.Cu',
    netId,
  });
  board.tracks = names.map((name, i) => track(name, points[i], points[i + 1]));
  board.tracks.push(track('island', { x: 50, y: 30 }, { x: 60, y: 30 }));
  board.tracks.push(track('foreign', { x: 50, y: 35 }, { x: 60, y: 35 }, ids.gnd));
  board.vias = [{ id: ids.viaForeign, x: 55, y: 38, diameter: 1, drill: 0.4, netId: ids.gnd }];
  if (kind === 'anchors') {
    board.tracks.push(track('branch', { x: 30, y: 20 }, { x: 30, y: 30 }));
    board.vias.push(
      { id: ids.viaBranch, x: 30, y: 30, diameter: 1, drill: 0.4, netId: ids.out },
      { id: ids.viaEnd, x: 40, y: 20, diameter: 1, drill: 0.4, netId: ids.out },
    );
  }
  if (kind === 'blocked') {
    const obstacle = board.tracks.find((item) => item.id === ids.foreign);
    obstacle.start = { x: 18, y: 24 };
    obstacle.end = { x: 42, y: 24 };
    obstacle.locked = true;
  }
  if (kind === 'hidden') {
    board.footprints.push({
      id: uid(),
      symbolId: null,
      reference: 'TP3',
      libraryId: 'Test:HiddenObstacle',
      x: 30,
      y: 24,
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
          type: 'smd',
          shape: 'rect',
          size: { x: 3, y: 3 },
          netId: ids.gnd,
          layers: ['F.Cu'],
        },
      ],
    });
  }
  return { board, schematic, ids, pickup, target };
}

const geometry = (tracks) =>
  tracks
    .map(({ id, start, end, width }) => ({ id, start, end, width }))
    .sort((a, b) => a.id.localeCompare(b.id));
function verify(before, after, schematic, ids) {
  assert.deepEqual(
    after.footprints,
    before.footprints,
    'Pads and packages are fixed during track drag.',
  );
  assert.deepEqual(after.vias, before.vias, 'Existing via anchors remain fixed.');
  assert.deepEqual(after.graphics, before.graphics);
  assert.deepEqual(after.nets, before.nets);
  for (const name of ['foreign', 'island'])
    assert.deepEqual(
      after.tracks.find((track) => track.id === ids[name]),
      before.tracks.find((track) => track.id === ids[name]),
    );
  for (const original of before.tracks)
    assert.ok(
      after.tracks.some((track) => track.id === original.id),
      'Existing track UUIDs survive connected drag.',
    );
  assert.equal(new Set(after.tracks.map((track) => track.id)).size, after.tracks.length);
  for (const track of after.tracks) {
    assert.deepEqual(
      Object.keys(track.start).sort(),
      ['x', 'y'],
      'Track start stores only point coordinates.',
    );
    assert.deepEqual(
      Object.keys(track.end).sort(),
      ['x', 'y'],
      'Track end stores only point coordinates.',
    );
    const dx = Math.abs(track.end.x - track.start.x),
      dy = Math.abs(track.end.y - track.start.y);
    assert.ok(dx > 1e-8 || dy > 1e-8, 'No zero-length tracks are committed.');
    assert.ok(
      dx < 1e-8 || dy < 1e-8 || Math.abs(dx - dy) < 1e-7,
      'Connected drag retains H/V/45 geometry.',
    );
  }
  assert.equal(
    analyzePCBConnectivity(after).edges.filter((wire) => wire.netId === ids.out).length,
    analyzePCBConnectivity(before).edges.filter((wire) => wire.netId === ids.out).length,
    'Fixed pads, branches and vias retain their copper connectivity.',
  );
  const project = createProject(schematic);
  project.pcb = after;
  assert.deepEqual(parseProject(serializeProject(project)).pcb, after);
  const native = parseSExpr(serializePCB(after, schematic));
  const segments = children(native, 'segment');
  assert.equal(segments.length, after.tracks.length);
  for (const track of after.tracks) {
    const node = segments.find((item) => val(child(item, 'uuid')) === track.id);
    assert.ok(node);
    assert.deepEqual(
      { x: num(child(node, 'start')), y: num(child(node, 'start'), 2) },
      track.start,
    );
    assert.deepEqual({ x: num(child(node, 'end')), y: num(child(node, 'end'), 2) }, track.end);
    assert.equal(num(child(node, 'width')), track.width);
    assert.equal(val(child(node, 'layer')), track.layer);
    assert.equal(val(child(node, 'net')), after.nets.find((net) => net.id === track.netId).name);
  }
}

const styles = await Promise.all(
  ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'].map((file) =>
    readFile(file, 'utf8'),
  ),
);
await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});
const casePattern = process.argv[2] ? new RegExp(process.argv[2]) : null;
let matchedCases = 0;
async function run(name, input, check) {
  if (casePattern && !casePattern.test(name)) return;
  matchedCases++;
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
    window.rejectCommit = false;
    if (value.theme) {
      document.documentElement.dataset.theme = value.theme;
      if (value.theme === 'dark') document.documentElement.style.setProperty('--canvas', '#18222d');
    }
  }, input);
  for (const content of styles) await page.addStyleTag({ content });
  await page.addStyleTag({ content: 'html,body,#root,.layout-editor{height:100%;margin:0}' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const canvas = page.getByTestId('layout-canvas');
  await canvas.waitFor();
  await canvas.focus();
  const button = (label) => page.getByRole('button', { name: label, exact: true });
  const point = async (p, click = false, modifiers = []) => {
    const at = await canvas.evaluate((svg, position) => {
      const screen = new DOMPoint(position.x, position.y).matrixTransform(svg.getScreenCTM());
      return { x: screen.x, y: screen.y };
    }, p);
    await page.mouse.move(at.x, at.y);
    for (const modifier of modifiers) await page.keyboard.down(modifier);
    if (click) await page.mouse.click(at.x, at.y);
    for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
  };
  const state = () => page.evaluate(() => ({ board: window.lastBoard, commits: window.commits }));
  const context = () => page.evaluate(() => window.layoutContext());
  const clean = async (expected = input.board) =>
    assert.deepEqual(await state(), { board: expected, commits: 0 });
  const marker = canvas.locator('[data-track-drag-preview]').first();
  const preview = async () =>
    geometry(
      await canvas.evaluate((svg) =>
        [...svg.querySelectorAll('[data-selection-id][data-net-id]')].flatMap((group) => {
          const line = [...group.querySelectorAll('line')].at(-1);
          if (!line) return [];
          return [
            {
              id: group.getAttribute('data-selection-id'),
              start: { x: Number(line.getAttribute('x1')), y: Number(line.getAttribute('y1')) },
              end: { x: Number(line.getAttribute('x2')), y: Number(line.getAttribute('y2')) },
              width: Number(line.getAttribute('stroke-width')),
            },
          ];
        }),
      ),
    );
  const start = async () => {
    await point(input.pickup);
    await canvas.press('d');
    assert.equal(await marker.count(), 1);
    assert.equal(
      await page.locator('.layout-tool-settings').count(),
      0,
      'Track drag opens no floating card.',
    );
    await clean();
  };
  try {
    await check({
      ...input,
      page,
      canvas,
      button,
      point,
      state,
      clean,
      marker,
      preview,
      context,
      start,
    });
    assert.deepEqual(errors, [], `${name}: no renderer errors.`);
    console.log(`Layout track drag: ${name}.`);
  } finally {
    await page.close();
  }
}

try {
  {
    const input = fixture();
    await run(
      'mouse track drag uses connected mode and one undo without drag controls',
      input,
      async ({ board, ids, page, point, canvas, marker, state, button, context, clean }) => {
        await openDisplayDrawer(page, 'Selection');
        for (const name of ['Left button drag', 'Mouse drag track behavior', 'Drag obstacle mode'])
          assert.equal(await page.getByRole('combobox', { name, exact: true }).count(), 0);
        assert.equal(
          await page.getByRole('spinbutton', { name: 'Drag clearance (mm)', exact: true }).count(),
          0,
        );
        await closeDisplayDrawer(page, 'Selection');
        await clean();
        assert.equal((await context()).mouseDragTrackBehavior, 'connected');
        await point(input.pickup);
        await page.mouse.down();
        await point(input.target);
        assert.equal(await marker.getAttribute('data-track-drag-mode'), 'connected');
        await clean();
        await page.mouse.up();
        const result = await state();
        assert.equal(result.commits, 1);
        const moved = result.board.tracks.find((track) => track.id === ids.main);
        assert.deepEqual(moved.start, { x: 20, y: 24 });
        assert.deepEqual(moved.end, { x: 40, y: 24 });
        await button('Undo').click();
        assert.deepEqual((await state()).board, board);
        assert.equal((await context()).mouseDragTrackBehavior, 'connected');
        assert.equal(await canvas.locator('[data-track-drag-preview]').count(), 0);
      },
    );
  }

  for (const action of ['d', 'g']) {
    await run(
      `${action} arrow nudge is retained when the unmoved pointer clicks the displayed preview`,
      fixture(),
      async ({ pickup, page, canvas, point, state, clean, preview }) => {
        await point(pickup);
        await canvas.press(action);
        await canvas.press('ArrowDown');
        await clean();
        const displayed = await preview();
        await page.mouse.down();
        await page.mouse.up();
        const result = await state();
        assert.equal(result.commits, 1);
        assert.deepEqual(geometry(result.board.tracks), displayed);
      },
    );
  }

  await run(
    'explicit placement evaluates the current click instead of committing the previous pointer pose',
    fixture(),
    async ({ ids, canvas, point, state, clean, start }) => {
      await start();
      await point({ x: 30, y: 24 });
      await clean();
      // A pen or coalesced event can deliver a new click without a preceding
      // pointermove. The commit must evaluate that event's current coordinates.
      await canvas.evaluate((svg) => {
        const click = new DOMPoint(30, 27).matrixTransform(svg.getScreenCTM());
        svg.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true,
            button: 0,
            pointerId: 1,
            pointerType: 'mouse',
            clientX: click.x,
            clientY: click.y,
          }),
        );
        svg.dispatchEvent(
          new PointerEvent('pointerup', {
            bubbles: true,
            button: 0,
            pointerId: 1,
            pointerType: 'mouse',
            clientX: click.x,
            clientY: click.y,
          }),
        );
      });
      const result = await state();
      assert.equal(result.commits, 1);
      const moved = result.board.tracks.find((track) => track.id === ids.main);
      assert.equal(moved.start.y, 27);
      assert.equal(moved.end.y, 27);
    },
  );

  await run(
    'rejected explicit placement retries the actual click instead of the previous pointer pose',
    fixture(),
    async ({ ids, page, canvas, point, state, clean, marker, start }) => {
      await start();
      await point({ x: 30, y: 24 });
      await page.evaluate(() => {
        window.rejectCommit = true;
      });
      await canvas.evaluate((svg) => {
        const click = new DOMPoint(30, 27).matrixTransform(svg.getScreenCTM());
        for (const type of ['pointerdown', 'pointerup'])
          svg.dispatchEvent(
            new PointerEvent(type, {
              bubbles: true,
              button: 0,
              pointerId: 1,
              pointerType: 'mouse',
              clientX: click.x,
              clientY: click.y,
            }),
          );
      });
      await clean();
      assert.equal(await marker.count(), 1);
      await page.evaluate(() => {
        window.rejectCommit = false;
      });
      await canvas.press('Enter');
      const result = await state();
      assert.equal(result.commits, 1);
      const moved = result.board.tracks.find((track) => track.id === ids.main);
      assert.equal(moved.start.y, 27);
      assert.equal(moved.end.y, 27);
    },
  );

  for (const legacy of [false, true]) {
    await run(
      `canvas composition ${legacy ? '229' : 'isComposing'} retains drag and cannot commit`,
      fixture(),
      async ({ canvas, point, marker, preview, clean, start }) => {
        await start();
        await point({ x: 30, y: 24 });
        const before = await preview();
        for (const key of ['Enter', 'Escape', 'Delete', 'ArrowDown']) {
          await canvas.dispatchEvent('keydown', {
            key,
            bubbles: true,
            cancelable: true,
            isComposing: !legacy,
            keyCode: legacy ? 229 : 0,
          });
          assert.equal(await marker.count(), 1);
          assert.deepEqual(await preview(), before);
          await clean();
        }
        await canvas.press('Escape');
        assert.equal(await marker.count(), 0);
        await clean();
      },
    );
  }

  for (const kind of ['horizontal', 'vertical', 'diagonal']) {
    const input = fixture(kind);
    await run(
      `${kind} segment slides with connected preview, fixed pads and one atomic undo`,
      input,
      async ({
        board,
        schematic,
        ids,
        page,
        canvas,
        button,
        point,
        state,
        clean,
        marker,
        preview,
        start,
      }) => {
        await start();
        await point(input.target);
        await clean();
        assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
        const displayed = await preview();
        if (kind === 'horizontal')
          await page.screenshot({ path: 'test-results/layout-track-drag-light.png' });
        const moved = displayed.find((track) => track.id === ids.main);
        if (kind === 'horizontal')
          assert.deepEqual(
            { start: moved.start, end: moved.end },
            { start: { x: 20, y: 24 }, end: { x: 40, y: 24 } },
            'Parallel pointer movement does not shift a single horizontal segment.',
          );
        if (kind === 'vertical')
          assert.deepEqual(
            { start: moved.start, end: moved.end },
            { start: { x: 24, y: 20 }, end: { x: 24, y: 40 } },
          );
        if (kind === 'diagonal') {
          assert.deepEqual(
            { start: moved.start, end: moved.end },
            { start: { x: 16, y: 20 }, end: { x: 30, y: 34 } },
          );
          assert.equal(displayed.length, board.tracks.length, 'Sliding a bend adds no doglegs.');
        }
        await canvas.press('Enter');
        const result = await state();
        assert.equal(result.commits, 1);
        assert.deepEqual(
          geometry(result.board.tracks),
          displayed,
          'Commit uses exactly the displayed track geometry and UUIDs.',
        );
        verify(board, result.board, schematic, ids);
        await button('Undo').click();
        assert.deepEqual((await state()).board, board);
      },
    );
  }

  {
    const input = fixture('diagonal');
    await run(
      'mouse diagonal drag in Shove slides existing joints and commits the exact preview on release',
      input,
      async ({
        board,
        schematic,
        ids,
        page,
        canvas,
        point,
        state,
        clean,
        marker,
        preview,
        button,
      }) => {
        await point(input.pickup);
        await page.mouse.down();
        await point({ x: 27, y: 23 });
        await clean();
        assert.equal(
          await page.locator('.layout-tool-settings').count(),
          0,
          'Pointer track dragging opens no floating settings card.',
        );
        assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
        const displayed = await preview();
        const moved = displayed.find((track) => track.id === ids.main);
        assert.deepEqual(
          { start: moved.start, end: moved.end },
          { start: { x: 24, y: 20 }, end: { x: 30, y: 26 } },
        );
        assert.equal(displayed.length, board.tracks.length);
        const left = displayed.find((track) => track.id === ids.left);
        const right = displayed.find((track) => track.id === ids.right);
        assert.deepEqual(left.end, moved.start);
        assert.equal(left.start.y, left.end.y);
        assert.deepEqual(right.start, moved.end);
        assert.equal(right.start.x, right.end.x);
        await page.screenshot({ path: 'test-results/layout-diagonal-track-drag.png' });
        await page.mouse.up();
        const result = await state();
        assert.equal(result.commits, 1);
        assert.deepEqual(geometry(result.board.tracks), displayed);
        verify(board, result.board, schematic, ids);
        await button('Undo').click();
        assert.deepEqual((await state()).board, board);
      },
    );
  }

  const boostSources = JSON.parse(await readFile('lib/reference-examples.json', 'utf8'));
  const lm2596 = parseProject(boostSources['reference-lm2596-to220-5-buck']);
  for (const gesture of ['D', 'pointer'])
    await run(
      `LM2596 VIN ${gesture} drag keeps one C1 lead and opens no floating settings`,
      {
        board: lm2596.pcb,
        schematic: lm2596.schematic,
        pickup: { x: 39.425, y: 51.5 },
        target: { x: 37.425, y: 51.5 },
      },
      async ({ board, page, canvas, button, point, state, clean, marker, preview, target }) => {
        const selectedId = 'd2d0110b-b8f6-461a-b1eb-bb8be76afcf9';
        const leadId = '8e31c3be-7184-47e5-81e5-1f02058af19e';
        await point({ x: 39.425, y: 51.5 });
        if (gesture === 'pointer') await page.mouse.down();
        else await canvas.press('d');
        await point(target);
        await clean();
        assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
        assert.equal(await marker.getAttribute('data-track-drag-constrained'), 'false');
        assert.equal(await page.locator('.layout-tool-settings').count(), 0);
        const displayed = await preview();
        const moved = displayed.find((track) => track.id === selectedId);
        const lead = displayed.find((track) => track.id === leadId);
        assert.deepEqual(moved.end, { x: 37.425, y: 50.25 });
        assert.deepEqual(lead.start, moved.end);
        assert.deepEqual(lead.end, { x: 39.55, y: 48.125 });
        const sourceIds = new Set(board.tracks.map((track) => track.id));
        const reconnects = displayed.filter((track) => !sourceIds.has(track.id));
        assert.equal(reconnects.length, 1);
        assert.ok(
          reconnects.every((track) => Math.min(track.start.y, track.end.y) > 50),
          'C1 gains no duplicate stub; only the remote U1 terminal needs a reconnect.',
        );
        if (gesture === 'pointer') await page.mouse.up();
        else await canvas.press('Enter');
        const result = await state();
        assert.equal(result.commits, 1);
        assert.deepEqual(geometry(result.board.tracks), displayed);
        assert.deepEqual(result.board.footprints, board.footprints);
        await button('Undo').click();
        assert.deepEqual((await state()).board, board);
      },
    );

  for (const gesture of ['D', 'pointer'])
    await run(
      `LM2596 J2 ${gesture} drag holds the nearest checked boundary through illegal cursor moves`,
      {
        board: lm2596.pcb,
        schematic: lm2596.schematic,
        pickup: { x: 67.46, y: 66 },
      },
      async ({ board, page, canvas, point, state, clean, context, marker, preview, button }) => {
        const selectedId = '9f4c2ebf-c1e7-410f-91a6-9f955554ce4e';
        await point({ x: 67.46, y: 66 });
        if (gesture === 'pointer') await page.mouse.down();
        else await canvas.press('d');
        await point({ x: 65.46, y: 66 });
        assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
        let lastX = 65.46;
        for (const x of [63.46, 61.46]) {
          await point({ x, y: 66 });
          assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
          assert.equal(await marker.getAttribute('data-track-drag-constrained'), 'true');
          const displayed = await preview();
          const selected = displayed.find((track) => track.id === selectedId);
          assert.ok(
            selected.start.x <= lastX && selected.start.x > 65.14,
            'An increasingly illegal cursor cannot rebound toward the original x=67.46.',
          );
          lastX = selected.start.x;
          assert.ok((await context()).connectedTrackDrag.appliedDelta.x < -2);
          await clean();
        }
        const displayed = await preview();
        assert.equal(await page.locator('.layout-tool-settings').count(), 0);
        if (gesture === 'pointer') await page.mouse.up();
        else await canvas.press('Enter');
        assert.equal((await state()).commits, 1);
        assert.deepEqual(geometry((await state()).board.tracks), displayed);
        await button('Undo').click();
        assert.deepEqual((await state()).board, board);
      },
    );

  const emc = parseProject(await readFile('lib/emc-flyback-example.json', 'utf8'));
  const emcInput = {
    board: emc.pcb,
    schematic: emc.schematic,
    ids: {
      main: 'f5f58608-884a-4ddc-9afc-1ddfccfc586e',
      lead: '1d86d449-e059-45b0-ae66-5414983dc04d',
    },
    pickup: { x: 63, y: 55.6625 },
    target: { x: 61.5, y: 54 },
  };
  for (const gesture of ['D', 'pointer'])
    await run(
      `EMC J1 through-hole ${gesture} drag in Shove slides its annular lead without a V-shaped reconnect`,
      emcInput,
      async ({ board, ids, page, canvas, button, point, state, clean, marker, preview, start }) => {
        const original = board.tracks.find((track) => track.id === ids.main);
        const lead = board.tracks.find((track) => track.id === ids.lead);
        assert.ok(original && lead, 'The pinned EMC example retains the reported J1 trace.');
        assert.deepEqual(original.start, { x: 64.8625, y: 53.8 });
        assert.deepEqual(original.end, lead.start);
        assert.deepEqual(lead.end, { x: 61, y: 62.7 });
        const detail = await canvas.evaluate((svg) => {
          const screen = new DOMPoint(63, 57).matrixTransform(svg.getScreenCTM());
          return { x: screen.x, y: screen.y };
        });
        const bounds = await canvas.boundingBox();
        assert.ok(bounds);
        await page.mouse.move(detail.x, detail.y);
        await page.mouse.down({ button: 'right' });
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2, {
          steps: 4,
        });
        await page.mouse.up({ button: 'right' });
        for (let i = 0; i < 6; i++) {
          await page.mouse.wheel(0, -120);
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
        }
        await start();
        await point(emcInput.target);
        await clean();
        assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
        assert.equal(await marker.getAttribute('data-track-drag-constrained'), 'false');
        await canvas.press('Escape');
        await clean();
        assert.equal(await marker.count(), 0, 'Escape discards the complete EMC drag preview.');

        await point(emcInput.pickup);
        if (gesture === 'pointer') await page.mouse.down();
        else await canvas.press('d');
        await point(emcInput.target);
        await clean();
        assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
        assert.equal(await marker.getAttribute('data-track-drag-constrained'), 'false');
        const displayed = await preview();
        const moved = displayed.find((track) => track.id === ids.main);
        const stretched = displayed.find((track) => track.id === ids.lead);
        assert.deepEqual(moved, {
          id: ids.main,
          start: { x: 61.8625, y: 53.8 },
          end: { x: 61, y: 54.6625 },
          width: original.width,
        });
        assert.deepEqual(stretched, {
          id: ids.lead,
          start: moved.end,
          end: lead.end,
          width: lead.width,
        });
        const sourceIds = new Set(board.tracks.map((track) => track.id));
        const reconnects = displayed.filter((track) => !sourceIds.has(track.id));
        assert.equal(reconnects.length, 1, 'Only the fixed F1 end gains a reconnect.');
        assert.deepEqual(
          { ...reconnects[0], id: '' },
          { id: '', start: original.start, end: moved.start, width: original.width },
          'The fixed F1 end extends horizontally while J1 gains no reverse diagonal.',
        );
        await canvas.screenshot({
          path: `test-results/layout-emc-j1-track-drag-shove-${gesture.toLowerCase()}.png`,
        });
        if (gesture === 'pointer') await page.mouse.up();
        else await canvas.press('Enter');
        const result = await state();
        assert.equal(result.commits, 1);
        assert.deepEqual(
          geometry(result.board.tracks),
          displayed,
          'Commit uses the exact EMC preview.',
        );
        assert.deepEqual(
          result.board.footprints,
          board.footprints,
          'Native pads and drills remain exact.',
        );
        assert.deepEqual(result.board.vias, board.vias);
        assert.deepEqual(result.board.graphics, board.graphics);
        assert.deepEqual(result.board.nets, board.nets);
        await button('Undo').click();
        assert.deepEqual((await state()).board, board);
      },
    );

  for (const theme of ['light', 'dark']) {
    for (const layer of ['F.Cu', 'B.Cu']) {
      for (const gesture of ['pointer', 'D']) {
        const input = fixture('diagonal');
        input.theme = theme;
        for (const track of input.board.tracks) {
          track.layer = layer;
          track.width = 0.8;
        }
        for (const footprint of input.board.footprints)
          for (const pad of footprint.pads) pad.layers = [layer];
        await run(
          `${theme} ${layer} ${gesture} drag retains layer selection paint and original widths`,
          input,
          async ({ ids, page, canvas, point, state, clean, marker, preview, start }) => {
            await page.waitForFunction(
              (expected) => document.querySelector('.layout-editor')?.dataset.pcbTheme === expected,
              theme,
            );
            const pixels = async (positions) => {
              const coordinates = await canvas.evaluate(
                (svg, values) =>
                  values.map((position) => {
                    const screen = new DOMPoint(position.x, position.y).matrixTransform(
                      svg.getScreenCTM(),
                    );
                    return { x: Math.round(screen.x), y: Math.round(screen.y) };
                  }),
                positions,
              );
              const { data, info } = await sharp(await page.screenshot())
                .removeAlpha()
                .raw()
                .toBuffer({ resolveWithObject: true });
              return coordinates.map(({ x, y }) => {
                const at = (y * info.width + x) * info.channels;
                return [...data.subarray(at, at + 3)];
              });
            };
            await point(input.pickup, true);
            const [selectedColor] = await pixels([input.pickup]);
            assert.ok(
              layer === 'F.Cu'
                ? selectedColor[0] > selectedColor[2]
                : selectedColor[2] > selectedColor[0],
              'The idle selection retains its copper layer hue.',
            );
            if (gesture === 'pointer') {
              await page.mouse.down();
            } else {
              await start();
            }
            await point({ x: 27, y: 23 });
            await clean();
            assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
            const displayed = await preview();
            const changed = ['left', 'main', 'right'].map((name) =>
              displayed.find((track) => track.id === ids[name]),
            );
            const colors = await pixels(
              changed.map(({ start, end }) => ({
                x: (start.x + end.x) / 2,
                y: (start.y + end.y) / 2,
              })),
            );
            for (let i = 0; i < changed.length; i++) {
              assert.deepEqual(
                colors[i],
                selectedColor,
                'Selected and attached preview tracks share the layer selection paint without a blue overlay.',
              );
              const widths = await canvas
                .locator(`[data-selection-id="${changed[i].id}"] line[stroke-linecap]`)
                .evaluateAll((lines) =>
                  lines.map((line) => Number(line.getAttribute('stroke-width'))),
                );
              assert.deepEqual(
                widths,
                [0.8, 0.8],
                'Preview highlighting retains the copper width.',
              );
            }
            if (gesture === 'pointer') await page.mouse.up();
            else await canvas.press('Enter');
            const result = await state();
            assert.equal(result.commits, 1);
            assert.deepEqual(geometry(result.board.tracks), displayed);
          },
        );
      }
    }
  }

  await run(
    'mouse drag leaves a fixed pad through a diagonal reconnect without a right-angle stub',
    fixture('pad-end'),
    async ({
      board,
      schematic,
      ids,
      page,
      canvas,
      point,
      state,
      clean,
      marker,
      preview,
      button,
    }) => {
      await point({ x: 30, y: 20 });
      await page.mouse.down();
      await point({ x: 30, y: 24 });
      await clean();
      assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
      const displayed = await preview();
      const main = displayed.find((track) => track.id === ids.main);
      assert.deepEqual(main.start, { x: 24, y: 24 });
      assert.deepEqual(main.end, { x: 36, y: 24 });
      const reconnect = displayed.find(
        (track) => !board.tracks.some((source) => source.id === track.id),
      );
      assert.ok(reconnect, 'The fixed pad retains its copper connection during the preview.');
      assert.deepEqual(
        [reconnect.start, reconnect.end].sort((a, b) => a.x - b.x),
        [{ x: 20, y: 20 }, main.start],
        'The pad connects directly to the shifted horizontal span through one 45-degree leg.',
      );
      await page.screenshot({ path: 'test-results/layout-pad-track-drag.png' });
      await page.mouse.up();
      const result = await state();
      assert.equal(result.commits, 1);
      assert.deepEqual(geometry(result.board.tracks), displayed);
      verify(board, result.board, schematic, ids);
      await button('Undo').click();
      assert.deepEqual((await state()).board, board);
      assert.equal(await marker.count(), 0);
    },
  );

  await run(
    'collapsed diagonal mouse drag stops near the limit and commits its displayed boundary',
    fixture('diagonal'),
    async ({ page, point, clean, marker, preview, state, button, board }) => {
      await point({ x: 25, y: 25 });
      await page.mouse.down();
      await point({ x: 27, y: 23 });
      assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
      const earlier = await preview();
      await point({ x: 30, y: 20 });
      assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
      assert.equal(await marker.getAttribute('data-track-drag-constrained'), 'true');
      const displayed = await preview();
      assert.notDeepEqual(displayed, geometry(board.tracks));
      assert.notDeepEqual(displayed, earlier, 'The preview advances toward the collapse limit.');
      await clean();
      await page.mouse.up();
      assert.equal((await state()).commits, 1);
      assert.deepEqual(geometry((await state()).board.tracks), displayed);
      await button('Undo').click();
      assert.deepEqual((await state()).board, board);
    },
  );

  const group = fixture('group');
  await run(
    'selected connected tracks translate rigidly while boundary copper follows',
    group,
    async ({ board, schematic, ids, canvas, point, state, clean, marker, preview }) => {
      await point({ x: 30, y: 20 }, true);
      await point({ x: 35, y: 25 }, true, ['Shift']);
      await canvas.press('d');
      await point(group.target);
      await clean();
      assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
      const displayed = await preview();
      for (const name of ['main', 'next']) {
        const before = board.tracks.find((track) => track.id === ids[name]);
        const after = displayed.find((track) => track.id === ids[name]);
        assert.deepEqual(after.start, { x: before.start.x + 3, y: before.start.y + 4 });
        assert.deepEqual(after.end, { x: before.end.x + 3, y: before.end.y + 4 });
      }
      await canvas.press('Enter');
      const result = await state();
      assert.equal(result.commits, 1);
      assert.deepEqual(geometry(result.board.tracks), displayed);
      verify(board, result.board, schematic, ids);
    },
  );

  const anchored = fixture('anchors');
  await run(
    'fixed through vias and a branch remain connected when the selected segment slides away',
    anchored,
    async ({ board, schematic, ids, canvas, point, state, clean, marker, start }) => {
      await start();
      await point(anchored.target);
      await clean();
      assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
      await canvas.press('Enter');
      const result = await state();
      assert.equal(result.commits, 1);
      assert.deepEqual(result.board.tracks.find((track) => track.id === ids.branch).start, {
        x: 30,
        y: 20,
      });
      verify(board, result.board, schematic, ids);
    },
  );

  for (const contact of ['width-only', 'interior']) {
    const input = fixture('anchors');
    const branch = input.board.tracks.find((track) => track.id === input.ids.branch);
    branch.start = { x: 30, y: contact === 'width-only' ? 20.3 : 15 };
    input.target = { x: 25, y: contact === 'width-only' ? 16 : 12 };
    await run(
      `${contact} same-net contact remains physically joined when dragging away`,
      input,
      async ({ board, schematic, ids, canvas, point, state, clean, marker, preview, start }) => {
        await start();
        await point(input.target);
        await clean();
        assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
        const displayed = await preview();
        await canvas.press('Enter');
        const result = await state();
        assert.equal(result.commits, 1);
        assert.deepEqual(
          result.board.tracks.find((track) => track.id === ids.branch),
          branch,
          'Pass-through copper stays anchored at its existing coordinates.',
        );
        assert.deepEqual(geometry(result.board.tracks), displayed);
        verify(board, result.board, schematic, ids);
      },
    );
  }

  for (const kind of ['blocked', 'hidden']) {
    const input = fixture(kind);
    await run(
      `${kind} foreign copper constrains connected drag without moving obstacles`,
      input,
      async ({
        ids,
        page,
        canvas,
        button,
        point,
        state,
        clean,
        marker,
        preview,
        context,
        start,
      }) => {
        if (kind === 'hidden') {
          await toggleLayoutVisualization(page, 'Visible objects');
          await page
            .getByRole('group', { name: 'Visible objects', exact: true })
            .getByRole('checkbox', { name: 'Footprints', exact: true })
            .uncheck();
          await toggleLayoutVisualization(page, 'Visible objects');
        }
        await start();
        await point({ x: 30, y: 21 });
        assert.equal(
          await marker.getAttribute('data-track-drag-blocked'),
          'false',
          'Begin with a changed valid preview before testing a blocked target.',
        );
        await point({ x: 30, y: 24 });
        assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
        assert.equal(await marker.getAttribute('data-track-drag-constrained'), 'true');
        const observed = await context();
        assert.deepEqual(observed.connectedTrackDrag.trackIds, [ids.main]);
        assert.deepEqual(observed.connectedTrackDrag.delta, { x: 0, y: 4 });
        assert.equal(observed.connectedTrackDrag.clearance, 0.25);
        assert.equal(observed.connectedTrackDrag.blocked, false);
        assert.equal(observed.connectedTrackDrag.constrained, true);
        assert.equal(observed.previewError, '');
        assert.ok(observed.connectedTrackDrag.appliedDelta.y > 1);
        assert.ok(
          observed.connectedTrackDrag.appliedDelta.y < 4,
          'Agent context distinguishes the requested cursor from its checked stop.',
        );
        await clean();
        const displayed = await preview();
        assert.notDeepEqual(displayed, geometry(input.board.tracks));
        const obstacle = displayed.find((item) => item.id === ids.foreign);
        assert.deepEqual(
          obstacle,
          geometry(input.board.tracks).find((item) => item.id === ids.foreign),
        );
        if (kind === 'blocked') {
          await page.evaluate(() => {
            document.documentElement.dataset.theme = 'dark';
            document.documentElement.style.setProperty('--canvas', '#15191e');
          });
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          await page.screenshot({ path: 'test-results/layout-track-drag-dark.png' });
        }
        await canvas.press('Escape');
        await clean();
        await start();
        await point({ x: 30, y: 21 });
        await point({ x: 30, y: 24 });
        assert.deepEqual(await preview(), displayed, 'Cancellation cannot retain a stale stop.');
        await point({ x: 30, y: 24 }, true);
        assert.equal((await state()).commits, 1);
        assert.deepEqual(geometry((await state()).board.tracks), displayed);
        assert.deepEqual((await state()).board.footprints, input.board.footprints);
        assert.equal(await marker.count(), 0);
        assert.equal((await context()).connectedTrackDrag, null);
        await button('Undo').click();
        assert.deepEqual((await state()).board, input.board);
      },
    );
  }

  for (const cancel of ['Escape', 'tool', 'layer', 'filter', 'replacement', 'inactive']) {
    const input = fixture();
    await run(
      `${cancel} cancels a pending connected drag with zero writes`,
      input,
      async ({ page, canvas, button, point, clean, marker, context, start }) => {
        await start();
        await point({ x: 30, y: 24 });
        await clean();
        let expected = input.board;
        if (cancel === 'Escape') await canvas.press('Escape');
        else if (cancel === 'tool') {
          await canvas.press('x');
          await canvas.press('Escape');
        } else if (cancel === 'layer' || cancel === 'filter') {
          const name = cancel === 'layer' ? 'Visible layers' : 'Selection';
          await toggleLayoutVisualization(page, name);
          await page
            .getByRole('checkbox', { name: cancel === 'layer' ? 'F.Cu' : 'Tracks', exact: true })
            .uncheck();
          await toggleLayoutVisualization(page, name);
        } else if (cancel === 'replacement') {
          expected = structuredClone(input.board);
          expected.tracks.find((track) => track.id === input.ids.island).width = 0.5;
          await page.evaluate((value) => window.replaceBoard(value), expected);
          await marker.waitFor({ state: 'detached' });
        } else {
          await page.evaluate(() => window.setLayoutActive(false));
          await page.waitForFunction(() => !document.querySelector('[data-track-drag-preview]'));
          await page.evaluate(() => window.setLayoutActive(true));
        }
        assert.equal(await marker.count(), 0);
        assert.equal(
          (await context()).connectedTrackDrag,
          null,
          'Cancelled tools leave no stale Agent drag context.',
        );
        await canvas.press('Enter');
        await point({ x: 30, y: 24 }, true);
        await clean(expected);
      },
    );
  }

  const clearance = fixture('blocked');
  clearance.board.tracks.find((track) => track.id === clearance.ids.foreign).start.y = 26;
  clearance.board.tracks.find((track) => track.id === clearance.ids.foreign).end.y = 26;
  for (const change of ['PageUp', 'layer row']) {
    await run(
      'continuous editing: same-layer ' + change + ' retains connected drag until one commit',
      clearance,
      async ({ board, page, canvas, button, point, state, clean, marker, preview, start }) => {
        await start();
        await point({ x: 30, y: 24 });
        const before = await preview();
        if (change === 'layer row') {
          await toggleLayoutVisualization(page, 'Visible layers');
          await page
            .getByRole('group', { name: 'Visible layers', exact: true })
            .getByRole('button', { name: 'F.Cu', exact: true })
            .click();
          await toggleLayoutVisualization(page, 'Visible layers');
        } else await canvas.press(change);
        assert.equal(await marker.count(), 1, 'Choosing the current layer is not a cancellation.');
        assert.deepEqual(await preview(), before);
        await clean();
        await canvas.press('Enter');
        const result = await state();
        assert.equal(result.commits, 1);
        assert.deepEqual(geometry(result.board.tracks), before);
        await button('Undo').click();
        assert.deepEqual((await state()).board, board);
      },
    );
  }

  await run(
    'parallel movement of a single segment stays clean when placed',
    fixture(),
    async ({ canvas, point, clean, marker, start }) => {
      await start();
      await point({ x: 34, y: 20 });
      assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
      await canvas.press('Enter');
      assert.equal(await marker.count(), 0);
      await clean();
    },
  );

  await run(
    'host rejection retains the exact explicit connected-drag draft for retry',
    fixture(),
    async ({ board, page, canvas, button, point, state, clean, marker, preview, start }) => {
      await start();
      await point({ x: 30, y: 24 });
      const displayed = await preview();
      await page.evaluate(() => {
        window.rejectCommit = true;
      });
      await canvas.press('Enter');
      await clean();
      assert.equal(await marker.count(), 1);
      assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
      assert.deepEqual(
        await preview(),
        displayed,
        'Rejected Core placement restores the exact displayed draft.',
      );
      await page.evaluate(() => {
        window.rejectCommit = false;
      });
      await canvas.press('Enter');
      assert.equal(await marker.count(), 0);
      const accepted = await state();
      assert.equal(accepted.commits, 1);
      assert.deepEqual(geometry(accepted.board.tracks), displayed);
      await button('Undo').click();
      assert.deepEqual((await state()).board, board);
    },
  );

  await run(
    'host rejection retains the exact explicit Move draft for retry',
    fixture(),
    async ({ board, page, canvas, button, point, state, clean, preview }) => {
      await point({ x: 30, y: 20 }, true);
      await canvas.press('m');
      await point({ x: 30, y: 24 });
      const displayed = await preview();
      await page.evaluate(() => {
        window.rejectCommit = true;
      });
      await canvas.press('Enter');
      await clean();
      assert.equal(
        await canvas.evaluate((svg) => svg.parentElement.classList.contains('is-moving')),
        true,
      );
      assert.deepEqual(await preview(), displayed);
      await page.evaluate(() => {
        window.rejectCommit = false;
      });
      await canvas.press('Enter');
      assert.equal(
        await canvas.evaluate((svg) => svg.parentElement.classList.contains('is-moving')),
        false,
      );
      const accepted = await state();
      assert.equal(accepted.commits, 1);
      assert.deepEqual(geometry(accepted.board.tracks), displayed);
      await button('Undo').click();
      assert.deepEqual((await state()).board, board);
    },
  );

  await run(
    'menu connected drag returns canvas focus for Enter and Escape',
    fixture(),
    async ({ board, page, canvas, button, point, state, clean, marker }) => {
      await point({ x: 30, y: 20 }, true);
      const menu = async () => {
        await page.getByRole('combobox', { name: 'Edit layout', exact: true }).click();
        const action = page.getByRole('option', { name: 'Drag connected tracks', exact: true });
        assert.equal(await action.innerText(), 'Drag connected tracks');
        await action.click();
        assert.equal(await canvas.evaluate((svg) => document.activeElement === svg), true);
      };
      await menu();
      await point({ x: 30, y: 24 });
      await page.keyboard.press('Escape');
      await clean();
      await point({ x: 30, y: 20 });
      await menu();
      await point({ x: 30, y: 24 });
      await page.keyboard.press('Enter');
      assert.equal((await state()).commits, 1);
      assert.equal(await marker.count(), 0);
      await button('Undo').click();
      assert.deepEqual((await state()).board, board);
    },
  );

  await run(
    'Properties text entry suppresses connected drag shortcuts',
    fixture(),
    async ({ page, point, clean, marker }) => {
      await point({ x: 30, y: 20 }, true);
      const width = page.getByRole('spinbutton', { name: 'Width (mm)', exact: true });
      await width.fill('2');
      await point({ x: 30, y: 20 });
      await page.keyboard.press('d');
      assert.equal(await marker.count(), 0);
      await page.keyboard.press('Escape');
      assert.equal(await width.inputValue(), '0.4');
      await clean();
    },
  );

  await run(
    'a mixed track and via selection fails visibly without starting a partial drag',
    fixture(),
    async ({ page, canvas, point, clean, marker }) => {
      await point({ x: 30, y: 20 }, true);
      await point({ x: 55, y: 38 }, true, ['Shift']);
      await canvas.press('d');
      assert.equal(await marker.count(), 0);
      assert.match(await page.getByRole('alert').innerText(), /track/i);
      await clean();
    },
  );
  assert.ok(
    matchedCases > 0,
    `No Layout track-drag cases matched ${JSON.stringify(process.argv[2] ?? '')}.`,
  );
} finally {
  await browser.close();
}
