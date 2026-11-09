// Actual deferred AgentResponse and message actions; clipboard writes are controlled.
// No Electron, provider, service, native clipboard reads or design files.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { waitForAsync } from './async-browser-test-helpers.mjs';

const bundle = await build({
  stdin: {
    resolveDir: process.cwd(),
    loader: 'tsx',
    contents: `import React,{useState} from 'react';import{createRoot}from'react-dom/client';
      import Response from './components/AgentResponse';import Actions from './components/AgentMessageActions';
      function Fixture(){const[text,setText]=useState('Ready.'),[active,setActive]=useState(true);window.setReply=setText;window.setVisible=setActive;window.reply=text;
        return <article className="message assistant" data-latest-response hidden={!active}><Response text={text} active={active}/><Actions text={text} role="assistant"/></article>}
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
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent('<div class="chat-panel"><div id="root"></div></div>');
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({
    content:
      'html,body{height:auto;overflow:auto}.chat-panel{width:100%;max-width:640px;padding:16px;margin:auto}',
  });
  await page.evaluate(() => {
    window.copyWrites = [];
    window.copyCalls = 0;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.copyCalls++;
          if (window.holdCopy)
            await new Promise((resolve) => {
              window.releaseCopy = resolve;
            });
          if (window.failCopy) throw new Error('Controlled clipboard failure');
          window.copyWrites.push(text);
        },
      },
    });
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const setReply = (text) => page.evaluate((text) => window.setReply(text), text);
  const code = 'R1 out fb 55.3k\n\n* Ω \\(V_{OUT}\\) <script>literal</script>\n';
  const codeReply = (text) =>
    'Feedback example.\n\n```spice\n' + text + '```\n\nInline `R1` stays inline.';
  const reply = codeReply(code);
  await setReply(reply);
  const first = page.getByRole('group', { name: 'spice block', exact: true });
  await first.waitFor();
  assert.equal(await page.getByRole('button', { name: 'Copy code', exact: true }).count(), 1);
  const copy = first.getByRole('button', { name: 'Copy code', exact: true });
  await copy.focus();
  await copy.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.equal(await page.evaluate(() => window.copyCalls), 0);
  await copy.press('Enter');
  await first.getByText('Copied', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.copyWrites.at(-1)), code);
  assert.equal(await first.locator('script').count(), 0);
  assert.equal(await first.locator('.katex').count(), 0);
  const numberedLines = first.locator('.agent-code-line-number');
  assert.deepEqual(
    await numberedLines.evaluateAll((lines) => lines.map((line) => line.dataset.line)),
    ['1', '2', '3'],
  );
  assert.equal(await first.locator('pre').textContent(), code);
  const selectedCode = await first.locator('pre').evaluate((element) => {
    const range = document.createRange();
    const selection = window.getSelection();
    const readSelection = (target) => {
      range.selectNodeContents(target);
      selection.removeAllRanges();
      selection.addRange(range);
      const selected = selection.toString();
      selection.removeAllRanges();
      return selected;
    };
    const plain = document.createElement('pre');
    const literal = document.createElement('code');
    literal.textContent = element.textContent;
    plain.append(literal);
    element.after(plain);
    const raw = readSelection(plain);
    plain.remove();
    return { numbered: readSelection(element), raw };
  });
  assert.equal(selectedCode.numbered, selectedCode.raw);

  const secondCode = 'const voltage = 8;\n';
  await setReply(reply + '\n\n```js\n' + secondCode + '```');
  const second = page.getByRole('group', { name: 'js block', exact: true });
  const copySecond = second.getByRole('button', { name: 'Copy code', exact: true });
  const wrap = first.getByRole('button', { name: 'Wrap code', exact: true });
  const secondWrap = second.getByRole('button', { name: 'Wrap code', exact: true });
  await wrap.focus();
  await wrap.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.equal(await wrap.getAttribute('aria-pressed'), 'false');
  await wrap.press('Enter');
  assert.equal(await wrap.getAttribute('aria-pressed'), 'true');
  assert.equal(await secondWrap.getAttribute('aria-pressed'), 'false');
  await wrap.press('Space');
  assert.equal(await wrap.getAttribute('aria-pressed'), 'false');
  await page.evaluate(() => {
    window.failCopy = true;
  });
  await copySecond.click();
  await second.getByText('Could not copy. Try again.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.copyWrites.length), 1);
  await page.evaluate(() => {
    window.failCopy = false;
  });
  await copySecond.click();
  await second.getByText('Copied', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.copyWrites.at(-1)), secondCode);

  // A write captures the text at the click; streaming updates cannot claim that new text was copied.
  await page.evaluate(() => {
    window.holdCopy = true;
  });
  await copy.click();
  await first.locator('.copy-action[data-state="copying"]').waitFor();
  assert.equal(
    await copy.evaluate((element) => element === document.activeElement),
    true,
    'A pending clipboard write must retain its activated keyboard target.',
  );
  await first.getByText('Copying…', { exact: true }).waitFor();
  assert.equal(await copy.getAttribute('aria-busy'), 'true');
  await mkdir('test-results/agent-code', { recursive: true });
  await page.setViewportSize({ width: 328, height: 900 });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await waitForAsync(page, () => {
      const button = document.querySelector('.agent-code-block .copy-action > button');
      return getComputedStyle(button).color === getComputedStyle(button.parentElement).color;
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      true,
    );
    await first.screenshot({ path: `test-results/agent-code/copying-${theme}-328.png` });
  }
  await page.setViewportSize({ width: 760, height: 900 });
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
  const pendingCalls = await page.evaluate(() => window.copyCalls);
  await copy.press('Enter');
  await copy.press('Space');
  assert.equal(
    await page.evaluate(() => window.copyCalls),
    pendingCalls,
    'A focused busy copy control ignores repeated keyboard activations.',
  );
  const changed = code + 'C1 out 0 10u\n';
  await setReply(codeReply(changed));
  assert.equal(await copy.isDisabled(), true);
  await copy.evaluate((button) => {
    button.click();
    button.click();
  });
  await wrap.focus();
  await page.evaluate(() => {
    window.holdCopy = false;
    window.releaseCopy();
  });
  await first.locator('.copy-action[data-state="idle"]').waitFor();
  assert.equal(
    await wrap.evaluate((element) => element === document.activeElement),
    true,
    'A completed clipboard write cannot reclaim focus after the user moves elsewhere.',
  );
  assert.equal(await first.getByText('Copied', { exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.copyWrites.at(-1)), code);
  await copy.click();
  await first.getByText('Copied', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.copyWrites.at(-1)), changed);

  // Delayed clipboard rejection keeps the same keyboard target ready for an explicit retry.
  await page.evaluate(() => {
    window.holdCopy = true;
    window.failCopy = true;
  });
  await copy.click();
  await first.getByText('Copying…', { exact: true }).waitFor();
  await page.evaluate(() => {
    window.holdCopy = false;
    window.releaseCopy();
  });
  await first.getByText('Could not copy. Try again.', { exact: true }).waitFor();
  assert.equal(await copy.evaluate((element) => element === document.activeElement), true);
  assert.equal(await copy.getAttribute('aria-busy'), null);
  await page.evaluate(() => {
    window.failCopy = false;
  });
  await copy.press('Enter');
  await first.getByText('Copied', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.copyWrites.at(-1)), changed);

  const longCode = 'R1 ' + 'node_'.repeat(200) + ' 0 1k\n' + 'C1 out 0 10u\n'.repeat(100);
  await setReply(codeReply(longCode));
  await wrap.click();
  await copy.click();
  await first.getByText('Copied', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.copyWrites.at(-1)), longCode);
  assert.equal(await first.locator('pre').textContent(), longCode);
  await wrap.click();
  await first.locator('pre').focus();
  await first.locator('pre').press('ArrowRight');
  await waitForAsync(page, () => document.querySelector('.agent-code-block pre').scrollLeft > 0);
  assert.ok(
    await numberedLines
      .first()
      .evaluate(
        (line) =>
          Math.abs(
            line.getBoundingClientRect().left - line.closest('pre').getBoundingClientRect().left,
          ) < 1,
      ),
  );
  await first.locator('pre').evaluate((element) => {
    element.scrollLeft = 80;
    element.addEventListener(
      'keydown',
      () => {
        window.lineOriginAtKey = element.scrollLeft;
      },
      { capture: true, once: true },
    );
  });
  const codeViewport = first.locator('pre');
  const goDialog = page.getByRole('dialog', { name: 'Go to line', exact: true });
  const lineInput = goDialog.getByRole('textbox', { name: 'Line number', exact: true });
  const jump = goDialog.getByRole('button', { name: 'Go to line', exact: true });
  await codeViewport.press('Control+g');
  await lineInput.waitFor();
  assert.ok(await lineInput.evaluate((element) => element === document.activeElement));
  for (const invalid of ['0', '9999', '1.5']) {
    await lineInput.fill(invalid);
    assert.equal(await lineInput.getAttribute('aria-invalid'), 'true');
    await goDialog.getByRole('status').getByText('Enter a line from 1 to 101.').waitFor();
    assert.ok(await jump.isDisabled());
    await lineInput.press('Enter');
    if (invalid === '9999') {
      await page.setViewportSize({ width: 328, height: 560 });
      assert.ok((await goDialog.boundingBox()).width <= 328);
      await goDialog.screenshot({ path: 'test-results/agent-code/go-to-line-328.png' });
      await page.setViewportSize({ width: 760, height: 900 });
    }
  }
  await lineInput.fill('64');
  await lineInput.dispatchEvent('compositionstart');
  await lineInput.press('Enter');
  await jump.click();
  assert.equal(await lineInput.inputValue(), '64');
  await lineInput.dispatchEvent('compositionend');
  await lineInput.press('Enter');
  await goDialog.waitFor({ state: 'detached' });
  const located = first.locator('.agent-code-line[data-located]');
  assert.equal(await located.locator('[data-line]').getAttribute('data-line'), '64');
  const jumped = await located.evaluate((row) => {
    const pre = row.closest('pre');
    return {
      focused: document.activeElement === pre,
      left: pre.scrollLeft,
      top: pre.scrollTop,
      offset: row.getBoundingClientRect().top - pre.getBoundingClientRect().top,
    };
  });
  assert.ok(jumped.focused && jumped.offset >= -1 && jumped.offset < 2, JSON.stringify(jumped));
  assert.equal(jumped.left, await page.evaluate(() => window.lineOriginAtKey));
  await first.getByRole('button', { name: 'Go to line', exact: true }).click();
  await lineInput.waitFor();
  await page.evaluate(() => window.setVisible(false));
  await goDialog.waitFor({ state: 'detached' });
  await page.evaluate(() => window.setVisible(true));
  await codeViewport.waitFor();
  assert.equal(await goDialog.count(), 0);
  const collapse = first.getByRole('button', { name: 'Collapse code', exact: true });
  const expand = first.getByRole('button', { name: 'Expand code', exact: true });
  const collapsePose = await codeViewport.evaluate((element) => {
    element.scrollTop = 120;
    element.scrollLeft = 80;
    window.collapsingReader = element;
    return [element.scrollTop, element.scrollLeft];
  });
  assert.equal(await collapse.getAttribute('aria-controls'), await codeViewport.getAttribute('id'));
  await collapse.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.ok(await codeViewport.isVisible());
  await collapse.press('Enter');
  await codeViewport.waitFor({ state: 'hidden' });
  await first.getByText('101 lines', { exact: true }).waitFor();
  assert.equal(await expand.getAttribute('aria-expanded'), 'false');
  assert.ok(await wrap.isDisabled());
  assert.ok(await first.getByRole('button', { name: 'Go to line', exact: true }).isDisabled());
  await copy.click();
  assert.equal(await page.evaluate(() => window.copyWrites.at(-1)), longCode);
  await page.evaluate(() => window.setVisible(false));
  await page.locator('.agent-code-disclosure').evaluate((element) => element.click());
  await page.evaluate(() => window.setVisible(true));
  await expand.waitFor();
  assert.equal(await codeViewport.evaluate((element) => element === window.collapsingReader), true);
  assert.equal(await codeViewport.textContent(), longCode);
  await page.setViewportSize({ width: 328, height: 560 });
  await first.screenshot({ path: 'test-results/agent-code/collapsed-328.png' });
  await page.setViewportSize({ width: 760, height: 900 });
  await expand.press('Space');
  await codeViewport.waitFor();
  assert.deepEqual(
    await codeViewport.evaluate((element) => [element.scrollTop, element.scrollLeft]),
    collapsePose,
  );
  assert.ok(await collapse.evaluate((element) => document.activeElement === element));
  await codeViewport.evaluate((element) => {
    element.scrollTop = 0;
    element.scrollLeft = 0;
  });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [760, 328]) {
      await page.setViewportSize({ width, height: 900 });
      const bounds = await first.locator('pre').evaluate((element) => ({
        height: element.clientHeight,
        scrollHeight: element.scrollHeight,
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        containment: getComputedStyle(element).overscrollBehaviorY,
      }));
      assert.ok(bounds.height <= 360);
      assert.ok(bounds.scrollHeight > bounds.height);
      assert.ok(bounds.scrollWidth > bounds.width);
      assert.equal(bounds.containment, 'contain');
      await waitForAsync(page, () => {
        const block = document.querySelector('.agent-code-block');
        return getComputedStyle(block, '::after').opacity === '1';
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        true,
      );
      await page.screenshot({
        path: `test-results/agent-code/${theme}-${width}.png`,
        fullPage: true,
      });
      await wrap.click();
      const wrapped = await first.locator('pre').evaluate((element) => ({
        height: element.clientHeight,
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        whiteSpace: getComputedStyle(element).whiteSpace,
        literal: element.textContent,
      }));
      assert.ok(wrapped.height <= 360);
      assert.ok(wrapped.scrollWidth <= wrapped.width + 1, 'Even unbroken identifiers wrap.');
      assert.equal(wrapped.whiteSpace, 'pre-wrap');
      await waitForAsync(page, () => {
        const block = document.querySelector('.agent-code-block');
        return (
          getComputedStyle(block, '::before').opacity === '0' &&
          getComputedStyle(block, '::after').opacity === '0'
        );
      });
      assert.ok(
        await numberedLines.first().evaluate((line) => {
          const row = line.parentElement.getBoundingClientRect();
          return (
            row.height > parseFloat(getComputedStyle(line).lineHeight) &&
            Math.abs(line.getBoundingClientRect().height - row.height) < 1
          );
        }),
      );
      assert.equal(
        wrapped.literal,
        longCode,
        'Wrapping changes layout without inserting newlines.',
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        true,
      );
      await page.screenshot({
        path: `test-results/agent-code/${theme}-${width}-wrapped.png`,
        fullPage: true,
      });
      await wrap.click();
    }
  }
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--font-step', '4px');
  });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    true,
  );
  await first.locator('pre').evaluate((element) => {
    element.scrollTop = 120;
    element.scrollLeft = 80;
    window.retainedCodeNode = element;
  });
  const retainedScroll = await first
    .locator('pre')
    .evaluate((element) => [element.scrollTop, element.scrollLeft]);
  await page.evaluate(() => window.setVisible(false));
  await page.locator('article[hidden]').waitFor({ state: 'attached' });
  const latestCode = longCode + 'C2 hidden 0 22u\n';
  await setReply(codeReply(latestCode));
  await waitForAsync(page, (text) => window.reply === text, codeReply(latestCode));
  assert.equal(
    await page.evaluate(() => window.retainedCodeNode.textContent),
    longCode,
    'Background text updates cannot replace mounted hidden code presentation.',
  );
  await page.evaluate(() => window.setVisible(true));
  await first.waitFor();
  await waitForAsync(
    page,
    (text) => document.querySelector('.agent-code-block pre').textContent === text,
    latestCode,
  );
  assert.equal(
    await page.evaluate(
      () => window.retainedCodeNode === document.querySelector('.agent-code-block pre'),
    ),
    true,
  );
  assert.deepEqual(
    await first.locator('pre').evaluate((element) => [element.scrollTop, element.scrollLeft]),
    retainedScroll,
  );
  await page.evaluate(() => {
    delete window.retainedCodeNode;
  });

  // Wrapping belongs to each mounted code block, including across hidden stream updates.
  await wrap.click();
  await first.locator('pre').evaluate((element) => {
    element.scrollTop = 220;
  });
  await page.evaluate(() => window.setVisible(false));
  await page.locator('article[hidden]').waitFor({ state: 'attached' });
  await page.evaluate(() => document.querySelector('.agent-code-actions > button').click());
  assert.equal(
    await page.evaluate(() =>
      document.querySelector('.agent-code-actions > button').getAttribute('aria-pressed'),
    ),
    'true',
    'A hidden Wrap activation cannot replace either retained reading position with zero-size measurements.',
  );
  const wrappedLatest = latestCode + 'C3 hidden 0 47u\n';
  await setReply(codeReply(wrappedLatest));
  await waitForAsync(page, (text) => window.reply === text, codeReply(wrappedLatest));
  await page.evaluate(() => window.setVisible(true));
  await waitForAsync(
    page,
    (text) => document.querySelector('.agent-code-block pre').textContent === text,
    wrappedLatest,
  );
  assert.equal(await wrap.getAttribute('aria-pressed'), 'true');
  assert.equal(await first.locator('pre').evaluate((element) => element.scrollTop), 220);
  await wrap.press('Enter');
  assert.deepEqual(
    await first.locator('pre').evaluate((element) => [element.scrollTop, element.scrollLeft]),
    retainedScroll,
    'Returning to unwrapped code restores its earlier row and horizontal reading position.',
  );
  await wrap.press('Space');
  assert.equal(await first.locator('pre').evaluate((element) => element.scrollTop), 220);
  await setReply(codeReply('R1 out 0 1k\n'));
  await waitForAsync(
    page,
    () => document.querySelector('.agent-code-block pre').textContent === 'R1 out 0 1k\n',
  );
  await wrap.click();
  assert.deepEqual(
    await first.locator('pre').evaluate((element) => [element.scrollTop, element.scrollLeft]),
    [0, 0],
    'Restoring a reading position clamps to the current code bounds after the source shrinks.',
  );
  await wrap.click();

  // Feedback grows away from the toolbar's fixed pointer/keyboard targets.
  await setReply(codeReply(wrappedLatest + '* Copy layout checkpoint.\n'));
  await page.setViewportSize({ width: 328, height: 900 });
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--font-step', '4px');
    window.holdCopy = true;
  });
  const idleActionX = [(await wrap.boundingBox()).x, (await copy.boundingBox()).x];
  await copy.click();
  await first.getByText('Copying…', { exact: true }).waitFor();
  assert.deepEqual(
    [(await wrap.boundingBox()).x, (await copy.boundingBox()).x],
    idleActionX,
    'Pending copy feedback cannot displace either code toolbar target.',
  );
  await page.evaluate(() => {
    window.holdCopy = false;
    window.failCopy = true;
    window.releaseCopy();
  });
  await first.getByText('Could not copy. Try again.', { exact: true }).waitFor();
  assert.deepEqual(
    [(await wrap.boundingBox()).x, (await copy.boundingBox()).x],
    idleActionX,
    'Retry feedback cannot displace the code toolbar targets at narrow large type.',
  );
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
      true,
    );
    await first.screenshot({ path: `test-results/agent-code/retry-${theme}-328.png` });
  }
  await page.evaluate(() => {
    window.failCopy = false;
  });
  await copy.press('Enter');
  await first.getByText('Copied', { exact: true }).waitFor();
  assert.deepEqual([(await wrap.boundingBox()).x, (await copy.boundingBox()).x], idleActionX);
  await page.evaluate(() => document.documentElement.style.removeProperty('--font-step'));

  // Removing a block while the browser write is pending must not leave a late success state.
  await page.evaluate(() => {
    window.holdCopy = true;
  });
  await copy.click();
  await first.locator('.copy-action[data-state="copying"]').waitFor();
  await setReply('No code remains.');
  await page.getByText('No code remains.', { exact: true }).waitFor();
  await first.waitFor({ state: 'detached' });
  await page.evaluate(() => {
    window.holdCopy = false;
    window.releaseCopy();
  });
  assert.equal(await page.getByRole('button', { name: 'Copy code', exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Copy response', exact: true }).count(), 1);
  const unnumberedCode = 'R1 out 0 1k\n'.repeat(2001);
  await setReply(codeReply(unnumberedCode));
  await first.waitFor();
  assert.equal(await numberedLines.count(), 0);
  assert.equal(await first.getByRole('button', { name: 'Go to line', exact: true }).count(), 0);
  assert.equal(await first.locator('pre').textContent(), unnumberedCode);
  await copy.click();
  await first.getByText('Copied', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.copyWrites.at(-1)), unnumberedCode);
  assert.deepEqual(errors, []);
  console.log(
    'Agent code UI passed: logical line numbers, native selection, per-block wrapping, literal copies, keyboard/IME, retry, streaming identity and bounded scrolling.',
  );
} finally {
  await browser.close();
}
