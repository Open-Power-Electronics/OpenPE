// Actual LayoutEditor presentation fixture; no Electron, solver, grants or design writes.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import {
  closeDisplayDrawer,
  openDisplayDrawer,
  setLayoutVisibility,
} from './visualization-test-helpers.mjs';

const { emptyCircuit, createPart } = await tsImport('../lib/circuit.ts', import.meta.url);
const { createEmptyPCB, padPosition } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const schematic = emptyCircuit();
const part = createPart(schematic, 'R', 10, 20);
Object.assign(part, { ref: 'R1', value: '1k' });
schematic.parts.push(part);
const board = createEmptyPCB();
board.nets = [{ id: 'switch', name: 'SW' }];
board.vias = [{ id: 'signal-via', x: 65, y: 15, diameter: 0.8, drill: 0.4, netId: 'switch' }];
board.tracks = [
  {
    id: 'front',
    start: { x: 4, y: 8 },
    end: { x: 84, y: 28 },
    width: 0.6,
    layer: 'F.Cu',
    netId: 'switch',
  },
  {
    id: 'back',
    start: { x: 20, y: 36 },
    end: { x: 48, y: 54 },
    width: 0.4,
    layer: 'B.Cu',
    netId: 'switch',
  },
  {
    id: 'locked',
    start: { x: 12, y: 48 },
    end: { x: 36, y: 48 },
    width: 0.5,
    layer: 'F.Cu',
    netId: 'switch',
    locked: true,
  },
];
board.footprints.push({
  id: 'component',
  symbolId: part.id,
  libraryId: 'Fixture:R',
  reference: 'R1',
  x: 10,
  y: 20,
  rotation: 90,
  side: 'front',
  pads: [
    {
      id: 'component-pad',
      number: '1',
      x: 3,
      y: 1,
      rotation: 0,
      type: 'smd',
      shape: 'rect',
      size: { x: 2, y: 2 },
      netId: 'switch',
      layers: ['F.Cu'],
    },
  ],
  graphics: [],
});
const original = JSON.stringify(board);
const bundle = await build({
  stdin: {
    contents: `import React,{useRef,useState}from'react';import{createRoot}from'react-dom/client';
import LayoutEditor from './components/LayoutEditor';
function Fixture(){const[options,setOptions]=useState({active:true,visible:true,board:window.fixture.board,annotationDisabled:false});
const locate=useRef(null),context=useRef(null);window.layoutContext=context;window.locateRef=locate;
window.updateOptions=patch=>setOptions(current=>({...current,...patch}));
return <LayoutEditor {...options} schematic={window.fixture.schematic} analysisObjectLocateRef={locate} agentContextRef={context}
onCommit={()=>{window.commits++;return true}} onSavePartProperties={()=>false} annotations={[]} annotationSessionId="emc-locate" onAnnotationsChange={()=>{}}/>;}
window.root=createRoot(document.getElementById('root'));window.root.render(<Fixture/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  await page.evaluate(
    (fixture) => {
      window.fixture = fixture;
      window.commits = 0;
    },
    { board, schematic },
  );
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({ content: 'html,body,#root,.layout-editor{height:100%;margin:0}' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const canvas = page.getByTestId('layout-canvas');
  await canvas.waitFor();
  await page.waitForFunction(() => !!window.locateRef.current && !!window.layoutContext.current);
  const frames = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  const update = async (patch) => {
    await page.evaluate((value) => window.updateOptions(value), patch);
    await frames();
  };
  const locate = (id) => page.evaluate((value) => window.locateRef.current(value), id);
  const view = () => canvas.getAttribute('viewBox');
  const assertBlocked = async (id) => {
    const before = await view();
    assert.equal(await locate(id), false);
    await frames();
    assert.equal(await view(), before);
    assert.equal(await page.evaluate(() => window.commits), 0);
  };

  assert.equal(await locate('front'), true);
  await page.waitForFunction(() => window.layoutContext.current?.selection[0]?.id === 'front');
  assert.deepEqual(await page.evaluate(() => window.layoutContext.current.selection), [
    { kind: 'track', id: 'front' },
  ]);
  const fit = await page.evaluate(() => {
    const text = document.querySelector('[data-testid="layout-canvas"]').getAttribute('viewBox');
    const [x, y, width, height] = text.split(' ').map(Number);
    return { x, y, width, height };
  });
  for (const point of [board.tracks[0].start, board.tracks[0].end]) {
    assert.ok(point.x > fit.x && point.x < fit.x + fit.width);
    assert.ok(point.y > fit.y && point.y < fit.y + fit.height);
  }
  assert.equal(await locate('signal-via'), true);
  await frames();
  assert.deepEqual(await page.evaluate(() => window.layoutContext.current.selection), [
    { kind: 'via', id: 'signal-via' },
  ]);
  assert.equal(await locate('component-pad'), true);
  await frames();
  assert.deepEqual(await page.evaluate(() => window.layoutContext.current.selection), [
    { kind: 'footprint', id: 'component' },
  ]);
  const padCenter = padPosition(board.footprints[0], board.footprints[0].pads[0]);
  const padView = (await view()).split(' ').map(Number);
  assert.ok(Math.abs(padView[0] + padView[2] / 2 - padCenter.x) < 1e-8);
  assert.ok(Math.abs(padView[1] + padView[3] / 2 - padCenter.y) < 1e-8);
  assert.equal(await locate('component'), true);
  await frames();
  assert.deepEqual(await page.evaluate(() => window.layoutContext.current.selection), [
    { kind: 'footprint', id: 'component' },
  ]);
  assert.equal(await locate('front'), true);
  await frames();
  // The analysis dock hides rather than discards the retained inspector. A
  // numeric draft must block locating before activate/selection can reset it.
  await canvas.focus();
  await canvas.press('e');
  const widthField = page.locator('.layout-inspector input[aria-label="Width (mm)"]');
  await widthField.waitFor({ state: 'visible' });
  await widthField.fill('-1');
  await widthField.press('Tab');
  await page.waitForFunction(
    () => !!document.querySelector('.layout-inspector [data-pending-edit="true"]'),
  );
  const invalidWidthDraft = await widthField.inputValue();
  assert.equal(Number(invalidWidthDraft), -1);
  await assertBlocked('back');
  await update({ sidebarVisible: false });
  await assertBlocked('back');
  assert.equal(await widthField.inputValue(), invalidWidthDraft);
  assert.deepEqual(await page.evaluate(() => window.layoutContext.current.selection), [
    { kind: 'track', id: 'front' },
  ]);
  await update({ sidebarVisible: true });
  assert.equal(await widthField.inputValue(), invalidWidthDraft);
  await widthField.focus();
  await frames();
  await widthField.fill('0.6');
  await widthField.press('Enter');
  await frames();
  assert.deepEqual(
    await page.evaluate(() =>
      [...document.querySelectorAll('.layout-inspector [data-pending-edit="true"]')].map(
        (element) => ({
          name: element.querySelector('input')?.getAttribute('aria-label'),
          value: element.querySelector('input')?.value,
        }),
      ),
    ),
    [],
  );
  assert.equal(await locate('front'), true);
  await frames();

  // Native linked-part Reference/Value drafts are hosted by PartProperties,
  // whose marker must remain visible to the Layout gate while hidden.
  await update({ ruleFocus: { request: 1, objectIds: ['component'], location: { x: 10, y: 20 } } });
  await page.waitForFunction(() => window.layoutContext.current?.selection[0]?.id === 'component');
  await canvas.focus();
  await canvas.press('e');
  const referenceField = page.locator('.layout-inspector input[aria-label="Component reference"]');
  await referenceField.waitFor({ state: 'visible' });
  await referenceField.fill('');
  await referenceField.press('Tab');
  await page.waitForFunction(
    () =>
      document
        .querySelector('.layout-inspector .part-properties')
        ?.getAttribute('data-pending-edit') === 'true',
  );
  await update({ sidebarVisible: false });
  await assertBlocked('back');
  assert.equal(await referenceField.inputValue(), '');
  assert.deepEqual(await page.evaluate(() => window.layoutContext.current.selection), [
    { kind: 'footprint', id: 'component' },
  ]);
  await update({ sidebarVisible: true });
  await referenceField.fill('R1');
  await referenceField.press('Enter');
  await page.waitForFunction(
    () => !document.querySelector('.layout-inspector [data-pending-edit="true"]'),
  );
  await update({ ruleFocus: null });
  assert.equal(await locate('front'), true);
  await frames();
  await assertBlocked('missing');
  await assertBlocked('locked');
  await update({ active: false });
  await assertBlocked('back');
  await update({ active: true });
  await update({ visible: false });
  await assertBlocked('back');
  await update({ visible: true });
  await update({ annotationDisabled: true });
  await assertBlocked('back');
  await update({ annotationDisabled: false });
  await update({ syncStatus: { pending: true, error: '', warnings: [] } });
  await assertBlocked('back');
  await update({ syncStatus: { pending: false, error: 'Synchronization failed.', warnings: [] } });
  await assertBlocked('back');
  await update({ syncStatus: undefined });
  await page.evaluate(() => {
    const dialog = document.createElement('dialog');
    dialog.id = 'fixture-overlay';
    document.body.append(dialog);
    dialog.showModal();
  });
  await assertBlocked('back');
  await page.evaluate(() => document.getElementById('fixture-overlay').remove());

  await setLayoutVisibility(page, 'B.Cu', false);
  await closeDisplayDrawer(page, 'Visualization');
  await assertBlocked('back');
  await setLayoutVisibility(page, 'B.Cu', true);
  await closeDisplayDrawer(page, 'Visualization');
  assert.equal(await locate('back'), true);
  await page.waitForFunction(() => window.layoutContext.current?.selection[0]?.id === 'back');

  await setLayoutVisibility(page, 'F.Cu', false);
  await closeDisplayDrawer(page, 'Visualization');
  await assertBlocked('component-pad');
  await setLayoutVisibility(page, 'F.Cu', true);
  await closeDisplayDrawer(page, 'Visualization');

  await openDisplayDrawer(page, 'Selection');
  const filters = page.getByRole('group', { name: 'Selection', exact: true });
  await filters.getByRole('checkbox', { name: 'Tracks', exact: true }).uncheck();
  await closeDisplayDrawer(page, 'Selection');
  await assertBlocked('front');
  await openDisplayDrawer(page, 'Selection');
  await filters.getByRole('checkbox', { name: 'Tracks', exact: true }).check();
  await filters.getByRole('checkbox', { name: 'Locked items', exact: true }).check();
  await closeDisplayDrawer(page, 'Selection');
  assert.equal(await locate('locked'), true);
  await page.waitForFunction(() => window.layoutContext.current?.selection[0]?.id === 'locked');
  assert.equal(
    await page.evaluate(
      () => window.fixture.board.tracks.find((track) => track.id === 'locked').locked,
    ),
    true,
  );

  await page.evaluate(() => (window.previousLocate = window.locateRef.current));
  const replacement = structuredClone(board);
  replacement.tracks = replacement.tracks.filter((track) => track.id !== 'front');
  await update({ board: replacement });
  assert.equal(
    await page.evaluate(() => window.previousLocate('back')),
    false,
    'A superseded callback cannot locate against replaced board data.',
  );
  await assertBlocked('front');
  assert.equal(await locate('back'), true);
  await frames();
  assert.equal(await page.evaluate(() => window.commits), 0);
  assert.equal(await page.evaluate(() => JSON.stringify(window.fixture.board)), original);
  assert.deepEqual(errors, []);
  await mkdir('test-results/emc-panel', { recursive: true });
  await page.screenshot({ path: 'test-results/emc-panel/layout-locate.png' });
  await page.evaluate(() => window.root.unmount());
  assert.equal(await page.evaluate(() => window.locateRef.current), null);
  console.log(
    'EMC Layout locating passed: exact selection/camera, visibility/filter/lock/Source/sync/lifecycle gates, stale callbacks and no design writes.',
  );
} finally {
  await browser.close();
}
