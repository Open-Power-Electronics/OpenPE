import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

// Real Three compileAsync polling in an isolated renderer. Test-only gates
// hold program readiness; no Electron, user project, provider or solver runs.
const { createProject } = await tsImport('../lib/project.ts', import.meta.url);
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const project = createProject();
project.pcb = createEmptyPCB();
project.pcb.graphics = [
  {
    id: randomUUID(),
    kind: 'polygon',
    layer: 'Edge.Cuts',
    width: 0.05,
    start: { x: 0, y: 0 },
    points: [
      { x: 50, y: 0 },
      { x: 50, y: 40 },
    ],
    end: { x: 0, y: 40 },
  },
];
project.pcb.footprints = [
  {
    id: randomUUID(),
    symbolId: null,
    libraryId: 'Fixture:Empty',
    reference: 'J1',
    value: 'Fixture',
    x: 10,
    y: 10,
    rotation: 0,
    side: 'front',
    graphics: [],
    pads: [],
  },
];
const bundle = await build({
  stdin: {
    contents: `import React,{useRef,useState}from'react';import{createRoot}from'react-dom/client';
import Preview from'./components/PCBModelPreview';
function Harness(){const[active,setActive]=useState(true),[mounted,setMounted]=useState(true),[board,setBoard]=useState(window.fixture.pcb),view=useRef(null);
window.modelWarmupFixture={setActive,setMounted,replace:id=>setBoard({...window.fixture.pcb,id}),view:()=>view.current};
return mounted?<div style={{height:'100vh'}}><Preview board={board} schematic={window.fixture.schematic} active={active} viewState={view}/></div>:null;}
createRoot(document.getElementById('root')).render(<Harness/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outfile: 'test-results/model-shader-warmup-ui.js',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [
    {
      name: 'control-real-shader-completion',
      setup(plugin) {
        plugin.onLoad({ filter: /[\\/]PCBModelPreview\.tsx$/ }, async ({ path: file }) => {
          let source = await readFile(file, 'utf8');
          for (const [marker, replacement] of [
            [
              'compile: () => renderer!.compileAsync(scene, camera),',
              'compile: () => window.interceptModelWarmup(renderer,scene,camera,board.id),',
            ],
            [
              '          renderer?.render(scene, camera);',
              '          window.modelWarmupFrames.push({board:board.id,compiled:window.modelWarmups.findLast(entry=>entry.renderer===renderer)?.done});renderer?.render(scene, camera);',
            ],
            [
              '      setReady(true);',
              '      window.modelWarmupReady.push(board.id);setReady(true);',
            ],
          ]) {
            assert.ok(source.includes(marker), `Warmup instrumentation finds ${marker.trim()}`);
            source = source.replace(marker, replacement);
          }
          return { contents: source, loader: 'tsx', resolveDir: path.dirname(file) };
        });
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  let requests = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) => {
    if (new URL(route.request().url()).pathname === '/api/libraries/footprints') {
      requests++;
      return route.fulfill({ json: { footprint: ['footprint', '"Fixture"'], models: [] } });
    }
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  await page.evaluate((fixture) => {
    window.fixture = fixture;
    window.openpe = {
      connection: async () => ({ base: 'http://localhost', token: 'shader-warmup-fixture' }),
    };
    window.modelWarmups = [];
    window.modelWarmupReady = [];
    window.modelWarmupFrames = [];
    window.interceptModelWarmup = (renderer, scene, camera, board) => {
      const entry = {
        renderer,
        scene,
        camera,
        board,
        release: false,
        done: false,
        disposed: false,
        polls: 0,
        postDisposeQueries: 0,
      };
      window.modelWarmups.push(entry);
      const originalDispose = renderer.dispose.bind(renderer);
      renderer.dispose = () => {
        entry.disposed = true;
        originalDispose();
      };
      if (window.failModelWarmup) throw new Error('Controlled shader preparation failure');
      const extension = renderer.extensions.get('KHR_parallel_shader_compile');
      if (!extension)
        throw new Error('This check needs KHR_parallel_shader_compile to exercise real polling.');
      const originalCompile = renderer.compile.bind(renderer);
      renderer.compile = (...args) => {
        const materials = originalCompile(...args);
        const programs = new Set(
          [...materials]
            .map((material) => renderer.properties.get(material).currentProgram)
            .filter(Boolean),
        );
        for (const program of programs) {
          const originalReady = program.isReady.bind(program);
          program.isReady = () => {
            entry.polls++;
            if (entry.disposed) entry.postDisposeQueries++;
            return entry.release && originalReady();
          };
        }
        return materials;
      };
      return renderer.compileAsync(scene, camera).then(() => {
        entry.done = true;
      });
    };
  }, project);
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
    await page.addStyleTag({ content: file.text });
  await page.addScriptTag({
    content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
  });
  const frames = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  const entry = (board) =>
    page.evaluate((board) => {
      const item = window.modelWarmups.findLast((item) => item.board === board);
      return (
        item && {
          board: item.board,
          done: item.done,
          disposed: item.disposed,
          polls: item.polls,
          postDisposeQueries: item.postDisposeQueries,
        }
      );
    }, board);
  const held = (board) =>
    page.waitForFunction((board) => {
      const entry = window.modelWarmups.findLast((item) => item.board === board);
      return entry && entry.polls > 1 && !entry.done;
    }, board);
  const release = (board) =>
    page.evaluate((board) => {
      window.modelWarmups.findLast((item) => item.board === board).release = true;
    }, board);
  const completed = (board) =>
    page.waitForFunction(
      (board) => window.modelWarmups.findLast((item) => item.board === board)?.done,
      board,
    );
  const ready = (board) =>
    page.waitForFunction(
      (board) =>
        window.modelWarmupReady.includes(board) && !document.querySelector('.pcb-model-status'),
      board,
    );
  const initial = project.pcb.id;
  await held(initial);
  assert.deepEqual(
    await page.evaluate(() => window.modelWarmupFrames),
    [],
    'Warmup submits no GPU frames.',
  );
  assert.deepEqual(await page.evaluate(() => window.modelWarmupReady), []);
  assert.equal(requests, 0, 'Model requests wait until the scene shaders are prepared.');
  await page.evaluate(() => window.modelWarmupFixture.setActive(false));
  await release(initial);
  await completed(initial);
  await frames();
  assert.deepEqual(await page.evaluate(() => window.modelWarmupFrames), []);
  assert.deepEqual(
    await page.evaluate(() => window.modelWarmupReady),
    [],
    'Hidden warmup completion cannot publish ready.',
  );
  assert.equal(requests, 0);
  await page.evaluate(() => window.modelWarmupFixture.setActive(true));
  await ready(initial);
  assert.equal(requests, 1);
  assert.equal(
    await page.evaluate(() => window.modelWarmupFrames.every((frame) => frame.compiled)),
    true,
  );

  // Cancel a real Three polling loop by replacing its scene before completion.
  await page.evaluate(() => window.modelWarmupFixture.replace('warmup-replaced'));
  await held('warmup-replaced');
  await page.evaluate(() => window.modelWarmupFixture.replace('warmup-current'));
  await completed('warmup-replaced');
  await held('warmup-current');
  const disposed = await entry('warmup-replaced');
  assert.equal(disposed.disposed, true);
  assert.equal(
    disposed.postDisposeQueries,
    0,
    'Disposed renderer properties stop native program polling.',
  );
  await frames();
  assert.equal(
    (await entry('warmup-replaced')).polls,
    disposed.polls,
    'Old compilation leaves no continuing polling work.',
  );
  assert.equal(
    await page.evaluate(() => window.modelWarmupReady.includes('warmup-replaced')),
    false,
  );
  assert.equal(await page.locator('.pcb-model-canvas canvas').count(), 1);

  // Unmount a second in-flight native loop, then verify later mounting remains usable.
  await page.evaluate(() => window.modelWarmupFixture.setMounted(false));
  await completed('warmup-current');
  assert.equal((await entry('warmup-current')).disposed, true);
  assert.equal((await entry('warmup-current')).postDisposeQueries, 0);
  assert.equal(await page.locator('.pcb-model-canvas canvas').count(), 0);
  await page.evaluate(() => {
    window.failModelWarmup = true;
    window.modelWarmupFixture.replace('warmup-failure');
    window.modelWarmupFixture.setMounted(true);
  });
  await page
    .getByRole('status')
    .filter({ hasText: 'Controlled shader preparation failure' })
    .waitFor();
  assert.equal((await entry('warmup-failure')).disposed, true);
  assert.equal(
    await page.evaluate(() => window.modelWarmupReady.includes('warmup-failure')),
    false,
  );
  await page.evaluate(() => {
    window.failModelWarmup = false;
  });
  await page.getByRole('button', { name: 'Retry 3D preview', exact: true }).click();
  await held('warmup-failure');
  await release('warmup-failure');
  await ready('warmup-failure');
  assert.equal(await page.locator('.pcb-model-canvas canvas').count(), 1);
  assert.equal(
    await page.evaluate(() => window.modelWarmupFrames.every((frame) => frame.compiled)),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS: real async shader warmup suppresses early frames/requests, retains hidden completion for resume, cancels polling on replacement/unmount, and reports/retries preparation failure.',
  );
} finally {
  await browser.close();
}
