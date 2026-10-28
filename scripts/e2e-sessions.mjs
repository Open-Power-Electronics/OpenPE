import { readNativeFiles } from './source-editor-test-helpers.mjs';
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
const runDirectory = path.join(root, 'test-results', `sessions-${Date.now()}`);
const designDirectory = path.join(runDirectory, 'design');
await mkdir(designDirectory, { recursive: true });
const designFile = path.join(designDirectory, 'rectifier.kicad_sch');
await copyFile(path.join(root, 'tests/fixtures/kicad/kicad-rectifier.kicad_sch'), designFile);
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
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.sessionRequests = [];
    window.fetch = async (url, options) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === '/api/agents')
        return Response.json([{ id: 'codex', available: true, supportsEffort: true }]);
      if (pathname === '/api/models') return Response.json({ models: [] });
      if (pathname === '/api/chat') {
        const request = JSON.parse(options.body);
        window.sessionRequests.push(request);
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              const event = (value) =>
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
              event({ type: 'text-delta', delta: `Answer for ${request.prompt}` });
              window.finishSessionResponse = () => {
                event({ type: 'done', outcome: 'completed' });
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
      }
      return original(url, options);
    };
  });
  await page.reload();
  await application.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  }, designFile);
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  const visible = () => page.locator('.chat-panel:visible');
  const input = () => visible().getByLabel('Message your agent', { exact: true });
  const select = async (name) => {
    await page.locator('.project-navigation').getByRole('button', { name, exact: true }).click();
  };
  const openConversation = () =>
    page.locator('.project-navigation > span').first().locator('.project-folder > button').click();
  const send = async (prompt) => {
    await input().fill(prompt);
    await input().press('Enter');
    await visible()
      .locator('.message-text')
      .filter({ hasText: `Answer for ${prompt}` })
      .waitFor();
  };
  const finish = async () => {
    await page.evaluate(() => window.finishSessionResponse());
    await visible().locator('.chat-progress').waitFor({ state: 'detached' });
  };
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  const source = await readNativeFiles(page);
  const initialSessionId = await page.locator('.project-session').getAttribute('data-session-id');
  for (let index = 0; index < 4; index++) await openConversation();
  assert.equal(await page.locator('.project-session').count(), 1);
  assert.equal(
    await page.locator('.project-session').getAttribute('data-session-id'),
    initialSessionId,
  );
  await input().fill('Unsent initial draft');
  await openConversation();
  assert.equal(await input().inputValue(), 'Unsent initial draft');
  await send('First session prompt');
  await page
    .locator('.project-navigation > span')
    .first()
    .locator('.project-folder > button')
    .click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await input().inputValue(), '');
  assert.equal(await visible().locator('.message').count(), 0);
  await input().fill('Second draft');
  await select('First session prompt');
  assert.ok(
    await visible()
      .locator('.message-text')
      .filter({ hasText: 'Answer for First session prompt' })
      .isVisible(),
  );
  await finish();
  await openConversation();
  assert.equal(await page.locator('.project-session').count(), 2);
  assert.equal(await input().inputValue(), 'Second draft');
  await send('Second session prompt');
  await finish();
  await page
    .locator('.project-navigation > span')
    .first()
    .locator('.project-folder > button')
    .click();
  await input().fill('Keep this unsent draft');
  await select('First session prompt');
  await send('Follow up in first');
  await finish();
  const requests = await page.evaluate(() => window.sessionRequests);
  assert.deepEqual(requests[1].history, [], 'New sessions never send another session history.');
  assert.deepEqual(
    requests[2].history.map((message) => message.text),
    ['First session prompt', 'Answer for First session prompt'],
  );
  assert.deepEqual(await readNativeFiles(page), source);
  await openConversation();
  assert.equal(await page.locator('.project-session').count(), 3);
  const deadline = Date.now() + 10000;
  while (true) {
    const persisted = await page.evaluate(async () => {
      const connection = await window.openpe.connection();
      const saved = await (
        await fetch(connection.base + '/api/state', {
          headers: { 'X-OpenPE-Token': connection.token },
        })
      ).json();
      const current = saved?.documents?.find((item) => item.id === saved.activeDocumentId);
      return (
        current?.sessions?.length === 3 &&
        current.sessions[0].messages.length === 4 &&
        current.sessions[0].messages.at(-1)?.outcome === 'completed' &&
        current.sessions.find((item) => item.id === current.activeSessionId)?.draft ===
          'Keep this unsent draft'
      );
    });
    if (persisted) break;
    assert.ok(Date.now() < deadline, 'The latest active session and draft are persisted.');
    await page.waitForTimeout(100);
  }
  await page.reload();
  await input().waitFor();
  assert.equal(await input().inputValue(), 'Keep this unsent draft');
  await select('First session prompt');
  assert.equal(await visible().locator('.message').count(), 4);
  await select('Second session prompt');
  assert.equal(await visible().locator('.message').count(), 2);
  await page.setViewportSize({ width: 1120, height: 760 });
  const header = await visible().locator('.chat-header').boundingBox();
  assert.ok(header.height <= 60, 'Session titles stay on one line in compact windows.');
  await application.evaluate(async ({ BrowserWindow }) => {
    await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, {
      stayHidden: true,
      stayAwake: true,
    });
  });
  await page.waitForTimeout(200);
  const png = await application.evaluate(async ({ BrowserWindow }) =>
    (
      await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, {
        stayHidden: true,
        stayAwake: true,
      })
    )
      .toPNG()
      .toString('base64'),
  );
  await writeFile('test-results/sessions.png', Buffer.from(png, 'base64'));
  assert.deepEqual(errors, []);
  console.log(
    'PASS: immediate new sessions, independent history/drafts, switching during streaming, recovery, unchanged schematic and compact session menu.',
  );
} finally {
  await application
    .evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
    })
    .catch(() => {});
  await application.close();
}
