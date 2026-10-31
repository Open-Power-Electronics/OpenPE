import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

// Real shared Dialog and rule panel, with controlled in-memory reports only.
// No Electron, project state, service, Agent or solver is started.
const { defaultPCBDesignRules: settings } = await tsImport(
  '../lib/design-rule-checks.ts',
  import.meta.url,
);
const report = {
  kind: 'erc',
  complete: true,
  truncated: false,
  checkedRules: ['erc.unconnected-pin', 'erc.pin-conflict'],
  issues: [
    {
      id: 'first',
      ruleId: 'erc.unconnected-pin',
      severity: 'error',
      message: 'R1 pin 1 is unconnected.',
      objectIds: ['part-r1'],
      location: { x: 25.4, y: 20.32 },
    },
    {
      id: 'second',
      ruleId: 'erc.pin-conflict',
      severity: 'warning',
      message: 'U1 and U2 have conflicting output pins.',
      objectIds: ['part-u1', 'part-u2'],
    },
  ],
  notes: ['Checks use the active schematic.'],
};
const clean = { ...report, issues: [] };
const bundle = await build({
  stdin: {
    contents: `import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
      import RuleCheckPanel from './components/RuleCheckPanel';
      function Fixture(){
        const [open,setOpen]=useState(false),[state,setState]=useState({kind:'erc',report:null,...window.fixture});
        window.updateRulePanel=changes=>setState(current=>({...current,...changes}));
        return <main className="editor" style={{height:'100%',padding:12}}>
          <div style={{position:'absolute',top:12,right:12,display:'flex',justifyContent:'flex-end'}}>
            <button onClick={()=>setOpen(true)}>Open checks</button>
          </div>
          {open&&<RuleCheckPanel {...state}
            onDRCSettingsChange={config=>setState(current=>({...current,drcSettings:config,stale:!!current.report}))}
            onRun={config=>window.checkRuns.push(config??null)}
            onSelectIssue={issue=>window.locatedIssues.push(issue.id)}
            onClose={()=>{window.closedPanels++;setOpen(false)}}/>}
        </main>;
      }
      createRoot(document.getElementById('root')).render(<Fixture/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  outdir: 'test-results/rule-check-panel-bundle',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const browser = await chromium.launch({
  headless: true,
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }),
  );
  await page.goto('http://localhost');
  await page.evaluate(() => {
    window.fixture = {};
    window.checkRuns = [];
    window.locatedIssues = [];
    window.closedPanels = 0;
  });
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
    await page.addStyleTag({ content: file.text });
  await page.addStyleTag({ content: 'html,body,#root{height:100%;margin:0}' });
  await page.addScriptTag({
    content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
  });
  const update = (changes) =>
    page.evaluate(async (changes) => {
      window.updateRulePanel(changes);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }, changes);
  const button = (name) => page.getByRole('button', { name, exact: true });
  await button('Open checks').click();
  const erc = page.getByRole('dialog', { name: 'ERC checks', exact: true });
  await erc.waitFor();
  assert.equal(await erc.getAttribute('aria-modal'), 'true');
  assert.equal(await erc.evaluate((dialog) => dialog.matches(':modal')), true);
  const initialERC = await erc.boundingBox();
  assert.equal(Math.round(initialERC.width), 600);
  assert.ok(Math.abs(initialERC.x + initialERC.width / 2 - 640) <= 1);
  assert.ok(Math.abs(initialERC.y + initialERC.height / 2 - 425) <= 1);
  assert.equal(await erc.getByText('Not checked', { exact: true }).isVisible(), true);
  assert.equal(await erc.getByText('No violations found in checked rules.').count(), 0);
  await button('Run ERC').click();
  assert.deepEqual(await page.evaluate(() => window.checkRuns), [null]);

  await update({ report });
  assert.equal(await erc.getByText('1 error', { exact: true }).isVisible(), true);
  assert.equal(await erc.getByText('1 warning', { exact: true }).isVisible(), true);
  assert.equal(
    await button(`Locate issue: ${report.issues[0].message}`).getAttribute('title'),
    'Locate issue',
  );
  await button(`Locate issue: ${report.issues[0].message}`).click();
  assert.deepEqual(await page.evaluate(() => window.locatedIssues), ['first']);
  assert.equal(await erc.locator('details').count(), 0);
  assert.equal(await erc.getByText(report.notes[0], { exact: true }).count(), 0);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/rule-check-panel-erc.png' });

  await update({ stale: true });
  assert.equal(await erc.getByText('Design or limits changed. Recheck ERC.').isVisible(), true);
  assert.equal(await button(`Locate issue: ${report.issues[0].message}`).isDisabled(), true);
  await button('Recheck ERC').click();
  assert.equal(await page.evaluate(() => window.checkRuns.length), 2);
  await update({ busy: true });
  assert.equal(await button('Recheck ERC').isDisabled(), true);
  assert.equal(await button('Close dialog').isDisabled(), true);
  await page.keyboard.press('Escape');
  assert.equal(await erc.isVisible(), true, 'A running check retains its dialog.');
  await update({ busy: false, sourcePending: true, error: 'Fixture check failed.' });
  assert.equal(await erc.getByText('Apply Source edits before checking rules.').isVisible(), true);
  assert.equal(await erc.getByRole('alert').innerText(), 'Fixture check failed.');
  assert.equal(await button('Recheck ERC').isDisabled(), true);
  await update({
    sourcePending: false,
    stale: false,
    error: '',
    report: { ...clean, complete: false },
  });
  assert.equal(await erc.getByText('Incomplete checks.', { exact: true }).isVisible(), true);
  assert.equal(await erc.getByText('No violations found in checked rules.').count(), 0);
  await update({ report: { ...clean, truncated: true } });
  assert.equal(
    await erc.getByText('Incomplete checks: issue list truncated.', { exact: true }).isVisible(),
    true,
  );
  assert.equal(await erc.getByText('No violations found in checked rules.').count(), 0);
  await update({ report: clean });
  await update({ blockedReason: 'Project is closing.' });
  assert.equal(await erc.getByText('Project is closing.', { exact: true }).isVisible(), true);
  assert.equal(await button('Recheck ERC').isDisabled(), true);
  assert.equal(await erc.getByText('No violations found in checked rules.').count(), 0);
  await update({ blockedReason: '' });
  assert.equal(
    await erc.getByText('No violations found in checked rules.', { exact: true }).isVisible(),
    true,
  );
  await update({ busy: true });
  assert.equal(
    await erc.getByText('No violations found in checked rules.').count(),
    0,
    'A new running check does not repeat an earlier clean conclusion.',
  );
  await update({ busy: false, error: 'Recheck failed.' });
  assert.equal(
    await button('Recheck ERC').evaluate((element) => document.activeElement === element),
    true,
    'Finishing a check restores keyboard focus after its action was disabled.',
  );
  assert.equal(
    await erc.getByText('No violations found in checked rules.').count(),
    0,
    'A failed recheck does not repeat an earlier clean conclusion.',
  );
  await update({ error: '' });
  await page.keyboard.press('Escape');
  await erc.waitFor({ state: 'detached' });
  assert.equal(
    await button('Open checks').evaluate((element) => document.activeElement === element),
    true,
  );

  await update({ kind: 'drc', report: { ...clean, kind: 'drc' }, drcSettings: settings });
  await button('Open checks').click();
  const drc = page.getByRole('dialog', { name: 'DRC checks', exact: true });
  const clearance = drc.getByRole('spinbutton', { name: 'Copper clearance (mm)', exact: true });
  await clearance.waitFor();
  assert.equal(await clearance.inputValue(), String(settings.clearance));
  assert.equal(await drc.getByRole('spinbutton').count(), 6);
  for (const invalid of ['', '-0.01', '1000.1']) {
    await clearance.fill(invalid);
    assert.equal(await clearance.getAttribute('aria-invalid'), 'true');
    assert.equal(await button('Recheck DRC').isDisabled(), true);
    assert.equal(
      await drc.getByText('No violations found in checked rules.').count(),
      0,
      'Invalid limits cannot retain a clean conclusion from earlier settings.',
    );
    assert.equal(await drc.getByRole('alert').innerText(), 'Enter each limit from 0 to 1000 mm.');
  }
  await clearance.fill('0.35');
  await button('Recheck DRC').click();
  assert.deepEqual(
    await page.evaluate(() => window.checkRuns.at(-1)),
    { ...settings, clearance: 0.35 },
    'Run receives the complete validated drafts, including the field that just blurred.',
  );
  await update({ drcSettings: { ...settings, clearance: 0.4 }, stale: false });
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="Copper clearance (mm)"]').value === '0.4',
  );
  await update({ busy: true });
  assert.equal(await clearance.isDisabled(), true);
  await update({ busy: false });
  const before = await drc.boundingBox();
  const resize = button('Resize design rules');
  assert.equal(await drc.locator('.inspector-resize').count(), 1);
  const grip = await resize.boundingBox();
  assert.ok(Math.abs(grip.x + grip.width - before.x - before.width) <= 2);
  assert.ok(Math.abs(grip.y + grip.height - before.y - before.height) <= 2);
  await resize.focus();
  await page.keyboard.press('ArrowDown');
  const afterHeight = await drc.boundingBox();
  assert.ok(afterHeight.height > before.height);
  assert.ok(Math.abs(afterHeight.y - before.y) <= 1, 'Resizing downward preserves the top anchor.');
  await page.keyboard.press('ArrowRight');
  const afterWidth = await drc.boundingBox();
  assert.ok(
    afterWidth.width > before.width && Math.abs(afterWidth.x - before.x) <= 1,
    'The bottom-right handle widens the window while preserving its left anchor.',
  );
  await resize.press('Home');
  const reset = await drc.boundingBox();
  assert.ok(Math.abs(reset.width - before.width) <= 1);
  assert.ok(Math.abs(reset.height - before.height) <= 1);
  await page.setViewportSize({ width: 1120, height: 760 });
  await page.waitForFunction(() => {
    const bounds = document.querySelector('dialog[open]').getBoundingClientRect();
    return bounds.x >= 0 && bounds.right <= window.innerWidth;
  });
  const bounds = await drc.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 1120);
  assert.equal(
    await drc.evaluate((element) => element.scrollWidth <= element.clientWidth),
    true,
    'Rule controls fit the compact panel without horizontal overflow.',
  );
  await page.screenshot({ path: 'test-results/rule-check-panel-drc.png' });
  await page.keyboard.press('Escape');
  await drc.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.closedPanels), 2);
  assert.deepEqual(errors, []);
  console.log(
    'Rule panel: concise ERC/DRC reports, incomplete/stale/Source states, complete limit drafts, locating, focus and resizing passed.',
  );
} finally {
  await browser.close();
}
