// Real Chat with controlled command discovery/SSE; no Electron, provider or design writes.
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
      import Chat from './components/Chat';import{emptyCircuit}from'./lib/circuit';
      const doc=emptyCircuit(),noop=()=>{},agents=[{id:'codex',available:true,supportsEffort:true}];
      const hosts=Object.fromEntries(['first','second'].map(id=>[id,{
        query:async name=>{if(name!=='capabilities.list')throw Error('Unexpected query');return [{id:'part.properties',kind:'command',available:true,review:'required',description:window.longDescription?'Review the captured operating conditions before changing the resistor. '.repeat(50):'Update the resistor from the captured command.'}]},
        execute:async(name,input)=>{window.executions.push({sessionId:id,name,input});if(window.holdApply)await new Promise(resolve=>{window.releaseApply=resolve});return {status:'applied'}},observe:async()=>null
      }]));
      function Fixture(){const[sessions,setSessions]=useState(Object.fromEntries(['first','second'].map(id=>[id,{messages:[],draft:''}]))),[active,setActive]=useState('first');
        window.setSession=setActive;window.reviewSessions=sessions;
        const update=(id,key,value)=>setSessions(items=>({...items,[id]:{...items[id],[key]:typeof value==='function'?value(items[id][key]):value}}));
        return <><main>{Object.entries(sessions).map(([id,session])=><Chat key={id} doc={doc} agents={agents} provider="codex" effort="low" setEffort={noop}
          approvalMode="review" setApprovalMode={noop} model="fixture-model" setModel={noop} messages={session.messages} setMessages={value=>update(id,'messages',value)}
          input={session.draft} setInput={value=>update(id,'draft',value)} annotations={[]} setAnnotations={noop} onSettings={noop} onApply={()=>false}
          active={active===id} sessionId={id} conversationTitle={id} onRunningChange={noop} capabilities={hosts[id]}/>)}</main>
          <aside id="editor"><textarea aria-label="Editor draft" defaultValue="Preserve editor draft"/><div style={{height:1400}}>Independent editor</div></aside></>}
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
    window.openpe = { connection: async () => ({ base: 'http://localhost', token: 'fixture' }) };
    window.runs = [];
    window.toolReplies = [];
    window.executions = [];
    const encoder = new TextEncoder(),
      nativeFetch = fetch;
    window.emit = (index, event) =>
      window.runs[index].controller.enqueue(
        encoder.encode('data: ' + JSON.stringify(event) + '\n\n'),
      );
    window.fetch = async (url, options) => {
      const path = new URL(url, location.href).pathname;
      if (path === '/api/chat') {
        const run = { body: JSON.parse(options.body) };
        window.runs.push(run);
        return new Response(
          new ReadableStream({
            start(controller) {
              run.controller = controller;
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      if (path === '/api/chat/tool-result') {
        window.toolReplies.push(JSON.parse(options.body));
        return new Response('{"ok":true}');
      }
      return nativeFetch(url, options);
    };
  });
  await page.route('http://localhost/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/agent-settings') return route.fulfill({ json: { followUpMode: 'queue' } });
    if (path === '/api/models')
      return route.fulfill({
        json: {
          models: [{ id: 'fixture-model', label: 'Fixture model', efforts: ['low'] }],
          defaultModel: 'fixture-model',
        },
      });
    if (/^\/agents\/[\w.-]+\.svg$/.test(path))
      return route.fulfill({ body: await readFile('public' + path), contentType: 'image/svg+xml' });
    if (path === '/')
      return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
    throw Error('Unexpected fixture request: ' + path);
  });
  await page.goto('http://localhost/');
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({
    content:
      'body{overflow:auto;min-height:1400px}#root{display:flex;gap:32px;padding:12px}main{width:448px;height:min(760px,calc(100dvh - 24px))}main>.chat-panel{height:100%}#editor{width:400px;height:760px;overflow:auto}',
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const chat = page.locator('.chat-panel:not([hidden])');
  const input = chat.getByRole('textbox', { name: 'Message your agent', exact: true });
  const editor = page.getByRole('textbox', { name: 'Editor draft', exact: true });
  const navigation = chat.getByRole('group', { name: 'Pending action reviews', exact: true });
  const review = navigation.getByRole('button', { name: 'Review pending actions', exact: true });
  const scroll = chat.locator('.chat-scroll');
  const card = (id) => chat.locator(`[data-tool-status="review"][data-review-id="${id}"]`);
  const apply = (id) =>
    card(id).getByRole('button', { name: 'Apply part.properties', exact: true });
  const send = async (text, count) => {
    await input.fill(text);
    await chat.getByRole('button', { name: 'Send message', exact: true }).click();
    await waitForAsync(page, (count) => window.runs.length === count, count);
  };
  const emit = (index, event) =>
    page.evaluate(({ index, event }) => window.emit(index, event), { index, event });
  const request = async (index, id, ref) => {
    await emit(index, {
      type: 'capability-request',
      tool: 'openpe_execute',
      arguments: { name: 'part.properties', input: { ref, value: '10k' } },
      runId: 'run-' + index,
      sessionId: await page.evaluate((index) => window.runs[index].body.sessionId, index),
      requestId: id,
      token: id + '-token',
    });
    await card(id).waitFor();
  };
  const finish = async (index) => {
    await emit(index, { type: 'done', outcome: 'completed' });
    await page.evaluate((index) => window.runs[index].controller.close(), index);
    await chat.getByRole('button', { name: 'Send message', exact: true }).waitFor();
  };
  const inView = (target) =>
    target.evaluate((element) => {
      const rect = element.getBoundingClientRect(),
        viewport = element.closest('.chat-scroll').getBoundingClientRect();
      return rect.top >= viewport.top - 1 && rect.bottom <= viewport.bottom + 1;
    });

  await send('Adjust R1.', 1);
  await request(0, 'first-review', 'R1');
  await emit(0, { type: 'text', text: 'First operating analysis.\n\n'.repeat(28) });
  await finish(0);
  await send('Inspect the next stage.', 2);
  await request(1, 'second-review', 'R2');
  await emit(1, { type: 'text', text: 'Second operating analysis.\n\n'.repeat(28) });
  await navigation.getByText('2 actions need review', { exact: true }).waitFor();
  await input.fill('Keep this next draft Ω.');
  await input.evaluate((element) => element.setSelectionRange(3, 9));
  await page.evaluate(() => {
    window.scrollTo(0, 60);
    document.querySelector('#editor').scrollTop = 85;
  });
  const pose = await page.evaluate(() => [scrollY, document.querySelector('#editor').scrollTop]);
  await review.evaluate((element) => element.focus({ preventScroll: true }));
  await review.press('Enter');
  assert.equal(
    await apply('first-review').evaluate((element) => element === document.activeElement),
    true,
  );
  assert.equal(await inView(apply('first-review')), true);
  assert.deepEqual(
    await page.evaluate(() => window.executions),
    [],
    'Navigation cannot execute a reviewed action.',
  );
  assert.equal(await input.inputValue(), 'Keep this next draft Ω.');
  assert.deepEqual(
    await input.evaluate((element) => [element.selectionStart, element.selectionEnd]),
    [3, 9],
  );
  assert.deepEqual(
    await page.evaluate(() => [scrollY, document.querySelector('#editor').scrollTop]),
    pose,
  );
  const readingTop = await scroll.evaluate((element) => element.scrollTop);
  await emit(1, { type: 'text-delta', delta: '\nMore streamed analysis.\n' });
  await chat.getByText('More streamed analysis.', { exact: true }).waitFor();
  assert.equal(await scroll.evaluate((element) => element.scrollTop), readingTop);
  await chat.locator('.chat-progress').getByText('Receiving response…', { exact: true }).waitFor();

  await input.evaluate((element) => element.focus({ preventScroll: true }));
  await input.dispatchEvent('compositionstart');
  await review.click();
  await chat.getByRole('button', { name: 'Latest messages', exact: true }).click();
  assert.equal(await input.evaluate((element) => element === document.activeElement), true);
  assert.equal(await scroll.evaluate((element) => element.scrollTop), readingTop);
  await input.dispatchEvent('compositionend');
  await review.evaluate((element) => element.focus({ preventScroll: true }));
  assert.equal(
    await review.evaluate((element) =>
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
  );
  await chat.getByRole('button', { name: 'Latest messages', exact: true }).press('Enter');
  assert.equal(await input.evaluate((element) => element === document.activeElement), true);
  assert.deepEqual(
    await input.evaluate((element) => [element.selectionStart, element.selectionEnd]),
    [3, 9],
  );
  await finish(1);

  // Different sessions may contain the same transport-local review identifier.
  await review.focus();
  await page.evaluate(() => window.setSession('second'));
  assert.equal(await navigation.count(), 0);
  await send('Review the other conversation.', 3);
  await request(2, 'first-review', 'R3');
  await emit(2, { type: 'text', text: 'Other conversation review.' });
  await finish(2);
  assert.equal(
    await scroll.evaluate((element) => element.scrollHeight === element.clientHeight),
    true,
    'Review clearance cannot add a scroll range to a fitting conversation.',
  );
  await review.press('Enter');
  assert.equal(
    await apply('first-review').evaluate((element) => element === document.activeElement),
    true,
  );
  assert.equal(
    await page.evaluate(() =>
      document.activeElement.closest('.message').textContent.includes('Other conversation review.'),
    ),
    true,
  );
  await editor.evaluate((element) => element.focus({ preventScroll: true }));
  await page.evaluate(() => window.setSession('first'));
  await navigation.getByText('2 actions need review', { exact: true }).waitFor();
  assert.equal(await editor.evaluate((element) => element === document.activeElement), true);
  assert.equal(await input.inputValue(), 'Keep this next draft Ω.');

  await mkdir('test-results/agent-review-navigation', { recursive: true });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.locator('main').evaluate((element) => {
    element.style.width = '1000px';
    element.style.setProperty('--chat-width', '1000px');
  });
  const wideNavigation = await navigation.boundingBox(),
    wideComposer = await chat.locator('.composer-stack').boundingBox();
  assert.equal(wideNavigation.width, 800);
  assert.ok(
    Math.abs(wideNavigation.x - wideComposer.x) < 1,
    'The review entry shares the composer reading width.',
  );
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.locator('main').evaluate((element) => {
    element.style.width = '328px';
    element.style.setProperty('--chat-width', '328px');
  });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.setProperty('--font-step', '4px');
    }, theme);
    await review.focus();
    await review.press('Enter');
    for (const label of ['Apply part.properties', 'Reject part.properties']) {
      assert.equal(
        await card('first-review')
          .getByRole('button', { name: label, exact: true })
          .evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return (
              document
                .elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
                ?.closest('button') === element
            );
          }),
        true,
        'Floating transcript controls cannot cover a located review action.',
      );
    }
    assert.ok((await chat.boundingBox()).width <= 328);
    assert.ok((await navigation.boundingBox()).width <= 328);
    await page
      .locator('main')
      .screenshot({ path: `test-results/agent-review-navigation/${theme}-328.png` });
  }
  await review.focus();
  await card('first-review')
    .getByRole('button', { name: 'Reject part.properties', exact: true })
    .evaluate((element) => element.click());
  await navigation.getByText('1 action needs review', { exact: true }).waitFor();
  assert.equal(await review.evaluate((element) => element === document.activeElement), true);
  await page.setViewportSize({ width: 1100, height: 680 });
  await review.press('Enter');
  for (const label of ['Apply part.properties', 'Reject part.properties']) {
    assert.equal(
      await card('second-review')
        .getByRole('button', { name: label, exact: true })
        .evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return (
            document
              .elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
              ?.closest('button') === element
          );
        }),
      true,
      'The last review stays clickable above floating transcript controls.',
    );
  }
  await page
    .locator('main')
    .screenshot({ path: 'test-results/agent-review-navigation/last-review-dark-328.png' });
  await review.focus();
  await card('second-review')
    .getByRole('button', { name: 'Reject part.properties', exact: true })
    .evaluate((element) => element.click());
  await navigation.waitFor({ state: 'detached' });
  assert.equal(
    await input.evaluate((element) => element === document.activeElement),
    true,
    'Removing a focused review entry returns to the surviving composer.',
  );
  assert.deepEqual(
    await input.evaluate((element) => [element.selectionStart, element.selectionEnd]),
    [3, 9],
  );
  assert.deepEqual(await page.evaluate(() => window.executions), []);

  await page.evaluate(() => {
    delete document.documentElement.dataset.theme;
    document.documentElement.style.removeProperty('--font-step');
    document.querySelector('main').style.width = '';
    document.querySelector('main').style.removeProperty('--chat-width');
    window.longDescription = true;
    window.holdApply = true;
  });
  await send('Check the complete operating conditions.', 4);
  await request(3, 'large-review', 'R4');
  await emit(3, { type: 'text', text: 'Review the complete command description.' });
  await finish(3);
  await scroll.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  await review.press('Enter');
  assert.equal(
    await inView(apply('large-review')),
    true,
    'A tall review card still reveals its explicit Apply control.',
  );
  assert.deepEqual(await page.evaluate(() => window.executions), []);
  await apply('large-review').press('Enter');
  await waitForAsync(page, () => window.executions.length === 1);
  await navigation.waitFor({ state: 'detached' });
  await editor.evaluate((element) => element.focus({ preventScroll: true }));
  await page.evaluate(() => window.releaseApply());
  await chat
    .locator('[data-review-id="large-review"][data-tool-status="applying"]')
    .waitFor({ state: 'detached' });
  assert.equal(await editor.evaluate((element) => element === document.activeElement), true);
  assert.deepEqual(await page.evaluate(() => window.executions), [
    { sessionId: 'first', name: 'part.properties', input: { ref: 'R4', value: '10k' } },
  ]);
  assert.deepEqual(errors, []);
  console.log(
    'Agent review navigation passed: pending counts, read-only positioning, tall cards, IME, retained drafts/focus, hidden session isolation and explicit Apply only.',
  );
} finally {
  await browser.close();
}
