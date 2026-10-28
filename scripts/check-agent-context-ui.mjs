// Isolated headless renderer with mocked Agent and solver responses.
// Never launches Electron, installed providers, or a real solver.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { bundledWorkbenchCatalog } from '../server/workbench-plugins.mjs';
import { validateAgentWorkspaceContext } from '../server/agent-context-format.mjs';
import { fillSource } from './source-editor-test-helpers.mjs';

const { switchingStageFixture } = await tsImport(
  '../tests/fixtures/switching-stage.ts',
  import.meta.url,
);
const { createProject, serializeProject, parseProject } = await tsImport(
  '../lib/project.ts',
  import.meta.url,
);
const { buildSpiceDeck } = await tsImport('../lib/spice.ts', import.meta.url);
const { pinPositions } = await tsImport('../lib/circuit.ts', import.meta.url);
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const project = createProject(switchingStageFixture());
project.pcb = createEmptyPCB();
const source = serializeProject(project);
const id = '00000000-0000-4000-8000-000000000001';
let state = {
  version: 2,
  documents: [
    {
      id,
      source,
      sourceDraft: null,
      dirty: false,
      filename: 'context.kicad_pro',
      sessions: [{ id: 'context-session', messages: [], draft: '' }],
      activeSessionId: 'context-session',
    },
  ],
  activeDocumentId: id,
  provider: 'codex',
  effort: 'low',
  approvalMode: 'review',
  models: {},
};
const workbench = bundledWorkbenchCatalog();
const chats = [];
let runs = 0;
const bundle = await build({
  stdin: {
    contents:
      "import React from 'react'; import {createRoot} from 'react-dom/client'; import Workspace from './components/DesktopWorkspace'; import {captureAgentPresentation} from './context/agent-presentation'; window.captureAgentPresentation=captureAgentPresentation; createRoot(document.getElementById('root')).render(<React.StrictMode><Workspace/></React.StrictMode>);",
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outdir: 'test-results/agent-context-ui-bundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
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
      releaseFile: async () => {},
      setDirty: async () => {},
      onCloseRequested: () => () => {},
    };
  });
  await page.route('http://localhost/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/state') {
      if (route.request().method() === 'POST') state = route.request().postDataJSON();
      return route.fulfill({ json: state });
    }
    if (pathname === '/api/appearance') return route.fulfill({ json: null });
    if (pathname === '/api/agents')
      return route.fulfill({ json: [{ id: 'codex', available: true, supportsEffort: true }] });
    if (pathname === '/api/models')
      return route.fulfill({ json: { models: [], defaultModel: '' } });
    if (pathname === '/api/workbench-plugins')
      return route.fulfill({ json: { ...workbench, updatedAt: Date.now() } });
    if (pathname === '/api/simulation/status')
      return route.fulfill({ json: { available: true, version: 'private-version' } });
    if (pathname === '/api/simulation/result') return route.fulfill({ json: { result: null } });
    if (pathname === '/api/simulation/transient') {
      runs++;
      const payload = route.request().postDataJSON();
      const deck = buildSpiceDeck(parseProject(payload.source).schematic, payload.config);
      const time = Array.from({ length: 801 }, (_, i) => (i * payload.config.stop) / 800);
      return route.fulfill({
        json: {
          version: 'private-version',
          log: 'private-log',
          time,
          traces: deck.traces.map((trace, n) => ({
            ...trace,
            values: time.map((_, i) => (i === 473 ? 100 + n : i / 800 + n)),
          })),
        },
      });
    }
    if (pathname === '/api/chat') {
      const payload = route.request().postDataJSON();
      validateAgentWorkspaceContext(
        payload.context.workspace,
        payload.context.id,
        payload.context.basis,
      );
      chats.push(payload);
      return route.fulfill({
        contentType: 'text/event-stream',
        body: 'data: {"type":"text","text":"Controlled reply"}\n\ndata: {"type":"done","outcome":"completed"}\n\n',
      });
    }
    if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(pathname))
      return route.fulfill({ body: await readFile('public' + pathname) });
    if (pathname.startsWith('/api/')) throw new Error(`Unexpected API call: ${pathname}`);
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const canvas = page.getByTestId('schematic-canvas');
  await canvas.waitFor();
  const presentation = await page.evaluate(() => {
    const host = document.createElement('section');
    host.style.cssText = 'position:fixed;left:10px;top:10px;width:240px;height:160px';
    host.innerHTML =
      '<label>Visible draft<input value="12.7"></label><label>Selected<input type="checkbox" checked></label>' +
      '<input type="password" value="credential-secret"><div hidden>hidden-secret</div>' +
      '<div class="chat-panel">conversation-secret</div><div style="overflow:hidden;height:10px"><div style="margin-top:100px">clipped-secret</div></div>';
    document.body.append(host);
    const capture = window.captureAgentPresentation(host);
    host.remove();
    return capture;
  });
  assert.ok(presentation.controls.some((control) => control.value === '12.7'));
  assert.ok(presentation.controls.some((control) => control.checked));
  assert.doesNotMatch(
    JSON.stringify(presentation),
    /credential-secret|hidden-secret|conversation-secret|clipped-secret/,
  );
  async function send(text) {
    const count = chats.length;
    const replies = await page.locator('.agent-markdown').count();
    await page.getByRole('textbox', { name: 'Message your agent' }).fill(text);
    await button('Send message').click();
    await page.waitForFunction(
      (count) => document.querySelectorAll('.agent-markdown').length > count,
      replies,
    );
    await button('Send message').waitFor();
    assert.equal(chats.length, count + 1);
    return chats.at(-1).context.workspace;
  }
  let context = await send('Before simulation');
  assert.deepEqual(context.project, JSON.parse(source));
  assert.equal(context.simulation.status, 'not-opened');
  assert.equal(runs, 0);
  assert.equal(context.ui.mode, 'interaction');
  assert.ok(context.ui.presentation.controls.some((control) => control.label === 'Simulation'));
  // Keep the submitted draft unchanged while editing: the retained conversation
  // must obtain the live design at Send, even without another composer render.
  const composer = page.getByRole('textbox', { name: 'Message your agent' });
  await composer.fill('Read the edit made after this draft');
  await page.getByTestId('symbol-hit-R1').click();
  await canvas.press('ArrowRight');
  await page.locator('.dirty-dot').first().waitFor();
  const editedChat = page.waitForRequest(
    (request) => new URL(request.url()).pathname === '/api/chat',
  );
  await button('Send message').click();
  const editedPayload = (await editedChat).postDataJSON();
  assert.equal(
    editedPayload.context.parts.find((part) => part.ref === 'R1').x,
    Number((project.schematic.parts.find((part) => part.ref === 'R1').x + 1.27).toFixed(4)),
  );
  assert.notEqual(editedPayload.context.basis, chats[0].context.basis);
  await page.waitForFunction(() => document.querySelectorAll('.agent-markdown').length >= 2);
  await button('Stop generation').waitFor({ state: 'hidden' });
  await canvas.press('Control+z');
  await page.waitForFunction(() => !document.querySelector('.dirty-dot'));
  await button('Layout').click();
  await page.getByTestId('layout-canvas').waitFor();
  context = await send('Inspect Layout presentation');
  assert.equal(context.ui.view, 'layout');
  assert.equal(context.ui.layoutView.boardId, project.pcb.id);
  assert.ok(context.ui.layoutView.viewport.width > 0);
  assert.ok(
    context.ui.presentation.drawings.some((drawing) => drawing.label === 'PCB layout editor'),
  );
  await button('Schematic').click();
  await button('SPICE Simulation').click();
  await button('Run').click();
  await button('Stop').waitFor({ state: 'hidden' });
  const target = project.schematic.parts.find((part) => part.ref === 'J3');
  const position = pinPositions(target, project.schematic.libraries[target.libId])[0];
  const point = await canvas.evaluate((svg, p) => {
    const screen = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
    return { x: screen.x, y: screen.y };
  }, position);
  await page.mouse.click(point.x, point.y);
  await page.locator('.simulation-waveform').first().waitFor();
  await button('Cursor A').click();
  await button('Cursor B').click();
  const cursorA = page.getByRole('slider', { name: /cursor A$/ }).first();
  const cursorB = page.getByRole('slider', { name: /cursor B$/ }).first();
  await cursorA.press('Home');
  await cursorB.press('End');
  context = await send('Read the simulation and cursor measurements');
  assert.equal(context.simulation.status, 'completed');
  assert.equal(context.simulation.waveformsVisible, true);
  const trace = context.simulation.result.traces.find((trace) => trace.selected);
  assert.ok(trace.visibleWindow);
  assert.equal(
    trace.visibleWindow.cursors[0].time,
    Number(await cursorA.getAttribute('aria-valuenow')),
  );
  assert.equal(
    trace.visibleWindow.cursors[1].time,
    Number(await cursorB.getAttribute('aria-valuenow')),
  );
  assert.doesNotMatch(JSON.stringify(context), /private-version|private-log/);
  assert.equal(
    context.simulation.result.traces.length,
    buildSpiceDeck(project.schematic, context.simulation.config).traces.length,
  );
  await button('Annotation mode').click();
  context = await send('Same result in Annotation mode');
  assert.equal(context.ui.mode, 'annotation');
  assert.equal(context.simulation.result.status, 'completed');
  await button('Close simulation settings').click();
  context = await send('Closed settings keep completed results');
  assert.equal(context.simulation.settingsVisible, false);
  assert.equal(context.simulation.waveformsVisible, false);
  assert.equal(context.simulation.result.status, 'completed');
  const completedConfig = context.simulation.config;
  await button('SPICE Simulation').click();
  await page.getByLabel('Input voltage (V)', { exact: true }).fill('18');
  context = await send('Edited setup keeps the previous result configuration');
  assert.equal(context.simulation.config.voltage, 18);
  assert.deepEqual(context.simulation.resultConfig, completedConfig);
  assert.equal(context.simulation.result.status, 'completed');
  await page.getByLabel('Duration (ms)', { exact: true }).fill('invalid');
  context = await send('Invalid timing');
  assert.equal(
    context.simulation.result.status,
    'completed',
    'Invalid timing drafts retain the displayed completed result.',
  );
  assert.equal(context.simulation.result.sampleCount, 801);
  assert.equal(context.simulation.waveformsVisible, true);
  assert.equal(context.simulation.status, 'completed');
  assert.equal(context.simulation.config, null);
  assert.deepEqual(context.simulation.resultConfig, completedConfig);
  assert.ok(context.simulation.errors.length);
  await button('Source').click();
  await fillSource(page, '{invalid source');
  context = await send('Review my unapplied Source draft');
  assert.equal(context.source.pending, true);
  const draftFiles = JSON.parse(context.source.draft);
  assert.equal(
    draftFiles.files.find((file) => file.name === draftFiles.entry).source,
    '{invalid source',
  );
  assert.deepEqual(context.project, JSON.parse(source));
  assert.equal(context.simulation.result, null);
  await button('New project').click();
  context = await send('New project must not inherit results');
  assert.notEqual(context.ui.activeSchematicId, project.schematic.id);
  assert.equal(context.simulation.status, 'not-opened');
  assert.equal(context.source.pending, false);
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Agent workspace context UI checks passed.');
} finally {
  await browser.close();
}
