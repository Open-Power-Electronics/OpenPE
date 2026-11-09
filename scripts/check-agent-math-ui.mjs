// Actual local KaTeX styles/fonts and deferred replies; no Electron, provider or native clipboard.
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
      import Response from './components/AgentResponse';
      function Fixture(){const[text,setText]=useState('Ready.'),[active,setActive]=useState(true);
        window.setReply=setText;window.setVisible=setActive;window.reply=text;
        return <article className="message assistant" hidden={!active}><Response text={text} active={active}/></article>}
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
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.route('http://localhost/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (/^\/fonts\/[A-Za-z0-9_-]+\.(woff2|woff|ttf)$/.test(pathname))
      return route.fulfill({ body: await readFile('node_modules/katex/dist' + pathname) });
    if (pathname === '/')
      return route.fulfill({
        contentType: 'text/html',
        body: '<main class="chat-panel"><div id="root"></div></main>',
      });
    throw new Error('Unexpected fixture request: ' + pathname);
  });
  await page.goto('http://localhost/');
  for (const file of [
    'node_modules/katex/dist/katex.min.css',
    'app/globals.css',
    'app/workspace.css',
  ])
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
          window.copies.push(text);
        },
      },
    });
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const setReply = (text) => page.evaluate((text) => window.setReply(text), text);
  const formula = String.raw`V_{OUT} = D V_{IN}`;
  const second = String.raw`\Delta I_L = \frac{(V_{IN}-V_{OUT})D}{L f_s}`;
  const block = (source) => '$$\n' + source + '\n$$';
  const regions = page.getByRole('region', { name: 'Formula', exact: true });
  const copies = page.getByRole('button', { name: 'Copy formula as LaTeX', exact: true });
  await setReply('Inline $V_{OUT}$ stays inline.\n\n```latex\n' + formula + '\n```');
  await page.locator('.katex').waitFor();
  assert.equal(await copies.count(), 0, 'Inline formulas and code get no formula controls.');
  await setReply(
    '```openpe_session\n{"title":"Reserved title"}\n```\n\n' +
      block(formula) +
      '\n\n' +
      block(second),
  );
  await copies.nth(1).waitFor();
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await regions.first().locator('math').count(), 1, 'MathML remains available.');
  assert.equal(await regions.first().locator('.katex-html[aria-hidden="true"]').count(), 1);
  await copies.first().focus();
  await copies.first().dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.equal(await page.evaluate(() => window.copies.length), 0);
  const idleCopyX = (await copies.first().boundingBox()).x;
  await copies.first().press('Enter');
  await waitForAsync(page, () => window.copies.length === 1);
  assert.equal(
    (await copies.first().boundingBox()).x,
    idleCopyX,
    'Formula copy feedback grows away from its fixed action target.',
  );
  assert.equal(await page.evaluate(() => window.copies.at(-1)), formula);
  await copies.nth(1).click();
  assert.equal(await page.evaluate(() => window.copies.at(-1)), second);
  assert.doesNotMatch(await page.locator('article').innerText(), /Reserved title|openpe_session/);

  await page.evaluate(() => {
    window.holdCopy = true;
  });
  await copies.first().click();
  await waitForAsync(page, () => typeof window.releaseCopy === 'function');
  const updated = formula + String.raw`\quad (0 < D < 1)`;
  await setReply(block(updated));
  await waitForAsync(
    page,
    (source) => document.querySelector('.agent-math-scroll annotation').textContent === source,
    updated,
  );
  await page.evaluate(() => {
    window.holdCopy = false;
    window.releaseCopy();
  });
  await page.locator('.agent-math-actions .copy-action[data-state="idle"]').waitFor();
  assert.equal(await page.evaluate(() => window.copies.at(-1)), formula);
  await copies.first().click();
  assert.equal(await page.evaluate(() => window.copies.at(-1)), updated);

  const wide =
    'Z = ' +
    Array.from(
      { length: 40 },
      (_, index) => String.raw`\frac{V_{${index + 1}}}{R_{${index + 1}}}`,
    ).join(' + ');
  const tall =
    '\\begin{aligned}\n' +
    Array.from({ length: 40 }, (_, index) => `V_{${index + 1}} &= ${index + 1} R I`).join(
      ' \\\\\n',
    ) +
    '\n\\end{aligned}';
  await setReply(block(wide) + '\n\n' + block(tall));
  await regions.nth(1).locator('.katex-display').waitFor();
  await page.evaluate(() => document.fonts.ready);
  await mkdir('test-results/agent-math', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [760, 328]) {
      await page.setViewportSize({ width, height: 900 });
      const bounds = await regions.first().evaluate((element) => ({
        width: element.clientWidth,
        content: element.scrollWidth,
        containment: getComputedStyle(element).overscrollBehavior,
      }));
      assert.ok(bounds.content > bounds.width);
      assert.equal(bounds.containment, 'contain');
      await regions.first().evaluate((element) => (element.scrollLeft = 0));
      await waitForAsync(page, () => {
        const block = document.querySelector('.agent-math-block');
        return getComputedStyle(block, '::after').opacity === '1';
      });
      await regions.first().focus();
      await regions.first().press('ArrowRight');
      await waitForAsync(page, () => document.querySelector('.agent-math-scroll').scrollLeft > 0);
      const vertical = await regions
        .nth(1)
        .evaluate((element) => ({ height: element.clientHeight, content: element.scrollHeight }));
      assert.ok(vertical.height <= 360 && vertical.content > vertical.height);
      await regions.nth(1).focus();
      await regions.nth(1).press('ArrowDown');
      await waitForAsync(
        page,
        () => document.querySelectorAll('.agent-math-scroll')[1].scrollTop > 0,
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        true,
      );
      await page.screenshot({
        path: `test-results/agent-math/${theme}-${width}.png`,
        fullPage: true,
      });
    }
  }
  const retained = await regions.first().evaluate((element) => {
    element.scrollLeft = 100;
    window.retainedFormula = element;
    return element.scrollLeft;
  });
  await page.evaluate(() => window.setVisible(false));
  await page.locator('article[hidden]').waitFor({ state: 'attached' });
  const hidden = wide + ' + I_0';
  await setReply(block(hidden) + '\n\n' + block(tall));
  await waitForAsync(page, (text) => window.reply === text, block(hidden) + '\n\n' + block(tall));
  await page.evaluate(() => window.setVisible(true));
  await waitForAsync(
    page,
    (source) => document.querySelector('.agent-math-scroll annotation').textContent === source,
    hidden,
  );
  assert.equal(
    await page.evaluate(
      () => window.retainedFormula === document.querySelector('.agent-math-scroll'),
    ),
    true,
  );
  assert.equal(await regions.first().evaluate((element) => element.scrollLeft), retained);
  await copies.first().click();
  assert.equal(await page.evaluate(() => window.copies.at(-1)), hidden);
  await setReply(block(String.raw`\frac{1}{`));
  await page.locator('.katex-error').waitFor();
  assert.equal(await copies.count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    'Agent math passed: literal LaTeX copies, MathML, inline/code isolation, keyboard/IME, streaming/hidden identity and bounded responsive scrolling with bundled fonts.',
  );
} finally {
  await browser.close();
}
