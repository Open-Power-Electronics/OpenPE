import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { setLayoutVisibility } from './visualization-test-helpers.mjs';

const { parseProject } = await tsImport('../lib/project.ts', import.meta.url);
const project = parseProject(await readFile('lib/emc-flyback-example.json', 'utf8'));
const trackId = 'e5b79686-7bce-4eeb-bc33-cc09e12ffe67';
const pickup = { x: 87, y: 114.24975 };
const target = { x: 85, y: pickup.y };
const mode = process.env.OPENPE_TEST_REACT_MODE ?? 'development';
// Actual EMC documents and ProjectCore, in an isolated browser. No services,
// desktop instances, providers or native/user file writes are involved.
const bundle = await build({
  stdin: {
    contents: `import React,{useState,useRef,useEffect} from 'react';import {createRoot} from 'react-dom/client';
      import LayoutEditor from './components/LayoutEditor';
      import {ProjectCore} from './core/project-core';
      import {child,children,parseSExpr,val,writeSExpr} from './lib/sexpr';
      function Test(){
        const [core]=useState(()=>new ProjectCore(window.fixture));
        const [snapshot,setSnapshot]=useState(core.getSnapshot),[active,setActive]=useState(true);
        const context=useRef(null);window.layoutContext=()=>context.current;window.setLayoutActive=setActive;
        useEffect(()=>core.subscribe(event=>setSnapshot(event.snapshot)),[core]);
        window.readState=()=>({board:core.getSnapshot().project.pcb,commits:window.commits,sourcePending:core.getSnapshot().sourceDraft!==null,error:window.commitError});
        window.stageSource=()=>{const file=core.getNativeFiles().files.find(file=>file.name.endsWith('.kicad_pcb'));core.updateNativeSource(file.name,file.source+'\\n')};
        window.clearSource=()=>core.discardSource();
        window.applySourceChange=()=>{const file=core.getNativeFiles().files.find(file=>file.name.endsWith('.kicad_pcb'));
          const root=parseSExpr(file.source),segment=children(root,'segment').find(item=>val(child(item,'uuid'))===window.trackId);
          const start=child(segment,'start');start[1]=String(Number(start[1])+0.5);
          core.updateNativeSource(file.name,writeSExpr(root)+'\\n');core.applySource();};
        return <LayoutEditor leftButtonDrag="drag-any" board={snapshot.project.pcb} schematic={snapshot.project.schematic} active={active}
          agentContextRef={context} draftStatus={snapshot.sourceDraft!==null?'Pending Source edits':''}
          onCommit={next=>{try{const changed=core.replaceBoard(next);if(changed)window.commits++;return true}
            catch(error){window.commitError=error.message;return false}}}
          undoAction={<button aria-label="Undo" disabled={!snapshot.canUndo} onClick={()=>core.undo()}>Undo</button>}
          annotations={[]} annotationSessionId="track-constraint" onAnnotationsChange={()=>{}}/>;
      }
      createRoot(document.getElementById('root')).render(<Test/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': JSON.stringify(mode) },
});
const styles = await Promise.all(
  ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'].map((file) =>
    readFile(file, 'utf8'),
  ),
);
const geometry = (tracks) =>
  tracks
    .map(({ id, start, end, width }) => ({ id, start, end, width }))
    .sort((a, b) => a.id.localeCompare(b.id));
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});
const pattern = process.argv[2] ? new RegExp(process.argv[2]) : null;
async function run(name, check) {
  if (pattern && !pattern.test(name)) return;
  const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.route('http://localhost/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
    );
    await page.goto('http://localhost');
    await page.evaluate(
      ({ project, trackId }) => {
        window.fixture = project;
        window.trackId = trackId;
        window.commits = 0;
        window.commitError = '';
      },
      { project, trackId },
    );
    for (const content of styles) await page.addStyleTag({ content });
    await page.addStyleTag({ content: 'html,body,#root,.layout-editor{height:100%;margin:0}' });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const canvas = page.getByTestId('layout-canvas');
    await canvas.waitFor();
    await canvas.focus();
    await canvas.press('PageDown');
    const point = async (position, click = false) => {
      const screen = await canvas.evaluate((svg, at) => {
        const point = new DOMPoint(at.x, at.y).matrixTransform(svg.getScreenCTM());
        return { x: point.x, y: point.y };
      }, position);
      await page.mouse.move(screen.x, screen.y);
      if (click) await page.mouse.click(screen.x, screen.y);
    };
    const state = () => page.evaluate(() => window.readState());
    const context = () => page.evaluate(() => window.layoutContext());
    const marker = canvas.locator('[data-track-drag-preview]');
    const preview = async () =>
      geometry(
        await canvas.evaluate((svg) =>
          [...svg.querySelectorAll('[data-selection-id][data-net-id]')].flatMap((group) => {
            const line = [...group.querySelectorAll('line')].at(-1);
            return line
              ? [
                  {
                    id: group.getAttribute('data-selection-id'),
                    start: { x: +line.getAttribute('x1'), y: +line.getAttribute('y1') },
                    end: { x: +line.getAttribute('x2'), y: +line.getAttribute('y2') },
                    width: +line.getAttribute('stroke-width'),
                  },
                ]
              : [];
          }),
        ),
      );
    const start = async (at = pickup) => {
      await point(at, true);
      await canvas.focus();
      await canvas.press('d');
      await marker.waitFor({ state: 'attached' });
    };
    const constrained = async () => {
      assert.equal(await marker.getAttribute('data-track-drag-constrained'), 'true');
      assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
      const observed = (await context()).connectedTrackDrag;
      assert.equal(observed.constrained, true);
      assert.equal(observed.blocked, false);
      assert.deepEqual(observed.appliedDelta, { x: -1.429688, y: 0 });
      const displayed = await preview();
      const selected = displayed.find((item) => item.id === trackId);
      assert.deepEqual(selected.start, { x: 85.570312, y: 117.689812 });
      assert.deepEqual(selected.end, { x: 85.570312, y: 110.809688 });
      assert.equal(displayed.length, project.pcb.tracks.length + 1);
      assert.match(await page.locator('.layout-status').innerText(), /Stopped at obstacle/);
      return displayed;
    };
    await check({ page, canvas, point, state, context, marker, preview, start, constrained });
    assert.deepEqual(errors, []);
    console.log(`Layout track constraint (${mode}): ${name}.`);
  } finally {
    await page.close();
  }
}
try {
  await run(
    'EMC D stops without rebounding and commits its exact displayed boundary once with undo',
    async ({ page, canvas, point, state, marker, start, constrained }) => {
      await start();
      await point(target);
      const displayed = await constrained();
      assert.equal((await state()).commits, 0);
      assert.deepEqual((await state()).board, project.pcb);
      await canvas.press('Enter');
      assert.equal(await marker.count(), 0);
      assert.equal((await state()).commits, 1);
      assert.deepEqual(geometry((await state()).board.tracks), displayed);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      assert.deepEqual((await state()).board, project.pcb);
    },
  );
  await run(
    'EMC pointer release commits its displayed constrained copper and reconnect identity once',
    async ({ page, point, state, marker, constrained }) => {
      await point(pickup);
      await page.mouse.down();
      await point(target);
      await marker.waitFor({ state: 'attached' });
      const displayed = await constrained();
      assert.equal((await state()).commits, 0);
      await page.mouse.up();
      assert.equal((await state()).commits, 1);
      assert.deepEqual(geometry((await state()).board.tracks), displayed);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      assert.deepEqual((await state()).board, project.pcb);
    },
  );
  await run(
    'returning to a legal current cursor clears the constraint and discards its older boundary',
    async ({ canvas, point, state, marker, preview, start, constrained }) => {
      await start();
      await point(target);
      await constrained();
      await point({ x: 86, y: pickup.y });
      assert.equal(await marker.getAttribute('data-track-drag-constrained'), 'false');
      const displayed = await preview();
      assert.equal(displayed.find((item) => item.id === trackId).start.x, 86);
      await canvas.press('Enter');
      assert.equal((await state()).commits, 1);
      assert.deepEqual(geometry((await state()).board.tracks), displayed);
    },
  );
  await run(
    'Escape and project deactivation discard constrained drafts without a write',
    async ({ page, canvas, point, state, marker, start, constrained }) => {
      await start();
      await point(target);
      await constrained();
      await canvas.press('Escape');
      assert.equal(await marker.count(), 0);
      assert.equal((await state()).commits, 0);
      await start();
      await point(target);
      await constrained();
      await page.evaluate(() => window.setLayoutActive(false));
      await marker.waitFor({ state: 'detached' });
      assert.equal((await state()).commits, 0);
      assert.deepEqual((await state()).board, project.pcb);
    },
  );
  await run(
    'posture changes recompute the current constraint before exact placement',
    async ({ canvas, point, state, preview, start, constrained }) => {
      await start();
      await point(target);
      await constrained();
      await canvas.press('/');
      await constrained();
      const displayed = await preview();
      await canvas.press('Enter');
      assert.equal((await state()).commits, 1);
      assert.deepEqual(geometry((await state()).board.tracks), displayed);
    },
  );
  await run(
    'layer changes cancel the constrained draft and cannot commit its previous board',
    async ({ page, canvas, point, state, marker, start, constrained }) => {
      await start();
      await point(target);
      await constrained();
      await setLayoutVisibility(page, 'B.Cu', false);
      await marker.waitFor({ state: 'detached' });
      await canvas.press('Enter');
      assert.equal((await state()).commits, 0);
      assert.deepEqual((await state()).board, project.pcb);
    },
  );
  await run(
    'pending native Source rejects a boundary commit and retains the exact explicit draft for retry',
    async ({ page, canvas, point, state, marker, preview, start, constrained }) => {
      await start();
      await point(target);
      const displayed = await constrained();
      await page.evaluate(() => window.stageSource());
      assert.equal((await state()).sourcePending, true);
      await canvas.press('Enter');
      assert.equal((await state()).commits, 0);
      assert.match((await state()).error, /Apply the Source edits/);
      assert.equal(await marker.count(), 1);
      assert.deepEqual(await preview(), displayed);
      await page.evaluate(() => window.clearSource());
      await canvas.press('Enter');
      assert.equal((await state()).commits, 1);
      assert.deepEqual(geometry((await state()).board.tracks), displayed);
    },
  );
  await run(
    'applying changed native Source cancels the old constrained basis before placement',
    async ({ page, canvas, point, state, marker, start, constrained }) => {
      await start();
      await point(target);
      await constrained();
      await page.evaluate(() => window.applySourceChange());
      await marker.waitFor({ state: 'detached' });
      const changed = (await state()).board;
      assert.equal(changed.tracks.find((item) => item.id === trackId).start.x, 87.5);
      await canvas.press('Enter');
      assert.equal((await state()).commits, 0);
      assert.deepEqual((await state()).board, changed);
    },
  );
  await run(
    'EMC VBUS drag holds a revalidated boundary at nearby copper',
    async ({ canvas, point, state, marker, preview, start }) => {
      const vbus = { x: 116.54655, y: 64.9017 };
      await canvas.press('PageUp');
      await start(vbus);
      await point({ x: vbus.x, y: vbus.y + 0.5 });
      assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
      await point({ x: vbus.x, y: vbus.y - 4 });
      assert.equal(await marker.getAttribute('data-track-drag-blocked'), 'false');
      assert.equal(await marker.getAttribute('data-track-drag-constrained'), 'true');
      const displayed = await preview();
      assert.notDeepEqual(displayed, geometry(project.pcb.tracks));
      await canvas.press('Enter');
      assert.equal((await state()).commits, 1);
      assert.deepEqual(geometry((await state()).board.tracks), displayed);
    },
  );
} finally {
  await browser.close();
}
