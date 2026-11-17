import { modelReferenceKey } from '../server/library-format.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { createLibraryService } from '../server/libraries.mjs';

// Real pinned EMC geometry and STEP conversions, with isolated browser requests.
// No Electron, providers, solver, downloads or user project files are involved.
const { parseProject, serializeProject } = await tsImport('../lib/project.ts', import.meta.url);
const { modelMeshGroup, disposeModelGroup } = await tsImport(
  '../lib/model-mesh.ts',
  import.meta.url,
);
const project = parseProject(await readFile('lib/emc-flyback-example.json', 'utf8'));
const original = serializeProject(project);
const renderMode = process.env.OPENPE_RENDER_MODE === 'development' ? 'development' : 'production';
const key = modelReferenceKey;
const service = createLibraryService({ dataDir: '.openpe/model-render-performance' });
const details = new Map(),
  models = new Map(),
  drawCounts = new Map();
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('EMC performance models must remain offline.');
};
let browser;
try {
  for (const footprint of project.pcb.footprints) {
    if (!details.has(footprint.libraryId))
      details.set(
        footprint.libraryId,
        await service.request({ action: 'detail', kind: 'footprints', id: footprint.libraryId }),
      );
    const detail = details.get(footprint.libraryId);
    for (const assigned of footprint.models ?? detail.models) {
      if (assigned.hidden) continue;
      const index = detail.models.findIndex(
        (candidate) => key(candidate.path) === key(assigned.path),
      );
      assert.ok(index >= 0, `${footprint.reference}: official model remains linked.`);
      const id = `${footprint.libraryId}:${index}`;
      if (models.has(id)) continue;
      const result = await service.model(footprint.libraryId, index);
      models.set(id, result);
      const before = result.meshes.reduce((sum, mesh) => sum + (mesh.brep_faces?.length || 1), 0);
      const group = modelMeshGroup(result.meshes);
      const after = group.children.reduce((sum, mesh) => sum + mesh.geometry.groups.length, 0);
      const triangles = group.children.reduce(
        (sum, mesh) => sum + mesh.geometry.index.count / 3,
        0,
      );
      assert.equal(
        triangles,
        result.meshes.reduce((sum, mesh) => sum + mesh.index.array.length / 3, 0),
        'Draw consolidation retains every source triangle.',
      );
      drawCounts.set(id, { before, after });
      disposeModelGroup(group);
    }
  }
  const assembly = { before: 0, after: 0, instances: 0 };
  for (const footprint of project.pcb.footprints) {
    const detail = details.get(footprint.libraryId);
    for (const assigned of footprint.models ?? detail.models) {
      if (assigned.hidden) continue;
      const index = detail.models.findIndex(
        (candidate) => key(candidate.path) === key(assigned.path),
      );
      const count = drawCounts.get(`${footprint.libraryId}:${index}`);
      if (count) {
        assembly.before += count.before;
        assembly.after += count.after;
        assembly.instances++;
      }
    }
  }
  assert.equal(assembly.instances, 83);
  assert.ok(
    assembly.after < assembly.before / 3,
    'Actual EMC placements consolidate redundant face draws.',
  );
  const bundle = await build({
    stdin: {
      contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
      import PCBModelPreview from './components/PCBModelPreview';
      function Fixture(){const [active,setActive]=useState(true),[visible,setVisible]=useState(true),[mounted,setMounted]=useState(true),
        [project,setProject]=useState(window.fixture),[presentationTick,setPresentationTick]=useState(0),[revision,setRevision]=useState(0);
        const[host]=useState(()=>({catalog:()=>[],execute:async()=>{window.modelWork.commits++;throw new Error('This rendering fixture cannot commit design changes.')}}));
        window.setModelActive=value=>{setVisible(value);setActive(value)};window.setModelSuspended=value=>setActive(!value);window.setModelMounted=setMounted;
        window.updateModelSchematic=(id,changes)=>setProject(previous=>({...previous,schematic:{...previous.schematic,parts:previous.schematic.parts.map(part=>part.id===id?{...part,...changes}:part)}}));
        window.refreshModelChrome=()=>setPresentationTick(previous=>previous+1);
        window.updateHiddenModel=(id,x)=>{setProject(previous=>({...previous,schematic:{...previous.schematic,title:'Latest hidden schematic',parts:previous.schematic.parts.map(part=>part.id===id?{...part,x}:part)}}));setRevision(previous=>previous+1)};
        window.replaceModel=id=>setProject({...window.fixture,pcb:{...window.fixture.pcb,id}});
        return mounted?<PCBModelPreview board={project.pcb} schematic={project.schematic} active={active} visible={visible} capabilityHost={host} revision={String(revision)} undoDepth={revision} listAction={<span data-model-test-tick={presentationTick}/>}/>:null;}
      createRoot(document.getElementById('root')).render(<Fixture/>);`,
      resolveDir: process.cwd(),
      loader: 'tsx',
    },
    bundle: true,
    write: false,
    outdir: 'test-results/model-render-performance/bundle',
    platform: 'browser',
    jsx: 'automatic',
    jsxDev: renderMode === 'development',
    define: { 'process.env.NODE_ENV': JSON.stringify(renderMode) },
    plugins: [
      {
        name: 'measure-model-work',
        setup(plugin) {
          plugin.onLoad({ filter: /[\\/]PCBModelPreview\.tsx$/ }, async ({ path: file }) => {
            let contents = await readFile(file, 'utf8');
            for (const [marker, replacement] of [
              [
                '  // Layout may emit many edits while Model is hidden.',
                '  window.modelWork.reactRenders++;\n  // Layout may emit many edits while Model is hidden.',
              ],
              [
                '  activeRef.current = active;',
                '  activeRef.current = active;window.modelLifecycle.active=active;',
              ],
              [
                '  schematicRef.current = schematic;',
                '  schematicRef.current = schematic;window.modelSeen={title:schematic?.title,positions:schematic?.parts.map(part=>[part.id,part.x]),revision};',
              ],
              [
                '    const yieldBuild = async () => {',
                `    const yieldBuild = async () => {
                  if(window.holdModelBuild){window.holdModelBuild=false;
                    await new Promise(resolve=>window.modelGate={boardId:board.id,release:resolve});}
                `,
              ],
              [
                '      if (activeRef.current || control.signal.aborted) return;',
                '      if (activeRef.current || control.signal.aborted) return;window.modelLifecycle.waiting.push(board.id);',
              ],
              [
                '      const boundary = boardPolygons(board);',
                '      window.modelWork.start=performance.now();window.modelWork.startBeat=window.modelWork.beats;\n      const boundary = boardPolygons(board);',
              ],
              [
                '      renderer = new THREE.WebGLRenderer({',
                '      window.modelWork.geometryMs=performance.now()-window.modelWork.start;window.modelWork.geometryBeats=window.modelWork.beats-window.modelWork.startBeat;window.modelLifecycle.created.push(board.id);\n      renderer = new THREE.WebGLRenderer({',
              ],
              [
                '      redraw.current = render;',
                '      redraw.current = render;window.inspectModel=()=>({scene,group,components,previewGroup,renderer,camera,orbit,boardId:board.id});',
              ],
              [
                '    updateCadPreview.current = () => {',
                '    updateCadPreview.current = () => {window.modelWork.previewBuilds++;',
              ],
              [
                '      pickAnnotation.current = pick;',
                '      pickAnnotation.current = pick;window.pickModelPoint=pick;',
              ],
              [
                '      const raycaster = new THREE.Raycaster();',
                '      const raycaster = new THREE.Raycaster();const originalIntersect=raycaster.intersectObject.bind(raycaster);raycaster.intersectObject=(...args)=>{window.modelWork.rays++;return originalIntersect(...args)};',
              ],
              [
                '      setReady(true);',
                '      window.modelLifecycle.ready.push(board.id);setReady(true);',
              ],
              [
                '          renderer?.render(scene, camera);',
                '          const renderStart=performance.now();renderer?.render(scene, camera);window.modelWork.frames.push({at:performance.now(),ms:performance.now()-renderStart,calls:renderer.info.render.calls,triangles:renderer.info.render.triangles});',
              ],
            ]) {
              assert.ok(contents.includes(marker), `Model instrumentation finds ${marker.trim()}.`);
              contents = contents.replace(marker, replacement);
            }
            return { contents, loader: 'tsx', resolveDir: path.dirname(file) };
          });
        },
      },
    ],
  });
  globalThis.fetch = originalFetch;
  browser = await chromium.launch({
    headless: true,
    channel:
      process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  });
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/libraries/footprints')
      return route.fulfill({ json: details.get(url.searchParams.get('id')) });
    if (url.pathname === '/api/library-model') {
      const id = `${url.searchParams.get('id')}:${url.searchParams.get('index')}`;
      assert.ok(models.has(id));
      return route.fulfill({ json: models.get(id) });
    }
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost/');
  await page.evaluate((fixture) => {
    window.fixture = fixture;
    window.openpe = { connection: async () => ({ base: 'http://localhost', token: 'test' }) };
    window.modelWork = {
      beats: 0,
      frames: [],
      longTasks: [],
      reactRenders: 0,
      rays: 0,
      previewBuilds: 0,
      commits: 0,
    };
    window.modelLifecycle = { active: true, waiting: [], created: [], ready: [] };
    window.holdModelBuild = true;
    window.heartbeat = setInterval(() => window.modelWork.beats++, 0);
    new PerformanceObserver((list) =>
      window.modelWork.longTasks.push(
        ...list.getEntries().map((entry) => ({ start: entry.startTime, duration: entry.duration })),
      ),
    ).observe({ type: 'longtask', buffered: true });
  }, project);
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({ content: 'html,body,#root,.pcb-model-preview{height:100%;margin:0}' });
  for (const output of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
    await page.addStyleTag({ content: output.text });
  await page.addScriptTag({
    content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
  });
  const nextFrames = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  const gate = async (boardId) => {
    await page.waitForFunction((id) => window.modelGate?.boardId === id, boardId);
  };
  const hidePausedBuild = async (boardId) => {
    await page.evaluate(() => window.setModelActive(false));
    await page.waitForFunction(() => window.modelLifecycle.active === false);
    await page.evaluate(() => {
      window.modelGate.release();
      window.modelGate = null;
    });
    await page.waitForFunction((id) => window.modelLifecycle.waiting.includes(id), boardId);
    await nextFrames();
  };
  const ready = async (boardId) => {
    await page.waitForFunction(
      (id) =>
        document.querySelector('.pcb-model-canvas canvas') &&
        !document.querySelector('.pcb-model-status') &&
        window.inspectModel?.().boardId === id,
      boardId,
      { timeout: 60000 },
    );
    await nextFrames();
  };
  // Hold the real first checkpoint, hide before its timer resumes, then release
  // into the actual inactive wait. No geometry or renderer may publish early.
  await gate(project.pcb.id);
  await hidePausedBuild(project.pcb.id);
  assert.deepEqual(await page.evaluate(() => window.modelLifecycle.created), []);
  assert.deepEqual(await page.evaluate(() => window.modelLifecycle.ready), []);
  assert.equal(await page.locator('.pcb-model-canvas canvas').count(), 0);
  await page.evaluate(() => window.setModelActive(true));
  await ready(project.pcb.id);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const report = await page.evaluate(() => {
    clearInterval(window.heartbeat);
    const work = window.modelWork;
    const geometryTasks = work.longTasks.filter(
      (task) => task.start >= work.start && task.start < work.start + work.geometryMs,
    );
    return {
      geometryMs: work.geometryMs,
      geometryHeartbeats: work.geometryBeats,
      longestGeometryTaskMs: Math.max(0, ...geometryTasks.map((task) => task.duration)),
      calls: work.frames.at(-1).calls,
      triangles: work.frames.at(-1).triangles,
      renderMs: work.frames.at(-1).ms,
      loaded: window.inspectModel().components.children.filter((object) => object.isGroup).length,
      source: window.fixture,
    };
  });
  assert.ok(
    report.geometryHeartbeats >= 8,
    'Input tasks run between actual board geometry phases.',
  );
  assert.equal(report.loaded, assembly.instances);
  assert.equal(
    serializeProject(report.source),
    original,
    'All presentation work preserves native design bytes.',
  );
  delete report.source;
  const linkedPart = project.schematic.parts.find((part) =>
    project.pcb.footprints.some((footprint) => footprint.symbolId === part.id),
  );
  assert.ok(linkedPart);
  const beforePose = await page.evaluate(() => {
    const { renderer, scene, camera, orbit } = window.inspectModel();
    window.retainedModel = { renderer, scene };
    return {
      created: [...window.modelLifecycle.created],
      position: camera.position.toArray(),
      target: orbit.target.toArray(),
    };
  });
  await page.evaluate(({ id, x }) => window.updateModelSchematic(id, { x }), {
    id: linkedPart.id,
    x: linkedPart.x + 1.27,
  });
  await nextFrames();
  assert.deepEqual(
    await page.evaluate(() => {
      const { renderer, scene, camera, orbit } = window.inspectModel();
      return {
        retained:
          renderer === window.retainedModel.renderer && scene === window.retainedModel.scene,
        created: window.modelLifecycle.created,
        position: camera.position.toArray(),
        target: orbit.target.toArray(),
      };
    }),
    { retained: true, ...beforePose },
    'Unrelated schematic poses retain the complete Model scene, models and camera.',
  );
  const interactions = [];
  const clearInteractions = () =>
    page.evaluate(() => {
      window.modelWork.frames = [];
      window.modelWork.longTasks = [];
      window.modelWork.reactRenders = 0;
    });
  const collectInteraction = async (name) => {
    await page.waitForFunction(
      () => {
        const frame = window.modelWork.frames.at(-1);
        return frame && performance.now() - frame.at > 120;
      },
      null,
      { timeout: 15000 },
    );
    const result = await page.evaluate(() => {
      const { frames, longTasks, reactRenders } = window.modelWork;
      const median = (values) =>
        [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
      return {
        frames: frames.length,
        renderMedianMs: median(frames.map((frame) => frame.ms)),
        renderMaxMs: Math.max(0, ...frames.map((frame) => frame.ms)),
        frameIntervalMedianMs: median(
          frames.slice(1).map((frame, index) => frame.at - frames[index].at),
        ),
        longTasks: longTasks.map((task) => Math.round(task.duration)),
        reactRenders,
      };
    });
    interactions.push({ name, ...result });
    return result;
  };
  await clearInteractions();
  const canvas = page.locator('.pcb-model-canvas canvas');
  const viewport = await canvas.boundingBox();
  await page.mouse.move(viewport.x + viewport.width * 0.45, viewport.y + viewport.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(viewport.x + viewport.width * 0.65, viewport.y + viewport.height * 0.65, {
    steps: 24,
  });
  await page.mouse.up();
  const orbitInteraction = await collectInteraction('orbit24');
  assert.equal(
    orbitInteraction.reactRenders,
    0,
    'Orbit does not rerender the Model tools/properties.',
  );
  await clearInteractions();
  for (let index = 0; index < 4; index++) await page.mouse.wheel(0, index % 2 ? 120 : -120);
  const zoomInteraction = await collectInteraction('wheelZoom4');
  assert.equal(
    zoomInteraction.reactRenders,
    0,
    'Zoom updates only its readout without rerendering Model tools/properties.',
  );
  const picking = await page.evaluate(() => {
    const { components, camera } = window.inspectModel();
    const samples = components.children
      .filter((object) => object.visible && object.isGroup)
      .slice(0, 20)
      .map((object) => {
        const point = object.position.clone().project(camera);
        const rect = document.querySelector('.pcb-model-canvas').getBoundingClientRect();
        const at = { x: (point.x + 1) * 500, y: ((1 - point.y) * 500 * rect.height) / rect.width };
        const start = performance.now(),
          id = window.pickModelPoint(at);
        return { ms: performance.now() - start, id, at };
      });
    return {
      queries: samples.length,
      hits: samples.filter((sample) => sample.id).length,
      medianMs: samples.map((sample) => sample.ms).sort((a, b) => a - b)[
        Math.floor(samples.length / 2)
      ],
      maxMs: Math.max(...samples.map((sample) => sample.ms)),
      target: samples.find((sample) => sample.id)?.at,
    };
  });
  assert.ok(picking.hits > 0, 'Actual STEP picking resolves visible component geometry.');
  await page.evaluate(() => {
    window.modelWork.rays = 0;
  });
  await page.mouse.click(
    viewport.x + (picking.target.x / 1000) * viewport.width,
    viewport.y + (picking.target.y / 1000) * viewport.width,
  );
  await nextFrames();
  assert.equal(
    await page.evaluate(() => window.modelWork.rays),
    1,
    'A component click performs one exact scene query when CAD categories are empty.',
  );
  delete picking.target;
  await page.getByRole('button', { name: 'Place box', exact: true }).click();
  await page.waitForFunction(() => window.inspectModel().previewGroup.children.length === 1);
  const previewBuilds = await page.evaluate(() => {
    window.retainedCadPreview = window.inspectModel().previewGroup.children[0];
    return window.modelWork.previewBuilds;
  });
  await page.evaluate(() => window.refreshModelChrome());
  await nextFrames();
  assert.deepEqual(
    await page.evaluate(() => ({
      retained: window.inspectModel().previewGroup.children[0] === window.retainedCadPreview,
      builds: window.modelWork.previewBuilds,
      commits: window.modelWork.commits,
    })),
    { retained: true, builds: previewBuilds, commits: 0 },
    'Unrelated Model rendering retains the exact CAD preview without geometry rebuilding or design writes.',
  );
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.inspectModel().previewGroup.children.length === 0);
  await page.evaluate(() => window.setModelActive(false));
  await page.waitForFunction(() => !window.modelLifecycle.active);
  await nextFrames();
  const hiddenRenders = await page.evaluate(() => window.modelWork.reactRenders);
  let latestHiddenX = linkedPart.x;
  for (let index = 0; index < 3; index++) {
    latestHiddenX = linkedPart.x + 5.08 + index * 1.27;
    await page.evaluate(({ id, x }) => window.updateHiddenModel(id, x), {
      id: linkedPart.id,
      x: latestHiddenX,
    });
    await nextFrames();
  }
  assert.equal(
    await page.evaluate(() => window.modelWork.reactRenders),
    hiddenRenders,
    'Hidden document/revision/undo changes do not render retained Model tools or properties.',
  );
  await page.evaluate(() => window.setModelActive(true));
  await nextFrames();
  assert.deepEqual(
    await page.evaluate(
      (id) => ({
        title: window.modelSeen.title,
        x: window.modelSeen.positions.find(([partId]) => partId === id)[1],
        revision: window.modelSeen.revision,
        rendererRetained: window.inspectModel().renderer === window.retainedModel.renderer,
      }),
      linkedPart.id,
    ),
    {
      title: 'Latest hidden schematic',
      x: latestHiddenX,
      revision: '3',
      rendererRetained: true,
    },
    'Reactivation consumes the latest deferred document/revision while retaining the unaffected scene.',
  );
  await page.evaluate(() => window.setModelSuspended(true));
  await nextFrames();
  const suspendedRenders = await page.evaluate(() => window.modelWork.reactRenders);
  await page.evaluate(() => window.refreshModelChrome());
  await nextFrames();
  assert.ok(
    (await page.evaluate(() => window.modelWork.reactRenders)) > suspendedRenders,
    'A visible Model suspended by a modal still receives presentation updates.',
  );
  await page.evaluate(() => window.setModelSuspended(false));
  await nextFrames();
  // A newer hidden board supersedes an already paused build. Reactivating must
  // cancel that old continuation before it can create a renderer or report ready.
  await page.evaluate(() => {
    window.holdModelBuild = true;
    window.replaceModel('paused-replacement');
  });
  await gate('paused-replacement');
  await hidePausedBuild('paused-replacement');
  const beforeReplacement = await page.evaluate(() => ({
    created: [...window.modelLifecycle.created],
    ready: [...window.modelLifecycle.ready],
  }));
  await page.evaluate(() => {
    window.holdModelBuild = true;
    window.replaceModel('latest-replacement');
    window.setModelActive(true);
  });
  await gate('latest-replacement');
  await page.evaluate(() => {
    window.modelGate.release();
    window.modelGate = null;
  });
  await ready('latest-replacement');
  assert.deepEqual(await page.evaluate(() => window.modelLifecycle.created), [
    ...beforeReplacement.created,
    'latest-replacement',
  ]);
  assert.deepEqual(await page.evaluate(() => window.modelLifecycle.ready), [
    ...beforeReplacement.ready,
    'latest-replacement',
  ]);
  assert.equal(await page.locator('.pcb-model-canvas canvas').count(), 1);

  // Unmount while the real inactive checkpoint is waiting, then mount a fresh
  // board. The cancelled build must never append a late canvas or ready state.
  await page.evaluate(() => {
    window.holdModelBuild = true;
    window.replaceModel('paused-unmount');
  });
  await gate('paused-unmount');
  await hidePausedBuild('paused-unmount');
  const beforeUnmount = await page.evaluate(() => ({
    created: [...window.modelLifecycle.created],
    ready: [...window.modelLifecycle.ready],
  }));
  await page.evaluate(() => window.setModelMounted(false));
  await page.locator('.pcb-model-preview').waitFor({ state: 'detached' });
  await nextFrames();
  assert.equal(await page.locator('.pcb-model-canvas canvas').count(), 0);
  assert.deepEqual(await page.evaluate(() => window.modelLifecycle.created), beforeUnmount.created);
  assert.deepEqual(await page.evaluate(() => window.modelLifecycle.ready), beforeUnmount.ready);
  await page.evaluate(() => {
    window.replaceModel('latest-after-unmount');
    window.setModelActive(true);
    window.setModelMounted(true);
  });
  await ready('latest-after-unmount');
  assert.deepEqual(await page.evaluate(() => window.modelLifecycle.created), [
    ...beforeUnmount.created,
    'latest-after-unmount',
  ]);
  assert.deepEqual(await page.evaluate(() => window.modelLifecycle.ready), [
    ...beforeUnmount.ready,
    'latest-after-unmount',
  ]);
  assert.equal(await page.locator('.pcb-model-canvas canvas').count(), 1);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      assembly,
      ...report,
      earlyLifecycle: 'hide/resume, replacement and unmount passed',
      interactions,
      picking,
    }),
  );
} finally {
  await browser?.close();
  service.close();
  globalThis.fetch = originalFetch;
}
