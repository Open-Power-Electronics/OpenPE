// Actual Chat/AgentComposer components with controlled local SSE and two mounted sessions.
// No Electron, installed provider, external service or solver is launched.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
        const [sessions,setSessions] = useState(Object.fromEntries(ids.map(id=>[id,{messages:[],draft:''}])));
        const [applied,setApplied] = useState(0);
        const update = (id,key,value) => setSessions(previous=>({...previous,
          [id]:{...previous[id],[key]:typeof value === 'function' ? value(previous[id][key]) : value}}));
        window.chatStopFixture = {sessions,applied};
        return <><nav>{ids.map((id,index)=><button key={id} onClick={()=>setActive(id)}>
          Show session {index+1}</button>)}</nav><main>{ids.map(id=><Chat key={id}
          doc={doc} agents={agents} provider="codex" effort="low" setEffort={ignore}
          approvalMode="auto" setApprovalMode={ignore} model="" setModel={ignore}
          messages={sessions[id].messages} setMessages={value=>update(id,'messages',value)}
          onSettings={ignore} onApply={()=>{setApplied(value=>value+1);return true;}}
          active={active===id} sessionId={id} conversationTitle={'Session '+id}
          input={sessions[id].draft} setInput={value=>update(id,'draft',value)}
          onRunningChange={ignore}
          annotations={[]} setAnnotations={ignore} capabilities={capabilities}/>)}</main></>;
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
  }, base);
  await page.route(`${base}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
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
  const stop = async (run) => {
    await button('Stop generation').click();
    await button('Send message').waitFor();
    await waitUntil(() => run.closed, 'Stopping did not disconnect the originating SSE response.');
  };
  const messages = (sessionId = 'first-session') =>
    page.evaluate((id) => window.chatStopFixture.sessions[id].messages, sessionId);

  // Cancellation while awaiting the first token releases the composer and retains a new draft.
  const beforeText = await send('Stop before the first token');
  await input.fill('Draft typed while waiting');
  await stop(beforeText);
  assert.equal(await input.inputValue(), 'Draft typed while waiting');
  let assistant = (await messages()).at(-1);
  assert.equal(assistant.outcome, 'cancelled');
  assert.equal(assistant.text, '');

  // Interrupting streamed text preserves it exactly once and retains the follow-up draft.
  const partial = await send('Inspect the inductor ripple');
  const partialText = 'Partial Ω analysis before interruption.';
  emit(partial, { type: 'status', stage: 'waiting', text: 'Waiting for the model…' });
  emit(partial, { type: 'text-delta', delta: partialText });
  await visibleChat.getByText(partialText, { exact: true }).waitFor();
  assert.ok(
    await visibleChat
      .locator('.message.assistant')
      .last()
      .evaluate((reply) => {
        const progress = reply.querySelector('.chat-progress');
        const body = reply.querySelector('.agent-markdown');
        const name = reply.querySelector('.message-agent-name');
        return (
          progress.parentElement === reply.querySelector('.message-author') &&
          progress.getBoundingClientRect().left >= name.getBoundingClientRect().right &&
          Math.abs(
            progress.getBoundingClientRect().right -
              reply.querySelector('.message-author').getBoundingClientRect().right,
          ) < 1 &&
          progress.getBoundingClientRect().bottom <= body.getBoundingClientRect().top
        );
      }),
    'Live elapsed time aligns to the right edge of the Agent header.',
  );
  assert.match(
    await visibleChat.locator('.chat-progress .chat-elapsed').innerText(),
    /^(?:<1s|\d+s|\d+m(?: \d+s)?)$/,
  );
  assert.equal(
    await visibleChat.locator('.chat-progress [role="status"]').innerText(),
    'Receiving response…',
  );
  assert.equal(await visibleChat.locator('.chat-progress svg').count(), 0);
  await input.fill('Continue with a different question');
  await stop(partial);
  assert.equal(await input.inputValue(), 'Continue with a different question');
  assistant = (await messages()).at(-1);
  assert.equal(assistant.outcome, 'cancelled');
  assert.equal(assistant.text, partialText);
  assert.ok(
    await visibleChat
      .locator('.message.assistant')
      .last()
      .evaluate(
        (reply) =>
          reply
            .querySelector('.message-agent-name')
            .nextElementSibling.matches('.message-timing') &&
          Math.abs(
            reply.querySelector('.message-timing').getBoundingClientRect().right -
              reply.querySelector('.message-author').getBoundingClientRect().right,
          ) < 1 &&
          !reply.querySelector('.chat-progress'),
      ),
    'Finished elapsed time aligns to the right edge of the Agent header.',
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
  finish(next, 'The new request completed.');
  await button('Send message').waitFor();

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
  await button('Show session 2').click();
  const secondRun = await send('Stop only the second session');
  emit(secondRun, { type: 'text-delta', delta: 'Second session partial.' });
  await visibleChat.getByText('Second session partial.', { exact: true }).waitFor();
  await stop(secondRun);
  assert.equal(firstRun.closed, false, 'Stopping session two must preserve session one.');
  assert.equal((await messages('second-session')).at(-1).outcome, 'cancelled');
  emit(firstRun, { type: 'text-delta', delta: ' More first-session output.' });
  await button('Show session 1').click();
  await button('Stop generation').waitFor();
  await visibleChat
    .getByText('First session remains active. More first-session output.', { exact: true })
    .waitFor();
  finish(firstRun);
  await button('Send message').waitFor();
  assert.equal((await messages()).at(-1).outcome, 'completed');
  assert.equal(await page.evaluate(() => window.chatStopFixture.applied), 1);

  // In-flight tools are visible in their originating conversation and Stop seals the card.
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
  assert.equal(await toolCard.getAttribute('data-tool-status'), 'cancelled');
  await page.evaluate(() => window.releaseToolQuery({ revision: 'late-revision' }));
  await page.waitForTimeout(100);
  assert.equal(await toolCard.getAttribute('data-tool-status'), 'cancelled');
  assert.equal(toolResults.length, 0, 'A stopped tool cannot publish a late response.');
  assert.doesNotMatch(await toolCard.innerText(), /late-revision/);

  // Reading old output pauses following; the explicit jump resumes it without moving focus.
  const scrollingRun = await send('Read a long response');
  emit(scrollingRun, { type: 'text-delta', delta: 'Long analysis.\n\n'.repeat(120) });
  const chatScroll = visibleChat.locator('.chat-scroll');
  await visibleChat.getByText('Long analysis.', { exact: true }).first().waitFor();
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
  assert.deepEqual(errors, []);
  console.log(
    'Agent Stop releases waiting/streaming responses, preserves partial context and drafts, blocks unfinished proposals and isolates sessions.',
  );
} finally {
  for (const run of requests) run.res.destroy();
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
