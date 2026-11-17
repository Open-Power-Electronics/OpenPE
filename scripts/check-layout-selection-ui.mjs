import { runCanvasAction } from './canvas-context-menu-test-helpers.mjs';
import { closeDisplayDrawer, toggleLayoutVisualization } from './visualization-test-helpers.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { emptyCircuit } = await tsImport('../lib/circuit.ts', import.meta.url);
const { createEmptyPCB, flipPCBFootprint } = await tsImport(
  '../lib/pcb-layout.ts',
  import.meta.url,
);

// Isolated renderer: real pointer dispatch, no Electron, user data or service requests.
const bundle = await build({
  stdin: {
    contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
      import LayoutEditor from './components/LayoutEditor';
      function Test(){const [board,setBoard]=useState(window.fixture.board);
        return <LayoutEditor board={board} schematic={window.fixture.schematic} active
          onCommit={next=>{window.lastBoard=next;window.commits++;setBoard(next);return true}}
          annotations={[]} annotationSessionId="selection" onAnnotationsChange={()=>{}}/>}
      createRoot(document.getElementById('root')).render(<Test/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const outline = (id, minX = -1, minY = -1, maxX = 1, maxY = 1) => ({
  id,
  kind: 'polygon',
  start: { x: minX, y: minY },
  end: { x: minX, y: maxY },
  points: [
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
  ],
  width: 0.12,
  layer: 'F.SilkS',
});
const reference = (id, x = 0, y = -3) => ({
  id,
  kind: 'text',
  start: { x, y },
  end: { x, y },
  width: 0.15,
  layer: 'F.SilkS',
  text: {
    value: '${REFERENCE}',
    property: 'Reference',
    rotation: 0,
    size: { x: 1, y: 1 },
    thickness: 0.15,
  },
});
const footprint = (id, x, y) => ({
  id,
  x,
  y,
  symbolId: null,
  libraryId: 'Test:Selection',
  reference: id,
  rotation: 0,
  side: 'front',
  pads: [
    {
      id: `${id}-pad`,
      number: '1',
      x: 0,
      y: 0,
      rotation: 0,
      type: 'smd',
      shape: 'rect',
      size: { x: 1, y: 1 },
      netId: null,
    },
  ],
  graphics: [outline(`${id}-outline`), reference(`${id}-reference`)],
});
const cases = [
  {
    name: 'reference text cannot enlarge a neighbouring footprint target',
    neighbour: {
      ...footprint('B2', 30, 20),
      graphics: [outline('B2-outline'), reference('B2-reference', -10, -5)],
    },
  },
  {
    name: 'rotated bodies do not select empty corners of their world bounding box',
    neighbour: {
      ...footprint('B2', 24, 24),
      rotation: 45,
      graphics: [outline('B2-outline', -6, -0.5, 6, 0.5), reference('B2-reference', 0, -2)],
    },
  },
  {
    name: 'a footprint remains selectable when its visible pad overlaps another footprint body',
    overlap: true,
    neighbour: {
      ...footprint('B2', 24, 20),
      pads: [-5, 5].map((x, i) => ({ ...footprint('B2', 0, 0).pads[0], id: `B2-pad-${i}`, x })),
      graphics: [outline('B2-outline', -5, -2, 5, 2), reference('B2-reference')],
    },
  },
  {
    name: 'hidden copper pads do not enlarge a visible silkscreen target',
    hideBack: true,
    neighbour: {
      ...footprint('B2', 30, 20),
      pads: [{ ...footprint('B2', 0, 0).pads[0], x: -10, layers: ['B.Cu'] }],
    },
  },
  {
    name: 'flipped rotated footprints use their actual local body',
    neighbour: flipPCBFootprint({
      ...footprint('B2', 24, 16),
      rotation: 45,
      graphics: [outline('B2-outline', -6, -0.5, 6, 0.5), reference('B2-reference', 0, -2)],
    }),
  },
];
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});
try {
  for (const test of cases) {
    const board = { ...createEmptyPCB(), footprints: [footprint('A1', 20, 20), test.neighbour] };
    const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
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
      { board, schematic: emptyCircuit() },
    );
    for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
      await page.addStyleTag({ content: await readFile(file, 'utf8') });
    await page.addStyleTag({
      content: 'html,body,#root{height:100%;margin:0}.layout-editor{height:100%}',
    });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const canvas = page.getByTestId('layout-canvas');
    await canvas.waitFor();
    const button = (name) => page.getByRole('button', { name, exact: true });
    // These cases exercise footprint pickup through copper, rather than pad inspection.
    await toggleLayoutVisualization(page, 'Selection');
    await page
      .getByRole('group', { name: 'Selection', exact: true })
      .getByRole('checkbox', { name: 'Pads', exact: true })
      .uncheck();
    await toggleLayoutVisualization(page, 'Selection');
    if (test.hideBack) {
      await toggleLayoutVisualization(page, 'Visible layers');
      await page.getByRole('checkbox', { name: 'B.Cu', exact: true }).uncheck();
      await toggleLayoutVisualization(page, 'Visible layers');
    }
    const screenPoint = (point) =>
      canvas.evaluate((svg, p) => {
        const at = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
        return { x: at.x, y: at.y };
      }, point);
    const clickA = async (point = { x: 20, y: 20 }) => {
      const at = await screenPoint(point);
      await page.mouse.click(at.x, at.y);
      const chooser = page.getByRole('menu', { name: 'Choose layout object', exact: true });
      assert.equal(await chooser.count(), 0, 'Footprint geometry resolves without an object menu.');
      assert.equal(
        await canvas
          .locator('.layout-footprint.selected')
          .first()
          .getAttribute('data-selection-id'),
        'A1',
        test.name,
      );
    };
    await clickA();
    // The interior remains selectable without requiring a click directly on copper.
    if (!test.overlap) await clickA({ x: 20.75, y: 20.75 });
    await closeDisplayDrawer(page, 'Properties');
    await runCanvasAction(page, 'Actual size (100%)');
    await page.setViewportSize({ width: 900, height: 640 });
    await page.waitForTimeout(100);
    await clickA();
    await closeDisplayDrawer(page, 'Properties');
    await runCanvasAction(page, 'Fit board to canvas');
    await canvas.press('Control+Home');
    const at = await screenPoint({ x: 20, y: 20 });
    await page.mouse.move(at.x, at.y);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(at.x + 23, at.y + 17, { steps: 3 });
    await page.mouse.up({ button: 'right' });
    await clickA();
    assert.equal(
      await page.evaluate(() => window.commits),
      0,
      'Selection, zoom, resize and pan leave design data clean.',
    );
    const start = await screenPoint({ x: 20, y: 20 });
    const finish = await screenPoint({ x: 22.54, y: 21.27 });
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(finish.x, finish.y, { steps: 4 });
    await page.mouse.up();
    const result = await page.evaluate(() => ({
      board: window.lastBoard,
      commits: window.commits,
    }));
    assert.equal(result.commits, 1, 'Dragging commits exactly once.');
    assert.equal(result.board.footprints[0].x, 22.5);
    assert.equal(result.board.footprints[0].y, 21.5);
    assert.deepEqual(
      result.board.footprints[1],
      board.footprints[1],
      'Only the clicked footprint moves.',
    );
    assert.deepEqual(errors, []);
    console.log(`Layout selection: ${test.name}.`);
    await page.close();
  }
} finally {
  await browser.close();
}
