// Actual user message presentation and controlled clipboard; no Electron or providers.
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
      import Message from './components/AgentUserMessage';import Actions from './components/AgentMessageActions';
      function Fixture(){const[text,setText]=useState('Short literal **text**.\\n<script>not markup</script>'),[active,setActive]=useState(true);
        window.setMessage=setText;window.setVisible=setActive;
        return <section hidden={!active}>
          <article className="message user" id="first"><Message text={text} active={active}/><Actions text={text} role="user" reuseMessageId="first" onReuse={()=>{}}/></article>
          <article className="message assistant"><div className="agent-process"><div className="message-author">Codex</div></div></article>
          <article className="message user" id="second"><Message text="Independent message" active={active}/></article>
        </section>}
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
  await page.setContent(
    '<main class="chat-panel"><div id="root"></div></main><input aria-label="Editor draft" value="Keep my draft">',
  );
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
          window.copies.push(text);
        },
      },
    });
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const message = page.locator('#first');
  const content = message.locator('.agent-user-content');
  const preview = message.locator('.agent-user-preview');
  const more = message.getByRole('button', { name: 'Show more of this message', exact: true });
  const less = message.getByRole('button', { name: 'Show less of this message', exact: true });
  const copy = message.getByRole('button', { name: 'Copy message', exact: true });
  const editor = page.getByRole('textbox', { name: 'Editor draft', exact: true });
  await content.waitFor();
  assert.equal(await content.textContent(), 'Short literal **text**.\n<script>not markup</script>');
  assert.equal(await content.locator('strong,script').count(), 0);
  assert.equal(await more.count(), 0, 'Short messages do not need a disclosure.');
  await page.evaluate(() => window.setMessage('hello'));
  await message.getByText('hello', { exact: true }).waitFor();
  for (const width of [760, 328]) {
    await page.setViewportSize({ width, height: 900 });
    const bubble = await message.locator('.agent-user-message').boundingBox();
    const author = page.locator('.message.assistant .message-author');
    const reply = await author.boundingBox();
    const action = await copy.boundingBox();
    assert.ok(reply.y - (bubble.y + bubble.height) <= 16);
    assert.ok(action.x + action.width <= bubble.x && action.y >= bubble.y);
    await copy.focus();
    assert.deepEqual(
      await author.boundingBox(),
      reply,
      'Revealing actions keeps the reply in place.',
    );
  }
  await page.setViewportSize({ width: 760, height: 900 });

  const long = Array.from(
    { length: 18 },
    (_, index) => `Requirement ${index + 1}: preserve Ω, µH and **literal text**.`,
  ).join('\n');
  await page.evaluate((text) => window.setMessage(text), long);
  await more.waitFor();
  const lineHeight = await content.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).lineHeight),
  );
  assert.ok((await preview.boundingBox()).height <= lineHeight * 6 + 1);
  assert.equal(await content.textContent(), long);
  assert.equal(await more.getAttribute('aria-controls'), await content.getAttribute('id'));
  assert.equal(await page.locator('#second .agent-user-toggle').count(), 0);
  assert.notEqual(
    await content.getAttribute('id'),
    await page.locator('#second .agent-user-content').getAttribute('id'),
  );
  await copy.click();
  assert.equal(await page.evaluate(() => window.copies.at(-1)), long);
  await more.focus();
  await more.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.equal(await more.getAttribute('aria-expanded'), 'false');
  await more.press('Enter');
  assert.equal(await less.getAttribute('aria-expanded'), 'true');
  assert.ok((await preview.boundingBox()).height > lineHeight * 12);
  assert.equal(await less.evaluate((element) => element === document.activeElement), true);
  await less.press('Space');
  assert.equal(await more.getAttribute('aria-expanded'), 'false');

  // Measured line wrapping, rather than character counts, controls the preview.
  const wrappedText = 'Please review the converter feedback network. '.repeat(8);
  await page.evaluate((text) => window.setMessage(text), wrappedText);
  await more.waitFor({ state: 'hidden' });
  await editor.focus();
  await editor.evaluate((element) => element.setSelectionRange(2, 7));
  await page.setViewportSize({ width: 328, height: 900 });
  await more.waitFor();
  assert.equal(await editor.evaluate((element) => element === document.activeElement), true);
  assert.deepEqual(
    await editor.evaluate((element) => [element.selectionStart, element.selectionEnd]),
    [2, 7],
  );
  await more.focus();
  await more.press('Enter');
  await page.setViewportSize({ width: 760, height: 900 });
  await less.waitFor({ state: 'hidden' });
  assert.equal(
    await content.evaluate((element) => element === document.activeElement),
    true,
    'A disclosure removed by reflow returns its own focus without scrolling.',
  );
  await page.setViewportSize({ width: 328, height: 900 });
  await less.waitFor();

  // Hidden presentation retains the explicit choice without taking editor focus on reveal.
  await editor.focus();
  await page.evaluate(() => window.setVisible(false));
  await page.locator('section[hidden]').waitFor({ state: 'attached' });
  await page.evaluate(() => window.setVisible(true));
  await less.waitFor();
  assert.equal(await less.getAttribute('aria-expanded'), 'true');
  assert.equal(await editor.evaluate((element) => element === document.activeElement), true);
  await less.click();
  await page.evaluate(() => document.documentElement.style.setProperty('--font-step', '4px'));
  await waitForAsync(page, () => {
    const element = document.querySelector('#first .agent-user-preview');
    const text = element.firstElementChild;
    return element.clientHeight <= Number.parseFloat(getComputedStyle(text).lineHeight) * 6 + 1;
  });
  assert.equal(await content.textContent(), wrappedText);
  const reuse = message.getByRole('button', { name: 'Reuse message', exact: true });
  const idleActionX = [(await copy.boundingBox()).x, (await reuse.boundingBox()).x];
  await copy.click();
  assert.equal(await page.evaluate(() => window.copies.at(-1)), wrappedText);
  await message.getByText('Copied', { exact: true }).waitFor();
  assert.deepEqual(
    [(await copy.boundingBox()).x, (await reuse.boundingBox()).x],
    idleActionX,
    'Copy feedback cannot displace either user-message action at narrow large type.',
  );
  await mkdir('test-results/agent-message', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await waitForAsync(page, () => {
      const button = document.querySelector('#first .agent-user-toggle');
      return getComputedStyle(button).color === getComputedStyle(button.parentElement).color;
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      true,
    );
    await page.screenshot({ path: `test-results/agent-message/${theme}-328.png`, fullPage: true });
  }
  assert.deepEqual(errors, []);
  console.log(
    'Agent user messages passed: measured folding, literal copies, keyboard/IME, responsive focus, independent IDs, hidden retention and themes.',
  );
} finally {
  await browser.close();
}
