import {
  toggleLayoutVisualization,
  selectLayoutLayer,
  setLayoutVisibility,
} from './visualization-test-helpers.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { emptyCircuit, createPart } = await tsImport('../lib/circuit.ts', import.meta.url);
const { createEmptyPCB, createPCBFootprint, flipPCBFootprint, padPosition } = await tsImport(
  '../lib/pcb-layout.ts',
  import.meta.url,
);
const { parseSExpr } = await tsImport('../lib/sexpr.ts', import.meta.url);
const { serializePCB } = await tsImport('../lib/pcb.ts', import.meta.url);
const { boardPolygons } = await tsImport('../lib/pcb-polygons.ts', import.meta.url);

// A fresh renderer for each case keeps this check away from Electron, providers and user files.
// Every hit uses a board coordinate and real mouse dispatch; SVG targets are never clicked by ID.
const bundle = await build({
  stdin: {
    contents: `import React,{useState,useRef,useLayoutEffect} from 'react';import {createRoot} from 'react-dom/client';
      import LayoutEditor from './components/LayoutEditor';
      import Dialog from './components/Dialog';import Select from './components/Select';
      function Test(){const [board,setBoard]=useState(window.fixture.board);const [active,setActive]=useState(true);
        const [schematic,setSchematic]=useState(window.fixture.schematic);const context=useRef(null);
        const [sidebar,setSidebar]=useState(true);const [selectDialog,setSelectDialog]=useState(false);
        const leftButtonDrag=window.fixture.leftButtonDrag??undefined;
        window.replaceBoard=next=>{window.lastBoard=next;setBoard(next)};window.setLayoutActive=setActive;
        window.replaceLayoutFixture=next=>{window.lastBoard=next.board;setBoard(next.board);setSchematic(next.schematic)};
        window.layoutContext=()=>context.current;
        useLayoutEffect(()=>{window.committedLayoutFixture={board,schematic}},[board,schematic]);
        window.openSelectDialog=()=>{window.dialogSelectChanges=0;setSelectDialog(true)};
        return <><LayoutEditor board={board} schematic={schematic} active={active} agentContextRef={context}
          leftButtonDrag={leftButtonDrag}
          sidebarVisible={sidebar} onShowSidebar={()=>setSidebar(true)}
          onToggleSidebar={window.fixture.sidebarControls?()=>setSidebar(previous=>!previous):undefined}
          onCommit={next=>{if(window.rejectCommit)return false;window.lastBoard=next;window.commits++;setBoard(next);return true}}
          annotations={[]} annotationSessionId="editing" onAnnotationsChange={()=>{}}/>
          {selectDialog&&<Dialog title="Select keyboard guard" onClose={()=>setSelectDialog(false)}>
            <Select label="Dialog layer" value="F.Cu" options={[{value:'F.Cu',label:'F.Cu'},{value:'B.Cu',label:'B.Cu'}]}
              onChange={()=>window.dialogSelectChanges++}/></Dialog>}</>}
      createRoot(document.getElementById('root')).render(<Test/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});

const footprint = (id, x, y) => ({
  id,
  x,
  y,
  symbolId: null,
  libraryId: 'Test:Editing',
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
  graphics: [
    {
      id: `${id}-outline`,
      kind: 'polygon',
      start: { x: -1, y: -1 },
      end: { x: -1, y: 1 },
      points: [
        { x: 1, y: -1 },
        { x: 1, y: 1 },
      ],
      width: 0.12,
      layer: 'F.SilkS',
    },
  ],
});
const board = {
  ...createEmptyPCB(),
  nets: [{ id: 'net', name: 'SIGNAL' }],
  footprints: [footprint('A1', 20, 20), footprint('B2', 30, 20)],
  tracks: [
    {
      id: 'track',
      start: { x: 15, y: 30 },
      end: { x: 25, y: 30 },
      width: 0.4,
      layer: 'F.Cu',
      netId: 'net',
    },
  ],
  vias: [{ id: 'via', x: 30, y: 30, diameter: 1, drill: 0.4, netId: 'net' }],
  graphics: [
    ...[
      [
        { x: 0, y: 0 },
        { x: 80, y: 0 },
      ],
      [
        { x: 80, y: 0 },
        { x: 80, y: 50 },
      ],
      [
        { x: 80, y: 50 },
        { x: 0, y: 50 },
      ],
      [
        { x: 0, y: 50 },
        { x: 0, y: 0 },
      ],
    ].map(([start, end], i) => ({ id: `edge-${i}`, start, end, width: 0.1, layer: 'Edge.Cuts' })),
  ],
};
const placementLibrary = {
  id: 'Test:Editing',
  name: 'Editing',
  library: 'Test',
  description: 'One-pin placement fixture',
  keywords: '',
  footprint: parseSExpr(`(footprint "Editing" (layer "F.Cu")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask")))`),
  pads: ['1'],
  models: [],
};
const styles = await Promise.all(
  ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'].map((file) =>
    readFile(file, 'utf8'),
  ),
);
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});

const casePattern = process.argv[2] ? new RegExp(process.argv[2]) : null;
let matchedCases = 0;
async function run(
  name,
  check,
  fixtureBoard = board,
  sidebarControls = false,
  fixtureSchematic = emptyCircuit(),
  libraryDetail,
  leftButtonDrag = 'drag-any',
) {
  if (casePattern && !casePattern.test(name)) return;
  matchedCases++;
  const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) => {
    const url = new URL(route.request().url());
    if (libraryDetail && url.pathname === '/api/libraries/footprints')
      return route.fulfill({
        json: url.searchParams.has('id')
          ? libraryDetail
          : { entries: [libraryDetail], libraries: [libraryDetail.library], total: 1 },
      });
    if (url.pathname === '/api/appearance') return route.fulfill({ json: null });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  await page.evaluate(
    (fixture) => {
      window.fixture = fixture;
      window.lastBoard = fixture.board;
      window.commits = 0;
      window.rejectCommit = false;
      if (fixture.libraryDetail)
        window.openpe = {
          connection: async () => ({ base: 'http://localhost', token: 'layout-editing-test' }),
        };
    },
    {
      board: fixtureBoard,
      schematic: fixtureSchematic,
      sidebarControls,
      libraryDetail,
      leftButtonDrag,
    },
  );
  for (const content of styles) await page.addStyleTag({ content });
  await page.addStyleTag({ content: 'html,body,#root,.layout-editor{height:100%;margin:0}' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const canvas = page.getByTestId('layout-canvas');
  await canvas.waitFor();
  await canvas.focus();
  await canvas.evaluate((svg) =>
    svg.addEventListener('pointerdown', (event) => {
      window.layoutPointerId = event.pointerId;
    }),
  );
  const screen = (point) =>
    canvas.evaluate((svg, p) => {
      const at = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
      return { x: at.x, y: at.y };
    }, point);
  const point = async (position, click = false) => {
    const at = await screen(position);
    await page.mouse.move(at.x, at.y);
    if (click) await page.mouse.click(at.x, at.y);
  };
  const snapshot = () =>
    page.evaluate(() => ({ board: window.lastBoard, commits: window.commits }));
  const captured = () => canvas.evaluate((svg) => svg.hasPointerCapture(window.layoutPointerId));
  const selected = async () =>
    canvas
      .locator('.layout-footprint.selected')
      .evaluateAll((items) =>
        [...new Set(items.map((item) => item.getAttribute('data-selection-id')))].sort(),
      );
  const box = async (start, end, modifiers = []) => {
    for (const modifier of modifiers) await page.keyboard.down(modifier);
    await point(start);
    await page.mouse.down();
    const at = await screen(end);
    await page.mouse.move(at.x, at.y, { steps: 4 });
    await page.mouse.up();
    for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
  };
  try {
    await check({ page, canvas, point, screen, snapshot, selected, box, captured });
    assert.deepEqual(errors, [], `${name}: no renderer errors`);
    console.log(`Layout editing: ${name}.`);
  } finally {
    await page.close();
  }
}

async function tabTo(page, control) {
  for (let step = 0; step < 60; step++) {
    if (await control.evaluate((element) => document.activeElement === element)) return;
    await page.keyboard.press('Tab');
  }
  assert.fail('The control must remain reachable through ordinary Tab navigation.');
}

async function waitForCanvasFocus(page) {
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('data-testid') === 'layout-canvas',
  );
}

async function drawZoneDraft({ page, point }) {
  await page.getByRole('button', { name: 'Draw polygon', exact: true }).click();
  for (const corner of [
    { x: 45, y: 20 },
    { x: 65, y: 20 },
    { x: 65, y: 35 },
  ])
    await point(corner, true);
}

function placementFixture() {
  const schematic = emptyCircuit();
  const part = createPart(schematic, 'Port', 0, 0);
  schematic.parts.push(part);
  return { schematic, part, board: structuredClone(board) };
}

async function openFootprintChooser(page) {
  await page
    .locator('.layout-toolbar')
    .getByRole('button', { name: 'Place footprint', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Footprint placement', exact: true });
  await dialog.waitFor({ state: 'visible' });
  await page.waitForFunction(() =>
    [...document.querySelectorAll('dialog button')].some(
      (button) => button.textContent === 'Place footprint' && !button.disabled,
    ),
  );
  return dialog;
}

try {
  for (const drawingLayer of ['F.Cu', 'B.Cu', 'F.SilkS', 'B.SilkS', 'Edge.Cuts']) {
    for (const shape of ['rectangle', 'polygon']) {
      await run(
        `regions: ${shape} draws, selects and saves on ${drawingLayer}`,
        async ({ page, canvas, point, snapshot }) => {
          await selectLayoutLayer(page, drawingLayer);
          await page.getByRole('button', { name: `Draw ${shape}`, exact: true }).click();
          assert.equal(
            await page.getByRole('button', { name: 'Fill copper zones', exact: true }).count(),
            0,
          );
          assert.equal(
            await page.getByRole('combobox', { name: 'Outline shape', exact: true }).count(),
            0,
          );
          await point({ x: 45, y: 15 }, true);
          await point({ x: 65, y: 35 });
          assert.equal(
            await canvas.locator('[data-shape-preview]').getAttribute('data-outline-layer'),
            drawingLayer,
          );
          if (shape === 'rectangle') await point({ x: 65, y: 35 }, true);
          else {
            await point({ x: 65, y: 15 }, true);
            await point({ x: 65, y: 35 }, true);
            await point({ x: 45, y: 35 }, true);
            await canvas.press('Enter');
          }
          const accepted = await snapshot();
          assert.equal(accepted.commits, 1);
          const copper = drawingLayer.endsWith('.Cu');
          const region = copper ? accepted.board.zones.at(-1) : accepted.board.graphics.at(-1);
          assert.equal(region.layer, drawingLayer);
          if (copper) {
            assert.equal(region.netId, null, 'A region requires no net during drawing.');
            assert.equal(region.fillEnabled, false);
            assert.equal(region.filledPolygons, undefined);
          } else {
            assert.equal(region.kind, 'polygon');
            assert.equal(region.fill, false);
          }
          await point({ x: 70, y: 40 }, true);
          await point({ x: 55, y: 25 }, true);
          assert.deepEqual(await page.evaluate(() => window.layoutContext().selection), [
            { kind: copper ? 'zone' : 'graphic', id: region.id },
          ]);
          const filled = page.getByRole('checkbox', { name: 'Filled', exact: true });
          await filled.waitFor();
          assert.equal(await filled.isChecked(), false);
          if (copper) {
            assert.equal(
              await page.getByRole('combobox', { name: 'Region net', exact: true }).count(),
              0,
            );
            await filled.click();
            await page.getByRole('alert').filter({ hasText: 'Assign a net' }).waitFor();
            assert.equal((await snapshot()).commits, 1);
            const net = page.getByRole('combobox', { name: 'Zone net', exact: true });
            await net.click();
            await page.getByRole('option', { name: 'SIGNAL', exact: true }).click();
            await filled.check();
            assert.ok((await snapshot()).board.zones.at(-1).filledPolygons.length);
          } else {
            await filled.check();
            assert.equal((await snapshot()).board.graphics.at(-1).fill, true);
          }
          const native = parseSExpr(serializePCB((await snapshot()).board, emptyCircuit()));
          const nodes = native.filter(
            (node) => Array.isArray(node) && node[0] === (copper ? 'zone' : 'gr_poly'),
          );
          assert.equal(
            nodes.length,
            copper
              ? accepted.board.zones.length
              : accepted.board.graphics.filter((graphic) => graphic.kind === 'polygon').length,
          );
        },
      );
    }
  }
  for (const shape of ['rectangle', 'polygon'])
    await run(
      `regions: ${shape} cancellation, IME, rejection and layer changes retain no partial edits`,
      async ({ page, canvas, point, snapshot }) => {
        await selectLayoutLayer(page, 'F.SilkS');
        await page.getByRole('button', { name: `Draw ${shape}`, exact: true }).click();
        await point({ x: 45, y: 15 }, true);
        await point({ x: 65, y: 35 });
        await canvas.dispatchEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 229,
          isComposing: true,
          bubbles: true,
        });
        assert.equal((await snapshot()).commits, 0);
        await canvas.press('Escape');
        assert.equal(await canvas.locator('[data-shape-preview]').count(), 0);
        assert.equal(
          await page
            .getByRole('button', { name: `Draw ${shape}`, exact: true })
            .getAttribute('aria-pressed'),
          'true',
        );
        await point({ x: 45, y: 15 }, true);
        if (shape === 'polygon') {
          await point({ x: 65, y: 15 }, true);
          await point({ x: 65, y: 35 }, true);
        } else await point({ x: 65, y: 35 });
        await page.evaluate(() => (window.rejectCommit = true));
        await canvas.press('Enter');
        assert.equal((await snapshot()).commits, 0);
        assert.equal(await canvas.locator('[data-shape-preview]').count(), 1);
        await selectLayoutLayer(page, 'B.SilkS');
        assert.equal(await canvas.locator('[data-shape-preview]').count(), 0);
        await page.evaluate(() => (window.rejectCommit = false));
        await point({ x: 45, y: 15 }, true);
        if (shape === 'polygon') {
          await point({ x: 65, y: 15 }, true);
          await point({ x: 65, y: 35 }, true);
          await canvas.press('Enter');
        } else await point({ x: 65, y: 35 }, true);
        assert.equal((await snapshot()).commits, 1);
        assert.equal((await snapshot()).board.graphics.at(-1).layer, 'B.SilkS');
      },
    );

  for (const finish of ['keyboard', 'pointer']) {
    await run(
      'creation continuity: ' + finish + ' zone completion supports natural M Escape and E',
      async (context) => {
        const { page, canvas, snapshot } = context;
        await drawZoneDraft(context);
        const button = page.getByRole('button', { name: 'Finish region', exact: true });
        if (finish === 'keyboard') {
          await tabTo(page, button);
          await page.keyboard.press('Enter');
        } else await button.click();
        const accepted = await snapshot();
        assert.equal(accepted.commits, 1);
        assert.equal(accepted.board.zones.length, 1);
        const zoneId = accepted.board.zones[0].id;
        assert.equal(await canvas.evaluate((svg) => document.activeElement === svg), true);
        await page.keyboard.press('m');
        assert.equal(await page.locator('.layout-canvas.is-moving').count(), 1);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.layout-canvas.is-moving').count(), 0);
        assert.deepEqual(await page.evaluate(() => window.layoutContext().selection), [
          { kind: 'zone', id: zoneId },
        ]);
        await page.keyboard.press('e');
        const inspector = page.getByRole('complementary', { name: 'Layout properties' });
        await page.waitForFunction(() =>
          document
            .querySelector('.layout-inspector:not([hidden])')
            ?.contains(document.activeElement),
        );
        await inspector.getByRole('heading', { name: 'Copper zone', exact: true }).waitFor();
        const net = inspector.getByRole('combobox', { name: 'Zone net', exact: true });
        await net.focus();
        await page.keyboard.press('Escape');
        assert.equal(await net.evaluate((control) => document.activeElement === control), true);
        assert.deepEqual(
          await snapshot(),
          accepted,
          'Inspection and cancelled movement add no edit.',
        );
      },
    );
  }

  await run(
    'creation continuity: rejected zone completion retains draft and keyboard retry focus',
    async (context) => {
      const { page, canvas, snapshot } = context;
      await drawZoneDraft(context);
      const draft = canvas.locator('[data-shape-preview]');
      const points = await draft.getAttribute('points');
      const button = page.getByRole('button', { name: 'Finish region', exact: true });
      await tabTo(page, button);
      await page.evaluate(() => {
        window.rejectCommit = true;
      });
      await page.keyboard.press('Enter');
      assert.equal(await button.evaluate((control) => document.activeElement === control), true);
      assert.equal(await draft.getAttribute('points'), points);
      assert.deepEqual(await snapshot(), { board, commits: 0 });
      await page.evaluate(() => {
        window.rejectCommit = false;
      });
      await page.keyboard.press('Enter');
      assert.equal(await draft.count(), 0);
      assert.equal(await canvas.evaluate((svg) => document.activeElement === svg), true);
      assert.equal((await snapshot()).commits, 1);
      assert.equal((await snapshot()).board.zones.length, 1);
    },
  );

  for (const update of ['already placed', 'deleted']) {
    const input = placementFixture();
    await run(
      'creation continuity: footprint window disables a target that is ' + update,
      async ({ page, canvas, snapshot }) => {
        const dialog = await openFootprintChooser(page);
        const next = {
          board: structuredClone(input.board),
          schematic: structuredClone(input.schematic),
        };
        if (update === 'already placed')
          next.board.footprints.push(
            createPCBFootprint(placementLibrary, input.schematic, input.part.id, { x: 50, y: 35 }),
          );
        else next.schematic.parts = [];
        await page.evaluate((value) => window.replaceLayoutFixture(value), next);
        await page.waitForFunction(() =>
          document
            .querySelector('.layout-placement-target')
            ?.textContent?.includes('No unplaced components in the primary schematic.'),
        );
        assert.equal(await dialog.isVisible(), true);
        assert.equal(
          await dialog.getByRole('button', { name: 'Place footprint', exact: true }).isDisabled(),
          true,
        );
        await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
        await dialog.waitFor({ state: 'detached' });
        assert.equal(await canvas.locator('.is-placement').count(), 0);
        assert.equal(await page.getByRole('alert').count(), 0);
        assert.deepEqual(await snapshot(), { board: next.board, commits: 0 });
        await waitForCanvasFocus(page);
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('.layout-tool-settings').count(), 0);
        assert.equal(await canvas.locator('.is-placement').count(), 0);
        assert.equal(await page.getByRole('alert').count(), 0);
        assert.deepEqual(
          await page.evaluate(() => ({
            tool: window.layoutContext().tool,
            selection: window.layoutContext().selection,
          })),
          { tool: 'select', selection: [] },
        );
        assert.deepEqual(await snapshot(), { board: next.board, commits: 0 });
      },
      input.board,
      false,
      input.schematic,
      placementLibrary,
    );
  }

  {
    const input = placementFixture();
    await run(
      'creation continuity: unrelated board changes retain the eligible footprint chooser',
      async ({ page, canvas, snapshot }) => {
        const dialog = await openFootprintChooser(page);
        const next = {
          board: { ...input.board, thickness: input.board.thickness + 0.1 },
          schematic: input.schematic,
        };
        await page.evaluate((value) => window.replaceLayoutFixture(value), next);
        await page.waitForFunction(
          (thickness) => window.committedLayoutFixture.board.thickness === thickness,
          next.board.thickness,
        );
        assert.equal(await dialog.isVisible(), true);
        await dialog.getByRole('button', { name: 'Place footprint', exact: true }).click();
        await dialog.waitFor({ state: 'detached' });
        assert.equal(await canvas.locator('.is-placement').count(), 1);
        assert.deepEqual(await snapshot(), { board: next.board, commits: 0 });
        await waitForCanvasFocus(page);
        await page.keyboard.press('Escape');
        assert.equal(await canvas.locator('.is-placement').count(), 0);
        assert.deepEqual(await snapshot(), { board: next.board, commits: 0 });
      },
      input.board,
      false,
      input.schematic,
      placementLibrary,
    );
  }

  {
    const input = placementFixture();
    await run(
      'creation continuity: cancelling an unchanged chooser retains the exact rotated placement',
      async ({ page, canvas, snapshot }) => {
        const dialog = await openFootprintChooser(page);
        await dialog.getByRole('button', { name: 'Place footprint', exact: true }).click();
        const preview = canvas.locator('.layout-footprint.is-placement');
        await preview.waitFor();
        await waitForCanvasFocus(page);
        const beforeRotation = await preview
          .locator(':scope > g')
          .first()
          .getAttribute('transform');
        await page.keyboard.press('r');
        const id = await preview.getAttribute('data-selection-id');
        const transform = await preview.locator(':scope > g').first().getAttribute('transform');
        assert.notEqual(
          transform,
          beforeRotation,
          'The retained preview includes a real rotation.',
        );
        await page
          .locator('.layout-toolbar')
          .getByRole('button', { name: 'Place footprint', exact: true })
          .click();
        await dialog.waitFor({ state: 'visible' });
        await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
        await dialog.waitFor({ state: 'detached' });
        await waitForCanvasFocus(page);
        assert.equal(await preview.getAttribute('data-selection-id'), id);
        assert.equal(
          await preview.locator(':scope > g').first().getAttribute('transform'),
          transform,
        );
        assert.equal(await canvas.evaluate((svg) => document.activeElement === svg), true);
        assert.deepEqual(await snapshot(), { board: input.board, commits: 0 });
        await page.keyboard.press('Escape');
        assert.equal(await preview.count(), 0);
        assert.deepEqual(await snapshot(), { board: input.board, commits: 0 });
      },
      input.board,
      false,
      input.schematic,
      placementLibrary,
    );
  }

  for (const label of ['Track width (mm)', 'Via diameter (mm)', 'Via drill (mm)']) {
    await run(
      'tool number continuity: ' + label + ' restores its draft before cancelling the route',
      async ({ page, canvas, point, snapshot, selected }) => {
        await point({ x: 20, y: 20 }, true);
        assert.deepEqual(await selected(), ['A1'], 'The initial footprint pickup is selected.');
        await page.getByRole('button', { name: 'Route tracks', exact: true }).click();
        await point({ x: 50, y: 35 }, true);
        await point({ x: 65, y: 35 });
        const route = canvas.locator('[data-route-preview]');
        const points = await route.getAttribute('points');
        const field = page.getByRole('spinbutton', { name: label, exact: true });
        const accepted = await field.inputValue();
        await field.fill('9');
        await field.press('Escape');
        assert.equal(await field.inputValue(), accepted);
        assert.equal(await route.count(), 1);
        assert.equal(await route.getAttribute('points'), points);
        assert.equal(await canvas.evaluate((control) => document.activeElement === control), true);
        assert.deepEqual(
          await selected(),
          ['A1'],
          'Cancelling the numeric draft retains the existing selection.',
        );
        await page.keyboard.press('Escape');
        assert.equal(await route.count(), 0);
        assert.equal(await page.locator('.layout-tool-settings').count(), 0);
        assert.equal(await canvas.evaluate((control) => document.activeElement === control), true);
        await page.keyboard.press('Enter');
        assert.deepEqual(await selected(), [], 'Canvas Escape also clears idle selection.');
        assert.deepEqual(await snapshot(), { board, commits: 0 });
      },
    );
  }

  for (const legacy of [false, true]) {
    await run(
      'tool number continuity: composing ' +
        (legacy ? '229' : 'isComposing') +
        ' retains the numeric draft and route',
      async ({ page, canvas, point, snapshot }) => {
        await page.getByRole('button', { name: 'Route tracks', exact: true }).click();
        await point({ x: 50, y: 35 }, true);
        await point({ x: 65, y: 35 });
        const route = canvas.locator('[data-route-preview]');
        const points = await route.getAttribute('points');
        const field = page.getByRole('spinbutton', { name: 'Track width (mm)', exact: true });
        const accepted = await field.inputValue();
        await field.fill('0.9');
        for (const key of ['Enter', 'Escape', ' ']) {
          await field.evaluate(
            (control, value) =>
              control.dispatchEvent(
                new KeyboardEvent('keydown', {
                  key: value.key,
                  bubbles: true,
                  cancelable: true,
                  isComposing: !value.legacy,
                  keyCode: value.legacy ? 229 : 0,
                }),
              ),
            { key, legacy },
          );
          assert.equal(await field.inputValue(), '0.9');
          assert.equal(await route.count(), 1);
          assert.equal(await route.getAttribute('points'), points);
          assert.equal(await field.evaluate((control) => document.activeElement === control), true);
          assert.deepEqual(await snapshot(), { board, commits: 0 });
        }
        await field.press('Escape');
        assert.equal(await field.inputValue(), accepted);
        await canvas.dispatchEvent('keydown', { key: 'Escape', repeat: true });
        assert.equal(await route.count(), 1, 'A held Escape cannot cancel the next stage.');
        await page.keyboard.press('Escape');
        assert.equal(await route.count(), 0);
        assert.deepEqual(await snapshot(), { board, commits: 0 });
      },
    );
  }

  for (const legacy of [false, true]) {
    await run(
      'tool select continuity: Dialog Select composing ' +
        (legacy ? '229' : 'isComposing') +
        ' blocks native activation and dismissal',
      async ({ page, canvas, point, snapshot }) => {
        await page.getByRole('button', { name: 'Route tracks', exact: true }).click();
        await point({ x: 50, y: 35 }, true);
        await point({ x: 65, y: 35 });
        const route = canvas.locator('[data-route-preview]');
        const points = await route.getAttribute('points');
        await page.evaluate(() => window.openSelectDialog());
        const dialog = page.getByRole('dialog', { name: 'Select keyboard guard', exact: true });
        await dialog.waitFor({ state: 'visible' });
        const select = dialog.getByRole('combobox', { name: 'Dialog layer', exact: true });
        await select.focus();
        for (const open of [false, true]) {
          if (open) await page.keyboard.press('ArrowDown');
          for (const key of ['Enter', 'Escape', ' ']) {
            const prevented = await select.evaluate(
              (control, value) => {
                const event = new KeyboardEvent('keydown', {
                  key: value.key,
                  bubbles: true,
                  cancelable: true,
                  isComposing: !value.legacy,
                  keyCode: value.legacy ? 229 : 0,
                });
                control.dispatchEvent(event);
                return event.defaultPrevented;
              },
              { key, legacy },
            );
            assert.equal(prevented, true);
            assert.equal(await dialog.isVisible(), true);
            assert.equal(
              await dialog.getByRole('listbox', { name: 'Dialog layer' }).count(),
              Number(open),
            );
            assert.equal(
              await select.evaluate((control) => document.activeElement === control),
              true,
            );
            assert.equal(await page.evaluate(() => window.dialogSelectChanges), 0);
            assert.equal(await route.getAttribute('points'), points);
            assert.deepEqual(await snapshot(), { board, commits: 0 });
          }
        }
        await page.keyboard.press('Escape');
        assert.equal(await dialog.getByRole('listbox', { name: 'Dialog layer' }).count(), 0);
        assert.equal(await dialog.isVisible(), true);
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'detached' });
        assert.equal(await route.getAttribute('points'), points);
        assert.deepEqual(await snapshot(), { board, commits: 0 });
      },
    );
  }

  for (const cutout of [false, true]) {
    const input = structuredClone(board);
    if (cutout)
      input.graphics.push({
        id: 'via-cutout',
        kind: 'circle',
        layer: 'Edge.Cuts',
        width: 0.1,
        start: { x: 55, y: 30 },
        end: { x: 59, y: 30 },
      });
    await run(
      'via boundary: standalone preview hides and placement fails ' +
        (cutout ? 'inside a cutout' : 'outside the board'),
      async ({ page, canvas, point, snapshot }) => {
        await page.getByRole('button', { name: 'Place through via', exact: true }).click();
        const preview = canvas.locator('[data-via-preview]');
        await point({ x: 50, y: 40 });
        await preview.waitFor();
        const blocked = cutout ? { x: 55, y: 30 } : { x: 82, y: 35 };
        assert.equal(
          await canvas.evaluate((svg, at) => {
            const p = new DOMPoint(at.x, at.y).matrixTransform(svg.getScreenCTM());
            return svg.contains(document.elementFromPoint(p.x, p.y));
          }, blocked),
          true,
          'The outside-board target remains inside the drawing viewport.',
        );
        await point(blocked);
        await preview.waitFor({ state: 'detached' });
        await point(blocked, true);
        assert.deepEqual(
          await snapshot(),
          { board: input, commits: 0 },
          'Outside clicks cannot place a via.',
        );
        await point({ x: 0.5, y: 35 });
        await preview.waitFor();
        assert.equal(
          await preview.getAttribute('data-route-blocked'),
          'true',
          'Insufficient edge clearance remains visibly blocked inside the board.',
        );
        await point({ x: 50, y: 40 });
        await preview.waitFor();
        assert.equal(await preview.getAttribute('data-route-blocked'), 'false');
        await point({ x: 50, y: 40 }, true);
        const accepted = await snapshot();
        assert.equal(accepted.commits, 1);
        assert.equal(accepted.board.vias.length, input.vias.length + 1);
        const via = accepted.board.vias.at(-1);
        assert.deepEqual({ x: via.x, y: via.y }, { x: 50, y: 40 });
      },
      input,
    );
  }
  await run(
    'via boundary: route transition preview hides outside the board without losing its draft',
    async ({ page, canvas, point, snapshot }) => {
      await page.getByRole('button', { name: 'Route tracks', exact: true }).click();
      await point({ x: 50, y: 35 }, true);
      await point({ x: 65, y: 35 });
      await canvas.press('v');
      const preview = canvas.locator('[data-via-preview]');
      await preview.waitFor();
      await point({ x: 82, y: 35 });
      await preview.waitFor({ state: 'detached' });
      assert.equal(
        await canvas.locator('[data-route-obstacle]').count(),
        0,
        'A hidden via has no remaining obstacle circle outside the board.',
      );
      await canvas.press('Enter');
      assert.deepEqual(await snapshot(), { board, commits: 0 });
      await point({ x: 65, y: 35 });
      await preview.waitFor();
      await canvas.press('Escape');
      assert.deepEqual(await snapshot(), { board, commits: 0 });
    },
  );
  await run(
    'tool select continuity: closed Via net Escape returns to Interaction and retains selection',
    async ({ page, canvas, point, snapshot, selected }) => {
      await point({ x: 20, y: 20 }, true);
      await page.getByRole('button', { name: 'Place through via', exact: true }).click();
      await page.getByRole('combobox', { name: 'Via placement net', exact: true }).focus();
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.layout-tool-settings').count(), 0);
      assert.equal(await canvas.evaluate((svg) => document.activeElement === svg), true);
      assert.deepEqual(await selected(), ['A1']);
      assert.deepEqual(await snapshot(), { board, commits: 0 });
    },
  );

  const placementSchematic = emptyCircuit();
  placementSchematic.parts.push(createPart(placementSchematic, 'Port', 0, 0));
  await run(
    'tool select continuity: Component Escape closes the placement window without writes',
    async ({ page, canvas, snapshot }) => {
      await page.getByRole('button', { name: 'Place footprint', exact: true }).click();
      await page.getByRole('combobox', { name: 'Schematic component', exact: true }).focus();
      await page.keyboard.press('Escape');
      assert.equal(await page.getByRole('dialog', { name: 'Footprint placement' }).count(), 0);
      assert.equal(await page.locator('.layout-tool-settings').count(), 0);
      assert.equal(await canvas.evaluate((svg) => document.activeElement === svg), true);
      assert.deepEqual(await snapshot(), { board, commits: 0 });
    },
    board,
    false,
    placementSchematic,
  );

  await run(
    'tool select continuity: closed Properties Select Escape stays local and keeps inspection',
    async ({ page, canvas, point, snapshot }) => {
      await point({ x: 20, y: 30 }, true);
      const inspector = page.getByRole('complementary', { name: 'Layout properties' });
      const select = inspector.getByRole('combobox', { name: 'Track net', exact: true });
      await select.focus();
      await page.evaluate(() => {
        window.outsideEscapes = 0;
        window.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') window.outsideEscapes++;
        });
      });
      await page.keyboard.press('Escape');
      assert.equal(await select.evaluate((control) => document.activeElement === control), true);
      assert.equal(await inspector.isVisible(), true);
      assert.equal(
        await canvas.locator('[data-selection-id="track"] [data-selection-only]').count(),
        1,
      );
      assert.equal(await page.evaluate(() => window.outsideEscapes), 0);
      assert.deepEqual(await snapshot(), { board, commits: 0 });
    },
  );

  for (const target of ['selected', 'hovered']) {
    await run(
      'inspection continuity: E reveals collapsed Properties for the ' + target + ' footprint',
      async ({ page, canvas, point, snapshot }) => {
        if (target === 'selected') await point({ x: 20, y: 20 }, true);
        await page.getByRole('button', { name: 'Toggle right sidebar', exact: true }).click();
        assert.equal(
          await page.getByRole('complementary', { name: 'Layout sidebar' }).isVisible(),
          false,
        );
        await point({ x: 30, y: 20 });
        await canvas.press('e');
        const inspector = page.getByRole('complementary', { name: 'Layout properties' });
        await inspector.waitFor({ state: 'visible' });
        assert.equal(
          await inspector.locator('header strong').innerText(),
          target === 'selected' ? 'A1' : 'B2',
        );
        const field = inspector.getByRole('spinbutton', { name: 'X (mm)', exact: true });
        await page.waitForFunction(
          () => document.activeElement?.getAttribute('aria-label') === 'X (mm)',
        );
        assert.equal(await field.inputValue(), target === 'selected' ? '20' : '30');
        assert.deepEqual(await snapshot(), { board, commits: 0 });
      },
      board,
      true,
    );
  }

  for (const method of ['Enter', 'blur']) {
    await run(
      'inspection continuity: snapped no-op and accepted coordinates normalize after ' + method,
      async ({ page, canvas, point, snapshot }) => {
        await point({ x: 20, y: 20 });
        await canvas.press('e');
        const inspector = page.getByRole('complementary', { name: 'Layout properties' });
        const x = inspector.getByRole('spinbutton', { name: 'X (mm)', exact: true });
        const y = inspector.getByRole('spinbutton', { name: 'Y (mm)', exact: true });
        await x.fill('20.2');
        if (method === 'Enter') await x.press('Enter');
        else await y.focus();
        assert.equal(
          await x.inputValue(),
          '20',
          'A successful grid no-op displays its accepted coordinate.',
        );
        assert.deepEqual(await snapshot(), { board, commits: 0 });
        await x.fill('20.7');
        if (method === 'Enter') await x.press('Enter');
        else await y.focus();
        assert.equal(await x.inputValue(), '20.5');
        const result = await snapshot();
        assert.equal(result.commits, 1);
        assert.equal(result.board.footprints[0].x, 20.5);
        assert.deepEqual(result.board.footprints[1], board.footprints[1]);
        assert.deepEqual(result.board.tracks, board.tracks);
        assert.deepEqual(result.board.vias, board.vias);
      },
    );
  }

  for (const value of ['', '10001']) {
    for (const method of ['Enter', 'blur']) {
      await run(
        'inspection continuity: invalid coordinate ' +
          JSON.stringify(value) +
          ' retains its draft after ' +
          method,
        async ({ page, canvas, point, snapshot }) => {
          await point({ x: 20, y: 20 });
          await canvas.press('e');
          const inspector = page.getByRole('complementary', { name: 'Layout properties' });
          const x = inspector.getByRole('spinbutton', { name: 'X (mm)', exact: true });
          await x.fill(value);
          if (method === 'Enter') await x.press('Enter');
          else await inspector.getByRole('spinbutton', { name: 'Y (mm)', exact: true }).focus();
          assert.equal(await x.inputValue(), value);
          assert.equal(await x.getAttribute('aria-invalid'), 'true');
          assert.match(await x.getAttribute('aria-description'), /Enter a number/);
          assert.deepEqual(await snapshot(), { board, commits: 0 });
          await x.press('Escape');
          assert.equal(await x.inputValue(), '20');
          assert.equal(await x.getAttribute('aria-invalid'), null);
          assert.deepEqual(await snapshot(), { board, commits: 0 });
        },
      );
    }
  }

  await run(
    'inspection continuity: host rejection preserves an unaccepted coordinate for retry',
    async ({ page, canvas, point, snapshot }) => {
      await point({ x: 20, y: 20 });
      await canvas.press('e');
      const x = page
        .getByRole('complementary', { name: 'Layout properties' })
        .getByRole('spinbutton', { name: 'X (mm)', exact: true });
      await page.evaluate(() => {
        window.rejectCommit = true;
      });
      await x.fill('20.7');
      await x.press('Enter');
      assert.equal(
        await x.inputValue(),
        '20.7',
        'A rejected proposal is not normalized as an accepted no-op.',
      );
      assert.deepEqual(await snapshot(), { board, commits: 0 });
      await page.evaluate(() => {
        window.rejectCommit = false;
      });
      await x.press('Enter');
      assert.equal(await x.inputValue(), '20.5');
      const result = await snapshot();
      assert.equal(result.commits, 1);
      assert.equal(result.board.footprints[0].x, 20.5);
    },
  );

  for (const kind of ['footprint', 'via', 'graphic', 'zone']) {
    const input = structuredClone(board);
    let pickup;
    let fields;
    if (kind === 'footprint') {
      pickup = { x: 20, y: 20 };
      fields = [
        { label: 'X (mm)', value: 20 },
        { label: 'Y (mm)', value: 20 },
      ];
    } else if (kind === 'via') {
      pickup = { x: 30, y: 30 };
      fields = [
        { label: 'X (mm)', value: 30 },
        { label: 'Y (mm)', value: 30 },
      ];
    } else if (kind === 'graphic') {
      input.graphics.push({
        id: 'inspection-line',
        start: { x: 40, y: 35 },
        end: { x: 50, y: 40 },
        width: 0.4,
        layer: 'F.SilkS',
      });
      pickup = { x: 45, y: 37.5 };
      fields = [
        { label: 'Start X (mm)', value: 40 },
        { label: 'Start Y (mm)', value: 35 },
        { label: 'End X (mm)', value: 50 },
        { label: 'End Y (mm)', value: 40 },
      ];
    } else {
      input.zones.push({
        id: 'inspection-zone',
        netId: 'net',
        layer: 'F.Cu',
        outline: [
          { x: 45, y: 35 },
          { x: 60, y: 35 },
          { x: 60, y: 45 },
          { x: 45, y: 45 },
        ],
        clearance: 0.25,
        minThickness: 0.2,
        thermalGap: 0.3,
        thermalBridge: 0.3,
        fillEnabled: true,
      });
      pickup = { x: 52, y: 35 };
      fields = [
        { label: 'Corner 1 X (mm)', value: 45 },
        { label: 'Corner 1 Y (mm)', value: 35 },
      ];
    }
    await run(
      'inspection continuity: ' +
        kind +
        ' coordinates retain no-op geometry and show accepted grid values',
      async ({ page, canvas, point, snapshot }) => {
        await point(pickup);
        await canvas.press('e');
        const inspector = page.getByRole('complementary', { name: 'Layout properties' });
        if (kind === 'zone') await inspector.getByText('Zone corners', { exact: true }).click();
        for (const entry of fields) {
          const field = inspector.getByRole('spinbutton', { name: entry.label, exact: true });
          for (const method of ['Enter', 'blur']) {
            await field.fill(String(entry.value + 0.2));
            if (method === 'Enter') await field.press('Enter');
            else
              await inspector
                .getByRole('spinbutton', {
                  name: fields.find((other) => other !== entry).label,
                  exact: true,
                })
                .focus();
            assert.equal(
              await field.inputValue(),
              String(entry.value),
              entry.label + ' normalizes a successful no-op.',
            );
            assert.deepEqual(await snapshot(), { board: input, commits: 0 });
          }
        }
        const first = fields[0];
        const field = inspector.getByRole('spinbutton', { name: first.label, exact: true });
        await field.fill(String(first.value + 0.7));
        await field.press('Enter');
        assert.equal(await field.inputValue(), String(first.value + 0.5));
        const expected = structuredClone(input);
        if (kind === 'footprint') expected.footprints[0].x = 20.5;
        else if (kind === 'via') expected.vias[0].x = 30.5;
        else if (kind === 'graphic')
          expected.graphics.find((graphic) => graphic.id === 'inspection-line').start.x = 40.5;
        else expected.zones[0].outline[0].x = 45.5;
        assert.deepEqual(await snapshot(), { board: expected, commits: 1 });
      },
      input,
    );
  }

  const exactCoordinate = structuredClone(board);
  exactCoordinate.footprints[0].x = 20.2;
  exactCoordinate.footprints[0].y = 20.3;
  await run(
    'inspection continuity: unchanged off-grid coordinates remain exact through Enter and blur',
    async ({ page, canvas, point, snapshot }) => {
      await point({ x: 20.2, y: 20.3 });
      await canvas.press('e');
      const inspector = page.getByRole('complementary', { name: 'Layout properties' });
      const x = inspector.getByRole('spinbutton', { name: 'X (mm)', exact: true });
      const y = inspector.getByRole('spinbutton', { name: 'Y (mm)', exact: true });
      await x.press('Enter');
      await y.focus();
      await y.press('Enter');
      await x.focus();
      assert.equal(await x.inputValue(), '20.2');
      assert.equal(await y.inputValue(), '20.3');
      assert.deepEqual(await snapshot(), { board: exactCoordinate, commits: 0 });
    },
    exactCoordinate,
  );

  for (const change of ['PageDown', 'PageUp', '+', '-', 'layer row']) {
    await run(
      'continuous editing: changed ' + change + ' cancels M before Enter or pointer placement',
      async ({ page, canvas, point, snapshot, selected }) => {
        if (change === 'PageUp') await canvas.press('PageDown');
        await point({ x: 20, y: 20 });
        await canvas.press('m');
        await point({ x: 24, y: 23 });
        assert.equal(await page.locator('.layout-canvas.is-moving').count(), 1);
        assert.deepEqual(await snapshot(), { board, commits: 0 });
        if (change === 'layer row') {
          await toggleLayoutVisualization(page, 'Visible layers');
          await page
            .getByRole('group', { name: 'Visible layers', exact: true })
            .getByRole('button', { name: 'B.Cu', exact: true })
            .click();
          await toggleLayoutVisualization(page, 'Visible layers');
        } else await canvas.press(change);
        assert.equal(await page.locator('.layout-canvas.is-moving').count(), 0);
        assert.deepEqual(
          await selected(),
          ['A1'],
          'Layer cancellation retains the pickup selection.',
        );
        await canvas.press('Enter');
        await point({ x: 24, y: 23 }, true);
        assert.deepEqual(
          await snapshot(),
          { board, commits: 0 },
          'The earlier M pose cannot revive.',
        );
      },
    );
  }

  for (const change of ['PageUp', 'layer row']) {
    await run(
      'continuous editing: same-layer ' + change + ' retains the exact M preview',
      async ({ page, canvas, point, snapshot }) => {
        await point({ x: 20, y: 20 });
        await canvas.press('m');
        await point({ x: 24, y: 23 });
        const target = canvas.locator('[data-footprint-body="A1"]');
        const transform = await target.getAttribute('transform');
        if (change === 'layer row') {
          await toggleLayoutVisualization(page, 'Visible layers');
          await page
            .getByRole('group', { name: 'Visible layers', exact: true })
            .getByRole('button', { name: 'F.Cu', exact: true })
            .click();
          await toggleLayoutVisualization(page, 'Visible layers');
        } else await canvas.press(change);
        assert.equal(await page.locator('.layout-canvas.is-moving').count(), 1);
        assert.equal(await target.getAttribute('transform'), transform);
        assert.deepEqual(await snapshot(), { board, commits: 0 });
        await canvas.press('Enter');
        const result = await snapshot();
        assert.equal(result.commits, 1);
        assert.deepEqual(
          { x: result.board.footprints[0].x, y: result.board.footprints[0].y },
          { x: 24, y: 23 },
        );
      },
    );
  }

  for (const legacy of [false, true]) {
    await run(
      'continuous editing: composing Properties keys ' +
        (legacy ? '229' : 'isComposing') +
        ' preserve drafts and design',
      async ({ page, canvas, point, snapshot, selected }) => {
        await point({ x: 20, y: 20 });
        await canvas.press('e');
        const field = page
          .getByRole('complementary', { name: 'Layout properties' })
          .getByRole('spinbutton', { name: 'X (mm)', exact: true });
        await field.fill('28');
        for (const key of ['Enter', 'Escape']) {
          await field.evaluate(
            (input, value) => {
              input.dispatchEvent(
                new KeyboardEvent('keydown', {
                  key: value.key,
                  bubbles: true,
                  cancelable: true,
                  isComposing: !value.legacy,
                  keyCode: value.legacy ? 229 : 0,
                }),
              );
            },
            { key, legacy },
          );
          await page.evaluate(
            () =>
              new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
          );
          assert.equal(
            await field.inputValue(),
            '28',
            'Composition cannot apply or discard this input.',
          );
          assert.equal(await field.evaluate((input) => document.activeElement === input), true);
          assert.deepEqual(await selected(), ['A1']);
          assert.deepEqual(await snapshot(), { board, commits: 0 });
        }
        await page.keyboard.press('Escape');
        assert.equal(await field.inputValue(), '20');
        assert.equal(
          await field.evaluate((input) => document.activeElement === input),
          true,
          'Properties Escape retains its independent text-entry focus.',
        );
        assert.deepEqual(await snapshot(), { board, commits: 0 });
      },
    );
  }

  await run(
    'continuous editing: routing parameter Escape returns to canvas before cancelling its route',
    async ({ page, canvas, point, snapshot }) => {
      await page.getByRole('button', { name: 'Route tracks', exact: true }).click();
      const start = { x: 50, y: 35 };
      assert.equal(
        await canvas.evaluate((svg, position) => {
          const at = new DOMPoint(position.x, position.y).matrixTransform(svg.getScreenCTM());
          return svg.contains(document.elementFromPoint(at.x, at.y));
        }, start),
        true,
        'The route start is outside the tool card.',
      );
      await point(start, true);
      await point({ x: 65, y: 35 });
      const route = canvas.locator('[data-route-preview]');
      const before = await route.getAttribute('points');
      const field = page
        .getByRole('complementary', { name: 'Routing settings' })
        .getByRole('spinbutton', { name: 'Track width (mm)', exact: true });
      await field.fill('0.7');
      await page.keyboard.press('Escape');
      assert.equal(await field.inputValue(), '0.4');
      assert.equal(await canvas.evaluate((svg) => document.activeElement === svg), true);
      assert.equal(
        await route.count(),
        1,
        'Parameter rollback leaves the route available for explicit cancellation.',
      );
      assert.equal(await route.getAttribute('points'), before);
      assert.equal(
        await route.getAttribute('stroke-width'),
        '0.4',
        'Blur cannot apply the discarded width.',
      );
      assert.deepEqual(await snapshot(), { board, commits: 0 });
      await page.keyboard.press('Escape');
      assert.equal(await route.count(), 0);
      assert.equal(
        await page
          .getByRole('button', { name: 'Interaction mode', exact: true })
          .getAttribute('aria-pressed'),
        'true',
      );
      assert.deepEqual(await snapshot(), { board, commits: 0 });
    },
  );

  await run(
    'continuous editing: clearing layer priority retains the route and pending via',
    async ({ page, canvas, point, snapshot }) => {
      await page.getByRole('button', { name: 'Route tracks', exact: true }).click();
      const start = { x: 50, y: 35 };
      assert.equal(
        await canvas.evaluate((svg, position) => {
          const at = new DOMPoint(position.x, position.y).matrixTransform(svg.getScreenCTM());
          return svg.contains(document.elementFromPoint(at.x, at.y));
        }, start),
        true,
        'The route start is outside the tool card.',
      );
      await point(start, true);
      await point({ x: 65, y: 35 });
      await canvas.press('v');
      const route = canvas.locator('[data-route-preview]');
      const before = await route.getAttribute('points');
      const via = canvas.locator('[data-route-via-preview]');
      assert.equal(await via.getAttribute('data-route-via-preview'), 'B.Cu');
      await toggleLayoutVisualization(page, 'Visible layers');
      const currentLayer = page
        .getByRole('group', { name: 'Visible layers', exact: true })
        .getByRole('button', { name: 'F.Cu', exact: true });
      assert.equal(await currentLayer.getAttribute('aria-pressed'), 'true');
      await currentLayer.click();
      assert.equal(await currentLayer.getAttribute('aria-pressed'), 'false');
      assert.equal(await page.evaluate(() => window.layoutContext().priorityLayer), null);
      assert.equal(await page.evaluate(() => window.layoutContext().layer), 'F.Cu');
      await toggleLayoutVisualization(page, 'Visible layers');
      assert.equal(await route.count(), 1);
      assert.equal(await route.getAttribute('points'), before);
      assert.equal(await via.getAttribute('data-route-via-preview'), 'B.Cu');
      assert.deepEqual(await snapshot(), { board, commits: 0 });
      await canvas.press('Escape');
      assert.deepEqual(await snapshot(), { board, commits: 0 });
    },
  );

  await run(
    'routing ignores edit shortcuts for selected and hovered footprints',
    async ({ page, canvas, point, snapshot }) => {
      await point({ x: 20, y: 20 }, true);
      const routeTool = page.getByRole('button', { name: 'Route tracks', exact: true });
      await routeTool.click();
      await point({ x: 15, y: 15 }, true);
      await point({ x: 25, y: 15 }, true);
      await point({ x: 30, y: 20 });
      for (const key of ['r', 'f', 'Delete']) {
        await canvas.press(key);
        assert.deepEqual(
          await snapshot(),
          { board, commits: 0 },
          `${key} must not edit another object while routing.`,
        );
        assert.equal(await routeTool.getAttribute('aria-pressed'), 'true');
        assert.equal(await canvas.locator('[data-route-preview]').count(), 1);
      }
      await canvas.press('Escape');
      assert.deepEqual(await snapshot(), { board, commits: 0 });
    },
  );

  await run(
    'Backspace removes only the last zone corner and finishing commits the revised outline once',
    async ({ page, canvas, point, snapshot }) => {
      await point({ x: 20, y: 20 }, true);
      await page.getByRole('button', { name: 'Draw polygon', exact: true }).click();
      for (const corner of [
        { x: 15, y: 15 },
        { x: 25, y: 15 },
        { x: 25, y: 25 },
      ])
        await point(corner, true);
      const finish = page.getByRole('button', { name: 'Finish region', exact: true });
      assert.equal(await finish.isEnabled(), true);
      await canvas.press('Backspace');
      assert.equal(
        await finish.isDisabled(),
        true,
        'Removing the third corner leaves the unfinished two-corner outline.',
      );
      assert.deepEqual(
        await snapshot(),
        { board, commits: 0 },
        'Removing draft corners retains selected packages and all existing board data.',
      );
      await point({ x: 25, y: 24 }, true);
      await canvas.press('Enter');
      const result = await snapshot();
      assert.equal(result.commits, 1);
      assert.deepEqual(result.board.zones[0].outline, [
        { x: 15, y: 15 },
        { x: 25, y: 15 },
        { x: 25, y: 24 },
      ]);
      assert.deepEqual(result.board.footprints, board.footprints);
      assert.deepEqual(result.board.tracks, board.tracks);
      assert.deepEqual(result.board.vias, board.vias);
    },
  );

  for (const finish of ['Enter', 'click']) {
    await run(
      `arrow keys adjust the pending move and ${finish} commits the displayed preview`,
      async ({ page, canvas, point, snapshot }) => {
        await point({ x: 20, y: 20 });
        await canvas.press('m');
        await canvas.press('ArrowRight');
        await canvas.press('Shift+ArrowDown');
        assert.deepEqual(
          await snapshot(),
          { board, commits: 0 },
          'Arrow keys retain the pending move as one transaction.',
        );
        assert.equal(
          await canvas.locator('[data-footprint-body="A1"]').getAttribute('transform'),
          'translate(20.5 25) rotate(0)',
        );
        if (finish === 'Enter') await canvas.press('Enter');
        else {
          // The physical pointer has not moved; pressing its button must preserve keyboard-adjusted geometry.
          await page.mouse.down();
          await page.mouse.up();
        }
        const result = await snapshot();
        assert.equal(result.commits, 1);
        assert.deepEqual(
          { x: result.board.footprints[0].x, y: result.board.footprints[0].y },
          { x: 20.5, y: 25 },
        );
        assert.deepEqual(result.board.footprints[1], board.footprints[1]);
        assert.deepEqual(result.board.tracks, board.tracks);
        assert.deepEqual(result.board.vias, board.vias);
      },
    );
  }

  for (const setting of ['copper layer visibility', 'footprint selection filter']) {
    await run(
      `changing ${setting} cancels a pending move before later Enter or click`,
      async ({ page, canvas, point, snapshot }) => {
        await point({ x: 20, y: 20 });
        await canvas.press('m');
        await point({ x: 24, y: 23 });
        assert.deepEqual(await snapshot(), { board, commits: 0 });
        const panelName = setting === 'copper layer visibility' ? 'Visible layers' : 'Selection';
        await toggleLayoutVisualization(page, panelName);
        await page
          .getByRole('group', { name: panelName, exact: true })
          .getByRole('checkbox', {
            name: setting === 'copper layer visibility' ? 'F.Cu' : 'Footprints',
            exact: true,
          })
          .uncheck();
        await toggleLayoutVisualization(page, panelName);
        await canvas.press('Enter');
        await point({ x: 24, y: 23 }, true);
        assert.deepEqual(
          await snapshot(),
          { board, commits: 0 },
          'Display/filter changes must not leave a committable stale move.',
        );
      },
    );
  }

  await run(
    'hover M moves a footprint with one click and one undo transaction',
    async ({ canvas, point, snapshot }) => {
      await point({ x: 20, y: 20 });
      await canvas.press('m');
      await point({ x: 24.2, y: 22.3 });
      assert.deepEqual(await snapshot(), { board, commits: 0 }, 'Live movement stays transient.');
      await point({ x: 24.2, y: 22.3 }, true);
      const result = await snapshot();
      assert.equal(result.commits, 1);
      assert.deepEqual(
        { x: result.board.footprints[0].x, y: result.board.footprints[0].y },
        { x: 24, y: 22.5 },
      );
      assert.deepEqual(result.board.footprints[1], board.footprints[1]);
      assert.deepEqual(
        result.board.tracks,
        board.tracks,
        'Moving packages retains existing copper.',
      );
      assert.deepEqual(result.board.vias, board.vias);
      assert.equal(result.board.footprints[0].id, board.footprints[0].id);
    },
  );

  await run(
    'Escape cancels keyboard move including pending rotation',
    async ({ canvas, point, snapshot }) => {
      await point({ x: 20, y: 20 });
      await canvas.press('m');
      await point({ x: 24, y: 23 });
      await canvas.press('r');
      await canvas.press('Escape');
      await point({ x: 24, y: 23 }, true);
      assert.deepEqual(await snapshot(), { board, commits: 0 });
    },
  );

  await run(
    'Escape cancels a captured pointer drag before pointerup',
    async ({ page, canvas, point, screen, snapshot, captured }) => {
      await point({ x: 20, y: 20 });
      await page.mouse.down();
      const at = await screen({ x: 24, y: 23 });
      await page.mouse.move(at.x, at.y, { steps: 4 });
      assert.equal(await captured(), true, 'The active pointer drag owns pointer capture.');
      await canvas.press('Escape');
      assert.equal(
        await captured(),
        false,
        'Escape releases capture before the physical pointerup.',
      );
      await page.mouse.up();
      assert.deepEqual(
        await snapshot(),
        { board, commits: 0 },
        'A later pointerup must not revive a cancelled drag.',
      );
    },
  );

  await run(
    'switching tools cancels a captured pointer drag and releases capture',
    async ({ page, canvas, point, screen, snapshot, captured }) => {
      await point({ x: 20, y: 20 });
      await page.mouse.down();
      const at = await screen({ x: 24, y: 23 });
      await page.mouse.move(at.x, at.y, { steps: 4 });
      assert.equal(await captured(), true);
      await canvas.press('h');
      assert.equal(await captured(), false);
      await page.mouse.up();
      await canvas.press('Escape');
      assert.deepEqual(await snapshot(), { board, commits: 0 });
    },
  );

  const offGridBoard = structuredClone(board);
  offGridBoard.footprints[0].pads[0].x = 1.23;
  offGridBoard.footprints[0].pads[0].y = 0.67;
  await run(
    'an off-grid pad remains the pickup anchor through move rotation and flip',
    async ({ canvas, point, snapshot }) => {
      await point(padPosition(offGridBoard.footprints[0], offGridBoard.footprints[0].pads[0]));
      await canvas.press('m');
      await point({ x: 24.2, y: 22.3 });
      await canvas.press('r');
      await canvas.press('f');
      assert.deepEqual(
        await snapshot(),
        { board: offGridBoard, commits: 0 },
        'Move, rotate and flip stay in the pending transaction.',
      );
      await point({ x: 24.2, y: 22.3 }, true);
      const result = await snapshot();
      assert.equal(result.commits, 1);
      const moved = result.board.footprints[0];
      assert.deepEqual(
        padPosition(moved, moved.pads[0]),
        { x: 24, y: 22.5 },
        'The picked pad lands exactly on the displayed grid point.',
      );
      assert.equal(moved.side, 'back');
      assert.equal(moved.rotation, 270);
      assert.equal(moved.id, offGridBoard.footprints[0].id);
      assert.deepEqual(result.board.footprints[1], offGridBoard.footprints[1]);
      assert.deepEqual(result.board.tracks, offGridBoard.tracks);
      assert.deepEqual(result.board.vias, offGridBoard.vias);
    },
    offGridBoard,
  );

  await run(
    'M moves a selected group with its relative offsets intact',
    async ({ canvas, point, box, selected, snapshot }) => {
      await box({ x: 17, y: 17 }, { x: 33, y: 23 });
      assert.deepEqual(await selected(), ['A1', 'B2']);
      await point({ x: 20, y: 20 });
      await canvas.press('m');
      await point({ x: 24, y: 23 });
      assert.deepEqual(await snapshot(), { board, commits: 0 });
      await canvas.press('Enter');
      const result = await snapshot();
      assert.equal(result.commits, 1);
      assert.deepEqual(
        result.board.footprints.map(({ id, x, y }) => ({ id, x, y })),
        [
          { id: 'A1', x: 24, y: 23 },
          { id: 'B2', x: 34, y: 23 },
        ],
      );
      assert.deepEqual(result.board.tracks, board.tracks);
      assert.deepEqual(result.board.vias, board.vias);
    },
  );

  await run(
    'an inverse rotation during M leaves a no-op click clean',
    async ({ canvas, point, snapshot }) => {
      await point({ x: 20, y: 20 });
      await canvas.press('m');
      await canvas.press('r');
      await canvas.press('Shift+r');
      await point({ x: 20, y: 20 }, true);
      assert.deepEqual(await snapshot(), { board, commits: 0 });
    },
  );

  await run(
    'Move selection from the menu returns focus for rotation, cancellation and placement',
    async ({ page, canvas, point, snapshot }) => {
      await point({ x: 20, y: 20 }, true);
      const menuMove = async () => {
        await page.getByRole('combobox', { name: 'Edit layout', exact: true }).click();
        await page.getByRole('option', { name: 'Move selection', exact: true }).click();
        await page.waitForFunction(
          () => document.activeElement === document.querySelector('[data-testid="layout-canvas"]'),
        );
      };
      await menuMove();
      await point({ x: 24, y: 23 });
      await page.keyboard.press('r');
      await page.keyboard.press('Escape');
      assert.deepEqual(await snapshot(), { board, commits: 0 });
      await menuMove();
      await point({ x: 24, y: 23 });
      await page.keyboard.press('r');
      await page.keyboard.press('Enter');
      const result = await snapshot();
      assert.equal(result.commits, 1);
      assert.deepEqual(
        {
          x: result.board.footprints[0].x,
          y: result.board.footprints[0].y,
          rotation: result.board.footprints[0].rotation,
        },
        { x: 24, y: 23, rotation: 90 },
      );
      assert.deepEqual(result.board.footprints[1], board.footprints[1]);
      assert.equal(await canvas.evaluate((svg) => document.activeElement === svg), true);
    },
  );

  await run(
    'direct group rotation uses a shared center and preserves package spacing',
    async ({ canvas, box, snapshot }) => {
      await box({ x: 17, y: 17 }, { x: 33, y: 23 });
      await canvas.press('r');
      const rotated = await snapshot();
      assert.equal(rotated.commits, 1);
      const [a, b] = rotated.board.footprints;
      assert.deepEqual({ x: a.x, y: a.y, rotation: a.rotation }, { x: 25, y: 25, rotation: 90 });
      assert.deepEqual({ x: b.x, y: b.y, rotation: b.rotation }, { x: 25, y: 15, rotation: 90 });
      assert.equal(Math.hypot(a.x - b.x, a.y - b.y), 10);
      assert.deepEqual(rotated.board.tracks, board.tracks);
      assert.deepEqual(rotated.board.vias, board.vias);
      await canvas.press('Shift+r');
      assert.deepEqual((await snapshot()).board, board);
    },
  );

  await run(
    'R and Shift+R rotate hovered geometry in opposite directions',
    async ({ canvas, point, snapshot }) => {
      await point({ x: 20, y: 20 });
      await canvas.press('r');
      const rotated = await snapshot();
      assert.equal(rotated.commits, 1);
      assert.equal(rotated.board.footprints[0].rotation, 90);
      await canvas.press('Shift+r');
      const restored = await snapshot();
      assert.equal(restored.commits, 2);
      assert.deepEqual(restored.board, board);
    },
  );

  await run(
    'F flips the hovered footprint without changing copper or IDs',
    async ({ canvas, point, snapshot }) => {
      await point({ x: 20, y: 20 });
      await canvas.press('f');
      const flipped = await snapshot();
      assert.equal(flipped.commits, 1);
      assert.deepEqual(flipped.board.footprints[0], flipPCBFootprint(board.footprints[0]));
      assert.deepEqual(flipped.board.footprints[1], board.footprints[1]);
      assert.deepEqual(flipped.board.tracks, board.tracks);
      assert.deepEqual(flipped.board.vias, board.vias);
      await canvas.press('f');
      assert.deepEqual((await snapshot()).board, board);
    },
  );

  await run(
    'E focuses Properties once, input Escape retains selection and closing restores canvas focus',
    async ({ page, canvas, point, snapshot, selected }) => {
      await point({ x: 20, y: 20 });
      await canvas.press('e');
      const inspector = page.getByRole('complementary', { name: 'Layout properties' });
      await inspector.waitFor();
      assert.equal(await inspector.locator('header strong').innerText(), 'A1');
      const x = inspector.getByRole('spinbutton', { name: 'X (mm)', exact: true });
      await page.waitForFunction(
        () => document.activeElement?.getAttribute('aria-label') === 'X (mm)',
      );
      await x.fill('28');
      await page.keyboard.press('Escape');
      assert.equal(
        await x.inputValue(),
        '20',
        'Input Escape discards only its uncommitted coordinate.',
      );
      assert.deepEqual(await selected(), ['A1']);
      await point({ x: 30, y: 20 });
      await page.keyboard.press('f');
      await page.keyboard.press('r');
      assert.deepEqual(await snapshot(), { board, commits: 0 });
      await page.getByRole('button', { name: 'Close properties', exact: true }).click();
      assert.equal(await canvas.evaluate((svg) => document.activeElement === svg), true);
      await point({ x: 30, y: 20 }, true);
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      assert.equal(await inspector.locator('header strong').innerText(), 'B2');
      assert.equal(
        await canvas.evaluate((svg) => document.activeElement === svg),
        true,
        'A later pointer selection must not replay the earlier E focus request.',
      );
      assert.deepEqual(await snapshot(), { board, commits: 0 });
    },
  );

  await run(
    'Delete removes the hovered package while retaining copper',
    async ({ canvas, point, snapshot }) => {
      await point({ x: 20, y: 20 });
      await canvas.press('Delete');
      const result = await snapshot();
      assert.equal(result.commits, 1);
      assert.deepEqual(result.board.footprints, [board.footprints[1]]);
      assert.deepEqual(result.board.tracks, board.tracks);
      assert.deepEqual(result.board.vias, board.vias);
    },
  );

  await run(
    'existing selection takes priority over a hovered shortcut target',
    async ({ canvas, point, snapshot }) => {
      await point({ x: 20, y: 20 }, true);
      await point({ x: 30, y: 20 });
      await canvas.press('f');
      const result = await snapshot();
      assert.equal(result.commits, 1);
      assert.equal(result.board.footprints[0].side, 'back');
      assert.equal(result.board.footprints[1].side, 'front');
    },
  );

  await run(
    'box direction chooses contained or intersecting geometry',
    async ({ canvas, selected, box, snapshot }) => {
      await box({ x: 17, y: 17 }, { x: 20.3, y: 23 });
      assert.deepEqual(await selected(), [], 'Left-to-right box requires the complete footprint.');
      await box({ x: 20.3, y: 17 }, { x: 17, y: 23 });
      assert.deepEqual(
        await selected(),
        ['A1'],
        'Right-to-left box accepts footprint intersections.',
      );
      await canvas.press('Escape');
      await box({ x: 17, y: 17 }, { x: 33, y: 23 });
      assert.deepEqual(await selected(), ['A1', 'B2']);
      assert.deepEqual(await snapshot(), { board, commits: 0 });
    },
  );

  await run(
    'supplied selected-object drag preference selects over unselected footprints and moves selected footprints',
    async ({ page, canvas, point, screen, selected, snapshot }) => {
      await point({ x: 20, y: 20 });
      await page.mouse.down();
      const end = await screen({ x: 33, y: 23 });
      await page.mouse.move(end.x, end.y, { steps: 4 });
      assert.equal(await canvas.locator('[data-selection-box]').count(), 1);
      await page.mouse.up();
      assert.deepEqual(await selected(), []);
      assert.deepEqual(await snapshot(), { board, commits: 0 });
      await point({ x: 20, y: 20 }, true);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 4 });
      assert.equal(await canvas.locator('[data-selection-box]').count(), 0);
      await canvas.press('Escape');
      await page.mouse.up();
      assert.deepEqual(await selected(), ['A1']);
      assert.deepEqual(await snapshot(), { board, commits: 0 });
    },
    board,
    false,
    emptyCircuit(),
    undefined,
    'drag-selected',
  );

  await run(
    'default left-button gesture selects unselected footprints and commits an exact selected-object drag',
    async ({ page, canvas, point, screen, selected, snapshot }) => {
      assert.equal(
        await page.getByRole('combobox', { name: 'Left button drag', exact: true }).count(),
        0,
      );
      await point({ x: 20, y: 20 });
      await page.mouse.down();
      const end = await screen({ x: 33, y: 23 });
      await page.mouse.move(end.x, end.y, { steps: 4 });
      assert.equal(await canvas.locator('[data-selection-box]').count(), 1);
      await page.mouse.up();
      assert.deepEqual(await selected(), []);
      assert.deepEqual(await snapshot(), { board, commits: 0 });
      await point({ x: 20, y: 20 }, true);
      assert.deepEqual(await selected(), ['A1']);
      await page.mouse.down();
      const target = await screen({ x: 24, y: 23 });
      await page.mouse.move(target.x, target.y, { steps: 4 });
      assert.equal(await canvas.locator('[data-selection-box]').count(), 0);
      assert.equal(
        await canvas.locator('[data-footprint-body="A1"]').getAttribute('transform'),
        'translate(24 23) rotate(0)',
      );
      await page.mouse.up();
      const expected = structuredClone(board);
      expected.footprints[0].x = 24;
      expected.footprints[0].y = 23;
      assert.deepEqual(await snapshot(), { board: expected, commits: 1 });
      assert.deepEqual(await selected(), ['A1']);
    },
    board,
    false,
    emptyCircuit(),
    undefined,
    null,
  );

  await run(
    'selection-rectangle preference permits box selection over selected footprints',
    async ({ page, canvas, point, screen, selected, snapshot }) => {
      await point({ x: 20, y: 20 }, true);
      await page.evaluate(() => window.setLayoutActive(false));
      await page.evaluate(() => window.setLayoutActive(true));
      await point({ x: 20, y: 20 });
      await page.mouse.down();
      const end = await screen({ x: 33, y: 23 });
      await page.mouse.move(end.x, end.y, { steps: 4 });
      assert.equal(await canvas.locator('[data-selection-box]').count(), 1);
      await canvas.press('Escape');
      await page.mouse.up();
      assert.deepEqual(await selected(), ['A1']);
      await page.keyboard.down('Shift');
      await point({ x: 30, y: 20 }, true);
      await page.keyboard.up('Shift');
      assert.deepEqual(await selected(), ['A1', 'B2']);
      assert.deepEqual(await snapshot(), { board, commits: 0 });
    },
    board,
    false,
    emptyCircuit(),
    undefined,
    'select',
  );

  await run(
    'box modifiers add, toggle and subtract without design writes',
    async ({ point, selected, box, snapshot }) => {
      await point({ x: 20, y: 20 }, true);
      await box({ x: 27, y: 17 }, { x: 33, y: 23 }, ['Shift']);
      assert.deepEqual(await selected(), ['A1', 'B2']);
      await box({ x: 17, y: 17 }, { x: 23, y: 23 }, ['Control']);
      assert.deepEqual(await selected(), ['B2']);
      await box({ x: 17, y: 17 }, { x: 23, y: 23 }, ['Control']);
      assert.deepEqual(await selected(), ['A1', 'B2']);
      await box({ x: 27, y: 17 }, { x: 33, y: 23 }, ['Control', 'Shift']);
      assert.deepEqual(await selected(), ['A1']);
      assert.deepEqual(await snapshot(), { board, commits: 0 });
    },
  );

  for (const cancellation of [
    'Escape',
    'pointer cancel',
    'capture loss',
    'deactivation',
    'replacement',
  ]) {
    await run(
      cancellation + ' cancels a selection box while retaining the previous selection',
      async ({ page, canvas, point, screen, selected, snapshot, captured }) => {
        await point({ x: 20, y: 20 }, true);
        await point({ x: 27, y: 17 });
        await page.mouse.down();
        const end = await screen({ x: 33, y: 23 });
        await page.mouse.move(end.x, end.y, { steps: 4 });
        assert.equal(await canvas.locator('[data-selection-box]').count(), 1);
        assert.deepEqual(
          await selected(),
          ['A1'],
          'A pending box does not discard prior selection.',
        );
        let expected = board;
        if (cancellation === 'Escape') await canvas.press('Escape');
        else if (cancellation === 'pointer cancel')
          await canvas.evaluate((svg) =>
            svg.dispatchEvent(
              new PointerEvent('pointercancel', {
                bubbles: true,
                pointerId: window.layoutPointerId,
              }),
            ),
          );
        else if (cancellation === 'capture loss') {
          await canvas.evaluate((svg) => svg.releasePointerCapture(window.layoutPointerId));
          await page.mouse.move(end.x + 2, end.y + 2);
        } else if (cancellation === 'deactivation')
          await page.evaluate(() => window.setLayoutActive(false));
        else {
          expected = { ...board, thickness: board.thickness + 0.1 };
          await page.evaluate((next) => window.replaceBoard(next), expected);
        }
        await canvas.locator('[data-selection-box]').waitFor({ state: 'detached' });
        await page.mouse.up();
        assert.equal(await captured(), false);
        assert.deepEqual(await selected(), ['A1']);
        assert.deepEqual(await snapshot(), { board: expected, commits: 0 });
      },
    );
  }

  await run(
    'replacement data invalidates a pending keyboard move',
    async ({ page, canvas, point, snapshot }) => {
      await point({ x: 20, y: 20 });
      await canvas.press('m');
      await point({ x: 24, y: 23 });
      const replacement = structuredClone(board);
      replacement.footprints[0].x = 21;
      await page.evaluate((next) => window.replaceBoard(next), replacement);
      await point({ x: 24, y: 23 }, true);
      assert.deepEqual(await snapshot(), { board: replacement, commits: 0 });
    },
  );

  await run(
    'hiding Layout cancels a pending move before it becomes active again',
    async ({ page, canvas, point, snapshot }) => {
      await point({ x: 20, y: 20 });
      await canvas.press('m');
      await point({ x: 24, y: 23 });
      await page.evaluate(() => window.setLayoutActive(false));
      await page.evaluate(() => window.setLayoutActive(true));
      await point({ x: 24, y: 23 }, true);
      assert.deepEqual(await snapshot(), { board, commits: 0 });
    },
  );
  assert.ok(
    matchedCases > 0,
    `No Layout editing cases matched ${JSON.stringify(process.argv[2] ?? '')}.`,
  );
} finally {
  await browser.close();
}
