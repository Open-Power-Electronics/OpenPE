import { runCanvasAction } from './canvas-context-menu-test-helpers.mjs';
// Real EMC geometry and Core commits in an isolated headless browser. All
// project data stays in memory; no Electron, services, providers or solvers.
// Usage: node scripts/benchmark-emc-interaction.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import ts from 'typescript';
import { tsImport } from 'tsx/esm/api';
const { parseProject } = await tsImport('../lib/project.ts', import.meta.url);
const { projectNetGroups } = await tsImport('../lib/project-net-groups.ts', import.meta.url);
const topology = (doc) =>
  projectNetGroups(doc)
    .map((group) => [...group.pins].sort())
    .filter((pins) => pins.length)
    .sort();
const project = parseProject(await readFile('lib/emc-flyback-example.json', 'utf8'));
const { defaultSchematicLayers } = await tsImport('../lib/schematic-layers.ts', import.meta.url);
const renderMode = process.env.OPENPE_RENDER_MODE === 'development' ? 'development' : 'production';
const bundle = await build({
  stdin: {
    contents: `import React,{useState,useLayoutEffect} from 'react';import{createRoot}from'react-dom/client';import Canvas from './components/Canvas';import {ProjectCore} from './core/project-core';
window.layoutEffect=useLayoutEffect;
function Fixture(){const[core]=useState(()=>new ProjectCore(window.fixture));const[doc,setDoc]=useState(core.getSnapshot().project.schematic),[selection,setSelection]=useState([]),[tool,setTool]=useState('select');window.state={doc,selection,tool,project:core.getSnapshot().project,undoDepth:core.getSnapshot().undoDepth};window.select=setSelection;window.undo=()=>{core.undo();setDoc(core.getSnapshot().project.schematic)};
return <Canvas active doc={doc} selection={selection} onSelection={setSelection} onSelect={id=>setSelection(id?[id]:[])} tool={tool} setTool={setTool} kind="R" annotations={[]} annotationSessionId="trace" onAnnotationsChange={()=>{}} fitKey={1} onPosition={()=>{}} onCommit={next=>{const start=performance.now();window.lastPreviewPayload=next;const accepted=core.replaceSchematic(next);window.metrics.commits.push(performance.now()-start);setDoc(core.getSnapshot().project.schematic);return accepted}} grid={true} gridSpacing={1.27} layers={window.layers}/>;}
createRoot(document.getElementById('root')).render(<Fixture/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  jsx: 'automatic',
  jsxDev: renderMode === 'development',
  define: { 'process.env.NODE_ENV': JSON.stringify(renderMode) },
  plugins: [
    {
      name: 'timing',
      setup(plugin) {
        plugin.onLoad(
          { filter: /[\\/](Canvas\.tsx|schematic-move\.ts)$/ },
          async ({ path: file }) => {
            let code = await readFile(file, 'utf8');
            assert.ok(
              code.includes(
                file.endsWith('Canvas.tsx') ? 'function move(' : 'function previewSchematicMove(',
              ),
            );
            if (file.endsWith('Canvas.tsx'))
              code = code.replace(
                '  const svg = useRef<SVGSVGElement>(null);',
                '  const renderStart=performance.now(); window.layoutEffect(()=>{window.metrics.renders.push(performance.now()-renderStart)});\n  const svg = useRef<SVGSVGElement>(null);',
              );
            const sf = ts.createSourceFile(
              file,
              code,
              ts.ScriptTarget.Latest,
              true,
              file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
            );
            const insert = [];
            function visit(n) {
              if (
                ts.isFunctionDeclaration(n) &&
                n.body &&
                ['move', 'previewSchematicMove'].includes(n.name?.text)
              ) {
                const key = n.name.text;
                insert.push(
                  [n.body.getStart(sf) + 1, `const timingStart=performance.now();try{`],
                  [
                    n.body.end - 1,
                    `}finally{(window.metrics.${key}??=[]).push(performance.now()-timingStart)}`,
                  ],
                );
              }
              ts.forEachChild(n, visit);
            }
            visit(sf);
            insert.sort((a, b) => b[0] - a[0]);
            for (const [p, t] of insert) code = code.slice(0, p) + t + code.slice(p);
            return {
              contents: code,
              loader: file.endsWith('tsx') ? 'tsx' : 'ts',
              resolveDir: path.dirname(file),
            };
          },
        );
      },
    },
  ],
});
const browser = await chromium.launch({
  headless: true,
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('http://localhost/**', (r) =>
    r.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  await page.evaluate(
    ({ project, layers }) => {
      window.fixture = project;
      window.layers = layers;
      window.metrics = { renders: [], move: [], previewSchematicMove: [], commits: [] };
      window.longtasks = [];
      new PerformanceObserver((l) =>
        window.longtasks.push(
          ...l.getEntries().map((e) => ({ start: e.startTime, duration: e.duration })),
        ),
      ).observe({ entryTypes: ['longtask'] });
    },
    { project, layers: defaultSchematicLayers },
  );
  for (const f of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(f, 'utf8') });
  await page.addStyleTag({ content: 'html,body,#root,.canvas-wrap{height:100%;margin:0}' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const canvas = page.getByTestId('schematic-canvas');
  await canvas.waitFor();
  await page.waitForTimeout(400);
  const clear = () =>
    page.evaluate(() => {
      window.metrics = { renders: [], move: [], previewSchematicMove: [], commits: [] };
      window.longtasks = [];
    });
  const result = async (name) => {
    await page.waitForTimeout(100);
    const r = await page.evaluate(() => ({ metrics: window.metrics, longtasks: window.longtasks }));
    const summary = {
      name,
      longtasks: r.longtasks.map((v) => Math.round(v.duration)),
      ...Object.fromEntries(
        Object.entries(r.metrics).map(([k, v]) => [
          k,
          {
            n: v.length,
            max: Math.max(0, ...v),
            total: v.reduce((a, b) => a + b, 0),
            median: [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)],
          },
        ]),
      ),
    };
    console.log(JSON.stringify(summary));
    return r;
  };
  await clear();
  for (const p of project.schematic.parts.slice(0, 16))
    await page.evaluate((id) => window.select([id]), p.id);
  await result('16 direct selections');
  await clear();
  await page.mouse.move(500, 450);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(900, 650, { steps: 24 });
  await page.mouse.up({ button: 'middle' });
  await result('pan 24 events');
  await clear();
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(100);
  await page.mouse.wheel(0, 600);
  await result('2 wheel zoom');
  assert.equal(await page.evaluate(() => window.state.undoDepth), 0);
  await runCanvasAction(page, 'Fit to canvas');
  const part = project.schematic.parts.find((p) => p.ref === 'R1');
  await page.evaluate((id) => window.select([id]), part.id);
  const toScreen = (p) =>
    canvas.evaluate((svg, p) => {
      const pt = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
      return { x: pt.x, y: pt.y };
    }, p);
  const screen = await toScreen(part);
  const target = await toScreen({ x: part.x + 20.32, y: part.y + 10.16 });
  await page.mouse.move(screen.x, screen.y);
  await canvas.focus();
  await page.keyboard.press('g');
  await clear();
  await page.mouse.move(target.x, target.y, { steps: 16 });
  await result('connected G drag 16 events');
  assert.equal(await page.evaluate(() => window.state.undoDepth), 0, 'Previews do not commit.');
  const retainedPose = await canvas.getByTestId(`part-${part.ref}`).innerHTML();
  await clear();
  for (let index = 0; index < 12; index++)
    await canvas.dispatchEvent('pointermove', {
      pointerId: 1,
      clientX: target.x + (index % 2 ? 0.01 : 0),
      clientY: target.y,
    });
  const repeatedPose = await result('12 pointer events within the same snapped G pose');
  assert.equal(repeatedPose.metrics.move.length, 12, 'All pointer events reach the real Canvas.');
  assert.equal(
    repeatedPose.metrics.previewSchematicMove.length,
    0,
    'An unchanged snapped pose retains its exact preview without repeated rerouting.',
  );
  assert.equal(
    repeatedPose.metrics.renders.length,
    0,
    'An unchanged pose does not redraw the canvas.',
  );
  assert.equal(await canvas.getByTestId(`part-${part.ref}`).innerHTML(), retainedPose);
  await clear();
  await page.keyboard.press('Enter');
  const connectedCommit = await result('connected G commit');
  assert.equal(connectedCommit.metrics.commits.length, 1);
  const committed = await page.evaluate(() => ({
    state: window.state,
    payload: window.lastPreviewPayload,
  }));
  assert.equal(committed.state.undoDepth, 1);
  assert.deepEqual(committed.state.doc, committed.payload, 'The exact rendered pose is committed.');
  assert.deepEqual(topology(committed.state.doc), topology(project.schematic));
  assert.deepEqual(
    committed.state.project.pcb,
    project.pcb,
    'Schematic movement retains PCB data.',
  );
  await page.evaluate(() => window.undo());
  await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(() => window.state.doc), project.schematic);
  await page.keyboard.press('Escape');
  await page.mouse.move(screen.x, screen.y);
  await page.keyboard.press('m');
  await clear();
  await page.mouse.move(target.x, target.y, { steps: 16 });
  await result('unconnected M move 16 events');
  await page.keyboard.press('Escape');
  assert.deepEqual(
    await page.evaluate(() => window.state.doc),
    project.schematic,
    'Cancellation preserves the original document.',
  );
  assert.equal(await page.evaluate(() => window.state.undoDepth), 0);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
