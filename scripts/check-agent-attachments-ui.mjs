// Actual Chat and pending attachment tray, with no Electron, provider or native files.
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
      import{annotationFixture}from'./tests/fixtures/annotation';
      const doc=emptyCircuit(),noop=()=>{},agents=[{id:'codex',available:true,supportsEffort:true}];
      const captures=Array.from({length:4},(_,index)=>({...annotationFixture(),comment:'Capture '+(index+1)+': keep the original screenshot and Ω, µH parameters.'}));
      function Fixture(){const[annotations,setAnnotations]=useState(captures),[input,setInput]=useState('Keep this literal **draft** and Ω.'),[active,setActive]=useState(true),[messages,setMessages]=useState([{id:'earlier',role:'assistant',text:'Earlier analysis.\\n\\n'.repeat(80)}]);
        window.attachmentFixture={annotations,captures,input};window.setCaptures=setAnnotations;window.setChatVisible=setActive;
        return <><main><Chat doc={doc} agents={agents} provider="codex" effort="low" setEffort={noop}
          approvalMode="review" setApprovalMode={noop} model="fixture-model" setModel={noop} messages={messages} setMessages={setMessages}
          input={input} setInput={setInput} annotations={annotations} setAnnotations={next=>{setAnnotations(next);if(window.chooseEditor)document.querySelector('#editor textarea').focus({preventScroll:true});if(window.hideAfterChange)setActive(false)}}
          onSettings={noop} onApply={()=>false} active={active} sessionId="attachments" conversationTitle="Attachments" onRunningChange={noop}/></main>
          <aside id="editor"><textarea aria-label="Editor draft" defaultValue="Keep editor selection"/><div style={{height:1400}}>Independent editor</div></aside></>}
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
    throw new Error('Unexpected fixture request: ' + path);
  });
  await page.goto('http://localhost/');
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({
    content:
      'body{overflow:auto;min-height:1400px}#root{display:flex;gap:32px;padding:12px}main{width:448px;height:760px}main>.chat-panel{height:100%}#editor{width:400px;height:760px;overflow:auto}',
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const input = page.getByRole('textbox', { name: 'Message your agent', exact: true });
  const editor = page.getByRole('textbox', { name: 'Editor draft', exact: true });
  const tray = page.getByLabel('Pending annotations', { exact: true });
  const remove = () => tray.getByRole('button', { name: /^Remove annotation / });
  await tray.waitFor();
  const original = await input.inputValue();
  await input.evaluate((element) => {
    element.focus({ preventScroll: true });
    element.setSelectionRange(4, 9);
  });
  await page.locator('.chat-scroll').evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  await page.evaluate(() => {
    window.scrollTo(0, 60);
    document.querySelector('#editor').scrollTop = 85;
  });
  const pose = () =>
    page.evaluate(() => [
      scrollY,
      document.querySelector('#editor').scrollTop,
      document.querySelector('.chat-scroll').scrollTop,
    ]);
  const originalPose = await pose();

  await input.dispatchEvent('compositionstart');
  for (const button of [
    remove().first(),
    tray.getByRole('button', { name: 'Preview annotation 1', exact: true }),
  ]) {
    await button.click();
    assert.equal(await remove().count(), 4);
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await input.evaluate((element) => element === document.activeElement), true);
    assert.equal(await input.inputValue(), original);
  }
  await input.dispatchEvent('compositionend');
  const preview = tray.getByRole('button', { name: 'Preview annotation 1', exact: true });
  await preview.evaluate((element) => element.focus({ preventScroll: true }));
  await preview.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Edit annotation', exact: true });
  await dialog.waitFor();
  const comment = dialog.getByRole('textbox', { name: 'Annotation comment', exact: true });
  await comment.fill('Unapplied comment draft');
  await comment.dispatchEvent('compositionstart');
  await comment.press('Enter');
  assert.equal(
    await page.evaluate(() => window.attachmentFixture.annotations[0].comment),
    'Capture 1: keep the original screenshot and Ω, µH parameters.',
  );
  await comment.dispatchEvent('compositionend');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await preview.evaluate((element) => element === document.activeElement), true);
  await remove()
    .first()
    .evaluate((element) => element.focus({ preventScroll: true }));
  assert.equal(
    await remove()
      .first()
      .evaluate((element) =>
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
  const nextId = await page.evaluate(() => window.attachmentFixture.annotations[1].id);
  await remove().first().press('Enter');
  assert.equal(await remove().count(), 3);
  assert.equal(await page.evaluate(() => window.attachmentFixture.annotations[0].id), nextId);
  assert.equal(
    await remove()
      .first()
      .evaluate((element) => element === document.activeElement),
    true,
  );

  await remove()
    .last()
    .evaluate((element) => element.focus({ preventScroll: true }));
  await remove().last().press('Enter');
  assert.equal(await remove().count(), 2);
  assert.equal(
    await remove()
      .last()
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.keyboard.press('Enter');
  assert.equal(await remove().count(), 1);
  assert.equal(
    await remove()
      .first()
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.keyboard.press('Enter');
  assert.equal(await tray.count(), 0);
  assert.equal(await input.evaluate((element) => element === document.activeElement), true);
  assert.equal(await input.inputValue(), original);
  assert.deepEqual(
    await input.evaluate((element) => [element.selectionStart, element.selectionEnd]),
    [4, 9],
  );
  assert.deepEqual(await pose(), originalPose);

  // A later focus choice inside the callback takes precedence over removal recovery.
  await page.evaluate(() => {
    window.setCaptures(window.attachmentFixture.captures.slice(0, 3));
    window.chooseEditor = true;
  });
  await tray.waitFor();
  await remove()
    .first()
    .evaluate((element) => element.focus({ preventScroll: true }));
  await remove().first().press('Enter');
  assert.equal(await remove().count(), 2);
  assert.equal(await editor.evaluate((element) => element === document.activeElement), true);
  await page.evaluate(() => {
    window.chooseEditor = false;
    window.hideAfterChange = true;
    window.setCaptures(window.attachmentFixture.captures.slice(0, 3));
  });
  await waitForAsync(page, () => window.attachmentFixture.annotations.length === 3);
  await remove()
    .first()
    .evaluate((element) => element.focus({ preventScroll: true }));
  await remove().first().press('Enter');
  await page.locator('.chat-panel[hidden]').waitFor({ state: 'attached' });
  await editor.evaluate((element) => element.focus({ preventScroll: true }));
  await page.evaluate(() => {
    window.hideAfterChange = false;
    window.setCaptures(window.attachmentFixture.captures.slice(0, 1));
  });
  await page.evaluate(() => window.setChatVisible(true));
  await tray.waitFor();
  assert.equal(await editor.evaluate((element) => element === document.activeElement), true);

  // Large type makes the four rows scroll, while remove targets stay visible inside the tray.
  await page.evaluate(() => {
    window.setCaptures(window.attachmentFixture.captures);
    document.documentElement.style.setProperty('--font-step', '4px');
    document.querySelector('main').style.setProperty('--chat-width', '328px');
    document.querySelector('main').style.width = '328px';
  });
  await waitForAsync(
    page,
    () =>
      document.querySelector('.annotation-attachments-pending').scrollHeight >
      document.querySelector('.annotation-attachments-pending').clientHeight,
  );
  await remove()
    .last()
    .evaluate((element) => element.focus({ preventScroll: true }));
  await remove().last().press('Enter');
  assert.equal(
    await remove()
      .last()
      .evaluate((element) => element === document.activeElement),
    true,
  );
  assert.equal(
    await remove()
      .last()
      .evaluate((element) => {
        const row = element.getBoundingClientRect(),
          viewport = element.closest('.annotation-attachments-pending').getBoundingClientRect();
        return row.top >= viewport.top - 1 && row.bottom <= viewport.bottom + 1;
      }),
    true,
  );
  await mkdir('test-results/agent-attachments', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    assert.ok((await page.locator('.chat-panel').boundingBox()).width <= 328);
    await page
      .locator('main')
      .screenshot({ path: `test-results/agent-attachments/${theme}-328.png` });
  }
  assert.deepEqual(errors, []);
  console.log(
    'Agent attachment tray passed: removal focus, retained draft/caret/viewports, newer choices, hidden views, IME pointer/keyboard and narrow large-type scrolling.',
  );
} finally {
  await browser.close();
}
