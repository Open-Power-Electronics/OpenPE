// Opt-in desktop/provider smoke check. Uses the real built renderer and service,
// an isolated OpenPE profile, and the installed Harness's own authentication.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { electronTestLaunch } from './electron-test-launch.mjs';
import { waitForAsync } from './async-browser-test-helpers.mjs';

const args = process.argv.slice(2);
if (!args.length || (args.length === 1 && args[0] === '--help')) {
  console.log(
    'Opt-in: node scripts/check-deepseek-agent-ui.mjs --run\n' +
      'Launches an isolated Electron instance and sends one real DeepSeek Flash request. ' +
      'Build OpenPE and configure the installed DeepSeek Harness first.',
  );
  process.exit(0);
}
assert.deepEqual(args, ['--run'], 'The only supported execution flag is --run.');

const output = path.resolve('test-results/deepseek-ui');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(path.join(output, 'profile-'));
const prompt = 'Reply exactly OPENPE_DEEPSEEK_UI_OK. Do not use tools or propose changes.';
const expected = 'OPENPE_DEEPSEEK_UI_OK';
const application = await electron.launch({
  ...electronTestLaunch(),
  env: {
    ...process.env,
    OPENPE_TEST: '1',
    OPENPE_DATA_DIR: profile,
    OPENPE_DEV_URL: '',
  },
  timeout: 90000,
});
let page;
const requests = [];
const report = { profile, status: 'started' };

function publicError(error) {
  return String(error?.message ?? error)
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/(Bearer\s+)\S+/gi, '$1[redacted]')
    .slice(0, 2000);
}

async function capture(name, locators = []) {
  const boxes = await Promise.all(locators.map((locator) => locator.boundingBox()));
  assert.ok(boxes.every(Boolean), 'Every requested capture region must be visible.');
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const left = Math.max(0, Math.floor(Math.min(...boxes.map((box) => box.x)) - 12));
  const top = Math.max(0, Math.floor(Math.min(...boxes.map((box) => box.y)) - 12));
  const right = Math.min(
    viewport.width,
    Math.ceil(Math.max(...boxes.map((box) => box.x + box.width)) + 12),
  );
  const bottom = Math.min(
    viewport.height,
    Math.ceil(Math.max(...boxes.map((box) => box.y + box.height)) + 12),
  );
  const rectangle = boxes.length
    ? { x: left, y: top, width: right - left, height: bottom - top }
    : undefined;
  const nativeCapture = async () => {
    let timer;
    try {
      return await Promise.race([
        application.evaluate(async ({ BrowserWindow }, rectangle) => {
          const image = await BrowserWindow.getAllWindows()[0].webContents.capturePage(rectangle, {
            stayHidden: true,
            stayAwake: true,
          });
          if (image.isEmpty()) throw new Error('The desktop capture is empty.');
          return image.toPNG().toString('base64');
        }, rectangle),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Native test capture timed out.')), 10000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  // Hidden native windows need a warm-up capture before recording settled paint.
  await nativeCapture();
  await page.waitForTimeout(180);
  await writeFile(path.join(output, name), Buffer.from(await nativeCapture(), 'base64'));
}

try {
  page = await application.firstWindow({ timeout: 90000 });
  page.setDefaultTimeout(60000);
  report.runtime = await application.evaluate(() => ({
    node: process.versions.node,
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
  }));
  const discovery = page
    .waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return url.pathname === '/api/models' && url.searchParams.get('provider') === 'deepseek';
      },
      { timeout: 90000 },
    )
    .then(async (response) => ({ status: response.status(), body: await response.json() }))
    .catch(() => ({ error: 'DeepSeek model discovery did not return a JSON response.' }));
  page.on('request', (request) => {
    if (new URL(request.url()).pathname !== '/api/chat' || request.method() !== 'POST') return;
    const body = request.postDataJSON();
    requests.push({ provider: body.provider, model: body.model, prompt: body.prompt });
  });

  await page.getByRole('combobox', { name: 'Choose agent', exact: true }).click();
  await page
    .getByRole('option')
    .filter({ has: page.getByText('DeepSeek Harness', { exact: true }) })
    .click();
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  await page.getByTestId('schematic-canvas').waitFor();
  const discovered = await discovery;
  assert.equal(discovered.error, undefined, discovered.error);
  assert.equal(discovered.status, 200, 'DeepSeek model discovery failed.');
  assert.ok(Array.isArray(discovered.body?.models), 'DeepSeek must return a model catalog.');
  report.models = discovered.body.models.map(({ id, label }) => ({ id, label }));
  const officialModels = report.models.filter(({ id }) => {
    try {
      const value = JSON.parse(id);
      return Array.isArray(value) && value.length === 2 && value[0] === 'deepseek-official';
    } catch {
      return false;
    }
  });
  const selected = officialModels.find(({ id, label }) => /flash/i.test(`${id} ${label}`));
  assert.ok(selected, 'The installed Harness must advertise an official DeepSeek Flash model.');
  console.log(`DeepSeek UI: discovered ${report.models.length} real models.`);

  const picker = page.getByRole('combobox', { name: 'Choose model', exact: true });
  const menu = page.getByRole('listbox', { name: 'Choose model', exact: true });
  const composer = page.locator('.chat-panel:visible .composer');
  async function chooseModel(model) {
    await picker.click();
    await menu.getByRole('option', { name: model.label, exact: true }).click();
    assert.equal((await picker.innerText()).trim(), model.label);
  }
  for (const model of officialModels) await chooseModel(model);
  await chooseModel(selected);
  report.selectedModel = selected;
  assert.equal(await page.getByText('Could not load models.', { exact: true }).count(), 0);
  assert.equal(await page.getByText('Default effort', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('combobox', { name: 'Reasoning effort', exact: true }).count(), 0);
  await picker.click();
  await capture('models.png', [composer, menu]);
  await picker.press('Escape');

  const input = page.getByRole('textbox', { name: 'Message your agent', exact: true });
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  await input.fill(prompt);
  assert.equal(await send.isEnabled(), true, 'The selected model must allow submission.');
  const started = performance.now();
  await send.click();
  console.log(`DeepSeek UI: submitted one request using ${selected.label}.`);
  const completed = await waitForAsync(
    page,
    () => {
      const assistant = document.querySelector('.message.assistant[data-latest-response]');
      if (
        !assistant ||
        assistant.querySelector('[data-running]') ||
        document.querySelector('button[aria-label="Stop generation"]')
      )
        return false;
      const text = assistant.querySelector('.agent-answer-part')?.textContent?.trim() ?? '';
      const outcome = assistant.querySelector('[data-outcome]')?.getAttribute('data-outcome');
      const diagnostic = assistant.querySelector('.agent-diagnostic-text')?.textContent?.trim();
      return text || outcome || diagnostic ? { text, outcome, diagnostic } : false;
    },
    undefined,
    { timeout: 180000, polling: 250 },
  );
  report.responseMs = Math.round(performance.now() - started);
  assert.equal(completed.outcome, undefined, 'DeepSeek stopped without completing the response.');
  assert.ok(!completed.diagnostic, 'DeepSeek reported a response diagnostic; see failure.png.');
  assert.equal(
    completed.text === expected,
    true,
    'The completed reply did not match the check marker.',
  );
  assert.deepEqual(requests, [{ provider: 'deepseek', model: selected.id, prompt }]);
  assert.equal(await page.locator('.message.assistant.error').count(), 0);
  assert.equal(await page.getByText('Could not load models.', { exact: true }).count(), 0);
  // An empty draft disables Send normally; verify readiness with an unsent draft.
  await input.fill('Connection check complete.');
  assert.equal(await send.isEnabled(), true, 'Send must be usable after the response completes.');
  await capture('response.png');
  await capture('reply.png', [
    page.locator('.message.user').last(),
    page.locator('.message.assistant[data-latest-response]'),
  ]);
  await capture('composer.png', [composer]);
  await input.fill('');
  report.status = 'passed';
  report.response = completed.text;
  console.log(
    `PASS: real DeepSeek UI discovery, model selection and response (${report.responseMs} ms).`,
  );
} catch (error) {
  report.status = 'failed';
  report.error = publicError(error);
  if (page) await capture('failure.png').catch(() => {});
  throw error;
} finally {
  await writeFile(path.join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  if (page)
    await page
      .getByRole('button', { name: 'Stop generation', exact: true })
      .click({ timeout: 2000 })
      .catch(() => {});
  // These handles belong only to the isolated test instance, never the user's app.
  await application
    .evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
    })
    .catch(() => {});
  await application.close();
}
