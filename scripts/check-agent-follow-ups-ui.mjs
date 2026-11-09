// Actual Chat/composer/settings with controlled SSE. No Electron or real provider.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { waitForAsync } from './async-browser-test-helpers.mjs';

const bundle = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `
  import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
  import Chat from './components/Chat';import Settings from './components/SettingsDialog';
  import {emptyCircuit} from './lib/circuit';import {defaultAppearance} from './lib/appearance';
  const doc=emptyCircuit(), agents=[{id:'codex',available:true,supportsEffort:true}], noop=()=>{};
  function Fixture(){const [sessions,setSessions]=useState([{id:'first',messages:[],draft:''},{id:'second',messages:[],draft:''}]);
    const [active,setActive]=useState('first'),[settings,setSettings]=useState(false);
    const update=(id,key,value)=>setSessions(items=>items.map(item=>item.id!==id?item:{...item,[key]:typeof value==='function'?value(item[key]):value}));
    window.sessions=sessions;
    return <><nav><button onClick={()=>setSettings(true)}>Settings</button><button onClick={()=>setActive(active==='first'?'second':'first')}>Switch session</button></nav>
      <main>{sessions.map(session=><Chat key={session.id} doc={doc} agents={agents} provider="codex" effort="low" setEffort={noop}
        approvalMode="review" setApprovalMode={noop} model="fixture-model" setModel={noop} messages={session.messages} setMessages={v=>update(session.id,'messages',v)}
        input={session.draft} setInput={v=>update(session.id,'draft',v)} annotations={[]} setAnnotations={noop}
        onSettings={()=>setSettings(true)} onApply={()=>false} active={session.id===active} sessionId={session.id} conversationTitle={session.id} onRunningChange={noop}/>)}</main>
      {settings&&<Settings appearance={{appearance:defaultAppearance,update:noop,error:'',ready:true,resolvedTheme:'light'}} agents={agents}
        detecting={false} error="" onDetect={async()=>{}} onClose={()=>setSettings(false)}/>}</>;
  }createRoot(document.getElementById('root')).render(<React.StrictMode><Fixture/></React.StrictMode>);
`,
  },
  bundle: true,
  write: false,
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
});

const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    window.openpe = { connection: async () => ({ base: 'http://localhost', token: 'fixture' }) };
    window.requests = [];
    window.steers = [];
    window.savedSettings = { followUpMode: 'queue' };
    const nativeFetch = window.fetch.bind(window),
      encoder = new TextEncoder();
    window.emit = (index, event) =>
      window.requests[index].controller.enqueue(
        encoder.encode('data: ' + JSON.stringify(event) + '\n\n'),
      );
    window.complete = (index, outcome = 'completed') => {
      window.emit(index, { type: 'text', text: 'Response ' + index });
      window.emit(index, { type: 'done', outcome });
      window.requests[index].controller.close();
    };
    window.ready = (index) =>
      window.emit(index, {
        type: 'input-ready',
        runId: 'run-' + index,
        sessionId: window.requests[index].body.sessionId,
        token: 'input-' + index,
      });
    window.fetch = async (url, options = {}) => {
      const path = new URL(url, location.href).pathname;
      if (path === '/api/chat') {
        const run = { body: JSON.parse(options.body), closed: false };
        window.requests.push(run);
        return new Response(
          new ReadableStream({
            start(controller) {
              run.controller = controller;
            },
            cancel() {
              run.closed = true;
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      if (path === '/api/chat/steer') {
        const body = JSON.parse(options.body);
        window.steers.push(body);
        if (window.nativeReject)
          return new Response(
            '{"error":"Native steering rejected","code":"OPENPE_STEER_REJECTED"}',
            { status: 409 },
          );
        if (window.rejectSteer)
          return new Response('{"error":"Steering delivery uncertain"}', { status: 409 });
        const index = Number(body.runId.slice(4));
        window.emit(index, {
          type: 'input-accepted',
          requestId: body.requestId,
          sessionId: body.sessionId,
          prompt: body.prompt,
        });
        return new Response('{"ok":true}');
      }
      if (path === '/api/agent-settings') {
        if (options.method === 'POST') window.savedSettings = JSON.parse(options.body);
        return new Response(JSON.stringify(window.savedSettings));
      }
      return nativeFetch(url, options);
    };
  });
  await page.route('http://localhost/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/models')
      return route.fulfill({
        json: {
          models: [{ id: 'fixture-model', label: 'Fixture model', efforts: ['low', 'medium'] }],
          defaultModel: 'fixture-model',
        },
      });
    if (/^\/agents\/[\w.-]+\.svg$/.test(pathname))
      return route.fulfill({
        body: await readFile('public' + pathname),
        contentType: 'image/svg+xml',
      });
    if (pathname.startsWith('/api/')) throw Error('Unexpected API ' + pathname);
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({
    content:
      'body{overflow:auto}nav{display:flex;gap:16px;padding:12px}main{width:448px;height:800px;margin:0 auto}main>.chat-panel{height:100%}',
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const chat = page.locator('.chat-panel:visible'),
    input = chat.getByRole('textbox', { name: 'Message your agent' });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const waitRequests = (count) => waitForAsync(page, (n) => window.requests.length === n, count);
  const queue = chat.getByRole('region', { name: 'Queued messages' });
  const assertInputFocus = async (reason) =>
    assert.equal(
      await input.evaluate((element) => element === document.activeElement),
      true,
      reason,
    );
  const suggestion = button('Design a 12 V to 5 V, 1 A buck converter');
  await suggestion.focus();
  await suggestion.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.equal(await input.inputValue(), '');
  await suggestion.press('Enter');
  await assertInputFocus('A selected suggestion is ready for immediate editing.');
  const suggestionText = await input.inputValue();
  await suggestion.click();
  await assertInputFocus('Selecting the same suggestion again also focuses its unchanged draft.');
  assert.deepEqual(
    await input.evaluate((element) => [element.selectionStart, element.selectionEnd]),
    [suggestionText.length, suggestionText.length],
  );
  await page.keyboard.type(' with margin');
  assert.equal(await input.inputValue(), suggestionText + ' with margin');
  assert.equal(
    await page.evaluate(() => window.requests.length),
    0,
    'Suggestions never auto-send.',
  );
  await input.fill('Initial task');
  await button('Send message').click();
  await assertInputFocus('Pointer Send returns focus to the composer for a follow-up.');
  await page.keyboard.type('Immediate next draft');
  assert.equal(await input.inputValue(), 'Immediate next draft');
  await input.fill('');
  await waitRequests(1);
  await button('Settings').focus();
  await page.evaluate(() => window.ready(0));
  const collapsedInputHeight = (await input.boundingBox()).height;
  await page.evaluate(() =>
    window.emit(0, { type: 'text', text: 'Reading the circuit.\n\n'.repeat(80) }),
  );
  await chat.getByText('Reading the circuit.', { exact: true }).first().waitFor();
  assert.equal(
    await button('Settings').evaluate((element) => element === document.activeElement),
    true,
    'Later streaming updates cannot replay composer focus over a newer focus choice.',
  );
  const draft = Array.from({ length: 7 }, (_, index) => `Draft requirement ${index + 1}`).join(
    '\n',
  );
  await input.fill(draft);
  assert.ok(
    (await input.boundingBox()).height > collapsedInputHeight + 40,
    'Multiline drafts should grow the composer instead of hiding lines.',
  );
  const scroll = chat.locator('.chat-scroll');
  await page.waitForFunction(() => {
    const element = [...document.querySelectorAll('.chat-scroll')].find(
      (element) => element.clientHeight > 0,
    );
    return element.scrollHeight - element.scrollTop - element.clientHeight < 2;
  });
  const grownHeight = (await input.boundingBox()).height;
  assert.ok(grownHeight <= Math.min(220, 900 * 0.3) + 1);
  await input.fill('Describe the feedback loop and compensation. '.repeat(4));
  const wrappedHeight = (await input.boundingBox()).height;
  await page.locator('main').evaluate((element) => {
    element.style.width = '328px';
  });
  await chat.evaluate((element) => {
    element.style.width = '328px';
  });
  assert.ok(
    (await input.boundingBox()).height > wrappedHeight,
    'Narrower composers should grow with wrapped lines.',
  );
  await input.evaluate((element) => element.setSelectionRange(4, 12));
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--font-step', '4px');
  });
  assert.deepEqual(
    await input.evaluate((element) => [element.selectionStart, element.selectionEnd]),
    [4, 12],
  );
  assert.equal(await input.evaluate((element) => element === document.activeElement), true);
  assert.ok((await input.boundingBox()).height <= 221);
  await page.evaluate(() => {
    document.documentElement.style.removeProperty('--font-step');
  });
  await page.locator('main').evaluate((element) => {
    element.style.width = '448px';
  });
  await chat.evaluate((element) => {
    element.style.width = '448px';
  });
  await input.fill(draft);
  await button('Switch session').click();
  assert.equal((await input.boundingBox()).height, collapsedInputHeight);
  await button('Switch session').click();
  assert.equal(await input.inputValue(), draft);
  assert.equal((await input.boundingBox()).height, grownHeight);
  await input.fill('One line');
  await input.press('Shift+Enter');
  assert.equal(await input.inputValue(), 'One line\n');
  assert.equal(
    await page.evaluate(() => window.requests.length),
    1,
    'Shift+Enter only inserts a newline.',
  );
  const expandDraft = button('Expand draft');
  const collapseDraft = button('Collapse draft');
  assert.equal(await expandDraft.count(), 0);
  const longDraft = 'Long draft line Ω\n'.repeat(80);
  await input.fill(longDraft);
  assert.ok((await input.boundingBox()).height <= 221);
  assert.equal(
    await input.evaluate((element) => element.scrollHeight > element.clientHeight),
    true,
  );
  await page.setViewportSize({ width: 1000, height: 600 });
  assert.ok((await input.boundingBox()).height <= 181);
  await page.setViewportSize({ width: 1000, height: 900 });
  await scroll.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  await button('Latest messages').waitFor();
  const retainedSelection = [8, 25, 'backward'];
  const draftSelection = () =>
    input.evaluate((element) => [
      element.selectionStart,
      element.selectionEnd,
      element.selectionDirection,
    ]);
  await input.evaluate((element) => element.setSelectionRange(8, 25, 'backward'));
  await input.dispatchEvent('compositionstart');
  await expandDraft.click();
  assert.equal(await collapseDraft.count(), 0);
  await assertInputFocus('Composition keeps the original draft input focused.');
  assert.deepEqual(await draftSelection(), retainedSelection);
  await input.dispatchEvent('compositionend');
  await expandDraft.dispatchEvent('keydown', { key: 'Enter', keyCode: 229 });
  assert.equal(await collapseDraft.count(), 0);
  await expandDraft.press('Enter');
  await assertInputFocus('Expanding returns focus to the original draft input.');
  assert.deepEqual(await draftSelection(), retainedSelection);
  assert.equal(await input.inputValue(), longDraft);
  assert.ok((await input.boundingBox()).height > 221 && (await input.boundingBox()).height <= 451);
  await input.dispatchEvent('keydown', { key: 'Enter', repeat: true });
  assert.equal(await queue.count(), 0);
  assert.equal(await input.inputValue(), longDraft);
  assert.equal(await scroll.evaluate((element) => element.scrollTop), 0);
  await button('Switch session').click();
  assert.equal(await collapseDraft.count(), 0);
  await button('Switch session').click();
  await collapseDraft.waitFor();
  assert.equal(await input.inputValue(), longDraft);
  assert.deepEqual(await draftSelection(), retainedSelection);
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.locator('main').evaluate((element) => (element.style.width = '328px'));
  await chat.evaluate((element) => (element.style.width = '328px'));
  await page.evaluate(() => document.documentElement.style.setProperty('--font-step', '4px'));
  assert.ok((await input.boundingBox()).height <= 301);
  assert.ok((await input.boundingBox()).height > 181);
  assert.equal(await collapseDraft.getAttribute('aria-expanded'), 'true');
  await mkdir('test-results/agent-follow-ups', { recursive: true });
  await chat
    .locator('.composer')
    .screenshot({ path: 'test-results/agent-follow-ups/expanded-draft-328.png' });
  await collapseDraft.press('Space');
  await assertInputFocus('Collapsing returns focus to the original draft input.');
  assert.deepEqual(await draftSelection(), retainedSelection);
  assert.ok((await input.boundingBox()).height <= 181);
  await expandDraft.press('Enter');
  await input.fill('');
  assert.equal(await collapseDraft.count(), 0);
  assert.equal(await expandDraft.count(), 0);
  await page.evaluate(() => document.documentElement.style.removeProperty('--font-step'));
  await page.locator('main').evaluate((element) => (element.style.width = '448px'));
  await chat.evaluate((element) => (element.style.width = '448px'));
  await page.setViewportSize({ width: 1000, height: 900 });
  assert.equal(await page.evaluate(() => window.requests.length), 1);
  await input.fill(draft);
  assert.equal(
    await scroll.evaluate((element) => element.scrollTop),
    0,
    'Resizing a draft must not move a reader away from older messages.',
  );
  await input.fill('');
  assert.equal((await input.boundingBox()).height, collapsedInputHeight);
  await button('Latest messages').click();
  assert.equal(await chat.getByRole('button', { name: 'Follow-up mode' }).count(), 0);
  await input.fill('IME draft');
  await input.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.equal(await page.evaluate(() => window.requests.length), 1);
  assert.equal(await queue.count(), 0);
  await page.evaluate(() => {
    document.documentElement.dataset.smartPunctuation = 'true';
  });
  await input.fill('Wait..');
  await input.dispatchEvent('compositionstart');
  await input.press('.');
  assert.equal(
    await input.inputValue(),
    'Wait...',
    'Intermediate IME text cannot be rewritten by smart punctuation.',
  );
  await input.dispatchEvent('compositionend');
  await input.fill('Again..');
  await input.press('.');
  assert.equal(
    await input.inputValue(),
    'Again…',
    'Smart punctuation resumes for ordinary input after composition ends.',
  );
  await input.evaluate((element) => {
    const schedule = window.requestAnimationFrame;
    window.requestAnimationFrame = (callback) => {
      window.pendingPunctuationCaret = callback;
      return 0;
    };
    try {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(
        element,
        'Pending...',
      );
      element.setSelectionRange(element.value.length, element.value.length);
      element.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '.' }),
      );
    } finally {
      window.requestAnimationFrame = schedule;
    }
  });
  assert.equal(await input.inputValue(), 'Pending…');
  await input.dispatchEvent('compositionstart');
  await input.evaluate((element) => {
    element.setSelectionRange(1, 1);
    window.pendingPunctuationCaret(performance.now());
    delete window.pendingPunctuationCaret;
  });
  assert.equal(
    await input.evaluate((element) => element.selectionStart),
    1,
    'An earlier punctuation caret update cannot move the caret during a new composition.',
  );
  await input.dispatchEvent('compositionend');
  await page.evaluate(() => {
    delete document.documentElement.dataset.smartPunctuation;
  });
  await input.fill('IME draft');
  await input.dispatchEvent('compositionstart');
  await input.dispatchEvent('keydown', { key: 'Enter', keyCode: 13, isComposing: false });
  assert.equal(
    await queue.count(),
    0,
    'An active composition must block Enter even when the event flag is false.',
  );
  assert.equal(await input.inputValue(), 'IME draft');
  await button('Queue message').click();
  assert.equal(await queue.count(), 0, 'Pointer Send cannot submit an unfinished composition.');
  await assertInputFocus('A blocked pointer action cannot blur the composing input.');
  await input.dispatchEvent('compositionend');
  for (const text of ['Remove first', 'Remove middle', 'Remove last']) {
    await input.fill(text);
    await button('Queue message').click();
    await assertInputFocus('Pointer Queue returns focus for continued typing.');
  }
  const retainedDraft = 'Keep draft value';
  await input.fill(retainedDraft);
  await input.evaluate((element) => element.setSelectionRange(2, 6));
  await scroll.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  const pageOffset = await page.evaluate(() => scrollY);
  await input.dispatchEvent('compositionstart');
  await queue.locator('li').nth(1).getByRole('button', { name: 'Remove queued message' }).click();
  assert.equal(
    await queue.locator('li').count(),
    3,
    'Pointer removal cannot change the queue during composer composition.',
  );
  await assertInputFocus('A blocked queue action keeps the composing input focused.');
  const queueSteersBeforeComposition = await page.evaluate(() => window.steers.length);
  await queue.locator('li').first().getByRole('button', { name: 'Steer', exact: true }).click();
  assert.equal(await page.evaluate(() => window.steers.length), queueSteersBeforeComposition);
  await queue.getByRole('combobox', { name: 'Queued message actions' }).first().click();
  assert.equal(await page.getByRole('listbox').count(), 0);
  for (const target of [
    queue.getByRole('button', { name: 'Remove queued message' }).first(),
    queue.getByRole('button', { name: 'Steer', exact: true }).first(),
    queue.getByRole('combobox', { name: 'Queued message actions' }).first(),
  ]) {
    assert.equal(
      await target.evaluate((element) =>
        element.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Enter',
            keyCode: 13,
            isComposing: false,
            bubbles: true,
            cancelable: true,
          }),
        ),
      ),
      false,
      'Active composition blocks queue keyboard actions even without a native composition flag.',
    );
  }
  await assertInputFocus('A blocked queue menu cannot interrupt the composition.');
  assert.equal(await input.inputValue(), retainedDraft);
  assert.deepEqual(
    await input.evaluate((element) => [element.selectionStart, element.selectionEnd]),
    [2, 6],
  );
  assert.equal(await scroll.evaluate((element) => element.scrollTop), 0);
  assert.equal(await page.evaluate(() => scrollY), pageOffset);
  await input.dispatchEvent('compositionend');
  await queue
    .locator('li')
    .nth(1)
    .getByRole('button', { name: 'Remove queued message' })
    .press('Enter');
  const removeLast = queue
    .locator('li')
    .last()
    .getByRole('button', { name: 'Remove queued message' });
  assert.equal(
    await removeLast.evaluate((element) => element === document.activeElement),
    true,
    'Deleting a queue row should focus the following row, allowing continuous keyboard removal.',
  );
  await removeLast.press('Enter');
  const removeFirst = queue.getByRole('button', { name: 'Remove queued message' });
  assert.equal(await removeFirst.evaluate((element) => element === document.activeElement), true);
  await removeFirst.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.equal(await queue.locator('li').count(), 1);
  await removeFirst.press('Enter');
  assert.equal(await queue.count(), 0);
  assert.equal(await input.evaluate((element) => element === document.activeElement), true);
  assert.equal(await input.inputValue(), retainedDraft);
  assert.deepEqual(
    await input.evaluate((element) => [element.selectionStart, element.selectionEnd]),
    [2, 6],
  );
  assert.equal(await scroll.evaluate((element) => element.scrollTop), 0);
  assert.equal(await page.evaluate(() => scrollY), pageOffset);
  await page.keyboard.type('X');
  assert.equal(await input.inputValue(), retainedDraft.slice(0, 2) + 'X' + retainedDraft.slice(6));
  for (let index = 0; index < 8; index++) {
    await input.fill(`Scroll removal ${index}`);
    await input.press('Enter');
  }
  await input.fill('Long queue draft');
  await input.evaluate((element) => element.setSelectionRange(3, 3));
  await queue.getByRole('button', { name: 'Remove queued message' }).first().focus();
  await queue.locator('ol').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  assert.ok(await queue.locator('ol').evaluate((element) => element.scrollTop > 0));
  await page.keyboard.press('Enter');
  assert.equal(await queue.locator('li').count(), 7);
  assert.equal(
    await queue.locator('ol').evaluate((element) => {
      const button = document.activeElement;
      const bounds = element.getBoundingClientRect(),
        focused = button.getBoundingClientRect();
      return (
        element.contains(button) &&
        focused.top >= bounds.top - 1 &&
        focused.bottom <= bounds.bottom + 1
      );
    }),
    true,
    'Queue removal should reveal the new focus only inside the bounded queue viewport.',
  );
  assert.equal(await scroll.evaluate((element) => element.scrollTop), 0);
  assert.equal(await page.evaluate(() => scrollY), pageOffset);
  for (let remaining = 6; remaining >= 0; remaining--) {
    await page.keyboard.press('Enter');
    assert.equal(await queue.locator('li').count(), remaining);
  }
  assert.equal(await input.evaluate((element) => element === document.activeElement), true);
  assert.equal(await input.inputValue(), 'Long queue draft');
  assert.deepEqual(
    await input.evaluate((element) => [element.selectionStart, element.selectionEnd]),
    [3, 3],
  );
  await input.fill('First queued');
  await input.press('Enter');
  await input.fill('Second queued');
  await input.press('Enter');
  assert.equal(await queue.locator('li').count(), 2);
  assert.equal(await page.evaluate(() => window.requests.length), 1);
  const firstQueuedRow = queue.locator('li').first();
  const queuePreview = firstQueuedRow.getByRole('button', {
    name: 'Preview queued message',
    exact: true,
  });
  const queuedMessageDialog = page.getByRole('dialog', { name: 'Queued message', exact: true });
  const whitespaceDraft = ' \n ';
  await input.fill(whitespaceDraft);
  await input.evaluate((element) => element.setSelectionRange(1, 2));
  await input.dispatchEvent('compositionstart');
  await queuePreview.click();
  assert.equal(await queuedMessageDialog.count(), 0);
  await assertInputFocus('Preview cannot interrupt a composing draft.');
  await input.dispatchEvent('compositionend');
  await queuePreview.press('Enter');
  await queuedMessageDialog.waitFor();
  assert.equal(
    await queuedMessageDialog
      .getByRole('region', { name: 'Queued message text', exact: true })
      .textContent(),
    'First queued',
  );
  await page.keyboard.press('Escape');
  await queuedMessageDialog.waitFor({ state: 'hidden' });
  assert.equal(await queuePreview.evaluate((element) => element === document.activeElement), true);
  assert.deepEqual(
    await input.evaluate((element) => [
      element.value,
      element.selectionStart,
      element.selectionEnd,
    ]),
    [whitespaceDraft, 1, 2],
  );
  assert.equal(await queue.locator('li').count(), 2);
  assert.deepEqual(await page.evaluate(() => [window.requests.length, window.requests[0].closed]), [
    1,
    false,
  ]);
  const firstQueuedActions = firstQueuedRow.getByRole('combobox', {
    name: 'Queued message actions',
  });
  await firstQueuedActions.press('Enter');
  assert.equal(
    await page
      .getByRole('option', { name: 'Edit message', exact: true })
      .getAttribute('aria-disabled'),
    'true',
  );
  await firstQueuedActions.press('Escape');
  assert.equal(await input.inputValue(), whitespaceDraft);
  await input.fill('');
  // Editing via keyboard must restore focus once without losing a reading position.
  await scroll.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  await queue
    .locator('li')
    .first()
    .getByRole('combobox', { name: 'Queued message actions' })
    .press('Enter');
  await page.getByRole('option', { name: 'Edit message', exact: true }).press('Enter');
  assert.equal(await input.inputValue(), 'First queued');
  assert.equal(await input.evaluate((element) => element === document.activeElement), true);
  assert.equal(await input.evaluate((element) => element.selectionStart), 'First queued'.length);
  assert.equal(await scroll.evaluate((element) => element.scrollTop), 0);
  await input.evaluate((element) => element.setSelectionRange(2, 5));
  await page.evaluate(() => window.emit(0, { type: 'text', text: 'Progress while editing.' }));
  await chat.getByText('Progress while editing.', { exact: true }).waitFor();
  assert.equal(await input.evaluate((element) => element === document.activeElement), true);
  assert.deepEqual(
    await input.evaluate((element) => [element.selectionStart, element.selectionEnd]),
    [2, 5],
  );
  await input.press('Enter');
  const restoredQueued = queue.locator('li').filter({ hasText: 'First queued' });
  await restoredQueued.getByRole('combobox', { name: 'Queued message actions' }).click();
  await page.getByRole('option', { name: 'Send next', exact: true }).click();
  await input.fill('Protect the current draft');
  await queue
    .locator('li')
    .first()
    .getByRole('combobox', { name: 'Queued message actions' })
    .click();
  assert.equal(
    await page
      .getByRole('option', { name: 'Edit message', exact: true })
      .getAttribute('aria-disabled'),
    'true',
  );
  await page.keyboard.press('Escape');
  assert.equal(await input.inputValue(), 'Protect the current draft');
  await input.fill('');
  await button('Switch session').click();
  assert.equal(await queue.count(), 0);
  await input.fill('Independent draft');
  await button('Switch session').click();
  assert.equal(await queue.locator('li').count(), 2);
  await mkdir('test-results/agent-follow-ups', { recursive: true });
  await page.screenshot({ path: 'test-results/agent-follow-ups/queue-light.png', fullPage: true });
  await chat
    .locator('.composer-stack')
    .screenshot({ path: 'test-results/agent-follow-ups/composer-light.png' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.screenshot({ path: 'test-results/agent-follow-ups/queue-dark.png', fullPage: true });
  await chat
    .locator('.composer-stack')
    .screenshot({ path: 'test-results/agent-follow-ups/composer-dark.png' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  // Promote one queued message into the same run; it must not start a second request.
  await page.evaluate(() => window.emit(0, { type: 'text', text: 'Inspecting the circuit.' }));
  await chat.getByText('Inspecting the circuit.', { exact: true }).waitFor();
  await queue.locator('li').first().getByRole('button', { name: 'Steer', exact: true }).click();
  await waitForAsync(page, () => window.steers.length === 1);
  await chat.locator('.message.user').filter({ hasText: 'First queued' }).waitFor();
  assert.equal(
    await chat
      .locator('.chat-transcript')
      .evaluate(
        (transcript) =>
          transcript.lastElementChild.matches('.chat-progress') &&
          transcript.querySelector('.message:last-of-type').nextElementSibling ===
            transcript.lastElementChild,
      ),
    true,
    'Live model status stays below accepted steering messages.',
  );
  assert.deepEqual(
    await chat
      .locator('.message')
      .evaluateAll((items) =>
        items.map((item) => (item.classList.contains('user') ? 'user' : 'assistant')),
      ),
    ['user', 'assistant', 'user'],
  );
  assert.equal(await page.evaluate(() => window.requests.length), 1);
  assert.equal(await queue.locator('li').count(), 1);
  await page.evaluate(() => window.complete(0));
  await waitRequests(2);
  assert.equal(await page.evaluate(() => window.requests[1].body.prompt), 'Second queued');
  assert.ok(
    await page.evaluate(() =>
      window.requests[1].body.history.some((m) => m.text === 'First queued'),
    ),
  );
  assert.deepEqual(await page.evaluate(() => window.requests[1].body.history.map((m) => m.role)), [
    'user',
    'assistant',
    'user',
  ]);
  // Stop pauses subsequent work and keeps both queue and unrelated session draft.
  await input.fill('After stop');
  await input.press('Enter');
  await button('Stop generation').click();
  await assertInputFocus('Pointer Stop returns focus even when the draft is empty.');
  await queue.getByText('Queue paused', { exact: true }).waitFor();
  await input.fill('Composing next draft');
  await input.dispatchEvent('compositionstart');
  await button('Resume queue').click();
  assert.equal(await page.evaluate(() => window.requests.length), 2);
  assert.equal(await input.inputValue(), 'Composing next draft');
  await queue.getByText('Queue paused', { exact: true }).waitFor();
  await assertInputFocus('A blocked Resume keeps the paused queue and composing input intact.');
  await input.dispatchEvent('compositionend');
  await input.fill('');
  await button('Resume queue').click();
  await waitRequests(3);
  await page.evaluate(() => window.ready(2));
  // Configure once in Settings; subsequent sends directly steer the active turn.
  await button('Settings').click();
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  await page.getByRole('combobox', { name: 'Messages sent while running', exact: true }).click();
  await page.getByRole('option', { name: /^Steer/ }).click();
  await button('Done').click();
  assert.equal(await page.evaluate(() => window.savedSettings.followUpMode), 'steer');
  const steersBeforeComposition = await page.evaluate(() => window.steers.length);
  await input.fill('Steering composition');
  await input.dispatchEvent('compositionstart');
  await input.dispatchEvent('keydown', { key: 'Enter', keyCode: 13, isComposing: false });
  await button('Steer current run').click();
  assert.equal(
    await page.evaluate(() => window.steers.length),
    steersBeforeComposition,
    'Active composition cannot steer through keyboard or pointer Send.',
  );
  assert.equal(await input.inputValue(), 'Steering composition');
  await input.dispatchEvent('compositionend');
  await input.fill('Immediate correction');
  await button('Steer current run').click();
  await assertInputFocus('Pointer Steer returns focus to the originating composer.');
  await waitForAsync(page, () => window.steers.length === 2);
  assert.equal(await page.evaluate(() => window.requests.length), 3);
  await input.fill('Rejected correction');
  await page.evaluate(() => (window.rejectSteer = true));
  await button('Steer current run').click();
  await chat.getByRole('alert').filter({ hasText: 'Steering delivery uncertain' }).waitFor();
  assert.equal(await input.inputValue(), 'Rejected correction');
  await assertInputFocus('A failed steering delivery leaves its draft ready for correction.');
  await page.evaluate(() => (window.rejectSteer = false));
  // The same text retries with the same request identity after uncertain delivery.
  await button('Steer current run').click();
  await waitForAsync(page, () => window.steers.length === 4);
  assert.equal(
    await page.evaluate(() => window.steers[2].requestId === window.steers[3].requestId),
    true,
  );
  await chat.locator('.message.user').filter({ hasText: 'Rejected correction' }).waitFor();
  assert.deepEqual(
    await page.evaluate(() =>
      window.sessions[0].messages.slice(-3).map(({ role, text }) => [role, text]),
    ),
    [
      ['assistant', ''],
      ['user', 'Immediate correction'],
      ['user', 'Rejected correction'],
    ],
  );
  // A repeated acknowledgment cannot duplicate or reorder an accepted input.
  await page.evaluate(() => {
    const { requestId, sessionId, prompt } = window.steers[1];
    window.emit(2, { type: 'input-accepted', requestId, sessionId, prompt });
  });
  await page.evaluate(() => window.complete(2));
  await button('Send message').waitFor({ state: 'visible' });
  assert.equal(
    await chat
      .locator('.message.assistant')
      .last()
      .locator('.message-actions')
      .evaluate((actions) => getComputedStyle(actions).opacity),
    '1',
    'The latest reply keeps its copy action visible even with later accepted steering messages.',
  );
  assert.deepEqual(
    await page.evaluate(() =>
      window.sessions[0].messages.slice(-3).map(({ role, text }) => [role, text]),
    ),
    [
      ['assistant', 'Response 2'],
      ['user', 'Immediate correction'],
      ['user', 'Rejected correction'],
    ],
  );
  // A turn without input-ready automatically uses Queue even with Steer selected.
  await input.fill('No native steering');
  await button('Send message').click();
  await waitRequests(4);
  await input.fill('Fallback queue');
  await button('Queue message').click();
  assert.equal(await queue.locator('li').count(), 1);
  assert.equal(await queue.getByRole('button', { name: 'Steer', exact: true }).isDisabled(), true);
  await page.evaluate(() => window.complete(3, 'failed'));
  await queue.getByText('Queue paused', { exact: true }).waitFor();
  await queue.getByRole('combobox', { name: 'Queued message actions' }).click();
  await page.getByRole('option', { name: 'Edit message', exact: true }).click();
  assert.equal(await input.inputValue(), 'Fallback queue');
  assert.equal(await queue.count(), 0);
  assert.equal(
    await input.evaluate((element) => element === document.activeElement),
    true,
    'Editing a queued message should move keyboard focus into the restored draft.',
  );
  assert.deepEqual(
    await input.evaluate((element) => [element.selectionStart, element.selectionEnd]),
    ['Fallback queue'.length, 'Fallback queue'.length],
    'The restored draft should be ready for continued typing.',
  );
  await page.keyboard.type(' revised');
  assert.equal(await input.inputValue(), 'Fallback queue revised');
  await button('Switch session').click();
  assert.equal(await input.inputValue(), 'Independent draft');
  await button('Switch session').click();
  // Equal queued text still has independent identities. A late native receipt
  // removes its original row even after a different steering attempt began.
  await button('Send message').click();
  await waitRequests(5);
  await page.evaluate(() => window.ready(4));
  await button('Settings').click();
  await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  await page.getByRole('combobox', { name: 'Messages sent while running', exact: true }).click();
  await page.getByRole('option', { name: /^Queue/ }).click();
  await button('Done').click();
  for (const text of ['Duplicate prompt', 'Duplicate prompt', 'Remove me']) {
    await input.fill(text);
    await input.press('Enter');
  }
  await page.evaluate(() => (window.rejectSteer = true));
  const firstAttempt = await page.evaluate(() => window.steers.length);
  await queue.locator('li').first().getByRole('button', { name: 'Steer', exact: true }).click();
  await chat.getByRole('alert').filter({ hasText: 'Steering delivery uncertain' }).waitFor();
  assert.equal(await queue.locator('li').count(), 3);
  const reuseInitial = chat
    .locator('.message.user')
    .first()
    .getByRole('button', { name: 'Reuse message', exact: true });
  assert.equal(await input.inputValue(), '');
  assert.equal(
    await reuseInitial.isDisabled(),
    true,
    'Uncertain native input delivery protects the empty draft from reuse.',
  );
  await input.press('ArrowUp');
  assert.equal(await input.inputValue(), '');
  assert.equal(await input.getAttribute('aria-keyshortcuts'), null);
  assert.equal(await queue.locator('li').count(), 3);
  await queue.locator('li').last().getByRole('button', { name: 'Remove queued message' }).click();
  await page.evaluate(() => (window.rejectSteer = false));
  await queue.locator('li').nth(1).getByRole('button', { name: 'Steer', exact: true }).click();
  await waitForAsync(page, (n) => window.steers.length === n, firstAttempt + 2);
  assert.equal(await queue.locator('li').count(), 1);
  assert.equal(
    await page.evaluate(
      (n) => window.steers[n].requestId !== window.steers[n + 1].requestId,
      firstAttempt,
    ),
    true,
  );
  await page.evaluate((n) => {
    const { requestId, sessionId, prompt } = window.steers[n];
    window.emit(4, { type: 'input-accepted', requestId, sessionId, prompt });
  }, firstAttempt);
  await queue.waitFor({ state: 'hidden' });
  // Explicit native rejection is safe to retry as a new user request.
  await page.evaluate(() => (window.nativeReject = true));
  await input.fill('Retry explicit rejection');
  const rejectedAt = await page.evaluate(() => window.steers.length);
  // Queue is still the default, so promote this entry explicitly.
  await input.press('Enter');
  await queue.getByRole('button', { name: 'Steer', exact: true }).click();
  await chat.getByRole('alert').filter({ hasText: 'Native steering rejected' }).waitFor();
  await page.evaluate(() => (window.nativeReject = false));
  await queue.getByRole('button', { name: 'Steer', exact: true }).click();
  await queue.waitFor({ state: 'hidden' });
  assert.equal(
    await page.evaluate(
      (n) => window.steers[n].requestId !== window.steers[n + 1].requestId,
      rejectedAt,
    ),
    true,
  );
  await page.evaluate(() => window.complete(4, 'failed'));
  const restoreOriginal = chat
    .locator('.message.assistant')
    .last()
    .getByRole('button', { name: 'Edit original prompt', exact: true });
  await restoreOriginal.press('Enter');
  assert.equal(await input.inputValue(), await page.evaluate(() => window.requests[4].body.prompt));
  assert.equal(await page.evaluate(() => window.requests.length), 5);
  await page.setViewportSize({ width: 500, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  console.log(
    'Agent follow-ups UI passed: queue order/promotion, settings, native rejection/retry, stop/failure, session isolation and IME.',
  );
} finally {
  await browser.close();
}
