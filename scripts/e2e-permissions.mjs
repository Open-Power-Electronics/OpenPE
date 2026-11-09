import { readSource, projectHistory, selectSourceFile } from './source-editor-test-helpers.mjs';
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';

const runDirectory = path.resolve('test-results', `permissions-${Date.now()}`);
const designDirectory = path.join(runDirectory, 'design');
await mkdir(designDirectory, { recursive: true });
const designFile = path.join(designDirectory, 'rectifier.kicad_sch');
await copyFile('tests/fixtures/kicad/kicad-rectifier.kicad_sch', designFile);
const application = await electron.launch({
  args: ['.'],
  env: {
    ...process.env,
    OPENPE_TEST: '1',
    OPENPE_DEV_URL: '',
    OPENPE_DATA_DIR: path.join(runDirectory, 'profile'),
  },
});
try {
  const page = await application.firstWindow();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (url, options) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === '/api/agents')
        return Response.json([{ id: 'codex', available: true, supportsEffort: true }]);
      if (pathname === '/api/models')
        return Response.json({
          models: [
            { id: 'fixture-model', label: 'Fixture model', efforts: ['low', 'medium', 'high'] },
          ],
          defaultModel: 'fixture-model',
        });
      if (pathname !== '/api/chat') return original(url, options);
      const request = JSON.parse(options.body);
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            const emit = (event) =>
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            const ops =
              request.prompt === 'invalid'
                ? [{ type: 'unsupported' }]
                : [{ type: 'setValue', ref: 'C1', value: request.prompt }];
            emit({
              type: 'text-delta',
              delta: 'Proposed change.\n```openpe\n' + JSON.stringify(ops) + '\n```',
            });
            window.finishPermissionResponse = (outcome = 'completed') => {
              emit({ type: 'done', outcome });
              controller.close();
            };
            options.signal.addEventListener(
              'abort',
              () => controller.error(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    };
  });
  await page.reload();
  await application.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, designFile);
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  const source = async () => {
    await selectSourceFile(page, 'rectifier.kicad_sch');
    return readSource(page);
  };
  const initial = await source();
  const panel = () => page.locator('.chat-panel:visible');
  const mode = async (label) => {
    await panel().getByRole('combobox', { name: 'Agent permissions', exact: true }).click();
    await page.getByRole('option').filter({ hasText: label }).click();
  };
  const send = async (text) => {
    await panel().getByLabel('Message your agent', { exact: true }).fill(text);
    await panel().getByLabel('Message your agent', { exact: true }).press('Enter');
    await page.waitForFunction(() => !!window.finishPermissionResponse);
    await panel().locator('.message-text').last().filter({ hasText: 'Proposed change.' }).waitFor();
  };
  const finish = async (outcome = 'completed') => {
    await page.evaluate((value) => {
      window.finishPermissionResponse(value);
      window.finishPermissionResponse = null;
    }, outcome);
    await page.locator('.chat-progress').waitFor({ state: 'detached' });
  };
  await send('220uF');
  await mode('Auto');
  await finish();
  assert.equal(
    await source(),
    initial,
    'Changing mode does not approve an already running request.',
  );
  await panel().getByRole('button', { name: 'Apply to schematic', exact: true }).click();
  assert.notEqual(await source(), initial);
  await projectHistory(page, 'Undo');
  assert.equal(await source(), initial);
  await send('330uF');
  await page
    .locator('.project-navigation > span')
    .first()
    .locator('.project-folder > button')
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New session', exact: true }).click();
  await finish();
  assert.ok(
    (await source()).includes('330uF'),
    'Background sessions auto-apply through the current document.',
  );
  await projectHistory(page, 'Undo');
  assert.equal(await source(), initial, 'Automatic changes are one undoable transaction.');
  for (const [prompt, outcome] of [
    ['invalid', 'completed'],
    ['470uF', 'failed'],
    ['680uF', 'cancelled'],
  ]) {
    await send(prompt);
    await finish(outcome);
    assert.equal(await source(), initial);
  }
  await send('820uF');
  await projectHistory(page, 'Redo');
  const edited = await source();
  await finish();
  assert.equal(await source(), edited, 'Stale proposals cannot overwrite intervening edits.');
  await page.waitForTimeout(1000);
  await page.reload();
  await panel().getByRole('combobox', { name: 'Agent permissions', exact: true }).waitFor();
  assert.match(
    await panel()
      .getByRole('combobox', { name: 'Agent permissions', exact: true })
      .getAttribute('aria-description'),
    /Auto/,
  );
  await page.setViewportSize({ width: 1120, height: 760 });
  await page
    .locator('.project-navigation > span')
    .first()
    .locator('.project-folder > button')
    .click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'New session', exact: true }).click();
  await page.waitForTimeout(5600);
  await panel().getByRole('combobox', { name: 'Agent permissions', exact: true }).click();
  const box = await page.getByRole('listbox').boundingBox();
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1120 && box.y + box.height <= 760);
  const capture = () =>
    application.evaluate(async ({ BrowserWindow }) =>
      (
        await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, {
          stayHidden: true,
          stayAwake: true,
        })
      )
        .toPNG()
        .toString('base64'),
    );
  await capture();
  await page.waitForTimeout(200);
  await writeFile('test-results/permissions.png', Buffer.from(await capture(), 'base64'));
  await page.keyboard.press('Escape');
  await page.getByRole('combobox', { name: 'Choose agent', exact: true }).click();
  await capture();
  await page.waitForTimeout(200);
  await writeFile('test-results/permission-agents.png', Buffer.from(await capture(), 'base64'));
  assert.deepEqual(errors, []);
  console.log(
    'PASS: manual review, send-time mode, background automatic apply, undo, invalid/failed/cancelled/stale protection, recovery and compact permission menu.',
  );
} finally {
  await application
    .evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
    })
    .catch(() => {});
  await application.close();
}
