import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
const source = await readFile('lib/emc-flyback-example.json', 'utf8');
const bundle = await build({
  stdin: {
    contents: `
import React,{useState,useSyncExternalStore} from 'react';import {createRoot} from 'react-dom/client';
import ComponentProperties from './components/ComponentProperties';import {ProjectCore} from './core/project-core';import {parseProject,projectNativeFiles} from './lib/project';
const core=new ProjectCore(parseProject(${JSON.stringify(source)}));const original=core.getSnapshot().project.pcb.footprints.find(f=>f.symbolId&&f.models?.length);const id=original.id;
window.openpe={chooseComponentModel:async()=>({path:'\${KIPRJMOD}/models/'+ 'b'.repeat(64)+'.step'}),inspectSpiceModel:async()=>null};
window.current=()=>core.getSnapshot().project;window.historyDepth=()=>core.getSnapshot().undoDepth;
window.nativePCB=()=>projectNativeFiles(core.getSnapshot().project).files.find(f=>f.name.endsWith('.kicad_pcb')).source;
function Fixture(){const snapshot=useSyncExternalStore(core.subscribe,core.getSnapshot);const [view,setView]=useState('Schematic');const project=snapshot.project;return <><nav>{['Schematic','Layout','Model'].map(v=><button key={v} onClick={()=>setView(v)}>{v}</button>)}<button onClick={()=>core.undo()}>Undo</button></nav><div className="layout-properties" data-mode={view}><ComponentProperties key={view} footprint={project.pcb.footprints.find(f=>f.id===id)} schematic={project.schematic} active resetKey snap={v=>v} fileId="00000000-0000-4000-8000-000000000001" getRevision={()=>core.getSnapshot().revision} onFootprint={next=>core.replaceBoard({...project.pcb,footprints:project.pcb.footprints.map(f=>f.id===id?next:f)})} onSavePartProperties={()=>true}/></div></>;}createRoot(document.getElementById('root')).render(<Fixture/>);
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
  const page = await browser.newPage({ viewport: { width: 720, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('http://localhost/**', (r) =>
    r.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({ content: '#root{padding:20px}.layout-properties{width:340px}' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const browse = () => page.getByRole('button', { name: 'Browse models', exact: true });
  await browse().waitFor();
  const before = await page.evaluate(() => window.nativePCB());
  for (const view of ['Schematic', 'Layout', 'Model']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    await browse().waitFor();
    const model = page.getByLabel('Model', { exact: true }),
      footprint = page.getByRole('button', { name: 'Browse footprints', exact: true });
    assert.equal(await footprint.count(), 1);
    assert.equal(await model.count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Add STEP file', exact: true }).count(), 0);
    assert.equal(
      await page.locator('.property-field').evaluateAll((rows) => {
        const i = rows.findIndex((r) => r.querySelector('[aria-label="Browse footprints"]'));
        return rows[i + 1]?.querySelector('[aria-label="Browse models"]') !== null;
      }),
      true,
    );
  }
  await browse().click();
  const dialog = page.getByRole('dialog', { name: 'Component models', exact: true });
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Browse STEP for model 1', exact: true }).click();
  await page.waitForFunction(() => window.nativePCB().includes('b'.repeat(64) + '.step'));
  assert.equal(await page.evaluate(() => window.historyDepth()), 1);
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  for (const view of ['Schematic', 'Layout', 'Model']) {
    await page.getByRole('button', { name: view, exact: true }).click();
    assert.ok(
      (await page.getByLabel('Model', { exact: true }).inputValue()).includes('b'.repeat(64)),
    );
  }
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  assert.equal(await page.evaluate(() => window.nativePCB()), before);
  await browse().click();
  await dialog.waitFor();
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
  await page.screenshot({ path: 'test-results/component-properties-main.png' });
  await browse().click();
  await page.getByRole('dialog', { name: 'Component models', exact: true }).waitFor();
  await page.screenshot({ path: 'test-results/component-properties-model-dialog.png' });
  assert.deepEqual(errors, []);
  console.log(
    'PASS: shared fields in all three modes, Model directly below Footprint, details only in secondary dialog, native model assignment and whole-project undo.',
  );
} finally {
  await browser.close();
}
