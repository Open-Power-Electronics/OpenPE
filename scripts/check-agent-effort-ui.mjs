// Actual AgentComposer/ModelSelect with isolated model catalogs and preferences.
// No Electron, installed provider, external service or solver is launched.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { waitForAsync } from './async-browser-test-helpers.mjs';

const catalogs = {
  codex: {
    defaultModel: 'fixture/full',
    models: [
      {
        id: 'fixture/full',
        label: 'Full reasoning',
        efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      },
      { id: 'fixture/three', label: 'Three levels', efforts: ['low', 'medium', 'high'] },
      { id: 'fixture/plain', label: 'No effort', efforts: [] },
      { id: 'fixture/gpt-6-astra', label: 'GPT-6-Astra', efforts: ['medium', 'high'] },
      { id: 'gpt-reserve', label: 'GPT-Reserve' },
      { id: 'codex-auto-review', label: 'Codex Auto Review' },
    ],
  },
  claude: {
    defaultModel: null,
    models: [
      {
        id: 'claude-sonnet-4-6',
        label: 'claude-sonnet-4-6',
        efforts: ['low', 'medium', 'high'],
      },
      {
        id: 'claude-haiku-4-5-20251001',
        label: 'claude-haiku-4-5-20251001',
        efforts: [],
      },
    ],
  },
  deepseek: {
    defaultModel: '["deepseek-official","deepseek-v4-flash"]',
    models: [
      { id: '["deepseek-official","deepseek-v4-flash"]', label: 'DeepSeek Flash' },
      { id: '["configured-provider","vendor/model:v2"]', label: 'Configured model' },
    ],
  },
  pi: {
    defaultModel: 'fixture/pi',
    models: [
      {
        id: 'fixture/pi',
        label: 'Pi reasoning',
        efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      },
    ],
  },
  cursor: {
    defaultModel: 'grok-4.7',
    models: [
      {
        id: 'grok-4.7',
        label: 'Grok 4.7',
        efforts: ['low', 'medium', 'high', 'xhigh'],
        effortParameter: 'reasoning_effort',
        parameters: [
          {
            id: 'context',
            label: 'Context',
            values: [
              { value: '256k', label: '256K' },
              { value: '500k', label: '500K' },
            ],
            default: '500k',
          },
          {
            id: 'reasoning_effort',
            label: 'Effort',
            values: [
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
              { value: 'xhigh', label: 'Extra High' },
            ],
            default: 'high',
          },
          {
            id: 'fast',
            label: 'Fast',
            values: [
              { value: 'false', label: 'false' },
              { value: 'true', label: 'Fast' },
            ],
            default: 'true',
          },
        ],
      },
      {
        id: 'plain-cursor',
        label: 'Plain',
        efforts: [],
        parameters: [
          {
            id: 'fast',
            label: 'Fast',
            values: [
              { value: 'false', label: 'false' },
              { value: 'true', label: 'Fast' },
            ],
            default: 'false',
          },
        ],
      },
    ],
    unavailable: [
      {
        id: 'claude-opus-5-5',
        reason: 'Cursor model claude-opus-5-5 variant uses unknown parameter cyber.',
      },
    ],
  },
};
const bundle = await build({
  stdin: {
    contents: `import React, {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import AgentComposer from './components/AgentComposer';
      import {resetAgentModelCatalogs} from './components/ModelSelect';
      import {defaultAgentPreferences} from './lib/workspace-state';
      const submissions = [], settingsOpens = [];
      function Fixture() {
        const [state,setState] = useState({
          provider:'codex', available:true, agentSupportsEffort:true,
          effort:defaultAgentPreferences.effort, model:'', input:'', busy:false,
        });
        const patch = next => setState(previous=>({...previous,...next}));
        window.effortFixture = {state,submissions,settingsOpens,patch,resetAgentModelCatalogs};
        return <main className="chat-panel"><AgentComposer key={state.composerKey} {...state}
          setEffort={effort=>patch({effort})} setModel={model=>patch({model})}
          setInput={input=>patch({input})} approvalMode="review" setApprovalMode={()=>{}}
          onSubmit={(effort, parameters, model) => submissions.push({ model: model ?? '', effort: effort ?? null, parameters: parameters ?? null })} onStop={()=>{}}
          onAgentSettings={()=>settingsOpens.push(state.provider)}/>
        </main>;
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
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let releaseCodex;
  let initialCodex = true;
  let releasePi;
  let failCodex = false;
  let updatedCodex = false;
  let holdCodexList = false;
  let releaseCodexList;
  let codexRequests = 0;
  await page.addInitScript(() => {
    window.openpe = { connection: async () => ({ base: 'http://localhost', token: 'fixture' }) };
  });
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/models') {
      const provider = url.searchParams.get('provider');
      if (provider === 'codex') codexRequests++;
      if (provider === 'codex' && initialCodex) {
        initialCodex = false;
        await new Promise((resolve) => (releaseCodex = resolve));
      }
      if (provider === 'pi') await new Promise((resolve) => (releasePi = resolve));
      if (provider === 'codex' && holdCodexList)
        await new Promise((resolve) => (releaseCodexList = resolve));
      if (provider === 'codex' && failCodex)
        return route.fulfill({ status: 502, json: { error: 'Fixture discovery unavailable.' } });
      assert.ok(catalogs[provider], `Unexpected provider: ${provider}`);
      if (provider === 'codex' && updatedCodex)
        return route.fulfill({
          json: {
            ...catalogs.codex,
            models: [
              ...catalogs.codex.models,
              { id: 'gpt-6.2-astra', label: 'GPT-6.2 Astra' },
              { id: 'gpt-6.2-sol', label: 'GPT-6.2 Sol', efforts: [] },
              { id: 'fixture/image', label: 'Image input model', textInput: false },
            ],
          },
        });
      return route.fulfill({ json: catalogs[provider] });
    }
    assert.ok(!url.pathname.startsWith('/api/'), `Unexpected API request: ${url.pathname}`);
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addStyleTag({ content: 'main{width:750px;margin:180px auto}' });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });

  const effort = page.getByRole('combobox', { name: 'Reasoning effort', exact: true });
  const model = page.getByRole('combobox', { name: 'Choose model', exact: true });
  const input = page.getByRole('textbox', { name: 'Message your agent', exact: true });
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  const main = page.locator('main');
  const composer = main.locator('.composer');
  const composerHeight = () =>
    composer.evaluate((element) => element.getBoundingClientRect().height);
  const availability = page.locator('.composer-availability');
  const modelList = page.getByRole('listbox', { name: 'Choose model', exact: true });
  const loadingOption = modelList.getByRole('option', { name: 'Loading models…', exact: true });
  const releaseModelList = async () => {
    const deadline = Date.now() + 10000;
    while (!releaseCodexList) {
      assert.ok(Date.now() < deadline, 'Catalog detection did not start.');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    holdCodexList = false;
    releaseCodexList();
    releaseCodexList = undefined;
  };
  const redetect = () => page.evaluate(() => window.effortFixture.resetAgentModelCatalogs());
  const snapshot = () => page.evaluate(() => window.effortFixture.state);
  const submissions = () => page.evaluate(() => window.effortFixture.submissions);
  const patch = async (next) => {
    await page.evaluate((next) => window.effortFixture.patch(next), next);
    await waitForAsync(
      page,
      (next) =>
        Object.entries(next).every(([key, value]) => window.effortFixture.state[key] === value),
      next,
    );
  };
  const waitEffort = (label) =>
    waitForAsync(
      page,
      (label) =>
        document.querySelector('[aria-label="Reasoning effort"]')?.textContent.trim() === label,
      label,
    );
  const choose = async (picker, label) => {
    await picker.click();
    await page.getByRole('option', { name: label, exact: true }).click();
  };
  const checkCompactModelTrigger = async () => {
    const size = await model.evaluate((field) => {
      const label = field.querySelector('.select-value');
      const text = document.createRange();
      text.selectNodeContents(label);
      return {
        field: field.getBoundingClientRect().width,
        text: text.getBoundingClientRect().width,
        wrapper: field.closest('.composer-model-picker').getBoundingClientRect().width,
        clipped: label.scrollWidth > label.clientWidth + 1,
      };
    });
    assert.equal(size.clipped, false, 'The selected model label fits its compact trigger.');
    assert.ok(
      size.field >= size.text && size.field - size.text <= 20,
      'The model trigger reserves only its selected text and control padding.',
    );
    assert.ok(
      size.wrapper - size.field <= 2,
      'The model picker does not reserve unused width beside its trigger.',
    );
    return size.field;
  };
  const checkModelPopup = async () => {
    const geometry = await modelList.evaluate((menu) => {
      const box = menu.getBoundingClientRect();
      return {
        width: box.width,
        bounded:
          box.left >= 7 &&
          box.right <= window.innerWidth - 7 &&
          box.top >= 7 &&
          box.bottom <= window.innerHeight - 7,
        horizontalOverflow: menu.scrollWidth > menu.clientWidth + 1,
        clipped: [...menu.querySelectorAll('.select-option strong')]
          .filter((label) => {
            const text = document.createRange();
            text.selectNodeContents(label);
            return label.scrollWidth > label.clientWidth + 1 || text.getClientRects().length !== 1;
          })
          .map((label) => label.textContent),
      };
    });
    assert.ok(
      geometry.width > (await model.boundingBox()).width,
      'The model popup sizes to its options independently of the compact trigger.',
    );
    assert.equal(geometry.bounded, true, 'The model popup stays inside the viewport margins.');
    assert.equal(geometry.horizontalOverflow, false, 'The model popup has no horizontal overflow.');
    assert.deepEqual(
      geometry.clipped,
      [],
      'Every model name fits on one line, including beside a scrollbar.',
    );
    return geometry.width;
  };
  const assertNoEffortChoices = async ({ allowDisabled = false } = {}) => {
    await waitForAsync(
      page,
      (allowDisabled) => {
        const picker = document.querySelector('[aria-label="Reasoning effort"][role="combobox"]');
        return !picker || (allowDisabled && picker.disabled);
      },
      allowDisabled,
    );
    if (allowDisabled && (await effort.count())) assert.equal(await effort.isDisabled(), true);
    else assert.equal(await effort.count(), 0);
    assert.equal(await page.getByText('Default effort', { exact: true }).count(), 0);
    assert.equal(await page.getByText('No reasoning effort', { exact: true }).count(), 0);
    assert.equal(
      await page.getByRole('listbox', { name: 'Reasoning effort', exact: true }).count(),
      0,
    );
  };
  const submitEffort = async (expected) => {
    const count = (await submissions()).length;
    await send.click();
    await waitForAsync(
      page,
      (count) => window.effortFixture.submissions.length === count + 1,
      count,
    );
    assert.equal((await submissions()).at(-1).effort, expected);
  };
  const assertSendBlocked = async () => {
    assert.equal(await send.isDisabled(), true);
    const count = (await submissions()).length;
    await input.press('Enter');
    assert.equal((await submissions()).length, count, 'Enter cannot bypass model discovery.');
  };

  await page.getByPlaceholder('Loading models…', { exact: true }).waitFor();
  await assertNoEffortChoices();
  await main.evaluate((element) => (element.style.width = '328px'));
  const loadingHeight = await composerHeight();
  assert.equal(await availability.count(), 0);
  assert.equal(
    await input.getAttribute('aria-describedby'),
    await composer.getByRole('status').getAttribute('id'),
  );
  await input.fill('Explain ripple');
  assert.equal((await model.textContent()).trim(), 'Loading model…');
  assert.equal(await composerHeight(), loadingHeight);
  assert.equal((await snapshot()).effort, 'medium', 'New preferences default to medium.');
  await assertNoEffortChoices();
  await assertSendBlocked();
  const initialDeadline = Date.now() + 10000;
  while (!releaseCodex) {
    assert.ok(Date.now() < initialDeadline, 'Codex model discovery did not start.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  releaseCodex();
  await page.getByPlaceholder('Work with Codex', { exact: true }).waitFor();
  assert.equal(await composerHeight(), loadingHeight, 'Model loading preserves composer height.');
  assert.equal(await effort.locator('svg').count(), 0, 'The inline effort field is text-only.');
  const checkEffortLabelGap = async () => {
    const textRight = await effort.locator('.select-value').evaluate((label) => {
      const text = document.createRange();
      text.selectNodeContents(label);
      return text.getBoundingClientRect().right;
    });
    const gap = (await send.boundingBox()).x - textRight;
    assert.ok(gap >= 0 && gap <= 12, 'The visible effort label sits near the Send button.');
  };
  await checkEffortLabelGap();
  await effort.click();
  const effortMenu = page.getByRole('listbox', { name: 'Reasoning effort', exact: true });
  assert.deepEqual(await effortMenu.getByRole('option').allTextContents(), [
    'None',
    'Minimal',
    'Low',
    'Medium',
    'High',
    'Extra high',
    'Max',
    'Ultra',
  ]);
  const checkEffortPlacement = async ({ clamped = false } = {}) => {
    const menuBox = await effortMenu.boundingBox();
    const fieldBox = await effort.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(menuBox.width > fieldBox.width, 'The menu can grow beyond the compact field.');
    const expectedLeft = clamped
      ? Math.max(8, Math.min(fieldBox.x, viewport.width - menuBox.width - 8))
      : fieldBox.x;
    assert.ok(
      Math.abs(menuBox.x - expectedLeft) < 1,
      'The effort popup aligns its left edge to the trigger within viewport bounds.',
    );
    assert.ok(Math.abs(fieldBox.y - menuBox.y - menuBox.height - 8) < 1);
    assert.ok(menuBox.x >= 7 && menuBox.x + menuBox.width <= viewport.width - 7);
    assert.ok(menuBox.y >= 7 && menuBox.y + menuBox.height <= viewport.height - 7);
    const truncated = await effortMenu
      .locator('strong')
      .evaluateAll((labels) =>
        labels
          .filter((label) => label.scrollWidth > label.clientWidth)
          .map((label) => label.textContent),
      );
    assert.deepEqual(truncated, [], 'All effort options show their full labels.');
  };
  await checkEffortPlacement();
  await mkdir('test-results/agent-effort', { recursive: true });
  const effortScreenshot = await page.evaluate(() => {
    const boxes = [
      document.querySelector('.composer').getBoundingClientRect(),
      document.querySelector('.composer-effort-menu').getBoundingClientRect(),
    ];
    const x = Math.max(0, Math.floor(Math.min(...boxes.map((box) => box.left)) - 8));
    const y = Math.max(0, Math.floor(Math.min(...boxes.map((box) => box.top)) - 8));
    return {
      x,
      y,
      width: Math.min(innerWidth, Math.ceil(Math.max(...boxes.map((box) => box.right)) + 8)) - x,
      height: Math.min(innerHeight, Math.ceil(Math.max(...boxes.map((box) => box.bottom)) + 8)) - y,
    };
  });
  await page.screenshot({
    path: 'test-results/agent-effort/effort-left-aligned.png',
    clip: effortScreenshot,
  });
  await page.keyboard.press('Escape');
  await page.evaluate(() => document.documentElement.style.setProperty('--font-step', '4px'));
  await checkEffortLabelGap();
  await effort.click();
  await checkEffortPlacement();
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 360, height: 740 });
  await effort.click();
  await checkEffortPlacement({ clamped: true });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.evaluate(() => document.documentElement.style.removeProperty('--font-step'));
  await main.evaluate((element) => (element.style.width = ''));
  await submitEffort('medium');
  assert.equal((await submissions()).at(-1).model, 'fixture/full');
  for (const [label, value] of [
    ['Max', 'max'],
    ['Ultra', 'ultra'],
  ]) {
    await choose(effort, label);
    await checkEffortLabelGap();
    await submitEffort(value);
  }

  // Navigation is a preview; composing Enter/Escape, including keyCode 229,
  // cannot select or dismiss the menu or submit the composer.
  await effort.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home');
  assert.equal((await snapshot()).effort, 'ultra');
  for (const key of ['Enter', 'Escape']) {
    await effort.dispatchEvent('keydown', { key, code: key, keyCode: 229 });
    await effort.dispatchEvent('keydown', { key, code: key, isComposing: true });
    assert.equal(await effort.getAttribute('aria-expanded'), 'true');
    assert.equal((await snapshot()).effort, 'ultra');
  }
  await page.keyboard.press('Escape');
  assert.equal((await snapshot()).effort, 'ultra');
  await effort.press('ArrowDown');
  await effort.press('Home');
  await effort.press('Enter');
  assert.equal((await snapshot()).effort, 'none');
  await choose(effort, 'Medium');
  await input.focus();
  const beforeIme = (await submissions()).length;
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229 });
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await input.press('Shift+Enter');
  assert.equal((await submissions()).length, beforeIme);
  await input.press('Enter');
  assert.equal((await submissions()).length, beforeIme + 1);
  assert.equal((await submissions()).at(-1).effort, 'medium');

  await choose(effort, 'Ultra');
  await choose(model, 'Three levels');
  await waitEffort('Medium');
  assert.equal(
    (await snapshot()).effort,
    'ultra',
    'An incompatible model does not overwrite the saved choice.',
  );
  await submitEffort('medium');
  await choose(model, 'Full reasoning');
  await waitEffort('Ultra');
  await choose(model, 'No effort');
  await assertNoEffortChoices();
  await submitEffort(null);

  await choose(model, 'Full reasoning');
  await waitEffort('Ultra');
  await patch({ available: false, agentAvailabilityKnown: false });
  assert.equal(await availability.count(), 0);
  assert.equal(await availability.getByRole('button', { name: 'Agent settings' }).count(), 0);
  await patch({ agentAvailabilityKnown: true });
  await availability.getByText('Codex is unavailable.', { exact: true }).waitFor();
  const agentSettings = availability.getByRole('button', { name: 'Agent settings', exact: true });
  await agentSettings.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.effortFixture.settingsOpens), ['codex']);
  assert.ok(await input.evaluate((field) => document.activeElement === field));
  await assertNoEffortChoices({ allowDisabled: true });
  assert.equal(await model.isDisabled(), true);
  assert.equal(await send.isDisabled(), true);
  const beforeUnavailable = (await submissions()).length;
  await input.press('Enter');
  assert.equal((await submissions()).length, beforeUnavailable);
  // The shared Home composer creates local projects and must remain usable
  // without any installed or connected Agent.
  await patch({ requiresAgent: false });
  assert.equal(await availability.count(), 0);
  await submitEffort(null);
  await patch({ requiresAgent: true });
  await assertSendBlocked();
  await patch({ available: true, busy: true });
  await assertNoEffortChoices({ allowDisabled: true });
  assert.equal(await model.isDisabled(), true);
  await input.press('Enter');
  assert.equal((await submissions()).length, beforeUnavailable + 1);
  await patch({ busy: false });
  await waitEffort('Ultra');

  // A delayed new-provider catalog must not expose the old provider's efforts.
  await patch({ provider: 'pi', model: '', agentSupportsEffort: false });
  await assertNoEffortChoices();
  await assertSendBlocked();
  const deadline = Date.now() + 10000;
  while (!releasePi) {
    assert.ok(Date.now() < deadline, 'Pi model discovery did not start.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  releasePi();
  await waitEffort('Medium');
  assert.equal((await snapshot()).agentSupportsEffort, false);
  await effort.click();
  assert.deepEqual(await page.getByRole('option').allTextContents(), [
    'Off',
    'Minimal',
    'Low',
    'Medium',
    'High',
    'Extra high',
    'Max',
  ]);
  await page.keyboard.press('Escape');
  await choose(effort, 'Off');
  await submitEffort('off');
  assert.equal((await submissions()).at(-1).model, 'fixture/pi');
  await patch({ provider: 'claude', model: '', agentSupportsEffort: true });
  await assertSendBlocked();
  await model.click();
  const claudeSonnet = modelList.getByRole('option', { name: 'claude-sonnet-4-6', exact: true });
  await claudeSonnet.waitFor();
  assert.equal(await modelList.getByRole('option', { name: 'Default', exact: true }).count(), 0);
  assert.deepEqual(await modelList.getByRole('option').allTextContents(), [
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
  ]);
  const claudePopupWidth = await checkModelPopup();
  await claudeSonnet.click();
  const sonnetTriggerWidth = await checkCompactModelTrigger();
  await model.click();
  assert.ok(Math.abs((await checkModelPopup()) - claudePopupWidth) <= 1);
  await model.press('Escape');
  await waitEffort('Medium');
  await submitEffort('medium');
  assert.equal((await submissions()).at(-1).model, 'claude-sonnet-4-6');
  await choose(model, 'claude-haiku-4-5-20251001');
  assert.ok(
    (await checkCompactModelTrigger()) > sonnetTriggerWidth,
    'The trigger grows with the selected concrete model name.',
  );
  await assertNoEffortChoices();
  await submitEffort(null);
  assert.equal((await submissions()).at(-1).model, 'claude-haiku-4-5-20251001');
  await patch({ provider: 'deepseek', model: '', agentSupportsEffort: false });
  await model.getByText('DeepSeek Flash', { exact: true }).waitFor();
  await submitEffort(null);
  assert.equal((await submissions()).at(-1).model, catalogs.deepseek.defaultModel);
  await choose(model, 'Configured model');
  await submitEffort(null);
  assert.equal((await submissions()).at(-1).model, catalogs.deepseek.models[1].id);
  failCodex = true;
  await patch({ provider: 'codex', model: '' });
  await page.getByPlaceholder('Work with Codex', { exact: true }).waitFor();
  await patch({ composerKey: 1 });
  await page.getByPlaceholder('Work with Codex', { exact: true }).waitFor();
  assert.equal(codexRequests, 1, 'Provider changes and new composers share the startup catalog.');
  await redetect();
  await availability.getByText('Could not load models.', { exact: true }).waitFor();
  await assertNoEffortChoices();
  await assertSendBlocked();
  await main.evaluate((element) => {
    element.style.width = '328px';
  });
  await main
    .locator('.composer')
    .screenshot({ path: 'test-results/agent-effort/model-retry-328.png' });
  await main.evaluate((element) => {
    element.style.width = '';
  });
  assert.equal(
    (await snapshot()).effort,
    'off',
    'Discovery failure preserves the saved preference.',
  );
  await input.focus();
  const beforeRetry = codexRequests;
  const beforeDraft = await input.inputValue();
  await input.evaluate((field) => field.setSelectionRange(2, 8, 'backward'));
  await input.dispatchEvent('compositionstart');
  await model.click();
  assert.equal(codexRequests, beforeRetry);
  assert.equal(await modelList.count(), 0);
  assert.ok(await input.evaluate((field) => document.activeElement === field));
  await input.dispatchEvent('compositionend');
  await model.dispatchEvent('keydown', { key: 'ArrowDown', keyCode: 229 });
  assert.equal(codexRequests, beforeRetry);
  await model.press('ArrowDown');
  await modelList.getByRole('option', { name: 'Could not load models.', exact: true }).waitFor();
  assert.equal(codexRequests, beforeRetry);
  await model.press('Escape');
  failCodex = false;
  holdCodexList = true;
  await redetect();
  await model.press('ArrowDown');
  await loadingOption.waitFor();
  await page.getByPlaceholder('Loading models…', { exact: true }).waitFor();
  assert.equal(await loadingOption.getAttribute('aria-disabled'), 'true');
  assert.equal(await model.getAttribute('aria-activedescendant'), null);
  await model.press('Enter');
  assert.ok(await modelList.isVisible());
  assert.equal((await snapshot()).model, '');
  assert.equal(await input.inputValue(), beforeDraft);
  assert.deepEqual(
    await input.evaluate((field) => [
      field.selectionStart,
      field.selectionEnd,
      field.selectionDirection,
    ]),
    [2, 8, 'backward'],
  );
  await assertSendBlocked();
  await page.locator('main').evaluate((element) => {
    element.tabIndex = -1;
    element.focus();
  });
  await releaseModelList();
  await page.getByPlaceholder('Work with Codex', { exact: true }).waitFor();
  await waitEffort('Medium');
  assert.equal(codexRequests, beforeRetry + 1);
  assert.equal(await availability.count(), 0);
  assert.equal(await modelList.count(), 0);
  assert.ok(await page.locator('main').evaluate((element) => document.activeElement === element));
  await submitEffort('medium');
  assert.equal((await snapshot()).effort, 'off');
  const filledHeight = await composerHeight();
  const draftBeforeChoice = await input.inputValue();
  await patch({ model: 'fixture/retired' });
  const chooseModelPrompt = 'Choose an available model to send.';
  await page.getByPlaceholder(chooseModelPrompt, { exact: true }).waitFor();
  assert.equal(await composer.getByRole('status').textContent(), chooseModelPrompt);
  assert.equal(await availability.count(), 0);
  assert.equal(await composerHeight(), filledHeight);
  assert.equal(await input.inputValue(), draftBeforeChoice);
  await assertSendBlocked();
  assert.equal((await snapshot()).model, 'fixture/retired');
  assert.equal((await model.textContent()).trim(), 'Choose model');
  await assertNoEffortChoices();
  await model.click();
  assert.equal(await modelList.getByRole('option', { name: 'fixture/retired' }).count(), 0);
  assert.equal(
    await modelList.getByRole('option', { name: /^(GPT-Reserve|Codex Auto Review)$/ }).count(),
    0,
  );
  await checkCompactModelTrigger();
  const wideModelPopupWidth = await checkModelPopup();
  await main.evaluate((element) => (element.style.width = '328px'));
  await checkCompactModelTrigger();
  assert.ok(
    Math.abs((await checkModelPopup()) - wideModelPopupWidth) <= 1,
    'Narrowing the composer does not force the model popup to match the field.',
  );
  const astra = modelList.getByRole('option', { name: 'GPT-6-Astra', exact: true });
  assert.equal(
    await astra.locator('strong').evaluate((label) => {
      const text = document.createRange();
      text.selectNodeContents(label);
      return text.getClientRects().length;
    }),
    1,
    'A narrow composer still shows the model name on one line.',
  );
  await model.press('Escape');
  await input.fill('');
  const emptyHeight = await composerHeight();
  assert.equal(await input.getAttribute('placeholder'), chooseModelPrompt);
  await model.click();
  await astra.click();
  await page.getByPlaceholder('Work with Codex', { exact: true }).waitFor();
  assert.equal(await composerHeight(), emptyHeight);
  assert.equal((await model.textContent()).trim(), 'GPT-6-Astra');
  await checkCompactModelTrigger();
  const modelLabelGap = await model.evaluate((field) => {
    const modelLabel = document.createRange();
    modelLabel.selectNodeContents(field.querySelector('.select-value'));
    const effortLabel = document.createRange();
    effortLabel.selectNodeContents(
      document.querySelector('[aria-label="Reasoning effort"] .select-value'),
    );
    return effortLabel.getBoundingClientRect().left - modelLabel.getBoundingClientRect().right;
  });
  assert.ok(modelLabelGap >= 0 && modelLabelGap <= 10, 'Model and effort labels sit together.');
  await input.fill(draftBeforeChoice);
  await submitEffort('medium');
  assert.equal((await submissions()).at(-1).model, 'fixture/gpt-6-astra');
  await main.evaluate((element) => (element.style.width = ''));

  const refreshRequests = codexRequests;
  updatedCodex = true;
  await model.click();
  await astra.waitFor();
  assert.equal(codexRequests, refreshRequests);
  assert.equal(
    await modelList.getByRole('option', { name: 'GPT-6.2 Astra', exact: true }).count(),
    0,
  );
  await model.press('Escape');
  holdCodexList = true;
  await redetect();
  await model.click();
  await loadingOption.waitFor();
  assert.equal(await modelList.getByRole('option').count(), 1);
  assert.equal((await snapshot()).model, 'fixture/gpt-6-astra');
  assert.equal(await input.inputValue(), draftBeforeChoice);
  assert.equal(await send.isDisabled(), true);
  await releaseModelList();
  await modelList.getByRole('option', { name: 'GPT-6.2 Astra', exact: true }).waitFor();
  assert.equal(codexRequests, refreshRequests + 1);
  assert.equal(await modelList.getByRole('option', { name: /refresh|retry/i }).count(), 0);
  const savedModelOption = modelList.getByRole('option', { name: 'GPT-6-Astra', exact: true });
  assert.equal(
    await model.getAttribute('aria-activedescendant'),
    await savedModelOption.getAttribute('id'),
  );
  assert.equal(
    await modelList.evaluate((menu) => {
      const viewportBottom = menu.getBoundingClientRect().top + menu.clientTop + menu.clientHeight;
      const boxes = [...menu.children].map((option) => option.getBoundingClientRect());
      return (
        menu.scrollTop === 0 &&
        boxes[4].bottom <= viewportBottom + 1 &&
        boxes[5].top >= viewportBottom - 1 &&
        menu.scrollHeight > menu.clientHeight
      );
    }),
    true,
    'The model popup opens with room for five rows and scrolls to show the rest.',
  );
  await checkModelPopup();
  await model.press('Escape');
  await main.evaluate((element) => (element.style.width = '328px'));
  await page.setViewportSize({ width: 360, height: 740 });
  await model.click();
  await checkModelPopup();
  await page.screenshot({ path: 'test-results/agent-effort/model-content-width-360.png' });
  await model.press('Escape');
  await page.setViewportSize({ width: 1100, height: 800 });
  await main.evaluate((element) => (element.style.width = ''));
  await model.click();
  await modelList.hover();
  await page.mouse.wheel(0, 120);
  await waitForAsync(page, () => {
    const menu = document.querySelector('.model-menu');
    return menu && menu.scrollTop > 0;
  });
  assert.equal(
    await modelList
      .getByRole('option', { name: /^Image input model/ })
      .getAttribute('aria-disabled'),
    'true',
  );
  await modelList.getByRole('option', { name: 'GPT-6.2 Astra', exact: true }).click();
  await checkCompactModelTrigger();
  await assertNoEffortChoices();
  await submitEffort(null);
  assert.equal((await submissions()).at(-1).model, 'gpt-6.2-astra');
  await choose(model, 'GPT-6.2 Sol');
  assert.equal(codexRequests, refreshRequests + 1);
  await submitEffort(null);
  assert.equal((await submissions()).at(-1).model, 'gpt-6.2-sol');

  // Explicit redetection replaces the previous catalog, while opening never requests it.
  failCodex = true;
  await redetect();
  await model.click();
  await modelList.getByRole('option', { name: 'Could not load models.', exact: true }).waitFor();
  assert.equal(await modelList.getByRole('option').count(), 1);
  await model.press('Escape');
  await availability.getByText('Could not load models.', { exact: true }).waitFor();
  await assertNoEffortChoices();
  await assertSendBlocked();
  await patch({ requiresAgent: false });
  await page.getByRole('status', { name: 'Model list unavailable', exact: true }).waitFor();
  await submitEffort(null);
  await patch({
    provider: 'cursor',
    model: '',
    available: true,
    requiresAgent: true,
    effort: 'off',
  });
  const contextPicker = page.getByRole('combobox', { name: 'Context', exact: true });
  const fastSwitch = page.getByRole('switch', { name: 'Fast', exact: true });
  await contextPicker.waitFor();
  const unavailableModels = page.getByRole('note');
  await unavailableModels.waitFor();
  assert.equal(
    await unavailableModels.textContent(),
    'Unavailable models: claude-opus-5-5 — Cursor model claude-opus-5-5 variant uses unknown parameter cyber.',
  );
  await model.click();
  const excluded = page.getByRole('option', { name: /claude-opus-5-5/ });
  assert.equal(await excluded.getAttribute('aria-disabled'), 'true');
  await excluded.click({ force: true });
  assert.equal((await snapshot()).model, '');
  await page.keyboard.press('Escape');
  await waitEffort('Medium');
  assert.equal(await page.getByText('No reasoning effort', { exact: true }).count(), 0);
  assert.equal((await contextPicker.textContent())?.trim(), '500K');
  assert.equal(await fastSwitch.getAttribute('aria-checked'), 'true');
  await effort.click();
  await checkEffortPlacement();
  assert.deepEqual(await page.getByRole('option').allTextContents(), [
    'Low',
    'Medium',
    'High',
    'Extra high',
  ]);
  await page.keyboard.press('Escape');
  const beforeCursor = (await submissions()).length;
  await send.click();
  await waitForAsync(
    page,
    (count) => window.effortFixture.submissions.length === count + 1,
    beforeCursor,
  );
  assert.deepEqual((await submissions()).at(-1), {
    model: 'grok-4.7',
    effort: 'medium',
    parameters: [
      { id: 'context', value: '500k' },
      { id: 'fast', value: 'true' },
    ],
  });
  assert.equal((await snapshot()).effort, 'off');
  await choose(contextPicker, '256K');
  await fastSwitch.click();
  assert.equal(await fastSwitch.getAttribute('aria-checked'), 'false');
  await choose(effort, 'High');
  await send.click();
  await waitForAsync(
    page,
    (count) => window.effortFixture.submissions.length === count + 1,
    beforeCursor + 1,
  );
  assert.deepEqual((await submissions()).at(-1), {
    model: 'grok-4.7',
    effort: 'high',
    parameters: [
      { id: 'context', value: '256k' },
      { id: 'fast', value: 'false' },
    ],
  });
  await choose(model, 'Plain');
  await assertNoEffortChoices();
  assert.equal(
    await page.getByRole('switch', { name: 'Fast', exact: true }).getAttribute('aria-checked'),
    'false',
  );
  await send.click();
  await waitForAsync(
    page,
    (count) => window.effortFixture.submissions.length === count + 1,
    beforeCursor + 2,
  );
  assert.deepEqual((await submissions()).at(-1), {
    model: 'plain-cursor',
    effort: null,
    parameters: [{ id: 'fast', value: 'false' }],
  });
  await choose(model, 'Grok 4.7');
  await waitEffort('High');
  assert.equal(await fastSwitch.getAttribute('aria-checked'), 'false');
  assert.equal(await page.getByText('No reasoning effort', { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: startup catalog sharing, request-free model selection, compact model triggers and content-sized bounded popups, exact submitted values, explicit redetection, offline Home submission and keyboard/IME behavior.',
  );
} finally {
  await browser.close();
}
