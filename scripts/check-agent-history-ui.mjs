// Actual retained work/history/Markdown; no Electron, providers, host writes or design files.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { waitForAsync } from './async-browser-test-helpers.mjs';

const bundle = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';
      import Process from './components/AgentProcess';import ToolList from './components/AgentToolList';
      import Tool from './components/AgentToolCall';import Response from './components/AgentResponse';
      const code='R1 '+ 'feedback_'.repeat(80)+' 0 1k\\n'+'C1 out 0 10u\\n'.repeat(60);
      const text='Checking the circuit.\\n\\n'+'Working notes.\\n\\n'.repeat(20)+'\u0060\u0060\u0060spice\\n'+code+'\u0060\u0060\u0060';
      function Fixture(){const[count,setCount]=useState(12),[version,setVersion]=useState(0),[expandedResult,setExpandedResult]=useState(false),[visible,setVisible]=useState(true),[running,setRunning]=useState(false),[deliveryError,setDeliveryError]=useState(false);
        window.addTool=()=>setCount(value=>value+1);window.updateResult=()=>setVersion(value=>value+1);window.growResult=()=>setExpandedResult(true);window.setVisible=setVisible;window.setRunning=setRunning;window.showDeliveryError=()=>setDeliveryError(true);
        return <><section hidden={!visible}><Process running={running} visible={visible} heading="Codex" hasWork>
          <Response text={text} active={visible}/>
          <ToolList latestCallId={'tool-'+(count-1)}>{Array.from({length:count},(_,index)=><Tool key={index} activity={{
            id:'tool-'+index,messageId:'retained',tool:'openpe_query',name:'project.inspect.'+index,status:'completed',
            arguments:{text:'Captured argument line\\n'.repeat(40),truncated:false},
            result:{text:'Result '+version+'\\n'+'Read-only observation\\n'.repeat(expandedResult?40:1),truncated:false}}}/>)}</ToolList>
        </Process>{deliveryError&&<Tool activity={{id:'delivery',messageId:'retained',tool:'openpe_query',name:'project.inspect.delivery',status:'completed',arguments:{text:'{}',truncated:false},deliveryError:'Result delivery failed: disconnected.\\n'+'Retained Ω and <script>literal</script>.\\n'.repeat(40)}}/>}</section><textarea aria-label="Outside draft" defaultValue="Keep this draft"/></>}
      createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>);`,
  },
  bundle: true,
  write: false,
  platform: 'browser',
  jsx: 'automatic',
});
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 760, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<main class="chat-panel"><div id="root"></div></main>');
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({
    content:
      'html,body{height:auto;overflow:auto}.chat-panel{width:100%;max-width:640px;padding:16px;margin:auto}',
  });
  await page.evaluate(() => {
    window.copies = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          if (window.holdCopy)
            await new Promise((resolve) => {
              window.releaseCopy = resolve;
            });
          if (window.failCopy) throw Error('Controlled clipboard failure');
          window.copies.push(text);
        },
      },
    });
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const work = page.locator('.agent-process');
  const workSummary = work.locator(':scope > summary');
  const workBody = work.locator('.agent-process-body');
  const history = work.locator('.agent-tool-history');
  const historySummary = history.locator(':scope > summary');
  const list = history.locator('.agent-tool-history-body');
  const code = work.getByLabel('spice code', { exact: true });
  const wrap = work.getByRole('button', { name: 'Wrap code', exact: true });
  const draft = page.getByRole('textbox', { name: 'Outside draft', exact: true });
  await workSummary.waitFor();
  assert.equal(await workBody.count(), 0, 'Unvisited completed work stays lazy.');
  assert.equal(await wrap.count(), 0);
  await workSummary.focus();
  await workSummary.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.equal(await work.evaluate((element) => element.open), false);
  await work.evaluate((element) => {
    element.open = true;
  });
  await workSummary.click();
  assert.equal(
    await work.evaluate((element) => element.open),
    false,
    'One activation closes work opened by the browser, without a second click.',
  );
  await work.evaluate((element) => {
    element.open = true;
  });
  await wrap.waitFor();
  await work.evaluate((element) => {
    element.open = false;
  });
  await workSummary.press('Enter');
  await wrap.waitFor();
  assert.equal(await list.count(), 0, 'Unvisited tool bodies stay lazy after opening work.');
  await wrap.click();
  await code.evaluate((element) => {
    element.scrollTop = 120;
  });
  await history.evaluate((element) => {
    element.open = true;
  });
  await historySummary.click();
  assert.equal(
    await history.evaluate((element) => element.open),
    false,
    'One activation closes history opened by the browser.',
  );
  await history.evaluate((element) => {
    element.open = true;
  });
  await list.waitFor();
  await history.evaluate((element) => {
    element.open = false;
    element.open = true;
    element.open = false;
  });
  await historySummary.press('Enter');
  await historySummary.press('Tab');
  assert.equal(
    await work
      .getByRole('region', { name: 'Tool call history', exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
    'The expanded history exposes its own keyboard scroll target before the tool rows.',
  );
  const historyKeyboardPose = await page.evaluate(() => [
    scrollY,
    document.querySelector('.agent-process-body').scrollTop,
  ]);
  await list.press('Home');
  await waitForAsync(
    page,
    () => document.querySelector('.agent-tool-history-body').scrollTop === 0,
  );
  await list.press('End');
  await waitForAsync(page, () => {
    const element = document.querySelector('.agent-tool-history-body');
    return element.scrollHeight - element.scrollTop - element.clientHeight < 2;
  });
  await list.press('PageDown');
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.deepEqual(
    await page.evaluate(() => [scrollY, document.querySelector('.agent-process-body').scrollTop]),
    historyKeyboardPose,
    'Native history navigation and its boundary retain the containing work/page viewports.',
  );
  const row = list.locator('.agent-tool-call > details').last();
  await row.locator(':scope > summary').click();
  const args = row.getByLabel('project.inspect.11 arguments', { exact: true });
  await args.evaluate((element) => {
    element.scrollTop = 70;
  });
  const argumentGroup = row.getByRole('group', {
    name: 'project.inspect.11 arguments details',
    exact: true,
  });
  const copyArguments = argumentGroup.getByRole('button', {
    name: 'Copy arguments preview',
    exact: true,
  });
  await copyArguments.evaluate((element) => element.focus({ preventScroll: true }));
  await copyArguments.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.deepEqual(await page.evaluate(() => window.copies), []);
  await copyArguments.press('Enter');
  await argumentGroup.getByText('Copied', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.copies.at(-1)), await args.textContent());
  const resultGroup = row.getByRole('group', {
    name: 'project.inspect.11 result details',
    exact: true,
  });
  const copyResult = resultGroup.getByRole('button', { name: 'Copy result preview', exact: true });
  const capturedResult = await resultGroup.locator('pre').textContent();
  await page.evaluate(() => {
    window.holdCopy = true;
  });
  await copyResult.evaluate((element) => element.focus({ preventScroll: true }));
  await copyResult.press('Enter');
  await resultGroup.getByText('Copying…', { exact: true }).waitFor();
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });
  const beforeResultGrowth = await list.evaluate((element) => element.scrollTop);
  await page.evaluate(() => window.growResult());
  await waitForAsync(page, () => {
    const result = document.querySelector(
      '.agent-tool-call:last-child .tool-preview:last-child pre',
    );
    return result.scrollHeight > result.clientHeight;
  });
  assert.equal(
    await list.evaluate((element) => element.scrollTop),
    beforeResultGrowth,
    'A growing result preserves the history reading position even when it was at the bottom.',
  );
  assert.equal(await args.evaluate((element) => element.scrollTop), 70);
  await page.evaluate(() => {
    window.holdCopy = false;
    window.releaseCopy();
  });
  await resultGroup.locator('.copy-action[data-state="idle"]').waitFor();
  assert.equal(await page.evaluate(() => window.copies.at(-1)), capturedResult);
  await page.evaluate(() => {
    window.failCopy = true;
  });
  await copyResult.press('Enter');
  await resultGroup.getByText('Could not copy. Try again.', { exact: true }).waitFor();
  assert.equal(await copyResult.evaluate((element) => element === document.activeElement), true);
  await page.evaluate(() => {
    window.failCopy = false;
  });
  await copyResult.press('Enter');
  await resultGroup.getByText('Copied', { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => window.copies.at(-1)),
    await resultGroup.locator('pre').textContent(),
  );
  await list.evaluate((element) => {
    element.scrollTop = 65;
    element.dispatchEvent(new Event('scroll'));
    window.retainedHistory = element;
  });
  const listTop = await list.evaluate((element) => element.scrollTop);
  await historySummary.click();
  assert.equal(await list.isVisible(), false);
  assert.equal(await list.count(), 1);
  await historySummary.press('Tab');
  assert.equal(
    await draft.evaluate((element) => element === document.activeElement),
    true,
    'Collapsed retained controls are excluded from keyboard navigation.',
  );
  await historySummary.click();
  assert.equal(
    await page.evaluate(
      () => window.retainedHistory === document.querySelector('.agent-tool-history-body'),
    ),
    true,
  );
  assert.equal(await row.evaluate((element) => element.open), true);
  assert.equal(await args.evaluate((element) => element.scrollTop), 70);
  assert.equal(await list.evaluate((element) => element.scrollTop), listTop);

  const workTop = await workBody.evaluate((element) => {
    element.scrollTop = 180;
    window.retainedWork = element;
    return element.scrollTop;
  });
  await workSummary.click();
  assert.equal(await workBody.isVisible(), false);
  await workSummary.press('Tab');
  assert.equal(await draft.evaluate((element) => element === document.activeElement), true);
  await draft.evaluate((element) => element.setSelectionRange(2, 6));
  await page.evaluate(() => window.updateResult());
  await waitForAsync(page, () =>
    document.querySelector('.tool-details').textContent.includes('Result 1'),
  );
  assert.equal(await draft.evaluate((element) => element === document.activeElement), true);
  await workSummary.click();
  assert.equal(
    await page.evaluate(
      () => window.retainedWork === document.querySelector('.agent-process-body'),
    ),
    true,
  );
  assert.equal(await history.evaluate((element) => element.open), true);
  assert.equal(await row.evaluate((element) => element.open), true);
  assert.equal(await wrap.getAttribute('aria-pressed'), 'true');
  assert.equal(await code.evaluate((element) => element.scrollTop), 120);
  assert.equal(await list.evaluate((element) => element.scrollTop), listTop);
  assert.equal(await workBody.evaluate((element) => element.scrollTop), workTop);

  // New calls still fold history, retain the summary, and reveal the latest calls next time.
  await row.locator(':scope > summary').focus();
  await page.evaluate(() => window.addTool());
  await historySummary.getByText('13 tool calls', { exact: true }).waitFor();
  assert.equal(await history.evaluate((element) => element.open), false);
  assert.equal(
    await historySummary.evaluate((element) => element === document.activeElement),
    true,
  );
  await historySummary.press('Enter');
  await waitForAsync(page, () => {
    const element = document.querySelector('.agent-tool-history-body');
    return element.scrollHeight - element.scrollTop - element.clientHeight < 2;
  });
  assert.equal(await row.first().evaluate((element) => element.open), false);
  assert.equal(
    await list
      .locator('.agent-tool-call > details')
      .nth(11)
      .evaluate((element) => element.open),
    true,
    'Previously inspected arguments remain expanded even as new calls arrive.',
  );
  await history.evaluate((element) => {
    element.open = false;
    element.open = true;
    window.addTool();
  });
  await historySummary.getByText('14 tool calls', { exact: true }).waitFor();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(
    await history.evaluate((element) => element.open),
    false,
    'A queued native toggle cannot reopen history folded by a newer tool call.',
  );
  await historySummary.click();
  await waitForAsync(page, () => {
    const element = document.querySelector('.agent-tool-history-body');
    return element.scrollHeight - element.scrollTop - element.clientHeight < 2;
  });
  await list.evaluate((element) => element.focus({ preventScroll: true }));
  await page.evaluate(() => window.addTool());
  await historySummary.getByText('15 tool calls', { exact: true }).waitFor();
  assert.equal(await history.evaluate((element) => element.open), false);
  assert.equal(
    await historySummary.evaluate((element) => element === document.activeElement),
    true,
  );
  await historySummary.press('Enter');
  await waitForAsync(page, () => {
    const element = document.querySelector('.agent-tool-history-body');
    return element.scrollHeight - element.scrollTop - element.clientHeight < 2;
  });
  await draft.focus();
  await page.evaluate(() => window.setVisible(false));
  await page.locator('section[hidden]').waitFor({ state: 'attached' });
  await page.evaluate(() => window.updateResult());
  await page.evaluate(() => window.setVisible(true));
  await workSummary.waitFor();
  assert.equal(await draft.evaluate((element) => element === document.activeElement), true);
  assert.equal(await draft.inputValue(), 'Keep this draft');
  assert.equal(await wrap.getAttribute('aria-pressed'), 'true');
  await mkdir('test-results/agent-history', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.setViewportSize({ width: 328, height: 900 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      true,
    );
    await historySummary.focus();
    await historySummary.press('Tab');
    assert.equal(await list.evaluate((element) => element === document.activeElement), true);
    await work.screenshot({ path: `test-results/agent-history/${theme}-328.png` });
  }
  await page.evaluate(() => window.setRunning(true));
  await page.locator('.agent-process[data-running]').waitFor();
  await historySummary.press('Enter');
  await historySummary.press('Tab');
  assert.equal(await list.evaluate((element) => element === document.activeElement), true);
  const beforeComposingKey = await list.evaluate((element) => element.scrollTop);
  assert.equal(
    await list.evaluate((element) =>
      element.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Home',
          keyCode: 229,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    ),
    false,
    'IME cannot scroll a live history region without a completed-work disclosure guard.',
  );
  assert.equal(await list.evaluate((element) => element.scrollTop), beforeComposingKey);
  const liveRow = list.locator('.agent-tool-call > details').nth(11);
  await liveRow.locator(':scope > summary').click();
  const liveArguments = liveRow.getByRole('group', {
    name: 'project.inspect.11 arguments details',
    exact: true,
  });
  const liveCopy = liveArguments.getByRole('button', {
    name: 'Copy arguments preview',
    exact: true,
  });
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--font-step', '4px');
    window.failCopy = true;
  });
  const liveCopyX = (await liveCopy.boundingBox()).x;
  await liveCopy.click();
  await liveArguments.getByText('Could not copy. Try again.', { exact: true }).waitFor();
  assert.equal((await liveCopy.boundingBox()).x, liveCopyX);
  assert.equal(
    await liveArguments
      .locator('.tool-preview-title > span')
      .first()
      .evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getClientRects().length;
      }),
    1,
    'Retry feedback cannot squeeze the Arguments heading into broken fragments.',
  );
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await liveCopy.evaluate((element) => {
      const viewport = element.closest('.agent-tool-history-body');
      viewport.scrollTop +=
        element.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 4;
      element.focus({ preventScroll: true });
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      true,
    );
    await history.screenshot({ path: `test-results/agent-history/copy-${theme}-328.png` });
  }
  await page.evaluate(() => {
    window.failCopy = false;
    document.documentElement.style.removeProperty('--font-step');
    window.setRunning(false);
  });
  await workSummary.waitFor();
  await workSummary.press('Enter');
  await workSummary.press('Tab');
  assert.equal(
    await workBody.evaluate((element) => element === document.activeElement),
    true,
    'Immediate Enter then Tab reaches a freshly mounted completed-work reading region.',
  );
  await page.evaluate(() => window.showDeliveryError());
  const deliveryDiagnostic = page.getByRole('region', {
    name: 'Result delivery error',
    exact: true,
  });
  await deliveryDiagnostic.waitFor();
  const deliveryText = await deliveryDiagnostic.textContent();
  assert.equal(await deliveryDiagnostic.locator('script').count(), 0);
  await page.getByRole('button', { name: 'Copy result delivery error', exact: true }).click();
  assert.equal(await page.evaluate(() => window.copies.at(-1)), deliveryText);
  assert.equal(
    await deliveryDiagnostic.evaluate((element) =>
      element.closest('.agent-tool-call').getAttribute('data-tool-status'),
    ),
    'completed',
    'Copying a delivery diagnostic cannot change the completed host execution outcome.',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Agent history passed: native keyboard reading/IME, stable growing results, lazy retained disclosures/viewports, hidden keyboard exclusion and new-call focus/latest behavior.',
  );
} finally {
  await browser.close();
}
