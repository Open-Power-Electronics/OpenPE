// Actual Chat with controlled SSE and an independent editor; no Electron or real provider.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { waitForAsync } from './async-browser-test-helpers.mjs';

const bundle = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `import React,{useState,useRef}from'react';import{createRoot}from'react-dom/client';
      import PanelFindController from './components/PanelFindController';import Chat from './components/Chat';import{emptyCircuit}from'./lib/circuit';
      import{annotationFixture}from'./tests/fixtures/annotation';
      const doc=emptyCircuit(),noop=()=>{},agents=[{id:'codex',available:true,supportsEffort:true}];
      const capabilities={query:()=>new Promise(resolve=>{window.releaseToolQuery=resolve}),observe:async()=>null,execute:async()=>null};
      const originalMessage={id:'reusable-source',role:'user',text:'Original **literal** requirement.\\n'+'Preserve Ω, µH and native parameters.\\n'.repeat(40)+'Unexpanded final requirement.',annotations:[annotationFixture()]};
      function Fixture(){const workspace=useRef(null),findControl=useRef(null);const[messages,setMessages]=useState([originalMessage,{id:'annotation-only',role:'user',text:'',annotations:[annotationFixture()]},{id:'earlier',role:'assistant',text:'Earlier reference.[^scope]\\n\\n'+'Earlier discussion.\\n\\n'.repeat(60)+'[^scope]: Earlier measurement conditions.'}]),[input,setInput]=useState(''),[active,setActive]=useState(true),[annotations,setAnnotations]=useState([]);window.setChatVisible=setActive;window.setReadingMessages=setMessages;window.readingFixture={messages,annotations};
        return <><div ref={workspace} style={{display:'contents'}}><main hidden={!active}><Chat doc={doc} agents={agents} provider="codex" effort="low" setEffort={noop}
          approvalMode="review" setApprovalMode={noop} model="fixture-model" setModel={noop} messages={messages} setMessages={setMessages}
          input={input} setInput={setInput} annotations={annotations} setAnnotations={setAnnotations} onSettings={noop} onApply={()=>false}
          onFind={()=>findControl.current?.open('agent')} active={active} sessionId="reading" conversationTitle="Reading" onRunningChange={noop} capabilities={capabilities}/></main>
          <aside id="editor" className="editor"><textarea aria-label="Editor draft" defaultValue="Keep editor selection"/><div style={{height:1400}}>Design stays here</div></aside></div><PanelFindController workspace={workspace} control={findControl} active={active} scopeKey={String(active)}/></>}
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
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const encoder = new TextEncoder();
    window.runs = [];
    window.openpe = { connection: async () => ({ base: 'http://localhost', token: 'fixture' }) };
    window.emit = (index, value) =>
      window.runs[index].enqueue(encoder.encode('data: ' + JSON.stringify(value) + '\n\n'));
    window.copies = [];
    window.copyAttempts = [];
    window.answerRequests = [];
    window.answerResponses = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.copyAttempts.push(text);
          if (window.holdResponseCopy)
            await new Promise((resolve, reject) => {
              window.settleResponseCopy = (success) =>
                success ? resolve() : reject(new Error('Fixture clipboard denied'));
            });
          window.copies.push(text);
        },
      },
    });
    const nativeFetch = fetch;
    window.fetch = async (url, options) => {
      const path = new URL(url, location.href).pathname;
      if (path === '/api/agent-settings') return new Response('{"followUpMode":"queue"}');
      if (path === '/api/chat/tool-result') return new Response('{"ok":true}');
      if (path === '/api/chat/answer') {
        window.answerRequests.push({
          body: JSON.parse(options.body),
          token: options.headers['X-OpenPE-Token'],
        });
        if (window.delayAnswers)
          return new Promise((resolve) => {
            window.answerResponses.push((error) =>
              resolve(
                new Response(JSON.stringify(error ? { error } : { ok: true }), {
                  status: error ? 503 : 200,
                }),
              ),
            );
          });
        return new Response('{"ok":true}');
      }
      if (path === '/api/chat')
        return new Response(
          new ReadableStream({
            start(controller) {
              window.runs.push(controller);
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      return nativeFetch(url, options);
    };
  });
  await page.route('http://localhost/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/models')
      return route.fulfill({
        json: {
          models: [{ id: 'fixture-model', label: 'Fixture model', efforts: ['low'] }],
          defaultModel: 'fixture-model',
        },
      });
    if (/^\/agents\/[\w.-]+\.svg$/.test(pathname))
      return route.fulfill({
        body: await readFile('public' + pathname),
        contentType: 'image/svg+xml',
      });
    if (pathname === '/')
      return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    throw new Error('Unexpected fixture request: ' + pathname);
  });
  await page.goto('http://localhost/');
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({
    content:
      'body{overflow:auto}#root{display:flex;gap:32px;padding:12px}main{width:448px;height:760px}main>.chat-panel{height:100%}#editor{height:760px;width:400px;overflow:auto}',
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const input = page.getByRole('textbox', { name: 'Message your agent', exact: true });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const chat = page.locator('.chat-scroll');
  const atBottom = () =>
    waitForAsync(page, () => {
      const element = document.querySelector('.chat-scroll');
      return element.scrollHeight - element.scrollTop - element.clientHeight < 2;
    });
  const send = async (text, count) => {
    await input.fill(text);
    await button('Send message').click();
    await waitForAsync(page, (count) => window.runs.length === count, count);
  };
  const emit = (index, event) =>
    page.evaluate(({ index, event }) => window.emit(index, event), { index, event });
  await atBottom();
  assert.equal(await input.getAttribute('aria-keyshortcuts'), 'ArrowUp ArrowDown');
  await input.press('Shift+ArrowUp');
  await input.dispatchEvent('keydown', { key: 'ArrowUp', repeat: true });
  assert.deepEqual(await page.evaluate(() => window.readingFixture.annotations), []);
  await input.press('ArrowUp');
  const pendingAnnotations = page.getByLabel('Pending annotations', { exact: true });
  await pendingAnnotations.waitFor();
  assert.equal(await input.inputValue(), '');
  assert.ok(
    await page.evaluate(() => {
      const [attachment] = window.readingFixture.annotations;
      const [original] = window.readingFixture.messages[1].annotations;
      return (
        attachment !== original &&
        attachment.elements !== original.elements &&
        JSON.stringify(attachment) === JSON.stringify(original) &&
        window.runs.length === 0
      );
    }),
  );
  await input.press('ArrowUp');
  const originalPromptText = await page.evaluate(() => window.readingFixture.messages[0].text);
  assert.equal(await input.inputValue(), originalPromptText);
  assert.equal(await input.evaluate((field) => field.selectionStart), 0);
  assert.ok(
    await page.evaluate(() => {
      const [attachment] = window.readingFixture.annotations;
      const [original] = window.readingFixture.messages[0].annotations;
      return attachment !== original && JSON.stringify(attachment) === JSON.stringify(original);
    }),
  );
  await input.press('ArrowDown');
  assert.equal(await input.inputValue(), originalPromptText);
  assert.ok(await input.evaluate((field) => field.selectionStart > 0));
  await input.evaluate((field) => field.setSelectionRange(field.value.length, field.value.length));
  await input.dispatchEvent('keydown', { key: 'ArrowDown', keyCode: 229 });
  assert.equal(await input.inputValue(), originalPromptText);
  await input.press('ArrowDown');
  assert.equal(await input.inputValue(), '');
  assert.equal(
    await pendingAnnotations
      .getByRole('button', { name: 'Remove annotation 1', exact: true })
      .count(),
    1,
  );
  await input.press('ArrowDown');
  await pendingAnnotations.waitFor({ state: 'detached' });
  assert.equal(await input.inputValue(), '');
  assert.equal(await page.evaluate(() => window.runs.length), 0);
  await input.press('ArrowUp');
  await pendingAnnotations.waitFor();
  await page.evaluate(() => window.setChatVisible(false));
  await pendingAnnotations.waitFor({ state: 'hidden' });
  await page.evaluate(() => window.setChatVisible(true));
  await pendingAnnotations.waitFor();
  await input.press('ArrowDown');
  assert.equal(await pendingAnnotations.isVisible(), true);
  await pendingAnnotations
    .getByRole('button', { name: 'Remove annotation 1', exact: true })
    .click();
  if (await button('Latest messages').count()) await button('Latest messages').click();
  await atBottom();
  const findConversation = button('Find in conversation');
  const searchBar = page.getByRole('search', { name: 'Find in Agent', exact: true });
  const search = searchBar.getByRole('searchbox', { name: 'Search Agent', exact: true });
  await input.fill('Preserve this draft Ω.');
  await input.evaluate((field) => field.setSelectionRange(2, 9));
  await input.dispatchEvent('compositionstart');
  await input.dispatchEvent('keydown', { key: 'f', ctrlKey: true });
  assert.equal(await searchBar.count(), 0);
  await input.dispatchEvent('compositionend');
  await chat.hover();
  await input.focus();
  await page.keyboard.press('Control+f');
  await search.waitFor();
  assert.equal(await page.getByRole('dialog', { name: /Find/ }).count(), 0);
  await search.fill('No such phrase');
  await waitForAsync(
    page,
    () => document.querySelector('[data-panel-find] [role=status]')?.textContent === '0/0',
  );
  await search.press('Escape');
  await searchBar.waitFor({ state: 'detached' });
  assert.deepEqual(
    await input.evaluate((field) => [field.value, field.selectionStart, field.selectionEnd]),
    ['Preserve this draft Ω.', 2, 9],
  );
  if (await button('Latest messages').count()) await button('Latest messages').click();
  await atBottom();
  await send('Inspect this converter.', 1);
  await emit(0, {
    type: 'process',
    id: 'notes',
    text:
      'Detailed working note.\n\n'.repeat(50) +
      '[Reference conditions](https://example.test/conditions)',
  });
  await emit(0, {
    type: 'process',
    id: 'conditions',
    text: 'Additional operating conditions.\n\n'.repeat(10),
  });
  await page.getByRole('link', { name: 'Reference conditions', exact: true }).waitFor();
  assert.equal(await page.getByRole('region', { name: 'Work note', exact: true }).count(), 0);
  assert.equal(
    await page.getByRole('region', { name: 'Work details content', exact: true }).count(),
    0,
    'Running work uses the conversation viewport without adding bounded reading targets.',
  );
  await emit(0, { type: 'text', text: 'Converter overview.' });
  await findConversation.click();
  await search.fill('Original');
  await search.press('Enter');
  await search.press('Escape');
  await searchBar.waitFor({ state: 'detached' });
  const promptPosition = await chat.evaluate((element) => element.scrollTop);
  await emit(0, { type: 'text', text: '\n\nAdditional streamed overview.' });
  await page
    .getByText('Additional streamed overview.', { exact: true })
    .waitFor({ state: 'attached' });
  assert.equal(await chat.evaluate((element) => element.scrollTop), promptPosition);
  await button('Latest messages').click();
  await emit(0, { type: 'done', outcome: 'completed' });
  await page.evaluate(() => window.runs[0].close());
  await button('Send message').waitFor();
  await send('Follow up on the feedback loop.', 2);
  await atBottom();
  const summary = page.locator('.agent-process > summary').last();
  const viewport = await chat.boundingBox();
  const before = await summary.boundingBox();
  assert.ok(
    before.y >= viewport.y && before.y + before.height <= viewport.y + viewport.height,
    'The work header starts visible, so the click cannot itself scroll it into view.',
  );
  await summary.focus();
  await summary.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.equal(await button('Latest messages').count(), 0);
  await summary.press('Enter');
  await summary.locator('..').locator('.agent-process-body').waitFor();
  await button('Latest messages').waitFor();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.ok(
    Math.abs((await summary.boundingBox()).y - before.y) < 2,
    'Expanding work must keep its header in place instead of following to the bottom.',
  );
  await summary.press('Tab');
  const workBody = summary
    .locator('..')
    .getByRole('region', { name: 'Work details content', exact: true });
  assert.equal(
    await workBody.evaluate((element) => element === document.activeElement),
    true,
    'Expanded work exposes its reading viewport before its nested controls.',
  );
  const workKeyboardPose = await page.evaluate(() => [
    document.querySelector('.chat-scroll').scrollTop,
    scrollY,
    document.querySelector('#editor').scrollTop,
  ]);
  await workBody.press('ArrowDown');
  await waitForAsync(page, () => document.querySelector('.agent-process-body').scrollTop > 0);
  await workBody.press('Home');
  await waitForAsync(page, () => document.querySelector('.agent-process-body').scrollTop === 0);
  await page.keyboard.press('Tab');
  const workNote = summary
    .locator('..')
    .getByRole('region', { name: 'Work note', exact: true })
    .first();
  assert.equal(
    await workNote.evaluate((element) => element === document.activeElement),
    true,
    'Long notes remain keyboard reachable even when their Markdown contains a link.',
  );
  await workNote.press('ArrowDown');
  await waitForAsync(page, () => document.querySelector('.agent-process-text').scrollTop > 0);
  await workNote.press('End');
  await waitForAsync(page, () => {
    const note = document.querySelector('.agent-process-text');
    return note.scrollHeight - note.scrollTop - note.clientHeight < 2;
  });
  await workNote.press('PageDown');
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.deepEqual(
    await page.evaluate(() => [
      document.querySelector('.chat-scroll').scrollTop,
      scrollY,
      document.querySelector('#editor').scrollTop,
    ]),
    workKeyboardPose,
    'Keyboard reading and a note boundary cannot move the conversation, editor or page.',
  );
  const noteReadingTop = await workNote.evaluate((element) => element.scrollTop);
  const readingTop = await chat.evaluate((element) => element.scrollTop);
  await emit(1, { type: 'text', text: 'New streamed analysis.\n\n'.repeat(40) });
  await page
    .locator('.message.assistant')
    .last()
    .getByText('New streamed analysis.', { exact: true })
    .first()
    .waitFor();
  assert.equal(await chat.evaluate((element) => element.scrollTop), readingTop);
  assert.equal(await workNote.evaluate((element) => element.scrollTop), noteReadingTop);
  assert.equal(await workNote.evaluate((element) => element === document.activeElement), true);
  await mkdir('test-results/agent-reading', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page
      .locator('main')
      .screenshot({ path: `test-results/agent-reading/work-note-keyboard-${theme}.png` });
  }
  await page.evaluate(() => delete document.documentElement.dataset.theme);
  const pausedReturnBounds = await button('Latest messages').boundingBox();
  await input.evaluate((element) => element.focus({ preventScroll: true }));
  await input.dispatchEvent('compositionstart');
  assert.equal(
    await button('Latest messages').evaluate((element) =>
      element.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerType: 'touch',
          bubbles: true,
          cancelable: true,
        }),
      ),
    ),
    false,
  );
  await chat.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });
  assert.equal(
    await button('Latest messages').count(),
    1,
    'A claimed composition gesture cannot release a manual reading pause.',
  );
  const pausedBottomBounds = await button('Latest messages').boundingBox();
  assert.ok(
    Math.abs(pausedBottomBounds.y - pausedReturnBounds.y) < 1,
    'Latest stays fixed even at the end of a manually paused transcript.',
  );
  await input.dispatchEvent('compositionend');
  await chat.evaluate((element, top) => {
    element.scrollTop = top;
    element.dispatchEvent(new Event('scroll'));
  }, readingTop);
  // The floating return control belongs to the native transcript wheel path.
  await page.evaluate(() => {
    document.documentElement.style.overflow = 'auto';
    document.body.style.minHeight = '1500px';
    window.scrollTo(0, 40);
    document.querySelector('#editor').scrollTop = 85;
    window.overlayWheelFocus = document.activeElement;
  });
  const overlayPose = await page.evaluate(() => [
    scrollY,
    document.querySelector('#editor').scrollTop,
  ]);
  const returnControl = button('Latest messages');
  const floatingBounds = await returnControl.boundingBox();
  const beforeOverlayWheel = await chat.evaluate((element) => element.scrollTop);
  await returnControl.hover();
  await page.mouse.wheel(0, 180);
  await waitForAsync(
    page,
    ({ before, outer }) =>
      document.querySelector('.chat-scroll').scrollTop !== before || scrollY !== outer,
    { before: beforeOverlayWheel, outer: overlayPose[0] },
    { timeout: 8000 },
  );
  assert.ok(
    await chat.evaluate((element, before) => element.scrollTop > before, beforeOverlayWheel),
    'Wheeling over Latest scrolls the conversation.',
  );
  assert.deepEqual(
    await page.evaluate(() => [scrollY, document.querySelector('#editor').scrollTop]),
    overlayPose,
  );
  assert.equal(
    await page.evaluate(() => document.activeElement === window.overlayWheelFocus),
    true,
  );
  const afterFloatingWheel = await returnControl.boundingBox();
  assert.ok(
    Math.abs(afterFloatingWheel.y - floatingBounds.y) < 1,
    'The return control stays fixed within the conversation viewport.',
  );
  const settleWheel = async (delta) => {
    await page.evaluate(() => {
      window.overlayWheelSettled = false;
      document.querySelector('.chat-scroll').addEventListener(
        'wheel',
        () => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              window.overlayWheelSettled = true;
            }),
          );
        },
        { once: true, passive: true },
      );
    });
    await page.mouse.wheel(0, delta);
    await waitForAsync(page, () => window.overlayWheelSettled === true);
  };
  const downTop = await chat.evaluate((element) => element.scrollTop);
  await settleWheel(-90);
  assert.ok(
    await chat.evaluate((element, before) => element.scrollTop < before, downTop),
    'The floating control retains the native wheel direction.',
  );
  await chat.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  await returnControl.hover();
  await settleWheel(-180);
  assert.equal(await chat.evaluate((element) => element.scrollTop), 0);
  assert.deepEqual(
    await page.evaluate(() => [scrollY, document.querySelector('#editor').scrollTop]),
    overlayPose,
    'The beginning of the conversation contains overscroll.',
  );
  await page.getByRole('textbox', { name: 'Editor draft', exact: true }).evaluate((element) => {
    element.focus({ preventScroll: true });
    element.setSelectionRange(2, 7);
  });
  const overlayScrollSize = await chat.evaluate((element) => [
    element.clientHeight,
    element.scrollHeight,
  ]);
  await returnControl.hover();
  await settleWheel(10000);
  await atBottom();
  await returnControl.waitFor({ state: 'hidden' });
  assert.deepEqual(
    await chat.evaluate((element) => [element.clientHeight, element.scrollHeight]),
    overlayScrollSize,
    'Showing or removing Latest cannot change the reading viewport or scroll range.',
  );
  await settleWheel(180);
  assert.deepEqual(
    await page.evaluate(() => [scrollY, document.querySelector('#editor').scrollTop]),
    overlayPose,
    'The remainder of a wheel gesture stays in the conversation after Latest disappears.',
  );
  assert.equal(
    await page
      .getByRole('textbox', { name: 'Editor draft', exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  assert.deepEqual(
    await page
      .getByRole('textbox', { name: 'Editor draft', exact: true })
      .evaluate((element) => [element.selectionStart, element.selectionEnd]),
    [2, 7],
  );
  await emit(1, { type: 'text-delta', delta: '\n\nWheel following checkpoint.' });
  await page.getByText('Wheel following checkpoint.', { exact: true }).waitFor();
  await atBottom();
  assert.equal(
    await page
      .getByRole('textbox', { name: 'Editor draft', exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
    'Following a resumed stream cannot take the editor focus.',
  );
  assert.deepEqual(
    await page.evaluate(() => [scrollY, document.querySelector('#editor').scrollTop]),
    overlayPose,
  );
  await chat.evaluate((element, top) => {
    element.scrollTop = top;
    element.dispatchEvent(new Event('scroll'));
  }, beforeOverlayWheel);
  await returnControl.waitFor();
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.documentElement.style.overflow = '';
    document.body.style.minHeight = '';
    delete window.overlayWheelFocus;
    delete window.overlayWheelSettled;
  });
  // Deliberately scrolling the outer conversation back to the bottom also resumes.
  await button('Latest messages').evaluate((element) => element.focus({ preventScroll: true }));
  await page.mouse.move(viewport.x + 2, viewport.y + viewport.height / 2);
  await page.mouse.wheel(0, 10000);
  await atBottom();
  await button('Latest messages').waitFor({ state: 'hidden' });
  assert.equal(
    await input.evaluate((element) => element === document.activeElement),
    true,
    'Scrolling to latest output cannot strand focus on a removed control.',
  );

  const code = 'R1 ' + 'feedback_'.repeat(100) + ' 0 1k\nC1 out 0 10u\n';
  await emit(1, { type: 'text-replace', text: 'Feedback netlist.\n\n```spice\n' + code + '```' });
  const wrap = button('Wrap code');
  await wrap.waitFor();
  await atBottom();
  await wrap.focus();
  await wrap.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.equal(await button('Latest messages').count(), 0);
  await wrap.press('Enter');
  await button('Latest messages').waitFor();
  const wrappedTop = await chat.evaluate((element) => element.scrollTop);
  await emit(1, { type: 'text-delta', delta: '\n\nLater output.\n\n'.repeat(15) });
  await page
    .locator('.message.assistant')
    .last()
    .getByText('Later output.', { exact: true })
    .first()
    .waitFor();
  assert.equal(await chat.evaluate((element) => element.scrollTop), wrappedTop);

  await button('Latest messages').click();
  await atBottom();
  assert.equal(
    await input.evaluate((element) => element === document.activeElement),
    true,
    'Returning to latest output keeps keyboard focus in the composer.',
  );
  await emit(1, {
    type: 'text-replace',
    text: 'Feedback netlist for keyboard reading.\n\n```spice\n' + code + '```',
  });
  await page.getByText('Feedback netlist for keyboard reading.', { exact: true }).waitFor();
  await atBottom();
  if ((await wrap.getAttribute('aria-pressed')) === 'true') {
    await wrap.click();
    await button('Latest messages').click();
    await atBottom();
  }
  const codeArea = page.getByLabel('spice code', { exact: true });
  await codeArea.focus();
  await codeArea.press('ArrowRight');
  await button('Latest messages').waitFor();
  await waitForAsync(page, () => document.querySelector('.agent-code-block pre').scrollLeft > 0);
  const codeTop = await chat.evaluate((element) => element.scrollTop);
  await emit(1, { type: 'text-delta', delta: '\n\nMore analysis.\n\n'.repeat(15) });
  await page
    .locator('.message.assistant')
    .last()
    .getByText('More analysis.', { exact: true })
    .first()
    .waitFor();
  assert.equal(await chat.evaluate((element) => element.scrollTop), codeTop);
  await button('Copy code').focus();
  await button('Copy code').press('Space');
  assert.equal(
    await button('Latest messages').count(),
    1,
    'Keyboard copying cannot release an existing reading pause.',
  );

  await button('Latest messages').click();
  await atBottom();
  await emit(1, {
    type: 'text-replace',
    text: 'Feedback netlist for copying.\n\n```spice\n' + code + '```',
  });
  await page.getByText('Feedback netlist for copying.', { exact: true }).waitFor();
  await atBottom();
  await codeArea.evaluate((element) => {
    element.scrollLeft = 0;
  });
  const codeBounds = await codeArea.boundingBox();
  await page.mouse.move(codeBounds.x + codeBounds.width / 2, codeBounds.y + codeBounds.height / 2);
  await page.mouse.wheel(80, 0);
  await button('Latest messages').waitFor();
  await waitForAsync(page, () => document.querySelector('.agent-code-block pre').scrollLeft > 0);
  await button('Latest messages').click();
  await atBottom();
  await button('Copy code').click();
  assert.equal(await page.evaluate(() => window.copies.at(-1)), code);
  assert.equal(
    await button('Latest messages').count(),
    0,
    'Copying alone does not pause following.',
  );
  await emit(1, { type: 'text-delta', delta: '\n\nFollowing continues.\n\n'.repeat(10) });
  await page
    .locator('.message.assistant')
    .last()
    .getByText('Following continues.', { exact: true })
    .first()
    .waitFor();
  await atBottom();
  const citationText =
    'Controller bandwidth.[^scope] Repeated citation.[^scope]\n\n' +
    'Review measured conditions.\n\n'.repeat(24) +
    '[^scope]: At 20 kHz, bandwidth is limited to 10 MHz.\n';
  await emit(1, { type: 'text-replace', text: citationText });
  const citedReply = page.locator('.message.assistant').last();
  const references = citedReply.locator('[data-footnote-ref]');
  const note = citedReply.locator('.footnotes li');
  await note.waitFor();
  const ids = await page
    .locator('.agent-markdown [id]')
    .evaluateAll((elements) => elements.map((element) => element.id));
  assert.equal(
    new Set(ids).size,
    ids.length,
    'Different replies never share citation identifiers.',
  );
  await atBottom();
  await page.evaluate(() => {
    document.body.style.minHeight = '1400px';
    window.scrollTo(0, 80);
    document.querySelector('#editor').scrollTop = 80;
  });
  const outerPose = await page.evaluate(() => [
    scrollY,
    document.querySelector('#editor').scrollTop,
  ]);
  await references.first().evaluate((element) => element.focus({ preventScroll: true }));
  assert.equal(
    await references.first().evaluate((element) =>
      element.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          keyCode: 229,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    ),
    false,
    'IME confirmation cannot activate a citation.',
  );
  await references.first().press('Enter');
  await button('Latest messages').waitFor();
  assert.equal(await note.evaluate((element) => element === document.activeElement), true);
  const backReferences = note.locator('[data-footnote-backref]');
  assert.equal(await backReferences.count(), 2);
  await backReferences.nth(1).press('Enter');
  assert.equal(
    await references.nth(1).evaluate((element) => element === document.activeElement),
    true,
  );
  assert.deepEqual(
    await page.evaluate(() => [scrollY, document.querySelector('#editor').scrollTop]),
    outerPose,
    'Citation navigation scrolls only its conversation.',
  );
  assert.equal(await page.evaluate(() => location.hash), '');
  const citedTop = await chat.evaluate((element) => element.scrollTop);
  await emit(1, {
    type: 'text-replace',
    text: citationText + '\nAdditional verified measurement.\n',
  });
  await citedReply.getByText('Additional verified measurement.', { exact: true }).waitFor();
  assert.equal(await chat.evaluate((element) => element.scrollTop), citedTop);
  assert.equal(
    await references.nth(1).evaluate((element) => element === document.activeElement),
    true,
  );
  await mkdir('test-results/agent-reading', { recursive: true });
  await page
    .locator('main')
    .screenshot({ path: 'test-results/agent-reading/citation-keyboard.png' });
  const referenceId = await references.nth(1).getAttribute('id');
  await page.getByRole('textbox', { name: 'Editor draft', exact: true }).focus();
  await page.evaluate(() => window.setChatVisible(false));
  await page.locator('main').waitFor({ state: 'hidden' });
  await emit(1, { type: 'text-replace', text: citationText.replace('10 MHz', '12 MHz') });
  await emit(1, { type: 'status', text: 'Hidden citation checkpoint.' });
  await page
    .locator('.chat-progress')
    .getByText('Hidden citation checkpoint.', { exact: true })
    .waitFor({ state: 'attached' });
  await page.evaluate(() => window.setChatVisible(true));
  await note.getByText('At 20 kHz, bandwidth is limited to 12 MHz.', { exact: false }).waitFor();
  assert.equal(await references.nth(1).getAttribute('id'), referenceId);
  assert.equal(
    await page
      .getByRole('textbox', { name: 'Editor draft', exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.body.style.minHeight = '';
  });
  await button('Latest messages').click();
  await atBottom();
  await page.locator('main').evaluate((element) => {
    element.style.width = '328px';
    element.style.setProperty('--chat-width', '328px');
  });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.setProperty('--font-step', '4px');
    }, theme);
    await references.first().evaluate((element) => element.focus({ preventScroll: true }));
    await references.first().press('Enter');
    assert.equal(
      await chat.evaluate((element) => element.scrollWidth <= element.clientWidth),
      true,
    );
    assert.ok((await page.locator('.chat-panel').boundingBox()).width <= 328);
    await page
      .locator('main')
      .screenshot({ path: `test-results/agent-reading/citation-${theme}-328.png` });
  }
  await page.evaluate(() => {
    delete document.documentElement.dataset.theme;
    document.documentElement.style.removeProperty('--font-step');
    document.querySelector('main').style.width = '';
    document.querySelector('main').style.removeProperty('--chat-width');
  });
  await button('Latest messages').click();
  await atBottom();
  await emit(1, {
    type: 'question-request',
    runId: 'reading-run',
    sessionId: 'reading',
    requestId: 'timing',
    token: 'question-token',
    questions: [
      {
        id: 'duration',
        header: 'Timing',
        question: 'What duration should be used?',
        options: [],
        multiSelect: false,
      },
    ],
  });
  const answer = page.getByRole('textbox', { name: 'Your answer: Timing', exact: true });
  await answer.waitFor();
  const questionNav = page.getByRole('group', { name: 'Pending questions', exact: true });
  const viewQuestion = questionNav.getByRole('button', {
    name: 'Go to pending questions',
    exact: true,
  });
  await questionNav.getByText('1 question pending', { exact: true }).waitFor();
  await chat.evaluate((element) => {
    element.scrollTop = 0;
  });
  const questionNavPose = await page.evaluate(() => [
    scrollY,
    document.querySelector('#editor').scrollTop,
  ]);
  await viewQuestion.press('Enter');
  assert.ok(
    await answer.evaluate((field) => {
      const legend = field.closest('fieldset').querySelector('legend');
      const bounds = legend.getBoundingClientRect();
      const viewport = field.closest('.chat-scroll').getBoundingClientRect();
      return (
        document.activeElement === legend &&
        bounds.top >= viewport.top - 1 &&
        bounds.bottom <= viewport.bottom + 1
      );
    }),
  );
  assert.deepEqual(
    await page.evaluate(() => [scrollY, document.querySelector('#editor').scrollTop]),
    questionNavPose,
  );
  assert.deepEqual(await page.evaluate(() => window.answerRequests), []);
  await page.keyboard.press('Tab');
  assert.ok(await answer.evaluate((field) => document.activeElement === field));
  await page.locator('main').evaluate((element) => {
    element.style.width = '328px';
    element.style.setProperty('--chat-width', '328px');
  });
  await questionNav.screenshot({ path: 'test-results/agent-reading/question-navigation-328.png' });
  await page.locator('main').evaluate((element) => {
    element.style.width = '';
    element.style.removeProperty('--chat-width');
  });
  await button('Latest messages').click();
  await atBottom();
  await answer.click();
  await button('Latest messages').waitFor();
  await answer.fill('20');
  await answer.press('Space');
  assert.equal(await answer.inputValue(), '20 ');
  assert.equal(
    await button('Latest messages').count(),
    1,
    'Typing in a question field cannot be mistaken for outer conversation scrolling.',
  );
  const longAnswer = 'Use this explicit timing requirement.\n'.repeat(80);
  await answer.fill(longAnswer);
  await viewQuestion.click();
  assert.ok(await button('Continue').evaluate((control) => document.activeElement === control));
  assert.deepEqual(await page.evaluate(() => window.answerRequests), []);
  await button('Continue').scrollIntoViewIfNeeded();
  await answer.evaluate((element) => {
    element.focus({ preventScroll: true });
    element.setSelectionRange(4, 12);
    element.scrollTop = 80;
  });
  const composingAnswerPose = await page.evaluate(() => [
    document.querySelector('.chat-scroll').scrollTop,
    document.querySelector('#editor').scrollTop,
    document.querySelector('.agent-questions textarea').scrollTop,
    scrollY,
  ]);
  await answer.dispatchEvent('compositionstart');
  await answer.dispatchEvent('keydown', { key: 'f', ctrlKey: true });
  assert.equal(await searchBar.count(), 0);
  await viewQuestion.click();
  await button('Continue').click();
  assert.deepEqual(await page.evaluate(() => window.answerRequests), []);
  assert.deepEqual(
    await answer.evaluate((element) => [
      element === document.activeElement,
      element.value,
      element.selectionStart,
      element.selectionEnd,
    ]),
    [true, longAnswer, 4, 12],
    'Blocked question delivery keeps the actual Chat answer focus, text and selection intact.',
  );
  await emit(1, { type: 'text-delta', delta: '\nBackground work while the answer composes.' });
  await page.getByText('Background work while the answer composes.', { exact: true }).waitFor();
  assert.deepEqual(
    await page.evaluate(() => [
      document.querySelector('.chat-scroll').scrollTop,
      document.querySelector('#editor').scrollTop,
      document.querySelector('.agent-questions textarea').scrollTop,
      scrollY,
    ]),
    composingAnswerPose,
  );
  assert.deepEqual(await page.evaluate(() => window.answerRequests), []);
  await answer.dispatchEvent('compositionend');
  await answer.press('Control+Enter');
  const receipt = page.getByLabel('Answers sent', { exact: true });
  await receipt.waitFor();
  await questionNav.waitFor({ state: 'detached' });
  assert.deepEqual(await page.evaluate(() => window.answerRequests), [
    {
      body: {
        runId: 'reading-run',
        sessionId: 'reading',
        requestId: 'timing',
        token: 'question-token',
        answers: { duration: [longAnswer.trim()] },
      },
      token: 'fixture',
    },
  ]);
  await receipt.locator('summary').click();
  await button('Latest messages').click();
  await atBottom();
  const submittedAnswers = receipt.getByRole('region', { name: 'Submitted answers', exact: true });
  await submittedAnswers.focus();
  await submittedAnswers.press('ArrowDown');
  await button('Latest messages').waitFor();
  await waitForAsync(page, () => document.querySelector('.agent-question-answers').scrollTop > 0);
  await button('Latest messages').click();
  await atBottom();
  await page.getByRole('textbox', { name: 'Editor draft', exact: true }).focus();
  await page.locator('#editor').evaluate((element) => {
    element.scrollTop = 80;
  });
  await emit(1, {
    type: 'process',
    id: 'derivation',
    text:
      'Derivation source.[^scope]\n\n' +
      'Measured derivation notes.\n\n'.repeat(24) +
      '\n[^scope]: Derivation bandwidth evidence.',
  });
  await emit(1, { type: 'done', outcome: 'completed' });
  await page.evaluate(() => window.runs[1].close());
  await button('Send message').waitFor();
  await atBottom();
  assert.equal(
    await button('Latest messages').count(),
    0,
    'Completion never creates a manual reading pause.',
  );
  assert.equal(await page.locator('#editor').evaluate((element) => element.scrollTop), 80);
  assert.equal(
    await page
      .getByRole('textbox', { name: 'Editor draft', exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );

  // Completed work nests a bounded Markdown reader inside the work viewport.
  await citedReply.locator('.agent-process > summary').press('Enter');
  const derivation = citedReply.locator('.agent-process-text').last();
  const derivationReference = derivation.locator('[data-footnote-ref]');
  const derivationNote = derivation.locator('.footnotes li');
  await derivationReference.waitFor();
  await derivationReference.evaluate((element) => element.focus({ preventScroll: true }));
  await derivationReference.press('Enter');
  assert.equal(
    await derivationNote.evaluate((element) => element === document.activeElement),
    true,
  );
  assert.equal(
    await derivationNote.evaluate((element) => {
      const target = element.getBoundingClientRect();
      return ['.agent-process-text', '.agent-process-body', '.chat-scroll'].every((selector) => {
        const viewport = element.closest(selector).getBoundingClientRect();
        return target.top >= viewport.top - 1 && target.bottom <= viewport.bottom + 1;
      });
    }),
    true,
    'A citation is revealed through every nested reading viewport.',
  );
  await derivationNote.locator('[data-footnote-backref]').press('Enter');
  assert.equal(
    await derivationReference.evaluate((element) => element === document.activeElement),
    true,
  );
  assert.equal(await page.locator('#editor').evaluate((element) => element.scrollTop), 80);
  await citedReply.locator('.agent-process > summary').press('Enter');

  // Pending input takes precedence over background activity without rewriting it.
  await send('Clarify the next measurements.', 3);
  const progress = page.locator('.chat-progress');
  const expectProgress = async (text, spinning) => {
    await waitForAsync(
      page,
      ({ text, spinning }) => {
        const row = document.querySelector('.chat-progress');
        return row?.textContent === text && !!row.querySelector('.spin') === spinning;
      },
      { text, spinning },
    );
  };
  const ask = (requestId, index = 2) =>
    emit(index, {
      type: 'question-request',
      runId: 'clarification-run',
      sessionId: 'reading',
      requestId,
      token: requestId + '-token',
      questions: [
        { id: requestId, header: requestId, question: 'Choose ' + requestId, options: [] },
      ],
    });
  await expectProgress('Waiting for the model…', true);
  await emit(2, { type: 'status', text: 'Checking measurements…' });
  await expectProgress('Checking measurements…', true);
  await ask('Voltage');
  await expectProgress('Waiting for your answer…', false);
  await emit(2, {
    type: 'capability-request',
    tool: 'openpe_query',
    arguments: { name: 'core.state' },
    sessionId: 'reading',
    runId: 'clarification-run',
    requestId: 'measurement-query',
    token: 'query-token',
  });
  await page.getByRole('status', { name: 'Running tool calls', exact: true }).waitFor();
  await expectProgress('Waiting for your answer…', false);
  await emit(2, { type: 'status', text: 'Inspecting measurements…' });
  await emit(2, { type: 'text', text: 'Choose explicit operating conditions.' });
  await expectProgress('Waiting for your answer…', false);
  await ask('Current');
  await page.evaluate(() => {
    window.delayAnswers = true;
  });
  const voltage = page.getByRole('textbox', { name: 'Your answer: Voltage', exact: true });
  const current = page.getByRole('textbox', { name: 'Your answer: Current', exact: true });
  await voltage.fill('400 V');
  await voltage.locator('xpath=ancestor::form').getByRole('button', { name: 'Continue' }).click();
  await waitForAsync(page, () => window.answerResponses.length === 1);
  await expectProgress('Waiting for your answer…', false);
  await current.fill('10 A');
  await current.locator('xpath=ancestor::form').getByRole('button', { name: 'Continue' }).click();
  await waitForAsync(page, () => window.answerResponses.length === 2);
  await expectProgress('Sending answers…', true);
  await page.evaluate(() => window.answerResponses[0]('Delivery failed. Try again.'));
  await page.getByText('Delivery failed. Try again.', { exact: true }).waitFor();
  await expectProgress('Waiting for your answer…', false);
  assert.equal(await voltage.inputValue(), '400 V');
  await voltage.locator('xpath=ancestor::form').getByRole('button', { name: 'Continue' }).click();
  await waitForAsync(page, () => window.answerResponses.length === 3);
  await expectProgress('Sending answers…', true);
  await emit(2, { type: 'status', text: 'Verifying operating conditions…' });
  await page.evaluate(() => {
    window.answerResponses[1]();
    window.answerResponses[2]();
  });
  await expectProgress('Using OpenPE tools…', true);
  await page.evaluate(() => window.releaseToolQuery({ revision: 0 }));
  await expectProgress('Verifying operating conditions…', true);
  assert.equal(await page.getByLabel('Answers sent', { exact: true }).count(), 3);
  await ask('Frequency');
  await expectProgress('Waiting for your answer…', false);
  const frequency = page.getByRole('textbox', { name: 'Your answer: Frequency', exact: true });
  const retainedFrequency = 'Switching frequency evidence: 100 kHz, Ω and µH.\n'.repeat(60);
  await frequency.click();
  await frequency.fill(retainedFrequency);
  await emit(2, { type: 'question-closed', sessionId: 'reading', requestId: 'Frequency' });
  await expectProgress('Verifying operating conditions…', true);
  assert.equal(await frequency.isEditable(), false);
  assert.equal(await frequency.getAttribute('readonly'), '');
  await frequency.evaluate((element) => element.focus({ preventScroll: true }));
  const closedFrequencyPose = await page.evaluate(() => [
    document.querySelector('.chat-scroll').scrollTop,
    document.querySelector('#editor').scrollTop,
    scrollY,
    window.answerRequests.length,
  ]);
  await frequency.press('Home');
  await frequency.press('End');
  await waitForAsync(page, () =>
    [...document.querySelectorAll('.agent-questions textarea')].some(
      (element) => element.readOnly && element.scrollTop > 0,
    ),
  );
  assert.equal(await frequency.evaluate((element) => element === document.activeElement), true);
  await frequency.press('Delete');
  await frequency.locator('xpath=ancestor::form').dispatchEvent('submit');
  assert.equal(await frequency.inputValue(), retainedFrequency);
  assert.deepEqual(
    await page.evaluate(() => [
      document.querySelector('.chat-scroll').scrollTop,
      document.querySelector('#editor').scrollTop,
      scrollY,
      window.answerRequests.length,
    ]),
    closedFrequencyPose,
    'Reading a natively closed answer cannot move outer viewports or send its retained draft.',
  );
  await ask('Temperature');
  await expectProgress('Waiting for your answer…', false);
  await page.getByRole('textbox', { name: 'Your answer: Temperature', exact: true }).fill('60 °C');
  await emit(2, { type: 'done', outcome: 'completed' });
  await page.evaluate(() => window.runs[2].close());
  await button('Send message').waitFor();
  assert.equal(await progress.count(), 0);
  assert.equal(
    await page.getByRole('textbox', { name: 'Your answer: Temperature', exact: true }).isEditable(),
    false,
  );
  assert.equal(
    await page.getByRole('textbox', { name: 'Your answer: Temperature', exact: true }).inputValue(),
    '60 °C',
  );
  await send('Clarify the ambient conditions.', 4);
  await ask('Ambient', 3);
  await expectProgress('Waiting for your answer…', false);
  await page.getByRole('textbox', { name: 'Your answer: Ambient', exact: true }).fill('25 °C');
  await input.focus();
  await input.press('Escape');
  await button('Send message').waitFor();
  assert.equal(await progress.count(), 0);
  assert.equal(
    await page.getByRole('textbox', { name: 'Your answer: Ambient', exact: true }).isEditable(),
    false,
  );
  assert.equal(
    await page.getByRole('textbox', { name: 'Your answer: Ambient', exact: true }).inputValue(),
    '25 °C',
  );
  await send('Verify startup.', 5);
  const failedPrompt = page.locator('.message.user').last();
  const reuse = failedPrompt.getByRole('button', { name: 'Reuse message', exact: true });
  for (const draft of ['Keep this next draft', '   ', 'First line\nSecond line']) {
    await input.fill(draft);
    assert.equal(await reuse.isDisabled(), true);
    await input.press('ArrowUp');
    assert.equal(await input.inputValue(), draft);
  }
  assert.ok(await input.evaluate((element) => element.selectionStart < 'First line\n'.length));
  await input.fill('');
  await input.dispatchEvent('compositionstart');
  await input.press('ArrowUp');
  await reuse.click();
  assert.equal(await input.inputValue(), '', 'Reuse cannot replace an active composition.');
  assert.equal(
    await input.evaluate((element) => element === document.activeElement),
    true,
    'A reuse pointer action keeps an active composition focused.',
  );
  await input.dispatchEvent('compositionend');
  await input.dispatchEvent('keydown', { key: 'ArrowUp', keyCode: 229 });
  assert.equal(await input.inputValue(), '');
  await reuse.focus();
  await reuse.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.equal(await input.inputValue(), '');
  await chat.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  const historyCount = await page.evaluate(() => window.readingFixture.messages.length);
  await input.press('ArrowUp');
  assert.equal(await input.inputValue(), 'Verify startup.');
  assert.equal(await input.evaluate((element) => element === document.activeElement), true);
  assert.equal(await input.evaluate((element) => element.selectionStart), 'Verify startup.'.length);
  assert.equal(await chat.evaluate((element) => element.scrollTop), 0);
  assert.equal(await page.evaluate(() => window.runs.length), 5);
  assert.equal(await page.evaluate(() => window.readingFixture.messages.length), historyCount);
  await input.evaluate((field) => field.setSelectionRange(0, 0));
  await input.press('ArrowUp');
  assert.equal(await input.inputValue(), 'Clarify the ambient conditions.');
  await input.evaluate((field) => field.setSelectionRange(field.value.length, field.value.length));
  await input.press('ArrowDown');
  assert.equal(await input.inputValue(), 'Verify startup.');
  await input.fill('Verify cold startup.');
  await input.press('ArrowDown');
  assert.equal(await input.inputValue(), 'Verify cold startup.');
  assert.equal(await page.evaluate(() => window.runs.length), 5);
  await page.getByRole('textbox', { name: 'Editor draft', exact: true }).focus();
  await emit(4, { type: 'text', text: 'Partial startup analysis.' });
  const startupDiagnostic =
    'Provider disconnected. Your partial response was kept.\n\n' +
    'Detail: ' +
    'diagnostic_reference_'.repeat(60) +
    '\n' +
    'Measured Ω, µH and <script>literal</script>.\n'.repeat(60);
  await emit(4, { type: 'error', text: startupDiagnostic });
  await emit(4, { type: 'done', outcome: 'failed' });
  await page.evaluate(() => window.runs[4].close());
  await button('Send message').waitFor();
  await page.getByText('Partial startup analysis.', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), 'Verify cold startup.');
  assert.equal(
    await page
      .getByRole('textbox', { name: 'Editor draft', exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  assert.equal(
    await chat.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    true,
    'Long literal diagnostics cannot widen the conversation or create an outer horizontal scroller.',
  );
  const failedStartup = page.locator('.message.assistant').last();
  const editFailedPrompt = failedStartup.getByRole('button', {
    name: 'Edit original prompt',
    exact: true,
  });
  assert.ok(await editFailedPrompt.isDisabled());
  const failedHeader = failedStartup.locator('.message-author');
  await failedHeader.getByText('Failed', { exact: true }).waitFor();
  const diagnostic = failedStartup.getByRole('region', {
    name: 'Response diagnostic',
    exact: true,
  });
  assert.equal(await diagnostic.textContent(), startupDiagnostic);
  assert.equal(await diagnostic.locator('script, img').count(), 0);
  assert.equal(
    await diagnostic.evaluate(
      (element) => element.clientHeight <= 240 && element.scrollHeight > element.clientHeight,
    ),
    true,
  );
  await failedStartup.scrollIntoViewIfNeeded();
  await diagnostic.evaluate((element) => element.focus({ preventScroll: true }));
  const diagnosticPose = await page.evaluate(() => [
    document.querySelector('.chat-scroll').scrollTop,
    document.querySelector('#editor').scrollTop,
    scrollY,
  ]);
  await diagnostic.press('End');
  await waitForAsync(page, () => {
    const element = document.querySelector(
      '.message.assistant:last-of-type .agent-diagnostic-text',
    );
    return element.scrollHeight - element.scrollTop - element.clientHeight < 2;
  });
  await diagnostic.press('PageDown');
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.deepEqual(
    await page.evaluate(() => [
      document.querySelector('.chat-scroll').scrollTop,
      document.querySelector('#editor').scrollTop,
      scrollY,
    ]),
    diagnosticPose,
  );
  const copyDiagnostic = failedStartup.getByRole('button', {
    name: 'Copy response diagnostic',
    exact: true,
  });
  const copiesBeforeDiagnostic = await page.evaluate(() => window.copies.length);
  await copyDiagnostic.focus();
  await copyDiagnostic.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.equal(await page.evaluate(() => window.copies.length), copiesBeforeDiagnostic);
  await copyDiagnostic.press('Enter');
  assert.equal(await page.evaluate(() => window.copies.at(-1)), startupDiagnostic);
  await failedStartup.getByRole('button', { name: 'Copy response', exact: true }).press('Enter');
  assert.equal(await page.evaluate(() => window.copies.at(-1)), 'Partial startup analysis.');
  assert.equal(await page.evaluate(() => window.runs.length), 5);
  await diagnostic.evaluate((element) => {
    element.scrollTop = 0;
  });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.setProperty('--font-step', '4px');
      document.querySelector('main').style.width = '328px';
      document.querySelector('main').style.setProperty('--chat-width', '328px');
    }, theme);
    assert.ok((await failedStartup.boundingBox()).width <= 328);
    const failedBadge = await failedHeader.getByText('Failed', { exact: true }).boundingBox();
    const elapsed = await failedHeader.getByLabel('Elapsed time', { exact: true }).boundingBox();
    assert.ok(failedBadge.x + failedBadge.width < elapsed.x);
    await chat.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const recoveryBounds = await editFailedPrompt.boundingBox();
    const latestBounds = await button('Latest messages').boundingBox();
    assert.ok(
      recoveryBounds && latestBounds && recoveryBounds.y + recoveryBounds.height < latestBounds.y,
    );
    assert.equal(
      await chat.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      true,
    );
    await failedStartup.screenshot({
      path: `test-results/agent-reading/diagnostic-${theme}-328.png`,
    });
  }
  await page.evaluate(() => {
    delete document.documentElement.dataset.theme;
    document.documentElement.style.removeProperty('--font-step');
    document.querySelector('main').style.width = '';
    document.querySelector('main').style.removeProperty('--chat-width');
  });
  await input.fill('');
  await input.dispatchEvent('compositionstart');
  await editFailedPrompt.click();
  assert.equal(await input.inputValue(), '');
  assert.ok(await input.evaluate((field) => document.activeElement === field));
  await input.dispatchEvent('compositionend');
  await editFailedPrompt.dispatchEvent('keydown', { key: 'Enter', keyCode: 229 });
  assert.equal(await input.inputValue(), '');
  await editFailedPrompt.press('Enter');
  assert.equal(await input.inputValue(), 'Verify startup.');
  assert.ok(await input.evaluate((field) => document.activeElement === field));
  assert.equal(await page.evaluate(() => window.runs.length), 5);
  assert.equal(await page.evaluate(() => window.readingFixture.messages.length), historyCount);
  await input.fill('');
  const annotatedPrompt = page.locator('[data-message-id="reusable-source"]');
  const restoreAnnotated = annotatedPrompt.getByRole('button', {
    name: 'Reuse message',
    exact: true,
    includeHidden: true,
  });
  await page.locator('#editor').evaluate((element) => {
    element.scrollTop = 80;
  });
  await restoreAnnotated.evaluate((element) => element.focus({ preventScroll: true }));
  const readingPose = await chat.evaluate((element) => element.scrollTop);
  await restoreAnnotated.press('Enter');
  const original = await page.evaluate(() => window.readingFixture.messages[0]);
  assert.equal(await input.inputValue(), original.text);
  assert.deepEqual(
    await page.evaluate(() => window.readingFixture.annotations),
    original.annotations,
  );
  assert.equal(
    await page.evaluate(
      () =>
        window.readingFixture.annotations[0] !== window.readingFixture.messages[0].annotations[0] &&
        window.readingFixture.annotations[0].elements !==
          window.readingFixture.messages[0].annotations[0].elements,
    ),
    true,
  );
  assert.equal(await input.evaluate((element) => element.selectionStart), original.text.length);
  assert.ok(
    await input.evaluate((element) => element.scrollTop > 0),
    'A long reused draft shows its editable tail.',
  );
  assert.equal(await chat.evaluate((element) => element.scrollTop), readingPose);
  assert.equal(await page.locator('#editor').evaluate((element) => element.scrollTop), 80);
  await pendingAnnotations.getByText('Earlier capture', { exact: true }).waitFor();
  await input.fill('');
  assert.equal(
    await reuse.isDisabled(),
    true,
    'Pending attachments also protect the current draft.',
  );
  await pendingAnnotations
    .getByRole('button', { name: 'Remove annotation 1', exact: true })
    .click();
  assert.equal(
    await input.evaluate((element) => element === document.activeElement),
    true,
    'Removing the final pending annotation returns to the surviving composer.',
  );
  assert.deepEqual(await page.evaluate(() => window.readingFixture.messages[0]), original);
  assert.equal(await reuse.isEnabled(), true);
  const annotationOnly = page.locator('[data-message-id="annotation-only"]');
  assert.equal(
    await annotationOnly.getByRole('button', { name: 'Copy message', exact: true }).count(),
    0,
  );
  await annotationOnly.getByRole('button', { name: 'Reuse message', exact: true }).click();
  assert.equal(await input.inputValue(), '');
  assert.equal(await input.evaluate((element) => element === document.activeElement), true);
  assert.deepEqual(
    await page.evaluate(() => window.readingFixture.annotations),
    await page.evaluate(() => window.readingFixture.messages[1].annotations),
  );
  await pendingAnnotations
    .getByRole('button', { name: 'Remove annotation 1', exact: true })
    .click();
  await page.getByRole('textbox', { name: 'Editor draft', exact: true }).focus();
  await page.evaluate(() => window.setChatVisible(false));
  await page.locator('main').waitFor({ state: 'hidden' });
  await restoreAnnotated.evaluate((element) => element.click());
  assert.equal(
    await page
      .getByRole('textbox', { name: 'Message your agent', exact: true, includeHidden: true })
      .inputValue(),
    '',
  );
  assert.deepEqual(await page.evaluate(() => window.readingFixture.annotations), []);
  await page.evaluate(() => window.setChatVisible(true));
  await page.locator('main').waitFor();
  assert.equal(
    await page
      .getByRole('textbox', { name: 'Editor draft', exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
  );
  assert.equal(
    await page.evaluate(() => window.runs.length),
    5,
    'Reusing or editing a draft never runs a provider.',
  );
  await page.locator('main').evaluate((element) => {
    element.style.width = '328px';
    element.style.setProperty('--chat-width', '328px');
  });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await annotatedPrompt.hover();
    await annotatedPrompt.screenshot({ path: `test-results/agent-reading/reuse-${theme}-328.png` });
  }
  await page.evaluate(() =>
    window.setReadingMessages([
      { id: 'collapse-user', role: 'user', text: 'Complete operating requirement.\n'.repeat(100) },
      { id: 'collapse-reply', role: 'assistant', text: 'Later discussion.\n\n'.repeat(80) },
    ]),
  );
  const collapseMessage = page.locator('[data-message-id="collapse-user"]');
  const expandMessage = collapseMessage.getByRole('button', {
    name: 'Show more of this message',
    exact: true,
  });
  await expandMessage.waitFor();
  await chat.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  await expandMessage.click();
  const collapseMessageButton = collapseMessage.getByRole('button', {
    name: 'Show less of this message',
    exact: true,
  });
  const focusCollapseButton = () =>
    collapseMessageButton.evaluate((element) => {
      const area = element.closest('.chat-scroll');
      area.scrollTop +=
        element.getBoundingClientRect().top -
        area.getBoundingClientRect().top -
        area.clientHeight / 2;
      area.dispatchEvent(new Event('scroll'));
      element.focus({ preventScroll: true });
    });
  const collapsedToggleInView = () =>
    expandMessage.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const area = element.closest('.chat-scroll').getBoundingClientRect();
      return bounds.top >= area.top && bounds.bottom <= area.bottom;
    });
  await focusCollapseButton();
  const collapseOuterPose = await page.evaluate(() => [
    scrollY,
    document.querySelector('#editor').scrollTop,
  ]);
  await collapseMessageButton.press('Enter');
  assert.equal(
    await collapsedToggleInView(),
    true,
    'Collapsing an older long message cannot leave its focused toggle outside the conversation.',
  );
  assert.equal(await expandMessage.evaluate((element) => element === document.activeElement), true);
  assert.equal(await button('Latest messages').count(), 1);
  assert.deepEqual(
    await page.evaluate(() => [scrollY, document.querySelector('#editor').scrollTop]),
    collapseOuterPose,
  );
  await page.setViewportSize({ width: 1100, height: 400 });
  await page.locator('main').evaluate((element) => {
    element.style.height = '336px';
    document.documentElement.style.setProperty('--font-step', '4px');
  });
  await expandMessage.click();
  await focusCollapseButton();
  const shortCollapseTop = await chat.evaluate((element) => element.scrollTop);
  await collapseMessageButton.dispatchEvent('keydown', {
    key: 'Enter',
    keyCode: 229,
    isComposing: true,
  });
  assert.equal(await collapseMessageButton.count(), 1);
  assert.equal(await chat.evaluate((element) => element.scrollTop), shortCollapseTop);
  await collapseMessageButton.click();
  assert.equal(await collapsedToggleInView(), true);
  assert.equal(await expandMessage.evaluate((element) => element === document.activeElement), true);
  assert.equal(
    await collapseMessage
      .locator('.agent-user-message')
      .evaluate(
        (element) =>
          element.getBoundingClientRect().height > element.closest('.chat-scroll').clientHeight,
      ),
    true,
    'The short-window case reveals the toggle when the complete summary cannot fit.',
  );
  await page
    .locator('main')
    .screenshot({ path: 'test-results/agent-reading/collapse-short-dark-328.png' });
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.locator('main').evaluate((element) => {
    element.style.height = '760px';
    document.documentElement.style.removeProperty('--font-step');
  });
  await expandMessage.click();
  await focusCollapseButton();
  const backgroundCollapseTop = await chat.evaluate((element) => element.scrollTop);
  await page
    .getByRole('textbox', { name: 'Editor draft', exact: true })
    .evaluate((element) => element.focus({ preventScroll: true }));
  await collapseMessageButton.evaluate((element) => element.click());
  assert.equal(await chat.evaluate((element) => element.scrollTop), backgroundCollapseTop);
  assert.equal(
    await page
      .getByRole('textbox', { name: 'Editor draft', exact: true })
      .evaluate((element) => element === document.activeElement),
    true,
    'A collapse without toggle focus cannot reveal over a newer editor focus choice.',
  );
  await expandMessage.click();
  await focusCollapseButton();
  const hiddenCollapseTop = await chat.evaluate((element) => element.scrollTop);
  await collapseMessageButton.evaluate((element) => {
    window.setChatVisible(false);
    element.click();
    const editor = document.querySelector('#editor textarea');
    editor.focus({ preventScroll: true });
    editor.setSelectionRange(3, 8);
  });
  await page.locator('main').waitFor({ state: 'hidden' });
  await page.evaluate(() => window.setChatVisible(true));
  await expandMessage.waitFor();
  assert.equal(await chat.evaluate((element) => element.scrollTop), hiddenCollapseTop);
  assert.deepEqual(
    await page
      .getByRole('textbox', { name: 'Editor draft', exact: true })
      .evaluate((element) => [
        element === document.activeElement,
        element.selectionStart,
        element.selectionEnd,
      ]),
    [true, 3, 8],
    'Hiding cancels the collapse reveal without replaying it or taking editor focus on return.',
  );
  await page.evaluate(() =>
    window.setReadingMessages([
      { id: 'compact-user', role: 'user', text: 'Retained requirement.\n'.repeat(45) },
      { id: 'compact-reply', role: 'assistant', text: 'A short settled answer.' },
    ]),
  );
  await page.getByText('A short settled answer.', { exact: true }).waitFor();
  if (await button('Latest messages').count()) await button('Latest messages').click();
  await button('Show more of this message').click();
  await button('Latest messages').waitFor();
  const expandedGap = await button('Latest messages').evaluate(
    (element) =>
      element.closest('.chat-scroll').getBoundingClientRect().bottom -
      element.getBoundingClientRect().bottom,
  );
  await button('Show less of this message').click();
  await waitForAsync(page, () => {
    const area = document.querySelector('.chat-scroll');
    return area.scrollHeight === area.clientHeight;
  });
  assert.equal(
    await button('Latest messages').count(),
    1,
    'A collapse does not discard the explicit reading pause.',
  );
  const compactGap = await button('Latest messages').evaluate(
    (element) =>
      element.closest('.chat-scroll').getBoundingClientRect().bottom -
      element.getBoundingClientRect().bottom,
  );
  assert.ok(
    Math.abs(compactGap - expandedGap) < 1,
    'The return control remains at the viewport edge when the conversation fits.',
  );
  await page
    .locator('main')
    .screenshot({ path: 'test-results/agent-reading/compact-return-328.png' });
  await page.evaluate(() => {
    document.documentElement.style.overflow = 'auto';
    document.body.style.minHeight = '1500px';
    window.scrollTo(0, 40);
  });
  const compactPose = await page.evaluate(() => [
    scrollY,
    document.querySelector('#editor').scrollTop,
  ]);
  await button('Latest messages').hover();
  await settleWheel(180);
  await button('Latest messages').waitFor({ state: 'hidden' });
  assert.deepEqual(
    await page.evaluate(() => [scrollY, document.querySelector('#editor').scrollTop]),
    compactPose,
    'A fitting conversation consumes its return gesture without scrolling the page.',
  );
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.documentElement.style.overflow = '';
    document.body.style.minHeight = '';
    delete window.overlayWheelSettled;
  });
  await mkdir('test-results/agent-reading', { recursive: true });
  await page.screenshot({ path: 'test-results/agent-reading/success.png' });
  const liveRun = await page.evaluate(() => {
    window.copies = [];
    window.copyAttempts = [];
    return window.runs.length;
  });
  await send('Inspect this live response.', liveRun + 1);
  const liveCopy = button('Copy response so far');
  assert.equal(await liveCopy.count(), 0);
  await emit(liveRun, {
    type: 'text',
    text: 'Converter overview.\n\nAdditional streamed overview.',
  });
  if (await button('Latest messages').count()) await button('Latest messages').click();
  await emit(liveRun, {
    type: 'text-delta',
    delta:
      '\n\nKeep Ω and µH.\n```openpe_session\n{"title":"Private title payload"}\n```\n```openpe\n["Private proposal payload"',
  });
  await page.getByText('Keep Ω and µH.', { exact: true }).waitFor();
  await findConversation.click();
  await search.fill('Keep Ω and µH.');
  await waitForAsync(
    page,
    () => document.querySelector('[data-panel-find] [role=status]')?.textContent === '1/1',
  );
  await search.press('Escape');
  await searchBar.waitFor({ state: 'detached' });
  await input.fill('Draft stays here.');
  await input.evaluate((field) => field.setSelectionRange(1, 6));
  await input.dispatchEvent('compositionstart');
  await liveCopy.click();
  assert.ok(await input.evaluate((field) => document.activeElement === field));
  assert.equal(await page.evaluate(() => window.copyAttempts.length), 0);
  await input.dispatchEvent('compositionend');
  await page.evaluate(() => {
    window.holdResponseCopy = true;
  });
  await liveCopy.press('Enter');
  await liveCopy.locator('..').getByText('Copying…', { exact: true }).waitFor();
  await liveCopy.press('Enter');
  const firstSnapshot = 'Converter overview.\n\nAdditional streamed overview.\n\nKeep Ω and µH.';
  assert.deepEqual(await page.evaluate(() => window.copyAttempts), [firstSnapshot]);
  await emit(liveRun, { type: 'text-delta', delta: ']\n```\n\nLatest visible paragraph.' });
  await page.getByText('Latest visible paragraph.', { exact: true }).waitFor();
  await page.evaluate(() => window.settleResponseCopy(false));
  await liveCopy.locator('..').getByText('Could not copy. Try again.', { exact: true }).waitFor();
  await liveCopy.press('Enter');
  await waitForAsync(page, () => window.copyAttempts.length === 2);
  const secondSnapshot = firstSnapshot + '\n\n\n\nLatest visible paragraph.';
  assert.equal(await page.evaluate(() => window.copyAttempts.at(-1)), secondSnapshot);
  await emit(liveRun, { type: 'text-delta', delta: '\n\nCompleted after copying.' });
  await emit(liveRun, { type: 'done', outcome: 'completed' });
  await page.evaluate((run) => window.runs[run].close(), liveRun);
  await button('Send message').waitFor();
  const settledCopy = button('Copy response').last();
  assert.ok(await settledCopy.evaluate((control) => document.activeElement === control));
  assert.equal(await settledCopy.getAttribute('aria-busy'), 'true');
  await page.evaluate(() => {
    window.holdResponseCopy = false;
    window.settleResponseCopy(true);
  });
  await settledCopy.locator('..').getByText('Copied snapshot', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.copies), [secondSnapshot]);
  assert.deepEqual(
    await input.evaluate((field) => [field.value, field.selectionStart, field.selectionEnd]),
    ['Draft stays here.', 1, 6],
  );
  await atBottom();
  await settledCopy.press('Enter');
  await settledCopy.locator('..').getByText('Copied', { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => window.copies.at(-1)),
    secondSnapshot + '\n\nCompleted after copying.',
  );
  assert.equal(await button('Latest messages').count(), 0);
  const codeForSearch = (term, leftTerm = '') =>
    [
      '```spice',
      ...Array.from({ length: 54 }, (_, row) =>
        row === 37 && leftTerm
          ? 'x'.repeat(20) + leftTerm + 'x'.repeat(100)
          : 'x'.repeat(120) + (row === 35 ? term : ` line ${row}`),
      ),
      '```',
    ].join('\n');
  const tableForSearch = (term, leftTerm = '') =>
    [
      `| ${Array.from({ length: 8 }, (_, column) => `Column ${column}`).join(' | ')} |`,
      `| ${Array(8).fill('---').join(' | ')} |`,
      ...Array.from(
        { length: 45 },
        (_, row) =>
          `| ${Array.from({ length: 8 }, (_, column) => (row === 30 && column === 7 ? term : row === 30 && column === 1 && leftTerm ? leftTerm : `Value ${row}.${column}`)).join(' | ')} |`,
      ),
    ].join('\n');
  await page.evaluate(
    (text) =>
      window.setReadingMessages((messages) => [
        ...messages,
        {
          id: 'reader-search',
          role: 'assistant',
          text,
        },
      ]),
    [
      codeForSearch('unrelated code'),
      codeForSearch('CODE_NEEDLE_Ω', 'CODE_LEFT_Ω'),
      tableForSearch('unrelated cell'),
      tableForSearch('TABLE_NEEDLE_µH', 'TABLE_LEFT_µH'),
    ].join('\n\n'),
  );
  const readerReply = page.locator('[data-message-id="reader-search"]');
  const codeReaders = readerReply.getByLabel('spice code', { exact: true });
  const tableReaders = readerReply.getByRole('region', { name: 'Response table', exact: true });
  await tableReaders.last().waitFor();
  const scrollPosition = (reader) =>
    reader.evaluate((element) => [element.scrollTop, element.scrollLeft]);
  const setUnrelatedPosition = (reader) =>
    reader.evaluate((element) => {
      element.scrollTop = 27;
      element.scrollLeft = 31;
      return [element.scrollTop, element.scrollLeft];
    });
  const otherCode = await setUnrelatedPosition(codeReaders.first());
  const otherTable = await setUnrelatedPosition(tableReaders.first());
  const revealReaderHit = async (reader, term) => {
    await findConversation.click();
    await search.fill(term);
    await waitForAsync(
      page,
      (term) =>
        Array.from(CSS.highlights.get('openpe-panel-find-current') ?? [])[0]?.toString() === term,
      term,
    );
    const placement = await reader.evaluate((element, term) => {
      const range = Array.from(CSS.highlights.get('openpe-panel-find-current') ?? [])[0];
      if (!range || !element.contains(range.startContainer))
        return {
          visible: false,
          match: range?.toString(),
          focus: document.activeElement?.className,
        };
      const hit = range.getBoundingClientRect();
      const reader = element.getBoundingClientRect();
      const viewport = element.closest('.chat-scroll').getBoundingClientRect();
      const header = element.querySelector('thead th')?.getBoundingClientRect();
      const gutter = element
        .querySelector(
          element.hasAttribute('data-freeze-first')
            ? 'thead th:first-child'
            : '.agent-code-line-number',
        )
        ?.getBoundingClientRect();
      const visible =
        !!document.activeElement.closest('[data-panel-find]') &&
        range.toString() === term &&
        element.scrollTop > 0 &&
        element.scrollLeft > 0 &&
        hit.top >= Math.max(reader.top, viewport.top, header?.bottom ?? 0) - 1 &&
        hit.bottom <= Math.min(reader.top + element.clientHeight, viewport.bottom) + 1 &&
        hit.left >= Math.max(reader.left, gutter?.right ?? reader.left) - 1 &&
        hit.right <= reader.left + element.clientWidth + 1;
      return {
        visible,
        hit: hit.toJSON(),
        reader: reader.toJSON(),
        viewport: viewport.toJSON(),
        header: header?.toJSON(),
        gutter: gutter?.toJSON(),
        scroll: [element.scrollTop, element.scrollLeft],
      };
    }, term);
    assert.ok(placement.visible, `${term}: ${JSON.stringify(placement)}`);
    await search.press('Escape');
    await searchBar.waitFor({ state: 'detached' });
  };
  const editorReaderPose = await page.evaluate(() => [
    scrollY,
    document.querySelector('#editor').scrollTop,
  ]);
  await revealReaderHit(codeReaders.last(), 'CODE_NEEDLE_Ω');
  const farCodePose = await scrollPosition(codeReaders.last());
  await revealReaderHit(codeReaders.last(), 'CODE_LEFT_Ω');
  const codeHitPose = await scrollPosition(codeReaders.last());
  assert.ok(codeHitPose[1] < farCodePose[1]);
  assert.deepEqual(await scrollPosition(tableReaders.last()), [0, 0]);
  await readerReply
    .getByRole('button', { name: 'Freeze first column', exact: true })
    .last()
    .click();
  await revealReaderHit(tableReaders.last(), 'TABLE_NEEDLE_µH');
  const rightTablePose = await scrollPosition(tableReaders.last());
  await revealReaderHit(tableReaders.last(), 'TABLE_LEFT_µH');
  assert.ok((await scrollPosition(tableReaders.last()))[1] < rightTablePose[1]);
  assert.deepEqual(await scrollPosition(codeReaders.last()), codeHitPose);
  assert.deepEqual(await scrollPosition(codeReaders.first()), otherCode);
  assert.deepEqual(await scrollPosition(tableReaders.first()), otherTable);
  assert.deepEqual(
    await page.evaluate(() => [scrollY, document.querySelector('#editor').scrollTop]),
    editorReaderPose,
  );
  assert.equal(await input.inputValue(), 'Draft stays here.');
  await page
    .locator('main')
    .screenshot({ path: 'test-results/agent-reading/panel-find-table.png' });
  const lineReader = codeReaders.last();
  const lineBefore = await scrollPosition(lineReader);
  const tableBeforeLineJump = await scrollPosition(tableReaders.last());
  await lineReader.evaluate((element) => element.focus({ preventScroll: true }));
  await page.keyboard.press('Control+g');
  const lineDialog = page.getByRole('dialog', { name: 'Go to line', exact: true });
  const lineField = lineDialog.getByRole('textbox', { name: 'Line number', exact: true });
  await lineField.fill('19');
  await lineField.press('Enter');
  await lineDialog.waitFor({ state: 'detached' });
  const highlightedLine = lineReader.locator('.agent-code-line[data-located]');
  assert.equal(await highlightedLine.locator('[data-line]').getAttribute('data-line'), '19');
  assert.ok(
    await highlightedLine.evaluate((line) => {
      const bounds = line.getBoundingClientRect();
      const reader = line.closest('pre');
      const conversation = reader.closest('.chat-scroll').getBoundingClientRect();
      return (
        document.activeElement === reader &&
        bounds.top >= conversation.top - 1 &&
        bounds.bottom <= conversation.bottom + 1
      );
    }),
  );
  assert.equal((await scrollPosition(lineReader))[1], lineBefore[1]);
  assert.deepEqual(await scrollPosition(tableReaders.last()), tableBeforeLineJump);
  const searchedCodeBlock = readerReply
    .getByRole('group', { name: 'spice block', exact: true })
    .last();
  await searchedCodeBlock.getByRole('button', { name: 'Collapse code', exact: true }).click();
  await findConversation.click();
  await search.fill('CODE_NEEDLE_Ω');
  await waitForAsync(
    page,
    () => document.querySelector('[data-panel-find] [role=status]')?.textContent === '0/0',
  );
  await search.press('Escape');
  await searchBar.waitFor({ state: 'detached' });
  await searchedCodeBlock.getByRole('button', { name: 'Expand code', exact: true }).click();
  assert.deepEqual(
    await page.evaluate(() => [scrollY, document.querySelector('#editor').scrollTop]),
    editorReaderPose,
  );
  await page.evaluate(() =>
    window.setReadingMessages((messages) => [
      ...messages,
      {
        id: 'quote-reply',
        role: 'assistant',
        text: 'Quoted **Ω feedback**.\n\nSecond paragraph, 20 µH.',
      },
    ]),
  );
  const quoteReply = page.locator('[data-message-id="quote-reply"] .agent-answer-part');
  await quoteReply.locator('strong').waitFor();
  const quote = button('Quote selected reply');
  const selectQuote = () =>
    quoteReply.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      return window.getSelection().toString();
    });
  const quoteReadingPosition = await quoteReply.evaluate((element) => {
    const viewport = element.closest('.chat-scroll');
    viewport.scrollTop +=
      element.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 80;
    return viewport.scrollTop;
  });
  const quoteScrollRange = await chat.evaluate((element) => [
    element.scrollHeight,
    element.clientHeight,
  ]);
  const selectedNearReply = await selectQuote();
  const floatingQuote = quote.and(page.locator('[data-floating]'));
  await floatingQuote.waitFor();
  const latestForQuote = button('Latest messages');
  await waitForAsync(
    page,
    () => parseFloat(document.querySelector('.chat-jump-latest')?.style.bottom) > 0,
  );
  assert.ok(
    await latestForQuote.evaluate((control) => {
      const bounds = control.getBoundingClientRect();
      const quote = document
        .querySelector('.chat-quote-selection[data-floating]')
        .getBoundingClientRect();
      const selected = window.getSelection().getRangeAt(0).getBoundingClientRect();
      const viewport = control.closest('.chat-scroll').getBoundingClientRect();
      const overlaps = (rect) =>
        bounds.left < rect.right &&
        bounds.right > rect.left &&
        bounds.top < rect.bottom &&
        bounds.bottom > rect.top;
      return bounds.top >= viewport.top && !overlaps(quote) && !overlaps(selected);
    }),
  );
  assert.deepEqual(
    await chat.evaluate((element) => [element.scrollHeight, element.clientHeight]),
    quoteScrollRange,
  );
  assert.ok(
    await quote.evaluate((control) => {
      const selected = window.getSelection().getRangeAt(0).getBoundingClientRect();
      const viewport = document.querySelector('.chat-scroll').getBoundingClientRect();
      const button = control.getBoundingClientRect();
      return (
        button.left >= viewport.left &&
        button.right <= viewport.right &&
        button.top >= viewport.top &&
        button.bottom <= viewport.bottom &&
        (button.bottom < selected.top || button.top > selected.bottom)
      );
    }),
  );
  await quote.evaluate((control) => control.focus({ preventScroll: true }));
  await chat.evaluate((element) => {
    element.scrollTop = 0;
  });
  await floatingQuote.waitFor({ state: 'detached' });
  assert.ok(await quote.evaluate((control) => document.activeElement === control));
  assert.equal(await page.evaluate(() => window.getSelection().toString()), selectedNearReply);
  await chat.evaluate((element, top) => {
    element.scrollTop = top;
  }, quoteReadingPosition);
  await floatingQuote.waitFor();
  await page
    .locator('main')
    .screenshot({ path: 'test-results/agent-reading/quote-selection-328.png' });
  const quoteWheelPose = await page.evaluate(() => [
    scrollY,
    document.querySelector('#editor').scrollTop,
  ]);
  await latestForQuote.hover();
  await settleWheel(-120);
  assert.ok(
    await chat.evaluate((element, previous) => element.scrollTop < previous, quoteReadingPosition),
  );
  assert.deepEqual(
    await page.evaluate(() => [scrollY, document.querySelector('#editor').scrollTop]),
    quoteWheelPose,
  );
  assert.equal(await page.evaluate(() => window.getSelection().toString()), selectedNearReply);
  await chat.evaluate((element, top) => {
    element.scrollTop = top;
  }, quoteReadingPosition);
  await input.fill('x'.repeat(15990));
  const selected = await selectQuote();
  assert.equal(selected.trim(), 'Quoted Ω feedback.\n\nSecond paragraph, 20 µH.');
  await quote.click();
  await page
    .getByRole('alert')
    .getByText('The selected quote is too long for this draft.')
    .waitFor();
  assert.equal(await input.inputValue(), 'x'.repeat(15990));
  assert.equal(await page.evaluate(() => window.getSelection().toString()), selected);
  await input.fill('Keep this draft.');
  await selectQuote();
  await quote.waitFor();
  await input.dispatchEvent('compositionstart');
  await quote.click();
  assert.equal(await input.inputValue(), 'Keep this draft.');
  assert.ok(await input.evaluate((field) => field === document.activeElement));
  await input.dispatchEvent('compositionend');
  const quotePose = await page.evaluate(() => [
    scrollY,
    document.querySelector('#editor').scrollTop,
    window.runs.length,
    window.copies.length,
  ]);
  await quote.click();
  const expectedQuote = selected
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
  assert.equal(await input.inputValue(), `Keep this draft.\n\n${expectedQuote}\n\n`);
  assert.ok(
    await input.evaluate(
      (field) => field === document.activeElement && field.selectionStart === field.value.length,
    ),
  );
  assert.deepEqual(
    await page.evaluate(() => [
      scrollY,
      document.querySelector('#editor').scrollTop,
      window.runs.length,
      window.copies.length,
    ]),
    quotePose,
  );
  await quote.waitFor({ state: 'detached' });
  await selectQuote();
  await quote.evaluate((control) => control.focus({ preventScroll: true }));
  await page.keyboard.press('Enter');
  assert.equal(
    await input.inputValue(),
    `Keep this draft.\n\n${expectedQuote}\n\n${expectedQuote}\n\n`,
  );
  await quote.waitFor({ state: 'detached' });
  await page.evaluate(() =>
    window.setReadingMessages((messages) => [
      ...messages,
      {
        id: 'full-height-selection',
        role: 'assistant',
        text: 'Selected paragraph across the viewport.\n\n'.repeat(100),
      },
    ]),
  );
  const fullHeightReply = page.locator(
    '[data-message-id="full-height-selection"] .agent-answer-part',
  );
  await fullHeightReply.locator('p').first().waitFor();
  await fullHeightReply.evaluate((element) => {
    const viewport = element.closest('.chat-scroll');
    viewport.scrollTop +=
      element.getBoundingClientRect().top - viewport.getBoundingClientRect().top + 300;
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.locator('.chat-jump-latest[data-selection-occluded]').waitFor({ state: 'attached' });
  await latestForQuote.waitFor({ state: 'hidden' });
  const fullySelectedPose = await chat.evaluate((element) => [
    element.scrollTop,
    element.scrollHeight,
    element.clientHeight,
  ]);
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await latestForQuote.waitFor();
  assert.equal(await latestForQuote.evaluate((control) => control.style.bottom), '');
  assert.deepEqual(
    await chat.evaluate((element) => [
      element.scrollTop,
      element.scrollHeight,
      element.clientHeight,
    ]),
    fullySelectedPose,
  );
  await page.evaluate(() =>
    window.setReadingMessages((messages) => [
      ...messages,
      { id: 'single-heading', role: 'assistant', text: '## Brief answer\n\nOne section.' },
      {
        id: 'outlined-reply',
        role: 'assistant',
        text:
          '## Design overview\n\n```text\n## Code, not a heading\n```\n\n' +
          'Operating conditions.\n\n'.repeat(28) +
          '### Measured ripple Ω\n\n' +
          'Ripple calculation.\n\n'.repeat(28) +
          '## Result\n\n' +
          'Result detail.\n\n'.repeat(30),
      },
    ]),
  );
  const outlinedReply = page.locator('[data-message-id="outlined-reply"]');
  const contents = outlinedReply.getByRole('button', { name: 'Show reply contents', exact: true });
  const outline = page.getByRole('dialog', { name: 'Reply contents', exact: true });
  await contents.waitFor();
  assert.equal(
    await page
      .locator('[data-message-id="single-heading"]')
      .getByRole('button', { name: 'Show reply contents' })
      .count(),
    0,
  );
  await input.evaluate((field) => field.focus({ preventScroll: true }));
  await input.dispatchEvent('compositionstart');
  await contents.click();
  assert.equal(await outline.count(), 0);
  assert.ok(await input.evaluate((field) => document.activeElement === field));
  await input.dispatchEvent('compositionend');
  await contents.press('Enter');
  const outlineEntries = outline
    .getByRole('list', { name: 'Reply headings', exact: true })
    .getByRole('button');
  assert.deepEqual(await outlineEntries.allTextContents(), [
    'Design overview',
    'Measured ripple Ω',
    'Result',
  ]);
  assert.ok(await outlineEntries.first().evaluate((entry) => document.activeElement === entry));
  await page.setViewportSize({ width: 328, height: 560 });
  await outline.screenshot({ path: 'test-results/agent-reading/reply-contents-328.png' });
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.keyboard.press('Escape');
  await outline.waitFor({ state: 'detached' });
  assert.ok(await contents.evaluate((control) => document.activeElement === control));
  const outlinePose = await page.evaluate(() => [
    scrollY,
    document.querySelector('#editor').scrollTop,
  ]);
  await contents.press('Enter');
  await page.keyboard.press('Tab');
  assert.ok(await outlineEntries.nth(1).evaluate((entry) => document.activeElement === entry));
  await page.keyboard.press('Enter');
  await outline.waitFor({ state: 'detached' });
  const rippleHeading = outlinedReply.getByRole('heading', {
    name: 'Measured ripple Ω',
    exact: true,
  });
  assert.ok(
    await rippleHeading.evaluate((heading) => {
      const reader = heading.closest('.chat-scroll').getBoundingClientRect();
      return (
        heading === document.activeElement &&
        Math.abs(heading.getBoundingClientRect().top - reader.top - 8) <= 1
      );
    }),
  );
  assert.deepEqual(
    await page.evaluate(() => [scrollY, document.querySelector('#editor').scrollTop]),
    outlinePose,
  );
  await contents.click();
  await outline.waitFor();
  await page.evaluate(() => window.setChatVisible(false));
  await outline.waitFor({ state: 'detached' });
  await page.evaluate(() => window.setChatVisible(true));
  await contents.waitFor();
  assert.equal(await outline.count(), 0);
  await input.fill('');
  const savedPrompt = 'Cold start\r\nCheck Ω at steady state.';
  await page.evaluate((text) => {
    window.setReadingMessages((messages) => [
      ...messages,
      { id: 'saved-prompt', role: 'user', text },
    ]);
  }, savedPrompt);
  await page.locator('[data-message-id="saved-prompt"]').waitFor();
  await input.press('ArrowUp');
  assert.equal(await input.inputValue(), savedPrompt.replace('\r\n', '\n'));
  await input.press('ArrowDown');
  assert.equal(await input.inputValue(), '');
  assert.equal(await page.evaluate(() => window.readingFixture.messages.at(-1).text), savedPrompt);
  assert.deepEqual(errors, []);
  console.log(
    'Agent reading passed: live response snapshots, inline rendered-pane Find, prompt history, exact reuse, citations, question delivery, reading positions and independent focus.',
  );
} finally {
  await browser.close();
}
