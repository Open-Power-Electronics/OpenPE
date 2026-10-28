import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { BoxGeometry } from 'three';
import { tsImport } from 'tsx/esm/api';

// Real PCBModelPreview/Three rendering with a small fixed STEP observation.
// No Electron, project destinations, providers, downloads or solvers run.
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const geometry = new BoxGeometry(14, 18, 1);
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

function fixture(side, orthographic) {
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
  for (const layer of ['F.Cu', 'B.Cu'])
    board.tracks.push({
      id: randomUUID(),
      netId,
      layer,
      width: 2,
      start: { x: 4, y: 15 },
      end: { x: 36, y: 15 },
    });
  for (const layer of ['F.SilkS', 'B.SilkS']) {
    for (const x of [11, 29])
      board.graphics.push({
        id: randomUUID(),
        kind: 'text',
        layer,
        width: 0.15,
        start: { x, y: 13 },
        end: { x, y: 13 },
        text: { value: 'PCB', rotation: 0, size: { x: 2.5, y: 2.5 }, thickness: 0.15 },
      });
  }
  board.footprints = [
    {
      id: randomUUID(),
      symbolId: null,
      libraryId: 'Fixture:Transparent',
      reference: 'J1',
      value: 'Cover',
      x: 11,
      y: 15,
      rotation: 0,
      side,
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
  ];
  const z = side === 'front' ? 1 : -1;
  return {
    board,
    modelCad: {
      version: 1,
      objects: [
        {
          id: randomUUID(),
          name: 'CAD cover',
          kind: 'box',
          position: { x: 29, y: 15, z: z * 8 },
          rotation: { x: 0, y: 0, z: 0 },
          size: { x: 14, y: 18, z: 1 },
          material: 'pmma',
          opacity: 0.45,
          holes: [],
        },
      ],
    },
    view: {
      boardId: board.id,
      position: orthographic ? [20, -15, z * 100] : [56, -52, z * 85],
      target: [20, -15, 0],
      up: [0, 1, 0],
      zoom: 1,
      extent: 58,
      orthographic,
      modelsVisible: true,
      silkscreenVisible: true,
    },
  };
}

const bundle = await build({
  stdin: {
    contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';
import Preview from'./components/PCBModelPreview';
function Harness(){const[value,setValue]=useState(window.initialFixture);window.setCompositingFixture=setValue;
return <div style={{height:'100vh'}}><Preview key={value.board.id} board={value.board} modelCad={value.modelCad}
viewState={{current:value.view}} sidebarVisible={false}/></div>}
createRoot(document.getElementById('root')).render(<Harness/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outdir: 'test-results/model-compositing-ui',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [
    {
      name: 'inspect-real-model-compositing',
      setup(plugin) {
        plugin.onLoad({ filter: /[\\/]PCBModelPreview\.tsx$/ }, async ({ path: filename }) => {
          const source = await readFile(filename, 'utf8');
          const marker = '      redraw.current = render;';
          assert.ok(source.includes(marker));
          return {
            loader: 'tsx',
            resolveDir: path.dirname(filename),
            contents: source.replace(
              marker,
              marker +
                '\n      window.inspectCompositing=()=>({renderer,scene,camera,group,components,cadGroup,previewGroup,board});',
            ),
          };
        });
      },
    },
  ],
});
await mkdir('test-results/model-compositing-ui', { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
});
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 720 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const initial = fixture('front', true);
  await page.addInitScript((value) => {
    window.initialFixture = value;
    window.openpe = { connection: async () => ({ base: 'http://localhost', token: 'test' }) };
  }, initial);
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/libraries/footprints')
      return route.fulfill({
        json: {
          footprint: ['footprint', '"Fixture"', ['model', '"Fixture.step"']],
          models: [{ path: 'Fixture.step' }],
        },
      });
    if (url.pathname === '/api/library-model') return route.fulfill({ json: parsedModel });
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
  const evidence = [];
  for (const side of ['front', 'back'])
    for (const orthographic of [true, false]) {
      const value = side === 'front' && orthographic ? initial : fixture(side, orthographic);
      if (value !== initial)
        await page.evaluate((next) => window.setCompositingFixture(next), value);
      await page.waitForFunction(
        (id) => {
          const state = window.inspectCompositing?.();
          return (
            state?.board.id === id &&
            state.components.children.some((object) => object.isGroup) &&
            !document.querySelector('.pcb-model-status')
          );
        },
        value.board.id,
        { timeout: 30000 },
      );
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const result = await page.evaluate(() => {
        const { renderer, scene, camera, group, components, cadGroup, previewGroup, board } =
          window.inspectCompositing();
        const assembly = [components, cadGroup, previewGroup];
        const layers = [];
        for (const root of assembly)
          root.traverse((object) => {
            if (object.isGroup) layers.push([object, object.renderOrder]);
          });
        const visibility = group.children.map((object) => [object, object.visible]);
        const context = renderer.getContext(),
          width = renderer.domElement.width,
          height = renderer.domElement.height;
        const read = () => {
          const pixels = new Uint8Array(width * height * 4);
          context.readPixels(0, 0, width, height, context.RGBA, context.UNSIGNED_BYTE, pixels);
          return pixels;
        };
        camera.updateMatrixWorld(true);
        renderer.render(scene, camera);
        const actual = read();
        // Independent painter reference: complete board surfaces first, followed
        // by the actual assembly using the retained board depth buffer.
        for (const root of assembly) root.visible = false;
        renderer.render(scene, camera);
        for (const [object] of visibility) object.visible = assembly.includes(object);
        renderer.autoClear = false;
        renderer.render(scene, camera);
        renderer.autoClear = true;
        const expected = read();
        for (const [object, visible] of visibility) object.visible = visible;
        // Fault injection reproduces the previous inherited Group order (0),
        // including nested placed/template Groups, without changing native data.
        for (const [object] of layers) object.renderOrder = 0;
        renderer.render(scene, camera);
        const legacy = read();
        for (const [object, order] of layers) object.renderOrder = order;
        renderer.render(scene, camera);
        let actualError = 0,
          legacyError = 0,
          changed = 0,
          samples = 0;
        // Interior board pixels exclude anti-aliased outer/silhouette edges.
        for (let y = 18; y < height - 18; y++)
          for (let x = 18; x < width - 18; x++) {
            const index = (y * width + x) * 4;
            const error = Math.max(
              ...[0, 1, 2].map((channel) =>
                Math.abs(legacy[index + channel] - expected[index + channel]),
              ),
            );
            if (error <= 8) continue;
            legacyError = Math.max(legacyError, error);
            actualError = Math.max(
              actualError,
              ...[0, 1, 2].map((channel) =>
                Math.abs(actual[index + channel] - expected[index + channel]),
              ),
            );
            changed++;
            samples++;
          }
        const opacity = [];
        for (const root of [components, cadGroup])
          root.traverse((object) => {
            if (object.isMesh && !object.userData.estimated)
              for (const material of Array.isArray(object.material)
                ? object.material
                : [object.material])
                opacity.push(material.opacity);
          });
        return {
          actualError,
          legacyError,
          changed,
          samples,
          opacity,
          orders: layers.map(([, order]) => order),
          pcb: JSON.stringify(board),
        };
      });
      const label = `${side}-${orthographic ? 'orthographic' : 'perspective'}`;
      assert.ok(
        result.legacyError > 8 && result.changed > 100,
        `${label}: old ordering visibly overpaints transparent covers`,
      );
      assert.ok(
        result.actualError <= 2,
        `${label}: assembly matches independently layered board/cover rendering (${result.actualError})`,
      );
      assert.ok(
        result.orders.every((order) => order === 3),
        `${label}: nested assembly groups retain one shared depth-sorted layer`,
      );
      assert.ok(
        result.opacity.length && result.opacity.every((opacity) => opacity === 0.45),
        `${label}: native cover opacity is retained`,
      );
      assert.equal(
        result.pcb,
        JSON.stringify(value.board),
        `${label}: rendering does not edit board geometry`,
      );
      delete result.pcb;
      evidence.push({ label, ...result });
      await page
        .locator('.pcb-model-canvas')
        .screenshot({ path: `test-results/model-compositing-ui/${label}.png` });
    }
  assert.deepEqual(errors, []);
  await writeFile(
    'test-results/model-compositing-ui/summary.json',
    JSON.stringify(evidence, null, 2) + '\n',
  );
  console.log(
    'Model compositing UI passed: actual native-opacity component/CAD covers match independent board-first rendering from front/back in both projections; previous ordering visibly fails.',
  );
} finally {
  await browser.close();
}
