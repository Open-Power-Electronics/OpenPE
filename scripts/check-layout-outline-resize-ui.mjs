import { runCanvasAction } from './canvas-context-menu-test-helpers.mjs';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
const { parseProject } = await tsImport('../lib/project.ts', import.meta.url);
const { uid } = await tsImport('../lib/circuit.ts', import.meta.url);
const { findPCBRectangle } = await tsImport('../lib/pcb-outline-resize.ts', import.meta.url);
const { parseKiCadPCB } = await tsImport('../lib/kicad-pcb.ts', import.meta.url);
const sources = JSON.parse(await readFile('lib/reference-examples.json', 'utf8'));
// Actual LM2596 documents with ProjectCore, isolated from Electron/services/user files.
const bundle = await build({
  stdin: {
    contents: `
import React,{useState,useEffect} from 'react';import {createRoot} from 'react-dom/client';
import LayoutEditor from './components/LayoutEditor';import {ProjectCore} from './core/project-core';
function Test(){const [core]=useState(()=>new ProjectCore(window.fixture));
 const [snapshot,setSnapshot]=useState(core.getSnapshot),[active,setActive]=useState(true);
 useEffect(()=>core.subscribe(event=>setSnapshot(event.snapshot)),[core]);window.setActive=setActive;
 window.state=()=>({board:core.getSnapshot().project.pcb,commits:window.commits,
   files:core.getNativeFiles().files,sourcePending:core.getSnapshot().sourceDraft!==null});
 window.stageSource=()=>{const file=core.getNativeFiles().files.find(f=>f.name.endsWith('.kicad_pcb'));core.updateNativeSource(file.name,file.source+'\\n')};
 window.clearSource=()=>core.discardSource();
 return <LayoutEditor board={snapshot.project.pcb} schematic={snapshot.project.schematic} active={active} leftButtonDrag="drag-any"
 onCommit={next=>{try{const changed=core.replaceBoard(next);if(changed)window.commits++;return true}catch(e){window.commitError=e.message;return false}}}
 undoAction={<button aria-label="Undo" onClick={()=>core.undo()}>Undo</button>}
 annotations={[]} annotationSessionId="resize" onAnnotationsChange={()=>{}}/>}
createRoot(document.getElementById('root')).render(<Test/>);`,
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
await mkdir('test-results', { recursive: true });
try {
  for (const polygon of [true, false, 'zone']) {
    const isZone = polygon === 'zone';
    const handleAttribute = isZone ? 'data-zone-resize-handle' : 'data-outline-resize-handle';
    const project = parseProject(sources['reference-lm2596-to220-5-buck']);
    const old = project.pcb.graphics.find((g) => g.layer === 'Edge.Cuts');
    if (!polygon) {
      const points = [old.start, ...old.points, old.end];
      project.pcb.graphics = project.pcb.graphics
        .filter((g) => g !== old)
        .concat(
          points.map((start, i) => ({
            id: uid(),
            layer: 'Edge.Cuts',
            width: old.width,
            start,
            end: points[(i + 1) % points.length],
          })),
        );
    }
    const frame = isZone
      ? project.pcb.zones.find((z) => z.layer === 'F.Cu' && !z.keepout)
      : project.pcb.graphics.find((g) => g.layer === 'Edge.Cuts');
    const targetSelection = [{ kind: isZone ? 'zone' : 'graphic', id: frame.id }];
    const rectangle = findPCBRectangle(project.pcb, targetSelection);
    const page = await browser.newPage({ viewport: { width: 1400, height: 950 } }),
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.route('http://localhost/**', (route) =>
        route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
      );
      await page.goto('http://localhost');
      await page.evaluate((project) => {
        window.fixture = project;
        window.commits = 0;
      }, project);
      for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
        await page.addStyleTag({ content: await readFile(file, 'utf8') });
      await page.addStyleTag({ content: 'html,body,#root,.layout-editor{height:100%;margin:0}' });
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      const canvas = page.getByTestId('layout-canvas');
      await canvas.waitFor();
      await runCanvasAction(page, 'Fit board to canvas');
      const screen = (position) =>
        canvas.evaluate((svg, p) => {
          const at = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
          return { x: at.x, y: at.y };
        }, position);
      const select = async () => {
        await page.getByRole('button', { name: frame.layer, exact: true }).click();
        const at = await screen({
          x: (rectangle.bounds.minX + rectangle.bounds.maxX) / 2,
          y: rectangle.bounds.minY,
        });
        await page.mouse.click(at.x, at.y);
      };
      const state = () => page.evaluate(() => window.state());
      const handle = (name) => canvas.locator('[' + handleAttribute + '="' + name + '"]');
      const move = async (name, delta, finish = true) => {
        const box = await handle(name).boundingBox();
        const p = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        const v = await canvas.evaluate((svg, d) => {
          const m = svg.getScreenCTM();
          return { x: d.x * m.a, y: d.y * m.d };
        }, delta);
        await page.mouse.move(p.x, p.y);
        await page.mouse.down();
        await page.mouse.move(p.x + v.x, p.y + v.y, { steps: 3 });
        if (finish) await page.mouse.up();
      };
      await select();
      await handle('se').waitFor();
      assert.equal(await canvas.locator('[' + handleAttribute + ']').count(), 8);
      const original = await state();
      await move('se', { x: 0, y: 0 });
      assert.deepEqual(
        await state(),
        original,
        'An untouched off-grid corner stays exact and clean.',
      );
      await move('se', { x: 0.01, y: 0.01 });
      assert.deepEqual(await state(), original, 'Sub-threshold pointer jitter stays clean.');
      await move('se', { x: -3, y: -2.5 }, false);
      assert.equal((await state()).commits, 0);
      assert.deepEqual((await state()).board, original.board);
      await page.screenshot({
        path:
          'test-results/outline-resize-' +
          (isZone ? 'zone' : polygon ? 'polygon' : 'lines') +
          '.png',
      });
      const shown = await canvas
        .locator('[data-layout-region-resize] > rect')
        .first()
        .evaluate((r) => ({
          x: +r.getAttribute('x'),
          y: +r.getAttribute('y'),
          width: +r.getAttribute('width'),
          height: +r.getAttribute('height'),
        }));
      await page.mouse.up();
      const after = await state();
      assert.equal(after.commits, 1);
      const bounds = findPCBRectangle(after.board, targetSelection).bounds;
      assert.deepEqual(bounds, {
        minX: shown.x,
        minY: shown.y,
        maxX: shown.x + shown.width,
        maxY: shown.y + shown.height,
      });
      assert.deepEqual(after.board.tracks, original.board.tracks);
      assert.deepEqual(after.board.footprints, original.board.footprints);
      if (isZone)
        assert.deepEqual(
          after.board.graphics,
          original.board.graphics,
          'Zone resizing leaves the board frame and artwork unchanged.',
        );
      const pcbFile = after.files.find((f) => f.name.endsWith('.kicad_pcb'));
      const native = parseKiCadPCB(pcbFile.source, project.schematic, 'outline-resize').board;
      assert.deepEqual(
        findPCBRectangle(native, targetSelection).bounds,
        bounds,
        'The actual native PCB Source matches the displayed resize.',
      );
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      assert.deepEqual((await state()).board, original.board);
      if (isZone) await page.getByRole('tab', { name: 'Bounds', exact: true }).click();
      const width = page.getByRole('spinbutton', { name: 'Width (mm)', exact: true });
      await width.fill(String(rectangle.bounds.maxX - rectangle.bounds.minX + 1.25));
      await width.press('Enter');
      assert.equal((await state()).commits, 2);
      assert.equal(
        findPCBRectangle((await state()).board, targetSelection).bounds.maxX,
        rectangle.bounds.maxX + 1.25,
      );
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      const height = page.getByRole('spinbutton', { name: 'Height (mm)', exact: true });
      await height.fill(String(rectangle.bounds.maxY - rectangle.bounds.minY + 2.25));
      await height.press('Enter');
      assert.equal((await state()).commits, 3);
      assert.equal(
        findPCBRectangle((await state()).board, targetSelection).bounds.maxY,
        rectangle.bounds.maxY + 2.25,
      );
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await move('e', { x: -2, y: 0 }, false);
      await canvas.press('Escape');
      await page.mouse.up();
      assert.deepEqual((await state()).board, original.board);
      assert.equal((await state()).commits, 3);
      await move('e', { x: -2, y: 0 }, false);
      await canvas.press('PageDown');
      await page.mouse.up();
      // A different layer cancels without committing the earlier preview.
      await canvas.press('Escape');
      assert.deepEqual((await state()).board, original.board);
      await select();
      await move('e', { x: -2, y: 0 }, false);
      await page.evaluate(() => window.setActive(false));
      await handle('e').waitFor({ state: 'detached' });
      await page.mouse.up();
      assert.deepEqual((await state()).board, original.board);
      await page.evaluate(() => window.setActive(true));
      await select();
      await page.evaluate(() => window.stageSource());
      await move('e', { x: -2, y: 0 });
      assert.equal((await state()).commits, 3);
      assert.equal((await state()).sourcePending, true);
      await page.evaluate(() => window.clearSource());
      assert.deepEqual(errors, []);
      console.log(
        'Outline resize: ' +
          (isZone ? 'native copper zone' : polygon ? 'native polygon' : 'four native lines') +
          ' handles, exact preview/Source, numeric width, undo, cancellation and Source gate passed.',
      );
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
