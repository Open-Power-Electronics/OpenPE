// Isolated original review workflow fixture; no Electron, providers, grants or native writes.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { waitForAsync } from './async-browser-test-helpers.mjs';

const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const board = createEmptyPCB();
board.id = 'review-board';
board.nets = [
  { id: 'switch', name: 'SWITCH' },
  { id: 'sense', name: 'SENSE' },
  { id: 'return', name: 'RETURN' },
  { id: 'supply', name: 'SUPPLY' },
];
board.graphics = [
  [
    [0, 0],
    [60, 0],
  ],
  [
    [60, 0],
    [60, 60],
  ],
  [
    [60, 60],
    [0, 60],
  ],
  [
    [0, 60],
    [0, 0],
  ],
].map(([a, b], index) => ({
  id: 'edge-' + index,
  start: { x: a[0], y: a[1] },
  end: { x: b[0], y: b[1] },
  layer: 'Edge.Cuts',
  width: 0.05,
}));
board.tracks = [
  {
    id: 'track',
    start: { x: 1, y: 4 },
    end: { x: 25, y: 4 },
    width: 0.5,
    layer: 'F.Cu',
    netId: 'switch',
  },
  {
    id: 'branch',
    start: { x: 25, y: 4 },
    end: { x: 25, y: 12 },
    width: 0.5,
    layer: 'F.Cu',
    netId: 'switch',
  },
  {
    id: 'sensitive',
    start: { x: 3, y: 5 },
    end: { x: 23, y: 5 },
    width: 0.3,
    layer: 'F.Cu',
    netId: 'sense',
  },
];
board.vias = [
  { id: 'signal-via', x: 25, y: 12, diameter: 0.8, drill: 0.4, netId: 'switch' },
  { id: 'return-via', x: 50, y: 50, diameter: 0.8, drill: 0.4, netId: 'return' },
];
const pad = (id, number, netId, x = 0) => ({
  id,
  number,
  netId,
  x,
  y: 0,
  rotation: 0,
  type: 'smd',
  shape: 'rect',
  size: { x: 1, y: 1 },
});
const footprint = (id, reference, x, y, pads) => ({
  id,
  reference,
  libraryId: 'Fixture:Package',
  x,
  y,
  rotation: 0,
  side: 'front',
  pads,
  graphics: [],
});
board.footprints = [
  footprint('device', 'U1', 10, 10, [
    pad('target', '1', 'supply'),
    pad('device-return', '2', 'return', 2),
  ]),
  footprint('capacitor', 'C1', 40, 20, [
    pad('cap-supply', '1', 'supply'),
    pad('cap-return', '2', 'return', 2),
  ]),
  footprint('connector', 'J1', 30, 30, [pad('connector-pad', '1', 'switch')]),
];
board.zones = [
  {
    id: 'unfilled',
    layer: 'B.Cu',
    netId: 'return',
    fillEnabled: true,
    outline: [
      { x: 0, y: 0 },
      { x: 60, y: 0 },
      { x: 60, y: 60 },
      { x: 0, y: 60 },
    ],
    minThickness: 0.25,
    clearance: 0.2,
    thermalGap: 0.3,
    thermalBridge: 0.3,
  },
];
const bundle = await build({
  stdin: {
    contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';
import EmcAnalysisPanel from './plugins/emc-analysis/renderer/EmcAnalysisPanel';
import {reviewEmcLayout} from './plugins/emc-analysis/domain/review';
window.requests=[];window.located=[];window.closes=0;window.allowLocate=true;
const host={query:(id,args,options)=>new Promise((resolve,reject)=>window.requests.push({id,args,options,board:window.board,resolve,reject}))};
window.reply=(index,patch={})=>{const request=window.requests[index];request.resolve({boardId:request.board.id,revision:Number(request.options.expectedRevision),result:reviewEmcLayout(request.board,request.args),...patch});};
function Fixture(){const[state,setState]=useState({revision:1,board:window.fixtureBoard,visible:true,selectedNetId:'switch'});window.board=state.board;window.updatePanel=patch=>setState(current=>({...current,...patch}));
return state.visible&&<EmcAnalysisPanel {...state} host={host} onLocate={id=>{window.located.push(id);return window.allowLocate;}} onClose={()=>{window.closes++;setState(current=>({...current,visible:false}));}}/>;}
window.root=createRoot(document.getElementById('root'));window.root.render(<Fixture/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  outfile: 'emc-panel-test.js',
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
  const page = await browser.newPage({ viewport: { width: 400, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<div id="root"></div>');
  await page.evaluate((board) => {
    window.fixtureBoard = board;
    window.reportBlobs = [];
    window.downloadNames = [];
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      window.reportBlobs.push(blob);
      return create(blob);
    };
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) {
        window.downloadNames.push(this.download);
        return;
      }
      return click.call(this);
    };
  }, board);
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({
    content:
      'html,body,#root{height:100%;margin:0}#root{display:flex;padding:12px;box-sizing:border-box}',
  });
  for (const output of bundle.outputFiles)
    if (output.path.endsWith('.css')) await page.addStyleTag({ content: output.text });
    else if (output.path.endsWith('.js')) await page.addScriptTag({ content: output.text });
  const panel = page.getByRole('region', { name: 'EMC Analysis', exact: true });
  const check = panel.locator('.emc-check-button');
  const close = panel.getByRole('button', { name: 'Close EMC Analysis', exact: true });
  const frames = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  const requests = () => page.evaluate(() => window.requests.length);
  const waitRequests = (count) =>
    waitForAsync(page, (count) => window.requests.length === count, count);
  const reply = (index) => page.evaluate((index) => window.reply(index), index);
  const update = async (patch) => {
    await page.evaluate((patch) => window.updatePanel(patch), patch);
    await frames();
  };
  const tab = (name) => panel.getByRole('tab', { name, exact: true });
  async function choose(label, name) {
    const trigger = panel.getByRole('combobox', { name: label, exact: true });
    await trigger.scrollIntoViewIfNeeded();
    await frames();
    await trigger.click();
    const popup = page.getByRole('listbox', { name: label, exact: true });
    await popup.waitFor();
    const [a, b] = await Promise.all([trigger.boundingBox(), popup.boundingBox()]);
    assert.ok(
      a && b && Math.abs(a.width - b.width) <= 1,
      'Every field popup matches its trigger width.',
    );
    await popup.getByRole('option', { name, exact: true }).click();
  }
  await panel.waitFor();
  await tab('Setup').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await tab('Findings').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Home');
  assert.equal(await tab('Setup').getAttribute('aria-selected'), 'true');
  assert.equal(await requests(), 0);
  assert.equal(await check.isDisabled(), true, 'Selection alone does not infer a net role.');
  assert.equal(await panel.getByText('Switching source', { exact: true }).count(), 0);
  assert.equal(
    await panel.getByRole('combobox', { name: 'PCB net', exact: true }).innerText(),
    'SWITCH',
  );
  await choose('Reference net', 'RETURN');
  await choose('Reference copper layer', 'B.Cu');
  await panel.getByRole('button', { name: 'Add net', exact: true }).click();
  await choose('PCB net', 'SENSE');
  await choose('Net role', 'Sensitive signal');
  await choose('Reference net', 'Unspecified');
  await choose('Reference copper layer', 'Unspecified');
  await panel.getByRole('button', { name: 'Add net', exact: true }).click();
  const connections = panel
    .locator('details')
    .filter({ has: page.locator('summary').filter({ hasText: /^Connections$/ }) });
  await connections.locator('summary').click();
  await choose('Edge connector', 'J1');
  await panel.getByRole('button', { name: 'Add connector', exact: true }).click();
  await choose('Device supply pad', 'U1 · Pad 1 · SUPPLY');
  await choose('Capacitor package', 'C1');
  await choose('Decoupling return net', 'RETURN');
  await panel.getByRole('button', { name: 'Add assignment', exact: true }).click();
  const limits = panel
    .locator('details')
    .filter({ has: page.locator('summary').filter({ hasText: /^Engineering limits$/ }) });
  await limits.locator('summary').click();
  const length = panel.getByRole('textbox', { name: 'Total track length', exact: true });
  await length.fill('0');
  assert.equal(await check.isDisabled(), true);
  assert.equal(await length.inputValue(), '0');
  await length.fill('20');
  await panel.getByRole('textbox', { name: 'Via count', exact: true }).fill('0');
  await mkdir('test-results/emc-panel', { recursive: true });
  await page.screenshot({ path: 'test-results/emc-panel/review-setup.png' });
  await check.click();
  await waitRequests(1);
  await check.click({ force: true });
  assert.equal(await requests(), 1);
  assert.deepEqual(
    await page.evaluate(() => ({
      id: window.requests[0].id,
      revision: window.requests[0].options.expectedRevision,
      nets: window.requests[0].args.nets.length,
      decoupling: window.requests[0].args.decoupling.length,
      connectors: window.requests[0].args.edgeConnectorIds,
    })),
    { id: 'emc.reviewLayout', revision: '1', nets: 2, decoupling: 1, connectors: ['connector'] },
  );
  await reply(0);
  const results = panel.getByLabel('Layout review results', { exact: true });
  await results.waitFor();
  assert.equal(await tab('Findings').getAttribute('aria-selected'), 'true');
  assert.ok((await panel.locator('.emc-finding').count()) > 2);
  const locate = panel.getByRole('button', { name: 'Locate finding object', exact: true });
  await locate.click();
  assert.ok((await page.evaluate(() => window.located.length)) > 0);
  await page.evaluate(() => (window.allowLocate = false));
  await locate.click();
  await panel.getByRole('alert').filter({ hasText: 'Check pending edits' }).waitFor();
  await page.evaluate(() => (window.allowLocate = true));
  await locate.click();
  await choose('Finding severity', 'Not verified');
  assert.ok((await panel.locator('.emc-finding').count()) > 0);
  assert.equal(await panel.locator('.emc-finding.emc-warning').count(), 0);
  await choose('Finding severity', 'Warnings');
  await panel.locator('.emc-finding').first().click();
  const exception = panel.locator('.emc-exception');
  await exception.locator('summary').click();
  const reason = exception.getByRole('textbox', { name: 'Exception reason', exact: true });
  await reason.fill('Reviewed operating mode and layout evidence for this occurrence.');
  await choose('Finding severity', 'Not verified');
  await choose('Finding severity', 'Warnings');
  assert.equal(
    await reason.inputValue(),
    'Reviewed operating mode and layout evidence for this occurrence.',
    'Unrecorded justification survives filtering and occurrence changes.',
  );
  await exception.getByRole('button', { name: 'Record exception', exact: true }).click();
  assert.ok((await panel.getByText('Exception recorded', { exact: true }).count()) > 0);
  await tab('Checklist').click();
  const manual = panel.locator('.emc-checklist > details').first();
  await manual.locator('summary').click();
  const title = await manual.locator('summary').innerText();
  const status = manual.getByRole('combobox');
  await status.scrollIntoViewIfNeeded();
  await frames();
  await status.click();
  await page.getByRole('listbox').getByRole('option', { name: 'Reviewed', exact: true }).click();
  await manual.getByRole('textbox').fill('Board drawing and operating-state review recorded.');
  await panel.getByRole('button', { name: 'Export JSON report', exact: true }).click();
  await panel.getByRole('button', { name: 'Export HTML report', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.downloadNames), [
    'emc-review.json',
    'emc-review.html',
  ]);
  const exported = await page.evaluate(async () => ({
    json: JSON.parse(await window.reportBlobs[0].text()),
    html: await window.reportBlobs[1].text(),
  }));
  assert.equal(exported.json.exceptions.length, 1);
  assert.equal(exported.json.manualReviews.length, 8);
  assert.equal(exported.json.manualReviews.filter((item) => item.status === 'reviewed').length, 1);
  assert.ok(exported.html.includes('Board drawing and operating-state review recorded.'));
  await tab('Findings').click();
  await panel.locator('.emc-finding').first().scrollIntoViewIfNeeded();
  await frames();
  await page.screenshot({ path: 'test-results/emc-panel/review-findings.png' });
  await page.setViewportSize({ width: 280, height: 800 });
  await frames();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.ok(
    await panel
      .locator('.emc-analysis-body')
      .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
  );
  await choose('Finding severity', 'All findings');
  await page.screenshot({ path: 'test-results/emc-panel/review-narrow.png' });
  await update({ revision: 2 });
  assert.equal(await panel.getByLabel('Layout review results', { exact: true }).count(), 0);
  assert.equal(
    await panel.getByRole('button', { name: 'Export JSON report', exact: true }).isDisabled(),
    true,
  );
  await tab('Setup').click();
  await check.click();
  await waitRequests(2);
  await limits.locator('summary').click();
  await length.fill('21');
  assert.equal(await page.evaluate(() => window.requests[1].options.signal.aborted), true);
  await reply(1);
  await frames();
  assert.equal(await panel.getByLabel('Layout review results', { exact: true }).count(), 0);
  await check.click();
  await waitRequests(3);
  await page.evaluate(() => window.requests[2].reject(new Error('Fixture review failed.')));
  await panel.getByText('Fixture review failed.', { exact: true }).waitFor();
  assert.equal(await check.innerText(), 'Retry');
  await check.click();
  await waitRequests(4);
  await reply(3);
  await results.waitFor();
  await panel.locator('.emc-exception > summary').click();
  assert.equal(
    await panel.getByRole('textbox', { name: 'Exception reason', exact: true }).inputValue(),
    '',
    'A fresh result does not inherit a previous justification draft.',
  );
  assert.equal(
    await panel.getByText('Exception recorded', { exact: true }).count(),
    0,
    'Reruns clear prior exceptions.',
  );
  await tab('Checklist').click();
  assert.equal(
    await panel
      .locator('.emc-manual-status')
      .filter({ hasText: /^Reviewed$/ })
      .count(),
    0,
  );
  const first = panel.locator('.emc-checklist > details').first();
  await first.locator('summary').click();
  const notes = first.getByRole('textbox');
  await notes.focus();
  await notes.dispatchEvent('compositionstart');
  await close.click({ force: true });
  await panel
    .getByRole('button', { name: 'Export JSON report', exact: true })
    .click({ force: true });
  assert.equal(await page.evaluate(() => window.closes), 0);
  assert.equal(await page.evaluate(() => window.downloadNames.length), 2);
  await notes.dispatchEvent('compositionend');
  await close.focus();
  await close.dispatchEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    keyCode: 229,
    bubbles: true,
  });
  assert.equal(await page.evaluate(() => window.closes), 0);
  await notes.fill('Manual evidence before a retryable recheck.');
  await tab('Setup').click();
  await check.click();
  await waitRequests(5);
  await page.evaluate(() => window.reply(4, { boardId: 'different-board' }));
  await panel
    .getByRole('alert')
    .filter({ hasText: 'no longer matches this PCB revision' })
    .waitFor();
  assert.equal(await results.count(), 0);
  assert.equal(
    await panel.getByRole('button', { name: 'Export JSON report', exact: true }).isDisabled(),
    true,
  );
  await check.click();
  await waitRequests(6);
  await page.evaluate(() => window.reply(5, { revision: 99 }));
  await panel
    .getByRole('alert')
    .filter({ hasText: 'no longer matches this PCB revision' })
    .waitFor();
  await check.click();
  await waitRequests(7);
  await page.evaluate(() => window.reply(6, { result: { completeness: 'partial' } }));
  await panel.getByRole('alert').filter({ hasText: 'Invalid EMC review result' }).waitFor();
  assert.equal(await results.count(), 0);
  await check.click();
  await waitRequests(8);
  await reply(7);
  await results.waitFor();
  await tab('Setup').click();
  await check.click();
  await waitRequests(9);
  await close.click();
  assert.equal(await page.evaluate(() => window.requests[8].options.signal.aborted), true);
  await reply(8);
  await frames();
  assert.equal(await panel.count(), 0);
  assert.deepEqual(errors, []);
  assert.equal(
    await page.evaluate(() => window.requests.every((item) => item.id === 'emc.reviewLayout')),
    true,
  );
  console.log(
    'EMC review UI passed: explicit intent/connections, findings/filter/locate, checklist/exceptions/report exports, revision/cancellation/retry/IME, narrow layout and equal-width menus.',
  );
} finally {
  await browser.close();
}
