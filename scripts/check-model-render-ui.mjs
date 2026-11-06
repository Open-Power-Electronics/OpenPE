import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { BoxGeometry } from 'three';
import { tsImport } from 'tsx/esm/api';
import sharp from 'sharp';

// Isolated real WebGL/React coverage. No Electron, native files, providers,
// solvers or remote resources run; the STEP service returns fixed box geometry.
const lifecycleOnly = process.argv.includes('--lifecycle-only');
const preparationBaseline = process.argv.includes('--preparation-baseline');
const rendererSource = await readFile('components/model-studio-renderer.ts', 'utf8');
const sampleTarget = rendererSource.match(/export const MODEL_RENDER_SAMPLES = (\d+);/);
assert.ok(sampleTarget, 'Find the current renderer sample target.');
const expectedRenderSamples = lifecycleOnly ? 1 : Number(sampleTarget[1]);
const outputDirectory = lifecycleOnly
  ? 'test-results/model-render-lifecycle'
  : preparationBaseline
    ? 'test-results/model-render-preparation-baseline'
    : 'test-results/model-render-ui';
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const board = createEmptyPCB();
board.graphics = [
  {
    id: randomUUID(),
    kind: 'polygon',
    layer: 'Edge.Cuts',
    width: 0.05,
    start: { x: 0, y: 0 },
    points: [
      { x: 40, y: 0 },
      { x: 40, y: 30 },
    ],
    end: { x: 0, y: 30 },
  },
];
const netId = randomUUID();
board.nets = [{ id: netId, name: 'GND' }];
board.tracks = [
  {
    id: randomUUID(),
    netId,
    layer: 'F.Cu',
    width: 2,
    start: { x: 3, y: 15 },
    end: { x: 37, y: 15 },
  },
];
board.footprints = [
  {
    id: randomUUID(),
    symbolId: null,
    libraryId: 'Fixture:Transparent',
    reference: 'J1',
    value: 'Cover',
    x: 11,
    y: 25,
    rotation: 0,
    side: 'front',
    pads: [],
    graphics: [],
    models: [
      {
        path: 'Fixture.step',
        opacity: 0.45,
        offset: { x: 0, y: 0, z: 6 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    ],
  },
  {
    id: randomUUID(),
    symbolId: null,
    libraryId: 'Fixture:Colors',
    reference: 'J2',
    value: 'Colored body',
    x: 11,
    y: 11,
    rotation: 0,
    side: 'front',
    pads: [],
    graphics: [],
    models: [
      {
        path: 'Colors.step',
        opacity: 1,
        offset: { x: 0, y: 0, z: 4 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    ],
  },
];
const fixture = {
  board,
  modelCad: {
    version: 1,
    objects: [
      {
        id: randomUUID(),
        name: 'Aluminium block',
        kind: 'box',
        position: { x: 29, y: 15, z: 6 },
        rotation: { x: 0, y: 0, z: 0 },
        size: { x: 12, y: 15, z: 10 },
        material: 'aluminium',
        opacity: 1,
      },
    ],
  },
  view: {
    boardId: board.id,
    position: [56, -52, 85],
    target: [20, -15, 0],
    up: [0, 0, 1],
    zoom: 1,
    extent: 58,
    orthographic: true,
    modelsVisible: true,
    boardDisplay: {
      substrate: true,
      copper: true,
      mask: true,
      silkscreen: true,
    },
  },
};
const geometry = new BoxGeometry(12, 6, 1);
const parsedModel = {
  meshes: [
    {
      color: [0.65, 0.8, 0.95],
      attributes: {
        position: { array: [...geometry.attributes.position.array] },
        normal: { array: [...geometry.attributes.normal.array] },
      },
      index: { array: [...geometry.index.array] },
    },
  ],
};
geometry.dispose();
// A typical STEP mesh has a grey base plus authored per-face colours. The
// installed path-tracer's mesh merge loses material-array groups unless the
// Render adapter normalizes them before upload. Check the actual GPU pixels.
const coloredGeometry = new BoxGeometry(14, 14, 6);
const parsedColoredModel = {
  meshes: [
    {
      color: [0.45, 0.45, 0.45],
      attributes: {
        position: { array: [...coloredGeometry.attributes.position.array] },
        normal: { array: [...coloredGeometry.attributes.normal.array] },
      },
      index: { array: [...coloredGeometry.index.array] },
      brep_faces: coloredGeometry.groups.map((group, index) => ({
        first: group.start / 3,
        last: (group.start + group.count) / 3 - 1,
        color: index === 2 || index === 3 ? [0.015, 0.04, 0.8] : [0.8, 0.025, 0.01],
      })),
    },
  ],
};
coloredGeometry.dispose();

const bundle = await build({
  stdin: {
    contents: `import React,{useRef,useState}from'react';import{createRoot}from'react-dom/client';
import Preview from'./components/PCBModelPreview';
function Footer({center}){return <footer className="status-bar"><div className="status-center">{center}</div></footer>;}
function Harness(){const [active,setActive]=useState(true),[sidebar,setSidebar]=useState(true),[mounted,setMounted]=useState(true);
 const view=useRef(window.initialFixture.view);
 const[host]=useState(()=>({catalog:()=>[],execute:async()=>{window.renderCommits++;throw Error('Rendering cannot edit this fixture.')}}));
 window.setRenderActive=setActive;window.setRenderSidebar=setSidebar;window.setRenderMounted=setMounted;
 return mounted?<div style={{height:'100vh'}}><Preview board={window.initialFixture.board} modelCad={window.initialFixture.modelCad}
 viewState={view} active={active} visible={active} sidebarVisible={sidebar} capabilityHost={host} errorTarget={null} statusBar={<Footer/>}/></div>:null;}
createRoot(document.getElementById('root')).render(<Harness/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outdir: `${outputDirectory}/bundle`,
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [
    {
      name: 'inspect-model-render',
      setup(plugin) {
        plugin.onLoad({ filter: /[\\/]model-studio-renderer\.ts$/ }, async ({ path: filename }) => {
          let source = await readFile(filename, 'utf8');
          if (lifecycleOnly)
            source = source.replace(/MODEL_RENDER_SAMPLES = \d+/, 'MODEL_RENDER_SAMPLES = 1');
          const marker = '  const tracer = new PathTracingRenderer(renderer);';
          assert.ok(source.includes(marker));
          source = source.replace(
            marker,
            `  window.renderPhaseTimings ??= {compilations:[],sceneUploads:[]};
            const backendStarted=performance.now();
            ${marker}
            window.renderPhaseTimings.backendMs=performance.now()-backendStarted;
            window.inspectPathTracer=()=>({samples:tracer.samples,compiling:tracer.isCompiling,compilePending:!!tracer._compilePromise,geometry:generator.geometry.attributes.position?.count,programs:renderer.info.programs?.length,quality:{samples:MODEL_RENDER_SAMPLES,bounces:material.bounces,transmissiveBounces:material.transmissiveBounces,resolutionScale:MODEL_RENDER_RESOLUTION_SCALE,mis:material.defines.FEATURE_MIS,denoise:{sigma:denoise.sigma,kSigma:denoise.kSigma,threshold:denoise.threshold}},maskMaterials:(window.traceMaterials??[]).filter(material=>material.name==='OpenPE Render mask').map(material=>({normal:!!material.normalMap,clearcoatNormal:!!material.clearcoatNormalMap,transmission:material.transmission}))});`,
          );
          source = source.replace(
            '      const results = generator.generate();',
            '      const results = generator.generate(); window.traceMaterials=results.materials;',
          );
          source = source.replace(
            '    setScene(scene, camera) {',
            '    setScene(scene, camera) { const uploadStarted=performance.now();',
          );
          source = source.replace(
            '      denoisedSample = -1;\n    },\n    updateCamera(camera)',
            '      window.renderPhaseTimings.sceneUploads.push(performance.now()-uploadStarted);\n      denoisedSample = -1;\n    },\n    updateCamera(camera)',
          );
          source = source.replace(
            '      tracer.update();',
            `      window.renderSamplingStarted ??= performance.now();
            window.renderTraceTiles=(window.renderTraceTiles??0)+1;
            tracer.update();
            const sample=Math.round(tracer.samples);
            if((sample===1||sample===MODEL_RENDER_SAMPLES)&&Math.abs(sample-tracer.samples)<1e-8&&!window.renderAccumulationStats?.some(item=>item.samples===sample)){
              const target=tracer.target,pixels=new Float32Array(32*32*4);
              renderer.readRenderTargetPixels(target,20,target.height-100,32,32,pixels);
              let sum=0,squares=0,alpha=0,min=Infinity,max=-Infinity;
              for(let i=0;i<pixels.length;i+=4){const value=.2126*pixels[i]+.7152*pixels[i+1]+.0722*pixels[i+2];sum+=value;squares+=value*value;alpha+=pixels[i+3];min=Math.min(min,value);max=Math.max(max,value);}
              (window.renderAccumulationStats??=[]).push({samples:sample,mean:sum/1024,variance:squares/1024-(sum/1024)**2,alpha:alpha/1024,min,max});
            }
            if(tracer.samples>=MODEL_RENDER_SAMPLES) window.renderSamplingCompleted ??= performance.now();`,
          );
          source = source.replace(
            '        advanceModelRenderFrame(backend);',
            '        if(!backend.compiling&&backend.samples<MODEL_RENDER_SAMPLES) window.renderSamplingFrames=(window.renderSamplingFrames??0)+1; advanceModelRenderFrame(backend);',
          );
          source = source.replace(
            '        quad.render(renderer);',
            '        window.renderDenoisePasses=(window.renderDenoisePasses??0)+1; quad.render(renderer);',
          );
          return { contents: source, loader: 'ts', resolveDir: path.dirname(filename) };
        });
        plugin.onLoad({ filter: /[\\/]PCBModelPreview\.tsx$/ }, async ({ path: filename }) => {
          let source = await readFile(filename, 'utf8');
          const replacements = [
            [
              '    const yieldBuild = async () => {',
              `    const yieldBuild = async () => {
                if(window.holdRenderBuild){window.holdRenderBuild=false;await new Promise(resolve=>window.releaseRenderBuild=resolve);}`,
            ],
            [
              '      redraw.current = render;',
              `      redraw.current = render;
              if(!window.renderTextureAllocations){
                window.renderTextureAllocations=new Map();window.renderTextureCounter=0;
                const gl=renderer.getContext(),create=gl.createTexture.bind(gl),remove=gl.deleteTexture.bind(gl);
                gl.createTexture=()=>{const texture=create();window.renderTextureAllocations.set(texture,{id:++window.renderTextureCounter,stack:new Error().stack});return texture;};
                gl.deleteTexture=texture=>{window.renderTextureAllocations.delete(texture);remove(texture);};
                const compileAsync=renderer.compileAsync.bind(renderer);
                renderer.compileAsync=(...args)=>{const started=performance.now();return compileAsync(...args).then(value=>{window.renderPhaseTimings?.compilations.push({elapsedMs:performance.now()-started,shaderLength:args[0].material?.fragmentShader?.length});return value;});};
              }
              window.inspectRender=()=>({renderer,scene,camera,group,components,cadGroup,groundGroup,previewGroup,sketchGroup,edgeGroup,faceGroup,operandGhostGroup,board,modelCad});
              window.exportRenderImage=()=>exportPNG.current();`,
            ],
          ];
          for (const [marker, replacement] of replacements) {
            assert.ok(source.includes(marker), `Find Model instrumentation: ${marker.trim()}`);
            source = source.replace(marker, replacement);
          }
          return { contents: source, loader: 'tsx', resolveDir: path.dirname(filename) };
        });
      },
    },
  ],
});
await mkdir(outputDirectory, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
});
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 820 } });
  const errors = [];
  const consoleErrors = [];
  const deprecationWarnings = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'warning' && /THREE\.(?:Clock|Source):/.test(message.text()))
      deprecationWarnings.push(message.text());
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
      console.error('Browser error:', message.text());
    }
  });
  await page.addInitScript((value) => {
    window.initialFixture = value;
    window.holdRenderBuild = true;
    window.renderCommits = 0;
    window.renderExports = [];
    window.openpe = {
      connection: async () => ({ base: 'http://localhost', token: 'test' }),
      exportImage: async (image) => {
        window.renderExports.push(image);
        return { name: 'render.png' };
      },
    };
  }, fixture);
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/libraries/footprints') {
      const model =
        url.searchParams.get('id') === 'Fixture:Colors' ? 'Colors.step' : 'Fixture.step';
      return route.fulfill({
        json: {
          footprint: ['footprint', '"Fixture"', ['model', `"${model}"`]],
          models: [{ path: model }],
        },
      });
    }
    if (url.pathname === '/api/library-model')
      return route.fulfill({
        json: url.searchParams.get('id') === 'Fixture:Colors' ? parsedColoredModel : parsedModel,
      });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  for (const filename of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(filename, 'utf8') });
  await page.addStyleTag({ content: 'html,body,#root{height:100%;margin:0}' });
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
    await page.addStyleTag({ content: file.text });
  await page.addScriptTag({
    content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
  });

  const button = page.getByRole('button', { name: 'Render', exact: true });
  const canvasHost = page.locator('.pcb-model-canvas');
  await button.waitFor();
  await page.waitForFunction(() => typeof window.releaseRenderBuild === 'function');
  assert.equal(await button.isDisabled(), true, 'Render stays disabled until the scene is ready.');
  await page.evaluate(() => window.releaseRenderBuild());
  await page.waitForFunction(() => {
    const state = window.inspectRender?.();
    return (
      state?.components.children.some((object) => object.isGroup) &&
      !document.querySelector('.pcb-model-status') &&
      document.querySelector('.pcb-model-canvas')?.dataset.renderMode === 'standard'
    );
  });
  const inspect = () =>
    page.evaluate(() => {
      const state = window.inspectRender();
      const geometries = [],
        materials = [];
      state.group.traverse((object) => {
        if (!object.isMesh) return;
        geometries.push([object.uuid, object.geometry.uuid]);
        for (const material of Array.isArray(object.material) ? object.material : [object.material])
          materials.push([
            material.uuid,
            material.opacity,
            material.transparent,
            material.depthWrite,
            material.roughness,
            material.metalness,
            material.color?.toArray(),
          ]);
      });
      return {
        board: JSON.stringify(state.board),
        modelCad: JSON.stringify(state.modelCad),
        camera: {
          position: state.camera.position.toArray(),
          quaternion: state.camera.quaternion.toArray(),
          zoom: state.camera.zoom,
          projection: state.camera.projectionMatrix.toArray(),
        },
        geometry: geometries,
        materials,
        helpers: [
          state.groundGroup,
          state.previewGroup,
          state.sketchGroup,
          state.edgeGroup,
          state.faceGroup,
          state.operandGhostGroup,
        ].map((object) => [object.uuid, object.visible]),
        commits: window.renderCommits,
      };
    });
  const exportImage = async () => {
    const image = await page.evaluate(async () => {
      await window.exportRenderImage();
      return window.renderExports.at(-1);
    });
    assert.ok(image?.dataUrl.startsWith('data:image/png;base64,'), 'Export returns a real PNG.');
    return Buffer.from(image.dataUrl.split(',')[1], 'base64');
  };
  const before = await inspect();
  assert.ok(before.materials.some((material) => material[1] === 0.45));
  const compositionGuard = await button.evaluate((element) =>
    [
      { key: 'Enter', isComposing: true },
      { key: 'Enter', keyCode: 229 },
      { key: ' ', keyCode: 229 },
    ].map((options) => {
      const event = new KeyboardEvent('keydown', {
        ...options,
        bubbles: true,
        cancelable: true,
      });
      return element.dispatchEvent(event);
    }),
  );
  assert.deepEqual(
    compositionGuard,
    [false, false, false],
    'IME keydowns prevent button activation.',
  );
  assert.equal(
    await button.getAttribute('aria-pressed'),
    'false',
    'IME retains standard rendering.',
  );
  const standardPNG = await exportImage();
  await writeFile(`${outputDirectory}/standard.png`, standardPNG);
  const renderStarted = Date.now();
  await button.evaluate((element) =>
    element.addEventListener('click', () => (window.renderEnabledAt = performance.now()), {
      once: true,
    }),
  );
  await button.click();
  await page.waitForFunction(
    () => document.querySelector('.pcb-model-canvas')?.dataset.renderMode === 'studio',
    undefined,
    { timeout: 60000 },
  );
  assert.equal(await button.getAttribute('aria-pressed'), 'true');
  const enabled = await inspect();
  for (const key of ['board', 'modelCad', 'geometry', 'materials', 'helpers', 'commits'])
    assert.deepEqual(enabled[key], before[key], `Render preserves ${key}.`);
  for (const [key, expected] of Object.entries(before.camera)) {
    const actual = enabled.camera[key];
    if (Array.isArray(expected)) {
      assert.equal(actual.length, expected.length, `Render preserves camera ${key} dimensions.`);
      for (let index = 0; index < expected.length; index++)
        assert.ok(
          Math.abs(actual[index] - expected[index]) <= 1e-9,
          `Render preserves camera ${key}[${index}]: ${actual[index]} versus ${expected[index]}.`,
        );
    } else
      assert.ok(
        Math.abs(actual - expected) <= 1e-9,
        `Render preserves camera ${key}: ${actual} versus ${expected}.`,
      );
  }
  const renderDiagnostic = setInterval(() => {
    void page
      .evaluate(() => ({
        samples: document.querySelector('.pcb-model-canvas')?.dataset.renderSamples,
        status: [...document.querySelectorAll('[data-model-render-status]')].map(
          (item) => item.textContent,
        ),
        tracer: window.inspectPathTracer?.(),
      }))
      .then((value) => console.log('Path tracing:', JSON.stringify(value)))
      .catch(() => {});
  }, 10000);
  let studioPNG;
  try {
    await page.waitForFunction(
      (target) =>
        Number(document.querySelector('.pcb-model-canvas')?.dataset.renderSamples) >= target ||
        Boolean(document.querySelector('[data-model-render-status][role="alert"]')),
      expectedRenderSamples,
      { timeout: 180000 },
    );
    assert.equal(
      await page.locator('[data-model-render-status][role="alert"]').count(),
      0,
      'Path tracing prepares successfully.',
    );
    assert.equal(
      await page.locator('footer [data-model-render-status]').count(),
      0,
      'Completed rendering clears the bottom status text while retaining the image.',
    );
    studioPNG = await exportImage();
  } finally {
    clearInterval(renderDiagnostic);
  }
  const completedSamples = Number(await canvasHost.getAttribute('data-render-samples'));
  const renderElapsedMs = Date.now() - renderStarted;
  const samplingElapsedMs = await page.evaluate(
    () => window.renderSamplingCompleted - window.renderSamplingStarted,
  );
  const preparationElapsedMs = await page.evaluate(
    () => window.renderSamplingStarted - window.renderEnabledAt,
  );
  const preparationPhases = await page.evaluate(() => window.renderPhaseTimings);
  const accumulationStats = await page.evaluate(() => window.renderAccumulationStats);
  const samplingWork = await page.evaluate(() => ({
    tiles: window.renderTraceTiles,
    frames: window.renderSamplingFrames,
    denoisePasses: window.renderDenoisePasses,
  }));
  assert.equal(
    samplingWork.tiles,
    expectedRenderSamples * 9,
    'Complete every tile of every sample.',
  );
  const quality = await page.evaluate(() => window.inspectPathTracer().quality);
  assert.deepEqual(
    quality,
    {
      samples: expectedRenderSamples,
      bounces: 3,
      transmissiveBounces: 3,
      resolutionScale: 0.75,
      mis: 1,
      denoise: { sigma: 1.6, kSigma: 1.5, threshold: 0.18 },
    },
    'Preparation optimization preserves the established rendering quality.',
  );
  const maskMaterials = await page.evaluate(() => window.inspectPathTracer().maskMaterials);
  assert.ok(
    maskMaterials.some(
      (material) => material.normal && material.clearcoatNormal && material.transmission > 0,
    ),
    'Coated outer copper drives actual traced base and clearcoat normals.',
  );
  assert.ok(
    completedSamples >= expectedRenderSamples,
    'PNG waits for the actual path tracer to converge.',
  );
  await writeFile(`${outputDirectory}/studio.png`, studioPNG);
  const standard = await sharp(standardPNG)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const studio = await sharp(studioPNG).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual(studio.info, standard.info, 'Studio exports retain viewport dimensions.');
  let changedPixels = 0,
    coloredPixels = 0,
    redPixels = 0,
    bluePixels = 0;
  for (let index = 0; index < studio.data.length; index += studio.info.channels) {
    if (
      Math.max(
        ...[0, 1, 2].map((channel) =>
          Math.abs(studio.data[index + channel] - standard.data[index + channel]),
        ),
      ) > 8
    )
      changedPixels++;
    if (
      studio.data[index + 1] > studio.data[index] + 10 &&
      studio.data[index + 1] > studio.data[index + 2] + 10
    )
      coloredPixels++;
    if (
      studio.data[index] > studio.data[index + 1] + 30 &&
      studio.data[index] > studio.data[index + 2] + 30
    )
      redPixels++;
    if (
      studio.data[index + 2] > studio.data[index] + 30 &&
      studio.data[index + 2] > studio.data[index + 1] + 30
    )
      bluePixels++;
  }
  assert.ok(changedPixels > 1000, 'Studio rendering produces visibly different image pixels.');
  assert.ok(
    coloredPixels > 100,
    'Studio PNG contains the rendered PCB rather than an empty background.',
  );
  assert.ok(redPixels > 200, 'Authored red STEP faces retain their colour in actual GPU output.');
  assert.ok(bluePixels > 200, 'Authored blue STEP faces retain their colour in actual GPU output.');
  // This fixed floor region has no geometry edges or cast shadow. A local
  // high-pass residual measures visible grain without counting smooth lighting.
  let floorNoise = 0;
  const luminance = (x, y) => {
    const offset = (y * studio.info.width + x) * studio.info.channels;
    return (
      0.2126 * studio.data[offset] +
      0.7152 * studio.data[offset + 1] +
      0.0722 * studio.data[offset + 2]
    );
  };
  for (let y = 20; y < 120; y++)
    for (let x = 20; x < 220; x++) {
      const neighbours =
        (luminance(x - 1, y) + luminance(x + 1, y) + luminance(x, y - 1) + luminance(x, y + 1)) / 4;
      floorNoise += Math.abs(luminance(x, y) - neighbours);
    }
  floorNoise /= 20000;
  await canvasHost.screenshot({ path: `${outputDirectory}/studio-viewport.png` });

  await page.getByRole('tab', { name: 'Display', exact: true }).click();
  await page.getByRole('tab', { name: 'Views', exact: true }).click();
  assert.equal(
    await button.getAttribute('aria-pressed'),
    'true',
    'Visualization tabs retain Render.',
  );
  const projection = page.getByRole('button', { name: 'Orthographic projection', exact: true });
  await projection.click();
  await page.waitForFunction(() => window.inspectRender().camera.isPerspectiveCamera);
  assert.equal(
    await button.getAttribute('aria-pressed'),
    'true',
    'Projection switching retains Render.',
  );
  await page.evaluate(() => window.setRenderSidebar(false));
  await button.waitFor({ state: 'detached' });
  await page.evaluate(() => window.setRenderSidebar(true));
  await button.waitFor();
  assert.equal(
    await button.getAttribute('aria-pressed'),
    'true',
    'Sidebar switching retains Render.',
  );
  await page.evaluate(() => window.setRenderActive(false));
  const frameCount = await canvasHost.getAttribute('data-render-count');
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(
    await canvasHost.getAttribute('data-render-count'),
    frameCount,
    'Inactive Model pauses rendering.',
  );
  await page.evaluate(() => window.setRenderActive(true));
  await page.waitForFunction(
    () => document.querySelector('.pcb-model-canvas')?.dataset.renderMode === 'studio',
  );
  assert.equal(await button.getAttribute('aria-pressed'), 'true', 'View switching retains Render.');
  await projection.click();
  await page.waitForFunction(() => window.inspectRender().camera.isOrthographicCamera);
  await button.click();
  await page.waitForFunction(
    () => document.querySelector('.pcb-model-canvas')?.dataset.renderMode === 'standard',
  );
  assert.equal(await button.getAttribute('aria-pressed'), 'false');
  const restored = await inspect();
  for (const key of ['board', 'modelCad', 'geometry', 'materials', 'helpers', 'commits'])
    assert.deepEqual(restored[key], before[key], `Toggle-off restores ${key}.`);
  await writeFile(`${outputDirectory}/restored.png`, await exportImage());
  const gpuMemory = () => page.evaluate(() => ({ ...window.inspectRender().renderer.info.memory }));
  const releasedMemory = await gpuMemory();
  const retainedAllocations = await page.evaluate(() =>
    [...window.renderTextureAllocations.values()].map((item) => item.id),
  );
  let pendingExportCancelled = false;
  for (let cycle = 0; cycle < 2; cycle++) {
    await button.click();
    await page.waitForFunction(
      () => document.querySelector('.pcb-model-canvas')?.dataset.renderMode === 'studio',
    );
    const exportedBeforeStop = await page.evaluate(() => window.renderExports.length);
    if (!lifecycleOnly && cycle === 0) {
      await page.evaluate(() => {
        window.cancelledRenderExport = window.exportRenderImage().then(
          () => ({ completed: true }),
          (error) => ({ error: error.message }),
        );
      });
    }
    await button.click();
    await page.waitForFunction(
      () => document.querySelector('.pcb-model-canvas')?.dataset.renderMode === 'standard',
    );
    if (!lifecycleOnly && cycle === 0) {
      const cancelled = await page.evaluate(() => window.cancelledRenderExport);
      assert.match(
        cancelled.error ?? '',
        /changed or was stopped/,
        'Stopping Render cancels pending image capture.',
      );
      assert.equal(
        await page.evaluate(() => window.renderExports.length),
        exportedBeforeStop,
        'Cancelled capture never opens the image picker.',
      );
      pendingExportCancelled = true;
    }
    const currentMemory = await gpuMemory();
    if (currentMemory.textures !== releasedMemory.textures) {
      console.log(
        'Retained texture allocations:',
        JSON.stringify(
          await page.evaluate(
            (ids) =>
              [...window.renderTextureAllocations.values()].filter(
                (item) => !ids.includes(item.id),
              ),
            retainedAllocations,
          ),
          null,
          2,
        ),
      );
    }
    assert.deepEqual(
      currentMemory,
      releasedMemory,
      `Render cycle ${cycle + 2} releases its GPU textures and geometries.`,
    );
    const current = await inspect();
    for (const key of ['board', 'modelCad', 'geometry', 'materials', 'helpers', 'commits'])
      assert.deepEqual(current[key], before[key], `Render cycle ${cycle + 2} preserves ${key}.`);
  }
  await page.evaluate(() => window.setRenderMounted(false));
  await canvasHost.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  assert.deepEqual(
    consoleErrors,
    [],
    'Studio shaders and browser resources produce no console errors.',
  );
  assert.deepEqual(deprecationWarnings, [], 'Render avoids deprecated Clock and Source APIs.');
  await writeFile(
    `${outputDirectory}/summary.json`,
    JSON.stringify(
      {
        changedPixels,
        coloredPixels,
        redPixels,
        bluePixels,
        completedSamples,
        renderElapsedMs,
        samplingElapsedMs,
        preparationElapsedMs,
        preparationPhases,
        accumulationStats,
        samplingWork,
        quality,
        floorNoise,
        maskMaterials,
        pendingExportCancelled,
        exportedWidth: studio.info.width,
        exportedHeight: studio.info.height,
        commits: restored.commits,
        releasedMemory,
      },
      null,
      2,
    ) + '\n',
  );
  if (!lifecycleOnly) {
    assert.equal(accumulationStats?.length, 2, 'Read back the first and completed GPU samples.');
    assert.ok(
      accumulationStats[1].variance < accumulationStats[0].variance * 0.25,
      'Actual GPU accumulation must reduce floor variance, not only advance its sample counter.',
    );
    assert.ok(floorNoise < 5, 'The denoised image must suppress visible floor speckle.');
  }
  console.log(
    'Model Render browser check passed: denoised GPU convergence, authored face colours, cleared completion status, retained view/native data and toggle-off/unmount.',
  );
} finally {
  await browser.close();
}
