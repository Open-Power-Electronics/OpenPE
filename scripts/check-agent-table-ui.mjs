// Actual deferred Markdown/table presentation; controlled clipboard and no native/provider access.
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
  await page.setContent('<main class="chat-panel"><div id="root"></div></main>');
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
  const firstTable =
    '| Part | Value | Notes |\n| :--- | ---: | --- |\n| **R1** | 5 Ω | $V_{OUT}$ and `a\\|b` |';
  const secondTable = '| Controller | Supply |\n| --- | --- |\n| LM2596 | 12 V |';
  const reserved = '```openpe_session\n{"title":"Reserved title"}\n```\n\n';
  await setReply(
    reserved + 'Component summary.\n\n' + firstTable + '\n\nSecond table:\n\n' + secondTable,
  );
  const tables = page.getByRole('region', { name: 'Response table', exact: true });
  const copies = page.getByRole('button', { name: 'Copy table as Markdown', exact: true });
  const freezes = page.getByRole('button', { name: 'Freeze first column', exact: true });
  await copies.nth(1).waitFor();
  await tables.first().locator('.katex').waitFor();
  assert.equal(
    await tables
      .first()
      .getByRole('columnheader', { name: 'Value' })
      .evaluate((element) => getComputedStyle(element).textAlign),
    'right',
  );
  await copies.first().focus();
  await copies.first().dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.equal(await page.evaluate(() => window.copies.length), 0);
  const idleCopyX = (await copies.first().boundingBox()).x;
  const idleFreezeX = (await freezes.first().boundingBox()).x;
  await copies.first().press('Enter');
  await waitForAsync(page, () => window.copies.length === 1);
  assert.equal(
    (await copies.first().boundingBox()).x,
    idleCopyX,
    'Table copy feedback grows away from its fixed action target.',
  );
  assert.equal(await page.evaluate(() => window.copies.at(-1)), firstTable);
  assert.equal((await freezes.first().boundingBox()).x, idleFreezeX);
  await freezes.first().dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.equal(await freezes.first().getAttribute('aria-pressed'), 'false');
  await freezes.first().press('Enter');
  assert.equal(await freezes.first().getAttribute('aria-pressed'), 'true');
  assert.equal(await freezes.nth(1).getAttribute('aria-pressed'), 'false');
  await copies.nth(1).click();
  assert.equal(await page.evaluate(() => window.copies.at(-1)), secondTable);
  assert.doesNotMatch(await page.locator('article').innerText(), /Reserved title|openpe_session/);

  // A streamed row changes only its own copy source, not the other table's feedback.
  const updated = firstTable + '\n| C1 | 10 µF | Feedback |';
  await setReply(
    'A longer introduction changes every parser offset.\n\n' + updated + '\n\n' + secondTable,
  );
  await tables.first().getByRole('cell', { name: 'C1', exact: true }).waitFor();
  await copies.first().click();
  assert.equal(await page.evaluate(() => window.copies.at(-1)), updated);
  await page.evaluate(() => {
    window.holdCopy = true;
  });
  await copies.first().click();
  await waitForAsync(page, () => typeof window.releaseCopy === 'function');
  const latest = updated + '\n| L1 | 100 µH | Output filter |';
  await setReply(latest);
  await tables.first().getByRole('cell', { name: 'L1', exact: true }).waitFor();
  await page.evaluate(() => {
    window.holdCopy = false;
    window.releaseCopy();
  });
  await page.locator('.agent-table-actions .copy-action[data-state="idle"]').waitFor();
  assert.equal(await page.evaluate(() => window.copies.at(-1)), updated);

  const header =
    '| Part | Value | Voltage | Current | Tolerance | Notes |\n| --- | ---: | --- | --- | --- | --- |';
  const longTable =
    header +
    '\n' +
    Array.from(
      { length: 60 },
      (_, index) =>
        `| ${index === 0 ? 'LongReference'.repeat(10) : `R${index + 1}`} | ${index + 1} kΩ | 24 V | 1 A | 1% | Parameter selection ${index + 1} |`,
    ).join('\n');
  await setReply(longTable + '\n\n' + secondTable);
  await tables
    .first()
    .getByRole('cell', { name: 'R60', exact: true })
    .waitFor({ state: 'attached' });
  const region = tables.first();
  await mkdir('test-results/agent-table', { recursive: true });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [760, 328]) {
      await page.setViewportSize({ width, height: 900 });
      await region.evaluate((element) => {
        element.scrollTop = 150;
      });
      const bounds = await region.evaluate((element) => ({
        height: element.clientHeight,
        scrollHeight: element.scrollHeight,
        width: element.clientWidth,
        scrollWidth: element.scrollWidth,
        top: element.getBoundingClientRect().top,
        headerTop: element.querySelector('th').getBoundingClientRect().top,
        containment: getComputedStyle(element).overscrollBehavior,
      }));
      assert.ok(bounds.height <= 360 && bounds.scrollHeight > bounds.height);
      assert.ok(
        Math.abs(bounds.headerTop - bounds.top) < 2,
        'Column headings remain visible while scrolling.',
      );
      assert.equal(bounds.containment, 'contain');
      if (width === 328) {
        assert.ok(bounds.scrollWidth > bounds.width);
        const cues = async (index, left, right) =>
          waitForAsync(
            page,
            ({ index, left, right }) => {
              const block = document.querySelectorAll('.agent-table-block')[index];
              return (
                Math.abs(Number(getComputedStyle(block, '::before').opacity) - left) < 0.01 &&
                Math.abs(Number(getComputedStyle(block, '::after').opacity) - right) < 0.01
              );
            },
            { index, left, right },
          );
        await region.evaluate((element) => (element.scrollLeft = 0));
        await cues(0, 0, 1);
        await cues(1, 0, 0);
        await region.focus();
        await region.press('ArrowRight');
        await waitForAsync(page, () => document.querySelector('.message-table').scrollLeft > 0);
        if ((await freezes.first().getAttribute('aria-pressed')) !== 'true')
          await freezes.first().press('Enter');
        await region.evaluate((element) => {
          element.scrollTop = 150;
          element.scrollLeft = 120;
        });
        const frozen = await region.evaluate((element) => {
          const corner = element.querySelector('th');
          const firstCell = element.querySelector('tbody td');
          const bounds = element.getBoundingClientRect();
          return {
            cornerX: corner.getBoundingClientRect().left - bounds.left,
            cornerY: corner.getBoundingClientRect().top - bounds.top,
            cellX: firstCell.getBoundingClientRect().left - bounds.left,
            width: corner.getBoundingClientRect().width,
            top: element.scrollTop,
            left: element.scrollLeft,
          };
        });
        assert.ok(
          Math.abs(frozen.cornerX) < 2 &&
            Math.abs(frozen.cornerY) < 2 &&
            Math.abs(frozen.cellX) < 2,
          JSON.stringify(frozen),
        );
        assert.ok(frozen.width < bounds.width * 0.6, JSON.stringify(frozen));
        assert.deepEqual([frozen.top, frozen.left], [150, 120]);
        await cues(0, 1, 1);
        await region.evaluate((element) => (element.scrollLeft = element.scrollWidth));
        await cues(0, 1, 0);
        await region.evaluate((element) => (element.scrollLeft = 120));
        await cues(0, 1, 1);
      }
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
        true,
      );
      await page.screenshot({
        path: `test-results/agent-table/${theme}-${width}.png`,
        fullPage: true,
      });
    }
  }
  const retained = await region.evaluate((element) => {
    element.scrollTop = 240;
    element.scrollLeft = 80;
    window.retainedTable = element;
    return [element.scrollTop, element.scrollLeft];
  });
  await page.evaluate(() => window.setVisible(false));
  await page.locator('article[hidden]').waitFor({ state: 'attached' });
  await page
    .locator('.agent-table-freeze')
    .first()
    .evaluate((button) => button.click());
  const hiddenLatest = longTable + '\n| R61 | 61 kΩ | 24 V | 1 A | 1% | Added while hidden |';
  const hiddenReply = hiddenLatest + '\n\n' + secondTable;
  await setReply(hiddenReply);
  await waitForAsync(page, (text) => window.reply === text, hiddenReply);
  await page.evaluate(() => window.setVisible(true));
  await region.getByRole('cell', { name: 'R61', exact: true }).waitFor({ state: 'attached' });
  assert.equal(await freezes.first().getAttribute('aria-pressed'), 'true');
  assert.equal(
    await page.evaluate(() => window.retainedTable === document.querySelector('.message-table')),
    true,
  );
  assert.deepEqual(
    await region.evaluate((element) => [element.scrollTop, element.scrollLeft]),
    retained,
  );
  await copies.first().click();
  assert.equal(await page.evaluate(() => window.copies.at(-1)), hiddenLatest);
  await setReply('| Part | Value |\n| --- | --- |\n| R1 | 1 kΩ |');
  await waitForAsync(page, () => {
    const element = document.querySelector('.message-table');
    return element.scrollHeight === element.clientHeight && element.clientHeight < 120;
  });
  assert.deepEqual(errors, []);
  console.log(
    'Agent tables passed: isolated Markdown copies, formulas/alignment, keyboard/IME, streaming/hidden identity, sticky headers and bounded responsive scrolling.',
  );
} finally {
  await browser.close();
}
