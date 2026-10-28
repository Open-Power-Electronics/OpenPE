// Isolated EMC Flyback renderer; no Electron, services, user destinations or writes.
// Timings cover pointer dispatch through two animation frames, excluding desktop delivery.
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { parseProject } = await tsImport('../lib/project.ts', import.meta.url);
const { createPCBRouter } = await tsImport('../lib/pcb-routing.ts', import.meta.url);
const { padCopperLayers } = await tsImport('../lib/pcb-connectivity.ts', import.meta.url);
const { padPosition, pcbBounds } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const project = parseProject(await readFile('lib/emc-flyback-example.json', 'utf8'));
const board = project.pcb;
assert.ok(board);
const mode = process.argv[2] ?? 'local';
assert.ok(['local', 'detour-a', 'detour-b'].includes(mode), 'Choose local, detour-a or detour-b.');
const bounds = pcbBounds(board),
  centre = {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
  };
const pads = board.footprints.flatMap((footprint) =>
  footprint.pads.flatMap((pad) =>
    pad.netId && padCopperLayers(board, footprint, pad).includes('F.Cu')
      ? [{ point: padPosition(footprint, pad), netId: pad.netId }]
      : [],
  ),
);
pads.sort(
  (a, b) =>
    Math.hypot(a.point.x - centre.x, a.point.y - centre.y) -
    Math.hypot(b.point.x - centre.x, b.point.y - centre.y),
);
let sample;
for (const pad of mode === 'local' ? pads.slice(0, 50) : []) {
  const router = createPCBRouter(board, {
    layer: 'F.Cu',
    netId: pad.netId,
    width: 0.4,
    clearance: 0.25,
  });
  if (router.validate([pad.point])) continue;
  for (const [dx, dy] of [
    [5, 3],
    [-5, 3],
    [5, -3],
    [-5, -3],
    [8, 0],
  ]) {
    const end = {
      x: Math.round((pad.point.x + dx) * 2) / 2,
      y: Math.round((pad.point.y + dy) * 2) / 2,
    };
    const results = [-0.5, 0, 0.5].map((delta) =>
      router.route(pad.point, { ...end, x: end.x + delta }),
    );
    if (results.every((result) => !result.blocked && result.points.length > 1)) {
      sample = { start: pad.point, end };
      break;
    }
  }
  if (sample) break;
}
if (mode !== 'local') {
  const track = board.tracks.find((track) => track.id === '33cdc88b-d74e-4100-8239-7380156abb0b');
  assert.ok(track, 'Retain the pinned EMC route anchor.');
  sample = {
    start: { x: 77.78, y: 119 },
    end: { x: 81.52, y: mode === 'detour-a' ? 122.86 : 114.86 },
    free: true,
  };
  const router = createPCBRouter(board, {
    layer: 'F.Cu',
    netId: track.netId,
    width: 0.4,
    clearance: 0.25,
  });
  const result = router.route(sample.start, sample.end);
  assert.ok(
    !result.blocked && result.points.length >= 5,
    'The detour fixture must exercise obstacle search.',
  );
}
assert.ok(sample, 'Find a legal local route on the actual EMC board.');
const bundle = await build({
  stdin: {
    contents: `import React from 'react';import{createRoot}from'react-dom/client';
import LayoutEditor from './components/LayoutEditor';import{ownProjectData}from'./lib/immutable-project';
const project=ownProjectData(window.fixture);window.commits=0;
createRoot(document.getElementById('root')).render(<LayoutEditor board={project.pcb} schematic={project.schematic}
active onCommit={()=>{window.commits++;return false}} annotations={[]} annotationSessionId="route-latency"
onAnnotationsChange={()=>{}}/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [
    {
      name: 'time-route-search',
      setup(plugin) {
        plugin.onLoad({ filter: /[\\/]pcb-routing\.ts$/ }, async ({ path }) => {
          let source = await readFile(path, 'utf8');
          const signature = /  function route\([\s\S]*?\): RouteResult \{/;
          const tail = /\n  }\r?\n  return \{ route, validate, validateRegion \};/;
          assert.match(source, signature);
          assert.match(source, tail);
          source = source
            .replace(signature, '$&\n    const previewStarted = performance.now();try {')
            .replace(
              tail,
              '\n    } finally { (window.routeTimings ??= []).push(performance.now() - previewStarted); }\n  }\n  return { route, validate, validateRegion };',
            );
          return { contents: source, loader: 'ts' };
        });
      },
    },
  ],
});
await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel: process.platform === 'win32' ? 'msedge' : undefined,
});
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
    window.routeTimings = [];
  }, project);
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({ content: 'html,body,#root,.layout-editor{height:100%;margin:0}' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const canvas = page.getByTestId('layout-canvas');
  await canvas.waitFor();
  await page.getByRole('button', { name: 'Route tracks', exact: true }).click();
  const screenPoint = (point) =>
    canvas.evaluate((svg, p) => {
      const at = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
      return { x: at.x, y: at.y };
    }, point);
  const start = await screenPoint(sample.start);
  await page.mouse.click(start.x, start.y);
  const routeSelector = '[data-route-blocked]';
  await canvas.locator(routeSelector).first().waitFor({ state: 'attached' });
  const move = (point) =>
    canvas.evaluate(
      async (svg, p) => {
        const screen = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
        const previousSearches = window.routeTimings.length;
        const began = performance.now();
        svg.dispatchEvent(
          new PointerEvent('pointermove', {
            bubbles: true,
            pointerId: 1,
            shiftKey: true,
            ctrlKey: Boolean(p.gridDisabled),
            clientX: screen.x,
            clientY: screen.y,
          }),
        );
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const line = svg.querySelector('[data-route-blocked]');
        return {
          inputToFrameMs: performance.now() - began,
          searches: window.routeTimings.length - previousSearches,
          blocked: line?.getAttribute('data-route-blocked'),
          points: line?.getAttribute('points'),
        };
      },
      { ...point, gridDisabled: sample.free },
    );
  const cold = await move(sample.end);
  assert.equal(cold.blocked, 'false');
  const endpoint = (result) => result.points.split(' ').at(-1).split(',').map(Number);
  assert.ok(
    cold.searches > 0 && cold.points.split(' ').length > 1,
    'The cold head must perform a nonzero route search.',
  );
  assert.deepEqual(endpoint(cold), [sample.end.x, sample.end.y]);
  assert.deepEqual(
    cold.points.split(' ')[0].split(',').map(Number),
    [sample.start.x, sample.start.y],
    'The actual renderer must use the selected real-copper anchor.',
  );
  const warm = [];
  let previous = cold;
  const step = sample.free ? 0.02 : 0.5;
  for (const delta of [step, 0, -step, 0, step, 0, -step, 0]) {
    const next = await move({ ...sample.end, x: sample.end.x + delta });
    assert.equal(next.blocked, 'false');
    assert.deepEqual(endpoint(next), [Number((sample.end.x + delta).toFixed(6)), sample.end.y]);
    assert.ok(
      next.searches > 0 && next.points !== previous.points,
      'Each changed grid head must run a fresh search and change the preview.',
    );
    warm.push(next);
    previous = next;
  }
  const jitter = [];
  for (const delta of sample.free ? [0, 0, 0, 0] : [-0.02, 0.02, -0.01, 0.01])
    jitter.push(await move({ ...sample.end, x: sample.end.x + delta }));
  assert.ok(
    jitter.every((result) => result.searches === 0 && result.points === warm.at(-1).points),
    'Same resolved endpoint reuses the path on the complete EMC board.',
  );
  assert.equal(await page.evaluate(() => window.commits), 0);
  assert.deepEqual(errors, []);
  const routeTimings = await page.evaluate(() => window.routeTimings);
  const report = {
    scope:
      'Isolated headless EMC renderer, synthetic pointer dispatch through two animation frames; excludes route pickup, desktop delivery and native I/O. Object snapping disabled to verify distinct grid heads.',
    board: {
      footprints: board.footprints.length,
      tracks: board.tracks.length,
      vias: board.vias.length,
    },
    sample,
    mode,
    cold,
    warm,
    jitter,
    routeTimings,
    maximumInputToFrameMs: Math.max(
      cold.inputToFrameMs,
      ...warm.map((result) => result.inputToFrameMs),
      ...jitter.map((result) => result.inputToFrameMs),
    ),
    maximumRouteMs: Math.max(...routeTimings),
  };
  await writeFile(
    `test-results/layout-route-preview-latency-${mode}.json`,
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({
      maximumInputToFrameMs: report.maximumInputToFrameMs,
      maximumRouteMs: report.maximumRouteMs,
      sameEndpointSearches: jitter.reduce((sum, result) => sum + result.searches, 0),
      report: `test-results/layout-route-preview-latency-${mode}.json`,
    }),
  );
  // A budget result is evidence, never a reason to skip correctness assertions.
  if (report.maximumInputToFrameMs >= 100) process.exitCode = 1;
} finally {
  await browser.close();
}
