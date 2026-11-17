// Isolated browser components: no Electron, provider, project or user files.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { waitForAsync } from './async-browser-test-helpers.mjs';

const bundle = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import Questions from './components/AgentQuestions';
    import Process from './components/AgentProcess';
    import Tool from './components/AgentToolCall';
    import ToolList from './components/AgentToolList';
    const initialQuestions=[{id:'voltage',header:'Voltage',question:'Output voltage?',options:[{label:'12 V',description:'Nominal'},{label:'24 V',description:'Higher'}],multiSelect:false},
      {id:'features',header:'Features',question:'Which features?',options:[{label:'Filter',description:''},{label:'Protection',description:''}],multiSelect:true}];
    window.answers=[];window.attempts=0;window.reviewApplyCalls=0;window.holdAnswer=false;window.releaseAnswer=null;
    function Fixture(){const [questions,setQuestions]=useState(initialQuestions),[running,setRunning]=useState(true),[attention,setAttention]=useState(false),[closed,setClosed]=useState(false),[toolCount,setToolCount]=useState(32),[failed,setFailed]=useState(false),[reviewState,setReviewState]=useState('review');window.setQuestions=setQuestions;
      return <><div className="fixture-controls"><button onClick={()=>setRunning(false)}>Finish run</button><button onClick={()=>setRunning(true)}>Restart run</button><button onClick={()=>{setAttention(true);setReviewState('review')}}>Review needed</button><button onClick={()=>{setAttention(true);setFailed(true)}}>Fail tool</button><button onClick={()=>setClosed(true)}>Cancel question</button><button onClick={()=>setToolCount(count=>count+1)}>Add tool</button></div>
      <article className={'message assistant'+(failed?' error':'')}>
      <Process running={running} heading="Codex" hasWork={true}><p className="message-text">Checking output</p>
        <ToolList running={running && attention}>
        {attention && Array.from({length:toolCount},(_,index)=><Tool key={index} activity={{id:'tool-'+index,messageId:'fixture',tool:'openpe_query',name:'project.inspect.'+index,status:failed&&index===0?'failed':'completed',arguments:{text:'{}',truncated:false},result:{text:'Project inspected',truncated:false},error:failed&&index===0?'Query the current project and try again.':undefined}}/>)}
        </ToolList>
      </Process>
      <p className="message-text">Final answer remains visible</p>
      {attention && <Tool activity={{id:'review',messageId:'fixture',tool:'openpe_execute',name:'part.properties',status:reviewState,arguments:{text:'{"reference":"R1","value":"10k"}',truncated:false}}}
        onApply={()=>{window.reviewApplyCalls++;setReviewState('applying')}} onReject={()=>setAttention(false)}/>}
      {failed && <p className="message-error" role="status">Stopped after five minutes.</p>}
      </article>
      <textarea aria-label="Other draft"/>
      <section className="question-slot"><Questions questions={questions} disabled={closed} onAnswer={async answers=>{window.attempts++;if(window.attempts===1)throw new Error('Retry delivery');if(window.holdAnswer)await new Promise(resolve=>{window.releaseAnswer=resolve});window.answers.push(answers)}}/></section></>}
    createRoot(document.getElementById('root')).render(<Fixture/>);`,
  },
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  jsx: 'automatic',
});
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 760, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const mount = async () => {
    await page.setContent('<div id="root" class="chat-panel"></div>');
    for (const file of ['app/globals.css', 'app/workspace.css'])
      await page.addStyleTag({ content: await readFile(file, 'utf8') });
    await page.addStyleTag({
      content:
        'html,body{height:auto;min-height:100%;overflow:auto}#root{width:100%;max-width:640px;margin:24px auto;padding:0 20px}.fixture-controls{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:20px;font-size:12px}.fixture-controls button{padding:6px;background:var(--panel)}',
    });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
  };
  await mount();
  const form = page.getByRole('form', { name: 'Agent questions' });
  await form.waitFor();
  assert.equal(await page.locator('.agent-process').getAttribute('data-running'), 'true');
  assert.equal(await page.locator('.agent-process > summary').count(), 0);
  await page.getByText('Checking output', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(await form.locator('input:checked').count(), 0);
  assert.equal(
    await form.getByRole('button', { name: 'Continue', exact: true }).isDisabled(),
    true,
  );
  const unanswered = form.getByRole('textbox', { name: 'Your answer: Voltage', exact: true });
  await unanswered.press('Control+Enter');
  assert.equal(await unanswered.inputValue(), '');
  assert.equal(await page.evaluate(() => window.attempts), 0);
  await form.getByRole('radio', { name: '12 V' }).check();
  await form.getByRole('radio', { name: '12 V' }).press('ArrowDown');
  assert.equal(await form.getByRole('radio', { name: '24 V' }).isChecked(), true);
  await form.getByRole('radio', { name: '24 V' }).press('ArrowUp');
  assert.equal(await form.getByRole('radio', { name: '12 V' }).isChecked(), true);
  assert.equal(await page.evaluate(() => window.attempts), 0);
  await form.getByRole('checkbox', { name: 'Filter', exact: true }).check();
  await form.getByRole('checkbox', { name: 'Protection', exact: true }).check();
  await mkdir('test-results/agent-interaction', { recursive: true });
  const answerDraft = form.getByRole('textbox', { name: 'Your answer: Voltage', exact: true });
  const initialAnswerHeight = (await answerDraft.boundingBox()).height;
  await answerDraft.fill('Draft requirement\n'.repeat(7));
  assert.ok(
    (await answerDraft.boundingBox()).height > initialAnswerHeight + 40,
    'Multiline question answers grow before scrolling internally.',
  );
  await answerDraft.fill('One line');
  await answerDraft.press('Enter');
  await answerDraft.press('Shift+Enter');
  assert.equal(await answerDraft.inputValue(), 'One line\n\n');
  assert.equal(await page.evaluate(() => window.attempts), 0, 'Answer newlines never auto-submit.');
  const wrappedDraft = 'Specify the controller, feedback network and thermal limits. '.repeat(4);
  await answerDraft.fill(wrappedDraft);
  const wideDraftHeight = (await answerDraft.boundingBox()).height;
  await answerDraft.evaluate((element) => element.setSelectionRange(4, 12));
  await page.setViewportSize({ width: 360, height: 900 });
  assert.ok(
    (await answerDraft.boundingBox()).height > wideDraftHeight,
    'Wrapped answers grow with a narrower question card.',
  );
  assert.deepEqual(
    await answerDraft.evaluate((element) => [element.selectionStart, element.selectionEnd]),
    [4, 12],
  );
  await answerDraft.fill('Long answer line\n'.repeat(80));
  assert.ok((await answerDraft.boundingBox()).height <= 221);
  assert.equal(
    await answerDraft.evaluate((element) => element.scrollHeight > element.clientHeight),
    true,
  );
  await page.setViewportSize({ width: 360, height: 600 });
  assert.ok(
    (await answerDraft.boundingBox()).height <= 181,
    'Short windows retain the viewport height cap.',
  );
  await page.screenshot({
    path: 'test-results/agent-interaction/question-draft-narrow.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 760, height: 1000 });
  await answerDraft.fill('');
  assert.equal((await answerDraft.boundingBox()).height, initialAnswerHeight);
  assert.equal(
    await answerDraft.evaluate((element) => getComputedStyle(element).resize),
    'vertical',
  );
  await form.getByRole('radio', { name: '12 V' }).check();
  await page.screenshot({
    path: 'test-results/agent-interaction/questions-light.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 360, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({
    path: 'test-results/agent-interaction/questions-narrow.png',
    fullPage: true,
  });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await page.screenshot({
    path: 'test-results/agent-interaction/questions-dark.png',
    fullPage: true,
  });
  await page.evaluate(() => {
    delete document.documentElement.dataset.theme;
    document.documentElement.style.setProperty('--font-step', '4px');
  });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({
    path: 'test-results/agent-interaction/questions-large-text.png',
    fullPage: true,
  });
  await page.evaluate(() => document.documentElement.style.removeProperty('--font-step'));
  await page.setViewportSize({ width: 760, height: 1000 });
  const custom = form.getByRole('textbox', { name: 'Your answer: Voltage' });
  await custom.fill('15 V');
  const continueAnswer = form.getByRole('button', { name: 'Continue', exact: true });
  await continueAnswer.scrollIntoViewIfNeeded();
  await custom.evaluate((element) => {
    element.focus({ preventScroll: true });
    element.setSelectionRange(1, 3);
  });
  await custom.dispatchEvent('compositionstart');
  await custom.press('Control+Enter');
  await form.dispatchEvent('submit');
  assert.equal(await page.evaluate(() => window.attempts), 0);
  await custom.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.equal(await page.evaluate(() => window.attempts), 0);
  const composingPageTop = await page.evaluate(() => scrollY);
  await continueAnswer.click();
  assert.equal(await page.evaluate(() => window.attempts), 0);
  assert.equal(
    await custom.evaluate((element) => element === document.activeElement),
    true,
    'Pointer Continue cannot take focus from an actively composing answer.',
  );
  assert.deepEqual(
    await custom.evaluate((element) => [
      element.value,
      element.selectionStart,
      element.selectionEnd,
    ]),
    ['15 V', 1, 3],
  );
  assert.equal(await page.evaluate(() => scrollY), composingPageTop);
  assert.equal(
    await continueAnswer.evaluate((element) =>
      element.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerType: 'touch',
          bubbles: true,
          cancelable: true,
        }),
      ),
    ),
    false,
    'A touch press also preserves the active answer composition.',
  );
  for (const key of ['Enter', ' ']) {
    assert.equal(
      await continueAnswer.evaluate(
        (element, key) =>
          element.dispatchEvent(
            new KeyboardEvent('keydown', {
              key,
              keyCode: key === 'Enter' ? 13 : 32,
              isComposing: false,
              bubbles: true,
              cancelable: true,
            }),
          ),
        key,
      ),
      false,
      'Continue respects the active composition even when the key omits its native flag.',
    );
  }
  assert.equal(await page.evaluate(() => window.attempts), 0);
  await custom.dispatchEvent('compositionend');
  await custom.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, repeat: true });
  await custom.dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, keyCode: 229 });
  assert.equal(await page.evaluate(() => window.attempts), 0);
  assert.equal(
    await continueAnswer.evaluate((element) =>
      element.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: ' ',
          keyCode: 229,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    ),
    false,
    'A late IME Space confirmation cannot activate Continue after compositionend.',
  );
  assert.equal(await continueAnswer.getAttribute('aria-keyshortcuts'), 'Control+Enter Meta+Enter');
  await custom.press('Control+Enter');
  await page.getByRole('alert').waitFor();
  assert.equal(await custom.inputValue(), '15 V');
  assert.equal(await form.locator('input:checked').count(), 2);
  assert.equal(
    await form
      .getByRole('button', { name: 'Continue', exact: true })
      .evaluate((element) => document.activeElement === element),
    true,
    'Retryable delivery errors retain the Continue action as the keyboard target.',
  );
  await page.evaluate(() => {
    window.holdAnswer = true;
  });
  await form.evaluate((element) => {
    const field = element.querySelector('textarea');
    field.focus({ preventScroll: true });
    field.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    element.requestSubmit();
  });
  await form.getByRole('button', { name: 'Sending…', exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => window.attempts),
    2,
    'Synchronous repeated submissions must create only one pending delivery.',
  );
  await page.evaluate(() => window.releaseAnswer());
  const receipt = page.getByLabel('Answers sent', { exact: true });
  await receipt.waitFor();
  assert.equal(await form.count(), 0);
  assert.equal(await receipt.evaluate((element) => element.open), false);
  assert.equal(
    await receipt.locator('summary').evaluate((element) => document.activeElement === element),
    true,
    'Submitting answers keeps keyboard focus on the Answered receipt.',
  );
  await receipt.locator('summary').press('Enter');
  await receipt.getByText('15 V', { exact: true }).waitFor();
  await receipt.getByText('Filter, Protection', { exact: true }).waitFor();
  await receipt.locator('summary').click();
  assert.deepEqual(await page.evaluate(() => window.answers), [
    { voltage: ['15 V'], features: ['Filter', 'Protection'] },
  ]);
  await page.getByRole('button', { name: 'Finish run', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.agent-process').open);
  await page.screenshot({ path: 'test-results/agent-interaction/completed.png', fullPage: true });
  assert.equal(
    await page.getByText('Final answer remains visible', { exact: true }).isVisible(),
    true,
  );
  await page.locator('.agent-process > summary').click();
  await page.getByText('Checking output', { exact: true }).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Review needed', exact: true }).click();
  assert.equal(await page.locator('.agent-process').evaluate((element) => element.open), true);
  const toolList = page.locator('.agent-tool-list');
  const history = toolList.locator('.agent-tool-history');
  const historySummary = history.locator(':scope > summary');
  const tools = toolList.locator('.agent-tool-history-body');
  assert.equal(await toolList.locator('.agent-tool-call:visible').count(), 0);
  assert.equal(await historySummary.innerText(), '32 tool calls');
  assert.equal(await history.evaluate((element) => element.open), false);
  await historySummary.focus();
  await historySummary.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.equal(await history.evaluate((element) => element.open), false);
  await historySummary.press('Enter');
  await tools.locator('.agent-tool-call').last().waitFor();
  assert.equal(await tools.locator('.agent-tool-call').count(), 32);
  const checkToolScroll = async () => {
    const bounds = await tools.evaluate((element) => ({
      height: element.clientHeight,
      content: element.scrollHeight,
      limit: Math.min(
        5 * parseFloat(getComputedStyle(element).getPropertyValue('--control-height')) + 8,
        innerHeight * 0.35,
      ),
      containment: getComputedStyle(element).overscrollBehaviorY,
    }));
    assert.ok(bounds.height <= bounds.limit + 1);
    assert.ok(bounds.content > bounds.height * 3);
    assert.equal(bounds.containment, 'contain');
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
  };
  await checkToolScroll();
  const waitForLatest = () =>
    waitForAsync(page, () => {
      const element = document.querySelector('.agent-tool-history-body');
      return element && element.scrollHeight - element.scrollTop - element.clientHeight < 2;
    });
  await waitForLatest();
  const visibleToolCount = () =>
    tools.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return [...element.querySelectorAll('.agent-tool-call')].filter((tool) => {
        const row = tool.getBoundingClientRect();
        return row.bottom > bounds.top + 1 && row.top < bounds.bottom - 1;
      }).length;
    });
  assert.ok((await visibleToolCount()) <= 5);
  await page.getByRole('button', { name: 'Add tool', exact: true }).click();
  assert.equal(await tools.isVisible(), false, 'New calls collapse expanded history.');
  assert.equal(await toolList.locator('.agent-tool-call:visible').count(), 0);
  await historySummary.click();
  assert.equal(await tools.locator('.agent-tool-call').count(), 33);
  await waitForLatest();
  await tools.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.waitForTimeout(50);
  await page.getByRole('button', { name: 'Add tool', exact: true }).click();
  assert.equal(await tools.isVisible(), false);
  await historySummary.click();
  await waitForLatest();
  await tools.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.waitForTimeout(50);
  await page.getByRole('button', { name: 'Add tool', exact: true }).click();
  assert.equal(await tools.isVisible(), false);
  await historySummary.click();
  await waitForLatest();
  assert.ok((await visibleToolCount()) <= 5);
  await page.setViewportSize({ width: 360, height: 600 });
  await checkToolScroll();
  const firstTool = tools.locator('summary').first();
  await firstTool.click();
  await tools.getByLabel('project.inspect.0 result', { exact: true }).waitFor();
  await checkToolScroll();
  await firstTool.click();
  await firstTool.focus();
  // Keyboard navigation must reveal the pending actions below the settled rows.
  for (let index = 0; index < 36; index++) await page.keyboard.press('Tab');
  await page.waitForFunction(
    () => document.activeElement?.getAttribute('aria-label') === 'Reject part.properties',
  );
  assert.ok(await tools.evaluate((element) => element.scrollTop > 0));
  await page.keyboard.press('Tab');
  assert.equal(
    await page
      .getByRole('button', { name: 'Apply part.properties', exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  assert.equal(
    await page.getByRole('button', { name: 'Apply part.properties', exact: true }).isVisible(),
    true,
  );
  assert.equal(
    await page.getByRole('button', { name: 'Reject part.properties', exact: true }).isVisible(),
    true,
  );
  await page.screenshot({ path: 'test-results/agent-interaction/review.png', fullPage: true });
  const applyReview = page.getByRole('button', { name: 'Apply part.properties', exact: true });
  await applyReview.click();
  await page.locator('[data-tool-status="applying"]').waitFor();
  assert.equal(await applyReview.getAttribute('aria-disabled'), 'true');
  assert.equal(await applyReview.innerText(), 'Applying…');
  assert.equal(
    await applyReview.evaluate((element) => document.activeElement === element),
    true,
    'Applying retains the original focused button while the host is busy.',
  );
  await page.locator('[data-tool-status="applying"]').screenshot({
    path: 'test-results/agent-interaction/review-applying.png',
  });
  await applyReview.click({ force: true });
  await page
    .getByRole('button', { name: 'Reject part.properties', exact: true })
    .click({ force: true });
  assert.equal(await page.evaluate(() => window.reviewApplyCalls), 1);
  assert.equal(await page.locator('[data-tool-status="applying"]').count(), 1);
  assert.equal(await page.locator('.agent-process').evaluate((element) => element.open), true);
  await page.locator('.agent-process > summary').click();
  await page.getByRole('button', { name: 'Review needed', exact: true }).click();
  assert.equal(await page.locator('.agent-process').evaluate((element) => element.open), false);
  await mount();
  await page.getByRole('button', { name: 'Fail tool', exact: true }).click();
  await page.getByRole('button', { name: 'Finish run', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.agent-process').open);
  assert.equal(await page.getByText('Needs attention', { exact: true }).count(), 0);
  await page.getByText('Final answer remains visible', { exact: true }).waitFor();
  await page.locator('.agent-process > summary').focus();
  await page.keyboard.press('Enter');
  await page.getByText('Checking output', { exact: true }).waitFor();
  await page.locator('.agent-tool-history > summary').click();
  await page.getByText('Query the current project and try again.', { exact: true }).waitFor();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    assert.equal(
      await page.locator('.message.error').evaluate((message) => {
        const sample = document.createElement('span');
        sample.style.color = 'var(--text)';
        message.append(sample);
        const expected = getComputedStyle(sample).color;
        sample.remove();
        return [...message.querySelectorAll('.message-text, .message-error')].every(
          (element) => getComputedStyle(element).color === expected,
        );
      }),
      true,
      `${theme}: failed turns keep reply, process and diagnostic text in the normal text colour.`,
    );
  }
  await page.locator('.agent-process > summary').press('Space');
  await page.waitForFunction(() => !document.querySelector('.agent-process').open);
  // Each completion folds tool history; review actions remain outside it.
  await page.locator('.agent-process > summary').click();
  await page.getByRole('button', { name: 'Restart run', exact: true }).click();
  assert.equal(await page.locator('.agent-process').getAttribute('data-running'), 'true');
  await page.getByRole('status', { name: 'Running tool calls', exact: true }).waitFor();
  assert.equal(await page.locator('.agent-tool-call[data-tool-status="completed"]').count(), 0);
  await page.locator('.agent-tool-history > summary').click();
  const liveTool = tools.locator('.agent-tool-call > details').first();
  await liveTool.locator(':scope > summary').click();
  assert.equal(await liveTool.evaluate((element) => element.open), true);
  await page.getByRole('button', { name: 'Finish run', exact: true }).click();
  assert.equal(await page.locator('.agent-process').evaluate((element) => element.open), false);
  assert.equal(await page.locator('.agent-process-body').count(), 0);
  assert.equal(await page.getByText('Needs attention', { exact: true }).count(), 0);
  assert.equal(
    await page.getByRole('status', { name: 'Running tool calls', exact: true }).count(),
    0,
  );
  await page.locator('.agent-process > summary').press('Enter');
  await page.locator('.agent-tool-history > summary').click();
  assert.equal(
    await tools
      .locator('.agent-tool-call > details')
      .first()
      .evaluate((element) => element.open),
    false,
  );
  assert.equal(await page.locator('.agent-process').evaluate((element) => element.open), true);
  await page.locator('.agent-process > summary').focus();
  await page.locator('.agent-process > summary').dispatchEvent('keydown', {
    key: 'Enter',
    keyCode: 229,
    isComposing: true,
  });
  assert.equal(await page.locator('.agent-process').evaluate((element) => element.open), true);
  await mount();
  const retainedAnswer = 'Retained Ω, µH and literal **answer**.\n'.repeat(80);
  const closedAnswer = form.getByRole('textbox', { name: 'Your answer: Voltage', exact: true });
  await closedAnswer.fill(retainedAnswer);
  await form.getByRole('checkbox', { name: 'Filter', exact: true }).check();
  await page.getByRole('button', { name: 'Cancel question', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: 'Closed', exact: true }).isDisabled(), true);
  await closedAnswer.focus();
  assert.equal(
    await closedAnswer.evaluate((element) => element === document.activeElement),
    true,
    'Closed questions retain a keyboard-readable answer instead of an inaccessible disabled field.',
  );
  assert.equal(await closedAnswer.isEditable(), false);
  assert.equal(await closedAnswer.inputValue(), retainedAnswer);
  assert.equal(
    await form.getByRole('checkbox', { name: 'Filter', exact: true }).isDisabled(),
    true,
  );
  assert.equal(await form.getByRole('checkbox', { name: 'Filter', exact: true }).isChecked(), true);
  const closedPageTop = await page.evaluate(() => scrollY);
  await closedAnswer.press('Home');
  await closedAnswer.press('End');
  await waitForAsync(page, () => document.querySelector('.agent-questions textarea').scrollTop > 0);
  assert.equal(await page.evaluate(() => scrollY), closedPageTop);
  await closedAnswer.press('Control+a');
  assert.deepEqual(
    await closedAnswer.evaluate((element) => [element.selectionStart, element.selectionEnd]),
    [0, retainedAnswer.length],
  );
  await page.keyboard.type('Cannot replace a retained answer');
  assert.equal(await closedAnswer.inputValue(), retainedAnswer);
  await form.dispatchEvent('submit');
  assert.equal(await page.evaluate(() => window.attempts), 0);
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: 328, height: 900 });
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.setProperty('--font-step', '4px');
    }, theme);
    await form.screenshot({ path: `test-results/agent-interaction/closed-${theme}-328.png` });
  }
  await page.setViewportSize({ width: 760, height: 1000 });
  await page.evaluate(() => {
    delete document.documentElement.dataset.theme;
    document.documentElement.style.removeProperty('--font-step');
  });
  for (const mode of ['draft', 'blurred-draft', 'hidden']) {
    await mount();
    await form.getByRole('radio', { name: '12 V' }).check();
    await form.getByRole('checkbox', { name: 'Filter', exact: true }).check();
    await form.getByRole('button', { name: 'Continue', exact: true }).click();
    await form.getByRole('alert').waitFor();
    await page.evaluate(() => {
      window.holdAnswer = true;
    });
    await form.getByRole('button', { name: 'Continue', exact: true }).click();
    await form.getByRole('button', { name: 'Sending…', exact: true }).waitFor();
    const otherDraft = page.getByRole('textbox', { name: 'Other draft', exact: true });
    if (mode === 'hidden') {
      await page.locator('.question-slot').evaluate((element) => {
        element.hidden = true;
      });
    } else {
      await otherDraft.fill('Keep this other draft');
      await otherDraft.evaluate((element, mode) => {
        element.setSelectionRange(2, 8);
        if (mode === 'blurred-draft') element.blur();
      }, mode);
    }
    await page.evaluate(() => window.releaseAnswer());
    await receipt.waitFor({ state: 'attached' });
    assert.equal(
      await receipt.locator('summary').evaluate((element) => document.activeElement === element),
      false,
      `${mode}: a completed answer must not reclaim a newer focus choice or hidden conversation.`,
    );
    if (mode === 'draft') {
      assert.deepEqual(
        await otherDraft.evaluate((element) => [
          element === document.activeElement,
          element.selectionStart,
          element.selectionEnd,
          element.value,
        ]),
        [true, 2, 8, 'Keep this other draft'],
      );
    }
    if (mode === 'hidden') {
      await page.locator('.question-slot').evaluate((element) => {
        element.hidden = false;
      });
      assert.equal(
        await receipt.locator('summary').evaluate((element) => document.activeElement === element),
        false,
        'Revealing a completed answer must not replay an old focus request.',
      );
    }
  }
  // Submitted long answers retain all literal content in a separate keyboard scroll area.
  await mount();
  await page.evaluate(() => {
    window.attempts = 1;
  });
  const longAnswer = 'Preserve Ω, µH and **literal answer text**.\n'.repeat(100);
  await form.getByRole('textbox', { name: 'Your answer: Voltage', exact: true }).fill(longAnswer);
  await form.getByRole('checkbox', { name: 'Filter', exact: true }).check();
  await form.getByRole('button', { name: 'Continue', exact: true }).click();
  await receipt.waitFor();
  await receipt.locator('summary').press('Enter');
  const submittedAnswers = receipt.getByRole('region', { name: 'Submitted answers', exact: true });
  assert.equal(await submittedAnswers.locator('dd').first().textContent(), longAnswer.trim());
  assert.equal(await submittedAnswers.locator('strong').count(), 0);
  const receiptBounds = await submittedAnswers.evaluate((element) => ({
    height: element.clientHeight,
    content: element.scrollHeight,
    containment: getComputedStyle(element).overscrollBehavior,
  }));
  assert.ok(receiptBounds.height <= 360 && receiptBounds.content > receiptBounds.height);
  assert.equal(receiptBounds.containment, 'contain');
  await submittedAnswers.focus();
  await submittedAnswers.press('ArrowDown');
  await page.waitForFunction(() => document.querySelector('.agent-question-answers').scrollTop > 0);
  await waitForAsync(page, async () => {
    const element = document.querySelector('.agent-question-answers');
    const before = element.scrollTop;
    await new Promise((resolve) => setTimeout(resolve, 100));
    return element.scrollTop === before;
  });
  await submittedAnswers.evaluate((element) => {
    element.scrollTop = 120;
  });
  const retainedAnswerTop = await submittedAnswers.evaluate((element) => element.scrollTop);
  await receipt.locator('summary').click();
  assert.equal(await submittedAnswers.isVisible(), false);
  await receipt.locator('summary').click();
  assert.equal(await submittedAnswers.evaluate((element) => element.scrollTop), retainedAnswerTop);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.setViewportSize({ width: 328, height: 760 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await receipt.screenshot({ path: `test-results/agent-interaction/answers-${theme}-328.png` });
  }
  await mount();
  const longHeader = 'Operating_point_'.repeat(6);
  const longPrompt =
    'Conditions:\nVout = 48 V\nInductance = 100 µH\n' + 'Switching_condition_'.repeat(20);
  await page.evaluate(
    ({ longHeader, longPrompt }) =>
      window.setQuestions([
        {
          id: 'long-condition',
          header: longHeader,
          question: longPrompt,
          options: [
            { label: 'Manufacturer_model_'.repeat(8), description: 'Use the pinned model.' },
          ],
          multiSelect: false,
        },
        { id: 'gate-drive', header: 'Gate drive', question: 'Drive voltage?', options: [] },
      ]),
    { longHeader, longPrompt },
  );
  await form.getByRole('textbox', { name: 'Your answer: ' + longHeader, exact: true }).waitFor();
  assert.equal(await form.locator('.agent-question-prompt').first().textContent(), longPrompt);
  assert.equal(
    await form
      .locator('.agent-question-prompt')
      .first()
      .evaluate((element) => getComputedStyle(element).whiteSpace),
    'pre-wrap',
  );
  for (const [width, theme, fontStep] of [
    [328, 'light', '0px'],
    [448, 'light', '0px'],
    [328, 'dark', '4px'],
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(
      ({ theme, fontStep }) => {
        document.documentElement.dataset.theme = theme;
        document.documentElement.style.setProperty('--font-step', fontStep);
      },
      { theme, fontStep },
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
      `Long question titles stay within the ${width}px conversation.`,
    );
    const titleBounds = await form.evaluate((element) => {
      const title = element.querySelector('legend');
      const number = title.querySelector('.agent-question-number');
      const text = document.createRange();
      text.selectNodeContents(title.lastChild);
      return {
        right: title.getBoundingClientRect().right,
        cardRight: element.getBoundingClientRect().right,
        width: title.clientWidth,
        content: title.scrollWidth,
        numberTop: number.getBoundingClientRect().top,
        textTop: text.getClientRects()[0].top,
      };
    });
    assert.ok(
      titleBounds.right <= titleBounds.cardRight && titleBounds.content <= titleBounds.width,
      `Long question titles remain readable inside the card: ${JSON.stringify(titleBounds)}`,
    );
    assert.ok(
      Math.abs(titleBounds.numberTop - titleBounds.textTop) < 5,
      'Question numbers align with the first title line.',
    );
    await form.screenshot({
      path: `test-results/agent-interaction/long-question-${theme}-${width}.png`,
    });
  }
  await form.getByRole('radio').check();
  await form.getByRole('textbox', { name: 'Your answer: Gate drive', exact: true }).fill('15 V');
  await form.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('alert').waitFor();
  await form.getByRole('button', { name: 'Continue', exact: true }).click();
  await receipt.waitFor();
  await receipt.locator('summary').click();
  const longAnswers = receipt.getByRole('region', { name: 'Submitted answers', exact: true });
  assert.equal(await longAnswers.locator('dt').first().textContent(), longPrompt);
  assert.equal(
    await longAnswers
      .locator('dt')
      .first()
      .evaluate((element) => getComputedStyle(element).whiteSpace),
    'pre-wrap',
  );
  assert.equal(
    await longAnswers.evaluate((element) => element.scrollWidth <= element.clientWidth),
    true,
    'Submitted question text wraps without horizontal scrolling.',
  );
  await receipt.screenshot({
    path: 'test-results/agent-interaction/long-question-receipt-328.png',
  });
  assert.deepEqual(errors, []);
  console.log(
    'Agent questions passed: long numbered titles and literal multiline prompts/receipts wrap at narrow widths; bounded drafts/receipts, single pending submission, IME, retry/focus, hidden cards, cancellation, process collapse and keyboard reviews remain intact.',
  );
} finally {
  await browser.close();
}
