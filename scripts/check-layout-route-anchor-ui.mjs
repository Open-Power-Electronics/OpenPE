import {
  routingFixture as fixture,
  verifyRoutingPreservation as verifyPreservation,
} from './layout-routing-test-helpers.mjs';
import { toggleLayoutVisualization } from './visualization-test-helpers.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { uid } = await tsImport('../lib/circuit.ts', import.meta.url);
const { serializePCB } = await tsImport('../lib/pcb.ts', import.meta.url);

// Real SVG pointer events in an isolated renderer, with mocked commits and undo.
// This check never starts Electron, a provider, a service or the user's workspace.
const bundle = await build({
  stdin: {
    contents: `import React,{useState,useRef} from 'react';import {createRoot} from 'react-dom/client';
      import LayoutEditor from './components/LayoutEditor';
      function Test(){const [board,setBoard]=useState(window.fixture.board);const [history,setHistory]=useState([]);
        const context=useRef(null);window.layoutContext=()=>context.current;window.historyDepth=history.length;
        return <LayoutEditor board={board} schematic={window.fixture.schematic} active agentContextRef={context}
          onCommit={next=>{window.lastBoard=next;window.commits++;setHistory([...history,board]);setBoard(next);return true}}
          undoAction={<button aria-label="Undo" disabled={!history.length} onClick={()=>{const next=history.at(-1);window.lastBoard=next;setBoard(next);setHistory(history.slice(0,-1))}}>Undo</button>}
          annotations={[]} annotationSessionId="route-anchor" onAnnotationsChange={()=>{}}/>}
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
  const button = (label) => page.getByRole('button', { name: label, exact: true });
  const point = async (p, click = false) => {
    const at = await canvas.evaluate((svg, position) => {
      const screen = new DOMPoint(position.x, position.y).matrixTransform(svg.getScreenCTM());
      return { x: screen.x, y: screen.y };
    }, p);
    await page.mouse.move(at.x, at.y);
    if (click) await page.mouse.click(at.x, at.y);
    return at;
  };
  const state = () =>
    page.evaluate(() => ({
      board: window.lastBoard,
      commits: window.commits,
      historyDepth: window.historyDepth,
    }));
  const clean = async () =>
    assert.deepEqual(await state(), { board: input.board, commits: 0, historyDepth: 0 });
  const routePreview = canvas.locator('[data-route-preview]');
  const viaPreview = canvas.locator('[data-route-via-preview]');
  const start = async () => {
    await button('Route tracks').click();
    await point(input.board.footprints[0], true);
    await clean();
  };
  const transition = async (p, key = 'v') => {
    await point(p);
    await canvas.press(key);
    assert.equal(await viaPreview.count(), 1, `${key} prepares a through via on the live head.`);
    assert.equal(await viaPreview.getAttribute('data-route-blocked'), 'false');
    await clean();
    await point(p, true);
    assert.equal(
      await viaPreview.count(),
      0,
      'A placed draft via changes layer and leaves routing active.',
    );
    assert.ok(await routePreview.count());
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
      start,
      transition,
      routePreview,
      viaPreview,
    });
    assert.deepEqual(errors, [], `${name}: no renderer errors.`);
    console.log(`Layout route anchor: ${name}.`);
  } finally {
    await page.close();
  }
}

function anchorFixture({ endLayer = 'F.Cu', endNet = 'OUT', mask = false } = {}) {
  const input = fixture({ endLayer });
  input.board.footprints[0].x = 18.23;
  input.board.footprints[0].y = 22.17;
  input.board.footprints[1].x = 48.27;
  input.board.footprints[1].y = 22.33;
  input.board.footprints[1].pads[0].netId =
    endNet === null ? null : input.board.nets.find((net) => net.name === endNet).id;
  input.connectionId = uid();
  input.board.tracks.push({
    id: input.connectionId,
    start: { x: 44.27, y: 30.33 },
    end: { x: 54.77, y: 30.33 },
    width: 0.4,
    layer: 'F.Cu',
    netId: input.board.nets[0].id,
  });
  if (mask) {
    input.maskId = uid();
    input.board.graphics.push({
      id: input.maskId,
      layer: 'F.SilkS',
      width: 0.8,
      start: { x: 47, y: 22.33 },
      end: { x: 49.5, y: 22.33 },
    });
  }
  return input;
}
const head = async (preview) => {
  const value = await preview.getAttribute('points');
  return value
    .trim()
    .split(/\s+/)
    .map((pair) => {
      const [x, y] = pair.split(',').map(Number);
      return { x, y };
    });
};
const closePoint = (actual, expected) => {
  assert.ok(Math.abs(actual.x - expected.x) < 1e-5, actual.x + ' != ' + expected.x);
  assert.ok(Math.abs(actual.y - expected.y) < 1e-5, actual.y + ' != ' + expected.y);
};
async function finish(method, { page, canvas, point }, at) {
  if (method === 'click') await point(at, true);
  else if (method === 'Enter') await canvas.press('Enter');
  else {
    const screen = await point(at);
    await page.mouse.dblclick(screen.x, screen.y);
  }
}

try {
  for (const target of ['off-grid pad under artwork', 'opposite-layer pad', 'track body', 'via']) {
    const input = anchorFixture({
      endLayer: target === 'opposite-layer pad' ? 'B.Cu' : 'F.Cu',
      mask: true,
    });
    const startPoint =
      target === 'track body'
        ? { x: 49.11, y: 30.4 }
        : target === 'via'
          ? input.board.vias[0]
          : input.board.footprints[1];
    const expected = target === 'track body' ? { x: 49.11, y: 30.33 } : startPoint;
    const netId = target === 'via' ? input.board.nets[1].id : input.board.nets[0].id;
    const layer = target === 'opposite-layer pad' ? 'B.Cu' : 'F.Cu';
    await run(
      'X starts from the hovered ' + target + ' and Enter commits its exact preview once',
      input,
      async ({ canvas, point, state, clean, button, routePreview }) => {
        await point(startPoint);
        await canvas.press('x');
        assert.equal(await button('Route tracks').getAttribute('aria-pressed'), 'true');
        assert.equal(
          await routePreview.count(),
          1,
          'Routing begins without a second pointer click.',
        );
        closePoint((await head(routePreview))[0], expected);
        await clean();
        await point({ x: 34, y: 27 });
        const displayed = await head(routePreview);
        assert.equal(await routePreview.getAttribute('data-route-blocked'), 'false');
        await canvas.press('x');
        assert.deepEqual(
          await head(routePreview),
          displayed,
          'Repeated X retains the active route.',
        );
        await clean();
        await canvas.press('Enter');
        const result = await state();
        assert.equal(result.commits, 1);
        assert.equal(result.historyDepth, 1);
        const added = result.board.tracks.slice(input.board.tracks.length);
        closePoint(added[0].start, expected);
        assert.ok(added.every((track) => track.layer === layer && track.netId === netId));
        assert.deepEqual(
          added.map((track) => ({ start: track.start, end: track.end })),
          displayed.slice(1).map((end, i) => ({ start: displayed[i], end })),
        );
        verifyPreservation(input.board, result.board, input.schematic);
        await button('Undo').click();
        assert.deepEqual((await state()).board, input.board);
      },
    );
  }

  for (const sourceWidth of [0.8, 0.025]) {
    const input = anchorFixture();
    input.board.tracks.find((track) => track.id === input.connectionId).width = sourceWidth;
    await run(
      `track continuation uses the configured width despite ${sourceWidth} mm source copper`,
      input,
      async ({ page, canvas, point, state, clean, routePreview }) => {
        await page.getByRole('button', { name: 'Route tracks', exact: true }).click();
        assert.equal(
          await page
            .getByRole('checkbox', { name: 'Use existing track width', exact: true })
            .count(),
          0,
        );
        const field = page.getByRole('spinbutton', { name: 'Track width (mm)', exact: true });
        await field.fill('0.3');
        await field.press('Enter');
        await point({ x: 49.11, y: 30.4 });
        await canvas.press('x');
        assert.equal(await routePreview.count(), 1);
        assert.equal(Number(await field.inputValue()), 0.3);
        await field.focus();
        await field.press('Tab');
        assert.equal(await field.getAttribute('aria-invalid'), null);
        assert.equal(Number(await field.inputValue()), 0.3);
        await clean();
        await point({ x: 49, y: 26 });
        assert.equal(await routePreview.getAttribute('data-route-blocked'), 'false');
        assert.equal(Number(await routePreview.getAttribute('stroke-width')), 0.3);
        await canvas.focus();
        await canvas.press('Enter');
        const result = await state();
        assert.equal(result.commits, 1);
        assert.equal(result.historyDepth, 1);
        assert.ok(result.board.tracks.length > input.board.tracks.length);
        for (const track of result.board.tracks.slice(input.board.tracks.length))
          assert.equal(track.width, 0.3);
        verifyPreservation(input.board, result.board, input.schematic);
        await page.getByRole('button', { name: 'Undo', exact: true }).click();
        assert.deepEqual((await state()).board, input.board);
      },
    );
  }

  await run(
    'configured route width survives source pickup and cancellation',
    anchorFixture(),
    async ({ page, canvas, point, state }) => {
      await page.getByRole('button', { name: 'Route tracks', exact: true }).click();
      const field = page.getByRole('spinbutton', { name: 'Track width (mm)', exact: true });
      await field.fill('0.3');
      await field.press('Enter');
      await point({ x: 49.11, y: 30.4 });
      await canvas.press('x');
      assert.equal(Number(await field.inputValue()), 0.3);
      await canvas.press('Escape');
      await page.getByRole('button', { name: 'Route tracks', exact: true }).click();
      assert.equal(Number(await field.inputValue()), 0.3);
      await point({ x: 49.11, y: 30.4 });
      await canvas.press('x');
      assert.equal(Number(await field.inputValue()), 0.3);
      await canvas.press('Escape');
      assert.equal((await state()).commits, 0);
    },
  );

  for (const target of [
    'empty space',
    'unassigned pad',
    'hidden copper',
    'Shift bypass',
    'blocked copper',
  ]) {
    const input = anchorFixture({ endNet: target === 'unassigned pad' ? null : 'OUT' });
    if (target === 'blocked copper') {
      const pad = input.board.footprints[1];
      input.board.tracks.push({
        id: uid(),
        start: { x: pad.x - 2, y: pad.y },
        end: { x: pad.x + 2, y: pad.y },
        width: 0.4,
        layer: 'F.Cu',
        netId: input.board.nets[1].id,
      });
    }
    await run(
      'X over ' + target + ' only selects routing without a free or stale starting point',
      input,
      async ({ page, canvas, button, point, state, clean, routePreview }) => {
        if (target === 'hidden copper') {
          await toggleLayoutVisualization(page, 'Visible objects');
          await page
            .getByRole('group', { name: 'Visible objects', exact: true })
            .getByRole('checkbox', { name: 'Footprints', exact: true })
            .uncheck();
          await toggleLayoutVisualization(page, 'Visible objects');
        }
        await point(target === 'empty space' ? { x: 34, y: 27 } : input.board.footprints[1]);
        await canvas.press(target === 'Shift bypass' ? 'Shift+x' : 'x');
        assert.equal(await button('Route tracks').getAttribute('aria-pressed'), 'true');
        assert.equal(await routePreview.count(), 0);
        await canvas.press('Enter');
        await clean();
        if (target === 'unassigned pad')
          assert.match(await page.getByRole('alert').innerText(), /no net|Schematic/i);
        if (target === 'blocked copper')
          assert.match(
            await page.getByRole('alert').innerText(),
            /track|clearance|obstacle|copper/i,
          );
        await canvas.press('Escape');
        assert.equal((await state()).commits, 0);
      },
    );
  }

  for (const target of [
    { endLayer: 'B.Cu', endNet: 'OUT', name: 'opposite-layer pad' },
    { endLayer: 'B.Cu', endNet: 'GND', name: 'foreign-net opposite-layer pad' },
    { endLayer: 'F.Cu', endNet: null, name: 'unassigned pad' },
  ]) {
    for (const method of ['click', 'Enter', 'double-click']) {
      const input = anchorFixture(target);
      await run(
        method + ' rejects ' + target.name + ' with matching preview and no writes',
        input,
        async ({ page, canvas, point, clean, start, routePreview }) => {
          await start();
          await point(input.board.footprints[1]);
          assert.equal(await routePreview.getAttribute('data-route-blocked'), 'true');
          const snap = canvas.locator('[data-route-snap-target]');
          assert.equal(await snap.getAttribute('data-route-snap-target'), 'pad');
          assert.equal(
            await snap.getAttribute('data-route-snap-id'),
            input.board.footprints[1].pads[0].id,
          );
          await finish(method, { page, canvas, point }, input.board.footprints[1]);
          await clean();
          assert.match(await page.getByRole('alert').innerText(), /net|layer|copper|Schematic/i);
          assert.equal(await routePreview.count(), 1);
          await canvas.press('Escape');
          await clean();
        },
      );
    }
  }

  for (const method of ['click', 'Enter', 'double-click']) {
    const input = anchorFixture({ mask: true });
    await run(
      method + ' reaches the exact off-grid pad under overlapping visible artwork',
      input,
      async ({ page, canvas, point, state, start, routePreview }) => {
        await start();
        // Routing raises its copper layer. Clear only that display priority so
        // this case exercises the ordinary stack with front artwork above pads.
        await toggleLayoutVisualization(page, 'Visible layers');
        const frontCopper = page
          .getByRole('group', { name: 'Visible layers', exact: true })
          .getByRole('button', { name: 'F.Cu', exact: true });
        assert.equal(await frontCopper.getAttribute('aria-pressed'), 'true');
        await frontCopper.click();
        assert.equal(await frontCopper.getAttribute('aria-pressed'), 'false');
        assert.equal(await routePreview.count(), 1, 'Clearing display priority retains the route.');
        await toggleLayoutVisualization(page, 'Visible layers');
        await point(input.board.footprints[1]);
        const masked = await canvas.evaluate(
          (svg, { x, y, id }) => {
            const p = new DOMPoint(x, y).matrixTransform(svg.getScreenCTM());
            // Routing deliberately owns a transparent interaction surface above
            // the board. Check the underlying drawing order, where the artwork
            // still masks this pad, rather than that tool's event surface.
            return (
              document
                .elementsFromPoint(p.x, p.y)
                .find((element) => element.closest('[data-layout-drawing]'))
                ?.closest('[data-selection-id]')
                ?.getAttribute('data-selection-id') === id
            );
          },
          { ...input.board.footprints[1], id: input.maskId },
        );
        assert.equal(
          masked,
          true,
          'Overlapping artwork remains above the pad in the drawing stack.',
        );
        const snap = canvas.locator('[data-route-snap-target]');
        assert.equal(
          await snap.getAttribute('data-route-snap-id'),
          input.board.footprints[1].pads[0].id,
        );
        const displayed = await head(routePreview);
        closePoint(displayed[0], input.board.footprints[0]);
        closePoint(displayed.at(-1), input.board.footprints[1]);
        assert.equal(await routePreview.getAttribute('data-route-blocked'), 'false');
        if (method === 'click')
          await page.screenshot({ path: 'test-results/layout-route-anchor.png' });
        await finish(method, { page, canvas, point }, input.board.footprints[1]);
        const result = await state();
        assert.equal(result.commits, 1);
        const added = result.board.tracks.slice(input.board.tracks.length);
        assert.deepEqual(
          added.map((track) => ({ start: track.start, end: track.end })),
          displayed.slice(1).map((end, i) => ({ start: displayed[i], end })),
        );
        verifyPreservation(input.board, result.board, input.schematic);
        if (method === 'click')
          await writeFile(
            'test-results/layout-route-anchor.kicad_pcb',
            serializePCB(result.board, input.schematic),
            'utf8',
          );
      },
    );
  }

  for (const target of [
    { name: 'endpoint', pointer: { x: 44.45, y: 30.4 }, expected: { x: 44.27, y: 30.33 } },
    { name: 'body projection', pointer: { x: 49.11, y: 30.4 }, expected: { x: 49.11, y: 30.33 } },
  ]) {
    for (const method of ['click', 'Enter']) {
      const input = anchorFixture();
      await run(
        method + ' uses the exact track ' + target.name + ' before grid snapping',
        input,
        async ({ page, canvas, point, state, start, routePreview }) => {
          await start();
          await point(target.pointer);
          closePoint((await head(routePreview)).at(-1), target.expected);
          const snap = canvas.locator('[data-route-snap-target]');
          assert.equal(await snap.getAttribute('data-route-snap-target'), 'track');
          assert.equal(await snap.getAttribute('data-route-snap-id'), input.connectionId);
          await finish(method, { page, canvas, point }, target.pointer);
          const result = await state();
          assert.equal(result.commits, 1);
          closePoint(result.board.tracks.at(-1).end, target.expected);
          verifyPreservation(input.board, result.board, input.schematic);
        },
      );
    }
  }

  await run(
    'Shift bypasses object attraction and clicks keep the visible grid waypoint',
    anchorFixture(),
    async ({ board, page, canvas, point, clean, start, routePreview }) => {
      await start();
      await page.keyboard.down('Shift');
      await point(board.footprints[1]);
      closePoint((await head(routePreview)).at(-1), { x: 48.5, y: 22.5 });
      assert.equal(await canvas.locator('[data-route-snap-target]').count(), 0);
      await point(board.footprints[1], true);
      await clean();
      await page.keyboard.up('Shift');
      closePoint((await head(routePreview)).at(-1), board.footprints[1]);
      assert.equal(
        await canvas.locator('[data-route-snap-target]').getAttribute('data-route-snap-target'),
        'pad',
      );
      await canvas.press('Escape');
      await clean();
    },
  );

  await run(
    'Control bypasses grid snapping and modifier release refreshes the visible head',
    anchorFixture(),
    async ({ board, schematic, page, canvas, point, state, clean, start, routePreview }) => {
      await start();
      await page.keyboard.down('Control');
      const raw = { x: 33.13, y: 28.27 };
      await point(raw);
      closePoint((await head(routePreview)).at(-1), raw);
      await point(raw, true);
      await clean();
      await page.keyboard.up('Control');
      const displayed = await head(routePreview);
      closePoint(displayed.at(-1), { x: 33, y: 28.5 });
      await canvas.press('Enter');
      const result = await state();
      assert.equal(result.commits, 1);
      closePoint(result.board.tracks.at(-1).end, displayed.at(-1));
      assert.ok(
        result.board.tracks.some(
          (track) => Math.abs(track.end.x - raw.x) < 1e-5 && Math.abs(track.end.y - raw.y) < 1e-5,
        ),
      );
      verifyPreservation(board, result.board, schematic);
    },
  );

  const rawStart = anchorFixture();
  await run(
    'a Control raw-pixel route start remains within canonical six-decimal precision',
    rawStart,
    async ({ page, canvas, button, point, state, clean, routePreview }) => {
      await button('Route tracks').click();
      await page.keyboard.down('Control');
      const raw = { x: 33.123457, y: 27.234568 };
      await point(raw, true);
      closePoint((await head(routePreview))[0], raw);
      await point({ x: 39.987653, y: 27.345678 });
      await clean();
      await page.keyboard.up('Control');
      const displayed = await head(routePreview);
      await canvas.press('Enter');
      const result = await state();
      assert.equal(result.commits, 1);
      closePoint(result.board.tracks.slice(rawStart.board.tracks.length)[0].start, displayed[0]);
      verifyPreservation(rawStart.board, result.board, rawStart.schematic);
    },
  );

  const focusModifiers = anchorFixture();
  await run(
    'Shift release outside canvas restores the snapped candidate before Enter',
    focusModifiers,
    async ({ page, canvas, point, state, clean, start, routePreview }) => {
      await start();
      await point(focusModifiers.board.footprints[1]);
      assert.equal(await canvas.locator('[data-route-snap-target]').count(), 1);
      await page.keyboard.down('Shift');
      assert.equal(await canvas.locator('[data-route-snap-target]').count(), 0);
      await page.keyboard.press('Tab');
      assert.equal(await canvas.evaluate((svg) => document.activeElement === svg), false);
      await page.keyboard.up('Shift');
      await canvas.focus();
      closePoint((await head(routePreview)).at(-1), focusModifiers.board.footprints[1]);
      assert.equal(
        await canvas.locator('[data-route-snap-target]').getAttribute('data-route-snap-target'),
        'pad',
      );
      await clean();
      await canvas.press('Enter');
      assert.equal((await state()).commits, 1);
      closePoint((await state()).board.tracks.at(-1).end, focusModifiers.board.footprints[1]);
    },
  );

  const blurredModifiers = anchorFixture();
  await run(
    'window blur resets held Control and Shift flags without committing background work',
    blurredModifiers,
    async ({ page, canvas, point, state, clean, start, routePreview }) => {
      await start();
      await page.keyboard.down('Control');
      await page.keyboard.down('Shift');
      const raw = { x: 48.39, y: 22.41 };
      await point(raw);
      closePoint((await head(routePreview)).at(-1), raw);
      assert.equal(await canvas.locator('[data-route-snap-target]').count(), 0);
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await canvas.focus();
      closePoint((await head(routePreview)).at(-1), blurredModifiers.board.footprints[1]);
      assert.equal(
        await canvas.locator('[data-route-snap-target]').getAttribute('data-route-snap-target'),
        'pad',
      );
      await clean();
      await page.keyboard.up('Control');
      await page.keyboard.up('Shift');
      await canvas.press('Enter');
      assert.equal((await state()).commits, 1);
      closePoint((await state()).board.tracks.at(-1).end, blurredModifiers.board.footprints[1]);
    },
  );

  for (const hidden of ['Footprints', 'F.Cu']) {
    const input = anchorFixture();
    await run(
      'hidden ' + hidden + ' objects do not attract routing starts',
      input,
      async ({ page, canvas, button, point, clean, routePreview }) => {
        const visibilitySection = hidden === 'Footprints' ? 'Visible objects' : 'Visible layers';
        await toggleLayoutVisualization(page, visibilitySection);
        await page
          .getByRole('group', { name: visibilitySection, exact: true })
          .getByRole('checkbox', { name: hidden, exact: true })
          .uncheck();
        await toggleLayoutVisualization(page, visibilitySection);
        await button('Route tracks').click();
        await point(input.board.footprints[0], true);
        closePoint((await head(routePreview))[0], { x: 18, y: 22 });
        assert.equal(await canvas.locator('[data-route-snap-target]').count(), 0);
        await canvas.press('Escape');
        await clean();
      },
    );
  }

  await run(
    'selection filters do not disable visible electrical routing anchors',
    anchorFixture(),
    async ({ board, page, canvas, button, point, clean, start, routePreview }) => {
      await toggleLayoutVisualization(page, 'Selection');
      for (const name of ['Footprints', 'Tracks', 'Vias'])
        await page
          .getByRole('group', { name: 'Selection', exact: true })
          .getByRole('checkbox', { name, exact: true })
          .uncheck();
      await toggleLayoutVisualization(page, 'Selection');
      await start();
      closePoint((await head(routePreview))[0], board.footprints[0]);
      await point(board.footprints[1]);
      closePoint((await head(routePreview)).at(-1), board.footprints[1]);
      await canvas.press('Escape');
      await clean();
    },
  );

  await run(
    'an empty-space route can still finish at the exact displayed grid head',
    anchorFixture(),
    async ({ canvas, point, state, start, routePreview }) => {
      await start();
      await point({ x: 33.13, y: 28.27 });
      const displayed = await head(routePreview);
      closePoint(displayed.at(-1), { x: 33, y: 28.5 });
      await canvas.press('Enter');
      assert.equal((await state()).commits, 1);
      closePoint((await state()).board.tracks.at(-1).end, displayed.at(-1));
    },
  );

  for (const gridDisabled of [false, true]) {
    const input = anchorFixture();
    await run(
      'pending via uses its own ' +
        (gridDisabled ? 'raw' : 'grid') +
        ' position without snapping to a pad',
      input,
      async ({ page, canvas, button, point, state, clean, start, viaPreview }) => {
        await start();
        await canvas.press('v');
        if (gridDisabled) await page.keyboard.down('Control');
        const raw = { x: 48.39, y: 22.41 };
        await point(raw);
        const expected = gridDisabled ? raw : { x: 48.5, y: 22.5 };
        const circle = viaPreview.locator('circle').first();
        closePoint(
          {
            x: Number(await circle.getAttribute('cx')),
            y: Number(await circle.getAttribute('cy')),
          },
          expected,
        );
        assert.equal(await canvas.locator('[data-route-snap-target]').count(), 0);
        assert.equal(await viaPreview.getAttribute('data-route-blocked'), 'false');
        await point(raw, true);
        await clean();
        const locked = canvas.locator('[data-route-locked-via] circle').first();
        closePoint(
          {
            x: Number(await locked.getAttribute('cx')),
            y: Number(await locked.getAttribute('cy')),
          },
          expected,
        );
        if (gridDisabled) await page.keyboard.up('Control');
        await point({ x: 55, y: 27.5 });
        await canvas.press('Enter');
        const result = await state();
        assert.equal(result.commits, 1);
        closePoint(result.board.vias.at(-1), expected);
        verifyPreservation(input.board, result.board, input.schematic);
        await button('Undo').click();
        assert.deepEqual((await state()).board, input.board);
      },
    );
  }
} finally {
  await browser.close();
}
