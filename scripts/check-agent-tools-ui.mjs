// Real DesktopWorkspace, Workbench and Core, with an in-renderer SSE fixture.
// No Electron, installed provider, external service or solver is launched.
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { bundledWorkbenchCatalog } from '../server/workbench-plugins.mjs';
import { fillSource, selectSourceFile } from './source-editor-test-helpers.mjs';

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
  define: { 'process.env.NODE_ENV': '"development"' },
});
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
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
      projectDirectory: async () => ({ entries: [], truncated: false }),
      releaseFile: async () => {},
      setDirty: async () => {},
      onCloseRequested: () => () => {},
    };
    const originalFetch = window.fetch.bind(window);
    const encoder = new TextEncoder();
    window.toolResponses = [];
    window.chatRequests = [];
    window.toolPlan = [];
    let controller, sessionId, runId, requestId, token, remaining;
    const emit = (event) =>
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    const next = () => {
      const step = remaining.shift();
      if (!step) {
        emit({ type: 'text', text: window.toolReply || 'Runtime fixture completed.' });
        window.toolReply = '';
        emit({ type: 'done', outcome: 'completed' });
        controller.close();
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
        setTimeout(next, 0);
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
    if (pathname === '/api/appearance') return route.fulfill({ json: defaultAppearance });
    if (pathname === '/api/agents')
      return route.fulfill({ json: [{ id: 'codex', available: true, supportsEffort: true }] });
    if (pathname === '/api/models')
      return route.fulfill({ json: { models: [], defaultModel: '' } });
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
      before + plan.length,
    );
    await button('Send message').waitFor();
    return page.evaluate((index) => window.toolResponses.slice(index), before);
  }
  const query = (name, input) => ({
    tool: 'openpe_query',
    arguments: { name, ...(input === undefined ? {} : { input }) },
  });
  const execute = (name, input, expectedRevision) => ({
    tool: 'openpe_execute',
    arguments: {
      name,
      ...(input === undefined ? {} : { input }),
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
    },
  });
  const snapshot = async () => (await send([query('project.snapshot')]))[0].result;
  const readPart = (snapshot) =>
    parseProject(JSON.stringify(snapshot.project)).schematic.parts.find(
      (part) => part.id === target.id,
    );
  await page.evaluate(() => {
    window.toolReply =
      '```openpe_session\n{"title":"Switching-stage capability review"}\n```\nRuntime fixture completed.';
  });
  let current = await snapshot();
  await page
    .getByRole('heading', { name: 'Switching-stage capability review', exact: true })
    .waitFor();
  assert.equal(await page.evaluate(() => window.chatRequests[0].requestTitle), true);
  assert.ok(
    await page.evaluate(
      () =>
        parseFloat(getComputedStyle(document.querySelector('.session-title')).fontSize) >
        parseFloat(getComputedStyle(document.querySelector('.agent-markdown')).fontSize),
    ),
  );
  assert.equal(readPart(current).value, target.value);
  const firstTool = page.locator('.agent-tool-call').first();
  assert.equal(await firstTool.getAttribute('data-tool-status'), 'completed');
  assert.ok(
    (await firstTool.boundingBox()).height <= 36,
    'Settled tools use a single compact row.',
  );
  assert.doesNotMatch(await firstTool.innerText(), /openpe_query|<1s/);
  const firstReply = page.locator('.message.assistant').first();
  assert.equal(await firstReply.locator('.agent-file-changes').count(), 0);
  assert.ok(
    await firstReply.evaluate((reply) => {
      const tool = reply.querySelector('.agent-tool-list');
      const body = reply.querySelector('.agent-markdown');
      return (
        Boolean(tool.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING) &&
        reply.lastElementChild.matches('.agent-markdown')
      );
    }),
    'Tool activity precedes the answer; an unchanged reply has no file footer.',
  );
  await firstTool.locator('summary').click();
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
  assert.match(
    await proposalReply.locator('.agent-file-changes').innerText(),
    /\.kicad_sch\s+Modified/,
  );
  await button('Undo').click();
  current = await snapshot();
  assert.match(await firstTool.locator('pre').last().innerText(), /revision/);
  assert.equal(await firstTool.getByText('Preview truncated', { exact: true }).count(), 1);
  await firstTool.locator('summary').click();
  const props = { schematicId: project.schematic.id, partId: target.id, value: '47k' };
  const review = (await send([execute('part.properties', props, current.revision)]))[0];
  assert.equal(review.result.status, 'review-required');
  assert.equal(await page.locator('[data-tool-status="review"]').count(), 1);
  const reviewReply = page
    .locator('.message.assistant')
    .nth((await page.locator('.message.assistant').count()) - 1);
  assert.equal(await reviewReply.locator('.agent-file-changes').count(), 0);
  assert.equal(readPart(await snapshot()).value, target.value, 'Review cannot write before Apply.');
  await mkdir('test-results/agent-tools', { recursive: true });
  await page.locator('[data-tool-status="review"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/agent-tools/review.png', fullPage: true });
  const apply = button('Apply part.properties');
  await apply.evaluate((element) => {
    element.click();
    element.click();
  });
  await apply.waitFor({ state: 'hidden' });
  current = await snapshot();
  assert.equal(await page.locator('[data-tool-status="applied"]').count(), 1);
  assert.match(
    await reviewReply.locator('.agent-file-changes').innerText(),
    /\.kicad_sch\s+Modified/,
  );
  await reviewReply.screenshot({ path: 'test-results/agent-tools/reply-changes.png' });
  assert.equal(readPart(current).value, '47k');
  assert.equal(current.undoDepth, 1, 'A reviewed command commits one Core transaction.');
  assert.equal(await page.locator('.project-file-tabs .dirty-dot').count(), 1);
  await button('Undo').click();
  current = await snapshot();
  assert.equal(readPart(current).value, target.value);
  assert.equal(current.undoDepth, 0);
  assert.equal(
    await page.locator('.project-file-tabs .dirty-dot').count(),
    0,
    'Undo to baseline clears dirty.',
  );

  // Rejection has a visible terminal state and never reaches the Core.
  await send([execute('part.properties', props, current.revision)]);
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
  assert.equal(await page.locator('[data-tool-status="rejected"]').count(), 1);
  assert.equal((await snapshot()).undoDepth, 0);

  // A bounded preview cannot hide arguments from a human reviewing a large command.
  const longValue = 'x'.repeat(8000) + '-full-command-tail';
  await send([execute('part.properties', { ...props, value: longValue }, current.revision)]);
  const longReview = page.locator('[data-tool-status="review"]');
  await longReview.locator(':scope > details > summary').click();
  await longReview.getByText('Full command', { exact: true }).click();
  assert.match(
    await longReview.locator('[aria-label="part.properties full command"]').innerText(),
    /-full-command-tail/,
  );
  await button('Reject part.properties').click();

  // Observations are visible and duplicate transport frames create one card.
  await page.evaluate(() => {
    window.duplicateNextTool = true;
  });
  const beforeObserve = await page.locator('.agent-tool-call').count();
  await send([{ tool: 'openpe_observe', arguments: {} }]);
  assert.equal(await page.locator('.agent-tool-call').count(), beforeObserve + 1);
  assert.match(
    await page.locator('.agent-tool-call').last().locator('summary').getAttribute('aria-label'),
    /openpe_observe/,
  );

  // A command prepared before a human edit must not silently apply afterward.
  await send([execute('part.properties', props, current.revision)]);
  await button('Redo').click();
  await button('Apply part.properties').click();
  await page
    .getByText('The project changed since this command was prepared.', { exact: false })
    .waitFor();
  assert.equal(
    await page
      .locator('[data-tool-status="failed"]')
      .locator('..')
      .locator('..')
      .locator('.agent-file-changes')
      .count(),
    0,
    'A human edit is not attributed to a rejected Agent command.',
  );
  assert.equal((await snapshot()).undoDepth, 1);
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
    execute(
      'schematic.move',
      { schematicId: project.schematic.id, ids: [target.id], delta: { x: 1.27, y: 0 } },
      current.revision,
    ),
  ]);
  assert.equal(moved[0].error, undefined);
  assert.match(
    await page.locator('.message.assistant').last().locator('.agent-file-changes').innerText(),
    /\.kicad_sch\s+Modified/,
  );
  current = await snapshot();
  assert.equal(readPart(current).x, target.x + 1.27);
  await send([
    execute(
      'schematic.move',
      { schematicId: project.schematic.id, ids: [target.id], delta: { x: 0, y: 0 } },
      current.revision,
    ),
  ]);
  assert.equal(
    await page.locator('.message.assistant').last().locator('.agent-file-changes').count(),
    0,
  );
  const oldWires = parseProject(JSON.stringify(current.project)).schematic.wires.length;
  const wired = await send([
    execute(
      'schematic.wire',
      {
        schematicId: project.schematic.id,
        points: [
          { x: 254, y: 254 },
          { x: 266.7, y: 254 },
          { x: 266.7, y: 266.7 },
        ],
      },
      current.revision,
    ),
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
  await fillSource(page, '{invalid source');
  current = await snapshot();
  const draftFiles = JSON.parse(current.sourceDraft);
  assert.equal(
    draftFiles.files.find((file) => file.name === draftFiles.entry).source,
    '{invalid source',
  );
  const blocked = (await send([execute('part.properties', props, current.revision)]))[0];
  assert.match(blocked.error, /Source|source/);
  const failedTool = page.locator('.agent-tool-call').last();
  assert.equal(await failedTool.getAttribute('data-tool-status'), 'failed');
  assert.match(await failedTool.innerText(), /Source|source/);
  const pending = await snapshot();
  assert.equal(pending.undoDepth, 2);
  assert.equal(pending.sourceDraft, current.sourceDraft);
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
    'Agent capability UI checks passed: live Core queries, Review, stale guards, undo/dirty, Auto move/wire and pending Source.',
  );
} finally {
  await browser.close();
}
