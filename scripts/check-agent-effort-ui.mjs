// Actual AgentComposer/ModelSelect with isolated model catalogs and preferences.
// No Electron, installed provider, external service or solver is launched.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
};
const bundle = await build({
  stdin: {
    contents: `import React, {useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import AgentComposer from './components/AgentComposer';
      import {defaultAgentPreferences} from './lib/workspace-state';
      const submissions = [];
      function Fixture() {
        const [state,setState] = useState({
          provider:'codex', available:true, agentSupportsEffort:true,
          effort:defaultAgentPreferences.effort, model:'', input:'Explain ripple', busy:false,
        });
        const patch = next => setState(previous=>({...previous,...next}));
        window.effortFixture = {state,submissions,patch};
        return <main><AgentComposer {...state}
          setEffort={effort=>patch({effort})} setModel={model=>patch({model})}
          setInput={input=>patch({input})} approvalMode="review" setApprovalMode={()=>{}}
          onSubmit={effort=>submissions.push({effort:effort ?? null})} onStop={()=>{}}/>
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
  await page.addInitScript(() => {
    window.openpe = { connection: async () => ({ base: 'http://localhost', token: 'fixture' }) };
  });
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/models') {
      const provider = url.searchParams.get('provider');
      if (provider === 'codex' && initialCodex) {
        initialCodex = false;
        await new Promise((resolve) => (releaseCodex = resolve));
      }
      if (provider === 'pi') await new Promise((resolve) => (releasePi = resolve));
      if (provider === 'codex' && failCodex)
        return route.fulfill({ status: 502, json: { error: 'Fixture discovery unavailable.' } });
      assert.ok(catalogs[provider], `Unexpected provider: ${provider}`);
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
  const assertNoEffortChoices = async () => {
    await waitForAsync(page, () => {
      const picker = document.querySelector('[aria-label="Reasoning effort"][role="combobox"]');
      return !picker || picker.disabled;
    });
    assert.ok((await effort.count()) === 0 || (await effort.isDisabled()));
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

  await waitEffort('Medium');
  assert.equal((await snapshot()).effort, 'medium', 'New preferences default to medium.');
  await assertNoEffortChoices();
  await assertSendBlocked();
  const initialDeadline = Date.now() + 10000;
  while (!releaseCodex) {
    assert.ok(Date.now() < initialDeadline, 'Codex model discovery did not start.');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  releaseCodex();
  await effort.click();
  assert.deepEqual(await page.getByRole('option').allTextContents(), [
    'None',
    'Minimal',
    'Low',
    'Medium',
    'High',
    'Extra high',
    'Max',
    'Ultra',
  ]);
  await page.keyboard.press('Escape');
  await submitEffort('medium');
  for (const [label, value] of [
    ['Max', 'max'],
    ['Ultra', 'ultra'],
  ]) {
    await choose(effort, label);
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
  await patch({ available: false });
  await assertNoEffortChoices();
  assert.equal(await model.isDisabled(), true);
  assert.equal(await send.isDisabled(), true);
  const beforeUnavailable = (await submissions()).length;
  await input.press('Enter');
  assert.equal((await submissions()).length, beforeUnavailable);
  // The shared Home composer creates local projects and must remain usable
  // without any installed or connected Agent.
  await patch({ requiresAgent: false });
  await submitEffort('ultra');
  await patch({ requiresAgent: true });
  await assertSendBlocked();
  await patch({ available: true, busy: true });
  await assertNoEffortChoices();
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
  failCodex = true;
  await patch({ provider: 'codex', model: '' });
  await page.getByRole('status', { name: 'Model list unavailable', exact: true }).waitFor();
  await assertNoEffortChoices();
  await assertSendBlocked();
  assert.equal(
    (await snapshot()).effort,
    'off',
    'Discovery failure preserves the saved preference.',
  );
  failCodex = false;
  await patch({ available: false });
  await patch({ available: true });
  await waitEffort('Medium');
  await submitEffort('medium');
  assert.equal((await snapshot()).effort, 'off');

  // Refresh failure for the same provider must revoke the previously loaded
  // catalog, rather than restoring stale efforts when availability returns.
  failCodex = true;
  await patch({ available: false });
  await patch({ available: true });
  await page.getByRole('status', { name: 'Model list unavailable', exact: true }).waitFor();
  await assertNoEffortChoices();
  await assertSendBlocked();
  await patch({ requiresAgent: false });
  await submitEffort('medium');
  assert.deepEqual(errors, []);
  console.log(
    'PASS: medium default, full model-advertised efforts, exact submitted values, model/provider changes, discovery and refresh gates, offline Home submission, unavailable/busy guards and keyboard/IME behavior.',
  );
} finally {
  await browser.close();
}
