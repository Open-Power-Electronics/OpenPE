import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { waitForAsync } from './async-browser-test-helpers.mjs';
import { formatTestProjectSource } from './format-test-project.mjs';

// Isolated renderer using the native export of the RC fixture and mocked read-only history.
// No Electron, Git, native destinations, solvers or providers are launched.
const { projectFromNativeFiles, projectNativeFiles, parseProject, serializeProject } =
  await tsImport('../lib/project.ts', import.meta.url);
const { newModelCadObject, withModelCad, modelCadFromProject } = await tsImport(
  '../lib/model-cad.ts',
  import.meta.url,
);
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const fixture = parseProject(formatTestProjectSource());
for (const footprint of fixture.pcb.footprints) {
  const part = fixture.schematic.parts.find((part) => part.id === footprint.symbolId);
  (part.fields ??= {}).Footprint = footprint.libraryId;
}
for (const net of fixture.pcb.nets) {
  if (net.name === '/IN' || net.name === '/OUT') net.name = net.name.slice(1);
}
const native = projectNativeFiles(fixture, 'rc-filter.kicad_pro');
let project = projectFromNativeFiles(native);
const body = newModelCadObject(project.pcb, 'box');
project = withModelCad(project, { version: 1, objects: [body] });
const before = serializeProject(project);
const changed = parseProject(before);
changed.schematic.parts[0].value = '4.7k';
changed.pcb.footprints[0].x += 5;
const movedBody = { ...body, size: { ...body.size, z: body.size.z + 4 } };
const after = serializeProject(withModelCad(changed, { version: 1, objects: [movedBody] }));
const missing = serializeProject(
  projectFromNativeFiles({
    ...native,
    files: native.files.filter((file) => !file.name.endsWith('.kicad_pcb')),
  }),
);
const empty = serializeProject(withModelCad({ ...project, pcb: createEmptyPCB() }, null));
const open = parseProject(before);
open.pcb.graphics = open.pcb.graphics.filter((graphic) => graphic.layer !== 'Edge.Cuts');
const openSource = serializeProject(open);
assert.equal(modelCadFromProject(parseProject(after)).objects[0].size.z, movedBody.size.z);
const changedNames = projectNativeFiles(parseProject(after))
  .files.filter(
    (file) =>
      projectNativeFiles(parseProject(before)).files.find((old) => old.name === file.name)
        ?.source !== file.source,
  )
  .map((file) => file.name);
const bundle = await build({
  stdin: {
    contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {flushSync} from 'react-dom';
      import History from './components/ProjectHistoryView';
      const root = createRoot(document.getElementById('root'));
      const scenes = new Map();
      const versions = [
        {id: 'b'.repeat(40), date:'2026-11-05T10:00:00+08:00', message:'Changed design', source:${JSON.stringify(after)}},
        {id: 'a'.repeat(40), date:'2026-11-05T09:00:00+08:00', message:'Initial design', source:${JSON.stringify(before)}}
      ];
      const calls = [];
      const writes = [];
      const host = {
        async query(id, input) {
          calls.push({id,input});
          if (id === 'versions.list') return {version:'mock Git',commits:versions,more:false};
          if (id === 'versions.read') return {source:versions.find(v=>v.id===input.id).source};
          throw new Error('Unexpected query: '+id);
        },
        async execute(id, input) {writes.push({id,input}); throw new Error('Comparison must be read-only');}
      };
      let state = {visible:true,source:${JSON.stringify(after)}};
      window.historyPreview = {
        calls,writes,scenes,
        render(next) {
          state={...state,...next};
          flushSync(()=>root.render(<History visible={state.visible} source={state.source}
            sourcePending={false} fileId="fixture" capabilityHost={host}
            onSave={async()=>{writes.push('save');return 'cancelled'}}
            onClose={()=>window.historyPreview.render({visible:false})}/>));
        }
      };
      window.historyPreview.render({});
    `,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outdir: 'test-results/history-previews-ui-bundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [
    {
      name: 'inspect-history-model-scenes',
      setup(plugin) {
        plugin.onLoad({ filter: /[\\/]PCBModelPreview\.tsx$/ }, async (args) => {
          const source = await readFile(args.path, 'utf8');
          const marker = '      const render = () => {';
          assert.ok(
            source.includes(marker),
            'The scene inspection follows the current render callback.',
          );
          return {
            contents: source.replace(
              marker,
              marker + '\nwindow.historyPreview.scenes.set(renderer.domElement, {scene, camera});',
            ),
            loader: 'tsx',
            resolveDir: path.dirname(args.path),
          };
        });
      },
    },
  ],
});
await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
let page;
const errors = [];
const unexpectedRequests = [];
let failFootprints = true;
let footprintRequests = 0;
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.openpe = { connection: async () => ({ base: 'http://localhost', token: 'fixture' }) };
  });
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/')
      return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    if (['/brand/openpe-mark.svg', '/brand/openpe-signal.svg'].includes(url.pathname))
      return route.fulfill({
        contentType: 'image/svg+xml',
        body: await readFile(`public${url.pathname}`),
      });
    if (url.pathname === '/api/libraries/footprints') {
      footprintRequests++;
      if (failFootprints)
        return route.fulfill({ status: 503, json: { error: 'Temporary model metadata failure.' } });
      return route.fulfill({ json: { footprint: ['footprint', '"Fixture"'], models: [] } });
    }
    unexpectedRequests.push(url.pathname);
    return route.fulfill({ status: 404, json: { error: 'Unexpected preview request.' } });
  });
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  for (const output of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
    await page.addStyleTag({ content: output.text });
  await page.addScriptTag({
    content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
  });
  const history = page.getByRole('dialog', { name: 'Git', exact: true });
  const button = (name) => history.getByRole('button', { name, exact: true });
  const region = (name) => history.getByRole('region', { name, exact: true });
  await region('Schematic comparison').waitFor();
  await history.getByRole('button', { name: 'Changed design', exact: false }).click();
  await waitForAsync(
    page,
    () =>
      document.querySelector('section.project-history-view').getAttribute('aria-busy') === 'false',
  );
  const expectedLabels = ['Initial design', 'Changed design'];
  async function assertLabels(name) {
    const labels = await region(name)
      .locator(':is(.schematic-compare-pane, .history-file-pane)')
      .evaluateAll((panes) => panes.map((pane) => pane.getAttribute('aria-description')));
    assert.deepEqual(labels, expectedLabels, `${name} identifies both versions accessibly.`);
  }
  async function checkNavigation(name) {
    const comparison = region(name);
    const drawings = comparison.locator('svg[role="img"]');
    const first = drawings.nth(0);
    const fitted = await first.getAttribute('viewBox');
    const synchronized = async () => {
      const view = await first.getAttribute('viewBox');
      assert.equal(view, await drawings.nth(1).getAttribute('viewBox'));
      return view;
    };
    const changed = async (previous) => {
      await waitForAsync(
        page,
        ({ name, previous }) =>
          document
            .querySelector(`[aria-label="${name}"] svg[role="img"]`)
            ?.getAttribute('viewBox') !== previous,
        { name, previous },
      );
      return synchronized();
    };
    await comparison.getByRole('button', { name: 'Zoom in comparison', exact: true }).click();
    const zoomed = await changed(fitted);
    await first.focus();
    for (const composition of [{ keyCode: 229 }, { isComposing: true }]) {
      await first.dispatchEvent('keydown', { key: 'ArrowRight', ...composition });
      assert.equal(await synchronized(), zoomed, `${name}: IME does not pan.`);
    }
    await first.press('ArrowRight');
    const panned = await changed(zoomed);
    await drawings.nth(1).dispatchEvent('wheel', { deltaY: -100 });
    const wheeled = await changed(panned);
    const bounds = await first.boundingBox();
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 30, y + 20, { steps: 3 });
    const dragged = await changed(wheeled);
    await page.mouse.up();
    await page.mouse.move(x + 50, y + 40);
    assert.equal(await synchronized(), dragged, `${name}: pointer release ends the pan.`);
    await comparison.getByRole('button', { name: 'Fit comparison', exact: true }).click();
    assert.equal(await synchronized(), fitted, `${name}: Fit restores the measured bounds.`);
  }
  for (const name of ['Schematic', 'Layout', 'Model', 'Source'])
    assert.equal(await button(`${name} comparison`).count(), 1);
  await assertLabels('Schematic comparison');
  await checkNavigation('Schematic comparison');
  await button('Layout comparison').click();
  const layout = region('Layout comparison');
  await layout.waitFor();
  await assertLabels('Layout comparison');
  const drawings = layout.locator('svg[role="img"]');
  assert.equal(await drawings.count(), 2);
  await waitForAsync(page, () => {
    const drawings = [
      ...document.querySelectorAll('[aria-label="Layout comparison"] svg[role="img"]'),
    ];
    return (
      drawings.length === 2 &&
      drawings.every((svg) => {
        const rect = svg.getBoundingClientRect();
        return rect.width > 150 && rect.height > 150 && svg.viewBox.baseVal.width > 0;
      })
    );
  });
  const fitted = await drawings.nth(0).getAttribute('viewBox');
  assert.equal(fitted, await drawings.nth(1).getAttribute('viewBox'));
  await checkNavigation('Layout comparison');
  assert.equal(await drawings.nth(0).getAttribute('viewBox'), fitted);
  await page.screenshot({ path: 'test-results/history-layout-comparison.png' });
  await button('Model comparison').click();
  const model = region('Model comparison');
  await model.waitFor();
  await assertLabels('Model comparison');
  await waitForAsync(page, () => {
    const canvases = [...document.querySelectorAll('[aria-label="Model comparison"] canvas')];
    return (
      canvases.length === 2 &&
      canvases.every((canvas) => {
        const captured = window.historyPreview.scenes.get(canvas);
        if (!captured) return false;
        let board = false,
          cad = false;
        captured.scene.traverseVisible((object) => {
          board ||= object.userData.modelBoard === true;
          cad ||= Boolean(object.userData.modelCadId) && object.isMesh;
        });
        return board && cad;
      })
    );
  });
  for (const scale of await model.locator('.model-spatial-scale').all()) {
    const bounds = await scale.boundingBox();
    assert.ok(bounds.width >= 100 && bounds.width < 140, '3D scale keeps its compact width.');
    assert.ok(bounds.height >= 100 && bounds.height < 140, '3D scale keeps its compact height.');
  }
  assert.deepEqual(await model.locator('input,textarea').all(), []);
  for (const name of ['Place box', 'Place cylinder', 'Delete selection', 'Export image'])
    assert.equal(await model.getByRole('button', { name, exact: true }).count(), 0);
  const dimensions = await page.evaluate(() =>
    [...document.querySelectorAll('[aria-label="Model comparison"] canvas')].map((canvas) => {
      const { scene } = window.historyPreview.scenes.get(canvas);
      let size;
      scene.traverseVisible((object) => {
        if (object.isMesh && object.userData.modelCadId) {
          object.geometry.computeBoundingBox();
          size = object.geometry.boundingBox.max.z - object.geometry.boundingBox.min.z;
        }
      });
      return size;
    }),
  );
  assert.notEqual(dimensions[0], dimensions[1], 'Each pane renders its own CAD version.');
  await waitForAsync(page, () => {
    const region = document.querySelector('section.model-comparison');
    return (
      region.querySelectorAll('.pcb-model-issues').length === 2 &&
      region.querySelectorAll('.pcb-model-status').length === 0
    );
  });
  const requestsBeforeRetry = footprintRequests;
  failFootprints = false;
  await model.locator('.pcb-model-issues summary').first().click();
  const retryRequest = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/libraries/footprints' && response.status() === 200,
  );
  await model.getByRole('button', { name: 'Retry component models', exact: true }).first().click();
  await retryRequest;
  assert.ok(footprintRequests > requestsBeforeRetry, 'Retry reattempts failed component metadata.');
  await model.locator('canvas').nth(0).click();
  for (const key of ['Delete', 'Backspace', 'm', 'b', 'c']) await page.keyboard.press(key);
  const cameras = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[aria-label="Model comparison"] canvas')].map((canvas) => {
        const { camera } = window.historyPreview.scenes.get(canvas);
        return { zoom: camera.zoom, position: camera.position.toArray() };
      }),
    );
  const cameraBeforeZoom = await cameras();
  assert.equal(await model.locator('.zoom-controls').count(), 0);
  await model.locator('.pcb-model-canvas').first().hover();
  await page.mouse.wheel(0, -100);
  await waitForAsync(
    page,
    (before) => {
      const canvas = document.querySelector('[aria-label="Model comparison"] canvas');
      const { camera } = window.historyPreview.scenes.get(canvas);
      return (
        JSON.stringify({ zoom: camera.zoom, position: camera.position.toArray() }) !==
        JSON.stringify(before)
      );
    },
    cameraBeforeZoom[0],
  );
  const cameraAfterZoom = await cameras();
  assert.notDeepEqual(cameraAfterZoom[0], cameraBeforeZoom[0], 'Model zoom changes its camera.');
  assert.deepEqual(
    cameraAfterZoom[1],
    cameraBeforeZoom[1],
    'Model panes retain independent cameras.',
  );
  await page.screenshot({ path: 'test-results/history-model-comparison.png' });
  await button('Source comparison').click();
  await region('File comparison').waitFor();
  await assertLabels('File comparison');
  const changedFiles = history.getByRole('navigation', { name: 'Changed files', exact: true });
  const schematicName = changedNames.find((name) => name.endsWith('.kicad_sch'));
  await button('Schematic comparison').click();
  await changedFiles
    .getByRole('button', { name: `Modified · ${schematicName}`, exact: true })
    .click();
  assert.equal(await button('Source comparison').getAttribute('aria-pressed'), 'true');
  assert.ok((await region('File comparison').innerText()).includes(schematicName));
  assert.ok((await region('File comparison').innerText()).includes('4.7k'));
  const message = history.getByRole('textbox', { name: 'Commit message', exact: true });
  await message.fill('Retained message');
  await button('Layout comparison').click();
  await layout.getByRole('button', { name: 'Zoom in comparison', exact: true }).click();
  const retainedView = await drawings.nth(0).getAttribute('viewBox');
  await button('Close dialog').click();
  await page.evaluate(() => window.historyPreview.render({ visible: true }));
  await layout.waitFor();
  await waitForAsync(
    page,
    () =>
      document.querySelector('section.project-history-view').getAttribute('aria-busy') === 'false',
  );
  assert.equal(await message.inputValue(), 'Retained message');
  assert.equal(await drawings.nth(0).getAttribute('viewBox'), retainedView);
  await assertLabels('Layout comparison');
  await history
    .getByRole('navigation', { name: 'Project versions', exact: true })
    .getByRole('button', { name: 'Worktree', exact: false })
    .click();
  await page.evaluate((source) => window.historyPreview.render({ source }), missing);
  await layout.getByText('PCB layout not present in this version.', { exact: true }).waitFor();
  assert.equal(await drawings.count(), 1);
  await button('Model comparison').click();
  await model.waitFor();
  await waitForAsync(page, () => {
    const region = document.querySelector('section.model-comparison');
    return region.textContent.includes('not present in this version');
  });
  await button('Layout comparison').click();
  for (const source of [empty, openSource]) {
    await page.evaluate((source) => window.historyPreview.render({ source }), source);
    await waitForAsync(page, () => {
      const pane = document.querySelector('[aria-label="After layout"]');
      const svg = pane?.querySelector('svg[role="img"]');
      return Boolean(svg && svg.viewBox.baseVal.width > 0);
    });
    assert.equal(await drawings.count(), 2, 'Empty/open native boards have a layout preview.');
  }
  assert.deepEqual(await page.evaluate(() => window.historyPreview.writes), []);
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpectedRequests, []);
  console.log(
    'PASS: Git Schematic/Layout/Model/Source previews share version selection, render native geometry and CAD, retain views, handle missing boards and remain read-only.',
  );
} catch (error) {
  if (page) {
    await page.screenshot({ path: 'test-results/history-previews-failure.png' });
    console.error(await page.locator('body').innerText(), errors, unexpectedRequests);
    console.error(
      { footprintRequests, failFootprints },
      await page.locator('.pcb-model-issues').allTextContents(),
    );
    console.error(
      await page.evaluate(() => ({
        scenes: window.historyPreview?.scenes.size,
        canvases: [...document.querySelectorAll('[aria-label="Model comparison"] canvas')].map(
          (canvas) => {
            const captured = window.historyPreview.scenes.get(canvas);
            const tags = [];
            captured?.scene.traverseVisible((object) => {
              if (Object.keys(object.userData).length)
                tags.push({ type: object.type, userData: object.userData });
            });
            return { captured: Boolean(captured), tags };
          },
        ),
      })),
    );
  }
  throw error;
} finally {
  await browser.close();
}
