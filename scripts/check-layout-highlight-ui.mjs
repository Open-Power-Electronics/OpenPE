import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { tsImport } from 'tsx/esm/api';
import { setLayoutVisibility, toggleLayoutVisualization } from './visualization-test-helpers.mjs';

const { emptyCircuit } = await tsImport('../lib/circuit.ts', import.meta.url);
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const { fillCopperZones } = await tsImport('../lib/pcb-polygons.ts', import.meta.url);
const rectangle = (x, y, width, height) => [
  { x, y },
  { x: x + width, y },
  { x: x + width, y: y + height },
  { x, y: y + height },
];
const edges = rectangle(0, 0, 60, 40);
const board = fillCopperZones({
  ...createEmptyPCB(),
  nets: [
    { id: 'gnd', name: 'GND' },
    { id: 'signal', name: 'SIGNAL' },
  ],
  graphics: edges.map((start, i) => ({
    id: `edge-${i}`,
    layer: 'Edge.Cuts',
    width: 0.1,
    start,
    end: edges[(i + 1) % 4],
  })),
  footprints: ['front', 'back'].map((side, i) => ({
    id: `footprint-${side}`,
    libraryId: 'Test:Highlight',
    symbolId: null,
    reference: i ? 'U2' : 'U1',
    x: i ? 45 : 15,
    y: 10,
    rotation: i ? 30 : 0,
    side,
    pads: [
      {
        id: `pad-${side}`,
        number: '1',
        x: 0,
        y: 0,
        rotation: 0,
        type: 'thru_hole',
        shape: 'circle',
        size: { x: 2.5, y: 2.5 },
        drill: 0.8,
        netId: 'gnd',
      },
    ],
    graphics: [
      {
        id: `body-${side}`,
        layer: i ? 'B.SilkS' : 'F.SilkS',
        start: { x: -3, y: -2 },
        end: { x: 3, y: -2 },
        width: 0.12,
      },
    ],
  })),
  tracks: ['F.Cu', 'B.Cu'].map((layer, i) => ({
    id: `track-${i}`,
    layer,
    netId: 'signal',
    width: 0.8,
    start: { x: i ? 38 : 8, y: 28 },
    end: { x: i ? 52 : 22, y: 28 },
  })),
  vias: [{ id: 'via', x: 18, y: 34, diameter: 1.8, drill: 0.6, netId: 'gnd' }],
  zones: ['F.Cu', 'B.Cu'].map((layer, i) => ({
    id: `zone-${i}`,
    layer,
    netId: 'gnd',
    outline: rectangle(i ? 33 : 3, 3, 24, 34),
    holes: [rectangle(i ? 43 : 13, 18, 4, 4)],
    clearance: 0.3,
    minThickness: 0.1,
    thermalGap: 0.3,
    thermalBridge: 0.3,
  })),
});

// Real pointer dispatch and rendered pixels in an isolated renderer, with no desktop/service I/O.
const bundle = await build({
  stdin: {
    contents: `import React,{useRef} from 'react';import {createRoot} from 'react-dom/client';
      import LayoutEditor from './components/LayoutEditor';
      import {captureLayoutPNG} from './lib/drawing-export';
      function Test(){const context=useRef(null);window.layoutContext=context;
        window.captureBoard=()=>captureLayoutPNG(document.querySelector('[data-testid="layout-canvas"]'),
          {minX:-2,minY:-2,maxX:62,maxY:42});
        return <LayoutEditor board={window.fixture.board} schematic={window.fixture.schematic} active grid={false}
          agentContextRef={context} onCommit={()=>{window.commits++;return true}}
          annotations={[]} annotationSessionId="highlight" onAnnotationsChange={()=>{}}/>}
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
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});
await mkdir('test-results/layout-highlight', { recursive: true });
try {
  for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({
      viewport: { width: 1100, height: 800 },
      colorScheme: theme,
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('http://localhost/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
    );
    await page.goto('http://localhost');
    await page.evaluate(
      ({ board, schematic, theme }) => {
        window.fixture = { board, schematic };
        window.commits = 0;
        document.documentElement.dataset.theme = theme;
        if (theme === 'dark') document.documentElement.style.setProperty('--canvas', '#18222d');
      },
      { board, schematic: emptyCircuit(), theme },
    );
    for (const content of styles) await page.addStyleTag({ content });
    await page.addStyleTag({ content: 'html,body,#root,.layout-editor{height:100%;margin:0}' });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const canvas = page.getByTestId('layout-canvas');
    await canvas.waitFor();
    await page.waitForFunction(
      (theme) => document.querySelector('.layout-editor')?.dataset.pcbTheme === theme,
      theme,
    );
    const point = (x, y) =>
      canvas.evaluate(
        (svg, p) => {
          const screen = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
          return { x: screen.x, y: screen.y };
        },
        { x, y },
      );
    const click = async (x, y, modifiers = []) => {
      const p = await point(x, y);
      for (const key of modifiers) await page.keyboard.down(key);
      await page.mouse.click(p.x, p.y);
      for (const key of modifiers.toReversed()) await page.keyboard.up(key);
    };
    const clear = async () => {
      await canvas.press('Escape');
      const close = page.getByRole('button', { name: 'Close properties', exact: true });
      if (await close.isVisible()) await close.click();
    };
    const pixel = async (x, y) => {
      const p = await point(x, y);
      const { data, info } = await sharp(await page.screenshot())
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const at = (Math.round(p.y) * info.width + Math.round(p.x)) * info.channels;
      return [...data.subarray(at, at + 3)];
    };
    const selected = () =>
      page.evaluate(() => window.layoutContext.current.selection.map((s) => s.id).sort());
    const capture = async () => {
      const { dataUrl } = await page.evaluate(() => window.captureBoard());
      return sharp(Buffer.from(dataUrl.split(',')[1], 'base64'))
        .raw()
        .toBuffer();
    };
    const originalExport = await capture();
    const originalFill = await pixel(8, 18);
    const originalHole = await pixel(15, 20);
    const originalBack = await pixel(38, 18);
    const fillPath = await canvas.locator('[data-copper-zone="zone-0"]').getAttribute('d');
    await click(8, 18);
    assert.deepEqual(await selected(), ['zone-0'], 'Clicking the saved copper selects its zone.');
    assert.notDeepEqual(
      await pixel(8, 18),
      originalFill,
      'Selected copper changes visible colour.',
    );
    assert.deepEqual(await pixel(15, 20), originalHole, 'Selection preserves the real hole.');
    assert.deepEqual(await pixel(38, 18), originalBack, 'Other copper keeps its original paint.');
    assert.equal(await canvas.locator('[data-copper-zone="zone-0"]').getAttribute('d'), fillPath);
    assert.deepEqual(await capture(), originalExport, 'Image export excludes selected paint.');
    await canvas.screenshot({ path: `test-results/layout-highlight/${theme}-zone.png` });

    await clear();
    await setLayoutVisibility(page, 'Zone outlines', false);
    const hiddenOutlineFill = await pixel(8, 18);
    await click(8, 18);
    assert.notDeepEqual(
      await pixel(8, 18),
      hiddenOutlineFill,
      'Filled copper highlights with zone outlines hidden.',
    );
    await clear();
    await click(38, 18);
    assert.deepEqual(await selected(), ['zone-1']);
    assert.notDeepEqual(
      await pixel(38, 18),
      originalBack,
      'Back copper also highlights in its own hue.',
    );
    await clear();

    const originalTrack = await pixel(10, 28);
    await click(10, 28);
    assert.deepEqual(await selected(), ['track-0']);
    const frontTrack = await pixel(10, 28);
    assert.notDeepEqual(frontTrack, originalTrack);
    assert.ok(frontTrack[0] > frontTrack[2], 'Selected front copper retains its red hue.');
    const originalBackTrack = await pixel(40, 28);
    await click(40, 28, ['Shift']);
    const backTrack = await pixel(40, 28);
    assert.notDeepEqual(backTrack, originalBackTrack);
    assert.ok(backTrack[2] > backTrack[0], 'Selected back copper retains its blue hue.');
    assert.deepEqual(await selected(), ['track-0', 'track-1']);
    for (const track of board.tracks) {
      const widths = await canvas
        .locator(`[data-selection-id="${track.id}"] line[stroke-linecap]`)
        .evaluateAll((lines) => lines.map((line) => Number(line.getAttribute('stroke-width'))));
      assert.deepEqual(
        widths,
        [track.width, track.width],
        'Selection preserves the displayed copper width.',
      );
    }
    await clear();
    const viaRing = await pixel(18.6, 34);
    const viaHole = await pixel(18, 34);
    await click(18.6, 34);
    assert.deepEqual(await selected(), ['via']);
    assert.notDeepEqual(await pixel(18.6, 34), viaRing);
    assert.deepEqual(await pixel(18, 34), viaHole, 'Selected via retains its drilled hole.');
    await clear();

    const padRing = await pixel(15, 10.8);
    const padHole = await pixel(15, 10);
    await click(15.8, 10);
    assert.deepEqual(await selected(), ['footprint-front']);
    assert.notDeepEqual(await pixel(15, 10.8), padRing);
    assert.deepEqual(await pixel(15, 10), padHole);
    await canvas.screenshot({ path: `test-results/layout-highlight/${theme}-footprint.png` });
    await clear();
    // A selected item must remain legible when another net is highlighted;
    // that selection-only opacity change must also stay out of exports.
    const signal = await point(10, 28);
    await page.mouse.move(signal.x, signal.y);
    await canvas.press('`');
    const highlightedExport = await capture();
    await click(8, 18);
    assert.deepEqual(await selected(), ['zone-0']);
    assert.equal(
      await canvas.locator('[data-copper-zone="zone-0"]').locator('..').getAttribute('opacity'),
      '0.8',
      'Selected copper stays visible while a different net is highlighted.',
    );
    assert.deepEqual(
      await capture(),
      highlightedExport,
      'Export retains net dimming independently of selection.',
    );
    await clear();
    await toggleLayoutVisualization(page, 'Selection');
    await page.getByRole('checkbox', { name: 'Pads', exact: true }).check();
    await toggleLayoutVisualization(page, 'Selection');
    await click(15.8, 10);
    assert.equal(
      await page.getByRole('menu', { name: 'Choose layout object', exact: true }).count(),
      0,
      'Enabled pad inspection resolves directly without an object menu.',
    );
    assert.deepEqual(await selected(), []);
    assert.notDeepEqual(
      await pixel(15, 10.8),
      padRing,
      'Individual pad inspection highlights that pad.',
    );
    assert.deepEqual(await pixel(15, 10), padHole);
    assert.equal(await page.evaluate(() => window.commits), 0);
    assert.deepEqual(
      await page.evaluate(() => window.fixture.board),
      board,
      'Selection leaves all native geometry and saved fills unchanged.',
    );
    assert.deepEqual(errors, []);
    console.log(
      `Layout highlight: ${theme} copper, holes, tracks, vias, footprints, pads and clean exports.`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
