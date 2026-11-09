import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';

// Real docked rule panel, with controlled in-memory reports only.
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
    contents: `import React,{useRef,useState} from 'react';import {createRoot} from 'react-dom/client';
      import RuleCheckPanel from './components/RuleCheckPanel';
      function Fixture(){
        const [open,setOpen]=useState(false),[state,setState]=useState({kind:'erc',report:null,...window.fixture});
        const opener=useRef(null);
        window.updateRulePanel=changes=>setState(current=>({...current,...changes}));
        return <main className="editor" style={{height:'100%',margin:0,flexDirection:'row'}}>
          <div className="editor-drawing-region">
          <div style={{flex:1}}>
            <button ref={opener} onClick={()=>setOpen(true)}>Open checks</button>
            <button onClick={()=>window.editorActions++}>Editor action</button>
          </div>
          {open&&<RuleCheckPanel {...state}
            onDRCSettingsChange={config=>setState(current=>({...current,drcSettings:config,stale:!!current.report}))}
            onRun={config=>window.checkRuns.push(config??null)}
            onSelectIssue={issue=>window.locatedIssues.push(issue.id)}
            onClose={()=>{window.closedPanels++;setOpen(false);opener.current.focus()}}/>}
          <div className="status-bar">Editor status</div>
          </div>
          <aside aria-label="Properties" style={{width:"24%",flex:"none"}}>Properties</aside>
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
    window.editorActions = 0;
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
  const assertScrollableIssue = async (body, text) => {
    assert.equal(
      await text.evaluate((message) => {
        const style = getComputedStyle(message);
        return (
          style.whiteSpace === 'nowrap' &&
          style.textOverflow === 'clip' &&
          message.scrollWidth <= message.clientWidth
        );
      }),
      true,
      'The whole message occupies one line without internal clipping.',
    );
    await body.focus();
    await body.press('ArrowRight');
    await page.waitForFunction(() => document.activeElement?.scrollLeft > 0);
    assert.equal(
      await text.evaluate((message) => {
        const body = message.closest('[data-rule-body]');
        body.scrollLeft = body.scrollWidth;
        return message.getBoundingClientRect().right <= body.getBoundingClientRect().right;
      }),
      true,
      'Horizontal scrolling reaches the end of the message.',
    );
  };
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
  assert.equal(await page.locator('dialog[open]').count(), 0);
  const initialERC = await erc.boundingBox();
  const editor = page.locator('.editor-drawing-region');
  const footer = page.locator('.status-bar');
  const sidebar = page.getByRole('complementary', { name: 'Properties' });
  const drawing = await editor.boundingBox();
  assert.ok(Math.abs(initialERC.width - 480) <= 1);
  assert.ok(Math.abs(initialERC.x - drawing.x - 9) <= 1);
  assert.ok(Math.abs(initialERC.height - 300) <= 1);
  assert.ok(Math.abs((await footer.boundingBox()).y - initialERC.y - initialERC.height - 8) <= 1);
  const close = button('Close Rule');
  assert.equal(await close.evaluate((element) => document.activeElement === element), true);
  const runBounds = await button('Run ERC').boundingBox();
  const closeBounds = await close.boundingBox();
  assert.ok(runBounds.x < closeBounds.x && Math.abs(runBounds.y - closeBounds.y) <= 1);
  assert.ok(closeBounds.x + closeBounds.width >= initialERC.x + initialERC.width - 12);
  await button('Editor action').click();
  assert.equal(await page.evaluate(() => window.editorActions), 1);
  assert.equal(await erc.isVisible(), true);
  assert.ok((await sidebar.boundingBox()).x >= initialERC.x + initialERC.width);
  assert.ok((await sidebar.boundingBox()).height > initialERC.height);
  assert.equal(await erc.getByText('Not checked', { exact: true }).isVisible(), true);
  assert.equal(await erc.getByText('No violations found in checked rules.').count(), 0);
  assert.deepEqual(
    await page.evaluate(() => window.checkRuns),
    [],
    'Mounting the report does not run a check.',
  );
  assert.equal(await erc.getByRole('heading', { name: 'ERC', exact: true }).count(), 1);
  assert.equal(await erc.getByRole('tab').count(), 0);
  await assertRunIMEBlocked(button('Run ERC'));
  await button('Run ERC').click();
  assert.deepEqual(await page.evaluate(() => window.checkRuns), [null]);

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
  assert.ok(rowBox.height <= 34, 'Short issues fit on one line.');
  const longMessage = report.issues[0].message.repeat(20);
  await update({ report: { ...report, issues: [{ ...report.issues[0], message: longMessage }] } });
  const longRow = button(`Locate issue: ${longMessage}`);
  assert.equal(await longRow.getByText(longMessage, { exact: true }).textContent(), longMessage);
  assert.equal(Math.round((await longRow.boundingBox()).height), Math.round(rowBox.height));
  const longText = longRow.getByText(longMessage, { exact: true });
  assert.equal(await longText.getAttribute('title'), longMessage);
  await assertScrollableIssue(erc.getByRole('region', { name: 'ERC report' }), longText);
  const powerMessage = '#PWR104 pin 1 on SGND has no power output on its network.';
  await update({
    report: {
      ...report,
      issues: [{ ...report.issues[0], ruleId: 'erc.power-undriven', message: powerMessage }],
    },
  });
  const power = button(`Locate issue: ${powerMessage}`);
  assert.equal(await power.getByText(powerMessage, { exact: true }).textContent(), powerMessage);
  await update({ report });
  assert.equal(
    await erc.locator('[data-rule-body]').evaluate((body) => body.scrollWidth <= body.clientWidth),
    true,
  );
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
  assert.equal(await erc.getByText(/Outdated|Design or limits changed/).count(), 0);
  assert.equal(await button(`Locate issue: ${report.issues[0].message}`).isDisabled(), true);
  await button('Recheck ERC').click();
  assert.equal(await page.evaluate(() => window.checkRuns.length), 2);
  await update({ busy: true, stale: false });
  assert.equal(await button('Recheck ERC').isDisabled(), true);
  const refreshAnimation = () =>
    button('Recheck ERC')
      .locator('svg')
      .evaluate((icon) => getComputedStyle(icon).animationName);
  assert.equal(await refreshAnimation(), 'spin');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await refreshAnimation(), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.equal(await issueRow.isDisabled(), true, 'Running checks disable whole-row locating.');
  await update({ quietRefresh: true });
  assert.equal(await erc.getByText('Checking ERC…', { exact: true }).count(), 0);
  assert.equal(await button('Recheck ERC').locator('svg').getAttribute('data-busy'), 'false');
  assert.equal(await issueRow.isDisabled(), true, 'Silent refreshes still guard locating.');
  assert.equal(
    await button('Close Rule').isDisabled(),
    false,
    'Read-only checks remain cancellable.',
  );
  await update({
    busy: false,
    quietRefresh: false,
    sourcePending: true,
    stale: false,
    error: 'Fixture check failed.',
  });
  await button('Recheck ERC')
    .locator('svg')
    .evaluate((icon) => Promise.all(icon.getAnimations().map((animation) => animation.finished)));
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
  assert.equal(await erc.getByText(/Incomplete checks/).count(), 0);
  assert.equal(await erc.getByText('No violations found in checked rules.').count(), 0);
  await update({ report: { ...clean, truncated: true } });
  assert.equal(await erc.getByText('Issue list truncated.', { exact: true }).isVisible(), true);
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
  await close.focus();
  for (const composition of [{ keyCode: 229 }, { isComposing: true }]) {
    await close.dispatchEvent('keydown', { key: 'Escape', ...composition });
    assert.equal(await erc.isVisible(), true, 'IME Escape leaves Rule open.');
  }
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
    await page.evaluate(() => window.checkRuns),
    [null, null],
    'Mounting DRC does not run a check.',
  );
  assert.equal(await drc.getByRole('heading', { name: 'DRC', exact: true }).count(), 1);
  assert.equal(await drc.getByRole('tab').count(), 0);
  await update({ kind: 'model' });
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
  const modelError = 'Model preview failed. '.repeat(30).trim();
  await update({
    modelReport: {
      board: {},
      state: 'error',
      issues: [{ message: modelError, severity: 'error' }],
      message: modelError,
      canLocate: false,
    },
  });
  await assertScrollableIssue(
    drc.getByRole('region', { name: 'Model report' }),
    drc.getByText(modelError, { exact: true }),
  );
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
  await update({ kind: 'drc' });
  assert.equal(await clearance.inputValue(), settings.clearance.toFixed(2));
  assert.equal(await drc.getByRole('spinbutton').count(), 6);
  assert.deepEqual(
    await drc.getByRole('spinbutton').evaluateAll((inputs) => inputs.map((input) => input.value)),
    Object.values(settings).map((value) => value.toFixed(2)),
  );
  await clearance.fill('0.154321');
  await button('Recheck DRC').click();
  const refreshIcon = button('Recheck DRC').locator('svg');
  const fastRefresh = await refreshIcon.evaluate((icon) =>
    icon.getAnimations().map((animation) => {
      const { duration, iterations } = animation.effect.getTiming();
      return { duration, iterations };
    }),
  );
  assert.deepEqual(
    fastRefresh,
    [{ duration: 450, iterations: 1 }],
    'A fast recheck shows one turn without entering busy state.',
  );
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
  await page.setViewportSize({ width: 400, height: 540 });
  const resize = drc.getByRole('separator', { name: 'Resize Rule panel' });
  assert.equal(await resize.locator('span').isVisible(), false);
  await page.waitForFunction(() => {
    const grip = document.querySelector('[aria-label="Resize Rule panel"]');
    return Number(grip?.getAttribute('aria-valuenow')) < 300;
  });
  const bounds = await drc.boundingBox();
  const editorBounds = await editor.boundingBox();
  assert.ok(Math.abs(bounds.width - editorBounds.width + 18) <= 2);
  assert.ok(Math.abs(bounds.height - editorBounds.height * 0.48) <= 2);
  assert.ok(Math.abs(bounds.y + bounds.height + 8 - (await footer.boundingBox()).y) <= 1);
  await resize.focus();
  await resize.dispatchEvent('keydown', { key: 'ArrowUp', keyCode: 229 });
  assert.equal((await drc.boundingBox()).height, bounds.height);
  await resize.press('ArrowUp');
  assert.ok(Math.abs((await drc.boundingBox()).height - bounds.height - 16) <= 1);
  await resize.press('Home');
  assert.ok(Math.abs((await drc.boundingBox()).height - bounds.height) <= 1);
  const grip = await resize.boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 - 24);
  await page.mouse.up();
  assert.ok(Math.abs((await drc.boundingBox()).height - bounds.height - 24) <= 1);
  await resize.press('Home');
  assert.equal(
    await drc
      .locator('[data-rule-body]')
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
    true,
    'Rule controls fit the narrow panel without horizontal overflow.',
  );
  const geometryWarning =
    'PCB DRC could not complete all geometry checks. Review the report notes and check the remaining geometry separately.';
  await update({
    report: {
      ...clean,
      kind: 'drc',
      complete: false,
      issues: [{ ...report.issues[1], ruleId: 'pcb.geometry-limit', message: geometryWarning }],
    },
  });
  await assertScrollableIssue(
    drc.getByRole('region', { name: 'DRC report' }),
    drc.getByText(geometryWarning, { exact: true }),
  );
  await update({ report: { ...clean, kind: 'drc' } });
  await button('Close Rule').focus();
  await page.screenshot({ path: 'test-results/rule-check-panel-drc.png' });
  await page.keyboard.press('Escape');
  await drc.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.closedPanels), 2);
  assert.deepEqual(errors, []);
  console.log(
    'Rule panel: compact whole-row ERC/DRC locating with pointer/keyboard/IME guards, incomplete/stale/Source states, complete limit drafts, focus, one-line issues and lower-left popup passed.',
  );
} finally {
  await browser.close();
}
