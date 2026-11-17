// Actual queue/dialog/annotation components; no provider, Electron or design writes.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { waitForAsync } from './async-browser-test-helpers.mjs';

const bundle = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `import React,{useRef,useState}from'react';import{createRoot}from'react-dom/client';
      import Queue from './components/AgentMessageQueue';import{annotationFixture}from'./tests/fixtures/annotation';
      const text='Preserve Ω, µH, **literal text** and <script>plain</script>.\\n'.repeat(60)+'Final requirement.';
      function Fixture(){const[items,setItems]=useState([{id:'one',text,annotations:[annotationFixture()],sameAgent:true}]),[active,setActive]=useState(true),input=useRef(null);
        window.entries=items;window.operations=[];window.setQueueActive=setActive;window.consumeQueue=()=>setItems([]);
        window.resetQueue=(annotationOnly=false)=>setItems([{id:'new',text:annotationOnly?'':text,annotations:[annotationFixture()],sameAgent:true}]);
        window.mutateCapture=()=>{items[0].annotations[0].comment='Changed outside preview';setItems([...items])};
        return <><main className="chat-panel" hidden={!active}><Queue items={items} active={active} paused={false} busy canSteer submitting={false} canEdit={false}
          onResume={()=>window.operations.push('resume')} onSteer={()=>window.operations.push('steer')} onEdit={()=>window.operations.push('edit')} onRemove={()=>window.operations.push('remove')} onFirst={()=>window.operations.push('first')} onFocusInput={()=>input.current?.focus({preventScroll:true})}/>
          <textarea ref={input} aria-label="Retained composer" defaultValue="Keep this next draft Ω."/></main><aside id="editor"><textarea aria-label="Editor draft" defaultValue="Keep editor selection"/><div style={{height:1600}}/></aside></>}
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
  await page.route('http://localhost/', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await page.goto('http://localhost/');
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({
    content:
      'html,body{height:auto;overflow:auto;min-height:1500px}#root{display:flex;gap:24px;padding:60px 12px 12px}main{width:448px;height:600px}#editor{width:400px;height:600px;overflow:auto}',
  });
  await page.evaluate(() => {
    window.copies = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text) => window.copies.push(text) },
    });
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const input = page.getByRole('textbox', { name: 'Retained composer', exact: true });
  const editor = page.getByRole('textbox', { name: 'Editor draft', exact: true });
  const preview = page.getByRole('button', { name: 'Preview queued message', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Queued message', exact: true });
  const body = dialog.getByRole('region', { name: 'Queued message text', exact: true });
  await preview.waitFor().catch((error) => {
    throw new Error(`${error.message}\n${errors.join('\n')}`);
  });
  const original = await page.evaluate(() => structuredClone(window.entries[0]));
  await input.evaluate((element) => {
    element.focus({ preventScroll: true });
    element.setSelectionRange(3, 8);
  });
  await page.evaluate(() => {
    window.scrollTo(0, 30);
    document.querySelector('#editor').scrollTop = 80;
  });
  const pose = await page.evaluate(() => [scrollY, document.querySelector('#editor').scrollTop]);
  await preview.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.equal(await dialog.count(), 0);
  await preview.press('Enter');
  await dialog.waitFor();
  assert.equal(await body.textContent(), original.text);
  assert.equal(await body.locator('script,strong').count(), 0);
  assert.equal(await body.evaluate((element) => element === document.activeElement), true);
  await body.press('End');
  await waitForAsync(page, () => document.querySelector('.agent-queue-preview-text').scrollTop > 0);
  await dialog.getByRole('button', { name: 'Copy queued message', exact: true }).click();
  assert.equal(await page.evaluate(() => window.copies.at(-1)), original.text);
  await page.evaluate(() => window.mutateCapture());
  assert.equal(
    await dialog.locator('.annotation-attachment-preview img').getAttribute('src'),
    original.annotations[0].image.dataUrl,
  );
  await dialog.getByRole('button', { name: 'Preview annotation 1', exact: true }).click();
  const annotation = page.getByRole('dialog', { name: 'Annotation', exact: true });
  await annotation.waitFor();
  assert.equal(
    await annotation.locator('.annotation-comment').textContent(),
    original.annotations[0].comment,
  );
  await page.keyboard.press('Escape');
  await annotation.waitFor({ state: 'hidden' });
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await preview.evaluate((element) => element === document.activeElement), true);
  assert.deepEqual(
    await input.evaluate((element) => [
      element.value,
      element.selectionStart,
      element.selectionEnd,
    ]),
    ['Keep this next draft Ω.', 3, 8],
  );
  assert.deepEqual(
    await page.evaluate(() => [scrollY, document.querySelector('#editor').scrollTop]),
    pose,
  );
  await preview.click();
  await page.evaluate(() => window.consumeQueue());
  await dialog.getByText('No longer queued', { exact: true }).waitFor();
  assert.equal(await body.textContent(), original.text);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await input.evaluate((element) => element === document.activeElement), true);
  assert.deepEqual(
    await input.evaluate((element) => [element.selectionStart, element.selectionEnd]),
    [3, 8],
  );
  await page.evaluate(() => window.resetQueue());
  await preview.click();
  await page.evaluate(() => window.setQueueActive(false));
  await dialog.waitFor({ state: 'hidden' });
  await editor.evaluate((element) => element.focus({ preventScroll: true }));
  await page.evaluate(() => window.setQueueActive(true));
  await preview.waitFor();
  assert.equal(await dialog.count(), 0);
  assert.equal(await editor.evaluate((element) => element === document.activeElement), true);
  await preview.click();
  await mkdir('test-results/agent-queue-preview', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: 328, height: 900 });
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.setProperty('--font-step', '4px');
    }, theme);
    assert.ok((await dialog.boundingBox()).width <= 328);
    assert.equal(
      await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      true,
    );
    await dialog.screenshot({ path: 'test-results/agent-queue-preview/' + theme + '-328.png' });
  }
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await page.evaluate(() => window.resetQueue(true));
  await preview.click();
  assert.equal(await body.count(), 0);
  assert.equal(
    await dialog.getByRole('button', { name: 'Copy queued message', exact: true }).count(),
    0,
  );
  await dialog.getByRole('button', { name: 'Preview annotation 1', exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.operations), []);
  assert.deepEqual(errors, []);
  console.log(
    'Queued message preview passed: literal text/copy, independent captured annotations, nested viewing, retained draft/caret/viewports, removal focus, hidden cancellation and narrow themes.',
  );
} finally {
  await browser.close();
}
