import { runCanvasAction } from './canvas-context-menu-test-helpers.mjs';
import assert from 'node:assert/strict';
import {
  chooseModelTool,
  modelToolAvailable,
  setModelSelectionCategories,
} from './model-tool-test-helpers.mjs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { BoxGeometry } from 'three';
import { tsImport } from 'tsx/esm/api';
import {
  openDisplayDrawer,
  selectModelView,
  selectModelVisualizationTab,
  assertToolbarSidebarPlacement,
} from './visualization-test-helpers.mjs';

// Real Core and WebGL in an isolated browser, with mocked library/native ports.
// This never opens Electron or touches project destinations, providers or solvers.
const { createProject } = await tsImport('../lib/project.ts', import.meta.url);
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const { modelCadGeometryKey, modelCadColor } = await tsImport(
  '../lib/model-cad.ts',
  import.meta.url,
);
const project = createProject();
project.name = 'Model CAD';
project.pcb = createEmptyPCB();
project.pcb.graphics = [
  {
    id: randomUUID(),
    kind: 'polygon',
    layer: 'Edge.Cuts',
    width: 0.05,
    start: { x: 0, y: 0 },
    points: [
      { x: 100, y: 0 },
      { x: 100, y: 76 },
    ],
    end: { x: 0, y: 76 },
  },
];
project.pcb.footprints = [
  {
    id: randomUUID(),
    symbolId: null,
    libraryId: 'Fixture:Model',
    reference: 'J1',
    value: 'Fixture',
    x: 12,
    y: 12,
    rotation: 0,
    side: 'front',
    graphics: [],
    pads: [],
    models: [
      {
        path: 'Fixture.step',
        offset: { x: 0, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
        scale: { x: 1, y: 1, z: 1 },
      },
    ],
  },
];
const geometry = new BoxGeometry(8, 6, 3);
const model = {
  meshes: [
    {
      color: [0.6, 0.65, 0.7],
      attributes: {
        position: { array: Array.from(geometry.attributes.position.array) },
        normal: { array: Array.from(geometry.attributes.normal.array) },
      },
      index: { array: Array.from(geometry.index.array) },
    },
  ],
};
geometry.dispose();
const bundle = await build({
  stdin: {
    contents: `import React,{useRef,useState,useSyncExternalStore}from'react';
import{createRoot}from'react-dom/client';import*as THREE from'three';
import Preview from'./components/PCBModelPreview';
import SidebarToggle from'./components/SidebarToggle';
import{ProjectCore}from'./core/project-core';import{registerProjectCapabilities}from'./core/register-project';
import{createCapabilityHost}from'./api/capabilities';import{registerWorkbenchCapabilities}from'./lib/workbench-capabilities';
import{modelCadFromProject,newModelCadObject}from'./lib/model-cad';import{serializeProject}from'./lib/project';import{prepareModelCadObjects}from'./components/model-cad-preparation';
const core=new ProjectCore(${JSON.stringify(project)}),host=createCapabilityHost({revision:()=>String(core.getSnapshot().revision)});
registerProjectCapabilities(host,core,{prepareModelCad:(objects,signal)=>prepareModelCadObjects(core,objects,signal)});let enabled=true;
registerWorkbenchCapabilities(host,()=>({revision:()=>String(core.getSnapshot().revision),state:()=>core.query('project.snapshot'),
enclosureExportAvailable:()=>core.getSnapshot().sourceDraft!==null?'Apply Source edits.':enabled||'Open Model.',
enclosureExport:async signal=>{signal.throwIfAborted();return window.openpe.exportEnclosure({source:serializeProject(core.getSnapshot().project)});}}));
function Harness(){const snapshot=useSyncExternalStore(listener=>core.subscribe(listener),()=>core.getSnapshot());
const[active,setActive]=useState(true),[sidebarVisible,setSidebarVisible]=useState(true),view=useRef(null);
const[grid,setGrid]=useState(true),[gridSpacing,setGridSpacing]=useState(0.5);
window.cad={core,host,state:()=>({revision:snapshot.revision,undoDepth:snapshot.undoDepth,redoDepth:snapshot.redoDepth,
modelCad:modelCadFromProject(snapshot.project),source:snapshot.source,pcb:JSON.stringify(snapshot.project.pcb)}),
setActive:value=>{enabled=value;setActive(value);},setSidebarVisible,setGrid,setGridSpacing,camera:()=>view.current,
newObject:kind=>newModelCadObject(core.getSnapshot().project.pcb,kind)};window.THREE=THREE;
return <div className="editor" style={{position:'relative',display:'flex',flexDirection:'column',height:'100vh'}}>
<div className="editor-mode-bar"><div className="editor-mode-actions" role="group" aria-label="Project actions"><button className="tool-button" aria-label="List">☷</button><button className="tool-button" aria-label="Git">⑂</button><SidebarToggle visible={sidebarVisible} onToggle={()=>setSidebarVisible(value=>!value)} className="editor-sidebar-toggle"/></div></div>
<div style={{position:'relative',flex:1,minHeight:0}}><Preview board={snapshot.project.pcb} schematic={snapshot.project.schematic}
grid={grid} gridSpacing={gridSpacing}
modelCad={modelCadFromProject(snapshot.project)}
onModeChange={mode=>window.modelMode=mode}
revision={String(snapshot.revision)} undoDepth={snapshot.undoDepth} redoDepth={snapshot.redoDepth}
sourcePending={snapshot.sourceDraft!==null} capabilityHost={host} active={active} viewState={view}
sidebarVisible={sidebarVisible} onShowSidebar={()=>setSidebarVisible(true)} onToggleSidebar={()=>setSidebarVisible(value=>!value)}/></div></div>};
createRoot(document.getElementById('root')).render(<Harness/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outfile: 'test-results/model-cad-ui.js',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [
    {
      name: 'inspect-model-scene',
      setup(plugin) {
        plugin.onLoad({ filter: /[\\/]useModelCadTools\.tsx$/ }, async (args) => {
          const source = await readFile(args.path, 'utf8');
          const marker = '  const panel = (';
          assert.ok(source.includes(marker));
          return {
            contents: source.replace(
              marker,
              '  window.modelCadGui = { canvasClick, sketch };\n' + marker,
            ),
            loader: 'tsx',
            resolveDir: path.dirname(args.path),
          };
        });
        plugin.onLoad({ filter: /[\\/]PCBModelPreview\.tsx$/ }, async (args) => {
          let source = await readFile(args.path, 'utf8');
          const renderMarker = '      const render = () => {';
          assert.ok(
            source.includes(renderMarker),
            'The scene inspection follows the current render callback.',
          );
          source = source.replace(
            renderMarker,
            renderMarker + '\nwindow.scene=scene;window.camera=camera;window.modelOrbit=orbit;',
          );
          return { contents: source, loader: 'tsx', resolveDir: path.dirname(args.path) };
        });
      },
    },
  ],
});
await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
});
const sketchBooleanOnly = process.argv.includes('--sketch-boolean');
const colorOnly = process.argv.includes('--color');
const sketchInputOnly = process.argv.includes('--sketch-input');
const deleteActionsOnly = process.argv.includes('--delete-actions');
const sketchPlaneOnly = process.argv.includes('--sketch-plane') || colorOnly;
const sketchPlaneComplete = Symbol('sketch-plane-complete');
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  let requests = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.exports = [];
    window.openpe = {
      connection: async () => ({ base: 'http://localhost', token: 'model-cad-test' }),
      exportEnclosure: async (options) => {
        window.exports.push(options);
        return window.cancelExport ? null : { name: 'model.step' };
      },
    };
  });
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/model-cad/preview') {
      const { object } = route.request().postDataJSON();
      // The isolated GUI test substitutes only the fixed geometry service.
      // Native kernel regressions verify the resulting BREP/STEP surfaces.
      const geometry = new BoxGeometry(object.size.x, object.size.y, object.size.z);
      const meshes = [
        {
          attributes: {
            position: { array: Array.from(geometry.attributes.position.array) },
            normal: { array: Array.from(geometry.attributes.normal.array) },
          },
          index: { array: Array.from(geometry.index.array) },
        },
      ];
      geometry.dispose();
      return route.fulfill({ json: { shapeKey: modelCadGeometryKey(object), meshes } });
    }
    if (url.pathname === '/api/libraries/footprints') {
      requests++;
      return route.fulfill({
        json: { footprint: ['footprint', '"Fixture"', ['model', '"Fixture.step"']] },
      });
    }
    if (url.pathname === '/api/library-model') {
      requests++;
      return route.fulfill({ json: model });
    }
    return route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><div id="root"></div>',
    });
  });
  await page.goto('http://localhost');
  assert.equal(await page.evaluate(() => document.compatMode), 'CSS1Compat');
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
    await page.addStyleTag({ content: file.text });
  await page.addScriptTag({
    content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
  });
  const preview = page.getByRole('region', { name: '3D board preview' });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const state = () => page.evaluate(() => window.cad.state());
  const solids = () => page.evaluate(() => window.cad.state().modelCad?.objects ?? []);
  const sidebar = page.getByRole('complementary', { name: 'Model sidebar', exact: true });
  const canvas = page.locator('.pcb-model-canvas');
  async function assertDocked() {
    const [drawing, dock] = await Promise.all([canvas.boundingBox(), sidebar.boundingBox()]);
    assert.ok(drawing.width >= 160, 'The dock preserves a usable Model drawing area.');
    assert.ok(dock.width >= 224, 'Model properties remain readable.');
    assert.ok(
      dock.x >= drawing.x + drawing.width - 1,
      'Model properties do not overlay the drawing.',
    );
    assert.ok(dock.y + dock.height <= page.viewportSize().height + 1);
    assert.equal(
      await sidebar.evaluate((element) => element.scrollWidth > element.clientWidth),
      false,
    );
  }
  const cameraState = () =>
    page.evaluate(() => ({
      position: window.camera.position.toArray().map((value) => Number(value.toFixed(8))),
      quaternion: window.camera.quaternion.toArray().map((value) => Number(value.toFixed(8))),
      zoom: window.camera.zoom,
    }));
  async function screenPoint(point) {
    await page.waitForFunction(() => {
      const host = document.querySelector('.pcb-model-canvas');
      const canvas = host?.querySelector('canvas');
      const camera = window.camera;
      if (!host || !canvas || !camera || !host.clientWidth || !host.clientHeight) return false;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      // The renderer sizes its canvas from the host's integer client dimensions.
      // Wait for that resize before mixing its rect with a camera projection.
      if (
        Math.abs(rect.width - host.clientWidth) > 1e-7 ||
        Math.abs(rect.height - host.clientHeight) > 1e-7
      )
        return false;
      const aspect = camera.isOrthographicCamera
        ? (camera.right - camera.left) / (camera.top - camera.bottom)
        : camera.aspect;
      return Number.isFinite(aspect) && Math.abs(aspect - rect.width / rect.height) < 1e-7;
    });
    return page.evaluate(({ x, y, z = 0 }) => {
      const rect = document.querySelector('.pcb-model-canvas canvas').getBoundingClientRect();
      const vector = new window.THREE.Vector3(x, -y, z).project(window.camera);
      return {
        x: rect.left + ((vector.x + 1) * rect.width) / 2,
        y: rect.top + ((1 - vector.y) * rect.height) / 2,
      };
    }, point);
  }
  async function clickWorld(point) {
    const p = await screenPoint(point);
    await page.mouse.click(p.x, p.y);
    return p;
  }
  async function clickSolid(id, local = { x: 0, y: 0, z: null }) {
    const point = await page.evaluate(
      ({ id, local }) => {
        const body = window.cad.state().modelCad.objects.find((item) => item.id === id);
        let mesh;
        window.scene.traverse((node) => {
          if (node.userData.modelCadId === id && !node.userData.modelCadPreview) mesh = node;
        });
        if (!mesh) throw new Error(`Missing CAD mesh ${id}`);
        window.scene.updateMatrixWorld(true);
        const p = mesh.localToWorld(
          new window.THREE.Vector3(local.x, -local.y, local.z ?? body.size.z / 2),
        );
        return { x: p.x, y: -p.y, z: p.z };
      },
      { id, local },
    );
    return clickWorld(point);
  }
  async function sceneMeshState(userData) {
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    return page.evaluate((userData) => {
      let result = null;
      window.scene.traverse((node) => {
        if (!Object.entries(userData).every(([key, value]) => node.userData[key] === value)) return;
        node.geometry.computeBoundingBox();
        let visible = true;
        for (let ancestor = node; ancestor; ancestor = ancestor.parent)
          visible &&= ancestor.visible;
        result = {
          visible,
          position: node.position.toArray(),
          quaternion: node.quaternion.toArray(),
          bounds: [
            node.geometry.boundingBox.min.toArray(),
            node.geometry.boundingBox.max.toArray(),
          ],
          color: node.material.color.toArray(),
          opacity: node.material.opacity,
        };
      });
      return result;
    }, userData);
  }

  async function setModelFilter(name, checked) {
    await openDisplayDrawer(page, 'Selection');
    await page
      .getByRole('group', { name: 'Selection', exact: true })
      .getByRole('checkbox', { name, exact: true })
      .setChecked(checked);
    await page.keyboard.press('Escape');
  }
  async function waitObjects(count) {
    await page.waitForFunction(
      (count) => (window.cad.state().modelCad?.objects.length ?? 0) === count,
      count,
    );
  }
  async function meshCount() {
    return page.evaluate(() => {
      let count = 0;
      window.scene.traverse((node) => {
        if (node.userData.modelCadId && !node.userData.modelCadPreview) count++;
      });
      return count;
    });
  }
  await page.waitForFunction(
    () =>
      window.scene &&
      document.querySelector('.pcb-model-canvas canvas') &&
      !document.querySelector('.pcb-model-status'),
  );
  const initial = await page.evaluate(() => {
    window.originalCanvas = document.querySelector('.pcb-model-canvas canvas');
    window.originalCamera = window.camera;
    return window.cad.state();
  });
  await sidebar.waitFor();
  await assertDocked();
  if (process.argv.includes('--ground')) {
    const ruler = page.getByRole('img', { name: /^3D scale:/ });
    await ruler.waitFor();
    const before = await state();
    const floorFrame = () =>
      page.evaluate(() => {
        const surface = window.scene.getObjectByName('model-ground').children[0];
        return [
          ...surface.getWorldPosition(new window.THREE.Vector3()).toArray(),
          ...surface.scale.toArray(),
        ];
      });
    const originalFloor = await floorFrame();
    const groundState = () =>
      page.evaluate(() => {
        const root = window.scene.getObjectByName('model-ground');
        return { visible: root.visible, objects: root.children.length };
      });
    assert.deepEqual(await groundState(), { visible: true, objects: 5 });
    assert.deepEqual(
      await page.evaluate(() => {
        const floor = window.scene.getObjectByName('model-ground');
        return floor.children[3].getWorldPosition(new window.THREE.Vector3()).toArray().slice(0, 2);
      }),
      [50, -38],
      'Ground axes intersect at the PCB outline center.',
    );
    const rulerBox = await ruler.boundingBox();
    assert.ok(
      rulerBox.width <= 112 && rulerBox.height <= 116,
      'The corner ruler keeps a compact footprint.',
    );
    const captionAnchor = await ruler
      .locator('.model-scale-value')
      .evaluate((node) => [node.getAttribute('x'), node.getAttribute('y')]);
    assert.equal(
      await page.evaluate(() =>
        ['x', 'y'].every(
          (axis) => window.scene.getObjectByName(`model-ground-axis-${axis}`)?.isMesh === true,
        ),
      ),
      true,
      'The floor uses colored strips for both axes, without letter annotations.',
    );
    assert.equal(
      await page.evaluate(
        () =>
          window.scene
            .getObjectByName('model-ground')
            .children[0].getWorldPosition(new window.THREE.Vector3()).z,
      ),
      -JSON.parse(before.pcb).thickness / 2 - 0.05,
      'The ground sits directly below the PCB underside.',
    );
    assert.equal(
      await ruler.locator('.model-scale-axis line').count(),
      3,
      'Each 3D axis has one uncluttered baseline.',
    );
    const isometricAxes = await ruler
      .locator('.model-scale-axis line')
      .evaluateAll((lines) => lines.map((line) => line.outerHTML));
    assert.equal(
      await ruler.locator('.model-scale-endpoint').count(),
      3,
      'Each axis has one labelled endpoint marker.',
    );
    const originBefore = await ruler.locator('.model-scale-origin').boundingBox();
    const axisBeforeZoom = await ruler
      .locator('.model-scale-axis line')
      .first()
      .evaluate((line) => line.outerHTML);
    await runCanvasAction(page, 'Zoom in');
    await page.waitForFunction(
      (before) => document.querySelector('.model-scale-axis line').outerHTML !== before,
      axisBeforeZoom,
    );
    const originAfter = await ruler.locator('.model-scale-origin').boundingBox();
    assert.deepEqual(
      await floorFrame(),
      originalFloor,
      'Zoom keeps exact symmetric floor extents centered on the PCB.',
    );
    assert.ok(
      Math.abs(originAfter.x - originBefore.x) < 0.1 &&
        Math.abs(originAfter.y - originBefore.y) < 0.1,
      'The lower-left ruler scales around its fixed origin.',
    );
    await selectModelView(page, 'Top view');
    await page.waitForFunction(
      (previous) =>
        JSON.stringify(
          [...document.querySelectorAll('.model-scale-axis line')].map((line) => line.outerHTML),
        ) !== JSON.stringify(previous),
      isometricAxes,
    );
    await selectModelView(page, 'Isometric view');
    assert.deepEqual(
      await ruler
        .locator('.model-scale-value')
        .evaluate((node) => [node.getAttribute('x'), node.getAttribute('y')]),
      captionAnchor,
      'The scale number keeps its fixed position while the view rotates.',
    );
    const projection = page.getByRole('button', { name: 'Orthographic projection', exact: true });
    await projection.click();
    await page.waitForFunction(() => window.modelOrbit.object.isPerspectiveCamera);
    await ruler.waitFor();
    await projection.click();
    await page.waitForFunction(() => window.modelOrbit.object.isOrthographicCamera);
    await page.evaluate(() => window.cad.setGrid(false));
    await page.waitForFunction(() => {
      const floor = window.scene.getObjectByName('model-ground');
      return floor.visible && floor.children.slice(1, 3).every((line) => !line.visible);
    });
    await page.evaluate(() => {
      window.cad.setGridSpacing(2);
      window.cad.setGrid(true);
    });
    await page.waitForFunction(() => window.scene.getObjectByName('model-ground').visible);
    await selectModelVisualizationTab(page, 'Display');
    const planeVisibility = page.getByRole('checkbox', {
      name: 'Show reference plane',
      exact: true,
    });
    assert.equal(
      await page.getByRole('combobox', { name: 'Reference plane', exact: true }).count(),
      0,
    );
    const beforePlaneCamera = await cameraState();
    const beforePlaneRequests = requests;
    await planeVisibility.focus();
    for (const event of [{ isComposing: true }, { keyCode: 229 }]) {
      assert.equal(
        await planeVisibility.evaluate(
          (node, event) =>
            node.dispatchEvent(
              new KeyboardEvent('keydown', {
                key: ' ',
                bubbles: true,
                cancelable: true,
                ...event,
              }),
            ),
          event,
        ),
        false,
        'IME cannot toggle reference plane visibility.',
      );
      assert.equal(await planeVisibility.isChecked(), true);
    }
    await planeVisibility.press('Space');
    await page.waitForFunction(() => !window.scene.getObjectByName('model-ground').visible);
    await preview.screenshot({ path: 'test-results/model-reference-plane-off.png' });
    await page.evaluate(() => window.cad.setActive(false));
    await page.waitForFunction(() => !window.modelOrbit.enabled);
    await page.evaluate(() => window.cad.setActive(true));
    await page.waitForFunction(() => window.modelOrbit.enabled);
    assert.equal(
      await planeVisibility.isChecked(),
      false,
      'View switches retain plane visibility.',
    );
    await planeVisibility.check();
    await page.waitForFunction(() => window.scene.getObjectByName('model-ground').visible);
    assert.deepEqual(
      await cameraState(),
      beforePlaneCamera,
      'Plane visibility preserves the camera.',
    );
    assert.equal(requests, beforePlaneRequests, 'Plane visibility retains model resources.');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (theme) => document.documentElement.setAttribute('data-theme', theme),
        theme,
      );
      await page.waitForFunction(
        (theme) => document.querySelector('.pcb-model-preview').dataset.modelTheme === theme,
        theme,
      );
      await preview.screenshot({ path: `test-results/model-ground-${theme}.png` });
    }
    await button('Create sketch').click();
    const plane = page.getByRole('complementary', { name: 'Sketch plane settings', exact: true });
    await page.waitForFunction(() => !window.scene.getObjectByName('model-ground').visible);
    await plane.getByRole('button', { name: 'Start sketch', exact: true }).click();
    await page.waitForFunction(() => {
      let grid = false;
      window.scene.traverseVisible((node) => {
        if (node.userData.modelCadSketchGrid) grid = true;
      });
      return grid && !window.scene.getObjectByName('model-ground').visible;
    });
    await page
      .getByRole('complementary', { name: 'Sketch settings', exact: true })
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    await page.waitForFunction(() => window.scene.getObjectByName('model-ground').visible);
    assert.equal(
      await planeVisibility.isChecked(),
      true,
      'Sketch cancellation retains plane visibility.',
    );
    assert.deepEqual(
      await state(),
      before,
      'Ground and ruler display actions preserve the document and undo.',
    );
    assert.deepEqual(errors, []);
    console.log(
      'PASS: Model ground, Off/density, theme, camera-following 3D ruler and unchanged Core/native state.',
    );
    throw sketchPlaneComplete;
  }
  const rightToggle = button('Toggle right sidebar');
  assert.equal(await rightToggle.count(), 1);
  assert.equal(
    await rightToggle.evaluate(
      (element) =>
        element.classList.contains('editor-sidebar-toggle') &&
        !!element.closest('.editor-mode-actions'),
    ),
    true,
    'The Model toggle occupies the shared upper project-action group.',
  );
  await assertToolbarSidebarPlacement(
    preview.getByRole('group', { name: 'Model tools', exact: true }),
  );
  const originalDockWidth = (await sidebar.boundingBox()).width;
  const resize = sidebar.locator('..').getByRole('button', {
    name: 'Resize model properties width',
    exact: true,
  });
  await resize.press('ArrowLeft');
  assert.ok(Math.abs((await sidebar.boundingBox()).width - originalDockWidth - 16) < 2);
  await resize.press('Home');
  const beforeSidebar = await state();
  const beforeSidebarCamera = await cameraState();
  const fullWidth = (await canvas.boundingBox()).width;
  await rightToggle.click();
  await sidebar.waitFor({ state: 'hidden' });
  assert.ok((await canvas.boundingBox()).width > fullWidth, 'Hiding the dock expands the canvas.');
  assert.equal(await rightToggle.getAttribute('aria-pressed'), 'false');
  assert.equal(
    await rightToggle.evaluate((element) => element.classList.contains('editor-sidebar-toggle')),
    true,
    'The collapsed dock retains the same toolbar toggle.',
  );
  await rightToggle.click();
  await sidebar.waitFor();
  await assertDocked();
  assert.deepEqual(
    await cameraState(),
    beforeSidebarCamera,
    'Toggling the dock preserves the camera pose and zoom.',
  );
  assert.deepEqual(
    await state(),
    beforeSidebar,
    'Toggling the dock does not change native content or undo.',
  );
  assert.ok(
    (await page.evaluate((id) => {
      const meshes = [];
      window.scene.traverse((node) => {
        if (node.userData.footprintId !== id || node.userData.estimated) return;
        node.traverse((child) => {
          if (child.isMesh) meshes.push({ mesh: child, material: child.material });
        });
      });
      window.originalComponentMaterials = meshes;
      return meshes.length;
    }, project.pcb.footprints[0].id)) > 0,
    'The fixture component has rendered model materials before inspection.',
  );
  await page.evaluate(() => window.cad.setSidebarVisible(false));
  await sidebar.waitFor({ state: 'hidden' });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await clickWorld({ x: 12, y: 12, z: project.pcb.thickness / 2 + 1 });
  await sidebar.waitFor();
  const componentProperties = sidebar.getByRole('region', {
    name: 'Component properties',
    exact: true,
  });
  await componentProperties.waitFor();
  await componentProperties.getByLabel('Reference', { exact: true }).waitFor();
  await page.waitForFunction(() =>
    window.originalComponentMaterials.every(({ mesh, material }) => mesh.material !== material),
  );
  assert.equal(
    await componentProperties.getByLabel('Reference', { exact: true }).inputValue(),
    'J1',
  );
  assert.deepEqual(await state(), beforeSidebar, 'Inspecting a component is presentation state.');
  if (deleteActionsOnly) {
    const native = await page.evaluate(() => window.cad.core.getNativeFiles());
    const id = project.pcb.footprints[0].id;
    const removeComponent = componentProperties.getByRole('button', {
      name: 'Delete object',
      exact: true,
    });
    await componentProperties.dispatchEvent('compositionstart');
    await removeComponent.click();
    assert.deepEqual(await state(), beforeSidebar, 'IME composition cannot delete a component.');
    await componentProperties.dispatchEvent('compositionend');
    await page.evaluate(() => window.cad.core.updateSource('invalid source'));
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Component properties"] .property-delete-action')
          .disabled,
    );
    await page.evaluate(() => window.cad.core.discardSource());
    await removeComponent.click();
    await page.waitForFunction(
      () => window.cad.core.getSnapshot().project.pcb.footprints.length === 0,
    );
    const manual = await page.evaluate(() => window.cad.core.getNativeFiles());
    assert.equal((await state()).undoDepth, beforeSidebar.undoDepth + 1);
    await button('Undo').click();
    await page.waitForFunction(
      () => window.cad.core.getSnapshot().project.pcb.footprints.length === 1,
    );
    assert.deepEqual(await page.evaluate(() => window.cad.core.getNativeFiles()), native);
    await page.evaluate(async (id) => {
      await window.cad.host.execute(
        'layout.delete',
        {
          boardId: window.cad.core.getSnapshot().project.pcb.id,
          selection: [{ kind: 'footprint', id }],
        },
        { actor: 'agent', expectedRevision: String(window.cad.core.getSnapshot().revision) },
      );
    }, id);
    assert.deepEqual(
      await page.evaluate(() => window.cad.core.getNativeFiles()),
      manual,
      'Model component Delete and Agent layout.delete produce the same native files.',
    );
    await button('Undo').click();
    await button('Place box').click();
    await canvas.press('Enter');
    await waitObjects(1);
    const solidPanel = page.getByRole('complementary', {
      name: 'Solid properties settings',
      exact: true,
    });
    const removeSolid = solidPanel.getByRole('button', { name: 'Delete object', exact: true });
    await removeSolid.waitFor();
    const nativeSolid = await page.evaluate(() => window.cad.core.getNativeFiles());
    const name = solidPanel.getByLabel('Solid name', { exact: true });
    await name.fill('unapplied name');
    assert.equal(await removeSolid.isDisabled(), true);
    await name.press('Escape');
    await removeSolid.focus();
    await removeSolid.press('Enter');
    await waitObjects(0);
    await button('Undo').click();
    await waitObjects(1);
    assert.deepEqual(await page.evaluate(() => window.cad.core.getNativeFiles()), nativeSolid);
    assert.deepEqual(errors, []);
    console.log(
      'PASS: Model component/CAD deletion, shared footer, IME/Source/draft gates, Agent parity and native undo.',
    );
    throw sketchPlaneComplete;
  }
  if (sketchBooleanOnly) {
    const before = await state();
    const nativeBefore = await page.evaluate(() => window.cad.core.getNativeFiles());
    assert.equal(await button('Drill through hole').count(), 0);
    await button('Create sketch').click();
    const plane = page.getByRole('complementary', { name: 'Sketch plane settings', exact: true });
    await plane.getByRole('button', { name: 'Start sketch', exact: true }).click();
    await page.waitForFunction(() => window.modelCadGui.sketch?.phase === 'sketch');
    const point = (x, y) =>
      page.evaluate(
        ({ x, y }) => {
          const sketch = window.modelCadGui.sketch;
          const world = new window.THREE.Vector3(
            sketch.origin.x + x,
            -sketch.origin.y - y,
            sketch.origin.z,
          ).project(window.camera);
          const rect = document.querySelector('.pcb-model-canvas canvas').getBoundingClientRect();
          return {
            x: rect.left + ((world.x + 1) * rect.width) / 2,
            y: rect.top + ((1 - world.y) * rect.height) / 2,
          };
        },
        { x, y },
      );
    const draw = async (a, b) => {
      const start = await point(...a),
        end = await point(...b);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 8 });
      await page.mouse.up();
      await page.waitForFunction(() => window.modelCadGui.sketch?.closed);
    };
    await draw([-14, -10], [14, 10]);
    const drawing = page.getByRole('complementary', { name: 'Sketch settings', exact: true });
    await drawing.getByRole('combobox', { name: 'Sketch Boolean operation', exact: true }).click();
    await page.getByRole('option', { name: 'Difference', exact: true }).click();
    await button('Draw circle').click();
    await page.waitForFunction(() => window.modelCadGui.sketch?.shape === 'circle');
    await draw([2, -1], [5, -1]);
    assert.equal(await page.evaluate(() => window.modelCadGui.sketch.contours.length), 2);
    assert.equal(
      await page.evaluate(() => window.modelCadGui.sketch.contours[1].operation),
      'difference',
    );
    await button('Finish sketch').click();
    await page.waitForFunction(() => window.modelCadGui.sketch?.phase === 'profile');
    await preview.screenshot({ path: 'test-results/model-sketch-boolean-profile.png' });
    assert.deepEqual(await state(), before, 'Planar Boolean drawing remains a local draft.');
    await button('Extrude sketch').click();
    const extrude = page.getByRole('complementary', { name: 'Extrude settings', exact: true });
    const distance = extrude.getByLabel('Extrusion distance (mm)', { exact: true });
    await distance.fill('6');
    await distance.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
    assert.deepEqual(await state(), before, 'Composing Enter cannot commit extrusion.');
    await extrude.getByRole('button', { name: 'Apply', exact: true }).click();
    await waitObjects(1);
    const object = (await solids())[0];
    assert.equal(object.kind, 'boolean');
    assert.equal(object.boolean.operation, 'difference');
    assert.equal(object.boolean.operands[0].shape.profile.kind, 'rectangle');
    assert.equal(object.boolean.operands[1].shape.profile.kind, 'circle');
    assert.equal(object.boolean.operands[1].shape.size.x, 6);
    assert.equal(object.boolean.operands[0].shape.size.z, 6);
    assert.equal(object.boolean.operands[1].shape.size.z, 6);
    assert.equal((await state()).revision, before.revision + 1);
    assert.doesNotMatch(JSON.stringify(object), /holes|diameterMm/);
    assert.equal(await page.getByRole('button', { name: 'Add hole', exact: true }).count(), 0);
    const native = await page.evaluate(() => window.cad.core.getNativeFiles());
    await button('Undo').click();
    await waitObjects(0);
    assert.deepEqual(await page.evaluate(() => window.cad.core.getNativeFiles()), nativeBefore);
    await button('Redo').click();
    await waitObjects(1);
    assert.deepEqual(await page.evaluate(() => window.cad.core.getNativeFiles()), native);
    assert.deepEqual(errors, []);
    console.log(
      'PASS: real Sketch rectangle/circle Difference drawing, local draft, one prepared extrusion command, IME, native undo/redo and no dedicated Hole UI (kernel mocked).',
    );
    throw sketchPlaneComplete;
  }
  for (const name of ['Place box', 'Place cylinder', 'Create sketch', 'Undo', 'Redo'])
    assert.equal(
      await button(name).count(),
      1,
      `A visible Model toolbar action is available: ${name}`,
    );
  const toolbar = page.getByRole('group', { name: 'Model tools', exact: true });
  assert.deepEqual(
    await toolbar
      .getByRole('button')
      .evaluateAll((buttons) =>
        buttons.slice(0, 3).map((button) => button.getAttribute('aria-label')),
      ),
    ['Interaction mode', 'Annotation mode', 'Create sketch'],
    'Create sketch follows Annotation mode.',
  );
  const primitives = toolbar.getByRole('group', { name: '3D primitives', exact: true });
  const drawingTools = toolbar.getByRole('group', { name: '2D drawing', exact: true });
  const conversionTools = toolbar.getByRole('group', { name: '2D to 3D', exact: true });
  assert.deepEqual(
    await primitives
      .getByRole('button')
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
    ['Place box', 'Place cylinder'],
  );
  assert.equal(
    await drawingTools.getByRole('button', { name: 'Create sketch', exact: true }).count(),
    1,
  );
  assert.equal(
    await conversionTools.getByRole('button', { name: 'Extrude sketch', exact: true }).isDisabled(),
    true,
  );
  const modifications = toolbar.getByRole('group', { name: 'Solid modifications', exact: true });
  assert.equal(
    await modifications.getByRole('button', { name: 'Drill through hole', exact: true }).count(),
    0,
  );
  assert.equal(
    await modifications.getByRole('combobox', { name: 'Modify solids', exact: true }).count(),
    1,
  );
  for (const group of [drawingTools, conversionTools, modifications])
    assert.equal(
      await group.evaluate((element) => getComputedStyle(element).borderLeftWidth),
      '1px',
    );
  await toolbar.screenshot({ path: 'test-results/model-toolbar-categories.png' });
  for (const name of ['Modify solids', 'Edit model'])
    assert.equal(
      await toolbar.getByRole('combobox', { name, exact: true }).count(),
      1,
      `Model groups related commands in ${name}.`,
    );
  assert.equal(
    await page
      .getByRole('combobox', { name: 'Selection type', exact: true, includeHidden: true })
      .count(),
    0,
    'Selection has one set of category checkboxes without a duplicate type selector.',
  );
  await openDisplayDrawer(page, 'Selection');
  const initialSelection = sidebar.getByRole('group', { name: 'Selection', exact: true });
  assert.deepEqual(
    await initialSelection
      .getByRole('checkbox')
      .evaluateAll((inputs) => inputs.map((input) => input.getAttribute('aria-label'))),
    ['All items', 'Solids', 'Faces', 'Edges', 'Lines'],
  );
  assert.equal(await modelToolAvailable(page, 'Pan 3D view'), true);
  assert.equal(
    await button('Export model STEP').count(),
    0,
    'Model has no STEP export toolbar action.',
  );

  await button('Place box').click();
  const placement = page.getByRole('complementary', { name: 'Box settings' });
  const assertPlacementStrip = async (panel, name, singleRow = true) => {
    await panel.evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations({ subtree: true })
          .filter((animation) => animation.effect.getTiming().iterations !== Infinity)
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    const geometry = await panel.evaluate((element) => {
      const body = element.querySelector('form > div');
      const inputs = [...body.querySelectorAll('input')].filter(
        (input) => input.getClientRects().length,
      );
      const centers = inputs.map((input) => {
        const rect = input.getBoundingClientRect();
        return rect.y + rect.height / 2;
      });
      const bounds = element.getBoundingClientRect();
      const bodyBounds = body.getBoundingClientRect();
      const close = element.querySelector('button[aria-label="Cancel"]').getBoundingClientRect();
      return {
        rows: Math.max(...centers) - Math.min(...centers),
        height: bounds.height,
        overflowX: body.scrollWidth > body.clientWidth,
        overflowY: body.scrollHeight > body.clientHeight,
        closeInside: close.left >= bounds.left && close.right <= bounds.right,
        inputsInside: inputs.every((input) => {
          const rect = input.getBoundingClientRect();
          return rect.left >= bodyBounds.left && rect.right <= bodyBounds.right + 1;
        }),
        labels: inputs.map((input) => input.getAttribute('aria-label')),
      };
    });
    if (singleRow) {
      assert.ok(geometry.rows < 1, `${name} fields share one row: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.height <= 54, `${name} uses a compact strip.`);
    }
    assert.equal(geometry.overflowX, false, `${name} needs no horizontal scrolling.`);
    assert.equal(geometry.overflowY, false);
    assert.equal(geometry.closeInside, true);
    assert.equal(geometry.inputsInside, true, `${name} keeps every dimension visible.`);
    assert.deepEqual(
      geometry.labels,
      name.includes('Cylinder')
        ? ['Diameter (mm)', 'Height (mm)']
        : ['Length (mm)', 'Width (mm)', 'Height (mm)'],
    );
    assert.equal(await panel.locator('header').count(), 0);
    assert.equal(
      await panel.getByRole('combobox', { name: 'Solid material', exact: true }).count(),
      0,
    );
  };
  await assertPlacementStrip(placement, 'Box');
  await placement.screenshot({ path: 'test-results/model-box-single-row.png' });
  await page.setViewportSize({ width: 900, height: 900 });
  await assertPlacementStrip(placement, 'Narrow Box');
  await placement.screenshot({ path: 'test-results/model-box-single-row-narrow.png' });
  await page.setViewportSize({ width: 640, height: 900 });
  await assertPlacementStrip(placement, 'Compact Box', false);
  await placement.screenshot({ path: 'test-results/model-box-dimensions-compact.png' });
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.equal(
    await button('Interaction mode').getAttribute('aria-pressed'),
    'false',
    'Placement does not also present Interaction as the active tool.',
  );
  assert.equal(
    await page.evaluate(() =>
      window.originalComponentMaterials.every(({ mesh, material }) => mesh.material !== material),
    ),
    true,
    'Starting placement retains the existing component selection until a solid is selected.',
  );
  await placement.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await button('Interaction mode').getAttribute('aria-pressed'), 'true');
  await componentProperties.waitFor();
  assert.equal(
    await page.evaluate(() =>
      window.originalComponentMaterials.every(({ mesh, material }) => mesh.material !== material),
    ),
    true,
    'Cancelling placement restores the retained component inspection and selection paint.',
  );
  assert.deepEqual(await state(), beforeSidebar);
  await button('Place box').click();
  await placement.waitFor();
  await placement.getByLabel('Length (mm)', { exact: true }).fill('24');
  await placement.getByLabel('Width (mm)', { exact: true }).fill('16');
  await placement.getByLabel('Height (mm)', { exact: true }).fill('8');
  const position = await screenPoint({ x: 70, y: 45, z: 0 });
  await page.mouse.move(position.x, position.y);
  assert.equal((await state()).revision, initial.revision, 'A placement preview creates no edit.');
  await placement.getByLabel('Length (mm)', { exact: true }).fill('-');
  await clickWorld({ x: 70, y: 45 });
  assert.equal(
    (await state()).revision,
    initial.revision,
    'Invalid dimensions cannot commit by clicking.',
  );
  assert.equal(await meshCount(), 0);
  await placement.getByLabel('Length (mm)', { exact: true }).fill('24');
  await clickWorld({ x: 70, y: 45 });
  await waitObjects(1);
  const first = (await solids())[0];
  assert.deepEqual(first.size, { x: 24, y: 16, z: 8 });
  assert.equal((await state()).revision, initial.revision + 1);
  assert.equal((await state()).undoDepth, initial.undoDepth + 1);
  assert.equal((await state()).pcb, initial.pcb);
  await page.waitForFunction(() =>
    window.originalComponentMaterials.every(({ mesh, material }) => mesh.material === material),
  );
  const selectedSolidProperties = page.getByRole('complementary', {
    name: 'Solid properties settings',
    exact: true,
  });
  await selectedSolidProperties.waitFor();
  assert.equal(
    await selectedSolidProperties
      .getByRole('combobox', { name: 'Solid material', exact: true })
      .count(),
    1,
  );
  assert.equal(
    await selectedSolidProperties.getByLabel('Solid X position (mm)', { exact: true }).count(),
    1,
  );
  assert.equal(
    await selectedSolidProperties.getByLabel('Solid name', { exact: true }).inputValue(),
    first.name,
    'A successful placement selects the new solid and restores the old component materials.',
  );
  const afterFirstPlacement = await state();
  await selectModelVisualizationTab(page, 'Display');
  await page.getByRole('checkbox', { name: 'Show CAD solids', exact: true }).uncheck();
  await page.keyboard.press('Escape');
  await sidebar.getByRole('region', { name: 'Model properties', exact: true }).waitFor();
  assert.equal(await componentProperties.isVisible(), false);
  await sidebar.getByText('Select an element to view its properties.', { exact: true }).waitFor();
  assert.deepEqual(
    await state(),
    afterFirstPlacement,
    'Hiding the selected CAD solid does not revive an earlier component inspection or edit content.',
  );
  await selectModelVisualizationTab(page, 'Display');
  await page.getByRole('checkbox', { name: 'Show CAD solids', exact: true }).check();
  await page.keyboard.press('Escape');

  await button('Place cylinder').click();
  await page.getByRole('complementary', { name: 'Cylinder settings' }).waitFor();
  await assertPlacementStrip(
    page.getByRole('complementary', { name: 'Cylinder settings' }),
    'Cylinder',
  );
  await page
    .getByRole('complementary', { name: 'Cylinder settings' })
    .screenshot({ path: 'test-results/model-cylinder-single-row.png' });
  await page.mouse.move(position.x + 80, position.y + 20);
  await page.keyboard.press('Escape');
  await page.getByRole('complementary', { name: 'Cylinder settings' }).waitFor({ state: 'hidden' });
  assert.equal(
    (await state()).revision,
    initial.revision + 1,
    'Escape cancels placement without an edit.',
  );

  await page.evaluate(() => window.cad.setSidebarVisible(false));
  await sidebar.waitFor({ state: 'hidden' });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  await clickSolid(first.id);
  await sidebar.waitFor();
  const inspector = page.getByRole('complementary', { name: 'Solid properties settings' });
  await inspector.waitFor();
  const deleteSolid = inspector.locator('footer').getByRole('button', {
    name: 'Delete object',
    exact: true,
  });
  assert.equal(await deleteSolid.isEnabled(), true);
  assert.equal(
    await inspector.getByRole('button', { name: 'Reload solid parameters', exact: true }).count(),
    0,
    'The ordinary Properties footer offers Delete without a redundant Reload action.',
  );
  const inspectorBody = inspector.locator('form > div').first();
  const originalInspectorViewport = page.viewportSize();
  const originalInspectorTheme = await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme'),
  );
  const originalInspectorScroll = await inspectorBody.evaluate((element) => element.scrollTop);
  const inspectorGeometry = () =>
    inspector.evaluate((element) => {
      const rect = (node) => {
        const { left, right, top, bottom, width, height } = node.getBoundingClientRect();
        return { left, right, top, bottom, width, height };
      };
      const body = element.querySelector('form > div');
      const footer = element.querySelector('footer');
      return {
        panel: rect(element),
        input: rect(element.querySelector('input[aria-label="Solid name"]').closest('label')),
        delete: rect(footer.querySelector('button[aria-label="Delete object"]')),
        apply: rect(footer.querySelector('button[type="submit"]')),
        footer: rect(footer),
        body: rect(body),
        bodyOverflow: body.scrollWidth - body.clientWidth,
        footerOverflow: footer.scrollWidth - footer.clientWidth,
      };
    });
  try {
    for (const viewport of [
      { width: 720, height: 650 },
      { width: 1280, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await assertDocked();
      await inspectorBody.evaluate((element) => {
        element.scrollTop = 0;
      });
      await inspector.getByRole('button', { name: 'Apply', exact: true }).waitFor();
      const geometry = await inspectorGeometry();
      const detail = `${viewport.width} × ${viewport.height}: ${JSON.stringify(geometry)}`;
      assert.ok(
        Math.abs(geometry.footer.right - geometry.delete.right - 12) <= 1,
        `Delete uses the shared 12 px right inset (${detail}).`,
      );
      assert.ok(
        geometry.apply.right + 8 <= geometry.delete.left + 1,
        `Apply precedes the rightmost Delete action (${detail}).`,
      );
      assert.ok(
        Math.abs(
          geometry.delete.top +
            geometry.delete.height / 2 -
            geometry.apply.top -
            geometry.apply.height / 2,
        ) <= 1,
        `Footer buttons share a vertical center (${detail}).`,
      );
      for (const name of ['delete', 'apply'])
        assert.ok(
          geometry[name].width >= 30 && geometry[name].height >= 30,
          `${name} retains a minimum 30 px target (${detail}).`,
        );
      assert.ok(
        geometry.bodyOverflow <= 1 && geometry.footerOverflow <= 1,
        `The inspector fields and footer have no horizontal overflow (${detail}).`,
      );
      assert.ok(
        Math.abs(geometry.footer.bottom - geometry.panel.bottom) <= 1 &&
          geometry.body.bottom <= geometry.footer.top + 1,
        `The footer occupies its own pinned row below the fields (${detail}).`,
      );
      await inspectorBody.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const scrolled = await inspectorGeometry();
      assert.ok(
        Math.abs(scrolled.footer.top - geometry.footer.top) <= 1 &&
          Math.abs(scrolled.footer.bottom - geometry.footer.bottom) <= 1,
        'Scrolling Properties keeps the footer pinned and its actions visible.',
      );
      assert.equal(
        await inspector.getByRole('button', { name: 'Apply', exact: true }).isVisible(),
        true,
        'Solid actions remain accessible in compact windows.',
      );
      await inspectorBody.evaluate((element) => {
        element.scrollTop = 0;
      });
      if (viewport.width === 720) {
        for (const theme of ['light', 'dark']) {
          await page.evaluate(
            (theme) => document.documentElement.setAttribute('data-theme', theme),
            theme,
          );
          await inspector.screenshot({
            path: `test-results/model-properties-alignment-${theme}.png`,
          });
        }
      }
    }
  } finally {
    await page.setViewportSize(originalInspectorViewport);
    await page.evaluate((theme) => {
      if (theme === null) document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', theme);
    }, originalInspectorTheme);
    await inspectorBody.evaluate((element, scrollTop) => {
      element.scrollTop = scrollTop;
    }, originalInspectorScroll);
  }
  await inspector.getByLabel('Solid name', { exact: true }).fill('Aluminium bracket');
  await inspector.getByLabel('Length (mm)', { exact: true }).fill('26');
  await inspector
    .locator('summary')
    .filter({ hasText: /^Placement$/ })
    .click();
  await inspector.getByLabel('Solid X rotation (degrees)', { exact: true }).fill('15');
  await inspector.getByLabel('Solid Y rotation (degrees)', { exact: true }).fill('20');
  await inspector.getByLabel('Solid Z rotation (degrees)', { exact: true }).fill('30');
  await inspector.getByLabel('Opacity (%)', { exact: true }).fill('85');
  const beforeDraftToggle = await state();
  await openDisplayDrawer(page, 'Selection');
  const guardedFilters = page.getByRole('group', { name: 'Selection', exact: true });
  for (const name of ['All items', 'Solids', 'Faces', 'Edges', 'Lines'])
    assert.equal(
      await guardedFilters.getByRole('checkbox', { name, exact: true }).isDisabled(),
      true,
      'Geometry filters retain unapplied Properties drafts.',
    );
  await guardedFilters.getByRole('button', { name: 'Selection', exact: true }).focus();
  await page.keyboard.press('Escape');
  assert.equal(await button('Interaction mode').isDisabled(), true);
  const draftCamera = await cameraState();
  assert.equal(
    await inspector.getByRole('button', { name: 'Toggle right sidebar', exact: true }).count(),
    0,
  );
  const propertiesDisclosure = sidebar.getByRole('button', { name: 'Properties', exact: true });
  await propertiesDisclosure.click();
  await inspector.waitFor({ state: 'hidden' });
  await propertiesDisclosure.click();
  assert.equal(await inspector.getByLabel('Length (mm)', { exact: true }).inputValue(), '26');
  assert.deepEqual(
    await state(),
    beforeDraftToggle,
    'Collapsing Properties retains unapplied drafts.',
  );
  await rightToggle.click();
  await sidebar.waitFor({ state: 'hidden' });
  await rightToggle.click();
  await inspector.waitFor();
  assert.equal(
    await inspector.getByLabel('Solid name', { exact: true }).inputValue(),
    'Aluminium bracket',
  );
  assert.equal(await inspector.getByLabel('Length (mm)', { exact: true }).inputValue(), '26');
  assert.equal(await inspector.getByLabel('Opacity (%)', { exact: true }).inputValue(), '85');
  assert.deepEqual(
    await state(),
    beforeDraftToggle,
    'Sidebar toggles never apply local solid drafts.',
  );
  assert.deepEqual(await cameraState(), draftCamera);
  await assertDocked();
  const stagedPreview = await sceneMeshState({ modelCadId: first.id, modelCadPreview: true });
  assert.equal(stagedPreview?.visible, true, 'A valid unapplied solid draft is visibly previewed.');
  assert.equal(stagedPreview.bounds[1][0] - stagedPreview.bounds[0][0], 26);
  const stagedFields = await inspector
    .locator('input')
    .evaluateAll((inputs) =>
      inputs.map((input) => ({ label: input.getAttribute('aria-label'), value: input.value })),
    );
  for (const enabled of [true, false]) {
    await chooseModelTool(page, 'Pan 3D view');
    assert.equal(
      await button('Interaction mode').getAttribute('aria-pressed'),
      String(!enabled),
      'Pan and Interaction do not appear active together.',
    );
    assert.deepEqual(
      await sceneMeshState({ modelCadId: first.id, modelCadPreview: true }),
      stagedPreview,
      `Turning Pan ${enabled ? 'on' : 'off'} retains the complete unapplied solid preview.`,
    );
    assert.equal(await inspector.isVisible(), true, 'Pan retains the selected solid inspector.');
    assert.equal(
      await inspector.getByRole('status', { name: 'Unapplied changes', exact: true }).isVisible(),
      true,
    );
    assert.deepEqual(
      await inspector
        .locator('input')
        .evaluateAll((inputs) =>
          inputs.map((input) => ({ label: input.getAttribute('aria-label'), value: input.value })),
        ),
      stagedFields,
      'Pan retains every local Properties field.',
    );
    assert.deepEqual(
      await state(),
      beforeDraftToggle,
      'Pan does not apply or discard a solid draft.',
    );
    assert.deepEqual(
      await cameraState(),
      draftCamera,
      'Selecting Pan alone does not move the camera.',
    );
  }
  for (const name of ['Move solid', 'Rotate solid 90°', 'Duplicate solid', 'Delete solid'])
    assert.equal(
      !(await modelToolAvailable(page, name)),
      true,
      `An unapplied inspector draft blocks ${name}.`,
    );
  assert.equal(
    await deleteSolid.isDisabled(),
    true,
    'Footer Delete retains unapplied solid drafts.',
  );
  await inspector.getByLabel('Length (mm)', { exact: true }).fill('-');
  assert.equal(await inspector.getByLabel('Length (mm)', { exact: true }).inputValue(), '-');
  assert.equal(await sceneMeshState({ modelCadId: first.id, modelCadPreview: true }), null);
  await inspector.getByLabel('Length (mm)', { exact: true }).fill('26');
  assert.deepEqual(
    await inspector
      .locator('input')
      .evaluateAll((inputs) =>
        inputs.map((input) => ({ label: input.getAttribute('aria-label'), value: input.value })),
      ),
    stagedFields,
    'Rejected valid and invalid drilling attempts retain every Properties draft field.',
  );
  assert.deepEqual(
    await sceneMeshState({ modelCadId: first.id, modelCadPreview: true }),
    stagedPreview,
  );
  const beforeApply = await state();
  await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.waitForFunction(
    () => window.cad.state().modelCad.objects[0].name === 'Aluminium bracket',
  );
  assert.equal(
    (await state()).revision,
    beforeApply.revision + 1,
    'All property fields apply as one edit.',
  );
  assert.deepEqual((await solids())[0].rotation, { x: 15, y: 20, z: 30 });
  assert.equal((await solids())[0].opacity, 0.85);

  await inspector.getByLabel('Length (mm)', { exact: true }).fill('28');
  await page.evaluate(() => {
    const snapshot = window.cad.core.getSnapshot();
    const body = window.cad.state().modelCad.objects[0];
    return window.cad.host.execute(
      'modelCad.update',
      { boardId: snapshot.project.pcb.id, object: { ...body, name: 'Changed by Agent' } },
      { actor: 'agent', expectedRevision: String(snapshot.revision) },
    );
  });
  await inspector.getByRole('alert').filter({ hasText: 'project changed' }).waitFor();
  assert.equal(
    await deleteSolid.isDisabled(),
    true,
    'A stale Properties draft cannot delete a subsequently changed solid.',
  );
  assert.equal(
    await inspector.getByRole('button', { name: 'Apply', exact: true }).isDisabled(),
    true,
  );
  assert.equal(await inspector.getByLabel('Length (mm)', { exact: true }).inputValue(), '28');
  await inspector.getByRole('button', { name: 'Reload solid parameters' }).click();
  assert.equal(await inspector.getByLabel('Length (mm)', { exact: true }).inputValue(), '26');
  assert.equal(await deleteSolid.isEnabled(), true);
  assert.equal(
    await inspector.getByRole('button', { name: 'Reload solid parameters', exact: true }).count(),
    0,
    'Reload is available only for resolving the stale Properties state.',
  );
  await rightToggle.click();

  const moveTargetPoint = await clickSolid(first.id, { x: 5, y: 0, z: null });
  const moveSelection = await page.evaluate(
    ({ id, point }) => {
      const host = document.querySelector('.pcb-model-canvas');
      const canvas = host.querySelector('canvas');
      const inspector = document.querySelector('[aria-label="Solid properties settings"]');
      const object = window.cad.state().modelCad.objects.find((body) => body.id === id);
      const hit = document.elementFromPoint(point.x, point.y);
      const rect = (element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        targetId: id,
        targetPoint: point,
        expectedName: object.name,
        expectedX: String(object.position.x),
        inspectorVisible: Boolean(inspector?.getClientRects().length),
        inspectedName: inspector?.querySelector('[aria-label="Solid name"]')?.value,
        inspectedX: inspector?.querySelector('[aria-label="Solid X position (mm)"]')?.value,
        unapplied: Boolean(inspector?.querySelector('[aria-label="Unapplied changes"]')),
        cadTool: host.dataset.cadTool,
        hostRect: rect(host),
        canvasRect: rect(canvas),
        camera: {
          type: window.camera.type,
          left: window.camera.left,
          right: window.camera.right,
          top: window.camera.top,
          bottom: window.camera.bottom,
          aspect: window.camera.aspect,
          zoom: window.camera.zoom,
        },
        elementFromPoint: hit && {
          tag: hit.tagName,
          className: hit.getAttribute('class'),
          label: hit.getAttribute('aria-label'),
        },
      };
    },
    { id: first.id, point: moveTargetPoint },
  );
  const moveSelectionMessage = `Selecting the drilled solid before Move: ${JSON.stringify(moveSelection)}`;
  assert.equal(moveSelection.inspectorVisible, true, moveSelectionMessage);
  assert.equal(moveSelection.inspectedName, moveSelection.expectedName, moveSelectionMessage);
  assert.equal(moveSelection.inspectedX, moveSelection.expectedX, moveSelectionMessage);
  assert.equal(moveSelection.unapplied, false, moveSelectionMessage);
  assert.equal(moveSelection.cadTool, 'select', moveSelectionMessage);
  assert.equal(await modelToolAvailable(page, 'Move solid'), true, moveSelectionMessage);
  await chooseModelTool(page, 'Move solid');
  const movePanel = page.getByRole('complementary', { name: 'Move solid settings' });
  await movePanel.waitFor();
  const beforeMove = await state();
  await clickWorld({ x: 50, y: 55 });
  await page.waitForFunction(
    ({ id, old }) => {
      const body = window.cad.state().modelCad.objects.find((item) => item.id === id);
      return body.position.x !== old.x || body.position.y !== old.y;
    },
    { id: first.id, old: beforeMove.modelCad.objects[0].position },
  );
  assert.equal((await state()).revision, beforeMove.revision + 1);
  await rightToggle.click();
  await sidebar.waitFor({ state: 'hidden' });
  const beforeDuplicate = await state();
  await chooseModelTool(page, 'Duplicate solid');
  await waitObjects(2);
  const duplicated = (await solids()).find((body) => body.id !== first.id);
  assert.equal(
    await sidebar.isVisible(),
    true,
    'Duplicating a solid reveals the new selection Properties.',
  );
  await inspector.waitFor();
  assert.equal(
    await inspector.getByLabel('Solid name', { exact: true }).inputValue(),
    duplicated.name,
  );
  assert.equal(
    await inspector.getByLabel('Solid X position (mm)', { exact: true }).inputValue(),
    String(duplicated.position.x),
  );
  assert.equal(
    await page
      .getByRole('combobox', { name: 'Edit model', exact: true })
      .evaluate(
        (element) =>
          document.activeElement === element ||
          document.activeElement === document.querySelector('.pcb-model-canvas'),
      ),
    true,
    'Revealing duplicate Properties retains keyboard focus on the action or canvas.',
  );
  assert.equal((await state()).revision, beforeDuplicate.revision + 1);
  assert.equal(
    (await state()).undoDepth,
    beforeDuplicate.undoDepth + 1,
    'Duplicate is one undo edit.',
  );
  assert.equal((await state()).pcb, beforeDuplicate.pcb);
  assert.equal(await modelToolAvailable(page, 'Delete solid'), true);
  const beforeDelete = await state();
  await deleteSolid.click();
  await waitObjects(1);
  assert.deepEqual(
    (await solids()).map((body) => body.id),
    [first.id],
  );
  assert.equal((await state()).revision, beforeDelete.revision + 1);
  assert.equal(
    (await state()).undoDepth,
    beforeDelete.undoDepth + 1,
    'Properties Delete removes only the inspected solid in one undo edit.',
  );
  assert.equal((await state()).pcb, beforeDelete.pcb, 'Properties Delete preserves PCB bytes.');
  await button('Undo').click();
  await waitObjects(2);
  assert.deepEqual((await state()).modelCad, beforeDelete.modelCad);
  assert.equal((await state()).pcb, beforeDelete.pcb);
  await button('Redo').click();
  await waitObjects(1);
  assert.deepEqual(
    (await solids()).map((body) => body.id),
    [first.id],
  );
  assert.equal((await state()).pcb, beforeDelete.pcb);
  await clickSolid(first.id, { x: 5, y: 0, z: null });
  const beforeRotate = await state();
  await chooseModelTool(page, 'Rotate solid 90°');
  await page.waitForFunction(() => window.cad.state().modelCad.objects[0].rotation.z === 120);
  assert.equal((await state()).revision, beforeRotate.revision + 1);
  const beforePan = await state();
  await chooseModelTool(page, 'Pan 3D view');
  assert.equal(await button('Interaction mode').getAttribute('aria-pressed'), 'false');
  assert.equal(await canvas.evaluate((element) => element.style.cursor), 'grab');
  await setModelSelectionCategories(page, ['Solids']);
  assert.notEqual(
    await canvas.evaluate((element) => element.style.cursor),
    'grab',
    'Changing selection categories leaves Pan and restores selection gestures.',
  );
  assert.equal(await button('Interaction mode').getAttribute('aria-pressed'), 'true');
  assert.equal((await state()).revision, beforePan.revision, 'Pan is presentation state.');
  await setModelSelectionCategories(page, ['Solids', 'Faces', 'Edges', 'Lines']);

  if (await inspector.isVisible()) await rightToggle.click();
  const beforeVisibility = await state();
  await selectModelVisualizationTab(page, 'Display');
  await page.getByRole('checkbox', { name: 'Show CAD solids', exact: true }).uncheck();
  await page.keyboard.press('Escape');
  await openDisplayDrawer(page, 'Selection');
  await page.getByRole('checkbox', { name: 'Solids', exact: true }).uncheck();
  await page.keyboard.press('Escape');
  assert.equal(
    (await state()).revision,
    beforeVisibility.revision,
    'CAD visibility and selection filters are presentation state.',
  );
  assert.equal(
    await page.evaluate((id) => {
      let visible;
      window.scene.traverse((node) => {
        if (node.userData.modelCadId === id && !node.userData.modelCadPreview)
          visible = node.parent.visible;
      });
      return visible;
    }, first.id),
    false,
  );
  for (const name of ['Place box', 'Place cylinder', 'Create sketch'])
    assert.equal(
      !(await modelToolAvailable(page, name)),
      false,
      `Selection eligibility does not block creating geometry through ${name}.`,
    );
  assert.equal(
    !(await modelToolAvailable(page, 'Boolean solids')),
    true,
    'Boolean operands require eligible whole solids.',
  );
  await rightToggle.click();
  await button('Place cylinder').click();
  const cylinderPanel = page.getByRole('complementary', { name: 'Cylinder settings' });
  await cylinderPanel.getByLabel('Diameter (mm)', { exact: true }).fill('9');
  await cylinderPanel.getByLabel('Height (mm)', { exact: true }).fill('12');
  assert.equal(await sidebar.isVisible(), false, 'Placement starts with the right dock collapsed.');
  const cylinderPosition = await screenPoint({
    x: 30,
    y: 30,
    z: await page.evaluate(() => window.cad.newObject('cylinder').position.z),
  });
  await page.mouse.move(cylinderPosition.x, cylinderPosition.y);
  const beforeKeyboardPlacement = await state();
  await canvas.focus();
  await page.keyboard.press('Enter');
  await waitObjects(2);
  const cylinder = (await solids()).find((body) => body.kind === 'cylinder');
  assert.deepEqual(cylinder.size, { x: 9, y: 9, z: 12 });
  assert.equal(
    await inspector.isVisible(),
    false,
    'A new solid remains unselected while whole solids are ineligible.',
  );
  assert.equal(await canvas.getAttribute('data-cad-selection-count'), '0');
  await openDisplayDrawer(page, 'Selection');
  assert.equal(
    await page.getByRole('checkbox', { name: 'Solids', exact: true }).isChecked(),
    false,
    'Creation retains the current selection filter.',
  );
  await page.getByRole('checkbox', { name: 'Solids', exact: true }).check();
  await page.keyboard.press('Escape');
  await setModelSelectionCategories(page, ['Solids']);
  await clickSolid(cylinder.id);
  await inspector.waitFor();
  assert.equal(
    await inspector.getByLabel('Solid name', { exact: true }).inputValue(),
    cylinder.name,
  );
  assert.equal(await inspector.getByLabel('Diameter (mm)', { exact: true }).inputValue(), '9');
  assert.equal(await inspector.getByLabel('Height (mm)', { exact: true }).inputValue(), '12');
  assert.equal(
    await inspector.getByLabel('Solid X position (mm)', { exact: true }).inputValue(),
    '30',
  );
  assert.equal(
    await inspector.getByLabel('Solid Y position (mm)', { exact: true }).inputValue(),
    '30',
  );
  assert.equal(await canvas.evaluate((element) => document.activeElement === element), true);
  assert.equal((await state()).revision, beforeKeyboardPlacement.revision + 1);
  assert.equal((await state()).undoDepth, beforeKeyboardPlacement.undoDepth + 1);
  assert.equal((await state()).pcb, beforeKeyboardPlacement.pcb);
  assert.equal((await state()).revision, beforeVisibility.revision + 1);
  await selectModelVisualizationTab(page, 'Display');
  assert.equal(
    await page.getByRole('checkbox', { name: 'Show CAD solids', exact: true }).isChecked(),
    true,
  );
  await page.keyboard.press('Escape');
  await openDisplayDrawer(page, 'Selection');
  assert.equal(await page.getByRole('checkbox', { name: 'Solids', exact: true }).isChecked(), true);
  await page.keyboard.press('Escape');
  await setModelSelectionCategories(page, ['Solids', 'Faces', 'Edges', 'Lines']);

  for (const name of ['Create U-channel enclosure', 'Toggle enclosure cover', 'Enclosure CAD'])
    assert.equal(await button(name).count(), 0, 'Dedicated enclosure editing actions are absent.');
  if (await sidebar.isVisible()) await rightToggle.click();
  const beforeExport = await state();
  assert.equal(
    await page.evaluate(
      () => window.cad.host.catalog().find((item) => item.id === 'enclosure.exportStep')?.available,
    ),
    true,
  );
  assert.deepEqual(
    await page.evaluate(() =>
      window.cad.host.execute('enclosure.exportStep', {}, { actor: 'human' }),
    ),
    { status: 'exported', name: 'model.step' },
  );
  await page.waitForFunction(() => window.exports.length > 0);
  assert.equal(await page.evaluate(() => window.exports.at(-1).source), beforeExport.source);
  assert.equal((await state()).revision, beforeExport.revision);

  await page.evaluate(() => window.cad.core.updateSource('invalid pending source'));
  await page.waitForFunction(
    () => document.querySelector('button[aria-label="Place box"]').disabled,
  );
  for (const name of [
    'Place box',
    'Place cylinder',
    'Move solid',
    'Rotate solid 90°',
    'Duplicate solid',
    'Delete solid',
    'Undo',
    'Redo',
  ])
    assert.equal(!(await modelToolAvailable(page, name)), true, `Pending Source blocks ${name}.`);
  assert.equal(
    await modelToolAvailable(page, 'Pan 3D view'),
    true,
    'The compact Edit menu retains camera navigation while Source blocks design edits.',
  );
  assert.equal(
    await page.evaluate(
      () => window.cad.host.catalog().find((item) => item.id === 'enclosure.exportStep')?.available,
    ),
    false,
  );
  await assert.rejects(
    page.evaluate(() => window.cad.host.execute('enclosure.exportStep', {}, { actor: 'human' })),
    /Apply Source edits/,
  );
  const guarded = await state();
  assert.equal(
    await page.evaluate(async () => {
      try {
        const snapshot = window.cad.core.getSnapshot();
        await window.cad.host.execute(
          'modelCad.add',
          { boardId: snapshot.project.pcb.id, object: window.cad.newObject('box') },
          { actor: 'human', expectedRevision: String(snapshot.revision) },
        );
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  assert.equal((await state()).revision, guarded.revision);
  await page.evaluate(() => window.cad.core.discardSource());

  const frozenRequests = requests;
  const visibleMeshes = await meshCount();
  await page.evaluate(() => window.cad.setActive(false));
  const deferredId = await page.evaluate(async () => {
    const snapshot = window.cad.core.getSnapshot(),
      object = window.cad.newObject('cylinder');
    await window.cad.host.execute(
      'modelCad.add',
      { boardId: snapshot.project.pcb.id, object },
      { actor: 'agent', expectedRevision: String(snapshot.revision) },
    );
    return object.id;
  });
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(await meshCount(), visibleMeshes, 'Hidden Model defers CAD mesh rebuilds.');
  assert.equal(requests, frozenRequests, 'Hidden CAD updates start no library requests.');
  await page.evaluate(() => window.cad.setActive(true));
  await page.waitForFunction((id) => {
    let found = false;
    window.scene.traverse((node) => {
      if (node.userData.modelCadId === id && !node.userData.modelCadPreview) found = true;
    });
    return found;
  }, deferredId);
  assert.equal(requests, frozenRequests, 'CAD edits retain component/model caches.');
  assert.equal(
    await page.evaluate(
      () => document.querySelector('.pcb-model-canvas canvas') === window.originalCanvas,
    ),
    true,
  );
  assert.equal(await page.evaluate(() => window.camera === window.originalCamera), true);
  assert.equal((await state()).pcb, initial.pcb, 'Model CAD never changes PCB source data.');

  const beforeFitFixture = await state();
  await page.evaluate(async (id) => {
    const snapshot = window.cad.core.getSnapshot();
    const object = window.cad.state().modelCad.objects.find((body) => body.id === id);
    await window.cad.host.execute(
      'modelCad.update',
      {
        boardId: snapshot.project.pcb.id,
        object: { ...object, position: { ...object.position, x: 1000 } },
      },
      { actor: 'human', expectedRevision: String(snapshot.revision) },
    );
  }, first.id);
  await page.waitForFunction((id) => {
    let found = false;
    window.scene.traverse((node) => {
      if (node.userData.modelCadId === id && !node.userData.modelCadPreview)
        found = node.position.x === 1000;
    });
    return found;
  }, first.id);
  const fitLabels = ['Show CAD solids', 'Show components'];
  await selectModelVisualizationTab(page, 'Display');
  const displayBeforeFit = await Promise.all(
    fitLabels.map((name) => page.getByRole('checkbox', { name, exact: true }).isChecked()),
  );
  for (const name of fitLabels) await page.getByRole('checkbox', { name, exact: true }).uncheck();
  await page.keyboard.press('Escape');
  const fitState = await state();
  const fitNative = await page.evaluate(() => window.cad.core.getNativeFiles());
  const fitCamera = async () => {
    await runCanvasAction(page, 'Fit 3D board');
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    assert.deepEqual(
      await state(),
      fitState,
      'Fit and visibility changes never edit Core or undo.',
    );
    return {
      ...(await cameraState()),
      span: await page.evaluate(
        () => (window.camera.top - window.camera.bottom) / window.camera.zoom,
      ),
    };
  };
  const setFitDisplay = async (name, visible) => {
    await selectModelVisualizationTab(page, 'Display');
    await page.getByRole('checkbox', { name, exact: true }).setChecked(visible);
    await page.keyboard.press('Escape');
  };
  const boardOnlyFit = await fitCamera();
  const assertBoardOnlyFit = async () => {
    const actual = await fitCamera();
    for (const key of ['position', 'quaternion'])
      actual[key].forEach((value, index) =>
        assert.ok(
          Math.abs(value - boardOnlyFit[key][index]) < 1e-7,
          'Hidden geometry cannot alter Fit.',
        ),
      );
    assert.ok(Math.abs(actual.span - boardOnlyFit.span) < 1e-7);
    assert.equal(actual.zoom, boardOnlyFit.zoom);
  };
  await setFitDisplay('Show CAD solids', true);
  assert.ok(
    (await fitCamera()).span > boardOnlyFit.span * 5,
    'Fit includes a visible remote solid.',
  );
  await setFitDisplay('Show CAD solids', false);
  await assertBoardOnlyFit();
  await setFitDisplay('Show components', true);
  assert.ok(
    Math.abs((await fitCamera()).position[2] - boardOnlyFit.position[2]) > 0.1,
    'A visible component contributes its height to Fit.',
  );
  await setFitDisplay('Show components', false);
  await assertBoardOnlyFit();
  assert.deepEqual(
    await page.evaluate(() => window.cad.core.getNativeFiles()),
    fitNative,
    'Repeated Fit and visibility changes preserve every native file byte.',
  );
  await button('Undo').click();
  await page.waitForFunction(
    (source) => window.cad.state().source === source,
    beforeFitFixture.source,
  );
  assert.equal((await state()).undoDepth, beforeFitFixture.undoDepth);
  assert.equal((await state()).pcb, beforeFitFixture.pcb);
  await selectModelVisualizationTab(page, 'Display');
  for (const [index, name] of fitLabels.entries())
    await page.getByRole('checkbox', { name, exact: true }).setChecked(displayBeforeFit[index]);
  await page.keyboard.press('Escape');

  await runCanvasAction(page, 'Fit 3D board');
  await preview.screenshot({ path: 'test-results/model-cad-tools-ui.png' });
  await clickSolid(first.id, { x: 5, y: 0, z: null });
  await inspector.waitFor();
  await preview.screenshot({ path: 'test-results/model-cad-inspector-ui.png' });
  const originalTheme = await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme'),
  );
  const selectionDrawer = page.getByRole('group', { name: 'Selection', exact: true });
  const selectionDisclosure = selectionDrawer.getByRole('button', {
    name: 'Selection',
    exact: true,
  });
  const selectionExpanded = (await selectionDisclosure.getAttribute('aria-expanded')) === 'true';
  await openDisplayDrawer(page, 'Selection');
  try {
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (theme) => document.documentElement.setAttribute('data-theme', theme),
        theme,
      );
      await toolbar.screenshot({
        path: `test-results/model-cad-toolbar-${theme}.png`,
      });
      await selectionDrawer.screenshot({ path: `test-results/model-cad-selection-${theme}.png` });
    }
  } finally {
    await page.evaluate((theme) => {
      if (theme === null) document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', theme);
    }, originalTheme);
    if (!selectionExpanded) await selectionDisclosure.click();
  }

  const beforeSketch = await state();
  const beforeSketchNative = sketchInputOnly
    ? await page.evaluate(() => window.cad.core.getNativeFiles())
    : null;
  const beforeSketchCount = (await solids()).length;
  const sketchCameraState = () =>
    page.evaluate(() => ({
      position: window.camera.position.toArray(),
      quaternion: window.camera.quaternion.toArray(),
      up: window.camera.up.toArray(),
      target: window.modelOrbit.target.toArray(),
      zoom: window.camera.zoom,
      orthographic: window.camera.isOrthographicCamera === true,
    }));
  const settleSketchCamera = () =>
    page.evaluate(async () => {
      let previous = '',
        stable = 0;
      for (let frame = 0; frame < 180 && stable < 3; frame++) {
        await new Promise(requestAnimationFrame);
        const current = [
          ...window.camera.position.toArray(),
          ...window.camera.quaternion.toArray(),
          ...window.modelOrbit.target.toArray(),
          window.camera.zoom,
        ]
          .map((value) => value.toFixed(7))
          .join(':');
        stable = current === previous ? stable + 1 : 0;
        previous = current;
      }
    });
  const assertSketchCameraRestored = async (expected, message) => {
    await page.waitForFunction((expected) => {
      const camera = window.camera;
      return (
        (camera.isOrthographicCamera === true) === expected.orthographic &&
        Math.abs(camera.zoom - expected.zoom) < 1e-6 &&
        ['position', 'quaternion', 'up'].every((field) =>
          camera[field]
            .toArray()
            .every((value, index) => Math.abs(value - expected[field][index]) < 1e-6),
        ) &&
        window.modelOrbit.target
          .toArray()
          .every((value, index) => Math.abs(value - expected.target[index]) < 1e-6)
      );
    }, expected);
    const actual = await sketchCameraState();
    for (const field of ['position', 'quaternion', 'up', 'target'])
      assert.ok(
        actual[field].every((value, index) => Math.abs(value - expected[field][index]) < 1e-6),
        `${message}: ${field} ${JSON.stringify({ actual: actual[field], expected: expected[field] })}`,
      );
    assert.ok(Math.abs(actual.zoom - expected.zoom) < 1e-6, `${message}: zoom`);
    assert.equal(actual.orthographic, expected.orthographic, `${message}: projection`);
  };
  const waitSketchPhase = async (phase) => {
    await page
      .waitForFunction(
        (phase) => document.querySelector('.pcb-model-canvas').dataset.sketchPhase === phase,
        phase,
      )
      .catch(async (cause) => {
        await preview.screenshot({ path: 'test-results/model-sketch-phase-failure.png' });
        throw new Error(
          `Expected sketch phase ${phase}: ${JSON.stringify(
            await page.evaluate(() => ({
              actual: document.querySelector('.pcb-model-canvas').dataset.sketchPhase,
              mode: window.modelMode,
              panels: [...document.querySelectorAll('aside[aria-label]')].map((node) =>
                node.getAttribute('aria-label'),
              ),
            })),
          )}`,
          { cause },
        );
      });
  };
  const sketchGrid = () =>
    page.evaluate(() => {
      const grids = [];
      window.scene.updateMatrixWorld(true);
      window.scene.traverseVisible((node) => {
        if (!node.userData.modelCadSketchGrid) return;
        const positions = node.geometry.attributes.position;
        const coordinates = [new Set(), new Set(), new Set()];
        const directions = new Set();
        let orthogonal = true;
        for (let index = 0; index < positions.count; index += 2) {
          const from = new window.THREE.Vector3()
            .fromBufferAttribute(positions, index)
            .applyMatrix4(node.matrixWorld)
            .toArray();
          const to = new window.THREE.Vector3()
            .fromBufferAttribute(positions, index + 1)
            .applyMatrix4(node.matrixWorld)
            .toArray();
          const changed = from.flatMap((value, axis) =>
            Math.abs(value - to[axis]) > 1e-5 ? [axis] : [],
          );
          orthogonal &&= changed.length === 1;
          if (changed.length === 1) directions.add(changed[0]);
          for (let axis = 0; axis < 3; axis++)
            if (Math.abs(from[axis] - to[axis]) < 1e-5)
              coordinates[axis].add(Number(from[axis].toFixed(5)));
        }
        grids.push({
          lineSegments: node.isLineSegments === true,
          points: node.isPoints === true,
          selectedSpacing: node.userData.modelGridSpacing,
          displaySpacing: node.userData.modelGridDisplaySpacing,
          orthogonal,
          directions: [...directions].sort(),
          coordinates: coordinates.map((values) => [...values].sort((a, b) => a - b)),
        });
      });
      return grids;
    });
  const waitSketchGrid = (visible) =>
    page.waitForFunction((visible) => {
      let count = 0;
      window.scene.traverseVisible((node) => {
        if (node.userData.modelCadSketchGrid) count++;
      });
      return visible ? count === 1 : count === 0;
    }, visible);
  const setSketchGrid = async (visible, spacing = 0.5) => {
    await page.evaluate(
      ({ visible, spacing }) => {
        window.cad.setGrid(visible);
        window.cad.setGridSpacing(spacing);
      },
      { visible, spacing },
    );
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await waitSketchGrid(visible);
    if (visible)
      await page.waitForFunction((spacing) => {
        let current = false;
        window.scene.traverseVisible((node) => {
          if (node.userData.modelCadSketchGrid)
            current = node.userData.modelGridSpacing === spacing;
        });
        return current;
      }, spacing);
  };
  const contourGeometry = () =>
    page.evaluate(() => {
      const lines = [];
      window.scene.traverse((node) => {
        if (node.userData.modelCadSketch && node.isLine)
          lines.push(Array.from(node.geometry.attributes.position.array));
      });
      return lines;
    });
  const previewMeshCount = () =>
    page.evaluate(() => {
      let count = 0;
      window.scene.traverse((node) => {
        if (node.userData.modelCadPreview && node.isMesh) count++;
      });
      return count;
    });
  const planePanel = page.getByRole('complementary', {
    name: 'Sketch plane settings',
    exact: true,
  });
  const sketchPanel = page.getByRole('complementary', { name: 'Sketch settings', exact: true });
  const profilePanel = page.getByRole('complementary', { name: 'Sketch profile', exact: true });
  const extrude = page.getByRole('complementary', { name: 'Extrude settings', exact: true });
  const chooseSketchPlane = async (plane) => {
    const selector = planePanel.getByRole('combobox', { name: 'Sketch plane', exact: true });
    await selector.press('ArrowDown');
    await selector.press('Home');
    for (let index = 0; index < ['XY', 'XZ', 'YZ'].indexOf(plane); index++)
      await selector.press('ArrowDown');
    await selector.press('Enter');
  };
  await waitSketchGrid(false);
  for (const [plane, axis, offset, normal] of [
    ['XY', 'z', 4.5, [0, 0, 1]],
    ['XZ', 'y', 31.5, [0, 1, 0]],
    ['YZ', 'x', 45.5, [1, 0, 0]],
  ]) {
    const beforePlaneCamera = await sketchCameraState();
    await button('Create sketch').click();
    await planePanel.waitFor();
    await waitSketchPhase('plane');
    await waitSketchGrid(false);
    await chooseSketchPlane(plane);
    const planeOffset = planePanel.getByLabel('Sketch plane offset (mm)', { exact: true });
    assert.equal(
      Number(await planeOffset.inputValue()),
      0,
      `${plane} starts with zero offset along its normal axis.`,
    );
    await planeOffset.fill('-');
    assert.equal(
      await planePanel.getByRole('button', { name: 'Start sketch', exact: true }).isDisabled(),
      true,
    );
    await planeOffset.fill(String(offset));
    await page.waitForFunction(
      ({ plane, axis, offset }) => {
        const expected = { x: 'X', y: 'Y', z: 'Z' }[axis];
        if (window.modelMode !== `${plane} plane · ${expected} = ${offset} mm`) return false;
        let surface;
        window.scene.traverseVisible((node) => {
          if (node.isMesh && node.userData.modelCadSketchPlane) surface = node;
        });
        return (
          surface &&
          Math.abs(
            surface.getWorldPosition(new window.THREE.Vector3())[axis] -
              (axis === 'y' ? -offset : offset),
          ) < 1e-6
        );
      },
      { plane, axis, offset },
    );
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      await planeOffset.dispatchEvent('keydown', { key: 'Enter', ...composition });
      assert.equal(await canvas.getAttribute('data-sketch-phase'), 'plane');
    }
    await planeOffset.dispatchEvent('compositionstart');
    await planeOffset.press('Enter');
    assert.equal(await canvas.getAttribute('data-sketch-phase'), 'plane');
    await planeOffset.dispatchEvent('compositionend');
    const canvasBounds = await canvas.boundingBox();
    await page.mouse.click(
      canvasBounds.x + canvasBounds.width / 2,
      canvasBounds.y + canvasBounds.height / 2,
    );
    assert.equal(
      await page.evaluate(() => window.modelCadGui.sketch?.points.length ?? 0),
      0,
      'The plane preview cannot accept drawing points before Start sketch.',
    );
    assert.deepEqual(await state(), beforeSketch);
    await assertSketchCameraRestored(
      beforePlaneCamera,
      'Choosing a workplane does not replace the 3D camera',
    );
    await planePanel.getByRole('button', { name: 'Start sketch', exact: true }).click();
    await waitSketchPhase('sketch');
    await sketchPanel.waitFor();
    await page
      .waitForFunction(
        ({ axis, offset, normal }) => {
          const sketch = window.modelCadGui.sketch;
          if (!sketch || sketch.origin[axis] !== offset) return false;
          const target = [sketch.origin.x, -sketch.origin.y, sketch.origin.z];
          const direction = window.camera.getWorldDirection(new window.THREE.Vector3()).toArray();
          return (
            target.every(
              (value, index) => Math.abs(value - window.modelOrbit.target.toArray()[index]) < 1e-6,
              // OrbitControls keeps polar views one microradian from its singularity.
            ) && direction.every((value, index) => Math.abs(value + normal[index]) < 2e-6)
          );
        },
        { axis, offset, normal },
      )
      .catch(async (cause) => {
        throw new Error(
          `${plane} sketch frame: ${JSON.stringify(
            await page.evaluate(() => ({
              sketch: window.modelCadGui.sketch,
              target: window.modelOrbit.target.toArray(),
              position: window.camera.position.toArray(),
              direction: window.camera.getWorldDirection(new window.THREE.Vector3()).toArray(),
              up: window.camera.up.toArray(),
              orthographic: window.camera.isOrthographicCamera,
            })),
          )}`,
          { cause },
        );
      });
    assert.deepEqual(
      await page.evaluate(() => window.camera.up.toArray()),
      plane === 'XY' ? [0, 1, 0] : [0, 0, 1],
      `${plane} starts with the matching workplane camera frame.`,
    );
    assert.equal(await page.evaluate(() => window.camera.isOrthographicCamera), true);
    await waitSketchGrid(true);
    const [gridFrame] = await sketchGrid();
    assert.equal(gridFrame.lineSegments && !gridFrame.points && gridFrame.orthogonal, true);
    const normalAxis = normal.findIndex((value) => value !== 0);
    assert.deepEqual(
      gridFrame.directions,
      [0, 1, 2].filter((axis) => axis !== normalAxis),
    );
    assert.deepEqual(
      gridFrame.coordinates[normalAxis],
      [axis === 'y' ? -offset : offset],
      `${plane} grid lines lie on the chosen absolute workplane offset.`,
    );
    for (const name of ['Draw rectangle', 'Draw circle', 'Draw polyline', 'Finish sketch'])
      assert.equal(await drawingTools.getByRole('button', { name, exact: true }).count(), 1);
    assert.equal(
      await conversionTools
        .getByRole('button', { name: 'Extrude sketch', exact: true })
        .isDisabled(),
      true,
    );
    assert.equal(
      await toolbar.getByRole('button', { name: 'Place box', exact: true }).count(),
      0,
      'The drawing phase exposes sketch tools instead of solid creation tools.',
    );
    assert.equal(await button('Finish sketch').isDisabled(), true);
    await sketchPanel.getByRole('button', { name: 'Cancel', exact: true }).click();
    await sketchPanel.waitFor({ state: 'hidden' });
    await waitSketchGrid(false);
    await assertSketchCameraRestored(
      beforePlaneCamera,
      'Cancelling sketch drawing restores the 3D camera',
    );
    assert.deepEqual(
      await state(),
      beforeSketch,
      'Workplane setup and cancellation create no native edits or undo.',
    );
  }

  // Offset editing keeps the 3D view; Start sketch aligns to the exact distant plane.
  const beforeRemoteCamera = await sketchCameraState();
  await button('Create sketch').click();
  await chooseSketchPlane('XZ');
  const remoteOffset = planePanel.getByLabel('Sketch plane offset (mm)', { exact: true });
  assert.equal(await planePanel.getByText('Offset', { exact: true }).count(), 1);
  assert.equal(
    await planePanel.getByRole('button', { name: 'Locate sketch plane', exact: true }).count(),
    0,
  );
  await remoteOffset.fill('212');
  await page.waitForFunction(() => window.modelCadGui.sketch?.origin.y === 212);
  await assertSketchCameraRestored(
    beforeRemoteCamera,
    'Editing a plane offset preserves the 3D view',
  );
  await remoteOffset.fill('-');
  assert.equal(
    await planePanel.getByRole('button', { name: 'Start sketch', exact: true }).isDisabled(),
    true,
  );
  await page.waitForFunction(() => {
    let count = 0;
    window.scene.traverseVisible((node) => {
      if (node.userData.modelCadSketchPlane) count++;
    });
    return count === 0;
  });
  await remoteOffset.fill('212');
  await planePanel.getByRole('button', { name: 'Start sketch', exact: true }).click();
  await waitSketchPhase('sketch');
  await page.waitForFunction(() => {
    const origin = window.modelCadGui.sketch?.origin;
    if (!origin || origin.y !== 212) return false;
    const point = new window.THREE.Vector3(origin.x, -origin.y, origin.z).project(window.camera);
    return Math.abs(point.x) < 1e-5 && Math.abs(point.y) < 1e-5 && point.z > -1 && point.z < 1;
  });
  await sketchPanel.getByRole('button', { name: 'Cancel', exact: true }).click();
  await assertSketchCameraRestored(
    beforeRemoteCamera,
    'Cancelling a distant sketch restores the camera',
  );
  assert.deepEqual(await state(), beforeSketch);

  const sketchPlaneOffset = sketchInputOnly ? 0 : 4.5;
  const beforeSketchCamera = await sketchCameraState();
  await button('Create sketch').click();
  const sketchOffsetInput = planePanel.getByLabel('Sketch plane offset (mm)', { exact: true });
  assert.equal(Number(await sketchOffsetInput.inputValue()), 0);
  if (sketchPlaneOffset) await sketchOffsetInput.fill(String(sketchPlaneOffset));
  await preview.screenshot({ path: 'test-results/model-sketch-flow-plane.png' });
  await planePanel.getByRole('button', { name: 'Start sketch', exact: true }).click();
  await waitSketchPhase('sketch');
  await sketchPanel.waitFor();
  await button('Draw circle').click();
  await page.waitForFunction(() => window.modelCadGui.sketch?.shape === 'circle');
  await button('Draw polyline').click();
  await page.waitForFunction(() => window.modelCadGui.sketch?.shape === 'polygon');
  await button('Draw rectangle').click();
  await page.waitForFunction(() => window.modelCadGui.sketch?.shape === 'rectangle');
  assert.equal(await page.getByRole('application', { name: '2D sketch canvas' }).count(), 0);
  assert.equal(
    await canvas.locator('canvas').count(),
    1,
    'Sketching uses the existing PCB WebGL canvas.',
  );
  assert.equal(await button('Finish sketch').isDisabled(), true);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const startSketch = await screenPoint({ x: 42, y: 30, z: sketchPlaneOffset });
  const endSketch = await screenPoint({ x: 58, y: 46, z: sketchPlaneOffset });
  assert.equal(
    await page.evaluate(
      ({ startSketch, endSketch }) =>
        [startSketch, endSketch].every(
          (point) => document.elementFromPoint(point.x, point.y)?.tagName === 'CANVAS',
        ),
      { startSketch, endSketch },
    ),
    true,
    'Sketch drawing targets the same PCB rendering surface.',
  );
  for (const shape of ['rectangle', 'circle']) {
    await button(shape === 'rectangle' ? 'Draw rectangle' : 'Draw circle').click();
    await button('Clear sketch').click();
    await page.mouse.click(startSketch.x, startSketch.y);
    assert.equal(
      await sketchPanel.getByRole('alert').count(),
      0,
      `${shape}: the first point is an incomplete gesture, not an invalid solid.`,
    );
    assert.equal(await button('Finish sketch').isDisabled(), true);
    const anchor = await page.evaluate(() => window.modelCadGui.sketch.points[0]);
    if (shape === 'rectangle') {
      await page.mouse.move(endSketch.x, startSketch.y);
      assert.equal(await sketchPanel.getByRole('alert').count(), 0);
      assert.equal(await button('Finish sketch').isDisabled(), true);
    }
    await page.mouse.move(endSketch.x, endSketch.y, { steps: 4 });
    const following = await page.evaluate(() => window.modelCadGui.sketch);
    assert.deepEqual(following.points[0], anchor);
    assert.notDeepEqual(
      following.points[1],
      anchor,
      'The first click retains a live pointer preview.',
    );
    assert.equal(following.closed, false);
    assert.equal(await button('Finish sketch').isDisabled(), true);
    await page.mouse.click(endSketch.x, endSketch.y);
    assert.equal(await page.evaluate(() => window.modelCadGui.sketch.closed), true);
    assert.equal(await button('Finish sketch').isEnabled(), true);
    assert.equal(await sketchPanel.getByRole('alert').count(), 0);
    assert.deepEqual(await state(), beforeSketch, 'Click drawing never commits a partial solid.');
    await button('Clear sketch').click();
    await page.mouse.click(startSketch.x, startSketch.y);
    await canvas.dispatchEvent('keydown', { key: 'Escape', keyCode: 229, isComposing: true });
    assert.equal(await page.evaluate(() => window.modelCadGui.sketch.points.length), 2);
    await canvas.press('Escape');
    await page.waitForFunction(() => window.modelCadGui.sketch.points.length === 0);
    assert.equal(await page.evaluate(() => window.modelCadGui.sketch.points.length), 0);
    assert.equal(await canvas.getAttribute('data-sketch-phase'), 'sketch');
    assert.equal(await button('Finish sketch').isDisabled(), true);
    await page.mouse.move(startSketch.x, startSketch.y);
    await page.mouse.down();
    await page.mouse.move(endSketch.x, endSketch.y, { steps: 4 });
    await page.mouse.up();
    assert.equal(
      await button('Finish sketch').isEnabled(),
      true,
      `${shape} still supports dragging.`,
    );
    await button('Clear sketch').click();
  }
  await button('Draw rectangle').click();
  await page.mouse.move(startSketch.x, startSketch.y);
  await page.mouse.down();
  await page.mouse.move(endSketch.x, endSketch.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => {
    let line = false;
    window.scene.traverse((node) => {
      if (node.userData.modelCadSketch && node.isLine) line = true;
    });
    return line;
  });
  assert.deepEqual(
    await state(),
    beforeSketch,
    'Shared-canvas sketch lines are transient presentation.',
  );
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    await canvas.dispatchEvent('keydown', { key: 'Enter', ...composition });
    assert.equal(await canvas.getAttribute('data-sketch-phase'), 'sketch');
  }
  const drawnContour = await contourGeometry();
  await settleSketchCamera();
  const beforeGridCamera = await sketchCameraState();
  const physicalSceneIdentity = () =>
    page.evaluate(() => {
      const meshes = [];
      window.scene.traverse((node) => {
        if (node.isMesh) meshes.push([node.uuid, node.geometry.uuid]);
      });
      return {
        scene: window.scene.uuid,
        canvasRetained:
          document.querySelector('.pcb-model-canvas canvas') === window.originalCanvas,
        meshes,
      };
    });
  const beforeGridScene = await physicalSceneIdentity();
  const beforeGridRequests = requests;
  const gridOrigin = await page.evaluate(() => {
    const { x, y, z } = window.modelCadGui.sketch.origin;
    return [x, -y, z];
  });
  for (const spacing of [10, 0.5]) {
    await setSketchGrid(true, spacing);
    const [lines] = await sketchGrid();
    assert.equal(lines.lineSegments && !lines.points && lines.orthogonal, true);
    assert.equal(lines.selectedSpacing, spacing);
    assert.ok(Number.isInteger(Math.log2(lines.displaySpacing / spacing)));
    for (const axis of [0, 1]) {
      const coordinates = lines.coordinates[axis];
      assert.ok(coordinates.length > 2, 'The sketch shows intersecting line families.');
      for (let index = 0; index < coordinates.length; index++) {
        const multiple = (coordinates[index] - gridOrigin[axis]) / lines.displaySpacing;
        assert.ok(Math.abs(multiple - Math.round(multiple)) < 1e-4);
        if (index > 0)
          assert.ok(
            Math.abs(coordinates[index] - coordinates[index - 1] - lines.displaySpacing) < 1e-4,
            'Actual line intervals follow the selected density and workplane origin.',
          );
      }
    }
    await assertSketchCameraRestored(beforeGridCamera, 'Grid density preserves the drawing camera');
    assert.deepEqual(await contourGeometry(), drawnContour);
    assert.deepEqual(await state(), beforeSketch);
    assert.deepEqual(await physicalSceneIdentity(), beforeGridScene);
  }
  await setSketchGrid(false);
  assert.deepEqual(await contourGeometry(), drawnContour, 'Off hides grid lines, not the sketch.');
  await assertSketchCameraRestored(beforeGridCamera, 'Grid Off preserves the drawing camera');
  assert.deepEqual(await state(), beforeSketch);
  assert.deepEqual(await physicalSceneIdentity(), beforeGridScene);
  await setSketchGrid(true);
  assert.equal(requests, beforeGridRequests, 'Sketch grid changes never reload model resources.');
  const sketchGridTheme = await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme'),
  );
  try {
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (theme) => document.documentElement.setAttribute('data-theme', theme),
        theme,
      );
      await page.waitForFunction(
        (theme) => document.querySelector('.pcb-model-preview').dataset.modelTheme === theme,
        theme,
      );
      await preview.screenshot({ path: `test-results/model-sketch-grid-${theme}.png` });
    }
  } finally {
    await page.evaluate((theme) => {
      if (theme === null) document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', theme);
    }, sketchGridTheme);
  }
  assert.equal(
    await sketchPanel.getByRole('button', { name: 'Change plane', exact: true }).count(),
    0,
  );
  assert.equal(await button('Finish sketch').isEnabled(), true);
  await preview.screenshot({ path: 'test-results/model-sketch-flow-sketch.png' });
  await button('Finish sketch').click();
  await waitSketchPhase('profile');
  await waitSketchGrid(false);
  await profilePanel.waitFor();
  await assertSketchCameraRestored(
    beforeSketchCamera,
    'Finish sketch returns to the previous 3D camera',
  );
  assert.equal(await extrude.count(), 0, 'Finish sketch does not automatically start extrusion.');
  assert.equal(await previewMeshCount(), 0, 'A finished profile has no unsolicited solid preview.');
  const finishedContour = await contourGeometry();
  assert.ok(finishedContour.length > 0, 'The finished sketch keeps its visible outline in 3D.');
  assert.deepEqual(
    await state(),
    beforeSketch,
    'Finishing a profile creates no solid or undo edit.',
  );
  assert.equal(
    await toolbar.getByRole('button', { name: 'Draw rectangle', exact: true }).count(),
    0,
  );
  assert.equal(
    await conversionTools.getByRole('button', { name: 'Extrude sketch', exact: true }).isEnabled(),
    true,
  );
  await preview.screenshot({ path: 'test-results/model-sketch-flow-profile.png' });
  if (sketchPlaneOnly) {
    await conversionTools
      .getByRole('button', { name: 'Extrude sketch', exact: true })
      .press('Enter');
    await waitSketchPhase('extrude');
    assert.equal(await button('Extrude sketch').getAttribute('aria-pressed'), 'true');
    await extrude.getByRole('button', { name: 'Cancel', exact: true }).click();
    await waitSketchPhase('profile');
    await profilePanel.getByRole('button', { name: 'Discard sketch', exact: true }).click();
    await assertSketchCameraRestored(
      beforeSketchCamera,
      'Discarding a profile restores the camera',
    );
    assert.deepEqual(await state(), beforeSketch);
    if (colorOnly) {
      await clickSolid(first.id, { x: 5, y: 0, z: null });
      await inspector.waitFor();
      const beforeColor = await state();
      const target = (await solids()).find((body) => body.id === first.id);
      const picker = inspector.getByLabel('Solid color', { exact: true });
      const resetColor = inspector.getByRole('button', { name: 'Use material color', exact: true });
      const defaultColor = `#${modelCadColor(target).toString(16).padStart(6, '0')}`;
      assert.equal(await picker.inputValue(), defaultColor);
      assert.equal(await resetColor.isDisabled(), true);
      await picker.fill('#e06445');
      await page.waitForFunction(() => {
        let colored = false;
        window.scene.traverseVisible((node) => {
          if (
            node.isMesh &&
            node.userData.modelCadPreview &&
            node.material.color.getHexString() === 'e06445'
          )
            colored = true;
        });
        return colored;
      });
      assert.deepEqual(await state(), beforeColor, 'Color preview creates no native edit.');
      await picker.dispatchEvent('compositionstart');
      await resetColor.press('Enter');
      assert.equal(await picker.inputValue(), '#e06445', 'IME cannot reset the color draft.');
      await picker.dispatchEvent('compositionend');
      await rightToggle.click();
      await rightToggle.click();
      assert.equal(await picker.inputValue(), '#e06445', 'Color drafts survive hidden Properties.');
      await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
      await page.waitForFunction(
        (id) =>
          window.cad.state().modelCad.objects.find((body) => body.id === id)?.color === '#e06445',
        first.id,
      );
      assert.equal((await state()).undoDepth, beforeColor.undoDepth + 1);
      assert.equal((await state()).pcb, beforeColor.pcb);
      const themeBeforeColor = await page.evaluate(() =>
        document.documentElement.getAttribute('data-theme'),
      );
      for (const theme of ['light', 'dark']) {
        await page.evaluate(
          (theme) => document.documentElement.setAttribute('data-theme', theme),
          theme,
        );
        await page.waitForFunction(
          (theme) => document.querySelector('.pcb-model-preview').dataset.modelTheme === theme,
          theme,
        );
        await preview.screenshot({ path: `test-results/model-color-properties-${theme}.png` });
      }
      await page.evaluate((theme) => {
        if (theme === null) document.documentElement.removeAttribute('data-theme');
        else document.documentElement.setAttribute('data-theme', theme);
      }, themeBeforeColor);
      await button('Undo').click();
      await page.waitForFunction(
        (id) =>
          window.cad.state().modelCad.objects.find((body) => body.id === id)?.color === undefined,
        first.id,
      );
      await button('Redo').click();
      await page.waitForFunction(
        (id) =>
          window.cad.state().modelCad.objects.find((body) => body.id === id)?.color === '#e06445',
        first.id,
      );
      await clickSolid(first.id, { x: 5, y: 0, z: null });
      await resetColor.click();
      assert.equal(await picker.inputValue(), defaultColor);
      assert.equal(
        (await solids()).find((body) => body.id === first.id).color,
        '#e06445',
        'Reset remains a draft until Apply.',
      );
      await inspector.getByRole('button', { name: 'Apply', exact: true }).click();
      await page.waitForFunction(
        (id) =>
          window.cad.state().modelCad.objects.find((body) => body.id === id)?.color === undefined,
        first.id,
      );
      assert.equal(
        (await state()).source,
        beforeColor.source,
        'Reset restores the original native design.',
      );
      console.log(
        'PASS: editable per-solid color, live preview, retained drafts/IME guards, Apply/undo/redo, material-color reset and unchanged PCB (isolated browser).',
      );
    }
    assert.deepEqual(errors, []);
    console.log(
      'PASS: grouped 3D primitives/2D drawing/conversion/modifications, conversion availability and keyboard activation, live workplanes, distant-plane alignment/clipping, draft/IME guards, grid isolation and retained camera/native state (isolated browser).',
    );
    throw sketchPlaneComplete;
  }
  const profileCamera = await sketchCameraState();
  await canvas.hover();
  await page.mouse.wheel(0, -120);
  await page.waitForFunction(
    (previous) =>
      Math.abs(window.camera.zoom - previous.zoom) > 1e-6 ||
      window.camera.position
        .toArray()
        .some((value, index) => Math.abs(value - previous.position[index]) > 1e-6),
    profileCamera,
  );
  await settleSketchCamera();
  assert.deepEqual(
    await contourGeometry(),
    finishedContour,
    '3D profile navigation does not edit the contour.',
  );
  await button('Extrude sketch').click();
  await waitSketchPhase('extrude');
  await waitSketchGrid(false);
  await extrude.waitFor();
  await extrude.getByLabel('Extrusion distance (mm)', { exact: true }).fill('-');
  assert.equal(
    await extrude.getByRole('button', { name: 'Apply', exact: true }).isDisabled(),
    true,
  );
  const beforeEditSketchCamera = await sketchCameraState();
  await extrude.getByRole('button', { name: 'Edit sketch', exact: true }).click();
  await waitSketchPhase('sketch');
  assert.equal(
    await button('Finish sketch').isEnabled(),
    true,
    'An invalid extrusion distance cannot prevent finishing an otherwise valid sketch.',
  );
  await button('Finish sketch').click();
  await waitSketchPhase('profile');
  await assertSketchCameraRestored(
    beforeEditSketchCamera,
    'Finishing an edited profile restores its current 3D camera',
  );
  assert.deepEqual(await contourGeometry(), finishedContour);
  assert.equal(await extrude.count(), 0);
  await button('Extrude sketch').click();
  await waitSketchPhase('extrude');
  await extrude.getByLabel('Extrusion distance (mm)', { exact: true }).fill('6');
  await extrude.getByRole('button', { name: 'Cancel', exact: true }).click();
  await waitSketchPhase('profile');
  await profilePanel.waitFor();
  assert.deepEqual(
    await contourGeometry(),
    finishedContour,
    'Cancelling extrusion preserves the completed sketch.',
  );
  await page.waitForFunction(() => {
    let previews = 0;
    window.scene.traverse((node) => {
      if (node.userData.modelCadPreview && node.isMesh) previews++;
    });
    return previews === 0;
  });
  assert.equal(await previewMeshCount(), 0);
  assert.deepEqual(await state(), beforeSketch, 'Extrusion cancellation creates no design edit.');
  await profilePanel.getByRole('button', { name: 'Edit sketch', exact: true }).click();
  await waitSketchPhase('sketch');
  assert.deepEqual(await contourGeometry(), finishedContour);
  await button('Finish sketch').click();
  await waitSketchPhase('profile');
  await button('Extrude sketch').click();
  await waitSketchPhase('extrude');
  await extrude.getByLabel('Extrusion distance (mm)', { exact: true }).fill('6');
  const extrusionCamera = await sketchCameraState();
  await canvas.hover();
  await page.mouse.wheel(0, 120);
  await page.waitForFunction(
    (previous) =>
      Math.abs(window.camera.zoom - previous.zoom) > 1e-6 ||
      window.camera.position
        .toArray()
        .some((value, index) => Math.abs(value - previous.position[index]) > 1e-6),
    extrusionCamera,
  );
  await settleSketchCamera();
  assert.deepEqual(
    await contourGeometry(),
    finishedContour,
    '3D extrusion navigation does not edit the contour.',
  );
  for (const composition of [{ isComposing: true }, { keyCode: 229 }])
    await extrude
      .getByLabel('Extrusion distance (mm)', { exact: true })
      .dispatchEvent('keydown', { key: 'Enter', ...composition });
  assert.deepEqual(await state(), beforeSketch, 'IME Enter cannot commit an extrusion.');
  await page.waitForFunction(() => {
    let ready = false;
    window.scene.traverse((node) => {
      if (node.userData.modelCadPreview && node.isMesh) ready = true;
    });
    return ready;
  });
  await preview.screenshot({ path: 'test-results/model-sketch-flow-extrude.png' });
  await extrude.getByRole('button', { name: 'Apply', exact: true }).click();
  await waitObjects(beforeSketchCount + 1);
  const extrusion = (await solids()).find((body) => body.kind === 'extrusion');
  assert.deepEqual(extrusion.profile, { kind: 'rectangle' });
  assert.deepEqual(extrusion.size, { x: 16, y: 16, z: 6 });
  assert.deepEqual(extrusion.position, { x: 50, y: 38, z: sketchPlaneOffset + 3 });
  assert.equal((await state()).undoDepth, beforeSketch.undoDepth + 1);
  assert.equal((await state()).revision, beforeSketch.revision + 1);
  assert.equal((await state()).pcb, beforeSketch.pcb);
  if (sketchInputOnly) {
    await button('Undo').click();
    await waitObjects(beforeSketchCount);
    assert.equal((await state()).source, beforeSketch.source);
    assert.deepEqual(
      await page.evaluate(() => window.cad.core.getNativeFiles()),
      beforeSketchNative,
      'Undo restores exact native files.',
    );
    assert.equal((await state()).pcb, beforeSketch.pcb);
    assert.deepEqual(errors, []);
    console.log(
      'PASS: zero-offset rectangle/circle click and drag drawing, live anchors, incomplete profiles, Escape/IME guards, extrusion Apply and exact native undo (isolated browser).',
    );
    throw sketchPlaneComplete;
  }
  await inspector.waitFor();
  await selectModelView(page, 'Top view');
  const beforeTopologyFilters = await state();
  const topologyNames = ['Solids', 'Faces', 'Edges', 'Lines'];
  await openDisplayDrawer(page, 'Selection');
  const topologyFilters = page.getByRole('group', { name: 'Selection', exact: true });
  assert.deepEqual(
    await topologyFilters
      .getByRole('checkbox')
      .evaluateAll((inputs) => inputs.map((input) => input.getAttribute('aria-label'))),
    ['All items', ...topologyNames],
  );
  for (const name of ['All items', ...topologyNames])
    assert.equal(
      await topologyFilters.getByRole('checkbox', { name, exact: true }).isChecked(),
      true,
    );
  await topologyFilters.screenshot({ path: 'test-results/model-selection-cad-filters.png' });
  await page.keyboard.press('Escape');
  const onlyTopology = async (name) => {
    await setModelSelectionCategories(page, [name]);
    await openDisplayDrawer(page, 'Selection');
    assert.equal(
      await topologyFilters
        .getByRole('checkbox', { name: 'All items', exact: true })
        .evaluate((input) => input.indeterminate),
      true,
      'The master checkbox is mixed across the four topology categories.',
    );
    await page.keyboard.press('Escape');
  };
  await setModelSelectionCategories(page, ['Solids', 'Lines']);
  await clickSolid(cylinder.id);
  await inspector.waitFor();
  for (const name of ['Fillet edges', 'Chamfer edges'])
    assert.equal(
      !(await modelToolAvailable(page, name)),
      true,
      'A whole cylinder has no eligible straight edge when only Lines are available.',
    );
  assert.deepEqual(
    await state(),
    beforeTopologyFilters,
    'Inspecting a cylinder with circular rims excluded does not change native data or undo.',
  );
  for (const [name, kind, label, local] of [
    ['Faces', 'Face', 'Top face', { x: 0, y: 0, z: extrusion.size.z / 2 }],
    ['Solids', null, null, { x: 0, y: 0, z: extrusion.size.z / 2 }],
    ['Edges', 'Edge', 'Top edge 1', { x: 0, y: -extrusion.size.y / 2, z: extrusion.size.z / 2 }],
    ['Lines', 'Line', 'Top edge 1', { x: 0, y: -extrusion.size.y / 2, z: extrusion.size.z / 2 }],
  ]) {
    await button('Interaction mode').click();
    await onlyTopology(name);
    if (name === 'Lines') {
      await clickSolid(cylinder.id, { x: cylinder.size.x / 2, y: 0, z: cylinder.size.z / 2 });
      assert.equal(
        await canvas.getAttribute('data-cad-selection-count'),
        '0',
        'Lines-only automatic picking ignores circular rims.',
      );
    }
    await clickSolid(extrusion.id, local);
    if (kind)
      await page
        .getByRole('region', { name: `${kind} properties`, exact: true })
        .getByText(label, { exact: true })
        .waitFor();
    else await inspector.waitFor();
    assert.equal(
      await canvas.getAttribute('data-cad-selection-count'),
      '1',
      `${name}-only filters select that topology through automatic interaction.`,
    );
    await setModelFilter(name, false);
    await page.waitForFunction(
      () => document.querySelector('.pcb-model-canvas').dataset.cadSelectionCount === '0',
    );
    await canvas.focus();
    for (const key of ['Delete', 'r', 'm']) await page.keyboard.press(key);
    assert.deepEqual(
      await state(),
      beforeTopologyFilters,
      'Filtering out selected topology clears it without native edits, undo or solid shortcuts.',
    );
  }
  await onlyTopology('Faces');
  await clickSolid(extrusion.id, { x: 0, y: 0, z: extrusion.size.z / 2 });
  await setModelFilter('Faces', false);
  await page.waitForFunction(
    () => document.querySelector('.pcb-model-canvas').dataset.cadSelectionCount === '0',
  );
  assert.equal(
    await canvas.getAttribute('data-cad-selection-count'),
    '0',
    'Disabling Faces clears the selected face without retaining a separate picking mode.',
  );
  await onlyTopology('Solids');
  await clickSolid(extrusion.id, { x: 0, y: 0, z: extrusion.size.z / 2 });
  await chooseModelTool(page, 'Move solid');
  await page.getByRole('complementary', { name: 'Move solid settings', exact: true }).waitFor();
  await setModelFilter('Solids', false);
  await page.waitForFunction(
    () => document.querySelector('.pcb-model-canvas').dataset.cadTool === 'select',
  );
  assert.deepEqual(
    await state(),
    beforeTopologyFilters,
    'Filter changes cancel an ineligible move without committing its preview.',
  );
  await setModelFilter('All items', true);
  await button('Interaction mode').click();
  const beforeTypedSelection = await state();
  for (const [category, kind, label, local] of [
    ['Faces', 'Face', 'Top face', { x: 0, y: 0, z: extrusion.size.z / 2 }],
    ['Edges', 'Edge', 'Top edge 1', { x: 0, y: -extrusion.size.y / 2, z: extrusion.size.z / 2 }],
    ['Lines', 'Line', 'Top edge 1', { x: 0, y: -extrusion.size.y / 2, z: extrusion.size.z / 2 }],
  ]) {
    await setModelSelectionCategories(page, [category]);
    await clickSolid(extrusion.id, local);
    const properties = page.getByRole('region', { name: `${kind} properties`, exact: true });
    await properties.getByText(label, { exact: true }).waitFor();
    assert.equal(await inspector.isVisible(), false, `${kind} has its own Properties.`);
    for (const action of ['Move solid', 'Rotate solid 90°', 'Duplicate solid', 'Delete solid'])
      assert.equal(
        !(await modelToolAvailable(page, action)),
        true,
        `${kind} selection does not select its owning solid implicitly.`,
      );
    await setModelSelectionCategories(page, ['Solids', category]);
    await chooseModelTool(page, 'Boolean solids');
    const blockedBoolean = page.getByRole('complementary', {
      name: 'Boolean settings',
      exact: true,
    });
    await blockedBoolean
      .getByText(
        'Solid Boolean operations require two solids. Faces, edges and lines are not solid operands.',
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await blockedBoolean.getByRole('button', { name: 'Apply', exact: true }).isDisabled(),
      true,
    );
    assert.equal(
      await blockedBoolean
        .getByRole('button', { name: 'Remove Boolean target', exact: true })
        .count(),
      0,
    );
    assert.equal(
      await blockedBoolean
        .getByRole('button', { name: 'Remove Boolean tool', exact: true })
        .count(),
      0,
    );
    if (kind === 'Face') {
      await blockedBoolean.getByRole('button', { name: 'Use owning solids', exact: true }).click();
      await blockedBoolean
        .getByRole('button', { name: 'Remove Boolean target', exact: true })
        .waitFor();
      assert.equal(
        await blockedBoolean
          .getByRole('button', { name: 'Remove Boolean tool', exact: true })
          .count(),
        0,
      );
      assert.equal(
        await blockedBoolean.getByRole('button', { name: 'Apply', exact: true }).isDisabled(),
        true,
        'Explicitly using one face owner still requires a second solid.',
      );
    }
    assert.deepEqual(
      await state(),
      beforeTypedSelection,
      'Typed selection and owner conversion are presentation only.',
    );
    await blockedBoolean.getByRole('button', { name: 'Cancel', exact: true }).click();
  }
  await setModelSelectionCategories(page, ['Lines']);
  await clickSolid(cylinder.id, { x: cylinder.size.x / 2, y: 0, z: cylinder.size.z / 2 });
  assert.equal(
    await canvas.getAttribute('data-cad-selection-count'),
    '0',
    'Line selection excludes a circular cylinder rim.',
  );
  await clickSolid(extrusion.id, { x: 0, y: -extrusion.size.y / 2, z: extrusion.size.z / 2 });
  await page
    .getByRole('region', { name: 'Line properties', exact: true })
    .getByText('Top edge 1', { exact: true })
    .waitFor();
  assert.deepEqual(await state(), beforeTypedSelection);
  const beforeEdgeSelection = await state();
  await setModelSelectionCategories(page, topologyNames);
  await button('Interaction mode').click();
  await inspector.waitFor({ state: 'hidden' });
  await clickSolid(extrusion.id, { x: 0, y: -extrusion.size.y / 2, z: extrusion.size.z / 2 });
  const edgeProperties = page.getByRole('region', { name: 'Edge properties', exact: true });
  await edgeProperties.getByText('Top edge 1', { exact: true }).waitFor();
  await page.waitForFunction(
    () => document.querySelector('.pcb-model-canvas').dataset.cadSelectedEdges === '1',
  );
  assert.equal(await inspector.isVisible(), false, 'Edge inspection replaces solid Properties.');
  for (const label of ['Move solid', 'Rotate solid 90°', 'Duplicate solid', 'Delete solid'])
    assert.equal(
      !(await modelToolAvailable(page, label)),
      true,
      'Edge selection cannot edit the parent solid implicitly.',
    );
  await page.keyboard.press('Delete');
  await page.keyboard.press('r');
  await page.keyboard.press('m');
  assert.deepEqual(
    await state(),
    beforeEdgeSelection,
    'Solid shortcuts do not act on selected edges.',
  );
  await page.keyboard.down('Shift');
  try {
    await clickSolid(extrusion.id, { x: extrusion.size.x / 2, y: 0, z: extrusion.size.z / 2 });
  } finally {
    await page.keyboard.up('Shift');
  }
  await edgeProperties.getByText('Top edge 2', { exact: true }).waitFor();
  await page.waitForFunction(
    () => document.querySelector('.pcb-model-canvas').dataset.cadSelectedEdges === '2',
  );
  await page.keyboard.down('Shift');
  try {
    await clickSolid(extrusion.id, { x: extrusion.size.x / 2, y: 0, z: extrusion.size.z / 2 });
  } finally {
    await page.keyboard.up('Shift');
  }
  await edgeProperties.getByText('Top edge 2', { exact: true }).waitFor({ state: 'hidden' });
  await page.waitForFunction(
    () => document.querySelector('.pcb-model-canvas').dataset.cadSelectedEdges === '1',
  );
  assert.deepEqual(
    await state(),
    beforeEdgeSelection,
    'Normal edge preselection changes no document or undo state.',
  );
  await page.keyboard.down('Shift');
  try {
    await clickSolid(extrusion.id, { x: 0, y: -extrusion.size.y / 2, z: extrusion.size.z / 2 });
  } finally {
    await page.keyboard.up('Shift');
  }
  assert.equal(await canvas.getAttribute('data-cad-selection-count'), '0');
  assert.equal(
    await inspector.isVisible(),
    false,
    'Deselecting the last edge does not promote its solid.',
  );
  await clickSolid(extrusion.id, { x: 0, y: -extrusion.size.y / 2, z: extrusion.size.z / 2 });
  await edgeProperties.getByText('Top edge 1', { exact: true }).waitFor();
  await chooseModelTool(page, 'Fillet edges');
  const preselectedFillet = page.getByRole('complementary', {
    name: 'Fillet settings',
    exact: true,
  });
  await preselectedFillet.getByRole('button', { name: 'Remove Top edge 1', exact: true }).waitFor();
  assert.equal(
    await preselectedFillet.getByRole('button', { name: 'Apply', exact: true }).isDisabled(),
    false,
    'Fillet carries the edge selected before starting the command.',
  );
  await preselectedFillet.getByRole('button', { name: 'Cancel', exact: true }).click();
  await inspector.waitFor();
  assert.deepEqual(
    await state(),
    beforeEdgeSelection,
    'Cancelling a preselected fillet retains the exact committed solid.',
  );
  await clickSolid(cylinder.id);
  await inspector.waitFor();
  assert.equal(
    await inspector.getByLabel('Solid name', { exact: true }).inputValue(),
    cylinder.name,
    'Cancelling an edge treatment restores picking of enabled solids.',
  );
  await clickSolid(extrusion.id, { x: 0, y: -extrusion.size.y / 2, z: extrusion.size.z / 2 });
  await edgeProperties.getByText('Top edge 1', { exact: true }).waitFor();
  await clickSolid(extrusion.id, { x: -6, y: -5, z: extrusion.size.z / 2 });
  await inspector.waitFor();
  assert.equal(
    await inspector.getByLabel('Solid name', { exact: true }).inputValue(),
    extrusion.name,
    'Chamfer starts from the exposed extrusion body, not an overlapping solid.',
  );
  assert.deepEqual(
    await state(),
    beforeEdgeSelection,
    'Enabled edges and solids remain selectable together after cancelling a treatment.',
  );
  const beforeChamfer = await state();
  await chooseModelTool(page, 'Chamfer edges');
  const chamfer = page.getByRole('complementary', { name: 'Chamfer settings', exact: true });
  assert.deepEqual(
    await chamfer
      .getByRole('combobox')
      .evaluateAll((controls) => controls.map((control) => control.getAttribute('aria-label'))),
    ['Chamfer distance (mm) unit'],
    'Only the quantity unit uses a menu; edges are picked on the solid.',
  );
  assert.equal(
    await chamfer.getByRole('button', { name: 'Apply', exact: true }).isDisabled(),
    true,
  );
  await chamfer.getByText('Select edges on the solid.', { exact: true }).waitFor();
  await chamfer.getByLabel('Chamfer distance (mm)', { exact: true }).fill('0.75');
  await clickSolid(extrusion.id, { x: 0, y: -extrusion.size.y / 2, z: extrusion.size.z / 2 });
  await chamfer.getByRole('button', { name: 'Remove Top edge 1', exact: true }).waitFor();
  await chamfer.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.waitForFunction(
    (id) =>
      window.cad.state().modelCad.objects.find((body) => body.id === id)?.edgeTreatment?.kind ===
      'chamfer',
    extrusion.id,
  );
  assert.deepEqual((await solids()).find((body) => body.id === extrusion.id).edgeTreatment, {
    kind: 'chamfer',
    distanceMm: 0.75,
    edges: ['profile:top:0'],
  });
  assert.equal((await state()).undoDepth, beforeChamfer.undoDepth + 1);
  const afterChamfer = await state();
  await clickSolid(cylinder.id, { x: cylinder.size.x / 2, y: 0, z: cylinder.size.z / 2 });
  await edgeProperties.waitFor();
  await clickSolid(extrusion.id, { x: -6, y: -5, z: extrusion.size.z / 2 });
  await inspector.waitFor();
  assert.equal(
    await inspector.getByLabel('Solid name', { exact: true }).inputValue(),
    extrusion.name,
    'Completing an edge treatment restores picking of enabled solids.',
  );
  assert.deepEqual(
    await state(),
    afterChamfer,
    'Enabled edges and solids remain selectable together after applying a treatment.',
  );
  await chooseModelTool(page, 'Fillet edges');
  const fillet = page.getByRole('complementary', { name: 'Fillet settings', exact: true });
  await fillet.getByRole('button', { name: 'Clear selection', exact: true }).click();
  assert.equal(await fillet.getByRole('button', { name: 'Apply', exact: true }).isDisabled(), true);
  await clickSolid(extrusion.id, { x: 0, y: -extrusion.size.y / 2, z: extrusion.size.z / 2 });
  await fillet.getByRole('button', { name: 'Remove Top edge 1', exact: true }).waitFor();
  await fillet.getByLabel('Fillet radius (mm)', { exact: true }).fill('0.5');
  await fillet.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.waitForFunction(
    (id) =>
      window.cad.state().modelCad.objects.find((body) => body.id === id)?.edgeTreatment?.kind ===
      'fillet',
    extrusion.id,
  );
  await chooseModelTool(page, 'Duplicate solid');
  await waitObjects(beforeSketchCount + 2);
  const tool = (await solids()).find(
    (body) => body.kind === 'extrusion' && body.id !== extrusion.id,
  );
  const beforeBoolean = await state();
  await setModelSelectionCategories(page, ['Solids']);
  await clickSolid(extrusion.id, { x: -6, y: -5, z: extrusion.size.z / 2 });
  await page.keyboard.down('Shift');
  try {
    await clickSolid(tool.id, { x: 6, y: 5, z: tool.size.z / 2 });
  } finally {
    await page.keyboard.up('Shift');
  }
  assert.equal(await canvas.getAttribute('data-cad-selection-count'), '2');
  assert.equal(
    await inspector.isVisible(),
    false,
    'Two solids do not expose one-solid Properties.',
  );
  await chooseModelTool(page, 'Boolean solids');
  const boolean = page.getByRole('complementary', { name: 'Boolean settings', exact: true });
  assert.equal(
    await boolean.getByRole('combobox').count(),
    1,
    'Only the operation uses a menu; operands are selected on the canvas.',
  );
  await boolean.getByRole('button', { name: 'Remove Boolean target', exact: true }).waitFor();
  await boolean.getByRole('button', { name: 'Remove Boolean tool', exact: true }).waitFor();
  await boolean.getByRole('button', { name: 'Remove Boolean tool', exact: true }).click();
  await boolean.getByRole('button', { name: 'Remove Boolean target', exact: true }).click();
  assert.equal(
    await boolean.getByRole('button', { name: 'Apply', exact: true }).isDisabled(),
    true,
  );
  await clickSolid(extrusion.id, { x: -6, y: -5, z: extrusion.size.z / 2 });
  await boolean.getByRole('button', { name: 'Remove Boolean target', exact: true }).waitFor();
  assert.equal(
    await boolean.getByRole('button', { name: 'Remove Boolean tool', exact: true }).count(),
    0,
  );
  assert.equal(
    await boolean.getByRole('button', { name: 'Apply', exact: true }).isDisabled(),
    true,
  );
  await clickSolid(tool.id, { x: 6, y: 5, z: tool.size.z / 2 });
  await boolean.getByRole('button', { name: 'Remove Boolean tool', exact: true }).waitFor();
  const waitOperandGhost = async (id) =>
    page.waitForFunction((id) => {
      let visible = false;
      window.scene.traverse((node) => {
        if (!node.isMesh || !node.userData.modelCadOperandGhost || node.userData.modelCadId !== id)
          return;
        let shown = true;
        for (let ancestor = node; ancestor; ancestor = ancestor.parent) shown &&= ancestor.visible;
        visible ||= shown;
      });
      return visible;
    }, id);
  await waitOperandGhost(tool.id);
  await clickSolid(tool.id, { x: 6, y: 5, z: tool.size.z / 2 });
  assert.equal(await canvas.getAttribute('data-cad-selection-count'), '1');
  assert.equal(
    await boolean.getByRole('button', { name: 'Apply', exact: true }).isDisabled(),
    true,
    'Clicking an operand ghost deselects its actual source solid.',
  );
  await clickSolid(tool.id, { x: 6, y: 5, z: tool.size.z / 2 });
  await waitOperandGhost(tool.id);
  await clickSolid(cylinder.id, { x: 0, y: 0, z: cylinder.size.z / 2 });
  assert.equal(await canvas.getAttribute('data-cad-selection-count'), '2');
  assert.deepEqual(
    await boolean
      .getByRole('region', { name: 'Boolean operands', exact: true })
      .locator('dd > span')
      .allTextContents(),
    [extrusion.name, cylinder.name],
    'A third canvas solid replaces Tool while retaining the first Target.',
  );
  await waitOperandGhost(cylinder.id);
  await clickSolid(cylinder.id, { x: 0, y: 0, z: cylinder.size.z / 2 });
  assert.equal(await canvas.getAttribute('data-cad-selection-count'), '1');
  await clickSolid(tool.id, { x: 6, y: 5, z: tool.size.z / 2 });
  await boolean.getByRole('button', { name: 'Remove Boolean tool', exact: true }).waitFor();
  await boolean.getByRole('button', { name: 'Swap operands', exact: true }).click();
  await boolean.getByRole('button', { name: 'Swap operands', exact: true }).click();
  assert.deepEqual(
    await state(),
    beforeBoolean,
    'Canvas operand selection and swapping do not mutate the design.',
  );
  await boolean.getByRole('button', { name: 'Apply', exact: true }).click();
  await waitObjects(beforeSketchCount + 1);
  const result = (await solids()).find((body) => body.kind === 'boolean');
  assert.equal(result.boolean.operation, 'union');
  assert.ok(!(await solids()).some((body) => body.id === extrusion.id || body.id === tool.id));
  assert.equal(
    (await state()).undoDepth,
    beforeBoolean.undoDepth + 1,
    'Boolean replaces both operands in one undo edit.',
  );
  await inspector.waitFor();
  assert.equal(
    await inspector.getByLabel('Length (mm)', { exact: true }).count(),
    0,
    'Boolean envelope dimensions are read-only.',
  );
  await button('Undo').click();
  await waitObjects(beforeSketchCount + 2);
  await button('Redo').click();
  await waitObjects(beforeSketchCount + 1);
  assert.equal((await state()).pcb, initial.pcb);
  assert.equal(
    await page.evaluate(
      () => document.querySelector('.pcb-model-canvas canvas') === window.originalCanvas,
    ),
    true,
  );
  await preview.screenshot({ path: 'test-results/model-cad-shared-sketch-ui.png' });
  assert.deepEqual(errors, []);
  console.log(
    'PASS: shared PCB-canvas draw/extrude/chamfer/fillet/Boolean controls, one-edit Core/undo semantics, docked properties/drafts, primitive edits and sketch cutouts, Source/IME guards, visible-only Fit, STEP and retained WebGL/caches (geometry service mocked).',
  );
} catch (cause) {
  if (cause !== sketchPlaneComplete) throw cause;
} finally {
  await browser.close();
}
