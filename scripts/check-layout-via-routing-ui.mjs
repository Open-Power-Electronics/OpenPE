import {
  routingFixture as fixture,
  verifyRoutingPreservation as verifyPreservation,
} from './layout-routing-test-helpers.mjs';
import { toggleLayoutVisualization } from './visualization-test-helpers.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { uid } = await tsImport('../lib/circuit.ts', import.meta.url);

// Real SVG pointer events in an isolated renderer, with mocked commits and undo.
// This check never starts Electron, a provider, a service or the user's workspace.
const bundle = await build({
  stdin: {
    contents: `import React,{useState,useLayoutEffect} from 'react';import {createRoot} from 'react-dom/client';
      import LayoutEditor from './components/LayoutEditor';
      function Test(){const [board,setBoard]=useState(window.fixture.board);const [history,setHistory]=useState([]);
        const [active,setActive]=useState(true);const [visible,setVisible]=useState(true);
        window.setLayoutActive=setActive;window.setLayoutVisible=setVisible;
        useLayoutEffect(()=>{window.layoutLifecycle={active:active&&visible,visible}},[active,visible]);
        window.historyDepth=history.length;
        return <LayoutEditor board={board} schematic={window.fixture.schematic} active={active&&visible} visible={visible}
          onCommit={next=>{window.lastBoard=next;window.commits++;setHistory([...history,board]);setBoard(next);return true}}
          undoAction={<button aria-label="Undo" disabled={!history.length} onClick={()=>{const next=history.at(-1);window.lastBoard=next;setBoard(next);setHistory(history.slice(0,-1))}}>Undo</button>}
          annotations={[]} annotationSessionId="via-routing" onAnnotationsChange={()=>{}}
          />}
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
  const button = (label) => page.getByRole('button', { name: label, exact: true });
  const point = async (p, click = false) => {
    const at = await canvas.evaluate((svg, position) => {
      const screen = new DOMPoint(position.x, position.y).matrixTransform(svg.getScreenCTM());
      return { x: screen.x, y: screen.y };
    }, p);
    await page.mouse.move(at.x, at.y);
    if (click) await page.mouse.click(at.x, at.y);
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
    console.log(`Layout via routing: ${name}.`);
  } finally {
    await page.close();
  }
}

try {
  const two = fixture();
  await run(
    'two-layer route commits front copper, through via and back copper as one undo edit',
    two,
    async ({ page, canvas, button, point, state, clean, start, viaPreview }) => {
      await start();
      const viaAt = { x: 32.5, y: 27.5 };
      await point(viaAt);
      const settings = page.getByRole('complementary', { name: 'Routing settings' });
      const diameter = settings.getByRole('spinbutton', { name: 'Via diameter (mm)', exact: true });
      const drill = settings.getByRole('spinbutton', { name: 'Via drill (mm)', exact: true });
      await diameter.fill('1.2');
      await diameter.press('Enter');
      await drill.fill('0.6');
      await drill.press('Enter');
      assert.equal(
        await viaPreview.count(),
        0,
        'Via dimensions can be configured before preparing a transition.',
      );
      await canvas.press('v');
      assert.equal(await viaPreview.count(), 1);
      await clean();
      const assertCardFits = async () => {
        const card = await settings.boundingBox();
        const surface = await canvas.boundingBox();
        assert.ok(card.x >= surface.x + 11 && card.y >= surface.y + 7);
        assert.ok(card.x + card.width <= surface.x + surface.width - 11);
        assert.ok(card.y + card.height <= surface.y + surface.height - 11);
        assert.equal(
          await settings.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
          true,
        );
        assert.equal(
          /\b(?:Backspace|Enter|Esc|Escape)\b/.test(await settings.innerText()),
          false,
          'The tool card contains no shortcut hint rows.',
        );
      };
      await assertCardFits();
      const originalTransform = await canvas.evaluate((svg) => {
        const matrix = svg.getScreenCTM();
        return { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f };
      });
      await page.screenshot({ path: 'test-results/layout-via-routing-light.png' });
      await page.evaluate(() => {
        document.documentElement.dataset.theme = 'dark';
        document.documentElement.style.setProperty('--canvas', '#15191e');
      });
      await page.setViewportSize({ width: 900, height: 640 });
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      await assertCardFits();
      await page.screenshot({ path: 'test-results/layout-via-routing-dark.png' });
      await page.evaluate(() => {
        document.documentElement.dataset.theme = 'light';
        document.documentElement.style.removeProperty('--canvas');
      });
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.waitForFunction((expected) => {
        const matrix = document.querySelector('[data-testid="layout-canvas"]').getScreenCTM();
        return Object.entries(expected).every(
          ([key, value]) => Math.abs(matrix[key] - value) < 0.0001,
        );
      }, originalTransform);
      await point(viaAt, true);
      assert.equal(await viaPreview.count(), 0);
      await point(two.board.footprints[1], true);
      const result = await state();
      assert.equal(result.commits, 1);
      assert.equal(result.historyDepth, 1);
      const addedTracks = result.board.tracks.slice(two.board.tracks.length);
      assert.ok(addedTracks.some((track) => track.layer === 'F.Cu'));
      assert.ok(addedTracks.some((track) => track.layer === 'B.Cu'));
      assert.deepEqual(addedTracks[0].start, {
        x: two.board.footprints[0].x,
        y: two.board.footprints[0].y,
      });
      assert.deepEqual(addedTracks.at(-1).end, {
        x: two.board.footprints[1].x,
        y: two.board.footprints[1].y,
      });
      const via = result.board.vias.at(-1);
      assert.equal(result.board.vias.length, two.board.vias.length + 1);
      assert.deepEqual(
        { ...via, id: '' },
        { id: '', ...viaAt, diameter: 1.2, drill: 0.6, netId: two.board.nets[0].id },
      );
      assert.ok(
        addedTracks.some(
          (track) => track.layer === 'F.Cu' && JSON.stringify(track.end) === JSON.stringify(viaAt),
        ),
      );
      assert.ok(
        addedTracks.some(
          (track) =>
            track.layer === 'B.Cu' && JSON.stringify(track.start) === JSON.stringify(viaAt),
        ),
      );
      verifyPreservation(two.board, result.board, two.schematic);
      await button('Undo').click();
      assert.deepEqual(
        (await state()).board,
        two.board,
        'A single Undo removes both-layer tracks and their via.',
      );
      assert.equal((await state()).historyDepth, 0);
    },
  );

  await run(
    'Escape cancels every locked segment and layer transition without writes',
    fixture(),
    async ({ canvas, point, clean, start, transition, routePreview, viaPreview }) => {
      await start();
      await transition({ x: 32.5, y: 27.5 });
      await point({ x: 38, y: 27.5 }, true);
      await canvas.press('Escape');
      assert.equal(await routePreview.count(), 0);
      assert.equal(await viaPreview.count(), 0);
      await clean();
    },
  );

  const hiddenDraft = fixture();
  await run(
    'leaving Layout cancels multi-layer copper and a pending via while retaining tool parameters',
    hiddenDraft,
    async ({
      page,
      canvas,
      button,
      point,
      clean,
      state,
      start,
      transition,
      routePreview,
      viaPreview,
    }) => {
      await start();
      const settings = page.getByRole('complementary', { name: 'Routing settings' });
      const width = settings.getByRole('spinbutton', { name: 'Track width (mm)', exact: true });
      await width.fill('0.6');
      await width.press('Enter');
      await transition({ x: 32.5, y: 27.5 });
      await point({ x: 38, y: 27.5 });
      await canvas.press('v');
      assert.equal(await viaPreview.count(), 1);
      assert.equal(await canvas.locator('[data-route-locked-via]').count(), 1);
      const view = await canvas.getAttribute('viewBox');
      await page.evaluate(() => window.setLayoutVisible(false));
      await page.waitForFunction(
        () =>
          !document.querySelector(
            '[data-route-preview], [data-route-locked-via], [data-route-via-preview]',
          ),
      );
      await clean();
      await page.evaluate(() => window.setLayoutVisible(true));
      await page.waitForFunction(() => window.layoutLifecycle?.active === true);
      await canvas.focus();
      assert.equal(await routePreview.count(), 0);
      assert.equal(await viaPreview.count(), 0);
      assert.equal(await canvas.getAttribute('viewBox'), view);
      assert.equal(await width.inputValue(), '0.6');
      assert.equal(await button('Route tracks').getAttribute('aria-pressed'), 'true');
      await canvas.press('Enter');
      await clean();
      // The retained tool starts a fresh transaction, with no revived legs.
      await point(hiddenDraft.board.footprints[0], true);
      await transition({ x: 32.5, y: 27.5 });
      await point(hiddenDraft.board.footprints[1], true);
      const result = await state();
      assert.equal(result.commits, 1);
      assert.equal(result.historyDepth, 1);
      assert.equal(result.board.vias.length, hiddenDraft.board.vias.length + 1);
      assert.ok(
        result.board.tracks
          .slice(hiddenDraft.board.tracks.length)
          .every((track) => track.width === 0.6),
      );
      verifyPreservation(hiddenDraft.board, result.board, hiddenDraft.schematic);
      await button('Undo').click();
      assert.deepEqual((await state()).board, hiddenDraft.board);
    },
  );

  const suspendedDraft = fixture({ endLayer: 'F.Cu' });
  await run(
    'temporary modal suspension keeps the visible multi-layer draft and prevents placement',
    suspendedDraft,
    async ({
      page,
      canvas,
      button,
      point,
      clean,
      state,
      start,
      transition,
      routePreview,
      viaPreview,
    }) => {
      await start();
      await transition({ x: 32.5, y: 27.5 });
      await point({ x: 38, y: 27.5 });
      await canvas.press('v');
      assert.equal(await viaPreview.count(), 1);
      const preview = await routePreview.getAttribute('points');
      await page.evaluate(() => window.setLayoutActive(false));
      // Programmatic React setters are asynchronous. Exercise the committed
      // suspension rather than racing its previous active keyboard handler.
      await page.waitForFunction(
        () => window.layoutLifecycle?.active === false && window.layoutLifecycle?.visible === true,
      );
      await canvas.press('Enter');
      assert.equal(await routePreview.getAttribute('points'), preview);
      assert.equal(await viaPreview.count(), 1);
      assert.equal(await canvas.locator('[data-route-locked-via]').count(), 1);
      await clean();
      await page.evaluate(() => window.setLayoutActive(true));
      await page.waitForFunction(() => window.layoutLifecycle?.active === true);
      await canvas.press('Enter');
      assert.equal(await viaPreview.count(), 0);
      assert.equal(await canvas.locator('[data-route-locked-via]').count(), 2);
      await clean();
      await point(suspendedDraft.board.footprints[1], true);
      const result = await state();
      assert.equal(result.commits, 1);
      assert.equal(result.historyDepth, 1);
      assert.equal(result.board.vias.length, suspendedDraft.board.vias.length + 2);
      verifyPreservation(suspendedDraft.board, result.board, suspendedDraft.schematic);
      await button('Undo').click();
      assert.deepEqual((await state()).board, suspendedDraft.board);
    },
  );

  const double = fixture({ endLayer: 'F.Cu' });
  await run(
    'double V cancels only the pending via and retains same-layer routing',
    double,
    async ({ canvas, point, state, clean, start, viaPreview }) => {
      await start();
      await point({ x: 32.5, y: 27.5 });
      await canvas.press('v');
      assert.equal(await viaPreview.count(), 1);
      await canvas.press('v');
      assert.equal(await viaPreview.count(), 0);
      await clean();
      await point(double.board.footprints[1], true);
      const result = await state();
      assert.equal(result.commits, 1);
      assert.deepEqual(result.board.vias, double.board.vias);
      assert.ok(
        result.board.tracks
          .slice(double.board.tracks.length)
          .every((track) => track.layer === 'F.Cu'),
      );
    },
  );

  await run(
    'the toolbar via action toggles a pending via without abandoning the route',
    fixture(),
    async ({ canvas, button, point, clean, start, routePreview, viaPreview }) => {
      await start();
      await point({ x: 32.5, y: 27.5 });
      await button('Place through via').click();
      assert.equal(await viaPreview.count(), 1);
      assert.equal(await button('Route tracks').getAttribute('aria-pressed'), 'true');
      assert.ok(await routePreview.count());
      await button('Place through via').click();
      assert.equal(await viaPreview.count(), 0);
      assert.equal(await button('Route tracks').getAttribute('aria-pressed'), 'true');
      await canvas.press('Escape');
      await clean();
    },
  );

  const chosen = fixture({ fourLayers: true });
  await run(
    'Layer keys select an inner target and Enter locks its via while continuing the draft',
    chosen,
    async ({ page, canvas, point, state, clean, start, viaPreview }) => {
      await start();
      await point({ x: 27.5, y: 27.5 });
      await canvas.press('+');
      assert.equal(await viaPreview.getAttribute('data-route-via-preview'), 'In1.Cu');
      await clean();
      await canvas.press('Enter');
      assert.equal(await viaPreview.count(), 0);
      assert.equal(await canvas.locator('[data-route-locked-via]').count(), 1);
      await clean();
      await point({ x: 38, y: 27.5 });
      await canvas.press('PageDown');
      assert.equal(await viaPreview.getAttribute('data-route-via-preview'), 'B.Cu');
      await point({ x: 38, y: 27.5 }, true);
      await clean();
      await point(chosen.board.footprints[1], true);
      const result = await state();
      assert.equal(result.commits, 1);
      assert.equal(result.board.vias.length, chosen.board.vias.length + 2);
      assert.deepEqual(
        [
          ...new Set(
            result.board.tracks.slice(chosen.board.tracks.length).map((track) => track.layer),
          ),
        ].sort(),
        ['B.Cu', 'F.Cu', 'In1.Cu'],
      );
      verifyPreservation(chosen.board, result.board, chosen.schematic);
    },
  );

  await run(
    'Priority layer cancels an unfinished multi-layer route without saving its drafts',
    fixture(),
    async ({ page, canvas, button, point, clean, start, transition, routePreview, viaPreview }) => {
      await start();
      await transition({ x: 28, y: 27.5 });
      await point({ x: 38, y: 27.5 });
      await canvas.press('v');
      assert.equal(await viaPreview.count(), 1);
      await toggleLayoutVisualization(page, 'Visible layers');
      await page
        .getByRole('group', { name: 'Visible layers', exact: true })
        .getByRole('button', { name: 'F.Cu', exact: true })
        .click();
      await toggleLayoutVisualization(page, 'Visible layers');
      assert.equal(await routePreview.count(), 0);
      assert.equal(await viaPreview.count(), 0);
      assert.equal(await canvas.locator('[data-route-locked-via]').count(), 0);
      await canvas.press('Enter');
      await clean();
    },
  );

  const backspace = fixture({ endLayer: 'F.Cu' });
  await run(
    'Backspace removes a waypoint then its preceding layer transition',
    backspace,
    async ({ canvas, point, state, clean, start, transition, viaPreview }) => {
      await start();
      await transition({ x: 32.5, y: 27.5 });
      await point({ x: 38, y: 27.5 }, true);
      await canvas.press('Backspace');
      await canvas.press('Backspace');
      assert.equal(await viaPreview.count(), 0);
      await clean();
      await point(backspace.board.footprints[1], true);
      const result = await state();
      assert.equal(result.commits, 1);
      assert.deepEqual(
        result.board.vias,
        backspace.board.vias,
        'Undoing the transition removes its pending through via.',
      );
      assert.ok(
        result.board.tracks
          .slice(backspace.board.tracks.length)
          .every((track) => track.layer === 'F.Cu'),
      );
    },
  );

  const four = fixture({ fourLayers: true, endLayer: 'F.Cu' });
  await run(
    'four-layer +, -, PageDown and PageUp transitions retain every copper layer',
    four,
    async ({ canvas, point, state, start, transition, button }) => {
      await start();
      const transitions = [
        { point: { x: 24, y: 25 }, key: '+', before: 'F.Cu', after: 'In1.Cu' },
        { point: { x: 30, y: 25 }, key: '+', before: 'In1.Cu', after: 'In2.Cu' },
        { point: { x: 36, y: 25 }, key: '-', before: 'In2.Cu', after: 'In1.Cu' },
        { point: { x: 42, y: 25 }, key: 'PageDown', before: 'In1.Cu', after: 'B.Cu' },
        { point: { x: 48, y: 25 }, key: 'PageUp', before: 'B.Cu', after: 'F.Cu' },
      ];
      for (const value of transitions) await transition(value.point, value.key);
      await point(four.board.footprints[1], true);
      const result = await state();
      assert.equal(result.commits, 1);
      assert.equal(result.historyDepth, 1);
      const added = result.board.tracks.slice(four.board.tracks.length);
      assert.deepEqual([...new Set(added.map((track) => track.layer))].sort(), [
        'B.Cu',
        'F.Cu',
        'In1.Cu',
        'In2.Cu',
      ]);
      assert.deepEqual(
        result.board.vias.slice(four.board.vias.length).map(({ x, y }) => ({ x, y })),
        transitions.map((value) => value.point),
      );
      for (const value of transitions) {
        assert.ok(
          added.some(
            (track) =>
              track.layer === value.before &&
              JSON.stringify(track.end) === JSON.stringify(value.point),
          ),
        );
        assert.ok(
          added.some(
            (track) =>
              track.layer === value.after &&
              JSON.stringify(track.start) === JSON.stringify(value.point),
          ),
        );
      }
      verifyPreservation(four.board, result.board, four.schematic);
      await button('Undo').click();
      assert.deepEqual((await state()).board, four.board);
    },
  );

  const revalidated = fixture();
  revalidated.board.tracks.push({
    id: uid(),
    start: { x: 23, y: 24.5 },
    end: { x: 28, y: 24.5 },
    width: 0.4,
    layer: 'F.Cu',
    netId: revalidated.board.nets[1].id,
  });
  await run(
    'width edits revalidate locked copper on a previous layer',
    revalidated,
    async ({ page, canvas, point, state, clean, start, transition, routePreview }) => {
      await start();
      await transition({ x: 32.5, y: 23 });
      await point(revalidated.board.footprints[1]);
      assert.equal(await routePreview.getAttribute('data-route-blocked'), 'false');
      const settings = page.getByRole('complementary', { name: 'Routing settings' });
      const width = settings.getByRole('spinbutton', { name: 'Track width (mm)', exact: true });
      await width.fill('3');
      await width.press('Enter');
      assert.equal(
        await routePreview.getAttribute('data-route-blocked'),
        'true',
        'A wider front-layer leg must block completion while the active back layer is clear.',
      );
      await canvas.press('Enter');
      await clean();
      await width.fill('0.4');
      await width.press('Enter');
      assert.equal(await routePreview.getAttribute('data-route-blocked'), 'false');
      await point(revalidated.board.footprints[1], true);
      const result = await state();
      assert.equal(result.commits, 1);
      assert.equal(result.board.vias.length, revalidated.board.vias.length + 1);
      assert.ok(
        result.board.tracks
          .slice(revalidated.board.tracks.length)
          .every((track) => track.width === 0.4),
      );
      verifyPreservation(revalidated.board, result.board, revalidated.schematic);
    },
  );

  const sizes = fixture({ endLayer: 'F.Cu' });
  await run(
    'changing pending via geometry preserves earlier locked via dimensions',
    sizes,
    async ({ page, canvas, point, state, clean, start, transition, viaPreview }) => {
      await start();
      const first = { x: 30, y: 27.5 };
      const second = { x: 40, y: 27.5 };
      await transition(first);
      await point(second);
      await canvas.press('v');
      const settings = page.getByRole('complementary', { name: 'Routing settings' });
      const diameter = settings.getByRole('spinbutton', { name: 'Via diameter (mm)', exact: true });
      const drill = settings.getByRole('spinbutton', { name: 'Via drill (mm)', exact: true });
      await diameter.fill('1.6');
      await diameter.press('Enter');
      await drill.fill('0.7');
      await drill.press('Enter');
      assert.equal(await viaPreview.getAttribute('data-route-blocked'), 'false');
      await clean();
      await point(second, true);
      assert.equal(await canvas.locator('[data-route-locked-via]').count(), 2);
      await point(sizes.board.footprints[1], true);
      const result = await state();
      assert.equal(result.commits, 1);
      assert.deepEqual(
        result.board.vias
          .slice(sizes.board.vias.length)
          .map(({ x, y, diameter, drill }) => ({ x, y, diameter, drill })),
        [
          { ...first, diameter: 0.8, drill: 0.4 },
          { ...second, diameter: 1.6, drill: 0.7 },
        ],
      );
      verifyPreservation(sizes.board, result.board, sizes.schematic);
    },
  );

  for (const layer of ['B.Cu', 'In2.Cu']) {
    const blocked = fixture({ fourLayers: true });
    blocked.board.tracks.push({
      id: uid(),
      start: { x: 29.5, y: 27.5 },
      end: { x: 35.5, y: 27.5 },
      width: 0.8,
      layer,
      netId: blocked.board.nets[1].id,
    });
    await run(
      `a hidden ${layer} obstacle rejects the through via across all copper layers`,
      blocked,
      async ({ page, canvas, button, point, clean, start, viaPreview }) => {
        await toggleLayoutVisualization(page, 'Visible layers');
        await page.getByRole('checkbox', { name: layer, exact: true }).uncheck();
        await toggleLayoutVisualization(page, 'Visible layers');
        await start();
        await point({ x: 32.5, y: 27.5 });
        await canvas.press('v');
        assert.equal(await viaPreview.getAttribute('data-route-blocked'), 'true');
        await point({ x: 32.5, y: 27.5 }, true);
        await clean();
        await canvas.press('Enter');
        await clean();
        await canvas.press('Escape');
        await clean();
      },
    );
  }

  for (const geometry of [
    { existing: { diameter: 3, drill: 0.2 }, candidate: { diameter: 1, drill: 0.8 } },
    { existing: { diameter: 1, drill: 0.8 }, candidate: { diameter: 3, drill: 0.2 } },
  ]) {
    const mutual = fixture();
    mutual.board.vias.push({
      id: uid(),
      x: 32.5,
      y: 27.5,
      ...geometry.existing,
      netId: mutual.board.nets[0].id,
    });
    await run(
      `same-net ${geometry.existing.diameter} mm and ${geometry.candidate.diameter} mm vias enforce mutual copper-to-hole clearance`,
      mutual,
      async ({ page, canvas, point, state, clean, start, viaPreview }) => {
        await start();
        await point({ x: 34.5, y: 27.5 });
        await canvas.press('v');
        const settings = page.getByRole('complementary', { name: 'Routing settings' });
        const diameter = settings.getByRole('spinbutton', {
          name: 'Via diameter (mm)',
          exact: true,
        });
        const drill = settings.getByRole('spinbutton', { name: 'Via drill (mm)', exact: true });
        await diameter.fill(String(geometry.candidate.diameter));
        await diameter.press('Enter');
        await drill.fill(String(geometry.candidate.drill));
        await drill.press('Enter');
        assert.equal(
          await viaPreview.locator('circle').first().getAttribute('cx'),
          '34.5',
          'The candidate is outside the existing copper hit target.',
        );
        assert.equal(await viaPreview.getAttribute('data-route-blocked'), 'true');
        await point({ x: 34.5, y: 27.5 }, true);
        await clean();
        await canvas.press('Enter');
        await clean();
        await point({ x: 35, y: 27.5 });
        assert.equal(await viaPreview.getAttribute('data-route-blocked'), 'false');
        await point({ x: 35, y: 27.5 }, true);
        await point(mutual.board.footprints[1], true);
        const result = await state();
        assert.equal(result.commits, 1);
        assert.equal(result.board.vias.length, mutual.board.vias.length + 1);
        assert.deepEqual(
          { ...result.board.vias.at(-1), id: '' },
          { id: '', x: 35, y: 27.5, ...geometry.candidate, netId: mutual.board.nets[0].id },
        );
        verifyPreservation(mutual.board, result.board, mutual.schematic);
      },
    );
  }

  const keepout = fixture();
  keepout.board.zones.push({
    id: uid(),
    netId: null,
    layer: 'F.Cu',
    outline: [
      { x: 30, y: 25 },
      { x: 35, y: 25 },
      { x: 35, y: 30 },
      { x: 30, y: 30 },
    ],
    clearance: 0.25,
    minThickness: 0.2,
    thermalGap: 0.3,
    thermalBridge: 0.3,
    keepout: { tracks: false, vias: true, pads: false, copperpour: false, footprints: false },
  });
  await run(
    'a via-only keepout permits a track head but blocks its pending through via',
    keepout,
    async ({ canvas, point, clean, start, routePreview, viaPreview }) => {
      await start();
      await point({ x: 32.5, y: 27.5 });
      assert.equal(await routePreview.getAttribute('data-route-blocked'), 'false');
      await canvas.press('v');
      assert.equal(await viaPreview.getAttribute('data-route-blocked'), 'true');
      await point({ x: 32.5, y: 27.5 }, true);
      await clean();
      await canvas.press('Escape');
      await clean();
    },
  );
} finally {
  await browser.close();
}
