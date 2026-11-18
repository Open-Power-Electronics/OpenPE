import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

const [{ createBlankProject }, { createPart }, { parseSExpr }] = await Promise.all([
  tsImport('../lib/create-blank-project.ts', import.meta.url),
  tsImport('../lib/circuit.ts', import.meta.url),
  tsImport('../lib/sexpr.ts', import.meta.url),
]);
const project = createBlankProject();
project.schematic.parts.push(createPart(project.schematic, 'R', 0, 0));
const detail = {
  id: 'NextPCB:123_fixture',
  name: 'Fixture',
  library: 'NextPCB',
  description: 'Package',
  keywords: '',
  pads: ['1', '2'],
  models: [],
  footprint: parseSExpr(`(footprint "123_fixture" (layer "F.Cu")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask"))
    (pad "2" smd rect (at 2.54 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask")))`),
};
const bundle = await build({
  stdin: {
    contents: `import React,{useState,useSyncExternalStore}from'react';
  import{createRoot}from'react-dom/client';import Layout from './components/LayoutEditor';
  import{ProjectCore}from'./core/project-core';import{attachNextPcbFootprint}from'./lib/library-project-assets';
  function Fixture(){const[core]=useState(()=>new ProjectCore(window.fixture));
    const snapshot=useSyncExternalStore(core.subscribe,core.getSnapshot),[active,setActive]=useState(true);
    window.core=core;window.setActive=setActive;
    return <Layout board={snapshot.project.pcb} schematic={snapshot.project.schematic}
      active={active} visible={active} annotationDisabled={snapshot.sourceDraft!==null||snapshot.editingBlocked!==null}
      getRevision={()=>core.getSnapshot().revision} onCommit={(board,source)=>{
        const next=source?attachNextPcbFootprint({...core.getSnapshot().project,pcb:board},source):core.getSnapshot().project;
        return core.replaceBoard(board,next.nativeFiles)}} annotations={[]} annotationSessionId="fixture" onAnnotationsChange={()=>{}}/>}
  createRoot(document.getElementById('root')).render(<Fixture/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const styles = await Promise.all(
  ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'].map((file) =>
    readFile(file, 'utf8'),
  ),
);
const browser = await chromium.launch({
  headless: true,
  channel: process.platform === 'win32' ? 'msedge' : undefined,
});
try {
  for (const mode of ['accept', 'cancel', 'source', 'close']) {
    const page = await browser.newPage({ viewport: { width: 1000, height: 750 } });
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let requests = 0,
      release;
    await page.route('http://localhost/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/libraries/footprints')
        return route.fulfill({
          json: url.searchParams.has('id')
            ? detail
            : { entries: [detail], libraries: ['NextPCB'], total: 1, nextOffset: null },
        });
      if (url.pathname === '/api/library-package') {
        requests++;
        assert.equal(route.request().method(), 'POST');
        await new Promise((resolve) => {
          release = resolve;
        });
        try {
          await route.fulfill({ json: { ...detail, projectAssets: true } });
        } catch {}
        return;
      }
      return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    });
    await page.goto('http://localhost');
    await page.evaluate((fixture) => {
      window.fixture = fixture;
      window.openpe = { connection: async () => ({ base: 'http://localhost', token: 'fixture' }) };
    }, project);
    for (const content of styles) await page.addStyleTag({ content });
    await page.addStyleTag({ content: 'html,body,#root,.layout-editor{height:100%;margin:0}' });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const canvas = page.getByTestId('layout-canvas');
    await canvas.waitFor();
    await canvas.focus();
    await page.getByRole('button', { name: 'Place footprint', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Footprint placement' });
    await dialog.waitFor().catch(async (error) => {
      console.error(errors, await page.locator('body').innerText());
      throw error;
    });
    await dialog.locator('.library-results button').first().click();
    const choose = dialog.getByRole('button', { name: 'Place footprint', exact: true });
    await choose.waitFor();
    await choose.dispatchEvent('keydown', { key: 'Enter', keyCode: 229 });
    await page.waitForTimeout(50);
    assert.equal(requests, 0);
    await choose.click();
    await page.waitForFunction(() => document.activeElement !== null);
    const deadline = Date.now() + 10000;
    while (!release) {
      assert.ok(Date.now() < deadline);
      await page.waitForTimeout(20);
    }
    assert.equal(await page.evaluate(() => window.core.getSnapshot().undoDepth), 0);
    if (mode === 'cancel') await page.keyboard.press('Escape');
    if (mode === 'source') await page.evaluate(() => window.core.updateSource('pending'));
    if (mode === 'close')
      await page.evaluate(() => {
        window.core.setEditingBlocked('Closing');
        window.setActive(false);
      });
    release();
    if (mode === 'accept') {
      await dialog.waitFor({ state: 'hidden' });
      await canvas.hover({ position: { x: 400, y: 300 } });
      await page
        .locator('.is-placement')
        .waitFor()
        .catch(async (error) => {
          console.error(await page.locator('body').innerText());
          throw error;
        });
      await canvas.click({ position: { x: 400, y: 300 } });
      assert.equal(await page.evaluate(() => window.core.getSnapshot().undoDepth), 1);
      assert.equal(
        await page.evaluate(() => window.core.getSnapshot().project.pcb.footprints.length),
        1,
      );
      assert.ok(
        await page.evaluate(() =>
          window.core
            .getNativeFiles()
            .files.some((file) => file.name === 'footprints/NextPCB.pretty/123_fixture.kicad_mod'),
        ),
      );
      await page.evaluate(() => window.core.undo());
    } else {
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => window.core.getSnapshot().undoDepth), 0);
      assert.equal(
        await page.evaluate(() => window.core.getSnapshot().project.pcb.footprints.length),
        0,
      );
      assert.equal(await page.locator('.is-placement').count(), 0);
    }
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(
    'PASS: manual Layout NextPCB preparation, final click, native files/one undo, cancellation and Source/close gates (isolated browser).',
  );
} finally {
  await browser.close();
}
