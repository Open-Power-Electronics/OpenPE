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
            onKindChange={kind=>{window.kindChanges.push(kind);setState(current=>({...current,kind}))}}
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
    window.kindChanges = [];
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
  const assertRunIMEBlocked = async (action) => {
    assert.equal(await action.isEnabled(), true);
    const before = await page.evaluate(() => window.checkRuns.length);
    assert.equal(
      await action.evaluate((element) => {
        for (const key of ['Enter', ' ']) {
          for (const composition of [{ keyCode: 229 }, { isComposing: true }]) {
            const event = new KeyboardEvent('keydown', {
              key,
              ...composition,
              bubbles: true,
              cancelable: true,
            });
            element.dispatchEvent(event);
            if (!event.defaultPrevented) return false;
          }
        }
        return true;
      }),
      true,
      'IME Enter and Space prevent default activation of an enabled check action.',
    );
    assert.equal(
      await page.evaluate(() => window.checkRuns.length),
      before,
      'IME activation starts no extra check.',
    );
  };
  await button('Open checks').click();
  const erc = page.getByRole('dialog', { name: 'Rule', exact: true });
  await erc.waitFor();
  assert.equal(await erc.getAttribute('aria-modal'), 'true');
  assert.equal(await erc.evaluate((dialog) => dialog.matches(':modal')), true);
  const initialERC = await erc.boundingBox();
  assert.equal(Math.round(initialERC.width), 720);
  assert.equal(Math.round(initialERC.height), 560);
  assert.ok(Math.abs(initialERC.x + initialERC.width / 2 - 640) <= 1);
  assert.ok(Math.abs(initialERC.y + initialERC.height / 2 - 425) <= 1);
  assert.equal(await erc.getByText('Not checked', { exact: true }).isVisible(), true);
  assert.equal(await erc.getByText('No violations found in checked rules.').count(), 0);
  assert.deepEqual(
    await page.evaluate(() => window.checkRuns),
    [null],
    'Opening the panel automatically runs the selected ERC check once.',
  );
  const tabs = erc.getByRole('tablist', { name: 'Rule', exact: true });
  const ercTab = tabs.getByRole('tab', { name: 'ERC', exact: true });
  const drcTab = tabs.getByRole('tab', { name: 'DRC', exact: true });
  assert.equal(await tabs.getByRole('tab').count(), 3);
  assert.equal(await ercTab.getAttribute('aria-selected'), 'true');
  assert.equal(await drcTab.getAttribute('aria-selected'), 'false');
  assert.equal(
    await erc.getByRole('tabpanel').getAttribute('aria-labelledby'),
    await ercTab.getAttribute('id'),
  );
  await update({ drcAvailable: false });
  assert.equal(await drcTab.isDisabled(), true, 'A project without a PCB cannot select DRC.');
  await ercTab.focus();
  await page.keyboard.press('End');
  assert.equal(await ercTab.getAttribute('aria-selected'), 'true');
  assert.deepEqual(await page.evaluate(() => window.kindChanges), []);
  await update({ drcAvailable: true });
  await assertRunIMEBlocked(button('Run ERC'));
  await button('Run ERC').click();
  assert.deepEqual(await page.evaluate(() => window.checkRuns), [null, null]);

  await update({ report });
  await assertRunIMEBlocked(button('Recheck ERC'));
  assert.equal(await erc.getByText('1 error', { exact: true }).isVisible(), true);
  assert.equal(await erc.getByText('1 warning', { exact: true }).isVisible(), true);
  const issueRow = button(`Locate issue: ${report.issues[0].message}`);
  const issueList = erc.getByRole('list', { name: 'ERC issues', exact: true });
  const firstItem = issueList.locator(':scope > li').first();
  assert.equal(await issueRow.getAttribute('title'), null, 'Issue text has no redundant tooltip.');
  assert.equal(await firstItem.getByRole('button').count(), 1, 'The whole issue is one action.');
  assert.equal(
    await issueRow.locator('button, input, a').count(),
    0,
    'Rows have no nested actions.',
  );
  assert.equal(await issueList.locator('.lucide-locate-fixed').count(), 0);
  const rowBox = await issueRow.boundingBox();
  const itemBox = await firstItem.boundingBox();
  assert.ok(
    Math.abs(rowBox.x - itemBox.x) <= 1 && Math.abs(rowBox.width - itemBox.width) <= 1,
    'The locate action spans the complete issue row.',
  );
  assert.ok(rowBox.height <= 56, 'A short issue retains a compact two-line row.');
  assert.equal(
    await issueRow.evaluate((element) => {
      for (const key of ['Enter', ' ']) {
        for (const composition of [{ keyCode: 229 }, { isComposing: true }]) {
          const event = new KeyboardEvent('keydown', {
            key,
            ...composition,
            bubbles: true,
            cancelable: true,
          });
          element.dispatchEvent(event);
          if (!event.defaultPrevented) return false;
        }
      }
      return true;
    }),
    true,
    'IME Enter and Space suppress native issue activation.',
  );
  await issueRow.dispatchEvent('compositionstart');
  for (const key of ['Enter', ' ']) {
    assert.equal(
      await issueRow.evaluate((element, key) => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      }, key),
      true,
      'Active composition also suppresses ordinary Enter/Space events.',
    );
  }
  assert.deepEqual(await page.evaluate(() => window.locatedIssues), []);
  await issueRow.dispatchEvent('compositionend');
  await issueRow.click({ position: { x: rowBox.width / 2, y: rowBox.height / 2 } });
  assert.deepEqual(await page.evaluate(() => window.locatedIssues), ['first']);
  await issueRow.focus();
  await issueRow.press('Enter');
  await issueRow.press('Space');
  assert.deepEqual(
    await page.evaluate(() => window.locatedIssues),
    ['first', 'first', 'first'],
    'Enter and Space locate through the same whole-row action.',
  );
  await update({ blockedReason: 'Project is closing.' });
  assert.equal(await issueRow.isDisabled(), true, 'Closing projects disable whole-row locating.');
  await issueRow.evaluate((element) => element.click());
  assert.equal(await page.evaluate(() => window.locatedIssues.length), 3);
  await update({
    blockedReason: '',
    report: { ...report, issues: [{ ...report.issues[0], objectIds: [], location: undefined }] },
  });
  assert.equal(await issueRow.isDisabled(), true, 'Issues without a target remain read-only.');
  await update({ report });
  assert.equal(await erc.locator('details').count(), 0);
  assert.equal(await erc.getByText(report.notes[0], { exact: true }).count(), 0);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/rule-check-panel-erc.png' });

  await update({ stale: true });
  assert.equal(await erc.getByText('Design or limits changed. Recheck ERC.').isVisible(), true);
  assert.equal(await button(`Locate issue: ${report.issues[0].message}`).isDisabled(), true);
  await button('Recheck ERC').click();
  assert.equal(await page.evaluate(() => window.checkRuns.length), 3);
  await update({ busy: true, stale: false });
  assert.equal(await button('Recheck ERC').isDisabled(), true);
  assert.equal(await issueRow.isDisabled(), true, 'Running checks disable whole-row locating.');
  assert.equal(
    await button('Close dialog').isDisabled(),
    false,
    'Read-only checks remain cancellable.',
  );
  await update({ busy: false, sourcePending: true, stale: false, error: 'Fixture check failed.' });
  assert.equal(await erc.getByText('Apply Source edits before checking rules.').isVisible(), true);
  assert.equal(await erc.getByRole('alert').innerText(), 'Fixture check failed.');
  assert.equal(await button('Recheck ERC').isDisabled(), true);
  assert.equal(await issueRow.isDisabled(), true, 'Pending Source disables whole-row locating.');
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
    await erc.evaluate(
      (element) => element.contains(document.activeElement) && !document.activeElement.disabled,
    ),
    true,
    'Finishing a check retains keyboard focus on an enabled control inside the panel.',
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
  const drc = page.getByRole('dialog', { name: 'Rule', exact: true });
  const clearance = drc.getByRole('spinbutton', { name: 'Copper clearance (mm)', exact: true });
  await clearance.waitFor();
  assert.deepEqual(
    await page.evaluate(() => window.checkRuns.at(-1)),
    settings,
    'Opening DRC automatically runs with its validated settings.',
  );
  assert.equal(await drcTab.getAttribute('aria-selected'), 'true');
  await ercTab.click();
  assert.equal(await ercTab.getAttribute('aria-selected'), 'true');
  assert.equal(await clearance.count(), 0, 'ERC hides the board limits.');
  assert.equal(
    await ercTab.evaluate((element) => {
      for (const key of ['ArrowRight', 'End', 'Enter', ' ']) {
        element.dispatchEvent(
          new KeyboardEvent('keydown', {
            key,
            keyCode: 229,
            bubbles: true,
            cancelable: true,
          }),
        );
        element.dispatchEvent(
          new KeyboardEvent('keydown', {
            key,
            isComposing: true,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
      return true;
    }),
    true,
  );
  assert.equal(await ercTab.getAttribute('aria-selected'), 'true', 'IME cannot switch rule tabs.');
  assert.deepEqual(await page.evaluate(() => window.kindChanges), ['erc']);
  await ercTab.press('ArrowRight');
  assert.equal(await drcTab.getAttribute('aria-selected'), 'true');
  assert.equal(await drcTab.evaluate((element) => document.activeElement === element), true);
  await drcTab.press('ArrowLeft');
  assert.equal(await ercTab.getAttribute('aria-selected'), 'true');
  await ercTab.press('End');
  const modelTab = tabs.getByRole('tab', { name: 'Model', exact: true });
  assert.equal(await modelTab.getAttribute('aria-selected'), 'true');
  assert.equal(await button('Run MODEL').count(), 0);
  await drc.getByText('Preview not loaded.', { exact: true }).waitFor();
  const runsBeforeModel = await page.evaluate(() => window.checkRuns.length);
  await update({
    modelReport: {
      board: {},
      state: 'loading',
      issues: [],
      message: '',
      canLocate: false,
    },
  });
  await drc.getByText('Loading models…', { exact: true }).waitFor();
  assert.equal(await drc.getByText('No model issues.', { exact: true }).count(), 0);
  await update({
    modelReport: {
      board: {},
      state: 'error',
      issues: [{ message: 'Preview failed.', severity: 'error' }],
      message: 'Preview failed.',
      canLocate: false,
    },
  });
  await drc.getByText('Preview failed.', { exact: true }).waitFor();
  await update({
    modelReport: {
      board: {},
      state: 'ready',
      issues: [],
      message: '',
      canLocate: true,
    },
  });
  await drc.getByText('No model issues.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.checkRuns.length), runsBeforeModel);
  await modelTab.press('Home');
  assert.equal(await ercTab.getAttribute('aria-selected'), 'true');
  await drcTab.click();
  assert.equal(await clearance.inputValue(), settings.clearance.toFixed(2));
  assert.equal(await drc.getByRole('spinbutton').count(), 6);
  assert.deepEqual(
    await drc.getByRole('spinbutton').evaluateAll((inputs) => inputs.map((input) => input.value)),
    Object.values(settings).map((value) => value.toFixed(2)),
  );
  await clearance.fill('0.154321');
  await button('Recheck DRC').click();
  await update({});
  assert.equal(await clearance.inputValue(), '0.15');
  assert.equal(
    await page.evaluate(() => window.checkRuns.at(-1).clearance),
    0.154321,
    'Two-decimal display retains the complete checking threshold.',
  );
  for (const invalid of ['', '-0.001', '1000.1']) {
    await clearance.focus();
    await update({});
    await clearance.fill(invalid);
    await drc.getByRole('spinbutton', { name: 'Minimum track width (mm)', exact: true }).focus();
    assert.equal(await clearance.inputValue(), invalid, 'Blur retains invalid drafts literally.');
    assert.equal(await clearance.getAttribute('aria-invalid'), 'true');
    assert.equal(await button('Recheck DRC').isDisabled(), true);
    assert.equal(
      await drc.getByText('No violations found in checked rules.').count(),
      0,
      'Invalid limits cannot retain a clean conclusion from earlier settings.',
    );
    assert.equal(await drc.getByRole('alert').innerText(), 'Enter each limit from 0 to 1000 mm.');
  }
  await ercTab.click();
  const beforeInvalidDRC = await page.evaluate(() => window.checkRuns.length);
  await drcTab.click();
  assert.equal(
    await page.evaluate(() => window.checkRuns.length),
    beforeInvalidDRC,
    'Reactivating DRC with retained invalid drafts does not run a check.',
  );
  assert.equal(
    Number(await clearance.inputValue()),
    1000.1,
    'Switching tabs preserves the invalid DRC threshold through two-decimal display.',
  );
  assert.equal(await clearance.getAttribute('aria-invalid'), 'true');
  assert.equal(await button('Recheck DRC').isDisabled(), true);
  await clearance.fill('0.35');
  await button('Recheck DRC').click();
  assert.deepEqual(
    await page.evaluate(() => window.checkRuns.at(-1)),
    { ...settings, clearance: 0.35 },
    'Run receives the complete validated drafts, including the field that just blurred.',
  );
  await update({ drcSettings: { ...settings, clearance: 0.4 }, stale: false });
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="Copper clearance (mm)"]').value === '0.40',
  );
  await update({ busy: true });
  assert.equal(await clearance.isDisabled(), true);
  await update({ busy: false });
  const before = await drc.boundingBox();
  const resize = button('Resize rule bottom right');
  assert.equal(await drc.locator('.dialog-resize-edge').count(), 8);
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
    return (
      bounds.x >= 24 &&
      bounds.right <= window.innerWidth - 24 &&
      bounds.y >= 24 &&
      bounds.bottom <= window.innerHeight - 24
    );
  });
  const bounds = await drc.boundingBox();
  assert.equal(Math.round(bounds.width), 720);
  assert.equal(Math.round(bounds.height), 560);
  assert.ok(bounds.x >= 24 && bounds.x + bounds.width <= 1120 - 24);
  assert.ok(bounds.y >= 24 && bounds.y + bounds.height <= 760 - 24);
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
    'Rule panel: compact whole-row ERC/DRC locating with pointer/keyboard/IME guards, incomplete/stale/Source states, complete limit drafts, focus and resizing passed.',
  );
} finally {
  await browser.close();
}
