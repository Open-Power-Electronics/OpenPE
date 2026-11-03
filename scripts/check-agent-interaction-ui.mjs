// Isolated renderer and controlled SSE fixture. No Electron, providers or user files.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { readNativeProject } from './source-editor-test-helpers.mjs';
import { bundledWorkbenchCatalog } from '../server/workbench-plugins.mjs';

const { emptyCircuit, createPart, uid } = await tsImport('../lib/circuit.ts', import.meta.url);
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const { createProject, serializeProject } = await tsImport('../lib/project.ts', import.meta.url);
const { defaultAgentPreferences } = await tsImport('../lib/workspace-state.ts', import.meta.url);
const { defaultAppearance } = await tsImport('../lib/appearance.ts', import.meta.url);
const circuit = emptyCircuit();
circuit.parts.push(createPart(circuit, 'R', 25.4, 25.4));
circuit.wires.push({ id: uid(), a: { x: 12.7, y: 40.64 }, b: { x: 63.5, y: 40.64 } });
const project = createProject(circuit);
project.pcb = createEmptyPCB();
project.pcb.footprints.push({
  id: uid(),
  symbolId: null,
  libraryId: 'Fixture:Pad',
  reference: 'TEST1',
  value: 'Pad',
  x: 10,
  y: 10,
  rotation: 0,
  side: 'front',
  graphics: [],
  pads: [
    {
      id: uid(),
      number: '1',
      x: 0,
      y: 0,
      rotation: 0,
      type: 'smd',
      shape: 'rect',
      size: { x: 2, y: 2 },
      netId: null,
    },
  ],
});
const source = serializeProject(project);
const documentId = uid();
let state = {
  version: 2,
  documents: [
    {
      id: documentId,
      source,
      sourceDraft: null,
      dirty: false,
      filename: 'interaction.kicad_pro',
      sessions: [{ id: 'interaction-session', messages: [], draft: '' }],
      activeSessionId: 'interaction-session',
    },
  ],
  activeDocumentId: documentId,
  provider: 'codex',
  effort: 'low',
  approvalMode: 'review',
  models: defaultAgentPreferences.models,
};
const streams = [];
const server = createServer((req, res) => {
  if (req.url !== '/api/chat') {
    res.writeHead(404).end();
    return;
  }
  req.resume();
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.flushHeaders();
  streams.push(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const bundle = await build({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import Workspace from './components/DesktopWorkspace';
      import Select from './components/Select';
      import WaveformLayoutPicker from './components/WaveformLayoutPicker';
      createRoot(document.getElementById('root')).render(<Workspace/>);
      window.mountPopupFixture = () => {
        const host = document.createElement('div'); host.id = 'popup-fixture'; document.body.append(host);
        createRoot(host).render(<div id="anchor-scroll" style={{height:80,overflow:'auto'}}>
          <Select label="Fixture selection" value="one" onChange={()=>{}}
            options={[{value:'one',label:'One'},{value:'two',label:'Two'}]}/>
          <WaveformLayoutPicker value="auto" onChange={value=>{window.waveformLayout=value}}/>
          <div style={{height:300}}/>
        </div>);
      };`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outdir: 'test-results/agent-interaction-ui-bundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
let browser;
try {
  browser = await chromium.launch({
    channel:
      process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((base) => {
    window.openpe = {
      titleBarOverlay: false,
      writeWorkspaceRecovery: async (content) => {
        await fetch(base + '/api/state', {
          method: content === null ? 'DELETE' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: content ?? undefined,
        });
      },
      connection: async () => ({ base, token: 'fixture' }),
      newFile: async () => crypto.randomUUID(),
      listExamples: async () => ({ entries: [], warnings: [] }),
      projectDirectory: async () => ({ entries: [], truncated: false }),
      releaseFile: async () => {},
      setDirty: async () => {},
      onCloseRequested: () => () => {},
    };
  }, base);
  await page.route(`${base}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/chat') return route.continue();
    if (url.pathname === '/api/state') {
      if (route.request().method() === 'POST') state = route.request().postDataJSON();
      return route.fulfill({ json: state });
    }
    if (url.pathname === '/api/appearance') return route.fulfill({ json: defaultAppearance });
    if (url.pathname === '/api/agents')
      return route.fulfill({ json: [{ id: 'codex', available: true, supportsEffort: true }] });
    if (url.pathname === '/api/models')
      return route.fulfill({ json: { models: [], defaultModel: '' } });
    if (url.pathname === '/api/workbench-plugins')
      return route.fulfill({ json: bundledWorkbenchCatalog() });
    if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(url.pathname))
      return route.fulfill({
        body: await readFile('public' + url.pathname),
        contentType: url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
      });
    if (url.pathname.startsWith('/api/')) throw new Error(`Unexpected API call: ${url.pathname}`);
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto(base);
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const schematic = page.getByTestId('schematic-canvas');
  await schematic.waitFor();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="schematic-canvas"]')?.viewBox.baseVal.x !== 0,
  );
  await page
    .getByRole('textbox', { name: 'Message your agent' })
    .fill('Controlled interaction check');
  await button('Send message').click();
  await button('Stop generation').waitFor();
  const event = (value) => streams.at(-1).write(`data: ${JSON.stringify(value)}\n\n`);
  let sequence = 0;
  async function append() {
    const marker = `Streaming paragraph ${++sequence}`;
    event({ type: 'text-delta', delta: `\n\n${marker}\n\n` + 'Circuit analysis. '.repeat(80) });
    await page.waitForFunction(
      (marker) => document.querySelector('.agent-markdown')?.textContent.includes(marker),
      marker,
    );
    // Let the scroll event reach window capture listeners.
    await page.waitForTimeout(80);
  }
  // Populate a scrollable response before opening menus.
  await append();
  await append();
  const grid = page.getByRole('combobox', { name: 'Grid density', exact: true });
  await grid.click();
  await append();
  assert.equal(
    await grid.getAttribute('aria-expanded'),
    'true',
    'Schematic Grid density stays open while the Agent response scrolls.',
  );
  await page.getByRole('option', { name: '1 mm', exact: true }).click();
  assert.match(await grid.innerText(), /1 mm/);

  // Pointer capture and the right viewport survive several response appends.
  const at = (canvas, p) =>
    canvas.evaluate((svg, p) => {
      const screen = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
      return { x: screen.x, y: screen.y };
    }, p);
  const wireStart = await at(schematic, { x: 38.1, y: 40.64 });
  const wireEnd = await at(schematic, { x: 38.1, y: 45.72 });
  const viewport = await schematic.getAttribute('viewBox');
  await page.mouse.click(wireStart.x, wireStart.y);
  await page.mouse.move(wireStart.x, wireStart.y);
  await page.mouse.down();
  await page.mouse.move(wireEnd.x, wireEnd.y, { steps: 4 });
  await append();
  assert.equal(await schematic.getAttribute('viewBox'), viewport);
  assert.equal(await schematic.evaluate((svg) => document.activeElement === svg), true);
  await page.mouse.up();
  const wire = schematic.locator(`[data-selection-id="${circuit.wires[0].id}"] > g > line`);
  assert.equal(Number(await wire.getAttribute('y1')), 45.72);

  await button('Layout').click();
  const layout = page.getByTestId('layout-canvas');
  await layout.waitFor();
  assert.match(await grid.innerText(), /0\.5 mm/, 'Layout defaults independently to 0.5 mm.');
  await grid.click();
  await append();
  assert.equal(
    await grid.getAttribute('aria-expanded'),
    'true',
    'Layout Grid density stays open during Agent output.',
  );
  await grid.press('Escape');
  const pad = await at(layout, { x: 10, y: 10 });
  await page.mouse.click(pad.x, pad.y);
  await layout.press('e');
  await button('Footprint properties').click();
  await layout.press('ArrowRight');
  const x = page.getByLabel('X (mm)', { exact: true });
  await x.waitFor();
  await x.fill('11.2');
  await append();
  assert.equal(await x.inputValue(), '11.2');
  assert.equal(
    await x.evaluate((el) => document.activeElement === el),
    true,
    'Streaming preserves a partially edited Layout coordinate and its focus.',
  );
  await x.press('Escape');
  await button('Source').click();
  const edited = await readNativeProject(page);
  assert.equal(
    edited.pcb.footprints[0].x,
    10.5,
    'Layout keyboard movement uses the default 0.5 mm grid.',
  );
  await button('Layout').click();

  await button('Settings').click();
  const settingsMenu = page.getByRole('dialog', { name: 'Settings', exact: true });
  await append();
  assert.equal(await settingsMenu.isVisible(), true);
  assert.equal(await settingsMenu.evaluate((el) => el.contains(document.activeElement)), true);
  await page.keyboard.press('Escape');

  const projectEntry = page.locator(`[data-project-id="${documentId}"]:visible`).first();
  await projectEntry.click({ button: 'right' });
  const projectMenu = page.getByRole('menu', { name: 'Project file actions', exact: true });
  await append();
  assert.equal(await projectMenu.isVisible(), true);
  assert.equal(await projectMenu.evaluate((el) => el.contains(document.activeElement)), true);
  await page.keyboard.press('Escape');

  // Shared popups ignore sibling scrolling but still dismiss when their anchor scrolls.
  await page.evaluate(() => window.mountPopupFixture());
  await page.addStyleTag({
    content:
      '#popup-fixture{position:fixed;right:20px;top:180px;width:250px;background:var(--surface);z-index:100}',
  });
  const picker = page.getByRole('combobox', { name: 'Waveform layout', exact: true });
  await picker.click();
  await append();
  assert.equal(await picker.getAttribute('aria-expanded'), 'true');
  await page.getByRole('gridcell', { name: '2 columns × 2 rows', exact: true }).click();
  assert.equal(await page.evaluate(() => window.waveformLayout), '2x2');
  const fixtureSelect = page.getByRole('combobox', { name: 'Fixture selection', exact: true });
  for (const control of [fixtureSelect, picker]) {
    await page.evaluate(() => {
      document.getElementById('anchor-scroll').scrollTop = 0;
    });
    await page.waitForTimeout(50);
    await control.click();
    await page.evaluate(() => {
      document.getElementById('anchor-scroll').scrollTop = 20;
    });
    await page.waitForTimeout(50);
    assert.equal(
      await control.getAttribute('aria-expanded'),
      'false',
      'Anchor scrolling still dismisses popups.',
    );
  }

  // Scrolling back pauses following; resuming at the bottom follows later output.
  const chat = page.locator('.chat-scroll:visible');
  await chat.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
  });
  await button('Latest messages').waitFor();
  await append();
  assert.equal(await chat.evaluate((el) => el.scrollTop), 0);
  await chat.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event('scroll'));
  });
  await button('Latest messages').waitFor({ state: 'hidden' });
  await append();
  await page.waitForFunction(
    () => {
      const el = document.querySelector('.chat-scroll');
      return el.scrollHeight - el.scrollTop - el.clientHeight < 2;
    },
    undefined,
    { timeout: 3000 },
  );
  event({ type: 'done', outcome: 'completed' });
  streams.at(-1).end();
  await button('Send message').waitFor();
  assert.deepEqual(errors, []);
  await mkdir('test-results/agent-interaction', { recursive: true });
  await page.screenshot({ path: 'test-results/agent-interaction/success.png' });
  console.log(
    'Agent streaming preserves editor menus, focus, wire gestures and viewports; Layout uses 0.5 mm; popup anchor dismissal and chat following pass.',
  );
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    await mkdir('test-results/agent-interaction', { recursive: true });
    await page.screenshot({ path: 'test-results/agent-interaction/failure.png' }).catch(() => {});
    await writeFile(
      'test-results/agent-interaction/failure.txt',
      await page.locator('body').innerText(),
    );
  }
  throw error;
} finally {
  for (const stream of streams) stream.destroy();
  await browser?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
