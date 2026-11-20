// Isolated panel lifecycle checks; delayed capability fixtures never run a solver or write a design.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundle = await build({
  stdin: {
    contents: `import React,{useRef,useState}from'react';import{createRoot}from'react-dom/client';
import LayoutParasiticsPanel from './plugins/layout-parasitics/renderer/LayoutParasiticsPanel';
const board={id:'board',nets:[{id:'net',name:'SIGNAL'},{id:'other',name:'OTHER'}],vias:[],footprints:[{id:'footprint',reference:'J1',libraryId:'Fixture:Pads',pads:[{id:'a',number:'1',netId:'net'},{id:'b',number:'2',netId:'net'},{id:'c',number:'3',netId:'other'}]}]};
window.requests=[];window.executions=[];window.added=[];window.clears=0;
const host={query:(id,args,options)=>new Promise((resolve,reject)=>window.requests.push({id,args,options,resolve,reject})),execute:(id,args,options)=>new Promise((resolve,reject)=>window.executions.push({id,args,options,resolve,reject}))};
function Fixture(){const [state,setState]=useState({board,schematicId:'schematic',revision:1,startId:'a',endId:undefined,visible:true});const composing=useRef(false);
window.updatePanel=patch=>setState(current=>({...current,...patch}));
return state.visible&&<LayoutParasiticsPanel {...state} schematic={{parts:[]}} host={host} composing={composing} onReset={()=>{window.clears++;setState(current=>({...current,startId:undefined,endId:undefined}))}} onClose={()=>setState(current=>({...current,visible:false}))} onAdded={id=>window.added.push(id)}/>;}
createRoot(document.getElementById('root')).render(<Fixture/>);`,
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
  const page = await browser.newPage({ viewport: { width: 420, height: 720 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<div id="root"></div>');
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({
    content:
      'html,body,#root{height:100%;margin:0}#root{display:flex;padding:12px;box-sizing:border-box}',
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const panel = page.getByRole('region', { name: 'Layout Parasitics', exact: true });
  await panel.waitFor();
  const copper = panel.getByRole('textbox', { name: 'Copper thickness', exact: true });
  const clear = panel.getByRole('button', { name: 'Clear selected terminals', exact: true });
  const create = panel.getByRole('button', { name: 'Add parasitic components', exact: true });
  const close = panel.getByRole('button', { name: 'Close Layout Parasitics', exact: true });
  const values = panel.locator('.layout-parasitics-results dd');
  const frames = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  const requests = () => page.evaluate(() => window.requests.length);
  const update = async (patch) => {
    await page.evaluate((patch) => window.updatePanel(patch), patch);
    await frames();
  };
  const waitRequests = (count) =>
    page.waitForFunction((count) => window.requests.length === count, count);
  const reply = (index, result = {}) =>
    page.evaluate(
      ({ index, result }) =>
        window.requests[index].resolve({
          shortestLengthMm: 10,
          equivalentResistanceOhm: 0.001,
          shortestPartialInductanceNh: 5,
          ...result,
        }),
      { index, result },
    );
  await frames();
  assert.equal(await requests(), 0, 'A single terminal cannot measure.');
  assert.equal(await create.isDisabled(), true, 'No measurement can add components.');
  assert.equal(await panel.getByRole('button', { name: 'Measure', exact: true }).count(), 0);
  for (const endId of ['a', 'c', 'missing']) {
    await update({ endId });
    assert.equal(
      await requests(),
      0,
      'Duplicate, different-net and missing terminals cannot measure.',
    );
  }
  await update({ endId: 'b' });
  await waitRequests(1);
  await panel.getByRole('img', { name: 'Measuring…', exact: true }).waitFor();
  assert.equal(await create.isDisabled(), true, 'A pending measurement cannot create a study.');
  assert.equal(await panel.getByRole('status').getAttribute('aria-busy'), 'true');
  assert.deepEqual(
    await page.evaluate(() => ({
      id: window.requests[0].id,
      args: window.requests[0].args,
      revision: window.requests[0].options.expectedRevision,
    })),
    {
      id: 'parasitics.measure',
      args: {
        boardId: 'board',
        startId: 'a',
        endId: 'b',
        copperThicknessMm: 0.035,
        viaPlatingMm: 0.025,
      },
      revision: '1',
    },
  );
  await reply(0);
  await panel.getByText('1.000 mΩ', { exact: true }).waitFor();
  assert.equal(await create.isEnabled(), true);
  await copper.fill('0.07');
  await waitRequests(2);
  await copper.fill('0.1');
  await waitRequests(3);
  assert.equal(await page.evaluate(() => window.requests[1].options.signal.aborted), true);
  await reply(1);
  await frames();
  assert.deepEqual(
    await values.allTextContents(),
    ['—', '—', '—'],
    'A cancelled response cannot publish into a new measurement.',
  );
  await reply(2);
  await panel.getByText('1.000 mΩ', { exact: true }).waitFor();
  await copper.fill('0');
  await frames();
  assert.equal(await requests(), 3);
  assert.equal(await copper.getAttribute('aria-invalid'), 'true');
  assert.equal(await create.isDisabled(), true, 'Invalid geometry cannot export old results.');
  assert.deepEqual(await values.allTextContents(), ['—', '—', '—']);
  assert.equal(await create.isDisabled(), true);
  await copper.fill('0.06');
  await waitRequests(4);
  await copper.dispatchEvent('compositionstart');
  await copper.fill('0.08');
  await frames();
  assert.equal(await requests(), 4, 'Composition cannot start an automatic calculation.');
  assert.equal(await page.evaluate(() => window.requests[3].options.signal.aborted), true);
  await clear.dispatchEvent('click');
  assert.equal(
    await page.evaluate(() => window.clears),
    0,
    'Composition cannot clear terminal picks.',
  );
  await copper.dispatchEvent('compositionend');
  await waitRequests(5);
  assert.equal(
    await clear.evaluate((button) => {
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        keyCode: 229,
        bubbles: true,
        cancelable: true,
      });
      button.dispatchEvent(event);
      return event.defaultPrevented;
    }),
    true,
  );
  await page.evaluate(() =>
    window.requests[4].reject(new Error('Fixture disconnected terminals.')),
  );
  await panel.getByRole('alert').filter({ hasText: 'Fixture disconnected terminals.' }).waitFor();
  await frames();
  assert.equal(await requests(), 5, 'A failed query does not create a retry loop.');
  await copper.fill('0.09');
  await waitRequests(6);
  await clear.click();
  await frames();
  assert.equal(await page.evaluate(() => window.requests[5].options.signal.aborted), true);
  await reply(5);
  await frames();
  assert.deepEqual(await values.allTextContents(), ['—', '—', '—']);
  await update({ startId: 'a', endId: 'b' });
  await waitRequests(7);
  await update({ revision: 2 });
  assert.equal(await page.evaluate(() => window.requests[6].options.signal.aborted), true);
  assert.equal(
    await requests(),
    7,
    'A new revision cannot automatically measure its old terminal picks.',
  );
  await reply(6);
  await frames();
  assert.deepEqual(await values.allTextContents(), ['—', '—', '—']);
  await update({ startId: undefined, endId: undefined });
  await update({ startId: 'a', endId: 'b' });
  await waitRequests(8);
  await reply(7);
  await panel.getByText('1.000 mΩ', { exact: true }).waitFor();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/layout-parasitics-automatic.png' });
  await copper.fill('0.1');
  await waitRequests(9);
  await close.click();
  assert.equal(await page.evaluate(() => window.requests[8].options.signal.aborted), true);
  await reply(8);
  await frames();
  assert.equal(await panel.count(), 0);

  // A new dock instance starts with its own input drafts and action lifecycle.
  await update({ visible: true, startId: 'a', endId: 'b' });
  await waitRequests(10);
  await reply(9);
  await panel.getByText('1.000 mΩ', { exact: true }).waitFor();
  await copper.dispatchEvent('compositionstart');
  await create.dispatchEvent('click');
  assert.equal(await page.evaluate(() => window.executions.length), 0);
  assert.equal(await create.isDisabled(), true, 'Composition cannot add schematic components.');
  await copper.dispatchEvent('compositionend');
  await waitRequests(11);
  await reply(10);
  await panel.getByText('1.000 mΩ', { exact: true }).waitFor();
  assert.equal(
    await create.evaluate((button) => {
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        keyCode: 229,
        bubbles: true,
        cancelable: true,
      });
      button.dispatchEvent(event);
      return event.defaultPrevented;
    }),
    true,
    'IME key code 229 cannot activate the creation action.',
  );
  await Promise.all([create.dispatchEvent('click'), create.dispatchEvent('click')]);
  await page.waitForFunction(() => window.executions.length === 1);
  assert.deepEqual(
    await page.evaluate(() => ({
      id: window.executions[0].id,
      args: window.executions[0].args,
      revision: window.executions[0].options.expectedRevision,
    })),
    {
      id: 'parasitics.createStudy',
      args: {
        boardId: 'board',
        schematicId: 'schematic',
        startId: 'a',
        endId: 'b',
        copperThicknessMm: 0.035,
        viaPlatingMm: 0.025,
      },
      revision: '2',
    },
    'Addition sends the existing schematic ID, exact measurement inputs and a revision.',
  );
  assert.equal(await copper.isDisabled(), true);
  assert.equal(await clear.isDisabled(), true);
  assert.equal(await close.isDisabled(), true);
  assert.equal(await create.isDisabled(), true);
  assert.equal(await create.getAttribute('aria-busy'), 'true');
  await update({ revision: 3 });
  assert.equal(await page.evaluate(() => window.executions[0].options.signal.aborted), false);
  await page.evaluate(() =>
    window.executions[0].resolve({ schematicId: 'schematic', revision: '3' }),
  );
  await page.waitForFunction(() => window.added[0] === 'schematic');
  assert.equal(await create.isDisabled(), true, 'The old measurement cannot add a second block.');

  await update({ startId: undefined, endId: undefined });
  await update({ startId: 'a', endId: 'b' });
  await waitRequests(12);
  await reply(11, { shortestPartialInductanceNh: null });
  await panel.getByText('Outside model', { exact: true }).waitFor();
  assert.equal(await create.isEnabled(), true, 'A resolved DC value can add an R-only block.');
  await create.click();
  await page.waitForFunction(() => window.executions.length === 2);
  await page.evaluate(() =>
    window.executions[1].reject(new Error('Fixture study creation failed.')),
  );
  await panel.getByRole('alert').filter({ hasText: 'Fixture study creation failed.' }).waitFor();
  assert.equal(await create.isEnabled(), true, 'A failed write is explicitly retryable.');
  assert.equal(await copper.inputValue(), '0.035', 'Failure keeps the valid parameter draft.');
  await frames();
  assert.equal(
    await page.evaluate(() => window.executions.length),
    2,
    'Failure cannot auto-retry.',
  );
  await copper.fill('0.07');
  await waitRequests(13);
  await reply(12, { equivalentResistanceOhm: 0, shortestPartialInductanceNh: null });
  await panel.getByText('0.000 mΩ', { exact: true }).waitFor();
  assert.equal(
    await create.isDisabled(),
    true,
    'A zero resistance is not a positive passive model.',
  );
  await copper.fill('0.08');
  await waitRequests(14);
  await reply(13);
  await panel.getByText('1.000 mΩ', { exact: true }).waitFor();
  await create.click();
  await page.waitForFunction(() => window.executions.length === 3);
  await update({ visible: false });
  assert.equal(await page.evaluate(() => window.executions[2].options.signal.aborted), true);
  await page.evaluate(() => window.executions[2].resolve({ schematicId: 'late-study' }));
  await frames();
  assert.deepEqual(
    await page.evaluate(() => window.added),
    ['schematic'],
    'Unmounted panels cannot navigate to late results.',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Layout Parasitics panel passed: automatic results, invalid/stale input, exact same-sheet command, duplicate/IME guards, R-only addition, retry, revision delivery and unmount cancellation.',
  );
} finally {
  await browser.close();
}
