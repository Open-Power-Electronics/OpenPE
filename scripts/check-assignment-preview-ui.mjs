import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { startServer } from '../server/index.mjs';
import { parseProject as parseHostProject } from '../server/project-format.mjs';
const root = await mkdtemp(path.resolve('test-results/assignment-preview-'));
const grant = '00000000-0000-4000-8000-000000000001';
const server = await startServer({
  dataDir: path.join(root, 'profile'),
  componentModelFiles: {
    resolve: (id) => (id === grant ? null : undefined),
  },
});
const source = await readFile('lib/emc-flyback-example.json', 'utf8');
const originalProject = parseHostProject(source);
const selectedFootprint = originalProject.pcb.footprints.find(
  (f) => f.symbolId && f.models?.length,
);
const modelFile = path.resolve(
  'examples/project/emc-flyback',
  selectedFootprint.models[0].path.slice('${KIPRJMOD}/'.length),
);
const imported = await server.componentModels.importFile(modelFile, new AbortController().signal);
const modelHash = imported.path.split('/').at(-1).slice(0, -5);
const bundle = await build({
  stdin: {
    contents: `
import React,{useState,useSyncExternalStore} from 'react';import {createRoot} from 'react-dom/client';
import ComponentProperties from './components/ComponentProperties';import {ProjectCore} from './core/project-core';import {parseProject,projectNativeFiles} from './lib/project';
import {attachOnlineFootprint} from './lib/library-project-assets';
import {parseSExpr,quote} from './lib/sexpr';
const core=new ProjectCore(parseProject(${JSON.stringify(source)}));const original=core.getSnapshot().project.pcb.footprints.find(f=>f.symbolId&&f.models?.length);const id=original.id;
window.openpe={connection:async()=>({base:'http://localhost',token:${JSON.stringify(server.token)}}),chooseComponentModel:async()=>({path:${JSON.stringify(imported.path)}}),inspectSpiceModel:async()=>null};
window.current=()=>core.getSnapshot().project;window.historyDepth=()=>core.getSnapshot().undoDepth;
window.undoFixture=()=>core.undo();
window.nativePCB=()=>projectNativeFiles(core.getSnapshot().project).files.find(f=>f.name.endsWith('.kicad_pcb')).source;
window.setOnlinePackage=(libraryId)=>{
  const {project}=core.getSnapshot();
  const path=${JSON.stringify(imported.path)};
  const name=libraryId.split(':')[1];
  const footprint=parseSExpr('(footprint '+quote(name)+' (layer "F.Cu") (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask")) (model '+quote(path)+'))');
  const {nativeFiles}=attachOnlineFootprint(project,{id:libraryId,footprint,projectAssets:true});
  const footprints=project.pcb.footprints.map(f=>f.id===id?{...f,libraryId,models:[{...f.models[0],path}]}:f);
  core.replaceBoard({...project.pcb,footprints},nativeFiles);
};
function Fixture(){const snapshot=useSyncExternalStore(core.subscribe,core.getSnapshot);const [view,setView]=useState('Schematic');const project=snapshot.project;return <><nav>{['Schematic','Layout','Model'].map(v=><button key={v} onClick={()=>setView(v)}>{v}</button>)}<button onClick={()=>core.undo()}>Undo</button></nav><div className="layout-properties" data-mode={view}><ComponentProperties key={view} footprint={project.pcb.footprints.find(f=>f.id===id)} schematic={project.schematic} projectSource={snapshot.source} active resetKey snap={v=>v} fileId="00000000-0000-4000-8000-000000000001" getRevision={()=>core.getSnapshot().revision} onFootprint={next=>core.replaceBoard({...project.pcb,footprints:project.pcb.footprints.map(f=>f.id===id?next:f)})} onSavePartProperties={()=>true}/></div></>;}createRoot(document.getElementById('root')).render(<Fixture/>);
`,
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
try {
  const page = await browser.newPage({ viewport: { width: 1120, height: 900 } });
  const errors = [];
  let previewRequests = 0;
  let failNextPreview = false;
  let failNextLibraryImport = true;
  const libraryImports = [];
  let offlineCatalog = false;
  const offlineCatalogRequests = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('http://localhost/**', async (r) => {
    const url = new URL(r.request().url());
    if (url.pathname.startsWith('/api/')) {
      if (offlineCatalog && ['/api/libraries/footprints', '/api/library-model'].includes(url.pathname)) {
        if (url.searchParams.has('categories')) return r.fulfill({ json: { categories: [] } });
        offlineCatalogRequests.push(url.pathname + url.search);
        return r.fulfill({ status: 503, json: { error: 'Catalog unavailable' } });
      }
      if (url.pathname === '/api/component-model') previewRequests++;
      if (url.pathname === '/api/component-model' && failNextPreview) {
        failNextPreview = false;
        return r.fulfill({ status: 503, json: { error: 'Temporary preview failure' } });
      }
      if (url.pathname === '/api/component-model/library') {
        libraryImports.push(JSON.parse(r.request().postData()));
        if (failNextLibraryImport) {
          failNextLibraryImport = false;
          return r.fulfill({ status: 503, json: { error: 'Temporary assignment failure' } });
        }
      }
      const response = await fetch(server.base + url.pathname + url.search, {
        method: r.request().method(),
        headers: { 'X-OpenPE-Token': server.token, 'Content-Type': 'application/json' },
        body: r.request().postData() ?? undefined,
      });
      return r.fulfill({
        status: response.status,
        contentType: 'application/json',
        body: await response.text(),
      });
    }
    return r.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({ content: '#root{padding:20px}.layout-properties{width:340px}*{transition:none!important}' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const browse = () => page.getByRole('button', { name: 'Browse models', exact: true });
  const manage = () => page.getByRole('button', { name: 'Manage assigned models', exact: true });
  const chooserLayout = (dialog) =>
    dialog.evaluate((element) => {
      const frame = element.getBoundingClientRect();
      return [
        '.dialog-header', '.library-filter', '.library-search-row', '.assignment-browser',
        '.library-results', '.assignment-detail', '.library-detail-heading', '.preview-tabs',
        '.assignment-preview-stage', '.library-detail-sections', '.library-pricing',
        '.dialog-footer', '.dialog-footer .primary',
      ].map((selector) => {
        const box = element.querySelector(selector).getBoundingClientRect();
        return selector === '.dialog-footer .primary'
          ? [frame.right - box.right, box.y - frame.y, box.height]
          : [box.x - frame.x, box.y - frame.y, box.width, box.height];
      });
    });
  await browse().waitFor();
  const before = await page.evaluate(() => window.nativePCB());
  for (const view of ['Schematic', 'Layout', 'Model']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    await browse().waitFor();
    const model = manage(),
      footprint = page.getByRole('button', { name: 'Browse footprints', exact: true });
    assert.equal(await footprint.count(), 1);
    assert.equal(await model.count(), 1);
    assert.equal(
      (await model.textContent()).includes('${KIPRJMOD}'),
      false,
      'The main Model field displays filenames, retaining paths in the secondary dialog.',
    );
    const resourceStyles = await page.locator('.property-resource-field').evaluateAll((rows) =>
      rows.map((row) => {
        const input = row.querySelector('.property-field-value'),
          name = row.querySelector('.property-field-name'),
          icon = row.querySelector('button svg');
        const box = input.getBoundingClientRect(),
          nameBox = name.getBoundingClientRect(),
          iconBox = icon.getBoundingClientRect(),
          style = getComputedStyle(input);
        return {
          x: box.x,
          width: box.width,
          height: box.height,
          labelX: nameBox.x,
          labelWidth: nameBox.width,
          font: style.fontFamily,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          lineHeight: style.lineHeight,
          iconWidth: iconBox.width,
          iconHeight: iconBox.height,
        };
      }),
    );
    assert.deepEqual(
      resourceStyles[0],
      resourceStyles[1],
      'Footprint and Model fields use the same geometry and typography.',
    );
    assert.equal(await page.getByRole('button', { name: 'Add STEP file', exact: true }).count(), 0);
    assert.equal(
      await page.locator('.property-field').evaluateAll((rows) => {
        const i = rows.findIndex((r) => r.querySelector('[aria-label="Browse footprints"]'));
        return rows[i + 1]?.querySelector('[aria-label="Browse models"]') !== null;
      }),
      true,
    );
  }
  await page.getByRole('button', { name: 'Browse footprints', exact: true }).click();
  const footprintDialog = page.locator('.library-chooser');
  await footprintDialog.locator('.footprint-preview').waitFor({ timeout: 60000 });
  await footprintDialog.getByText('Pads', { exact: true }).waitFor();
  await page.screenshot({ path: 'test-results/assignment-preview-footprint-2d.png' });
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');
  await page.screenshot({path:'test-results/assignment-preview-footprint-dark.png'});
  await page.evaluate(()=>delete document.documentElement.dataset.theme);
  await footprintDialog.getByRole('button', { name: '3D model', exact: true }).click();
  await footprintDialog
    .getByRole('button', { name: 'Fit model preview', exact: true })
    .waitFor({ timeout: 60000 });
  const footprintLayout = await chooserLayout(footprintDialog);
  assert.equal(
    await footprintDialog.locator('.dialog-footer .primary').textContent(),
    'Assign',
  );
  await page.screenshot({ path: 'test-results/assignment-preview-footprint-3d.png' });
  await footprintDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  assert.equal(
    await page.evaluate(() => window.nativePCB()),
    before,
    'Browsing does not change native data.',
  );
  await browse().click();
  const modelChooser = page.getByRole('dialog', { name: 'Choose component model', exact: true });
  await modelChooser.getByRole('textbox', { name: 'Search models', exact: true }).waitFor();
  await modelChooser.getByRole('button', { name: 'Fit model preview', exact: true }).waitFor({ timeout: 60000 });
  assert.deepEqual(
    await chooserLayout(modelChooser),
    footprintLayout,
    'Both choosers align the header, filters, results, details, preview, cards and footer.',
  );
  assert.equal(await modelChooser.locator('.dialog-footer button').count(), 1);
  assert.equal(await modelChooser.locator('.dialog-footer .primary').textContent(), 'Use model');
  await modelChooser.getByRole('button', { name: 'Footprint', exact: true }).click();
  await modelChooser.locator('.footprint-preview').waitFor();
  await modelChooser.getByRole('button', { name: '3D model', exact: true }).click();
  await modelChooser.getByRole('button', { name: 'Fit model preview', exact: true }).waitFor();
  await page.screenshot({ path: 'test-results/assignment-preview-dialog.png' });
  await modelChooser.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await manage().press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Component models', exact: true });
  await dialog
    .getByRole('button', { name: 'Fit model preview', exact: true })
    .waitFor({ timeout: 60000 });
  assert.equal(await dialog.locator('canvas').count(), 1);
  await page.screenshot({ path: 'test-results/assignment-preview-model.png' });
  const requestsBefore = previewRequests;
  await page.evaluate(() => {
    window.originalPreviewCanvas = document.querySelector('.component-model-preview canvas');
  });
  await dialog.getByText('Placement', { exact: true }).click();
  const opacity = dialog.getByRole('spinbutton', { name: 'Opacity (%)', exact: true });
  await opacity.fill('45');
  await opacity.press('Enter');
  await page.waitForFunction(
    (id) => window.current().pcb.footprints.find((f) => f.id === id).models[0].opacity === 0.45,
    selectedFootprint.id,
  );
  await dialog.getByRole('button', { name: 'Fit model preview', exact: true }).click();
  assert.equal(
    await page.evaluate(
      () =>
        window.originalPreviewCanvas === document.querySelector('.component-model-preview canvas'),
    ),
    true,
    'Accepted placement settings retain the scene and camera.',
  );
  assert.equal(previewRequests, requestsBefore, 'Placement does not reparse model geometry.');
  const offset = dialog.getByRole('spinbutton', { name: 'Offset X (mm)', exact: true });
  await offset.dispatchEvent('compositionstart');
  await offset.fill('5');
  await offset.press('Enter');
  assert.equal(
    await page.evaluate(() => window.historyDepth()),
    1,
    'Composing Enter cannot apply placement.',
  );
  await offset.dispatchEvent('compositionend');
  await offset.press('Escape');
  await page.evaluate(() => window.undoFixture());
  await page.waitForFunction(() => window.historyDepth() === 0);
  assert.equal(await page.evaluate(() => window.nativePCB()), before);
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.screenshot({ path: 'test-results/assignment-preview-model-dark.png' });
  await page.setViewportSize({ width: 560, height: 800 });
  const fits = await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  assert.equal(fits, true, 'The model browser fits a narrow window.');
  await page.screenshot({ path: 'test-results/assignment-preview-model-narrow.png' });
  await page.setViewportSize({ width: 1120, height: 900 });
  await page.evaluate(() => delete document.documentElement.dataset.theme);
  await dialog.getByRole('button', { name: 'Choose library model 1', exact: true }).click();
  await footprintDialog
    .getByRole('button', { name: 'Fit model preview', exact: true })
    .waitFor({ timeout: 60000 });
  assert.equal(await modelChooser.locator('.dialog-footer button').count(), 1);
  const modelSelect = footprintDialog.getByRole('combobox', { name: '3D model', exact: true });
  await modelSelect.click();
  await modelSelect.press('End');
  await modelSelect.press('Enter');
  await footprintDialog
    .getByRole('button', { name: 'Fit model preview', exact: true })
    .waitFor({ timeout: 60000 });
  await footprintDialog.getByRole('button', { name: 'Use model', exact: true }).click();
  await modelChooser.getByText('Temporary assignment failure', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.nativePCB()), before);
  await modelChooser.getByRole('button', { name: 'Use model', exact: true }).click();
  await page.waitForFunction(() => window.historyDepth() === 1);
  assert.equal(
    libraryImports.at(-1).index,
    1,
    'Library assignment uses the model currently selected in the preview.',
  );
  await page.evaluate(() => window.undoFixture());
  await page.waitForFunction(() => window.historyDepth() === 0);
  failNextPreview = true;
  await dialog.getByRole('button', { name: 'Browse STEP for model 1', exact: true }).click();
  await page.waitForFunction((hash) => window.nativePCB().includes(hash + '.step'), modelHash);
  await dialog.getByRole('button', { name: 'Retry preview', exact: true }).waitFor();
  await dialog.getByRole('button', { name: 'Retry preview', exact: true }).click();
  await dialog
    .getByRole('button', { name: 'Fit model preview', exact: true })
    .waitFor({ timeout: 60000 });
  assert.equal(await page.evaluate(() => window.historyDepth()), 1);
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  for (const view of ['Schematic', 'Layout', 'Model']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    assert.ok((await manage().textContent()).includes(modelHash));
  }
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal(await page.evaluate(() => window.nativePCB()), before);
  await manage().click();
  await page.evaluate(() => {
    window.openpe.chooseComponentModel = () =>
      new Promise((resolve) => {
        window.finishModelPick = resolve;
      });
  });
  await dialog.getByRole('button', { name: 'Browse STEP for model 1', exact: true }).click();
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.evaluate(() =>
    window.finishModelPick({ path: '${KIPRJMOD}/models/' + 'c'.repeat(64) + '.step' }),
  );
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(
    await page.evaluate(() => window.nativePCB()),
    before,
    'Closing the model browser rejects a late picker result.',
  );
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/assignment-preview-main.png' });
  offlineCatalog = true;
  const importsBefore = libraryImports.length;
  for (const id of ['NextPCB:123_fixture', 'JLCPCB:C7593']) {
    await page.evaluate((id) => window.setOnlinePackage(id), id);
    await page.getByRole('button', { name: 'Browse footprints', exact: true }).click();
    assert.equal(await footprintDialog.locator('.library-detail-id').textContent(), id);
    await footprintDialog.locator('.footprint-preview').waitFor();
    await footprintDialog.getByRole('button', { name: '3D model', exact: true }).click();
    await footprintDialog.getByRole('button', { name: 'Fit model preview', exact: true }).waitFor();
    await footprintDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
    await browse().click();
    assert.equal(await modelChooser.locator('.library-detail-id').textContent(), id);
    await modelChooser.getByRole('button', { name: 'Use model', exact: true }).click();
    await modelChooser.waitFor({ state: 'hidden' });
  }
  assert.deepEqual(offlineCatalogRequests, []);
  assert.equal(libraryImports.length, importsBefore, 'Already verified project models need no catalog import.');
  assert.deepEqual(errors, []);
  console.log(
    'PASS: actual STEP previews in both choosers, 2D/3D switching, placement scene retention, IME guard, responsive layout, shared fields, native model assignment and undo.',
  );
} finally {
  await browser.close();
  server.close();
}
