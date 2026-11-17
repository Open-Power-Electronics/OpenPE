// Real DesktopWorkspace, Workbench and Core, with an in-renderer SSE fixture.
// No Electron, installed provider, external service or solver is launched.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { bundledWorkbenchCatalog } from '../server/workbench-plugins.mjs';

import { fillSource, readSource, selectSourceFile } from './source-editor-test-helpers.mjs';

const { switchingStageFixture } = await tsImport(
  '../tests/fixtures/switching-stage.ts',
  import.meta.url,
);
const { createProject, serializeProject, parseProject } = await tsImport(
  '../lib/project.ts',
  import.meta.url,
);
const { defaultAgentPreferences } = await tsImport('../lib/workspace-state.ts', import.meta.url);
const { defaultAppearance } = await tsImport('../lib/appearance.ts', import.meta.url);
const project = createProject(switchingStageFixture());
const target = project.schematic.parts.find((part) => part.ref === 'R1');
assert.ok(target);
const source = serializeProject(project);
const documentId = '00000000-0000-4000-8000-000000000001';
let state = {
  version: 2,
  documents: [
    {
      id: documentId,
      source,
      sourceDraft: null,
      dirty: false,
      filename: 'tools.kicad_pro',
      sessions: [{ id: 'tools-session', messages: [], draft: '' }],
      activeSessionId: 'tools-session',
    },
  ],
  activeDocumentId: documentId,
  provider: 'codex',
  effort: 'low',
  approvalMode: 'review',
  models: defaultAgentPreferences.models,
};
const bundle = await build({
  stdin: {
    contents:
      "import React from 'react'; import {createRoot} from 'react-dom/client'; import Workspace from './components/DesktopWorkspace'; createRoot(document.getElementById('root')).render(<React.StrictMode><Workspace/></React.StrictMode>);",
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outdir: 'test-results/agent-tools-ui-bundle',
  platform: 'browser',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
async function runChecks() {
  const page = await browser.newPage({ viewport: { width: 1480, height: 920 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.openpe = {
      titleBarOverlay: false,
      writeWorkspaceRecovery: async (content) => {
        await fetch('http://localhost/api/state', {
          method: content === null ? 'DELETE' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: content ?? undefined,
        });
      },
      connection: async () => ({ base: 'http://localhost', token: 'fixture' }),
      newFile: async () => crypto.randomUUID(),
      listExamples: async () => ({ entries: [], warnings: [] }),
      listRecent: async () => ({ initialized: true, entries: [], warnings: [] }),
      onRecentChanged: () => () => {},
      projectDirectory: async () => ({ entries: [], truncated: false }),
      releaseFile: async () => {},
      setDirty: async () => {},
      onCloseRequested: () => () => {},
    };
    const originalFetch = window.fetch.bind(window);
    const encoder = new TextEncoder();
    window.toolResponses = [];
    window.copies = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text) => window.copies.push(text) },
    });
    window.chatRequests = [];
    window.toolPlan = [];
    let controller, sessionId, runId, requestId, token, remaining;
    const emit = (event) =>
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    const next = () => {
      const step = remaining.shift();
      if (!step) {
        if (window.pauseToolCompletion) {
          window.resumeToolCompletion = () => {
            window.pauseToolCompletion = false;
            next();
          };
          return;
        }
        emit({ type: 'text', text: window.toolReply || 'Runtime fixture completed.' });
        window.toolReply = '';
        emit({ type: 'done', outcome: window.toolOutcome || 'completed' });
        window.toolOutcome = undefined;
        controller.close();
        return;
      }
      if (step.type) {
        emit(step);
        queueMicrotask(next);
        return;
      }
      requestId = crypto.randomUUID();
      token = crypto.randomUUID();
      const event = { type: 'capability-request', sessionId, runId, requestId, token, ...step };
      emit(event);
      if (window.duplicateNextTool) {
        window.duplicateNextTool = false;
        emit(event);
      }
    };
    window.fetch = async (url, options) => {
      const pathname = new URL(String(url), location.href).pathname;
      if (pathname === '/api/chat') {
        const body = JSON.parse(options.body);
        window.chatRequests.push(body);
        if (!body.capabilities)
          throw new Error('The Workbench did not expose its capability host.');
        sessionId = body.sessionId;
        runId = crypto.randomUUID();
        remaining = structuredClone(window.toolPlan);
        const stream = new ReadableStream({
          start(value) {
            controller = value;
            queueMicrotask(next);
          },
          cancel() {},
        });
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (pathname === '/api/chat/tool-result') {
        const body = JSON.parse(options.body);
        if (
          body.sessionId !== sessionId ||
          body.runId !== runId ||
          body.requestId !== requestId ||
          body.token !== token
        )
          throw new Error('Capability response lost its originating identity.');
        window.toolResponses.push(body);
        const rejectDelivery = window.toolResponses.length === window.rejectToolDeliveryAt;
        setTimeout(next, 0);
        if (rejectDelivery)
          return new Response('{"error":"Fixture delivery failure"}', { status: 503 });
        return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(url, options);
    };
  });
  await page.route('http://localhost/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/state') {
      if (route.request().method() === 'POST') state = route.request().postDataJSON();
      return route.fulfill({ json: state });
    }
    if (pathname === '/api/agent-settings')
      return route.fulfill({ json: { followUpMode: 'queue' } });
    if (pathname === '/api/appearance') return route.fulfill({ json: defaultAppearance });
    if (pathname === '/api/agents')
      return route.fulfill({ json: [{ id: 'codex', available: true, supportsEffort: true }] });
    if (pathname === '/api/models')
      return route.fulfill({
        json: {
          models: [
            { id: 'fixture-model', label: 'Fixture model', efforts: ['low', 'medium', 'high'] },
          ],
          defaultModel: 'fixture-model',
        },
      });
    if (pathname === '/api/workbench-plugins')
      return route.fulfill({ json: bundledWorkbenchCatalog() });
    if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(pathname))
      return route.fulfill({
        body: await readFile('public' + pathname),
        contentType: pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
      });
    if (pathname.startsWith('/api/')) throw new Error(`Unexpected service call: ${pathname}`);
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page
    .getByTestId('schematic-canvas')
    .waitFor()
    .catch(async (error) => {
      throw new Error(
        `${error.message}\n${errors.join('\n')}\n${await page.locator('body').innerText()}`,
      );
    });
  const button = (name) => page.getByRole('button', { name, exact: true });
  await page
    .getByRole('textbox', { name: 'Message your agent' })
    .waitFor()
    .catch(async (error) => {
      throw new Error(
        `${error.message}\n${errors.join('\n')}\n${await page.locator('body').innerText()}`,
      );
    });
  async function send(plan) {
    const before = await page.evaluate(() => window.toolResponses.length);
    await page.evaluate((value) => {
      window.toolPlan = value;
    }, plan);
    await page
      .getByRole('textbox', { name: 'Message your agent' })
      .fill('Execute the controlled capability plan.');
    await button('Send message').click();
    await page.waitForFunction(
      (count) => window.toolResponses.length >= count,
      before + plan.filter((step) => step.tool).length,
    );
    await button('Send message').waitFor();
    return page.evaluate((index) => window.toolResponses.slice(index), before);
  }
  const query = (name, input) => ({
    tool: 'openpe_query',
    arguments: { name, ...(input === undefined ? {} : { input }) },
  });
  const execute = (name, input) => ({
    tool: 'openpe_execute',
    arguments: {
      name,
      ...(input === undefined ? {} : { input }),
    },
  });
  const snapshot = async () => (await send([query('project.snapshot')]))[0].result;
  const readPart = (snapshot) =>
    parseProject(JSON.stringify(snapshot.project)).schematic.parts.find(
      (part) => part.id === target.id,
    );
  await page.evaluate(() => {
    window.toolReply =
      '```openpe_session\n{"title":"Capability review"}\n```\nRuntime fixture completed.';
  });
  let current = await snapshot();
  await page.getByRole('heading', { name: 'Capability review', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.chatRequests[0].requestTitle), true);
  assert.ok(
    await page.evaluate(
      () =>
        parseFloat(getComputedStyle(document.querySelector('.session-title')).fontSize) >
        parseFloat(getComputedStyle(document.querySelector('.agent-markdown')).fontSize),
    ),
  );
  assert.equal(readPart(current).value, target.value);
  await page.locator('.message.assistant').first().locator('.agent-process > summary').click();
  await page.locator('.message.assistant').first().locator('.agent-tool-history > summary').click();
  const firstTool = page.locator('.agent-tool-call').first();
  assert.equal(await firstTool.getAttribute('data-tool-status'), 'completed');
  assert.ok(
    (await firstTool.boundingBox()).height <= 36,
    'Settled tools use a single compact row.',
  );
  assert.doesNotMatch(await firstTool.innerText(), /openpe_query|<1s|Completed/);
  const firstReply = page.locator('.message.assistant').first();
  assert.equal(await firstReply.locator('.agent-file-changes').count(), 0);
  assert.ok(
    await firstReply.evaluate((reply) => {
      const tool = reply.querySelector('.agent-tool-list');
      const body = reply.querySelector('.agent-markdown');
      return (
        Boolean(tool.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING) &&
        reply.querySelector('.agent-answer-part').nextElementSibling.matches('.message-actions')
      );
    }),
    'Tool activity precedes the answer; an unchanged reply has no file footer.',
  );
  await firstTool.locator('summary').click();
  await page.evaluate(() => {
    window.pauseToolCompletion = true;
    window.resumeToolCompletion = null;
  });
  const timelineRun = send([
    { type: 'text', text: 'Before tools.' },
    { type: 'process', id: 'phase-one', text: 'Reading project' },
    ...Array.from({ length: 7 }, () => query('core.state')),
    { type: 'process', id: 'phase-two', text: 'Checking results' },
    query('project.snapshot'),
    { type: 'process', id: 'phase-one', text: 'Project inspected' },
    { type: 'text', text: 'Between batches.' },
    query('core.state'),
  ]);
  await page.waitForFunction(() => typeof window.resumeToolCompletion === 'function');
  const liveWork = page.locator('.message.assistant').last().locator('.agent-process');
  assert.equal(await liveWork.count(), 1);
  assert.equal(await liveWork.getAttribute('data-running'), 'true');
  assert.equal(
    await liveWork.locator(':scope > summary').count(),
    0,
    'Live work needs no Working row.',
  );
  await liveWork.locator('.agent-process-body').waitFor();
  assert.match(await liveWork.innerText(), /Before tools\.|Checking results/);
  assert.equal(await liveWork.locator('.agent-tool-call:visible').count(), 0);
  assert.equal(await liveWork.locator('.agent-tool-history:not([open])').count(), 3);
  assert.doesNotMatch(await liveWork.innerText(), /earlier tool|Needs attention/);
  assert.equal(
    await liveWork
      .locator('.agent-process-body')
      .evaluate((element) => getComputedStyle(element).maxHeight),
    'none',
  );
  await page.evaluate(() => window.resumeToolCompletion());
  await timelineRun;
  const timelineReply = page.locator('.message.assistant').last();
  assert.equal(await timelineReply.locator('.agent-process[open]').count(), 0);
  assert.equal(await timelineReply.locator('.agent-process').count(), 1);
  assert.equal(
    await timelineReply.locator('.agent-answer-part').innerText(),
    'Runtime fixture completed.',
  );
  assert.ok(
    (await timelineReply.boundingBox()).height < 150,
    'Completed work leaves room for the answer.',
  );
  await mkdir('test-results/agent-tools', { recursive: true });
  await timelineReply.screenshot({ path: 'test-results/agent-tools/compact.png' });
  const workSummary = timelineReply.locator('.agent-process > summary');
  assert.equal(await workSummary.locator('svg').count(), 0);
  assert.equal(await timelineReply.locator('.message-author .message-timing').count(), 1);
  assert.equal(await workSummary.locator('.message-agent-name').innerText(), 'Codex');
  await workSummary.getByLabel('Elapsed time', { exact: true }).waitFor();
  assert.doesNotMatch(await workSummary.innerText(), /Work details/);
  await workSummary.focus();
  await workSummary.dispatchEvent('keydown', { key: 'Enter', isComposing: true, keyCode: 229 });
  await workSummary.dispatchEvent('keyup', { key: 'Enter', isComposing: true, keyCode: 229 });
  assert.equal(
    await timelineReply.locator('.agent-process[open]').count(),
    0,
    'IME cannot toggle completed work.',
  );
  for (const summary of await timelineReply.locator('.agent-process > summary').all()) {
    await summary.click();
    await summary.locator('..').locator('.agent-process-body').waitFor();
  }
  assert.deepEqual(
    await timelineReply.evaluate((reply) =>
      [...reply.querySelectorAll('.agent-answer-part, .agent-process-text, .agent-tool-list')].map(
        (element) =>
          element.matches('.agent-tool-list')
            ? `tools:${element.dataset.toolCount}`
            : element.textContent.trim(),
      ),
    ),
    [
      'Before tools.',
      'Project inspected',
      'tools:7',
      'Checking results',
      'tools:1',
      'Between batches.',
      'tools:1',
      'Runtime fixture completed.',
    ],
  );
  assert.equal(await timelineReply.locator('.agent-tool-call:visible').count(), 0);
  await timelineReply.locator('.agent-tool-history > summary').first().click();
  const carousel = timelineReply.locator('.agent-tool-history-body').first();
  assert.ok((await timelineReply.locator('.agent-process-body').boundingBox()).height <= 362);
  assert.equal(
    await carousel.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const visible = [...element.querySelectorAll('.agent-tool-call')].filter((row) => {
        const box = row.getBoundingClientRect();
        return box.bottom > bounds.top + 1 && box.top < bounds.bottom - 1;
      });
      return (
        visible.length === 5 && element.scrollTop > 0 && element.scrollHeight > element.clientHeight
      );
    }),
    true,
  );
  await carousel.evaluate((element) => {
    element.scrollTop = 0;
  });
  assert.equal(await carousel.evaluate((element) => element.scrollTop), 0);
  await mkdir('test-results/agent-tools', { recursive: true });
  await timelineReply.screenshot({ path: 'test-results/agent-tools/timeline.png' });
  assert.equal(await timelineReply.locator('.agent-tool-issues').count(), 0);
  await page.evaluate(() => {
    window.pauseToolCompletion = true;
    window.resumeToolCompletion = null;
    window.rejectToolDeliveryAt = window.toolResponses.length + 8;
    window.toolOutcome = 'failed';
  });
  const issueRun = send([
    query(''),
    ...Array.from({ length: 20 }, (_, index) => ({
      type: 'process',
      id: `issue-note-${index}`,
      text: `Checking operating conditions before delivery ${index}.`,
    })),
    ...Array.from({ length: 6 }, () => query('core.state')),
    query('core.state'),
    ...Array.from({ length: 6 }, () => query('core.state')),
  ]);
  await page.waitForFunction(() => typeof window.resumeToolCompletion === 'function');
  const issueReply = page.locator('.message.assistant').last();
  const issueGroups = issueReply.locator('.agent-tool-history > summary');
  const executionIssue = { name: '1 tool failed', exact: true };
  const deliveryIssue = { name: '1 result delivery error', exact: true };
  await issueGroups.first().getByRole('img', executionIssue).waitFor();
  await issueGroups.last().getByRole('img', deliveryIssue).waitFor();
  assert.equal(await issueReply.locator('.agent-tool-history[open]').count(), 0);
  assert.equal(await issueReply.locator('.agent-tool-call').count(), 0);
  await page.evaluate(() => window.resumeToolCompletion());
  const responsesWithIssues = await issueRun;
  const hostFailure = responsesWithIssues[0];
  const deliveryFailure = responsesWithIssues[7];
  assert.match(hostFailure.error, /capability name is required/);
  assert.ok(deliveryFailure.result && !deliveryFailure.error);
  const issueSummary = issueReply.locator('.agent-process > summary');
  const aggregate = issueSummary.getByRole('img', {
    name: '1 tool failed, 1 result delivery error',
    exact: true,
  });
  await aggregate.waitFor();
  const failedTurn = issueSummary.getByText('Failed', { exact: true });
  await failedTurn.waitFor();
  assert.equal(await aggregate.textContent(), '2');
  assert.deepEqual((await issueSummary.getAttribute('aria-describedby')).split(' '), [
    await failedTurn.getAttribute('id'),
    await aggregate.getAttribute('id'),
  ]);
  assert.equal(await issueReply.locator('.agent-process-body').count(), 0);
  await issueSummary.press('Enter');
  await issueGroups.first().getByRole('img', executionIssue).waitFor();
  await issueGroups.last().getByRole('img', deliveryIssue).waitFor();
  const issueWork = issueReply.locator('.agent-process-body');
  await page.waitForFunction(() => {
    const reply = Array.from(document.querySelectorAll('.message.assistant')).at(-1);
    const work = reply.querySelector('.agent-process-body');
    const summary = work?.querySelector('[data-tool-issues="1"]:last-child > details > summary');
    if (!summary || work.scrollTop === 0) return false;
    const bounds = work.getBoundingClientRect();
    const group = summary.getBoundingClientRect();
    return group.top >= bounds.top - 1 && group.bottom <= bounds.bottom + 1;
  });
  assert.ok(await issueSummary.evaluate((element) => element === document.activeElement));
  await issueGroups.last().press('Enter');
  const deliveryRow = issueReply.locator('[data-tool-delivery-error]');
  await deliveryRow.getByRole('region', { name: 'Result delivery error', exact: true }).waitFor();
  await page.waitForFunction(() => {
    const row = document.querySelector('[data-tool-delivery-error]');
    const body = row?.closest('.agent-tool-history-body');
    if (!body || body.scrollTop === 0 || body.scrollHeight - body.clientHeight - body.scrollTop < 2)
      return false;
    const bounds = body.getBoundingClientRect();
    const rowSummary = row.querySelector('summary').getBoundingClientRect();
    return rowSummary.top >= bounds.top - 1 && rowSummary.bottom <= bounds.bottom + 1;
  });
  assert.ok(await issueGroups.last().evaluate((element) => element === document.activeElement));
  const deliveryHistory = deliveryRow.locator('..');
  const manualTail = await deliveryHistory.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  await issueGroups.last().press('Enter');
  await issueGroups.last().press('Enter');
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(await deliveryHistory.evaluate((element) => element.scrollTop), manualTail);
  assert.equal(await deliveryRow.getAttribute('data-tool-status'), 'completed');
  await issueGroups.last().press('Enter');
  await issueGroups.first().press('Enter');
  await issueReply
    .locator('[data-tool-status="failed"]')
    .getByRole('region', { name: 'Tool error', exact: true })
    .waitFor();
  await issueWork.evaluate((element) => {
    element.scrollTop = 0;
  });
  await issueSummary.press('Enter');
  await issueSummary.press('Enter');
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(await issueWork.evaluate((element) => element.scrollTop), 0);
  await issueSummary.press('Enter');
  await button('Latest messages').click();
  const issuePanel = page.locator('.chat-panel:visible');
  const panelWidth = await issuePanel.evaluate((panel) => panel.style.width);
  await issuePanel.evaluate((panel) => {
    panel.style.width = '328px';
  });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.setProperty('--font-step', '4px');
    }, theme);
    const elapsed = await issueSummary.getByLabel('Elapsed time', { exact: true }).boundingBox();
    const badge = await aggregate.boundingBox();
    const failed = await failedTurn.boundingBox();
    assert.ok(failed.x + failed.width < badge.x && badge.x + badge.width < elapsed.x);
    await issueSummary.screenshot({ path: `test-results/agent-tools/issues-${theme}-328.png` });
  }
  await issuePanel.evaluate((panel, width) => {
    panel.style.width = width;
  }, panelWidth);
  await page.evaluate(() => {
    delete document.documentElement.dataset.theme;
    document.documentElement.style.removeProperty('--font-step');
  });
  if (process.argv.includes('--timeline-only')) {
    assert.deepEqual(errors, []);
    console.log(
      'Agent chronology passed: interleaved work, bounded batches, issue counts and first-expansion reveal, retained reading positions and separate diagnostics.',
    );
    return;
  }
  await page.evaluate(() => {
    window.toolReply = 'Change R1.\n```openpe\n[{"type":"setValue","ref":"R1","value":"56k"}]\n```';
  });
  await send([]);
  assert.equal(await page.evaluate(() => window.chatRequests.at(-1).requestTitle), undefined);
  assert.doesNotMatch(
    await page.evaluate(() => JSON.stringify(window.chatRequests.at(-1).history)),
    /openpe_session/,
  );
  const proposalReply = page.locator('.message.assistant').last();
  await button('Apply to schematic').click();
  assert.equal(await proposalReply.locator('.agent-file-changes').count(), 0);
  await page.locator('.project-navigation .dirty-dot').waitFor();
  assert.equal(await page.locator('.editor-view-switch .dirty-dot').count(), 0);
  assert.equal(await page.locator('.breadcrumb > .dirty-dot').count(), 0);
  await button('Undo').click();
  current = await snapshot();
  assert.match(await firstTool.locator('pre').last().innerText(), /revision/);
  assert.equal(await firstTool.getByText('Preview truncated', { exact: true }).count(), 1);
  await firstTool.locator('summary').click();
  const props = { schematicId: project.schematic.id, partId: target.id, value: '47k' };
  const beforeNavigation = await snapshot();
  const navigation = await send([
    execute('workbench.selection', { ids: [target.id] }),
    execute('workbench.panel', { panel: 'parts' }),
    execute('workbench.view', { view: 'source' }),
    execute('workbench.view', { view: 'canvas' }),
  ]);
  assert.ok(
    navigation.every((response) => !response.error && response.result.status !== 'review-required'),
  );
  assert.equal(await page.locator('[data-tool-status="review"]').count(), 0);
  const afterNavigation = await snapshot();
  assert.deepEqual(afterNavigation.project, beforeNavigation.project);
  assert.equal(afterNavigation.undoDepth, beforeNavigation.undoDepth);
  // Pending reviews stay visible through later calls, completion and manual folding.
  await page.evaluate(() => {
    window.pauseToolCompletion = true;
    window.resumeToolCompletion = null;
  });
  const pendingRun = send([
    execute('part.properties', props),
    execute('part.properties', { ...props, value: '68k' }),
    query('core.state'),
  ]);
  await page.waitForFunction(() => typeof window.resumeToolCompletion === 'function');
  const pendingReply = page
    .locator('.message.assistant')
    .nth((await page.locator('.message.assistant').count()) - 1);
  assert.equal(
    await pendingReply.getByRole('button', { name: 'Apply part.properties', exact: true }).count(),
    2,
  );
  for (const control of await pendingReply
    .getByRole('button', { name: 'Apply part.properties', exact: true })
    .all())
    assert.equal(await control.isVisible(), true, 'Later calls cannot hide a pending review.');
  assert.equal(await pendingReply.locator('.agent-process [data-tool-status="review"]').count(), 0);
  await page.evaluate(() => {
    window.resumeToolCompletion();
    window.resumeToolCompletion = null;
  });
  await pendingRun;
  assert.equal(await pendingReply.locator('.agent-process[open]').count(), 0);
  assert.equal(await pendingReply.locator('[data-tool-status="review"]').count(), 2);
  for (const toggle of ['Enter', 'Space']) {
    await pendingReply.locator('.agent-process > summary').press(toggle);
    for (const control of await pendingReply
      .getByRole('button', { name: 'Apply part.properties', exact: true })
      .all())
      assert.equal(await control.isVisible(), true);
  }
  assert.equal(readPart(await snapshot()).value, target.value);
  await pendingReply
    .getByRole('button', { name: 'Reject part.properties', exact: true })
    .first()
    .click();
  assert.equal(
    await pendingReply.getByRole('button', { name: 'Apply part.properties', exact: true }).count(),
    1,
  );
  assert.equal(
    await pendingReply
      .getByRole('button', { name: 'Apply part.properties', exact: true })
      .evaluate((element) => document.activeElement === element),
    true,
    'Rejecting a focused review moves focus to the next pending Apply action.',
  );
  await pendingReply.getByRole('button', { name: 'Reject part.properties', exact: true }).click();
  assert.equal(
    await pendingReply
      .locator('.agent-process > summary')
      .evaluate((element) => document.activeElement === element),
    true,
    'Resolving the final review returns focus to its completed process header.',
  );

  const review = (await send([execute('part.properties', props)]))[0];
  assert.equal(review.result.status, 'review-required');
  await page.locator('[data-tool-status="review"]').waitFor();
  assert.equal(await page.locator('[data-tool-status="review"]').count(), 1);
  const reviewReply = page
    .locator('.message.assistant')
    .nth((await page.locator('.message.assistant').count()) - 1);
  const descriptor = (
    await send([query('capabilities.list', { ids: ['part.properties'], includeSchema: false })])
  )[0].result[0];
  const reviewDescription = reviewReply.locator('.tool-review-description');
  assert.equal(await reviewDescription.innerText(), descriptor.description);
  assert.equal(await reviewDescription.isVisible(), true);
  assert.equal(await reviewReply.locator('.agent-tool-call > details[open]').count(), 0);
  assert.equal(await reviewReply.locator('.agent-file-changes').count(), 0);
  assert.equal(readPart(await snapshot()).value, target.value, 'Review cannot write before Apply.');
  await mkdir('test-results/agent-tools', { recursive: true });
  await page.locator('[data-tool-status="review"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/agent-tools/review.png', fullPage: true });
  const chatPanel = page.locator('.chat-panel:visible');
  const originalWidth = await chatPanel.evaluate((element) => element.style.width);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await chatPanel.evaluate((element) => {
      element.style.width = '328px';
    });
    await reviewDescription.scrollIntoViewIfNeeded();
    assert.equal(await reviewDescription.isVisible(), true);
    for (const name of ['Apply part.properties', 'Reject part.properties'])
      assert.equal(await reviewReply.getByRole('button', { name, exact: true }).isVisible(), true);
    assert.ok(
      await chatPanel.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      'Review descriptions and controls must fit the narrow conversation panel.',
    );
    await reviewReply.screenshot({ path: `test-results/agent-tools/review-${theme}-narrow.png` });
  }
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'light';
  });
  await chatPanel.evaluate((element, width) => {
    element.style.width = width;
  }, originalWidth);
  const apply = button('Apply part.properties');
  await apply.focus();
  await apply.evaluate((element) => {
    element.click();
    element.click();
  });
  await apply.waitFor({ state: 'hidden' });
  assert.equal(
    await reviewReply
      .locator('.agent-process > summary')
      .evaluate((element) => document.activeElement === element),
    true,
    'Applying the focused final review returns focus to the same reply header.',
  );
  current = await snapshot();
  await reviewReply.locator('.agent-process > summary').click();
  await reviewReply.locator('.agent-tool-history > summary').click();
  await reviewReply.locator('.agent-process[open]').waitFor({ state: 'attached' });
  await reviewReply.locator('[data-tool-status="applied"]').waitFor();
  assert.equal(await page.locator('[data-tool-status="applied"]').count(), 1);
  assert.equal(await reviewReply.locator('.agent-file-changes').count(), 0);
  assert.equal(await page.locator('.editor-view-switch .dirty-dot').count(), 0);
  await reviewReply.screenshot({ path: 'test-results/agent-tools/reply-changes.png' });
  assert.equal(readPart(current).value, '47k');
  assert.equal(current.undoDepth, 1, 'A reviewed command commits one Core transaction.');
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 1);
  await page.evaluate(() => {
    window.toolReply = '```spice\nR1 out fb 47k\n```';
  });
  await send([]);
  const codeReply = page
    .locator('.message.assistant')
    .nth((await page.locator('.message.assistant').count()) - 1);
  const code = codeReply.locator('.agent-code-block pre');
  await code.focus();
  await code.dispatchEvent('keydown', {
    key: 's',
    ctrlKey: true,
    keyCode: 229,
    isComposing: false,
  });
  await code.press('Control+z');
  current = await snapshot();
  assert.equal(
    readPart(current).value,
    '47k',
    'Code-block keyboard focus cannot undo the circuit.',
  );
  assert.equal(current.undoDepth, 1);
  const copyCode = codeReply.getByRole('button', { name: 'Copy code', exact: true });
  await copyCode.focus();
  await copyCode.press('Control+z');
  current = await snapshot();
  assert.equal(current.undoDepth, 1, 'Copy controls cannot invoke circuit undo shortcuts.');
  await button('Undo').click();
  current = await snapshot();
  assert.equal(readPart(current).value, target.value);
  assert.equal(current.undoDepth, 0);
  assert.equal(
    await page.locator('.project-navigation .dirty-dot').count(),
    0,
    'Undo to baseline clears dirty.',
  );

  // Rejection has a visible terminal state and never reaches the Core.
  await send([execute('part.properties', props)]);
  const reject = button('Reject part.properties');
  await reject.focus();
  assert.equal(
    await reject.evaluate((el) =>
      el.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          keyCode: 229,
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    ),
    false,
    'Composing keyboard input cannot activate review controls.',
  );
  await reject.press('Enter');
  const rejectedReply = page.locator('.message.assistant').last();
  await rejectedReply.locator('.agent-process > summary').click();
  await rejectedReply.locator('.agent-tool-history > summary').click();
  await rejectedReply.locator('.agent-process[open]').waitFor({ state: 'attached' });
  await rejectedReply.locator('[data-tool-status="rejected"]').waitFor();
  assert.equal(await rejectedReply.locator('[data-tool-status="rejected"]').count(), 1);
  assert.equal((await snapshot()).undoDepth, 0);

  for (const mode of ['draft', 'hidden']) {
    await send([execute('part.properties', props)]);
    const backgroundReply = page.locator('.message.assistant').last();
    const backgroundReject = backgroundReply.getByRole('button', {
      name: 'Reject part.properties',
      exact: true,
      includeHidden: true,
    });
    const draft = page.getByRole('textbox', { name: 'Message your agent', exact: true });
    await draft.fill('Preserve my separate draft');
    await draft.evaluate((element) => element.setSelectionRange(2, 8));
    const panel = page.locator('.chat-panel');
    if (mode === 'hidden')
      await panel.evaluate((element) => {
        element.style.display = 'none';
      });
    await backgroundReject.evaluate((element) => element.click());
    await backgroundReject.waitFor({ state: 'detached' });
    if (mode === 'draft')
      assert.deepEqual(
        await draft.evaluate((element) => [
          document.activeElement === element,
          element.selectionStart,
          element.selectionEnd,
          element.value,
        ]),
        [true, 2, 8, 'Preserve my separate draft'],
        'Background review resolution preserves another focused draft and its selection.',
      );
    else
      await panel.evaluate((element) => {
        element.style.removeProperty('display');
      });
    assert.equal(
      await backgroundReply
        .locator('.agent-process > summary')
        .evaluate((element) => document.activeElement === element),
      false,
      'Background/hidden review resolution cannot reclaim focus on completion or reveal.',
    );
    await draft.fill('');
  }

  // A bounded preview cannot hide arguments from a human reviewing a large command.
  const longValue = 'x'.repeat(8000) + '-full-command-tail';
  await send([execute('part.properties', { ...props, value: longValue })]);
  const longReview = page.locator('[data-tool-status="review"]');
  await longReview.locator(':scope > details > summary').click();
  const deliveriesBeforeCopy = await page.evaluate(() => [
    window.chatRequests.length,
    window.toolResponses.length,
  ]);
  assert.equal(
    await longReview.getByRole('button', { name: 'Copy full command', exact: true }).count(),
    0,
    'Full command copying stays lazy with its disclosure.',
  );
  await longReview.getByRole('button', { name: 'Copy arguments preview', exact: true }).click();
  const copiedPreview = await page.evaluate(() => window.copies.at(-1));
  assert.equal(
    copiedPreview,
    await longReview.getByLabel('part.properties arguments', { exact: true }).textContent(),
  );
  assert.doesNotMatch(copiedPreview, /-full-command-tail/);
  const fullCommandSummary = longReview.getByText('Full command', { exact: true });
  await fullCommandSummary.press('Enter');
  await fullCommandSummary.press('Tab');
  assert.match(
    await longReview.locator('[aria-label="part.properties full command"]').innerText(),
    /-full-command-tail/,
  );
  const copyFullCommand = longReview.getByRole('button', {
    name: 'Copy full command',
    exact: true,
  });
  assert.equal(
    await copyFullCommand.evaluate((element) => element === document.activeElement),
    true,
    'Immediate Tab after expanding Full command reaches its copy control.',
  );
  const copiesBeforeComposition = await page.evaluate(() => window.copies.length);
  await copyFullCommand.focus();
  await copyFullCommand.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true });
  assert.equal(await page.evaluate(() => window.copies.length), copiesBeforeComposition);
  await copyFullCommand.press('Enter');
  assert.equal(
    await page.evaluate(() => window.copies.at(-1)),
    JSON.stringify({ name: 'part.properties', input: { ...props, value: longValue } }, null, 2),
  );
  assert.deepEqual(
    await page.evaluate(() => [window.chatRequests.length, window.toolResponses.length]),
    deliveriesBeforeCopy,
    'Copying either representation neither submits a request nor resolves the pending review.',
  );
  assert.equal(await longReview.getAttribute('data-tool-status'), 'review');
  await button('Reject part.properties').click();

  // Observations are visible and duplicate transport frames create one card.
  await page.evaluate(() => {
    window.duplicateNextTool = true;
  });
  await send([{ tool: 'openpe_observe', arguments: {} }]);
  await page.locator('.message.assistant').last().locator('.agent-process > summary').click();
  await page.locator('.message.assistant').last().locator('.agent-tool-history > summary').click();
  await page.locator('.message.assistant').last().locator('.agent-tool-call').waitFor();
  assert.equal(
    await page.locator('.message.assistant').last().locator('.agent-tool-call').count(),
    1,
  );
  assert.match(
    await page.locator('.agent-tool-call').last().locator('summary').getAttribute('aria-label'),
    /openpe_observe/,
  );

  // A reviewed command operates on current data, including after a human edit.
  await send([execute('part.properties', { ...props, value: '82k' })]);
  await button('Redo').click();
  await button('Apply part.properties').click();
  await page.locator('.message.assistant').last().locator('.agent-process > summary').click();
  await page.locator('.message.assistant').last().locator('.agent-tool-history > summary').click();
  await page.locator('.message.assistant').last().locator('[data-tool-status="applied"]').waitFor();
  assert.equal(readPart(await snapshot()).value, '82k');
  assert.equal((await snapshot()).undoDepth, 2);
  await button('Undo').click();
  await button('Undo').click();

  // Auto uses the same Core handlers for movement and multi-leg wiring.
  const permission = page.getByRole('combobox', { name: 'Agent permissions', exact: true });
  await permission.click();
  await page.getByRole('option', { name: /^Auto\b/ }).click();
  current = await snapshot();
  await page.evaluate(() => {
    window.duplicateNextTool = true;
  });
  const moved = await send([
    execute('schematic.move', {
      schematicId: project.schematic.id,
      ids: [target.id],
      delta: { x: 1.27, y: 0 },
    }),
  ]);
  assert.equal(moved[0].error, undefined);
  assert.equal(
    await page.locator('.message.assistant').last().locator('.agent-file-changes').count(),
    0,
  );
  await page.locator('.project-navigation .dirty-dot').waitFor();
  current = await snapshot();
  assert.equal(readPart(current).x, target.x + 1.27);
  await send([
    execute('schematic.move', {
      schematicId: project.schematic.id,
      ids: [target.id],
      delta: { x: 0, y: 0 },
    }),
  ]);
  assert.equal(
    await page.locator('.message.assistant').last().locator('.agent-file-changes').count(),
    0,
  );
  const oldWires = parseProject(JSON.stringify(current.project)).schematic.wires.length;
  const wired = await send([
    execute('schematic.wire', {
      schematicId: project.schematic.id,
      points: [
        { x: 254, y: 254 },
        { x: 266.7, y: 254 },
        { x: 266.7, y: 266.7 },
      ],
    }),
  ]);
  assert.equal(wired[0].error, undefined);
  current = await snapshot();
  assert.equal(current.undoDepth, 2);
  assert.equal(parseProject(JSON.stringify(current.project)).schematic.wires.length, oldWires + 2);

  await button('Source').click();
  await selectSourceFile(page, 'tools.kicad_pro').catch(async (error) => {
    throw new Error(
      `${error.message}\n${errors.join('\n')}\n${(await page.locator('body').innerText()).slice(-5000)}`,
    );
  });
  await page.getByRole('region', { name: 'Project source', exact: true }).waitFor();
  if (errors.length) throw new Error(errors.join('\n'));
  const originalProjectSource = await readSource(page);
  JSON.parse(originalProjectSource);
  const validSourceDraft = originalProjectSource + '\n ';
  await fillSource(page, validSourceDraft);
  const inspectDraft = await send([
    execute('workbench.view', { view: 'source' }),
    execute('workbench.panel', { panel: null }),
  ]);
  assert.ok(
    inspectDraft.every(
      (response) => !response.error && response.result.status !== 'review-required',
    ),
  );
  assert.equal(await readSource(page), validSourceDraft);
  const blockedNavigation = (await send([execute('workbench.view', { view: 'canvas' })]))[0];
  assert.match(blockedNavigation.error, /pending Source/);
  assert.equal(await readSource(page), validSourceDraft);
  assert.equal((await snapshot()).undoDepth, 2);
  await fillSource(page, '{invalid source');
  assert.equal(await readSource(page), '{invalid source');
  current = await snapshot();
  assert.equal(current.sourcePending, true);
  assert.equal(current.sourceDraft, null, 'Agent snapshots do not expose native draft bytes.');
  assert.ok(current.draftCharacters > 0);
  const blocked = (await send([execute('part.properties', props)]))[0];
  assert.match(blocked.error, /Source|source/);
  const failedReply = page.locator('.message.assistant').last();
  await failedReply.locator('.agent-process > summary').click();
  await failedReply.locator('.agent-tool-history > summary').click();
  const failedTool = failedReply.locator('.agent-tool-call').last();
  await failedTool.waitFor();
  assert.equal(await failedTool.getAttribute('data-tool-status'), 'failed');
  assert.match(await failedTool.innerText(), /Source|source/);
  const toolError = failedTool.getByRole('region', { name: 'Tool error', exact: true });
  const requestsBeforeErrorCopy = await page.evaluate(() => [
    window.chatRequests.length,
    window.toolResponses.length,
  ]);
  await failedTool.getByRole('button', { name: 'Copy tool error', exact: true }).click();
  assert.equal(await page.evaluate(() => window.copies.at(-1)), await toolError.textContent());
  assert.deepEqual(
    await page.evaluate(() => [window.chatRequests.length, window.toolResponses.length]),
    requestsBeforeErrorCopy,
  );
  assert.equal(await failedTool.getAttribute('data-tool-status'), 'failed');
  const pending = await snapshot();
  assert.equal(pending.undoDepth, 2);
  assert.equal(pending.sourcePending, true);
  assert.equal(await readSource(page), '{invalid source');
  assert.equal(readPart(pending).value, target.value);
  assert.equal(errors.length, 0, errors.join('\n'));
  for (const width of [328, 480]) {
    await page.locator('.chat-panel:visible').evaluate((el, width) => {
      el.style.width = `${width}px`;
    }, width);
    assert.ok(
      await page
        .locator('.chat-scroll:visible')
        .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
    );
  }
  await mkdir('test-results/agent-tools', { recursive: true });
  await page.screenshot({ path: 'test-results/agent-tools/workbench.png', fullPage: true });

  const manualName =
    'Review the LM2596 buck converter, feedback network, transient response and PCB layout';
  await page.locator('.project-session[aria-current="true"]').click({ button: 'right' });
  await page
    .getByRole('menu', { name: 'Conversation actions', exact: true })
    .getByRole('menuitem', { name: 'Rename', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill(manualName);
  await page.getByRole('dialog').getByRole('button', { name: 'Rename', exact: true }).click();
  await page.evaluate(() => {
    window.toolReply =
      '```openpe_session\n{"title":"Do not replace my name"}\n```\nThe reviewed converter remains a draft.';
  });
  await send([]);
  await page.getByRole('heading', { name: manualName, exact: true }).waitFor();
  assert.doesNotMatch(
    await page.locator('.message.assistant').last().innerText(),
    /openpe_session|Do not replace my name/,
  );
  await page.setViewportSize({ width: 2000, height: 920 });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.locator('.chat-panel:visible').evaluate((el) => {
      el.style.width = '1040px';
    });
    assert.ok(
      await page
        .locator('.chat-transcript:visible')
        .evaluate((el) => el.getBoundingClientRect().width <= 800),
    );
    assert.ok(
      await page
        .locator('.chat-panel:visible .composer-stack')
        .evaluate((el) => el.getBoundingClientRect().width <= 800),
    );
    await page
      .locator('.chat-panel:visible')
      .screenshot({ path: `test-results/agent-tools/conversation-${theme}.png` });
  }
  console.log(
    'Agent capability UI checks passed: live Core queries, current-state Review/Auto, undo/dirty, Auto move/wire and pending Source.',
  );
}
try {
  await runChecks();
} finally {
  await browser.close();
}
