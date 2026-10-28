import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';
import { waitForAsync } from './async-browser-test-helpers.mjs';
import { bundledWorkbenchCatalog } from '../server/workbench-plugins.mjs';

const { parseProject } = await tsImport('../lib/project.ts', import.meta.url);
const { circuitFingerprint } = await tsImport('../lib/circuit.ts', import.meta.url);
const { prepareThermalModel } = await tsImport('../lib/thermal.ts', import.meta.url);
const { validateAgentWorkspaceContext } = await tsImport(
  '../context/agent-workspace-context.ts',
  import.meta.url,
);
const sources = JSON.parse(await readFile('lib/reference-examples.json', 'utf8'));
const exampleId = Object.keys(sources).find((id) => /lm2596/i.test(id));
assert.ok(exampleId, 'The curated LM2596 example is present.');
const source = sources[exampleId];
const project = parseProject(source);
const documentId = randomUUID(),
  sessionId = randomUUID(),
  fileId = randomUUID();
let recovery = {
  version: 2,
  documents: [
    {
      id: documentId,
      source,
      sourceDraft: null,
      dirty: false,
      filename: 'project.kicad_pro',
      sessions: [{ id: sessionId, messages: [], draft: '' }],
      activeSessionId: sessionId,
    },
  ],
  activeDocumentId: documentId,
  provider: 'codex',
  effort: 'low',
  approvalMode: 'review',
  models: {},
};
const catalog = bundledWorkbenchCatalog();
const bundle = await build({
  stdin: {
    contents: `import React from 'react';import{createRoot}from'react-dom/client';import Workspace from './components/DesktopWorkspace';window.thermalWorkbenchHost=()=>window.__thermalHosts?.findLast(host=>host.catalog().some(entry=>entry.id==='workbench.state'));createRoot(document.getElementById('root')).render(<Workspace/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outfile: 'test-results/thermal-workbench-ui.js',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [
    {
      name: 'isolated-capability-observer',
      setup(builder) {
        builder.onLoad({ filter: /[\\/]api[\\/]capabilities\.ts$/ }, async ({ path }) => ({
          loader: 'ts',
          contents:
            (await readFile(path, 'utf8')).replace(
              'export function createCapabilityHost(',
              'function originalCreateCapabilityHost(',
            ) +
            `\nexport function createCapabilityHost(options){const host=originalCreateCapabilityHost(options);(window.__thermalHosts??=[]).push(host);return host;}`,
        }));
      },
    },
  ],
});
await mkdir('test-results', { recursive: true });
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1480, height: 920 } });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((fileId) => {
    window.thermalExports = [];
    window.openpe = {
      titleBarOverlay: false,
      writeWorkspaceRecovery: async (content) => {
        await fetch('http://localhost/api/state', {
          method: content === null ? 'DELETE' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: content ?? undefined,
        });
      },
      connection: async () => ({ base: 'http://localhost', token: 'thermal-workbench-test' }),
      newFile: async () => fileId,
      releaseFile: async () => {},
      setDirty: async () => {},
      onCloseRequested: () => () => {},
      exportImage: async (image) => {
        window.thermalExports.push(image);
        return { name: `${image.name}.png` };
      },
    };
  }, fileId);
  let statusRequests = 0;
  let runRequests = 0;
  let savedThermal = null;
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/state') {
      if (route.request().method() === 'POST') recovery = route.request().postDataJSON();
      return route.fulfill({ json: recovery });
    }
    if (url.pathname === '/api/workbench-plugins') {
      if (route.request().method() === 'POST') {
        const { id, action } = route.request().postDataJSON();
        const plugin = catalog.plugins.find((row) => row.id === id);
        plugin.installed = action !== 'uninstall';
        plugin.enabled = action === 'install' || action === 'enable';
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ json: { ...catalog, updatedAt: Date.now() } });
    }
    if (url.pathname === '/api/plugins')
      return route.fulfill({
        json: {
          controlsVersion: 1,
          plugins: [],
          actions: [],
          browse: true,
          warning: '',
          updatedAt: Date.now(),
        },
      });
    if (url.pathname === '/api/appearance') return route.fulfill({ json: null });
    if (url.pathname === '/api/agents') return route.fulfill({ json: [] });
    if (url.pathname === '/api/models')
      return route.fulfill({ json: { models: [], defaultModel: '' } });
    if (url.pathname === '/api/thermal/status') {
      statusRequests++;
      return route.fulfill({
        json: { available: true, gmsh: 'fixture Gmsh', elmer: 'fixture Elmer', diagnostic: '' },
      });
    }
    if (url.pathname === '/api/thermal/result')
      return route.fulfill({ json: savedThermal ?? { result: null } });
    if (url.pathname === '/api/thermal/run') {
      runRequests++;
      const payload = route.request().postDataJSON();
      assert.equal(payload.fileId, fileId);
      assert.equal(route.request().headers()['x-openpe-token'], 'thermal-workbench-test');
      const model = prepareThermalModel(project.pcb, payload.config);
      const outline = model.board.flatMap((polygon) => polygon.outer);
      const minX = Math.min(...outline.map((point) => point.x));
      const maxX = Math.max(...outline.map((point) => point.x));
      const minY = Math.min(...outline.map((point) => point.y));
      const maxY = Math.max(...outline.map((point) => point.y));
      const a = payload.config.ambientC;
      const z = project.pcb.thickness / 2;
      const points = [
        { x: minX, y: minY, z, temperatureC: a + 5 },
        { x: maxX, y: minY, z, temperatureC: a + 20 },
        { x: maxX, y: maxY, z, temperatureC: a + 30 },
        { x: minX, y: maxY, z, temperatureC: a + 10 },
        { x: minX, y: minY, z: -z, temperatureC: a + 4 },
        { x: maxX, y: minY, z: -z, temperatureC: a + 18 },
        { x: maxX, y: maxY, z: -z, temperatureC: a + 25 },
        { x: minX, y: maxY, z: -z, temperatureC: a + 9 },
      ];
      const power = payload.config.heatSources.reduce((sum, item) => sum + item.powerW, 0);
      savedThermal = {
        config: payload.config,
        result: {
          version: 1,
          status: 'completed',
          basis: model.basis,
          solver: { gmsh: 'fixture Gmsh', elmer: 'fixture Elmer' },
          points,
          triangles: [
            [0, 1, 2],
            [0, 2, 3],
            [4, 5, 6],
            [4, 6, 7],
          ],
          statistics: {
            minC: a + 4,
            maxC: a + 30,
            meanC: points.reduce((sum, point) => sum + point.temperatureC, 0) / points.length,
            inputPowerW: power,
            outputPowerW: power,
            energyImbalanceRelative: 0,
            nodeCount: points.length,
            elementCount: 6,
          },
          assumptions: ['Controlled Layout renderer fixture; no thermal solver was executed.'],
          diagnostics: [],
        },
      };
      return route.fulfill({ json: savedThermal });
    }
    if (url.pathname === '/api/simulation/status')
      return route.fulfill({ json: { available: true, version: 'fixture ngspice' } });
    if (url.pathname === '/api/simulation/result') return route.fulfill({ json: { result: null } });
    if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(url.pathname))
      return route.fulfill({
        contentType: url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        body: await readFile('public' + url.pathname),
      });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
    await page.addStyleTag({ content: file.text });
  await page.addScriptTag({
    content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
  });
  await page.getByTestId('schematic-canvas').waitFor();
  assert.equal(statusRequests, 0, 'Thermal code is dormant before it is opened.');
  assert.equal(
    await page.evaluate(() =>
      window
        .thermalWorkbenchHost()
        .catalog()
        .some((entry) => entry.id === 'thermal.status'),
    ),
    false,
  );
  const unopened = await page.evaluate(() =>
    window.thermalWorkbenchHost().query('workbench.state'),
  );
  assert.equal(unopened.thermal.status, 'not-opened');
  validateAgentWorkspaceContext(
    unopened,
    project.schematic.id,
    circuitFingerprint(project.schematic),
  );
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  await page.getByRole('button', { name: 'Thermal FEM', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Thermal FEM', exact: true });
  await panel.waitFor();
  const shown = await page.evaluate(() => window.thermalWorkbenchHost().execute('thermal.show'));
  assert.deepEqual(shown, { visible: true }, 'thermal.show awaits the visible lazy component.');
  await waitForAsync(
    page,
    async () => (await window.thermalWorkbenchHost().query('thermal.status')).solver?.available,
  );
  assert.equal(
    await panel.getByRole('textbox', { name: 'U1 (W)', exact: true }).count(),
    1,
    'Loaded footprints use their linked schematic reference.',
  );
  const context = await page.evaluate(() => window.thermalWorkbenchHost().query('workbench.state'));
  assert.equal(context.thermal.boardId, project.pcb.id);
  assert.equal(context.thermal.visible, true);
  validateAgentWorkspaceContext(
    context,
    project.schematic.id,
    circuitFingerprint(project.schematic),
  );
  assert.equal(runRequests, 0, 'Opening Thermal never starts a solve.');
  const baseline = await page.evaluate(async () => ({
    source: await window.thermalWorkbenchHost().query('project.source'),
    history: await window.thermalWorkbenchHost().query('history.get'),
    dirty: (await window.thermalWorkbenchHost().query('workbench.state')).ui.dirty,
  }));
  await panel.getByRole('textbox', { name: 'U1 (W)', exact: true }).fill('1');
  await panel.getByRole('textbox', { name: 'U1 (W)', exact: true }).blur();
  await panel.getByRole('button', { name: 'Run', exact: true }).click();
  const layout = page.getByTestId('layout-canvas');
  const field = layout.locator('[data-thermal-field]');
  const layoutTemperature = page.getByRole('region', {
    name: 'Layout board temperature',
    exact: true,
  });
  await field.waitFor();
  await layoutTemperature.waitFor();
  assert.equal(runRequests, 1);
  assert.equal(await field.getAttribute('data-thermal-surface'), 'front');
  const raster = field.locator('[data-thermal-raster]');
  const frontOrigin = savedThermal.result.points[0];
  const frontCorner = savedThermal.result.points[2];
  assert.deepEqual(
    await raster.evaluate((image) =>
      ['x', 'y', 'width', 'height'].map((key) => Number(image.getAttribute(key))),
    ),
    [frontOrigin.x, frontOrigin.y, frontCorner.x - frontOrigin.x, frontCorner.y - frontOrigin.y],
    'The solved field occupies its real PCB bounds inside the existing Layout canvas.',
  );
  assert.equal(
    await panel
      .getByRole('button', { name: 'Show temperature in Layout', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  );
  const viewWithField = await layout.getAttribute('viewBox');
  const frontPaint = await raster.getAttribute('href');
  assert.match(frontPaint, /^data:image\/png;base64,/);
  assert.equal(
    await field.locator('[data-thermal-hottest]').getAttribute('data-thermal-hottest'),
    '2',
  );
  const surface = panel.getByRole('combobox', { name: 'Thermal surface', exact: true });
  await surface.press('ArrowDown');
  await surface.press('End');
  await surface.press('Enter');
  await page.waitForFunction(
    () =>
      document.querySelector('[data-thermal-field]')?.getAttribute('data-thermal-surface') ===
      'back',
  );
  assert.notEqual(
    await raster.getAttribute('href'),
    frontPaint,
    'Changing surface draws the corresponding solver temperatures.',
  );
  assert.equal(
    await field.locator('[data-thermal-hottest]').getAttribute('data-thermal-hottest'),
    '6',
  );
  await panel.getByRole('button', { name: 'Export temperature map', exact: true }).click();
  await page.waitForFunction(() => window.thermalExports.length === 1);
  assert.equal(
    await page.evaluate(async () => {
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = window.thermalExports[0].dataUrl;
      });
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 32;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, 32, 32);
      const pixels = context.getImageData(0, 0, 32, 32).data;
      for (let index = 0; index < pixels.length; index += 4) {
        const channels = [...pixels.slice(index, index + 3)];
        if (pixels[index + 3] > 0 && Math.max(...channels) - Math.min(...channels) > 35)
          return true;
      }
      return false;
    }),
    true,
    'Exporting from the docked panel includes the coloured temperature field.',
  );
  assert.equal(
    await layout.getAttribute('viewBox'),
    viewWithField,
    'Changing surface preserves the Layout camera.',
  );
  const showTemperature = panel.getByRole('button', {
    name: 'Show temperature in Layout',
    exact: true,
  });
  await showTemperature.click();
  await field.waitFor({ state: 'detached' });
  assert.equal(await showTemperature.getAttribute('aria-pressed'), 'false');
  assert.equal(await layout.getAttribute('viewBox'), viewWithField);
  assert.equal(
    (await page.evaluate(() => window.thermalWorkbenchHost().query('thermal.status'))).status,
    'completed',
  );
  await showTemperature.click();
  await field.waitFor();
  const probe = panel.getByRole('button', { name: 'Probe Layout temperature', exact: true });
  assert.equal(await probe.getAttribute('aria-pressed'), 'false');
  await probe.click();
  assert.equal(await probe.getAttribute('aria-pressed'), 'true');
  const target = savedThermal.result.points[4];
  const projectedTarget = await layout.evaluate((svg, point) => {
    const local = svg.createSVGPoint();
    // Stay a little inside the mesh so the polygon receives the pointer.
    local.x = point.x + 0.25;
    local.y = point.y + 0.25;
    const screen = local.matrixTransform(svg.getScreenCTM());
    return { x: screen.x, y: screen.y };
  }, target);
  await page.mouse.click(projectedTarget.x, projectedTarget.y);
  await waitForAsync(
    page,
    async () => (await window.thermalWorkbenchHost().query('thermal.status')).probe?.node === 4,
  );
  const probed = await page.evaluate(() => window.thermalWorkbenchHost().query('thermal.status'));
  assert.deepEqual(
    probed.probe,
    { ...target, node: 4 },
    'Canvas probing reports the exact real node on the chosen surface.',
  );
  assert.equal(await field.locator('[data-thermal-probe]').getAttribute('data-thermal-probe'), '4');
  assert.match(await layoutTemperature.innerText(), /Node/);
  assert.ok(
    (await layoutTemperature.innerText()).includes(target.temperatureC.toFixed(2)),
    'Layout readout shows the probed temperature.',
  );
  assert.equal(
    await layout.getAttribute('viewBox'),
    viewWithField,
    'Probing preserves the Layout camera.',
  );
  await layout.hover({ position: { x: 30, y: 30 } });
  await page.mouse.wheel(0, -140);
  await page.waitForFunction(
    (before) =>
      document.querySelector('[data-testid="layout-canvas"]').getAttribute('viewBox') !== before,
    viewWithField,
  );
  const navigatedView = await layout.getAttribute('viewBox');
  await page.getByRole('button', { name: 'Schematic', exact: true }).click();
  await page.getByTestId('schematic-canvas').waitFor();
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  await field.waitFor();
  assert.equal(
    await layout.getAttribute('viewBox'),
    navigatedView,
    'Returning to Layout retains its navigated camera and field.',
  );
  assert.equal(runRequests, 1, 'Surface, visibility, probe and navigation do not solve again.');
  await page.screenshot({ path: 'test-results/thermal-workbench-layout-ui.png' });
  await page.evaluate(() =>
    window.thermalWorkbenchHost().execute('source.update', { draft: 'Pending Source fixture' }),
  );
  await field.waitFor({ state: 'detached' });
  await layoutTemperature.waitFor({ state: 'detached' });
  assert.equal(
    (await page.evaluate(() => window.thermalWorkbenchHost().query('thermal.status'))).result,
    null,
    'Pending Source invalidates displayed temperature evidence.',
  );
  await page.evaluate(() => window.thermalWorkbenchHost().execute('source.discard'));
  await field.waitFor();
  assert.equal(
    runRequests,
    1,
    'Returning to the validated source restores its matching saved result without solving.',
  );
  assert.equal(await layout.getAttribute('viewBox'), navigatedView);
  const unchanged = await page.evaluate(async () => ({
    source: await window.thermalWorkbenchHost().query('project.source'),
    history: await window.thermalWorkbenchHost().query('history.get'),
    dirty: (await window.thermalWorkbenchHost().query('workbench.state')).ui.dirty,
  }));
  assert.deepEqual(
    unchanged,
    baseline,
    'Thermal configuration, result, camera, probe and discarded draft do not mutate the design or undo.',
  );
  await page.screenshot({ path: 'test-results/thermal-workbench-ui.png' });
  await page.getByRole('button', { name: 'Schematic', exact: true }).click();
  await page.getByTestId('schematic-canvas').waitFor();
  await page.evaluate(() =>
    window
      .thermalWorkbenchHost()
      .execute('workbench.plugins.change', { action: 'disable', id: 'pcb-thermal@openpe' }),
  );
  await panel.waitFor({ state: 'detached' });
  await page.waitForFunction(
    () =>
      !window
        .thermalWorkbenchHost()
        .catalog()
        .some((entry) => entry.id === 'thermal.status'),
  );
  const disabled = await page.evaluate(() =>
    window.thermalWorkbenchHost().query('workbench.state'),
  );
  assert.deepEqual(disabled.thermal, { status: 'disabled' });
  validateAgentWorkspaceContext(
    disabled,
    project.schematic.id,
    circuitFingerprint(project.schematic),
  );
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  await layout.waitFor();
  await field.waitFor({ state: 'detached' });
  await layoutTemperature.waitFor({ state: 'detached' });
  const afterTeardownView = (await layout.getAttribute('viewBox')).split(' ').map(Number);
  const beforeTeardownView = navigatedView.split(' ').map(Number);
  assert.deepEqual(afterTeardownView.slice(0, 2), beforeTeardownView.slice(0, 2));
  assert.ok(
    Math.abs(afterTeardownView[3] - beforeTeardownView[3]) < 1e-9,
    'Disabling while Layout is hidden clears its field and retains camera scale as the sidebar closes.',
  );
  assert.equal(
    await page.evaluate(() => window.thermalWorkbenchHost().query('project.source')),
    baseline.source,
  );
  assert.deepEqual(
    await page.evaluate(() => window.thermalWorkbenchHost().query('history.get')),
    baseline.history,
  );
  assert.equal(catalog.plugins.find((row) => row.id === 'spice-simulation@openpe').enabled, true);
  assert.deepEqual(
    await page.evaluate(() => window.thermalWorkbenchHost().execute('simulation.show')),
    { visible: true },
  );
  await page.getByRole('region', { name: 'Simulation settings' }).waitFor();
  assert.equal(
    (await page.evaluate(() => window.thermalWorkbenchHost().query('workbench.state'))).thermal
      .status,
    'disabled',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Thermal Workbench: lazy Layout action, native mesh field/surfaces, real-node canvas probe, visibility, retained camera, Source invalidation, unchanged design and independent plugin teardown passed.',
  );
  console.log(
    'Screenshots: test-results/thermal-workbench-layout-ui.png, test-results/thermal-workbench-ui.png (mocked renderer data; no thermal solver was executed).',
  );
} finally {
  await browser.close();
}
