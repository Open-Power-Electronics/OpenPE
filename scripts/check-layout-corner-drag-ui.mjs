import { toggleLayoutVisualization } from './visualization-test-helpers.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
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
        return <LayoutEditor board={board} schematic={window.fixture.schematic} active={active} agentContextRef={context}
          onCommit={next=>{window.lastBoard=next;window.commits++;setHistory([...history,board]);setBoard(next);return true}}
          undoAction={<button aria-label="Undo" disabled={!history.length} onClick={()=>{const next=history.at(-1);window.lastBoard=next;setBoard(next);setHistory(history.slice(0,-1))}}>Undo</button>}
          annotations={[]} annotationSessionId="corner-drag" onAnnotationsChange={()=>{}}/>}
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
      { x: 40, y: 30 },
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
    board.tracks.find((item) => item.id === ids.foreign).start = { x: 18, y: 24 };
    board.tracks.find((item) => item.id === ids.foreign).end = { x: 42, y: 24 };
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
    await canvas.press('g');
    const menu = page.getByRole('menu', { name: 'Choose layout object', exact: true });
    if (await menu.count()) {
      const track = input.board.tracks.find((item) => item.id === input.ids.main);
      const coordinates = (point) => `${Number(point.x.toFixed(3))}, ${Number(point.y.toFixed(3))}`;
      await menu
        .getByRole('menuitem')
        .filter({
          hasText: `${coordinates(track.start)} → ${coordinates(track.end)}`,
        })
        .click();
    }
    assert.equal(await marker.count(), 1);
    assert.equal(await marker.getAttribute('data-track-drag-mode'), 'corner');
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
    console.log(`Layout corner drag: ${name}.`);
  } finally {
    await page.close();
  }
}

try {
  for (const source of ['segment', 'joint']) {
    const input = fixture(source === 'joint' ? 'group' : 'horizontal');
    input.pickup = source === 'joint' ? { x: 35, y: 20 } : { x: 30, y: 20 };
    input.target = source === 'joint' ? { x: 38, y: 24.5 } : { x: 32.5, y: 24.5 };
    await run(
      source + ' free-angle corner previews and commits exactly once with fixed remote endpoints',
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
        if (source === 'segment')
          await page.screenshot({ path: 'test-results/layout-corner-drag-light.png' });
        assert.ok(
          displayed.some((track) =>
            [track.start, track.end].some(
              (at) => at.x === input.target.x && at.y === input.target.y,
            ),
          ),
          'The live corner follows the grid-snapped pointer without H/V/45 restriction.',
        );
        if (source === 'segment') {
          assert.equal(
            displayed.length,
            board.tracks.length + 1,
            'A new mid-segment bend creates two legs.',
          );
          for (const name of ['left', 'right'])
            assert.deepEqual(
              displayed.find((track) => track.id === ids[name]),
              geometry(board.tracks).find((track) => track.id === ids[name]),
            );
        } else {
          assert.equal(displayed.length, board.tracks.length);
          assert.deepEqual(displayed.find((track) => track.id === ids.main).end, input.target);
          assert.deepEqual(displayed.find((track) => track.id === ids.next).start, input.target);
          assert.deepEqual(displayed.find((track) => track.id === ids.main).start, {
            x: 25,
            y: 20,
          });
          assert.deepEqual(displayed.find((track) => track.id === ids.next).end, { x: 35, y: 30 });
        }
        await canvas.press('Enter');
        const result = await state();
        assert.equal(result.commits, 1);
        assert.deepEqual(geometry(result.board.tracks), displayed);
        verify(board, result.board, schematic, ids);
        if (source === 'segment')
          await writeFile(
            'test-results/layout-corner-drag.kicad_pcb',
            serializePCB(result.board, schematic),
            'utf8',
          );
        await button('Undo').click();
        assert.deepEqual((await state()).board, board);
      },
    );
  }

  for (const anchor of ['pad', 'via', 'branch']) {
    const input = fixture('anchors');
    if (anchor === 'pad') {
      input.board.footprints[0].x = 20;
      input.board.footprints[0].y = 20;
    }
    input.pickup =
      anchor === 'pad' ? { x: 20, y: 20 } : anchor === 'via' ? { x: 40, y: 20 } : { x: 30, y: 20 };
    input.target = anchor === 'via' ? { x: 44, y: 24.5 } : { x: 27.5, y: 24.5 };
    await run(
      'fixed ' + anchor + ' pickup reconnects its copper without moving the original anchor',
      input,
      async ({ board, schematic, ids, canvas, point, state, clean, marker, preview }) => {
        await point({ x: 25, y: 20 }, true);
        await point(input.pickup);
        await canvas.press('g');
        assert.equal(await marker.getAttribute('data-track-drag-mode'), 'corner');
        await point(input.target);
        await clean();
        assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
        const displayed = await preview();
        await canvas.press('Enter');
        const result = await state();
        assert.equal(result.commits, 1);
        assert.deepEqual(geometry(result.board.tracks), displayed);
        assert.deepEqual(
          result.board.tracks.find((track) => track.id === ids.branch),
          board.tracks.find((track) => track.id === ids.branch),
        );
        verify(board, result.board, schematic, ids);
      },
    );
  }

  await run(
    'a selected track takes priority over unrelated hovered copper',
    fixture(),
    async ({ board, ids, canvas, point, state, clean, marker }) => {
      await point({ x: 30, y: 20 }, true);
      await point({ x: 55, y: 35 });
      await canvas.press('g');
      assert.equal(await marker.getAttribute('data-track-drag-mode'), 'corner');
      await point({ x: 33, y: 24 });
      await clean();
      assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
      await canvas.press('Enter');
      const result = await state();
      assert.equal(result.commits, 1);
      assert.deepEqual(
        result.board.tracks.find((track) => track.id === ids.foreign),
        board.tracks.find((track) => track.id === ids.foreign),
      );
      assert.notDeepEqual(
        result.board.tracks.filter((track) => track.netId === ids.out),
        board.tracks.filter((track) => track.netId === ids.out),
      );
    },
  );

  const selected = fixture('group');
  await run(
    'a selected track group chooses the nearest seed for a local corner edit',
    selected,
    async ({ board, ids, canvas, point, state, clean, marker }) => {
      await point({ x: 30, y: 20 }, true);
      await point({ x: 35, y: 25 }, true, ['Shift']);
      await canvas.press('g');
      await point({ x: 38, y: 29 });
      await clean();
      assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
      await canvas.press('Enter');
      const result = await state();
      assert.equal(result.commits, 1);
      assert.deepEqual(
        result.board.tracks.find((track) => track.id === ids.main),
        board.tracks.find((track) => track.id === ids.main),
      );
      assert.ok(
        result.board.tracks.some((track) =>
          [track.start, track.end].some((at) => at.x === 38 && at.y === 29),
        ),
      );
    },
  );

  for (const kind of ['blocked', 'hidden']) {
    const input = fixture(kind);
    await run(
      kind + ' copper holds a checked corner boundary for cancellation and exact placement',
      input,
      async ({ page, canvas, button, point, state, clean, marker, preview, start }) => {
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
        assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
        await point({ x: 30, y: 24 });
        assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
        assert.equal(await marker.getAttribute('data-track-drag-constrained'), 'true');
        const displayed = await preview();
        assert.notDeepEqual(displayed, geometry(input.board.tracks));
        if (kind === 'blocked') {
          await page.evaluate(() => {
            document.documentElement.dataset.theme = 'dark';
            document.documentElement.style.setProperty('--canvas', '#15191e');
          });
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          await page.screenshot({ path: 'test-results/layout-corner-drag-dark.png' });
        }
        await canvas.press('Escape');
        assert.equal(await marker.count(), 0);
        await clean();
        await start();
        await point({ x: 30, y: 21 });
        await point({ x: 30, y: 24 });
        const retried = await preview();
        const copper = (tracks) => tracks.map(({ id, ...track }) => JSON.stringify(track)).sort();
        assert.deepEqual(copper(retried), copper(displayed));
        await canvas.press('Enter');
        assert.equal((await state()).commits, 1);
        assert.deepEqual(geometry((await state()).board.tracks), retried);
        await button('Undo').click();
        assert.deepEqual((await state()).board, input.board);
      },
    );
  }

  for (const cancel of ['Escape', 'tool', 'layer', 'filter', 'replacement', 'inactive']) {
    const input = fixture();
    await run(
      cancel + ' cancels an unfinished corner edit without writes',
      input,
      async ({ page, canvas, button, point, clean, marker, start }) => {
        await start();
        await point({ x: 32.5, y: 24.5 });
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
          await marker.waitFor({ state: 'detached' });
          await page.evaluate(() => window.setLayoutActive(true));
        }
        assert.equal(await marker.count(), 0);
        await canvas.press('Enter');
        await point({ x: 32.5, y: 24.5 }, true);
        await clean(expected);
      },
    );
  }

  await run(
    'an unchanged corner edit remains clean and creates no redundant split',
    fixture(),
    async ({ canvas, clean, marker, start }) => {
      await start();
      await canvas.press('Enter');
      assert.equal(await marker.count(), 0);
      await clean();
    },
  );

  await run(
    'edit and transform shortcuts cannot alter a pending corner transaction',
    fixture(),
    async ({ canvas, point, clean, marker, preview, start }) => {
      await start();
      await point({ x: 32.5, y: 24.5 });
      const displayed = await preview();
      for (const key of ['m', 'd', 'r', 'f', 'Delete', 'Backspace', 'u', 'e']) {
        await canvas.press(key);
        await clean();
        assert.equal(await marker.getAttribute('data-track-drag-mode'), 'corner');
        assert.deepEqual(await preview(), displayed);
      }
      await canvas.press('Escape');
      await clean();
    },
  );

  await run(
    'Properties text entry suppresses the corner shortcut',
    fixture(),
    async ({ page, point, clean, marker }) => {
      await point({ x: 30, y: 20 }, true);
      const width = page.getByRole('spinbutton', { name: 'Width (mm)', exact: true });
      await width.fill('2');
      await point({ x: 30, y: 20 });
      await page.keyboard.press('g');
      assert.equal(await marker.count(), 0);
      await page.keyboard.press('Escape');
      assert.equal(await width.inputValue(), '0.4');
      await clean();
    },
  );

  await run(
    'the corner menu action restores canvas focus for placement',
    fixture(),
    async ({ page, canvas, point, state, clean, marker }) => {
      await point({ x: 30, y: 20 }, true);
      await page.getByRole('combobox', { name: 'Edit layout', exact: true }).click();
      const action = page.getByRole('option', { name: 'Drag track corner', exact: true });
      assert.equal(await action.innerText(), 'Drag track corner');
      await action.click();
      assert.equal(await canvas.evaluate((svg) => document.activeElement === svg), true);
      assert.equal(
        await page.locator('.layout-tool-settings').count(),
        0,
        'Corner drag opens no floating card.',
      );
      assert.equal(
        await page.getByRole('spinbutton', { name: 'Drag clearance (mm)', exact: true }).count(),
        0,
      );
      assert.equal(
        await page.evaluate(() => window.layoutContext().connectedTrackDrag.clearance),
        0.25,
      );
      await point({ x: 32.5, y: 24.5 });
      await clean();
      await page.keyboard.press('Enter');
      assert.equal((await state()).commits, 1);
      assert.equal(await marker.count(), 0);
    },
  );

  const preciseJoint = fixture('group');
  preciseJoint.board.tracks.find((track) => track.id === preciseJoint.ids.main).end = {
    x: 35.25,
    y: 20.25,
  };
  preciseJoint.board.tracks.find((track) => track.id === preciseJoint.ids.next).start = {
    x: 35.25,
    y: 20.25,
  };
  await run(
    'menu corner pickup retains the raw off-grid joint after leaving a highly zoomed canvas',
    preciseJoint,
    async ({ page, canvas, point, state, clean, marker, preview }) => {
      const joint = { x: 35.25, y: 20.25 },
        target = { x: 35.5, y: 20.5 };
      await point({ x: 30, y: 20 }, true);
      await point(joint);
      for (let step = 0; step < 20; step++) await page.mouse.wheel(0, -100);
      await page.waitForFunction(
        () => document.querySelector('[data-testid="layout-canvas"]').getScreenCTM().a > 100,
      );
      await point(joint);
      await page.getByRole('combobox', { name: 'Edit layout', exact: true }).click();
      await page.getByRole('option', { name: 'Drag track corner', exact: true }).click();
      assert.equal(await marker.getAttribute('data-track-drag-mode'), 'corner');
      await point(target);
      await clean();
      const displayed = await preview();
      assert.equal(
        displayed.length,
        preciseJoint.board.tracks.length,
        'An existing joint is moved rather than inserting an interior bend.',
      );
      assert.deepEqual(displayed.find((track) => track.id === preciseJoint.ids.main).end, target);
      assert.deepEqual(displayed.find((track) => track.id === preciseJoint.ids.next).start, target);
      assert.deepEqual(displayed.find((track) => track.id === preciseJoint.ids.main).start, {
        x: 25,
        y: 20,
      });
      assert.deepEqual(displayed.find((track) => track.id === preciseJoint.ids.next).end, {
        x: 35,
        y: 30,
      });
      await canvas.press('Enter');
      assert.equal((await state()).commits, 1);
      verify(preciseJoint.board, (await state()).board, preciseJoint.schematic, preciseJoint.ids);
    },
  );
} finally {
  await browser.close();
}
