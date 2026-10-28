import { fileMenuAction } from './file-menu-test-helpers.mjs';
// Explicit opt-in desktop coverage; never part of npm test.
import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  fillSource,
  readSource,
  projectHistory,
  selectSourceFile,
  readNativeProject,
} from './source-editor-test-helpers.mjs';
import { projectFromNativeFiles } from '../server/project-format.mjs';
import { waitForAsync } from './async-browser-test-helpers.mjs';
import { observeWorkspaceRecovery } from './workspace-recovery-test-helpers.mjs';
import { createHash } from 'node:crypto';

const homeManifest = JSON.parse(
  await readFile('resources/example-catalog/home-manifest.json', 'utf8'),
);
const homeExampleCount = homeManifest.recent.length + homeManifest.examples.length;
const dir = path.resolve('test-results', `workspace-${Date.now()}`);
await mkdir(dir, { recursive: true });
const files = {};
const nativeFiles = {};
const diskProject = async (name) =>
  projectFromNativeFiles({
    entry: `Project ${name}.kicad_pro`,
    files: await Promise.all(
      Object.keys(nativeFiles[name]).map(async (filename) => ({
        name: filename,
        source: await readFile(path.join(path.dirname(files[name]), filename), 'utf8'),
      })),
    ),
  });
for (const name of ['A', 'B']) {
  const destination = path.join(dir, name);
  await mkdir(destination);
  nativeFiles[name] = {
    [`Project ${name}.kicad_pro`]:
      JSON.stringify({
        meta: { filename: `Project ${name}.kicad_pro` },
        text_variables: { NOTE: `Project ${name} native settings` },
      }) + '\n',
    [`Project ${name}.kicad_sch`]: await readFile('tests/fixtures/rc-filter.kicad_sch', 'utf8'),
    [`Project ${name}.kicad_pcb`]: await readFile('tests/fixtures/rc-filter.kicad_pcb', 'utf8'),
  };
  files[name] = path.join(destination, `Project ${name}.kicad_pro`);
  await Promise.all(
    Object.entries(nativeFiles[name]).map(([filename, source]) =>
      writeFile(path.join(destination, filename), source),
    ),
  );
}
const original = await diskProject('A');
const app = await electron.launch({
  args: ['.'],
  env: {
    ...process.env,
    OPENPE_TEST: '1',
    OPENPE_DEV_URL: '',
    OPENPE_DATA_DIR: path.join(dir, 'profile'),
  },
});
let closedNormally = false;
let recoveryObserver;
try {
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  page.setDefaultTimeout(30_000);
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:/);
  await page.waitForLoadState('domcontentloaded');
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  recoveryObserver = await observeWorkspaceRecovery(app, page, path.join(dir, 'profile'));
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('startup-preview-checked')) {
      const requestIdle = window.requestIdleCallback.bind(window);
      const cancelIdle = window.cancelIdleCallback.bind(window);
      const queued = new Map();
      let serial = 0;
      window.requestIdleCallback = (callback, options) => {
        const id = --serial;
        queued.set(id, [callback, options]);
        return id;
      };
      window.cancelIdleCallback = (id) => queued.delete(id);
      window.releaseStartupPreviews = () => {
        sessionStorage.setItem('startup-preview-checked', 'true');
        window.requestIdleCallback = requestIdle;
        window.cancelIdleCallback = cancelIdle;
        for (const [callback, options] of queued.values()) requestIdle(callback, options);
        queued.clear();
      };
    }
    const recoveryGate = sessionStorage.getItem('recovery-loading-checked')
      ? Promise.resolve()
      : new Promise((resolve) => {
          window.releaseWorkspaceRecovery = () => {
            sessionStorage.setItem('recovery-loading-checked', 'true');
            resolve();
          };
        });
    const fetchOriginal = window.fetch.bind(window);
    window.fetch = async (url, options) => {
      const pathname = new URL(String(url), window.location.href).pathname;
      if (pathname === '/api/state' && (!options?.method || options.method === 'GET'))
        await recoveryGate;
      if (pathname === '/api/agents')
        return Response.json([{ id: 'codex', available: true, supportsEffort: true }]);
      if (pathname === '/api/models') return Response.json({ models: [] });
      if (pathname === '/api/chat') {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              const send = (value) =>
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
              send({ type: 'text-delta', delta: 'Project A response' });
              window.finishProjectResponse = () => {
                send({ type: 'done', outcome: 'completed' });
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
      return fetchOriginal(url, options);
    };
  });
  await page.getByRole('region', { name: 'Welcome to OpenPE', exact: true }).waitFor();
  await page.reload();
  const loading = page.getByRole('status', { name: 'Loading workspace', exact: true });
  await loading.waitFor();
  const loadingBounds = await loading.boundingBox();
  const textBounds = await loading.locator('p').boundingBox();
  assert.ok(Math.abs(textBounds.x + textBounds.width / 2 - loadingBounds.width / 2) < 2);
  assert.ok(Math.abs(textBounds.y - (loadingBounds.y + loadingBounds.height / 2)) < 50);
  await page.evaluate(() => window.releaseWorkspaceRecovery());
  await page.getByRole('region', { name: 'Welcome to OpenPE', exact: true }).waitFor();
  assert.equal(await page.locator('.home-example').count(), homeExampleCount);
  assert.equal(await page.locator('.home-example-preview svg').count(), 0);
  const brief = page.locator('.home-layout textarea');
  await brief.fill('Startup remains interactive');
  assert.equal(await brief.inputValue(), 'Startup remains interactive');
  await page.evaluate(() => window.releaseStartupPreviews());
  await page.waitForFunction(
    (count) => document.querySelectorAll('.home-example-preview svg').length === count,
    homeExampleCount,
  );
  assert.equal(await brief.inputValue(), 'Startup remains interactive');
  await brief.fill('');
  const button = (name) => page.getByRole('button', { name, exact: true });
  const projects = () => page.getByRole('group', { name: 'Open projects', exact: true });
  const select = (name) =>
    projects()
      .getByRole('button', { name: new RegExp(`^Project ${name},`) })
      .click();
  const open = async (name) => {
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, files[name]);
    await button('Open project').click();
    await projects()
      .getByRole('button', { name: new RegExp(`^Project ${name},`) })
      .waitFor();
  };
  await open('A');
  const projectEntry = projects().getByRole('button', { name: /^Project A,/ });
  const railWidth = await projects().evaluate((element) => element.clientWidth);
  await projectEntry.hover();
  assert.equal(await page.locator('.project-name-reveal').count(), 0);
  assert.equal(await projectEntry.getAttribute('title'), 'Project A');
  assert.match(await projectEntry.getAttribute('aria-label'), /^Project A,/);
  assert.equal(await projects().evaluate((element) => element.clientWidth), railWidth);
  await projectEntry.click();
  assert.equal(await projectEntry.getAttribute('aria-current'), 'page');
  await page.mouse.move(500, 400);
  // Subframe loading must not revoke the still-mounted workspace's grants.
  // The native saves below verify that A keeps its original destination.
  await page.evaluate(async () => {
    const frame = document.createElement('iframe');
    frame.hidden = true;
    const loaded = new Promise((resolve) =>
      frame.addEventListener('load', resolve, { once: true }),
    );
    frame.srcdoc = '<!doctype html><title>Grant lifecycle check</title>';
    document.body.appendChild(frame);
    await loaded;
    frame.remove();
    const grant = await window.openpe.newFile();
    await window.openpe.releaseFile(grant);
    await window.openpe.releaseFile(grant);
  });
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  await page.getByLabel('Message your agent', { exact: true }).fill('Analyze project A');
  await button('Send message').click();
  await page.getByText('Project A response', { exact: true }).waitFor();
  await button('Source').click();
  await selectSourceFile(page, 'Project A.kicad_sch');
  await fillSource(
    page,
    (await readSource(page)).replace('(property "Value" "1k"', '(property "Value" "2k"'),
  );
  await button('Apply').click();
  const canonicalA = await readSource(page);
  await fillSource(page, '{unfinished A');
  await open('B');
  assert.equal(await projects().getByRole('button').count(), 2);
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.getByLabel('Message your agent', { exact: true }).fill('B composer draft');
  await page.evaluate(() => window.finishProjectResponse());
  assert.equal(
    await page.locator('.message').count(),
    0,
    'The response belongs only to project A.',
  );
  await button('Source').click();
  await selectSourceFile(page, 'Project B.kicad_sch');
  await fillSource(
    page,
    (await readSource(page)).replace('(property "Value" "1k"', '(property "Value" "3k"'),
  );
  await fileMenuAction(page, 'Save');
  await page.getByRole('status').filter({ hasText: 'Save project' }).waitFor();
  assert.equal(
    (await diskProject('B')).schematic.parts.find((part) => part.ref === 'R1').value,
    '3k',
  );
  assert.equal(
    (await diskProject('A')).schematic.parts.find((part) => part.ref === 'R1').value,
    original.schematic.parts.find((part) => part.ref === 'R1').value,
  );
  await select('A');
  assert.equal(await readSource(page), '{unfinished A');
  await page.getByText('Project A response', { exact: true }).waitFor();
  await fillSource(page, canonicalA);
  await projectHistory(page, 'Undo');
  assert.equal(
    (await readNativeProject(page)).schematic.parts.find((part) => part.ref === 'R1').value,
    original.schematic.parts.find((part) => part.ref === 'R1').value,
  );
  await projectHistory(page, 'Redo');
  await fileMenuAction(page, 'Save');
  await page.getByRole('status').filter({ hasText: 'Save project' }).waitFor();
  assert.equal(
    (await diskProject('A')).schematic.parts.find((part) => part.ref === 'R1').value,
    '2k',
  );
  await select('B');
  assert.equal(
    await page.getByLabel('Message your agent', { exact: true }).inputValue(),
    'B composer draft',
  );
  await open('A');
  assert.equal(
    await projects().getByRole('button').count(),
    2,
    'Opening the same granted file selects it.',
  );
  await page.locator('.nav-rail').getByRole('button', { name: 'New project', exact: true }).click();
  await projects().getByRole('button').nth(2).waitFor();
  assert.equal(await projects().getByRole('button').count(), 3);
  assert.equal(await page.locator('.file-tab .dirty-dot').count(), 0);
  const newProjectId = await page
    .locator('.project-navigation [aria-current="page"]')
    .evaluate((element) => element.closest('[data-project-id]').dataset.projectId);
  await select('A');
  await page.locator(`[data-project-id="${newProjectId}"] button`).click({ button: 'right' });
  const fileMenu = page.getByRole('menu', { name: 'Project file actions', exact: true });
  await fileMenu.waitFor();
  assert.equal(await projects().getByRole('button').count(), 3, 'Right-click only opens the menu.');
  await fileMenu.getByRole('menuitem', { name: 'Close project', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.project-navigation button').length === 2,
  );
  assert.equal(await page.getByRole('dialog').count(), 0, 'Unedited new projects close directly.');
  assert.match(
    await page.locator('.project-navigation [aria-current="page"]').getAttribute('aria-label'),
    /^Project A,/,
  );
  // Keyboard menu invocation and copying must preserve the original Source draft.
  await selectSourceFile(page, 'Project A.kicad_pro');
  const draftCopy = JSON.parse(await readSource(page));
  draftCopy.text_variables.NOTE = 'Native settings draft retained during duplication';
  const copyText = JSON.stringify(draftCopy, null, 2);
  await fillSource(page, copyText);
  const originalButton = projects().getByRole('button', { name: /^Project A,/ });
  await originalButton.focus();
  await originalButton.press('Shift+F10');
  await fileMenu.getByRole('menuitem', { name: 'Duplicate project', exact: true }).click();
  await projects()
    .getByRole('button', { name: /^Project A copy,/ })
    .waitFor();
  await button('Source').click();
  await selectSourceFile(page, 'Project A-copy.kicad_pro');
  const copied = JSON.parse(await readSource(page));
  assert.equal(copied.text_variables.NOTE, draftCopy.text_variables.NOTE);
  assert.equal(
    (await readNativeProject(page)).schematic.parts.find((part) => part.ref === 'R1').value,
    '2k',
  );
  await fileMenuAction(page, 'Close project');
  await projects().getByRole('button').nth(2).waitFor({ state: 'detached' });
  await select('A');
  assert.equal(await readSource(page), copyText);
  const recoveryDraft = `{recover A ${Date.now()}`;
  const beforeDraftWrite = (await recoveryObserver.snapshot()).sequence;
  await fillSource(page, recoveryDraft);
  await recoveryObserver.waitForState(
    (state) =>
      state?.documents?.some(
        (item) =>
          item.id === state.activeDocumentId &&
          item.sourceDraft &&
          JSON.parse(item.sourceDraft).files.some((file) => file.source === recoveryDraft),
      ),
    { after: beforeDraftWrite },
  );
  await waitForAsync(
    page,
    async (recoveryDraft) => {
      const c = await window.openpe.connection();
      const state = await (
        await fetch(c.base + '/api/state', {
          cache: 'no-store',
          headers: { 'X-OpenPE-Token': c.token },
        })
      ).json();
      return (
        state?.documents?.length === 2 &&
        state.documents.some(
          (item) =>
            item.id === state.activeDocumentId &&
            item.sourceDraft &&
            JSON.parse(item.sourceDraft).files.some((file) => file.source === recoveryDraft),
        )
      );
    },
    recoveryDraft,
  );
  await page.reload();
  await page.getByRole('textbox', { name: 'Project file source', exact: true }).waitFor();
  assert.equal(await readSource(page), recoveryDraft);
  assert.equal(await projects().getByRole('button').count(), 2);
  await select('B');
  assert.equal(
    await page.locator('.file-tab .dirty-dot').count(),
    0,
    'Clean recovery stays clean.',
  );
  await button('Source').click();
  await fillSource(page, (await readSource(page)) + '\n');
  await select('A');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  const confirmation = page.getByRole('dialog', { name: 'Save changes?', exact: true });
  await confirmation.getByRole('button', { name: 'Save', exact: true }).click();
  await confirmation.getByRole('alert').filter({ hasText: 'Fix the source errors' }).waitFor();
  await confirmation.getByRole('button', { name: "Don't save", exact: true }).click();
  await confirmation.getByText('Project B', { exact: true }).waitFor();
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(
    app.windows().length,
    1,
    'Cancelling the second project keeps the whole workspace open.',
  );
  await projects()
    .getByRole('button', { name: /^Project A,/ })
    .click({ button: 'right' });
  await fileMenu.getByRole('menuitem', { name: 'Close project', exact: true }).click();
  await confirmation.getByText('Project A', { exact: true }).waitFor();
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await readSource(page), recoveryDraft);
  await projects()
    .getByRole('button', { name: /^Project A,/ })
    .click({ button: 'right' });
  await fileMenu.getByRole('menuitem', { name: 'Close project', exact: true }).click();
  await confirmation.getByRole('button', { name: "Don't save", exact: true }).click();
  await projects().getByRole('button').nth(1).waitFor({ state: 'detached' });
  assert.equal(await projects().getByRole('button').count(), 1);
  assert.equal(
    await page.getByLabel('Message your agent', { exact: true }).inputValue(),
    'B composer draft',
  );
  await button('Source').click();
  assert.equal(
    (await readNativeProject(page)).schematic.parts.find((part) => part.ref === 'R1').value,
    '3k',
  );
  await page.locator('.nav-rail').getByRole('button', { name: 'New project', exact: true }).click();
  await projects().getByRole('button').nth(1).waitFor();
  await button('Source').click();
  const projectFile = page
    .getByRole('navigation', { name: 'Project files', exact: true })
    .locator('button[data-source-file$=".kicad_pro"]');
  await projectFile.waitFor();
  assert.equal(await projectFile.count(), 1);
  const projectFileName = await projectFile.getAttribute('data-source-file');
  assert.ok(projectFileName, 'The new project exposes its actual native project filename.');
  await selectSourceFile(page, projectFileName);
  const freshSettings = JSON.parse(await readSource(page));
  freshSettings.text_variables = { NOTE: 'Edited project before quit' };
  await fillSource(page, JSON.stringify(freshSettings, null, 2));
  await button('Apply').click();
  // A real native validation rejection must retain stored bytes, keep the
  // confirmation open, and permit retry through the original trusted handler.
  const beforeClear = await recoveryObserver.armClearValidationFailure();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await confirmation.getByText('Project B', { exact: true }).waitFor();
  await confirmation.getByRole('button', { name: "Don't save", exact: true }).click();
  await confirmation.getByText('Project B', { exact: true }).waitFor({ state: 'detached' });
  await confirmation.getByRole('button', { name: "Don't save", exact: true }).click();
  await confirmation
    .getByRole('alert')
    .filter({ hasText: 'Test recovery cleanup failure' })
    .waitFor();
  const failedClear = await recoveryObserver.snapshot();
  assert.equal(failedClear.validationFaultRejected, true);
  assert.equal(failedClear.unexpectedValidationSuccess, false);
  assert.equal(failedClear.faultFileUnchanged, true);
  assert.equal(failedClear.faultBeforeSha256, failedClear.faultAfterSha256);
  assert.equal(
    createHash('sha256')
      .update(await readFile(recoveryObserver.stateFile))
      .digest('hex'),
    failedClear.faultBeforeSha256,
  );
  assert.equal(failedClear.failed, beforeClear.failed + 1);
  assert.equal(failedClear.completedClears, beforeClear.completedClears);
  assert.equal(
    (await recoveryObserver.evidence()).httpWrites,
    0,
    'Native failure must not retry via HTTP.',
  );
  const exited = app.waitForEvent('close');
  await confirmation.getByRole('button', { name: "Don't save", exact: true }).click();
  await exited;
  closedNormally = true;
  const recovered = await recoveryObserver.evidence();
  assert.equal(recovered.completedClears, beforeClear.completedClears + 1);
  assert.equal(recovered.failed, beforeClear.failed + 1);
  assert.equal(recovered.active, 0);
  assert.equal(recovered.truncated || recovered.metadataWriteFailed, false);
  assert.equal(recovered.httpWrites, 0);
  assert.equal(
    JSON.parse(await readFile(path.join(dir, 'profile', 'openpe-workspace-v2.json'), 'utf8')),
    null,
    'Discarding every reviewed project atomically clears the recovery envelope.',
  );
  assert.equal(
    (await diskProject('B')).schematic.parts.find((part) => part.ref === 'R1').value,
    '3k',
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: independent projects, native destinations, Source drafts, history, detached Agent streams, recovery, multi-project close cancellation and Don't save quit with cleanup retry.",
  );
} catch (error) {
  const page = app.windows()[0];
  if (page) {
    await page.screenshot({ path: path.join(dir, 'failure.png') }).catch(() => {});
    await writeFile(path.join(dir, 'failure.txt'), await page.locator('body').innerText()).catch(
      () => {},
    );
  }
  throw error;
} finally {
  await recoveryObserver?.restore().catch(() => {});
  if (!closedNormally) {
    await app
      .evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().forEach((window) => window.destroy()),
      )
      .catch(() => {});
    await app.close().catch(() => {});
  }
}
