// Actual Chat/AgentComposer components with controlled local SSE and two mounted sessions.
// No Electron, installed provider, external service or solver is launched.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const requests = [];
const toolResults = [];
const server = createServer((req, res) => {
  if (req.url === '/api/chat/tool-result') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      toolResults.push(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    });
    return;
  }
  if (req.url !== '/api/chat') return res.writeHead(404).end();
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const run = { body: JSON.parse(body), res, closed: false };
    requests.push(run);
    res.on('close', () => (run.closed = true));
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.flushHeaders();
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const bundle = await build({
  stdin: {
    contents: `import React, {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import Chat from './components/Chat';
      import {emptyCircuit} from './lib/circuit';
      import {annotationFixture} from './tests/fixtures/annotation';
      const doc = emptyCircuit();
      const ids = ['first-session', 'second-session'];
      const agents = [{id:'codex',available:true,supportsEffort:true}];
      const ignore = () => {};
      const capabilities = {
        query: () => new Promise(resolve => { window.releaseToolQuery = resolve; }),
        execute: () => ({}), observe: () => ({cursor:0,events:[],truncated:false}),
      };
      function Fixture() {
        const [active,setActive] = useState(ids[0]);
        const [panelVisible,setPanelVisible] = useState(true);
        const [sessions,setSessions] = useState(()=>Object.fromEntries(ids.map((id,index)=>[
          id,{messages:[],draft:'',annotations:index===0?[annotationFixture()]:[]}
        ])));
        const [applied,setApplied] = useState(0);
        const update = (id,key,value) => setSessions(previous=>({...previous,
          [id]:{...previous[id],[key]:typeof value === 'function' ? value(previous[id][key]) : value}}));
        window.chatStopFixture = {sessions,applied};
        return <><nav>{ids.map((id,index)=><button key={id} onClick={()=>setActive(id)}>
          Show session {index+1}</button>)}<button onClick={()=>setPanelVisible(value=>!value)}>Toggle conversation panel</button></nav><main style={{display:panelVisible?'block':'none'}}>{ids.map(id=><Chat key={id}
          doc={doc} agents={agents} provider="codex" effort="low" setEffort={ignore}
          approvalMode="auto" setApprovalMode={ignore} model="" setModel={ignore}
          messages={sessions[id].messages} setMessages={value=>update(id,'messages',value)}
          onSettings={ignore} onApply={()=>{setApplied(value=>value+1);return true;}}
          active={active===id} sidebarVisible={panelVisible} sessionId={id} conversationTitle={'Session '+id}
          input={sessions[id].draft} setInput={value=>update(id,'draft',value)}
          onRunningChange={ignore}
          annotations={sessions[id].annotations} setAnnotations={value=>update(id,'annotations',value)}
          capabilities={capabilities}/>)}</main></>;
      }
      createRoot(document.getElementById('root')).render(<Fixture/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const waitUntil = async (condition, message) => {
  const deadline = Date.now() + 10000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const emit = (run, event) => {
  assert.equal(run.closed, false, 'The controlled response must still be connected.');
  run.res.write(`data: ${JSON.stringify(event)}\n\n`);
};
const finish = (run, text) => {
  if (text) emit(run, { type: 'text-delta', delta: text });
  emit(run, { type: 'done', outcome: 'completed' });
  run.res.end();
};
let browser;
try {
  browser = await chromium.launch({
    channel:
      process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((base) => {
    window.openpe = { connection: async () => ({ base, token: 'fixture' }) };
    window.liveClockIntervals = new Set();
    const nativeInterval = window.setInterval.bind(window);
    const nativeClearInterval = window.clearInterval.bind(window);
    window.setInterval = (callback, delay, ...args) => {
      const id = nativeInterval(callback, delay, ...args);
      if (delay === 250) window.liveClockIntervals.add(id);
      return id;
    };
    window.clearInterval = (id) => {
      window.liveClockIntervals.delete(id);
      nativeClearInterval(id);
    };
    window.copiedMessages = [];
    window.copyAttempts = 0;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.copyAttempts++;
          if (window.holdCopy)
            await new Promise((resolve) => {
              window.releaseCopy = resolve;
            });
          if (window.failCopy) throw new Error('Controlled clipboard rejection');
          window.copiedMessages.push(text);
        },
      },
    });
  }, base);
  await page.route(`${base}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/agent-settings')
      return route.fulfill({ json: { followUpMode: 'queue' } });
    if (pathname === '/api/chat' || pathname === '/api/chat/tool-result') return route.continue();
    if (pathname === '/api/models')
      return route.fulfill({
        json: {
          models: [
            { id: 'fixture-model', label: 'Fixture model', efforts: ['low', 'medium', 'high'] },
          ],
          defaultModel: 'fixture-model',
        },
      });
    if (/^\/agents\/[\w.-]+\.svg$/.test(pathname))
      return route.fulfill({ body: await readFile('public' + pathname) });
    if (pathname.startsWith('/api/')) throw new Error(`Unexpected API call: ${pathname}`);
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto(base);
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({
    content:
      'body{overflow:auto}main{width:480px;height:780px}main>.chat-panel{height:100%}nav{display:flex;gap:12px;padding:12px}',
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const input = page.getByRole('textbox', { name: 'Message your agent', exact: true });
  const visibleChat = page.locator('.chat-panel:visible');
  const send = async (prompt) => {
    const index = requests.length;
    if (prompt !== undefined) await input.fill(prompt);
    await button('Send message').click();
    await waitUntil(() => requests.length > index, 'The chat request was not submitted.');
    await button('Stop generation').waitFor();
    return requests[index];
  };
  const stop = async (run, keyboard = false) => {
    const draft = await input.inputValue();
    const selection = await input.evaluate((element) => [
      element.selectionStart,
      element.selectionEnd,
    ]);
    if (keyboard) await input.press('Escape');
    else await button('Stop generation').click();
    await button('Send message').waitFor();
    await waitUntil(() => run.closed, 'Stopping did not disconnect the originating SSE response.');
    assert.equal(
      await input.evaluate((element) => element === document.activeElement),
      true,
      'Stop returns focus to the originating draft.',
    );
    assert.equal(await input.inputValue(), draft);
    assert.deepEqual(
      await input.evaluate((element) => [element.selectionStart, element.selectionEnd]),
      selection,
    );
  };
  const messages = (sessionId = 'first-session') =>
    page.evaluate((id) => window.chatStopFixture.sessions[id].messages, sessionId);

  // Cancellation while awaiting the first token releases the composer and retains a new draft.
  const literalPrompt =
    'Stop before the first token\n```openpe\nKeep this user text literally.\n```\nΩ';
  const beforeText = await send(literalPrompt);
  await input.fill('Draft typed while waiting');
  await input.dispatchEvent('compositionstart');
  await input.dispatchEvent('keydown', { key: 'Escape', keyCode: 27, isComposing: false });
  await button('Stop generation').click();
  assert.equal(
    await input.evaluate((element) => element === document.activeElement),
    true,
    'Pointer Stop cannot blur an unfinished composition.',
  );
  assert.equal(
    beforeText.closed,
    false,
    'Composition lifecycle blocks Escape and pointer Stop even without event flags.',
  );
  await button('Stop generation').waitFor();
  await input.dispatchEvent('compositionend');
  await input.fill('');
  await input.dispatchEvent('compositionstart');
  await button('Stop generation').click();
  assert.equal(
    beforeText.closed,
    false,
    'An empty draft cannot bypass composition protection on the primary Stop button.',
  );
  await button('Stop generation').waitFor();
  await input.dispatchEvent('compositionend');
  await input.fill('Draft typed while waiting');
  assert.equal(await input.getAttribute('aria-keyshortcuts'), null);
  assert.equal(await button('Stop generation').getAttribute('title'), 'Stop generation');
  for (const event of [
    { key: 'Escape', isComposing: true, keyCode: 229 },
    { key: 'Escape', keyCode: 229 },
    { key: 'Escape', repeat: true },
    { key: 'Escape', ctrlKey: true },
  ])
    await input.dispatchEvent('keydown', event);
  assert.equal(
    beforeText.closed,
    false,
    'Composition, repeat and modified Escape cannot stop a run.',
  );
  await button('Stop generation').waitFor();
  const permission = visibleChat.getByRole('combobox', { name: 'Agent permissions', exact: true });
  await permission.click();
  await page.keyboard.press('Escape');
  assert.equal(await permission.getAttribute('aria-expanded'), 'false');
  assert.equal(beforeText.closed, false, 'Escape in a permission menu closes only the menu.');
  await stop(beforeText, true);
  assert.equal(await input.inputValue(), 'Draft typed while waiting');
  assert.equal(await input.getAttribute('aria-keyshortcuts'), null);
  await input.press('Escape');
  assert.equal(
    await input.inputValue(),
    'Draft typed while waiting',
    'Idle Escape keeps the draft.',
  );
  assert.equal(requests.length, 1);
  let assistant = (await messages()).at(-1);
  assert.equal(assistant.outcome, 'cancelled');
  assert.equal(assistant.text, '');
  await visibleChat
    .locator('.message.assistant')
    .last()
    .locator('.message-author')
    .getByText('Stopped', { exact: true })
    .waitFor();
  const firstUser = visibleChat.locator('.message.user').first();
  const copyMessage = firstUser.getByRole('button', { name: 'Copy message', exact: true });
  await copyMessage.focus();
  await copyMessage.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.equal(await page.evaluate(() => window.copyAttempts), 0);
  await copyMessage.press('Enter');
  await firstUser.getByText('Copied', { exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.copiedMessages), [literalPrompt]);
  await page.evaluate(() => {
    window.failCopy = true;
  });
  await copyMessage.click();
  await firstUser.getByText('Could not copy. Try again.', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.failCopy = false;
    window.holdCopy = true;
  });
  await copyMessage.click();
  await page.waitForFunction(() => typeof window.releaseCopy === 'function');
  await copyMessage.evaluate((element) => {
    element.click();
    element.click();
  });
  assert.equal(await page.evaluate(() => window.copyAttempts), 3);
  assert.equal(await copyMessage.isDisabled(), true);
  await page.evaluate(() => {
    window.holdCopy = false;
    window.releaseCopy();
  });
  await firstUser.getByText('Copied', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.copiedMessages.length), 2);
  const restorePrompt = visibleChat
    .locator('.message.assistant')
    .last()
    .getByRole('button', { name: 'Edit original prompt', exact: true });
  assert.ok(await restorePrompt.isDisabled());
  const stoppedTranscript = await messages();
  await input.fill('');
  await restorePrompt.press('Enter');
  assert.equal(await input.inputValue(), literalPrompt);
  assert.ok(await input.evaluate((field) => document.activeElement === field));
  assert.ok(
    await page.evaluate(() => {
      const { messages, annotations } = window.chatStopFixture.sessions['first-session'];
      return (
        annotations.length === 1 &&
        annotations[0] !== messages[0].annotations[0] &&
        JSON.stringify(annotations) === JSON.stringify(messages[0].annotations)
      );
    }),
  );
  assert.deepEqual(await messages(), stoppedTranscript);
  assert.equal(requests.length, 1);
  await visibleChat.getByRole('button', { name: 'Remove annotation 1', exact: true }).click();

  // Interrupting streamed text preserves it exactly once and retains the follow-up draft.
  const partial = await send('Inspect the inductor ripple');
  const partialText = 'Partial Ω analysis before interruption.';
  emit(partial, { type: 'status', stage: 'waiting', text: 'Waiting for the model…' });
  emit(partial, { type: 'text-delta', delta: partialText });
  await visibleChat.getByText(partialText, { exact: true }).waitFor();
  assert.equal(
    await visibleChat
      .locator('.message.assistant')
      .last()
      .getByRole('button', { name: 'Copy response', exact: true })
      .count(),
    0,
  );
  assert.ok(
    await visibleChat.locator('.chat-transcript').evaluate((transcript) => {
      const progress = transcript.querySelector('.chat-progress');
      const reply = transcript.querySelector('.message.assistant:last-of-type');
      return (
        transcript.lastElementChild === progress &&
        progress.getBoundingClientRect().top >= reply.getBoundingClientRect().bottom &&
        !reply.querySelector('.chat-progress')
      );
    }),
    'Live model status stays below all conversation content.',
  );
  assert.match(
    await visibleChat
      .locator('.message.assistant')
      .last()
      .locator('.message-author .message-timing')
      .innerText(),
    /^(?:<1s|\d+s|\d+m(?: \d+s)?)$/,
  );
  assert.equal(await visibleChat.locator('.chat-progress [aria-label="Elapsed time"]').count(), 0);
  assert.equal(
    await visibleChat.locator('.chat-progress [role="status"]').innerText(),
    'Receiving response…',
  );
  assert.equal(await visibleChat.locator('.chat-progress svg.spin').count(), 1);
  emit(partial, { type: 'status', stage: 'thinking', text: 'Model reasoning…' });
  await visibleChat
    .locator('.chat-progress')
    .getByText('Model reasoning…', { exact: true })
    .waitFor();
  await input.fill('Continue with a different question');
  await stop(partial);
  assert.equal(await visibleChat.locator('.chat-progress').count(), 0);
  assert.equal(await input.inputValue(), 'Continue with a different question');
  assistant = (await messages()).at(-1);
  assert.equal(assistant.outcome, 'cancelled');
  assert.equal(assistant.text, partialText);
  const partialReply = visibleChat.locator('.message.assistant').last();
  await partialReply.locator('.message-author').getByText('Stopped', { exact: true }).waitFor();
  await partialReply.getByRole('button', { name: 'Copy response', exact: true }).click();
  await partialReply.getByText('Copied', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.copiedMessages.at(-1)), partialText);
  assert.ok(
    await visibleChat
      .locator('.message.assistant')
      .last()
      .evaluate(
        (reply) =>
          reply.querySelector('.message-author .message-timing') &&
          Math.abs(
            reply.querySelector('.message-timing').getBoundingClientRect().right -
              reply.querySelector('.message-author').getBoundingClientRect().right,
          ) < 1 &&
          reply.querySelector('.message-timing').getBoundingClientRect().left >=
            reply.querySelector('.message-agent-name').getBoundingClientRect().right &&
          !reply.querySelector('.agent-process > summary') &&
          !reply.querySelector('.chat-progress'),
      ),
    'Plain replies keep finished elapsed time at the right of the Agent header without an empty disclosure.',
  );
  assert.match(
    await visibleChat.locator('.message.assistant').last().locator('.message-timing').innerText(),
    /^(?:<1s|\d+s|\d+m(?: \d+s)?)$/,
  );
  assert.equal(await visibleChat.getByText(partialText, { exact: true }).count(), 1);

  const next = await send();
  assert.equal(next.body.prompt, 'Continue with a different question');
  assert.ok(
    next.body.history.some(
      (message) => message.role === 'assistant' && message.text === partialText,
    ),
    'The next message retains the interrupted assistant content as conversation context.',
  );
  assert.ok(next.body.history.every((message) => !message.text.includes('Generation stopped.')));
  assert.ok(
    next.body.history.every((message) => message.role !== 'assistant' || message.text.trim()),
    'An interrupted response without text is not added to provider history.',
  );
  const markdownReply = '**Feedback**\n\n$V_{OUT}=8\\,V$\n\n```spice\nR1 out fb 55.3k\n```';
  finish(next, '```openpe_session\n{"title":"Hidden title"}\n```\n' + markdownReply);
  await button('Send message').waitFor();
  const markdownMessage = visibleChat.locator('.message.assistant').last();
  assert.equal(await markdownMessage.locator('.agent-response-outcome').count(), 0);
  assert.equal(
    await markdownMessage
      .getByRole('button', { name: 'Edit original prompt', exact: true })
      .count(),
    0,
  );
  await markdownMessage.getByRole('button', { name: 'Copy response', exact: true }).click();
  await markdownMessage.getByText('Copied', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.copiedMessages.at(-1)), markdownReply);
  await markdownMessage.locator('.message-actions .copy-action[data-state="idle"]').waitFor();
  assert.equal(await markdownMessage.getByText('Copied', { exact: true }).count(), 0);

  // A complete fenced proposal in an unfinished response cannot reach Auto or manual Apply.
  const proposal = await send('Prepare a value change');
  const proposalText =
    'An unfinished value suggestion.\n```openpe\n[{"type":"setValue","ref":"R1","value":"47k"}]\n```';
  emit(proposal, { type: 'text-delta', delta: proposalText });
  await visibleChat.getByText('An unfinished value suggestion.', { exact: true }).waitFor();
  await stop(proposal);
  assert.equal((await messages()).at(-1).text, proposalText);
  assert.equal(await page.evaluate(() => window.chatStopFixture.applied), 0);
  assert.equal(await visibleChat.getByRole('button', { name: 'Apply to schematic' }).count(), 0);
  const proposalReply = visibleChat.locator('.message.assistant').last();
  await proposalReply.getByRole('button', { name: 'Copy response', exact: true }).click();
  await proposalReply.getByText('Copied', { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => window.copiedMessages.at(-1)),
    'An unfinished value suggestion.',
  );

  const completedProposal = await send('Complete a value change');
  finish(completedProposal, proposalText);
  await button('Send message').waitFor();
  assert.equal(
    await page.evaluate(() => window.chatStopFixture.applied),
    1,
    'The same complete proposal remains applicable after a successful response.',
  );

  // Each mounted conversation keeps its own AbortController and in-flight response.
  const firstRun = await send('Keep the first session running');
  emit(firstRun, { type: 'text-delta', delta: 'First session remains active.' });
  await visibleChat.getByText('First session remains active.', { exact: true }).waitFor();
  await button('Toggle conversation panel').click();
  assert.equal(await page.evaluate(() => window.liveClockIntervals.size), 0);
  emit(firstRun, { type: 'text-delta', delta: ' Panel-hidden output.' });
  emit(firstRun, { type: 'status', stage: 'waiting', text: 'Background panel checkpoint.' });
  await page
    .locator('.chat-panel:not([hidden]) .chat-progress')
    .getByText('Background panel checkpoint.', { exact: true })
    .waitFor({ state: 'attached' });
  assert.equal(firstRun.closed, false, 'Collapsing the Agent panel cannot cancel its stream.');
  await button('Toggle conversation panel').click();
  const firstText = 'First session remains active. Panel-hidden output.';
  await visibleChat.getByText(firstText, { exact: true }).waitFor();
  await button('Show session 2').click();
  const secondRun = await send('Stop only the second session');
  emit(secondRun, { type: 'text-delta', delta: 'Second session partial.' });
  await visibleChat.getByText('Second session partial.', { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => window.liveClockIntervals.size),
    1,
    'Only the visible conversation should keep a live display clock.',
  );
  await stop(secondRun, true);
  assert.equal(firstRun.closed, false, 'Stopping session two must preserve session one.');
  assert.equal((await messages('second-session')).at(-1).outcome, 'cancelled');
  assert.equal(
    await page.evaluate(() => window.liveClockIntervals.size),
    0,
    'A running hidden conversation receives output without ticking its display clock.',
  );
  emit(firstRun, { type: 'text-delta', delta: ' More first-session output.' });
  await button('Show session 1').click();
  await button('Stop generation').waitFor();
  await visibleChat.getByText(firstText + ' More first-session output.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.liveClockIntervals.size), 1);
  await button('Show session 2').click();
  assert.equal(await page.evaluate(() => window.liveClockIntervals.size), 0);
  finish(firstRun, ' Completed while hidden.');
  await page.waitForFunction(
    () => window.chatStopFixture.sessions['first-session'].messages.at(-1).outcome === 'completed',
  );
  assert.equal(
    await page
      .locator('.chat-panel[hidden] .agent-answer-part .agent-markdown')
      .last()
      .textContent(),
    firstText + ' More first-session output.',
    'Hidden Markdown retains its mounted presentation while underlying messages complete.',
  );
  assert.equal(
    (await messages()).at(-1).text,
    firstText + ' More first-session output. Completed while hidden.',
  );
  await button('Show session 1').click();
  await visibleChat
    .getByText(firstText + ' More first-session output. Completed while hidden.', {
      exact: true,
    })
    .waitFor();
  await button('Send message').waitFor();
  assert.equal((await messages()).at(-1).outcome, 'completed');
  assert.equal(await page.evaluate(() => window.chatStopFixture.applied), 1);

  // A folded group shows running activity; Stop seals the card in its originating history.
  const toolRun = await send('Observe a slow OpenPE query');
  emit(toolRun, {
    type: 'capability-request',
    tool: 'openpe_query',
    arguments: { name: 'project.snapshot' },
    sessionId: 'first-session',
    runId: 'tool-run',
    requestId: 'slow-query',
    token: 'private-tool-token',
  });
  const toolReply = visibleChat.locator('.message.assistant').last();
  await toolReply.getByRole('status', { name: 'Running tool calls', exact: true }).waitFor();
  assert.equal(await toolReply.locator('.agent-tool-call').count(), 0);
  assert.equal(await toolReply.locator('.agent-tool-history > summary').innerText(), '1 tool call');
  await visibleChat
    .locator('.chat-progress')
    .getByText('Using OpenPE tools…', { exact: true })
    .waitFor();
  await mkdir('test-results/agent-stop', { recursive: true });
  await visibleChat.screenshot({ path: 'test-results/agent-stop/running-tools.png' });
  const liveToolSummary = toolReply.locator('.agent-tool-history > summary');
  await liveToolSummary.click();
  await liveToolSummary.focus();
  await liveToolSummary.evaluate((element) => {
    window.retainedToolSummary = element;
  });
  const anotherTool = (requestId) =>
    emit(toolRun, {
      type: 'capability-request',
      tool: 'openpe_query',
      arguments: { name: 'core.state' },
      sessionId: 'first-session',
      runId: 'tool-run',
      requestId,
      token: 'private-tool-token',
    });
  anotherTool('slow-query-two');
  await liveToolSummary.getByText('2 tool calls', { exact: true }).waitFor();
  assert.equal(await toolReply.locator('.agent-tool-history[open]').count(), 0);
  assert.equal(
    await liveToolSummary.evaluate(
      (element) => element === window.retainedToolSummary && document.activeElement === element,
    ),
    true,
    'New calls fold history without replacing its focused summary.',
  );
  await liveToolSummary.press('Enter');
  const expandedToolSummary = toolReply.locator('.agent-tool-call').last().locator('summary');
  await expandedToolSummary.focus();
  anotherTool('slow-query-three');
  await liveToolSummary.getByText('3 tool calls', { exact: true }).waitFor();
  assert.equal(await toolReply.locator('.agent-tool-history[open]').count(), 0);
  assert.equal(
    await liveToolSummary.evaluate((element) => document.activeElement === element),
    true,
    'Folding a focused tool row returns focus to its group, without moving the composer.',
  );
  await input.focus();
  anotherTool('slow-query-four');
  await liveToolSummary.getByText('4 tool calls', { exact: true }).waitFor();
  assert.equal(
    await input.evaluate((element) => document.activeElement === element),
    true,
    'A new tool call cannot steal focus from a draft outside its history.',
  );
  await liveToolSummary.focus();
  await liveToolSummary.press('Enter');
  const toolCard = visibleChat.locator('.agent-tool-call').last();
  await toolCard.locator('.tool-state').getByText('Running…', { exact: true }).waitFor();
  await toolCard.locator('summary').focus();
  await toolCard.locator('summary').press('Enter');
  assert.equal(await toolCard.locator('details').getAttribute('open'), '');
  assert.doesNotMatch(await toolCard.innerText(), /private-tool-token|tool-run|slow-query/);
  await button('Show session 2').click();
  assert.equal(await visibleChat.locator('.agent-tool-call').count(), 0);
  await button('Show session 1').click();
  await stop(toolRun);
  assert.equal(
    await visibleChat.getByRole('status', { name: 'Running tool calls', exact: true }).count(),
    0,
  );
  const summary = toolReply.locator('.agent-process > summary');
  const stopped = summary.getByText('Stopped', { exact: true });
  await stopped.waitFor();
  assert.equal(await summary.getAttribute('aria-describedby'), await stopped.getAttribute('id'));
  assert.equal(await summary.locator('svg').count(), 0);
  assert.equal(await toolReply.locator('.message-author .message-timing').count(), 1);
  await summary.getByLabel('Elapsed time', { exact: true }).waitFor();
  assert.doesNotMatch(await summary.innerText(), /Work details/);
  assert.equal(await summary.locator('.message-agent-name').innerText(), 'Codex');
  await summary.getByLabel('Elapsed time', { exact: true }).click();
  assert.equal(await toolReply.locator('.agent-process[open]').count(), 1);
  await summary.getByLabel('Elapsed time', { exact: true }).click();
  assert.equal(await toolReply.locator('.agent-process[open]').count(), 0);
  await visibleChat.screenshot({ path: 'test-results/agent-stop/completed-tools.png' });
  await toolReply.locator('.agent-process > summary').click();
  await toolReply.locator('.agent-tool-history > summary').click();
  assert.equal(await toolCard.getAttribute('data-tool-status'), 'cancelled');
  await page.evaluate(() => window.releaseToolQuery({ revision: 'late-revision' }));
  await page.waitForTimeout(100);
  assert.equal(await toolCard.getAttribute('data-tool-status'), 'cancelled');
  assert.equal(toolResults.length, 0, 'A stopped tool cannot publish a late response.');
  assert.doesNotMatch(await toolCard.innerText(), /late-revision/);

  // Automatic completion folds focused work into an accessible header without stealing drafts.
  for (const mode of ['work', 'code', 'draft', 'other-session', 'hidden-panel']) {
    const completionRun = await send(`Complete while focused on ${mode}`);
    if (mode === 'code')
      emit(completionRun, { type: 'text-delta', delta: '```spice\nR1 out 0 10k\n```\n\n' });
    emit(completionRun, {
      type: 'capability-request',
      tool: 'openpe_query',
      arguments: { name: 'project.snapshot' },
      sessionId: 'first-session',
      runId: `completion-${mode}`,
      requestId: `completion-query-${mode}`,
      token: 'private-tool-token',
    });
    const completionReply = page
      .locator('.chat-panel')
      .first()
      .locator('.message.assistant')
      .last();
    await completionReply
      .getByRole('status', { name: 'Running tool calls', exact: true })
      .waitFor();
    const resultCount = toolResults.length + 1;
    await page.evaluate(() => window.releaseToolQuery({ revision: 'current-revision' }));
    await waitUntil(
      () => toolResults.length === resultCount,
      'The controlled query did not finish.',
    );
    await completionReply.locator('.agent-tool-history > summary').click();
    await completionReply.locator('.agent-tool-call > details > summary').focus();
    if (mode === 'code')
      await completionReply
        .locator('.agent-process-body')
        .getByLabel('spice code', { exact: true })
        .focus();
    if (mode === 'draft' || mode === 'other-session') {
      if (mode === 'other-session') await button('Show session 2').click();
      await input.fill('Keep this draft and selection');
      await input.evaluate((element) => element.setSelectionRange(2, 8));
    } else if (mode === 'hidden-panel') {
      await button('Toggle conversation panel').click();
    }
    finish(completionRun, `Completed ${mode}.`);
    await page.waitForFunction(
      () =>
        window.chatStopFixture.sessions['first-session'].messages.at(-1)?.outcome === 'completed',
    );
    const completedHeader = completionReply.locator('.agent-process > summary');
    assert.equal(await completionReply.locator('.agent-process[open]').count(), 0);
    assert.equal(
      await completedHeader.evaluate((element) => document.activeElement === element),
      mode === 'work' || mode === 'code',
      `${mode}: completion restores only focus from the disappearing visible work.`,
    );
    if (mode === 'draft' || mode === 'other-session') {
      assert.deepEqual(
        await input.evaluate((element) => [
          element === document.activeElement,
          element.selectionStart,
          element.selectionEnd,
          element.value,
        ]),
        [true, 2, 8, 'Keep this draft and selection'],
      );
    }
    if (mode === 'other-session') await button('Show session 1').click();
    if (mode === 'hidden-panel') await button('Toggle conversation panel').click();
    if (mode !== 'work' && mode !== 'code')
      assert.equal(
        await completedHeader.evaluate((element) => document.activeElement === element),
        false,
        'Revealing completed work does not replay a focus request.',
      );
    await input.fill('');
  }

  // Reading old output pauses following; the explicit jump resumes it without moving focus.
  const scrollingRun = await send('Read a long response');
  emit(scrollingRun, { type: 'text-delta', delta: 'Long analysis.\n\n'.repeat(120) });
  const chatScroll = visibleChat.locator('.chat-scroll');
  await visibleChat.getByText('Long analysis.', { exact: true }).first().waitFor();
  await chatScroll.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });
  await chatScroll.evaluate(
    (element) =>
      new Promise((resolve) => {
        const paragraph = element.querySelector(
          '.message.assistant:last-of-type .agent-markdown p:last-of-type',
        );
        const range = document.createRange();
        range.setStart(paragraph.firstChild, 0);
        range.setEnd(paragraph.firstChild, 4);
        document.addEventListener('selectionchange', resolve, { once: true });
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }),
  );
  await button('Latest messages').waitFor();
  const readingOffset = await chatScroll.evaluate((element) => element.scrollTop);
  emit(scrollingRun, { type: 'text-delta', delta: '\n\nOutput while selecting.\n\n'.repeat(10) });
  await visibleChat
    .getByText('Output while selecting.', { exact: true })
    .last()
    .waitFor({ state: 'attached' });
  assert.ok(
    Math.abs((await chatScroll.evaluate((element) => element.scrollTop)) - readingOffset) < 2,
    'Selecting response text pauses following without scrolling away from it.',
  );
  await chatScroll.evaluate((element) => element.dispatchEvent(new Event('scroll')));
  await button('Latest messages').waitFor();
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        document.addEventListener('selectionchange', resolve, { once: true });
        window.getSelection().removeAllRanges();
      }),
  );
  emit(scrollingRun, { type: 'text-delta', delta: '\n\nOutput after clearing selection.' });
  await visibleChat
    .getByText('Output after clearing selection.', { exact: true })
    .waitFor({ state: 'attached' });
  assert.ok(
    Math.abs((await chatScroll.evaluate((element) => element.scrollTop)) - readingOffset) < 2,
    'Clearing the selection cannot resume following or move the reading position.',
  );
  await button('Latest messages').focus();
  await button('Latest messages').press('Enter');
  await button('Latest messages').waitFor({ state: 'hidden' });
  emit(scrollingRun, { type: 'text-delta', delta: '\n\nOutput after resuming.' });
  await visibleChat.getByText('Output after resuming.', { exact: true }).waitFor();
  assert.ok(
    await chatScroll.evaluate(
      (element) => element.scrollHeight - element.scrollTop - element.clientHeight < 2,
    ),
  );
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        const external = document.createElement('span');
        external.id = 'external-selection';
        external.textContent = 'Editor selection';
        document.body.append(external);
        const range = document.createRange();
        range.selectNodeContents(external);
        document.addEventListener('selectionchange', resolve, { once: true });
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }),
  );
  assert.equal(
    await button('Latest messages').count(),
    0,
    'Selecting outside the conversation cannot pause its stream.',
  );
  await page.evaluate(() => document.getElementById('external-selection').remove());
  await input.focus();
  await chatScroll.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
  });
  await button('Latest messages').waitFor();
  emit(scrollingRun, { type: 'text-delta', delta: '\n\nNew output while reading.' });
  await visibleChat
    .getByText('New output while reading.', { exact: true })
    .waitFor({ state: 'attached' });
  assert.equal(await chatScroll.evaluate((el) => el.scrollTop), 0);
  assert.equal(await input.evaluate((el) => document.activeElement === el), true);
  await button('Latest messages').focus();
  await button('Latest messages').press('Enter');
  await button('Latest messages').waitFor({ state: 'hidden' });
  finish(scrollingRun, 'Following resumed.');
  await button('Send message').waitFor();
  assert.ok(
    await chatScroll.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 2),
  );
  await page.setViewportSize({ width: 560, height: 900 });
  await mkdir('test-results/agent-stop', { recursive: true });
  await visibleChat.screenshot({ path: 'test-results/agent-stop/message-actions-light.png' });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await visibleChat.screenshot({ path: 'test-results/agent-stop/message-actions-dark.png' });
  assert.equal(
    await visibleChat.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    'Agent Stop/completion preserve work focus, partial context, drafts and sessions, block unfinished proposals and keep hidden presentation current.',
  );
} finally {
  for (const run of requests) run.res.destroy();
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
