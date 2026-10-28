import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const { emptyCircuit, uid } = await tsImport('../lib/circuit.ts', import.meta.url);
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const { createProject, exportKiCad, projectFromNativeFiles } = await tsImport(
  '../lib/project.ts',
  import.meta.url,
);

// Real SVG input backed by ProjectCore and native KiCad source, isolated from
// Electron, services, providers, and every user project.
const bundle = await build({
  stdin: {
    contents: `import React,{useRef,useState,useSyncExternalStore} from 'react';import {createRoot} from 'react-dom/client';
      import LayoutEditor from './components/LayoutEditor';import {ProjectCore} from './core/project-core';
      import {projectNativeFiles} from './lib/project';
      function Test(){const [core]=useState(()=>new ProjectCore(window.fixture));const context=useRef(null);
        const state=useSyncExternalStore(core.subscribe,core.getSnapshot,core.getSnapshot);
        window.layoutContext=()=>context.current;
        window.snapshot=()=>({board:core.getSnapshot().project.pcb,undoDepth:core.getSnapshot().undoDepth,
          commits:window.commits,native:projectNativeFiles(core.getSnapshot().project).files.find(f=>f.name.endsWith('.kicad_pcb')).source});
        return <LayoutEditor leftButtonDrag="drag-any" board={state.project.pcb} schematic={state.project.schematic} active agentContextRef={context}
          onCommit={next=>{const accepted=core.replaceBoard(next);if(accepted)window.commits++;return accepted}}
          undoAction={<button aria-label="Undo" disabled={!state.canUndo} onClick={()=>core.undo()}>Undo</button>}
          annotations={[]} annotationSessionId="track-lock" onAnnotationsChange={()=>{}}/>}
      createRoot(document.getElementById('root')).render(<Test/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const project = createProject(emptyCircuit());
const netId = uid();
const lockedId = uid();
const freeId = uid();
const outline = [
  { x: 5, y: 5 },
  { x: 60, y: 5 },
  { x: 60, y: 45 },
  { x: 5, y: 45 },
];
project.pcb = {
  ...createEmptyPCB(),
  nets: [{ id: netId, name: 'SIGNAL' }],
  tracks: [
    {
      id: lockedId,
      start: { x: 20, y: 20 },
      end: { x: 40, y: 20 },
      width: 0.4,
      layer: 'F.Cu',
      netId,
      locked: true,
    },
    {
      id: freeId,
      start: { x: 20, y: 30 },
      end: { x: 40, y: 30 },
      width: 0.4,
      layer: 'F.Cu',
      netId,
    },
  ],
  graphics: [
    {
      id: uid(),
      kind: 'polygon',
      start: { x: 0, y: 0 },
      end: { x: 0, y: 50 },
      points: [
        { x: 65, y: 0 },
        { x: 65, y: 50 },
      ],
      width: 0.1,
      layer: 'Edge.Cuts',
    },
  ],
  zones: [
    {
      id: uid(),
      layer: 'F.Cu',
      netId,
      outline,
      filledPolygons: [{ points: outline }],
      clearance: 0.25,
      minThickness: 0.2,
      thermalGap: 0.3,
      thermalBridge: 0.3,
    },
  ],
};
const fixture = projectFromNativeFiles({
  entry: 'Tracks.kicad_pro',
  files: [
    { name: 'Tracks.kicad_pro', source: '{}\n' },
    { name: 'Tracks.kicad_sch', source: exportKiCad(project, 'schematic') },
    { name: 'Tracks.kicad_pcb', source: exportKiCad(project, 'pcb') },
  ],
});
const styles = await Promise.all(
  ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'].map((path) =>
    readFile(path, 'utf8'),
  ),
);
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});

async function run(name, check) {
  if (process.argv[2] && !name.includes(process.argv[2])) return;
  const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  await page.evaluate((value) => {
    window.fixture = value;
    window.commits = 0;
  }, fixture);
  for (const content of styles) await page.addStyleTag({ content });
  await page.addStyleTag({ content: 'html,body,#root,.layout-editor{height:100%;margin:0}' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const canvas = page.getByTestId('layout-canvas');
  await canvas.waitFor();
  const screen = (position) =>
    canvas.evaluate((svg, p) => {
      const at = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
      return { x: at.x, y: at.y };
    }, position);
  const point = async (position, click = false, modifiers = []) => {
    const at = await screen(position);
    for (const key of modifiers) await page.keyboard.down(key);
    await page.mouse.move(at.x, at.y);
    if (click) await page.mouse.click(at.x, at.y);
    for (const key of [...modifiers].reverse()) await page.keyboard.up(key);
  };
  const drag = async (from, to) => {
    await point(from);
    await page.mouse.down();
    const at = await screen(to);
    await page.mouse.move(at.x, at.y, { steps: 4 });
    await page.mouse.up();
  };
  const snapshot = () => page.evaluate(() => window.snapshot());
  const selected = () =>
    page.evaluate(() =>
      window
        .layoutContext()
        .selection.map((s) => s.id)
        .sort(),
    );
  const initial = await snapshot();
  const clean = async () => assert.deepEqual(await snapshot(), initial);
  const enableLockedItems = async () => {
    await page
      .getByRole('group', { name: 'Selection', exact: true })
      .getByRole('checkbox', { name: 'Locked items', exact: true })
      .check();
    await canvas.focus();
    await clean();
  };
  try {
    await check({
      page,
      canvas,
      point,
      drag,
      snapshot,
      selected,
      clean,
      initial,
      enableLockedItems,
    });
    assert.deepEqual(errors, [], `${name}: no renderer errors.`);
    console.log(`Layout track lock: ${name}.`);
  } finally {
    await page.close();
  }
}

try {
  await run(
    'native locked tracks require selection opt-in while editing gestures stay blocked',
    async ({ page, canvas, point, drag, selected, clean, enableLockedItems }) => {
      assert.equal(
        await page.getByRole('checkbox', { name: 'Locked items', exact: true }).isChecked(),
        false,
      );
      await point({ x: 30, y: 20 }, true);
      assert.deepEqual(
        await selected(),
        [fixture.pcb.zones[0].id],
        'Default filtering picks the underlying copper zone instead of the locked track.',
      );
      await clean();
      await enableLockedItems();
      await point({ x: 30, y: 20 }, true);
      assert.deepEqual(await selected(), [lockedId]);
      for (const key of ['m', 'd', 'g', 'ArrowRight', 'r', 'Delete']) {
        await canvas.press(key);
        await clean();
        assert.equal(
          await canvas.locator('[data-track-drag-preview]').count(),
          0,
          `${key} cannot start a locked edit.`,
        );
      }
      await drag({ x: 30, y: 20 }, { x: 30, y: 24 });
      assert.deepEqual(await selected(), [lockedId]);
      await clean();
    },
  );

  await run(
    'mixed track selections reject complete edits and preserve unlocked neighbours',
    async ({ canvas, point, drag, selected, clean, enableLockedItems }) => {
      await enableLockedItems();
      await point({ x: 30, y: 20 }, true);
      await point({ x: 30, y: 30 }, true, ['Shift']);
      assert.deepEqual(await selected(), [lockedId, freeId].sort());
      for (const key of ['m', 'd', 'g', 'ArrowUp', 'r', 'Delete']) {
        await canvas.press(key);
        await clean();
      }
      await drag({ x: 30, y: 30 }, { x: 33, y: 33 });
      await clean();
    },
  );

  await run(
    'Properties lock changes retain saved fills and native bytes undo exactly',
    async ({ page, point, snapshot, initial, enableLockedItems }) => {
      await enableLockedItems();
      await point({ x: 30, y: 20 }, true);
      const lock = page.getByRole('checkbox', { name: 'Locked track', exact: true });
      const width = page.getByRole('spinbutton', { name: 'Width (mm)', exact: true });
      assert.equal(await lock.isChecked(), true);
      assert.equal(await width.isDisabled(), true);
      assert.equal(
        await page.getByRole('combobox', { name: 'Track net', exact: true }).isDisabled(),
        true,
      );
      assert.equal(
        await page.getByRole('combobox', { name: 'Track layer', exact: true }).isDisabled(),
        true,
      );
      await lock.uncheck();
      const unlocked = await snapshot();
      assert.equal(unlocked.commits, 1);
      assert.equal(unlocked.undoDepth, 1);
      assert.equal(Object.hasOwn(unlocked.board.tracks[0], 'locked'), false);
      assert.deepEqual(unlocked.board.zones, initial.board.zones);
      assert.equal(unlocked.native.includes('(locked yes)'), false);
      assert.equal(await width.isEnabled(), true);
      await lock.check();
      const relocked = await snapshot();
      assert.equal(relocked.commits, 2);
      assert.equal(relocked.board.tracks[0].locked, true);
      assert.deepEqual(relocked.board.zones, initial.board.zones);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      assert.equal(await lock.isChecked(), false);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      const restored = await snapshot();
      assert.deepEqual(restored.board, initial.board);
      assert.equal(restored.native, initial.native);
      assert.equal(restored.undoDepth, 0);
    },
  );

  await run(
    'unlocking permits copper properties and undo restores their lock and fills',
    async ({ page, point, snapshot, initial, enableLockedItems }) => {
      await enableLockedItems();
      await point({ x: 30, y: 20 }, true);
      const lock = page.getByRole('checkbox', { name: 'Locked track', exact: true });
      const width = page.getByRole('spinbutton', { name: 'Width (mm)', exact: true });
      await lock.uncheck();
      await width.fill('0.8');
      await width.press('Enter');
      const edited = await snapshot();
      assert.equal(edited.undoDepth, 2);
      assert.equal(edited.board.tracks[0].width, 0.8);
      assert.equal(edited.board.zones[0].filledPolygons, undefined);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      const unlocked = await snapshot();
      assert.equal(Object.hasOwn(unlocked.board.tracks[0], 'locked'), false);
      assert.equal(unlocked.board.tracks[0].width, 0.4);
      assert.deepEqual(unlocked.board.zones, initial.board.zones);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      const restored = await snapshot();
      assert.deepEqual(restored.board, initial.board);
      assert.equal(restored.native, initial.native);
      assert.equal(await lock.isChecked(), true);
      assert.equal(await width.isDisabled(), true);
    },
  );
} finally {
  await browser.close();
}
