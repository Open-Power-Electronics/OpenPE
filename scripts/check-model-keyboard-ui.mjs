import assert from 'node:assert/strict';
import { modelToolAvailable } from './model-tool-test-helpers.mjs';
import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { selectModelView, selectModelVisualizationTab } from './visualization-test-helpers.mjs';

// Isolated Model renderer with real Core and WebGL, without Electron, project
// destinations, library requests, providers, solvers or a running user instance.
const { createProject } = await tsImport('../lib/project.ts', import.meta.url);
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const { newModelCadObject, withModelCad } = await tsImport('../lib/model-cad.ts', import.meta.url);
const source = createProject();
source.pcb = createEmptyPCB();
source.pcb.graphics = [
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
const body = newModelCadObject(source.pcb, 'box');
body.name = 'Mounting bracket';
body.size = { x: 20, y: 12, z: 8 };
body.position = { x: 50, y: 38, z: 12 };
body.holes = [{ id: randomUUID(), x: 4, y: 0, diameterMm: 3.2 }];
const project = withModelCad(source, { version: 1, objects: [body] });
const bundle = await build({
  stdin: {
    contents: `import React,{useState,useSyncExternalStore}from'react';
import{createRoot}from'react-dom/client';import*as THREE from'three';
import Preview from'./components/PCBModelPreview';import{ProjectCore}from'./core/project-core';
import{registerProjectCapabilities}from'./core/register-project';import{createCapabilityHost}from'./api/capabilities';
import{modelCadFromProject}from'./lib/model-cad';
const core=new ProjectCore(${JSON.stringify(project)}),host=createCapabilityHost({revision:()=>String(core.getSnapshot().revision)});
registerProjectCapabilities(host,core);window.THREE=THREE;
function Harness(){const snapshot=useSyncExternalStore(listener=>core.subscribe(listener),()=>core.getSnapshot());
const[active,setActive]=useState(true);window.modelKeys={core,host,setActive,state:()=>({revision:snapshot.revision,
undoDepth:snapshot.undoDepth,modelCad:modelCadFromProject(snapshot.project),pcb:JSON.stringify(snapshot.project.pcb)})};
return <div style={{height:'100vh'}}><Preview board={snapshot.project.pcb} schematic={snapshot.project.schematic}
modelCad={modelCadFromProject(snapshot.project)} revision={String(snapshot.revision)} capabilityHost={host}
undoDepth={snapshot.undoDepth} redoDepth={snapshot.redoDepth} sourcePending={snapshot.sourceDraft!==null} active={active}/></div>}
createRoot(document.getElementById('root')).render(<Harness/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outfile: 'test-results/model-keyboard-ui.js',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [
    {
      name: 'inspect-model-keyboard-scene',
      setup(plugin) {
        plugin.onLoad({ filter: /[\\/]useModelCadTools\.tsx$/ }, async ({ path: file }) => {
          const source = await readFile(file, 'utf8');
          const marker = '  const blocked = !host || !active || disabled || busy || annotating;';
          assert.ok(source.includes(marker));
          return {
            contents: source
              .replace(
                marker,
                marker +
                  '\n  window.modelKeyDebug={selected,object:object?.id,tool,blocked,staged,inspectorDirty,busy,active,disabled,annotating,revision,baseRevision:baseRevision.current};',
              )
              .replace(
                '  function move() {',
                '  function move() {window.modelKeyTrace??=[];window.modelKeyTrace.push({op:"move",blocked,object:object?.id,tool,staged,revision});',
              )
              .replace(
                '  const cancel = useCallback(() => {',
                '  const cancel = useCallback(() => {window.modelKeyTrace??=[];window.modelKeyTrace.push({op:"cancel",stack:new Error().stack});',
              )
              .replace(
                '    keyDown: (event: React.KeyboardEvent) => {',
                '    keyDown: (event: React.KeyboardEvent) => {window.modelHookKey={key:event.key,shift:event.shiftKey,repeat:event.repeat,object:object?.id,blocked,staged,tool,revision,baseRevision:baseRevision.current};',
              ),
            loader: 'tsx',
            resolveDir: path.dirname(file),
          };
        });
        plugin.onLoad({ filter: /[\\/]PCBModelPreview\.tsx$/ }, async ({ path: file }) => {
          const source = await readFile(file, 'utf8');
          const marker = 'renderer?.render(scene, camera);';
          assert.ok(source.includes(marker));
          return {
            contents: source
              .replace(
                marker,
                `window.modelScene=scene;window.modelCamera=camera;window.modelOrbit=orbit;${marker}
              const sample=window.pendingModelKeySample;
              if(sample?.start!==undefined){let matched=false;scene.traverse(node=>{
                if(node.userData.modelCadId===sample.id&&Boolean(node.userData.modelCadPreview)===sample.preview&&
                  (sample.x===undefined||Math.abs(node.position.x-sample.x)<1e-8)&&
                  (sample.rotation===undefined||Math.abs(node.rotation.z+sample.rotation*Math.PI/180)<1e-8))matched=true;
              });if(matched){window.modelKeyboardTimings.push({operation:sample.operation,ms:performance.now()-sample.start});
                window.pendingModelKeySample=null;}}`,
              )
              .replace(
                '            onKeyDown={(e) => {',
                '            onKeyDown={(e) => {window.modelCanvasKey={key:e.key,shift:e.shiftKey,alt:e.altKey,ctrl:e.ctrlKey,meta:e.metaKey,repeat:e.repeat,defaultPrevented:e.defaultPrevented,pointers:pressedPointers.current.size,overlay:hasOpenOverlay(),target:e.target.tagName,active};',
              )
              .replace(
                '      const raycaster = new THREE.Raycaster();',
                '      const raycaster = new THREE.Raycaster();window.modelPickRays=0;const cast=raycaster.intersectObject.bind(raycaster);raycaster.intersectObject=(...args)=>{window.modelPickRays++;return cast(...args);};',
              )
              .replace(
                '      fit.current = () => {',
                '      fit.current = () => {window.modelFitCalls=(window.modelFitCalls??0)+1;',
              ),
            loader: 'tsx',
            resolveDir: path.dirname(file),
          };
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
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.modelKeyboardTimings = [];
    document.addEventListener(
      'keydown',
      (event) => {
        const sample = window.pendingModelKeySample;
        if (sample && sample.start === undefined && event.key.toLowerCase() === sample.key)
          sample.start = performance.now();
      },
      true,
    );
  });
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
    await page.addStyleTag({ content: file.text });
  await page.addScriptTag({
    content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
  });
  const canvas = page.locator('.pcb-model-canvas');
  const button = (name) => page.getByRole('button', { name, exact: true });
  const state = () => page.evaluate(() => window.modelKeys.state());
  const solid = async () => (await state()).modelCad.objects.find((item) => item.id === body.id);
  const tool = () => canvas.getAttribute('data-cad-tool');
  const sampleNext = (operation, key, preview, extra = {}) =>
    page.evaluate(
      (sample) => {
        window.pendingModelKeySample = sample;
      },
      { operation, key, preview, id: body.id, ...extra },
    );
  const waitSample = (operation) =>
    page.waitForFunction(
      (operation) => window.modelKeyboardTimings.some((sample) => sample.operation === operation),
      operation,
    );
  const movePanel = page.getByRole('complementary', { name: 'Move solid settings', exact: true });
  const inspector = page.getByRole('complementary', {
    name: 'Solid properties settings',
    exact: true,
  });
  const frame = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  const cameraState = () =>
    page.evaluate(() => ({
      position: window.modelCamera.position.toArray(),
      quaternion: window.modelCamera.quaternion.toArray(),
      zoom: window.modelCamera.zoom,
    }));
  const orientationState = () =>
    page.evaluate(() => {
      const camera = window.modelCamera,
        target = window.modelOrbit.target;
      return {
        up: camera.up.toArray(),
        direction: camera.position.clone().sub(target).normalize().toArray(),
        quaternion: camera.quaternion.toArray(),
        target: target.toArray(),
        distance: camera.position.distanceTo(target),
        zoom: camera.zoom,
        orthographic: Boolean(camera.isOrthographicCamera),
      };
    });
  async function settleCamera() {
    await page.evaluate(async () => {
      let previous = '',
        stable = 0;
      for (let frame = 0; frame < 180 && stable < 3; frame++) {
        await new Promise(requestAnimationFrame);
        const camera = window.modelCamera;
        const current = [...camera.position.toArray(), ...camera.quaternion.toArray(), camera.zoom]
          .map((value) => value.toFixed(6))
          .join(':');
        stable = current === previous ? stable + 1 : 0;
        previous = current;
      }
    });
  }
  async function screenPoint(point) {
    return page.evaluate(({ x, y, z }) => {
      const rect = document.querySelector('.pcb-model-canvas canvas').getBoundingClientRect();
      const p = new window.THREE.Vector3(x, -y, z).project(window.modelCamera);
      return {
        x: rect.left + ((p.x + 1) * rect.width) / 2,
        y: rect.top + ((1 - p.y) * rect.height) / 2,
      };
    }, point);
  }
  async function selectBody() {
    const item = await solid();
    // Stay clear of the local through hole while picking the saved body.
    const point = await screenPoint({ ...item.position, z: item.position.z + item.size.z / 2 });
    await page.mouse.click(point.x, point.y);
    await inspector.waitFor();
    await canvas.focus();
  }
  async function movePointer(x, y) {
    const item = await solid();
    const point = await screenPoint({ x, y, z: item.position.z });
    await page.mouse.move(point.x, point.y);
    await frame();
  }
  await page.waitForFunction(
    () =>
      window.modelScene &&
      document.querySelector('.pcb-model-canvas canvas') &&
      !document.querySelector('.pcb-model-status'),
  );
  const sidebar = page.getByRole('complementary', { name: 'Model sidebar', exact: true });
  const drawerGeometry = () =>
    sidebar.evaluate((dock) => {
      const bounds = (element) => {
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      return {
        sidebar: bounds(dock),
        sections: ['Properties', 'Visualization', 'Selection'].map((label) => {
          const section = dock.querySelector(`.editor-display-drawer[aria-label="${label}"]`);
          return {
            label,
            expanded: section.dataset.expanded === 'true',
            section: bounds(section),
            header: bounds(section.querySelector('.editor-display-drawer-header')),
            body: bounds(section.querySelector('.editor-display-drawer-body')),
          };
        }),
      };
    });
  const assertDockBounds = (before, after) => {
    for (const axis of ['x', 'y', 'width', 'height'])
      assert.ok(
        Math.abs(after.sidebar[axis] - before.sidebar[axis]) <= 1,
        `Model sidebar ${axis} stays fixed while sections or CAD Properties change.`,
      );
    const collapsed = after.sections.filter((section) => !section.expanded);
    for (let index = 1; index < after.sections.length; index++)
      assert.ok(
        after.sections[index].header.y >=
          after.sections[index - 1].section.y + after.sections[index - 1].section.height - 1,
        'Model Properties, Visualization, Selection keep their order regardless of expansion.',
      );
    for (const section of after.sections.filter((section) => section.expanded))
      assert.ok(
        section.body.height > 24 && section.body.y >= section.header.y + section.header.height - 1,
        `Model ${section.label} keeps its header above its scrolling content.`,
      );
    for (const section of collapsed) {
      assert.ok(
        Math.abs(section.section.height - section.header.height) <= 1,
        `Collapsed Model ${section.label} reserves only its header.`,
      );
      assert.equal(
        section.body.height,
        0,
        `Collapsed Model ${section.label} hides its retained body.`,
      );
    }
    if (collapsed.length === after.sections.length) {
      const last = after.sections.at(-1);
      assert.ok(
        Math.abs(last.section.y + last.section.height - after.sidebar.y - after.sidebar.height) <=
          1,
        'The fully collapsed Model section stack remains at the sidebar bottom.',
      );
    }
  };
  const disclosures = ['Properties', 'Visualization', 'Selection'].map((name) =>
    sidebar.getByRole('button', { name, exact: true }),
  );
  for (const disclosure of disclosures)
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'true');
  const defaultDrawers = await drawerGeometry();
  assertDockBounds(defaultDrawers, defaultDrawers);
  for (const mask of [7, 6, 4, 5, 1, 0, 2, 3, 7]) {
    for (let index = 0; index < disclosures.length; index++) {
      const expected = Boolean(mask & (1 << index));
      if (((await disclosures[index].getAttribute('aria-expanded')) === 'true') !== expected)
        await disclosures[index].click();
    }
    assertDockBounds(defaultDrawers, await drawerGeometry());
  }
  const beforeSpaceFit = await state();
  const fitCalls = () => page.evaluate(() => window.modelFitCalls);
  const assertSameCamera = (actual, expected, message) => {
    for (const field of ['position', 'quaternion', 'zoom']) {
      const values = Array.isArray(actual[field]) ? actual[field] : [actual[field]];
      const reference = Array.isArray(expected[field]) ? expected[field] : [expected[field]];
      assert.ok(
        values.every((value, index) => Math.abs(value - reference[index]) < 1e-6),
        `${message}: ${field}`,
      );
    }
  };
  const assertSameTarget = (actual, expected, message) => {
    assert.ok(
      actual.every((value, axis) => Math.abs(value - expected[axis]) < 1e-6),
      message,
    );
  };
  const assertIsometric = (actual, expected, message) => {
    const direction = [1, -1, 1].map((value) => value / Math.sqrt(3));
    assert.deepEqual(actual.up, [0, 0, 1], `${message}: native Z remains up`);
    assert.ok(
      actual.direction.every((value, axis) => Math.abs(value - direction[axis]) < 1e-6),
      `${message}: camera faces the equal-axis isometric direction`,
    );
    const dot = actual.quaternion.reduce(
      (sum, value, axis) => sum + value * expected.quaternion[axis],
      0,
    );
    assert.ok(Math.abs(Math.abs(dot) - 1) < 1e-6, `${message}: orientation has no residual roll`);
    assert.equal(actual.orthographic, expected.orthographic, `${message}: projection is retained`);
  };
  async function rotateCamera() {
    const bounds = await canvas.boundingBox();
    await page.mouse.move(bounds.x + bounds.width * 0.75, bounds.y + bounds.height * 0.65);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * 0.82, bounds.y + bounds.height * 0.56, {
      steps: 5,
    });
    await page.mouse.up();
  }
  for (const orthographic of [true, false]) {
    const views = await selectModelVisualizationTab(page, 'Views');
    const projection = views.getByRole('button', { name: 'Orthographic projection', exact: true });
    if (((await projection.getAttribute('aria-pressed')) === 'true') !== orthographic)
      await projection.click();
    await button('Fit 3D board').click();
    await settleCamera();
    const expected = await cameraState();
    const bounds = await canvas.boundingBox();
    await page.mouse.move(bounds.x + bounds.width * 0.8, bounds.y + bounds.height * 0.8);
    await canvas.focus();
    await page.mouse.wheel(0, -300);
    await settleCamera();
    assert.notDeepEqual(await cameraState(), expected, 'Wheel navigation leaves the fitted view.');
    const beforeFitCalls = await fitCalls();
    await page.keyboard.press('Space');
    await settleCamera();
    assert.equal(await fitCalls(), beforeFitCalls + 1, 'Space invokes Fit exactly once.');
    assertSameCamera(
      await cameraState(),
      expected,
      `${orthographic ? 'Orthographic' : 'Perspective'} Space matches the Fit button`,
    );
    const fittedOrientation = await orientationState();
    await selectModelView(page, 'Isometric view');
    await settleCamera();
    assertIsometric(
      await orientationState(),
      fittedOrientation,
      'Space and Isometric view share one orientation',
    );
    for (const name of ['Top view', 'Bottom view', 'Front view', 'Left view']) {
      await selectModelView(page, name);
      await settleCamera();
      const beforePreset = await orientationState();
      await selectModelView(page, 'Isometric view');
      await settleCamera();
      const preset = await orientationState();
      assertIsometric(preset, fittedOrientation, `Isometric after ${name}`);
      assertSameTarget(
        preset.target,
        beforePreset.target,
        'Presets retain the current orbit target',
      );
      assert.equal(preset.zoom, beforePreset.zoom, 'Presets retain the current zoom');
      assert.ok(Math.abs(preset.distance - beforePreset.distance) < 1e-6);
      await selectModelView(page, name);
      await canvas.focus();
      await page.keyboard.press('Space');
      await settleCamera();
      assertIsometric(await orientationState(), preset, `Space after ${name}`);
      assertSameCamera(await cameraState(), expected, `Space refits after ${name}`);
    }
    await rotateCamera();
    await selectModelView(page, 'Isometric view');
    await settleCamera();
    assertIsometric(await orientationState(), fittedOrientation, 'Isometric cancels orbit inertia');
    await rotateCamera();
    await canvas.focus();
    await page.keyboard.press('Space');
    await settleCamera();
    assertIsometric(await orientationState(), fittedOrientation, 'Space cancels orbit inertia');
    assertSameCamera(await cameraState(), expected, 'Space refits after a manual orbit');

    const panBounds = await canvas.boundingBox();
    await page.mouse.move(
      panBounds.x + panBounds.width * 0.8,
      panBounds.y + panBounds.height * 0.8,
    );
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(
      panBounds.x + panBounds.width * 0.85,
      panBounds.y + panBounds.height * 0.75,
      {
        steps: 5,
      },
    );
    await page.mouse.up({ button: 'right' });
    await page.mouse.wheel(0, -120);
    await settleCamera();
    const displaced = await orientationState();
    assert.notDeepEqual(
      displaced.target,
      fittedOrientation.target,
      'Panning changes the orbit target',
    );
    assert.ok(
      Math.abs(displaced.zoom - fittedOrientation.zoom) > 1e-3 ||
        Math.abs(displaced.distance - fittedOrientation.distance) > 1e-3,
      'Wheel navigation changes the target-plane scale',
    );
    await selectModelView(page, 'Isometric view');
    await settleCamera();
    const displacedIsometric = await orientationState();
    assertIsometric(displacedIsometric, fittedOrientation, 'Isometric retains a displaced target');
    assertSameTarget(
      displacedIsometric.target,
      displaced.target,
      'Isometric does not refit after pan',
    );
    assert.equal(displacedIsometric.zoom, displaced.zoom, 'Isometric does not reset wheel zoom');
    assert.ok(Math.abs(displacedIsometric.distance - displaced.distance) < 1e-6);
    await canvas.focus();
    await page.keyboard.press('Space');
    await settleCamera();
    assertSameCamera(await cameraState(), expected, 'Space recentres and fits after pan and zoom');

    const display = await selectModelVisualizationTab(page, 'Display');
    await display.getByRole('checkbox', { name: 'Show CAD solids', exact: true }).uncheck();
    await canvas.focus();
    await page.keyboard.press('Space');
    await settleCamera();
    const boardOnly = await orientationState();
    assertIsometric(
      boardOnly,
      fittedOrientation,
      'Space keeps Isometric while fitting visible geometry',
    );
    assert.ok(
      Math.abs(boardOnly.target[2]) < 1e-6,
      'Hidden solids leave the board-centred Fit target',
    );
    assert.ok(
      Math.abs(boardOnly.target[2] - fittedOrientation.target[2]) > 1,
      'Space recomputes the target from current visible bounds',
    );
    await selectModelView(page, 'Front view');
    const beforeBoardOnlyPreset = await orientationState();
    await selectModelView(page, 'Isometric view');
    await settleCamera();
    const boardOnlyPreset = await orientationState();
    assertIsometric(boardOnlyPreset, boardOnly, 'Isometric also retains the board-only target');
    assertSameTarget(
      boardOnlyPreset.target,
      beforeBoardOnlyPreset.target,
      'Isometric keeps the board-only orbit target',
    );
    assert.equal(boardOnlyPreset.zoom, beforeBoardOnlyPreset.zoom);
    await (
      await selectModelVisualizationTab(page, 'Display')
    )
      .getByRole('checkbox', { name: 'Show CAD solids', exact: true })
      .check();
    await canvas.focus();
    await page.keyboard.press('Space');
    await settleCamera();
    assertSameCamera(
      await cameraState(),
      expected,
      'Space includes revealed solids in the fitted view',
    );
  }
  await selectModelVisualizationTab(page, 'Views');
  await button('Orthographic projection').click();
  await button('Fit 3D board').click();
  await settleCamera();
  const fitGuardBounds = await canvas.boundingBox();
  await page.mouse.move(
    fitGuardBounds.x + fitGuardBounds.width * 0.8,
    fitGuardBounds.y + fitGuardBounds.height * 0.8,
  );
  await canvas.focus();
  await page.mouse.wheel(0, -180);
  await settleCamera();
  const guardedCamera = await cameraState(),
    guardedFitCalls = await fitCalls();
  for (const guard of [
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { shiftKey: true },
    { repeat: true },
    { isComposing: true },
    { keyCode: 229 },
  ])
    await canvas.dispatchEvent('keydown', { key: ' ', code: 'Space', ...guard });
  await canvas.evaluate((node) => {
    const event = new KeyboardEvent('keydown', {
      key: ' ',
      code: 'Space',
      bubbles: true,
      cancelable: true,
    });
    event.preventDefault();
    node.dispatchEvent(event);
    for (const tag of ['input', 'textarea', 'select', 'div']) {
      const field = document.createElement(tag);
      if (tag === 'div') field.contentEditable = 'true';
      node.append(field);
      field.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: ' ',
          code: 'Space',
          bubbles: true,
          cancelable: true,
        }),
      );
      field.remove();
    }
  });
  await page.evaluate(() => {
    const dialog = document.createElement('dialog');
    dialog.id = 'model-space-fit-overlay';
    dialog.open = true;
    document.body.append(dialog);
  });
  await canvas.dispatchEvent('keydown', { key: ' ', code: 'Space' });
  await page.evaluate(() => document.getElementById('model-space-fit-overlay').remove());
  await canvas.dispatchEvent('pointerdown', { pointerId: 712, button: 1, buttons: 4 });
  await canvas.dispatchEvent('keydown', { key: ' ', code: 'Space' });
  await canvas.dispatchEvent('pointerup', { pointerId: 712, button: 1, buttons: 0 });
  await page.evaluate(() => window.modelKeys.setActive(false));
  await frame();
  await canvas.dispatchEvent('keydown', { key: ' ', code: 'Space' });
  await page.evaluate(() => window.modelKeys.setActive(true));
  await settleCamera();
  assert.equal(
    await fitCalls(),
    guardedFitCalls,
    'Modifiers, repeats, composition, fields, dialogs, held pointers and inactive views cannot Fit.',
  );
  assertSameCamera(await cameraState(), guardedCamera, 'Blocked Space retains the current camera');
  assert.deepEqual(await state(), beforeSpaceFit, 'Fit changes neither native design nor undo.');
  await button('Fit 3D board').click();
  await settleCamera();
  const initial = await state();
  await page.evaluate(() => {
    window.originalModelCanvas = document.querySelector('.pcb-model-canvas canvas');
    window.originalModelCamera = window.modelCamera;
  });
  await selectBody();
  assertDockBounds(defaultDrawers, await drawerGeometry());
  await sampleNext('Rotate selected CAD solid', 'r', false, { rotation: 90 });
  await page.keyboard.press('r');
  await page.waitForFunction(() => window.modelKeys.state().modelCad.objects[0].rotation.z === 90);
  await waitSample('Rotate selected CAD solid');
  assert.equal((await state()).revision, initial.revision + 1);
  await page.keyboard.press('Shift+r');
  await page.waitForFunction(() => window.modelKeys.state().modelCad.objects[0].rotation.z === 0);
  assert.equal((await state()).undoDepth, initial.undoDepth + 2);
  const beforeModifiers = await state();
  for (const key of ['m', 'r', 'Enter', 'Escape', 'Delete'])
    await canvas.dispatchEvent('keydown', { key, isComposing: true });
  assert.deepEqual(
    await state(),
    beforeModifiers,
    'IME composition cannot edit the selected solid.',
  );
  assert.equal(await tool(), 'select', 'Composing M cannot start pickup.');
  assert.equal(
    await modelToolAvailable(page, 'Move solid'),
    true,
    'Composing Escape retains selection.',
  );
  for (const modifiers of [
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { repeat: true },
  ])
    await canvas.dispatchEvent('keydown', { key: 'r', ...modifiers });
  assert.deepEqual(await state(), beforeModifiers, 'Modified/repeated R cannot edit the solid.');

  const nameInput = inspector.getByLabel('Solid name', { exact: true });
  const originalName = await nameInput.inputValue();
  await inspector.getByLabel('Height (mm)', { exact: true }).fill('11');
  await nameInput.fill('Local Escape draft');
  await nameInput.press('Escape');
  assert.equal(
    await inspector.isVisible(),
    true,
    'Escape inside a solid property field must retain the selected solid and inspector.',
  );
  assert.equal(await nameInput.inputValue(), originalName, 'Escape restores this focus session.');
  assert.equal(
    await inspector.getByLabel('Height (mm)', { exact: true }).inputValue(),
    '11',
    'Escape retains another field draft entered before this focus session.',
  );
  assert.deepEqual(await state(), beforeModifiers);
  await nameInput.fill('IME Escape draft');
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    await nameInput.dispatchEvent('keydown', { key: 'Escape', ...composition });
    assert.equal(await inspector.isVisible(), true, 'IME Escape cannot close solid properties.');
    assert.equal(await nameInput.inputValue(), 'IME Escape draft');
    assert.deepEqual(await state(), beforeModifiers);
  }

  await inspector.getByLabel('Solid name', { exact: true }).fill('Draft m r');
  await inspector.getByLabel('Solid name', { exact: true }).press('m');
  assert.equal(await tool(), 'select', 'Editing a field cannot start canvas movement.');
  await canvas.focus();
  for (const key of ['m', 'r', 'Delete']) await page.keyboard.press(key);
  assert.deepEqual(
    await state(),
    beforeModifiers,
    'Unapplied inspector drafts block editing shortcuts.',
  );
  await inspector.getByRole('button', { name: 'Close solid settings', exact: true }).click();
  await inspector.waitFor({ state: 'hidden' });
  await selectBody();
  assert.equal(
    await inspector.getByLabel('Solid name', { exact: true }).inputValue(),
    originalName,
  );
  assert.equal(
    await inspector.getByLabel('Height (mm)', { exact: true }).inputValue(),
    String(body.size.z),
  );
  assert.deepEqual(
    await state(),
    beforeModifiers,
    'Closing and reselecting discards drafts without a design edit.',
  );
  await sampleNext('Pick up selected CAD solid', 'm', true);
  await page.evaluate(() => {
    const canvas = document.querySelector('.pcb-model-canvas');
    canvas.focus();
    canvas.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'm', bubbles: true, cancelable: true }),
    );
  });
  await frame();
  assert.equal(
    await tool(),
    'move',
    JSON.stringify(
      await page.evaluate(() => ({
        hook: window.modelKeyDebug,
        hookAtInput: window.modelHookKey,
        key: window.modelCanvasKey,
        trace: window.modelKeyTrace,
        focused: document.activeElement?.className,
      })),
    ),
  );
  await movePanel.waitFor();
  assertDockBounds(defaultDrawers, await drawerGeometry());
  await waitSample('Pick up selected CAD solid');
  const beforeMove = await state();
  await movePanel.getByLabel('Length (mm)', { exact: true }).fill('21');
  await movePanel.getByLabel('Length (mm)', { exact: true }).press('Escape');
  assert.equal(await tool(), 'move', 'Escape in a move parameter cannot cancel pickup.');
  assert.equal(await movePanel.isVisible(), true);
  assert.equal(await movePanel.getByLabel('Length (mm)', { exact: true }).inputValue(), '20');
  assert.deepEqual(await state(), beforeMove);
  await movePanel.getByLabel('Length (mm)', { exact: true }).fill('20');
  await canvas.focus();
  await movePointer(62.23, 45.4);
  const preview = await page.evaluate((id) => {
    let result;
    window.modelScene.traverse((node) => {
      if (node.userData.modelCadId === id && node.userData.modelCadPreview)
        result = { x: node.position.x, y: -node.position.y, z: node.position.z };
    });
    return result;
  }, body.id);
  assert.deepEqual(preview, { x: 62, y: 45.5, z: body.position.z });
  assert.deepEqual(await state(), beforeMove, 'Moving the preview creates no edit.');
  const navigationPoint = await screenPoint(preview);
  const beforeWheel = await cameraState();
  await page.mouse.wheel(0, -250);
  await settleCamera();
  assert.ok(
    Math.abs((await cameraState()).zoom - beforeWheel.zoom) > 0.001,
    'Wheel zoom remains active during pickup.',
  );
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(navigationPoint.x + 40, navigationPoint.y + 24, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  await settleCamera();
  assert.ok(
    (await cameraState()).position.some(
      (value, axis) => Math.abs(value - beforeWheel.position[axis]) > 0.001,
    ),
    'Right-drag pan remains active during pickup.',
  );
  const beforeMiddle = await cameraState();
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(navigationPoint.x + 40, navigationPoint.y + 55, { steps: 4 });
  await page.mouse.up({ button: 'middle' });
  await settleCamera();
  assert.ok(
    Math.abs((await cameraState()).zoom - beforeMiddle.zoom) > 0.001,
    'Middle-drag zoom remains active during pickup.',
  );
  const beforeLeftDrag = await cameraState();
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(navigationPoint.x + 60, navigationPoint.y + 75, { steps: 4 });
  await page.mouse.up({ button: 'left' });
  await settleCamera();
  const afterLeftDrag = await cameraState();
  for (const field of ['position', 'quaternion'])
    assert.ok(
      afterLeftDrag[field].every(
        (value, axis) => Math.abs(value - beforeLeftDrag[field][axis]) < 1e-9,
      ),
      `Left drag cannot change camera ${field} during placement.`,
    );
  assert.ok(Math.abs(afterLeftDrag.zoom - beforeLeftDrag.zoom) < 1e-12);
  await page.mouse.dblclick(navigationPoint.x + 60, navigationPoint.y + 75, { button: 'right' });
  await frame();
  assert.deepEqual(
    await state(),
    beforeMove,
    'Camera gestures and their releases cannot commit CAD.',
  );
  assert.equal(await tool(), 'move', 'Navigation retains the active move draft.');
  await movePointer(62.23, 45.4);
  for (const key of ['r', 'Enter', 'Escape'])
    await canvas.dispatchEvent('keydown', { key, isComposing: true });
  await canvas.dispatchEvent('keydown', { key: 'Enter', keyCode: 229 });
  await frame();
  assert.deepEqual(await state(), beforeMove, 'Composing Enter cannot commit a placement preview.');
  assert.equal(await tool(), 'move', 'Composing Escape cannot cancel the active preview.');
  assert.equal(
    await movePanel.getByLabel('Solid Z rotation (degrees)').inputValue(),
    '0',
    'Composing R cannot rotate the active preview.',
  );
  await movePanel.getByLabel('Length (mm)', { exact: true }).fill('24');
  await canvas.focus();
  await sampleNext('Rotate moving CAD preview', 'r', true, { x: 62, rotation: 90 });
  await page.keyboard.press('r');
  await waitSample('Rotate moving CAD preview');
  assert.equal(await movePanel.getByLabel('Solid Z rotation (degrees)').inputValue(), '90');
  assert.equal(await movePanel.getByLabel('Length (mm)', { exact: true }).inputValue(), '24');
  await movePanel.getByLabel('Height (mm)', { exact: true }).fill('10');
  await canvas.focus();
  await page.keyboard.press('Shift+r');
  await frame();
  assert.equal(await movePanel.getByLabel('Solid Z rotation (degrees)').inputValue(), '0');
  await page.keyboard.press('r');
  await frame();
  assert.equal(await movePanel.getByLabel('Solid Z rotation (degrees)').inputValue(), '90');
  await canvas.evaluate((element) => {
    for (const shiftKey of [false, false, true])
      element.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'r', shiftKey, bubbles: true, cancelable: true }),
      );
  });
  await frame();
  assert.equal(
    await movePanel.getByLabel('Solid Z rotation (degrees)').inputValue(),
    '-180',
    'Batched turns retain every rotation request.',
  );
  await page.keyboard.press('Shift+r');
  await frame();
  assert.equal(await movePanel.getByLabel('Solid Z rotation (degrees)').inputValue(), '90');
  assert.deepEqual(await state(), beforeMove, 'Preview turns and form edits create no Core edit.');
  await sampleNext('Commit moved CAD solid', 'enter', false, { x: 62 });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.modelKeys.state().modelCad.objects[0].position.x === 62);
  await waitSample('Commit moved CAD solid');
  assert.deepEqual((await solid()).position, preview, 'Enter commits the exact snapped preview.');
  assert.equal((await solid()).rotation.z, 90, 'Enter includes the preview rotation.');
  assert.deepEqual((await solid()).size, { x: 24, y: 12, z: 10 });
  assert.deepEqual(
    (await solid()).holes,
    body.holes,
    'Keyboard movement retains body and hole identities.',
  );
  assert.equal((await state()).undoDepth, beforeMove.undoDepth + 1);
  assert.equal((await state()).pcb, initial.pcb);
  const committedMove = await state();
  await button('Undo').click();
  await page.waitForFunction(() => window.modelKeys.state().modelCad.objects[0].position.x === 50);
  assert.deepEqual(
    (await state()).modelCad,
    beforeMove.modelCad,
    'One undo restores movement, rotation, dimensions and holes together.',
  );
  await button('Redo').click();
  await page.waitForFunction(() => window.modelKeys.state().modelCad.objects[0].position.x === 62);
  assert.deepEqual((await state()).modelCad, committedMove.modelCad);
  await canvas.focus();
  for (const action of ['Cancel', 'Escape from card button']) {
    await page.keyboard.press('m');
    await movePanel.waitFor();
    assert.equal(
      await movePanel.getByRole('button', { name: 'Close solid settings', exact: true }).count(),
      0,
      'The move tool sheet has one explicit Cancel action.',
    );
    await movePanel.getByLabel('Height (mm)', { exact: true }).fill('17');
    const beforeExplicitCancel = await state();
    if (action === 'Escape from card button') {
      await movePanel.getByRole('button', { name: 'Cancel', exact: true }).focus();
      await page.keyboard.press('Escape');
    } else await movePanel.getByRole('button', { name: action, exact: true }).click();
    await frame();
    assert.equal(await tool(), 'select');
    assert.equal(
      await inspector.isVisible(),
      true,
      `${action} must restore the selected solid's Properties after a move.`,
    );
    assert.equal(await inspector.getByLabel('Height (mm)', { exact: true }).inputValue(), '10');
    assert.equal(
      await canvas.evaluate((element) => document.activeElement === element),
      true,
      `${action} returns focus to the current canvas for the next editing key.`,
    );
    assert.deepEqual(await state(), beforeExplicitCancel);
  }
  const beforeInspectorClose = await state();
  await inspector.getByRole('button', { name: 'Close solid settings', exact: true }).click();
  await inspector.waitFor({ state: 'hidden' });
  assert.equal(
    !(await modelToolAvailable(page, 'Move solid')),
    true,
    'Closing Properties clears selection.',
  );
  assert.deepEqual(await state(), beforeInspectorClose, 'Closing Properties creates no edit.');
  await selectBody();
  await page.keyboard.press('m');
  await movePointer(72, 48);
  await page.keyboard.press('r');
  await frame();
  const beforeCancel = await state();
  await page.keyboard.press('Escape');
  await movePanel.waitFor({ state: 'hidden' });
  assert.deepEqual(await state(), beforeCancel, 'Escape cancels the complete move without writes.');
  assert.equal(
    await modelToolAvailable(page, 'Move solid'),
    true,
    'Cancelling pickup retains the selected solid.',
  );
  await page.keyboard.press('Escape');
  assert.equal(
    !(await modelToolAvailable(page, 'Move solid')),
    true,
    'A second Escape clears selection.',
  );

  await selectBody();
  await page.keyboard.press('m');
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'model-external-focus';
    document.body.append(input);
    input.focus({ preventScroll: true });
    window.modelKeys.core.updateSource('invalid pending Source');
  });
  await movePanel.waitFor({ state: 'hidden' });
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    'model-external-focus',
    'Automatic Source cancellation cannot steal focus from another editor.',
  );
  const sourceGuarded = await state();
  await canvas.focus();
  for (const key of ['Enter', 'm', 'r']) await page.keyboard.press(key);
  assert.deepEqual(
    await state(),
    sourceGuarded,
    'Pending Source cancels and blocks keyboard edits.',
  );
  await page.evaluate(() => window.modelKeys.core.discardSource());
  assert.equal(
    await inspector.isVisible(),
    true,
    'Source cancellation retains the selected solid Properties when editing resumes.',
  );
  assert.equal(await inspector.getByLabel('Height (mm)', { exact: true }).inputValue(), '10');
  await page.evaluate(() => document.getElementById('model-external-focus').remove());
  await canvas.focus();
  await page.keyboard.press('m');
  await movePanel.waitFor();
  await page.evaluate((id) => {
    const snap = window.modelKeys.core.getSnapshot();
    const object = window.modelKeys.state().modelCad.objects.find((item) => item.id === id);
    return window.modelKeys.host.execute(
      'modelCad.update',
      {
        boardId: snap.project.pcb.id,
        object: { ...object, name: 'Updated by Agent' },
      },
      { actor: 'agent', expectedRevision: String(snap.revision) },
    );
  }, body.id);
  await movePanel.waitFor({ state: 'hidden' });
  const revised = await state();
  assert.equal(
    await inspector.isVisible(),
    true,
    'Revision cancellation retains the selected solid Properties.',
  );
  assert.equal(await nameInput.inputValue(), 'Updated by Agent');
  await canvas.focus();
  await page.keyboard.press('Enter');
  assert.deepEqual(await state(), revised, 'A newer revision cancels the old preview.');
  await page.keyboard.press('m');
  await movePanel.waitFor();
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.id = 'model-other-project-focus';
    document.body.append(input);
    input.focus({ preventScroll: true });
    window.modelKeys.setActive(false);
  });
  await movePanel.waitFor({ state: 'hidden' });
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    'model-other-project-focus',
    'Project deactivation cannot return focus to the hidden Model canvas.',
  );
  await page.keyboard.press('Enter');
  assert.deepEqual(await state(), revised, 'Deactivation discards keyboard pickup without writes.');
  await page.evaluate(() => window.modelKeys.setActive(true));
  await frame();
  assert.equal(
    await inspector.isVisible(),
    true,
    'Returning to Model restores Properties for the retained selected solid.',
  );
  assert.equal(
    await page.evaluate(() => document.activeElement?.id),
    'model-other-project-focus',
    'Restoring selected Properties after automatic cancellation cannot steal focus.',
  );
  await page.evaluate(() => document.getElementById('model-other-project-focus').remove());

  await button('Place box').click();
  const placement = page.getByRole('complementary', { name: 'Box settings', exact: true });
  await placement.getByLabel('Length (mm)', { exact: true }).fill('23');
  await placement.getByLabel('Length (mm)', { exact: true }).press('Escape');
  assert.equal(await tool(), 'box', 'Escape in a placement field cannot exit the Box tool.');
  assert.equal(await placement.isVisible(), true);
  assert.equal(await placement.getByLabel('Length (mm)', { exact: true }).inputValue(), '20');
  assert.deepEqual(await state(), revised);
  await placement.getByLabel('Length (mm)', { exact: true }).fill('-');
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    await placement.getByLabel('Length (mm)', { exact: true }).dispatchEvent('keydown', {
      key: 'Escape',
      ...composition,
    });
    assert.equal(await tool(), 'box', 'IME Escape cannot discard a placement draft.');
    assert.equal(await placement.getByLabel('Length (mm)', { exact: true }).inputValue(), '-');
  }
  await canvas.focus();
  await page.keyboard.press('r');
  await page.keyboard.press('Enter');
  assert.deepEqual(await state(), revised, 'Enter cannot commit invalid dimensions.');
  await movePointer(30.2, 26.3);
  await placement.evaluate((panel) => {
    // Correct an invalid form and request rotation in one event batch. The
    // next input must use that current valid form rather than the old null
    // preview, without waiting for a render/frame sample.
    const input = panel.querySelector('[aria-label="Length (mm)"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '22');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const height = panel.querySelector('[aria-label="Height (mm)"]');
    height.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(height, '12');
    height.dispatchEvent(new Event('input', { bubbles: true }));
    height.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    const canvas = document.querySelector('.pcb-model-canvas');
    canvas.focus();
    canvas.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'r', shiftKey: true, bubbles: true, cancelable: true }),
    );
  });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.modelKeys.state().modelCad.objects.length === 2);
  assert.equal(
    (await state()).revision,
    revised.revision + 1,
    'Enter places one body in one transaction.',
  );
  assert.equal((await state()).modelCad.objects[1].size.x, 22);
  assert.equal(
    (await state()).modelCad.objects[1].size.z,
    10,
    'Immediate placement uses the field restored by Escape and retains the other field draft.',
  );
  assert.equal(
    (await state()).modelCad.objects[1].rotation.z,
    -90,
    'Immediate Enter commits the latest form rotation without waiting for a frame.',
  );

  await button('Place cylinder').click();
  const standoff = page.getByRole('complementary', { name: 'Cylinder settings', exact: true });
  await standoff.waitFor();
  await movePointer(35, 28);
  const beforeStandoff = await state();
  await standoff.evaluate((panel) => {
    // Keep the physical pointer over the canvas while keyboard focus edits a
    // precise mounting location; the old pointer snap must not override it.
    for (const axis of ['X', 'Y']) {
      const input = panel.querySelector(`[aria-label="Solid ${axis} position (mm)"]`);
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '53.8');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const canvas = document.querySelector('.pcb-model-canvas');
    canvas.focus();
    canvas.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
  });
  await page.waitForFunction(() => window.modelKeys.state().modelCad.objects.length === 3);
  assert.deepEqual(
    (await state()).modelCad.objects[2].position,
    { x: 53.8, y: 53.8, z: source.pcb.thickness / 2 + 5 },
    'Immediate Enter retains exact typed off-grid mounting coordinates after a pointer preview.',
  );
  assert.equal((await state()).undoDepth, beforeStandoff.undoDepth + 1);

  await button('Place cylinder').click();
  await standoff.waitFor();
  const numericPose = { x: 53.8, y: 53.8, z: source.pcb.thickness / 2 + 5 };
  const navigationStart = await screenPoint({ x: 35, y: 28, z: numericPose.z });
  await page.mouse.move(navigationStart.x, navigationStart.y);
  await frame();
  await standoff.evaluate((panel) => {
    for (const axis of ['X', 'Y']) {
      const input = panel.querySelector(`[aria-label="Solid ${axis} position (mm)"]`);
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '53.8');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    document.querySelector('.pcb-model-canvas').focus();
  });
  const numericDraftState = await state();
  const previewPose = () =>
    page.evaluate(() => {
      let position;
      window.modelScene.traverse((node) => {
        if (node.userData.modelCadPreview && node.userData.modelCadId)
          position = { x: node.position.x, y: -node.position.y, z: node.position.z };
      });
      return position;
    });
  const beforeNumericWheel = await cameraState();
  await page.mouse.wheel(0, -180);
  await settleCamera();
  assert.ok(
    Math.abs((await cameraState()).zoom - beforeNumericWheel.zoom) > 0.001,
    'Wheel zoom remains available after precise numeric placement.',
  );
  assert.deepEqual(
    await previewPose(),
    numericPose,
    'Wheel navigation cannot replace exact numeric XY with the stationary pointer snap.',
  );
  assert.equal(await standoff.getByLabel('Solid X position (mm)').inputValue(), '53.8');
  assert.equal(await standoff.getByLabel('Solid Y position (mm)').inputValue(), '53.8');
  assert.equal(await tool(), 'cylinder');
  assert.deepEqual(await state(), numericDraftState);

  const beforeNumericPan = await cameraState();
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(navigationStart.x + 38, navigationStart.y + 24, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  await settleCamera();
  assert.ok(
    (await cameraState()).position.some(
      (value, axis) => Math.abs(value - beforeNumericPan.position[axis]) > 0.001,
    ),
    'Right-drag pan remains available after precise numeric placement.',
  );
  assert.deepEqual(
    await previewPose(),
    numericPose,
    'Right-drag navigation and release cannot take ownership of exact numeric XY.',
  );
  assert.equal(await standoff.getByLabel('Solid X position (mm)').inputValue(), '53.8');
  assert.equal(await standoff.getByLabel('Solid Y position (mm)').inputValue(), '53.8');
  assert.equal(await tool(), 'cylinder');
  assert.deepEqual(await state(), numericDraftState);
  await canvas.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.modelKeys.state().modelCad.objects.length === 4);
  assert.deepEqual((await state()).modelCad.objects[3].position, numericPose);
  assert.equal((await state()).undoDepth, numericDraftState.undoDepth + 1);

  await selectBody();
  const beforeGuards = await state();
  await page.evaluate(() => {
    const overlay = document.createElement('dialog');
    overlay.id = 'model-keyboard-test-overlay';
    overlay.open = true;
    document.body.append(overlay);
  });
  for (const key of ['m', 'r']) await page.keyboard.press(key);
  assert.deepEqual(await state(), beforeGuards, 'An open dialog blocks canvas edit shortcuts.');
  assert.equal(await tool(), 'select');
  await page.evaluate(() => document.getElementById('model-keyboard-test-overlay').remove());
  const pointer = await screenPoint({ x: 5, y: 5, z: 0 });
  await page.mouse.move(pointer.x, pointer.y);
  await page.mouse.down({ button: 'middle' });
  await page.keyboard.press('r');
  await page.keyboard.press('m');
  assert.deepEqual(await state(), beforeGuards, 'Orbit/pan gestures cannot start keyboard edits.');
  assert.equal(await tool(), 'select');
  await page.mouse.up({ button: 'middle' });
  await canvas.focus();
  const rotationAfterGesture =
    (((((await solid()).rotation.z + 90 + 180) % 360) + 360) % 360) - 180;
  await page.keyboard.press('r');
  await page.waitForFunction(
    (rotation) => window.modelKeys.state().modelCad.objects[0].rotation.z === rotation,
    rotationAfterGesture,
  );
  assert.equal(
    (await state()).revision,
    beforeGuards.revision + 1,
    'Keyboard editing resumes after gesture release.',
  );
  assert.equal(
    await page.evaluate(
      () =>
        document.querySelector('.pcb-model-canvas canvas') === window.originalModelCanvas &&
        window.modelCamera === window.originalModelCamera,
    ),
    true,
    'Keyboard CAD edits retain the WebGL scene and camera.',
  );
  assert.equal((await state()).pcb, initial.pcb);
  assert.deepEqual(errors, []);
  for (const action of ['Cancel', 'Escape from card button']) {
    await button('Drill through hole').click();
    const holePanel = page.getByRole('complementary', { name: 'Hole settings', exact: true });
    const previousDiameter = await holePanel.getByLabel('Hole diameter (mm)').inputValue();
    await holePanel.getByLabel('Hole diameter (mm)').fill('4.2');
    await holePanel.getByLabel('Hole diameter (mm)').press('Escape');
    assert.equal(await tool(), 'hole', 'Escape in the diameter field cannot exit drilling.');
    assert.equal(await holePanel.getByLabel('Hole diameter (mm)').inputValue(), previousDiameter);
    await holePanel.getByLabel('Hole diameter (mm)').fill('4.2');
    for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
      await holePanel.getByLabel('Hole diameter (mm)').dispatchEvent('keydown', {
        key: 'Escape',
        ...composition,
      });
      assert.equal(await tool(), 'hole', 'IME Escape cannot exit drilling.');
      assert.equal(await holePanel.getByLabel('Hole diameter (mm)').inputValue(), '4.2');
    }
    const beforeDrillCancel = await state();
    assert.equal(
      await holePanel.getByRole('button', { name: 'Close solid settings', exact: true }).count(),
      0,
      'The drilling tool sheet has one explicit Cancel action.',
    );
    if (action === 'Escape from card button') {
      await holePanel.getByRole('button', { name: 'Cancel', exact: true }).focus();
      await page.keyboard.press('Escape');
    } else await holePanel.getByRole('button', { name: action, exact: true }).click();
    await frame();
    assert.equal(
      await inspector.isVisible(),
      true,
      `${action} restores selected solid Properties.`,
    );
    assert.equal(
      await canvas.evaluate((element) => document.activeElement === element),
      true,
      `${action} returns drilling focus to the canvas.`,
    );
    assert.deepEqual(await state(), beforeDrillCancel);
  }
  await button('Drill through hole').click();
  assert.equal(await tool(), 'hole');
  const beforeDrillNavigation = await state();
  const beforeDrillWheel = await cameraState();
  const drillPoint = await screenPoint({ x: 50, y: 38, z: body.position.z });
  await page.mouse.move(drillPoint.x, drillPoint.y);
  await page.mouse.wheel(0, 180);
  await settleCamera();
  assert.ok(
    Math.abs((await cameraState()).zoom - beforeDrillWheel.zoom) > 0.001,
    'Drilling retains camera zoom.',
  );
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(drillPoint.x + 30, drillPoint.y + 20, { steps: 4 });
  await page.mouse.up({ button: 'right' });
  await settleCamera();
  assert.equal(await tool(), 'hole');
  assert.deepEqual(await state(), beforeDrillNavigation, 'Drill navigation cannot add a hole.');
  await canvas.focus();
  await page.keyboard.press('Escape');
  await selectModelView(page, 'Top view');
  await frame();
  const beforePickRays = await page.evaluate(() => window.modelPickRays);
  await selectBody();
  assert.equal(
    (await page.evaluate(() => window.modelPickRays)) - beforePickRays,
    1,
    'A CAD click shares one complete scene raycast.',
  );
  console.log(
    'Model keyboard event to WebGL submission, simple mocked CAD fixture (ms):',
    await page.evaluate(() =>
      window.modelKeyboardTimings.map((sample) => ({
        operation: sample.operation,
        ms: Number(sample.ms.toFixed(1)),
      })),
    ),
  );
  await page
    .getByRole('region', { name: '3D board preview', exact: true })
    .screenshot({ path: 'test-results/model-keyboard-ui.png' });
  console.log(
    'PASS: Model Space and Isometric share equal-axis orientation after presets and manual orbit in both projections; Space fits current visible bounds while presets retain target/zoom, with focus/IME/modifier/dialog/gesture guards and no document edits; focused M pickup, R/Shift+R selection and placement/move preview rotation with retained form fields, exact Enter placement, cancellation/selection retention, one-edit undo, draft/Source/revision/deactivation/dialog/gesture guards, one scene ray per CAD click and retained PCB/WebGL/camera.',
  );
} finally {
  await browser.close();
}
