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
const { defaultAgentPreferences } = await tsImport('../lib/workspace-state.ts', import.meta.url);
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
  ...defaultAgentPreferences,
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
      projectDirectory: async () => ({ entries: [], truncated: false }),
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
    if (url.pathname === '/api/agent-settings')
      return route.fulfill({ json: { followUpMode: 'queue' } });
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
  const nativeSidebar = page.getByRole('complementary', { name: 'Layout sidebar', exact: true });
  const sidebarResize = nativeSidebar.locator('..').getByRole('button', {
    name: 'Resize layout sidebar width',
    exact: true,
  });
  const drawing = page.locator('.layout-main .layout-canvas');
  const nativeWidth = (await nativeSidebar.boundingBox()).width;
  assert.ok(Math.abs(nativeWidth - 300) <= 1, 'The native Layout sidebar starts at 300 px.');
  const nativeDrawingWidth = (await drawing.boundingBox()).width;
  await page.getByRole('button', { name: 'Thermal FEM', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Thermal FEM', exact: true });
  const heatInput = page.getByRole('combobox', { name: 'Thermal heat input', exact: true });
  await heatInput.press('ArrowDown');
  await heatInput.press('Home');
  await heatInput.press('Enter');
  await panel.waitFor();
  const expectThermalWidth = async (expected, drawingWidth) => {
    await page.waitForFunction((expected) => {
      const panel = document.querySelector('[aria-label="Thermal FEM"][data-docked]');
      return panel && Math.abs(panel.getBoundingClientRect().width - expected) <= 1;
    }, expected);
    assert.ok(
      Math.abs((await drawing.boundingBox()).width - drawingWidth) <= 1,
      'Replacing the native sidebar with Thermal preserves the drawing width.',
    );
  };
  await expectThermalWidth(nativeWidth, nativeDrawingWidth);
  const openWithNativeWidth = async () => {
    const width = (await nativeSidebar.boundingBox()).width;
    const drawingWidth = (await drawing.boundingBox()).width;
    await page.getByRole('button', { name: 'Thermal FEM', exact: true }).click();
    await panel.waitFor();
    await expectThermalWidth(width, drawingWidth);
  };
  const closeThermal = async () => {
    await page.getByRole('button', { name: 'Close Thermal', exact: true }).click();
    await nativeSidebar.waitFor();
  };
  await closeThermal();
  for (let i = 0; i < 4; i++) await sidebarResize.press('ArrowLeft');
  assert.ok(Math.abs((await nativeSidebar.boundingBox()).width - (nativeWidth + 64)) <= 1);
  await openWithNativeWidth();
  await closeThermal();
  for (let i = 0; i < 20; i++) await sidebarResize.press('ArrowRight');
  assert.ok(Math.abs((await nativeSidebar.boundingBox()).width - 224) <= 1);
  await openWithNativeWidth();
  await closeThermal();
  for (let i = 0; i < 20; i++) await sidebarResize.press('ArrowLeft');
  await openWithNativeWidth();
  await closeThermal();
  await page.setViewportSize({ width: 1120, height: 920 });
  await openWithNativeWidth();
  assert.ok(
    (await drawing.boundingBox()).width >= 159,
    'Narrow windows retain the native minimum drawing area.',
  );
  await closeThermal();
  await page.setViewportSize({ width: 1480, height: 920 });
  await sidebarResize.dblclick();
  await openWithNativeWidth();
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
  const componentList = panel.getByRole('region', { name: 'Components', exact: true });
  const originalViewport = page.viewportSize();
  await page.setViewportSize({ ...originalViewport, height: 1200 });
  const disclosures = componentList.locator('summary');
  for (const disclosure of await disclosures.all()) await disclosure.click();
  const footer = panel.locator('footer');
  const collapsedPanelBounds = await panel.boundingBox();
  const collapsedFooterBounds = await footer.boundingBox();
  assert.ok(
    Math.abs(
      collapsedPanelBounds.y +
        collapsedPanelBounds.height -
        collapsedFooterBounds.y -
        collapsedFooterBounds.height,
    ) <= 1,
    'Run stays at the panel bottom even when all component categories are collapsed.',
  );
  await panel
    .locator(':scope > div')
    .first()
    .evaluate((body) => {
      body.scrollTop = body.scrollHeight;
    });
  assert.deepEqual(
    await footer.boundingBox(),
    collapsedFooterBounds,
    'Scrolling settings does not move the Run footer.',
  );
  await page.screenshot({ path: 'test-results/thermal-run-bottom.png' });
  for (const disclosure of await disclosures.all()) await disclosure.click();
  await page.setViewportSize(originalViewport);
  const capacitorGroup = componentList.getByRole('group', { name: 'Capacitors (C)', exact: true });
  assert.deepEqual(
    await capacitorGroup.locator('.analysis-component-locate').allTextContents(),
    ['C1', 'C2'],
    'Thermal component labels show references only.',
  );
  await panel.evaluate((element) => {
    element.style.width = '224px';
  });
  const parameterUnits = [
    ['Ambient', '°C'],
    ['Front convection', 'W/m²·K'],
    ['Back convection', 'W/m²·K'],
    ['Edge convection', 'W/m²·K'],
    ['Dielectric conductivity', 'W/m·K'],
    ['Copper conductivity', 'W/m·K'],
    ['Via plating', 'mm'],
    ['Mesh size', 'mm'],
    ...project.pcb.layers.map((layer) => [`${layer} thickness`, 'mm']),
  ];
  for (const [name, unit] of parameterUnits) {
    const input = panel.getByRole('textbox', { name: `${name} (${unit})`, exact: true });
    const control = input.locator('..');
    assert.equal(
      await control.locator(':scope > span').innerText(),
      unit,
      `${name} uses a unit suffix inside its field.`,
    );
    assert.equal(
      await control.locator('..').locator(':scope > span').first().textContent(),
      name,
      'Visible parameter labels omit units.',
    );
    assert.equal(
      await control.evaluate((element) => {
        const input = element.querySelector('input').getBoundingClientRect();
        const suffix = element.querySelector('span').getBoundingClientRect();
        const bounds = element.getBoundingClientRect();
        return (
          input.width >= 32 &&
          input.right <= suffix.left + 1 &&
          suffix.right <= bounds.right &&
          element.scrollWidth <= element.clientWidth + 1
        );
      }),
      true,
      `${name} retains room for the value and complete unit at 224 px.`,
    );
  }
  await panel.getByRole('textbox', { name: 'Ambient (°C)', exact: true }).scrollIntoViewIfNeeded();
  await panel.screenshot({ path: 'test-results/thermal-unit-inputs.png' });
  const compactRows = await capacitorGroup.locator('.simulation-field').evaluateAll((elements) =>
    elements.map((element) => {
      const bounds = element.getBoundingClientRect();
      return {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        overflow: element.scrollWidth > element.clientWidth + 1,
      };
    }),
  );
  assert.ok(
    Math.abs(compactRows[0].y - compactRows[1].y) < 1 &&
      compactRows[1].x > compactRows[0].x + compactRows[0].width,
    'Thermal keeps two columns at its minimum dock width.',
  );
  assert.equal(
    compactRows.some((row) => row.overflow),
    false,
    'References, power inputs and W units fit each compact cell.',
  );
  assert.equal(
    await componentList.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    true,
  );
  await page.screenshot({ path: 'test-results/thermal-components-compact.png' });
  await componentList.scrollIntoViewIfNeeded();
  await componentList.screenshot({ path: 'test-results/thermal-components-refined.png' });
  const originalTheme = await page.evaluate(() => document.documentElement.dataset.theme ?? null);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'dark';
  });
  await componentList.screenshot({ path: 'test-results/thermal-components-refined-dark.png' });
  await page.evaluate((theme) => {
    if (theme === null) delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, originalTheme);
  await panel.evaluate((element) => {
    element.style.width = '';
  });
  const categories = await componentList.locator('.analysis-category-name').allTextContents();
  assert.ok(categories.includes('Integrated circuits'));
  const unitGroup = componentList.getByRole('group', {
    name: 'Integrated circuits (U)',
    exact: true,
  });
  const powerInput = panel.getByRole('textbox', { name: 'U1 (W)', exact: true });
  await powerInput.fill('0.25');
  await powerInput.blur();
  assert.equal(
    await powerInput.getAttribute('title'),
    '0.25',
    'Compact heat inputs expose their full unchanged value on hover.',
  );
  await unitGroup.locator('summary').click();
  assert.equal(await unitGroup.locator('input').first().isDisabled(), true);
  await page.getByRole('button', { name: 'Close Thermal', exact: true }).click();
  await page.getByRole('button', { name: 'Thermal FEM', exact: true }).click();
  assert.equal(
    await unitGroup.getAttribute('open'),
    null,
    'Thermal retains folded categories after reopening.',
  );
  await unitGroup.locator('summary').press('Enter');
  assert.equal(await powerInput.inputValue(), '0.25', 'Collapsing retains heat settings.');
  const targetFootprint = project.pcb.footprints.find(
    (footprint) =>
      footprint.reference === 'U1' ||
      project.schematic.parts.find((part) => part.id === footprint.symbolId)?.ref === 'U1',
  );
  assert.ok(targetFootprint);
  await componentList.getByRole('button', { name: 'Locate U1', exact: true }).click();
  await page
    .getByTestId('layout-canvas')
    .locator(
      `.layout-footprint.selected[data-selection-id="${targetFootprint.id}"] [data-selection-only]`,
    )
    .first()
    .waitFor();
  assert.equal(await panel.isVisible(), true);
  assert.equal(await powerInput.inputValue(), '0.25', 'Locating keeps the heat setting.');
  await componentList.getByRole('button', { name: 'Locate R1', exact: true }).click();
  await componentList.getByRole('button', { name: 'Locate U1', exact: true }).press('Enter');
  await page
    .getByTestId('layout-canvas')
    .locator(
      `.layout-footprint.selected[data-selection-id="${targetFootprint.id}"] [data-selection-only]`,
    )
    .first()
    .waitFor();
  assert.equal(runRequests, 0, 'Locating never starts a solve.');
  assert.deepEqual(
    await page.evaluate(async () => ({
      source: await window.thermalWorkbenchHost().query('project.source'),
      history: await window.thermalWorkbenchHost().query('history.get'),
      dirty: (await window.thermalWorkbenchHost().query('workbench.state')).ui.dirty,
    })),
    baseline,
    'Thermal grouping and locating do not change native design or history.',
  );
  await page.screenshot({ path: 'test-results/thermal-components-locate.png' });
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
  assert.equal(await layoutTemperature.evaluate((card) => !!card.closest('.canvas-wrap')), true);
  assert.equal(await panel.getByText('Minimum', { exact: false }).count(), 0);
  assert.match(
    await layoutTemperature.innerText(),
    /Minimum[\s\S]*Maximum[\s\S]*Mean[\s\S]*Power into board/,
  );
  assert.equal(await layoutTemperature.locator('summary').count(), 0);
  assert.equal(await layoutTemperature.getByText('Hottest components', { exact: true }).count(), 0);
  const heatList = layoutTemperature.getByRole('list', { name: 'Hottest components' });
  await heatList.waitFor({ state: 'attached' });
  assert.equal(
    await heatList.getByRole('listitem').count(),
    0,
    'Unresolved fixture pad areas cannot enter a temperature ranking.',
  );
  assert.match(await layoutTemperature.innerText(), /Pad temperatures unavailable/);
  const componentHighlight = layout.locator('[data-thermal-component-highlight]');
  await componentHighlight.waitFor();
  assert.equal(
    await componentHighlight.getAttribute('data-thermal-component-highlight'),
    targetFootprint.id,
  );
  assert.equal(await componentHighlight.getAttribute('aria-label'), 'Selected component U1');
  const selectedReadout = layoutTemperature.locator('[data-thermal-component-readout]');
  await selectedReadout.waitFor();
  assert.equal(
    await selectedReadout.getAttribute('data-thermal-component-readout'),
    targetFootprint.id,
  );
  assert.match(await selectedReadout.innerText(), /U1[\s\S]*Unavailable/);
  assert.equal(await componentHighlight.locator('text').count(), 0);
  const resistor = project.pcb.footprints.find(
    (footprint) =>
      footprint.reference === 'R1' ||
      project.schematic.parts.find((part) => part.id === footprint.symbolId)?.ref === 'R1',
  );
  await componentList.getByRole('button', { name: 'Locate R1', exact: true }).press('Enter');
  await page.waitForFunction(
    (id) =>
      document
        .querySelector('[data-thermal-component-highlight]')
        ?.getAttribute('data-thermal-component-highlight') === id,
    resistor.id,
  );
  assert.match(await selectedReadout.innerText(), /R1[\s\S]*[\d.]+ °C/);
  const componentClick = await layout
    .locator(`[data-footprint-body="${resistor.id}"]`)
    .evaluate((body) => {
      const point = body.ownerSVGElement.createSVGPoint();
      point.x = Number(body.getAttribute('x')) + Number(body.getAttribute('width')) / 2;
      point.y = Number(body.getAttribute('y')) + Number(body.getAttribute('height')) / 2;
      const screen = point.matrixTransform(body.getScreenCTM());
      return { x: screen.x, y: screen.y };
    });
  await layout.focus();
  await layout.press('Escape');
  await componentHighlight.waitFor({ state: 'detached' });
  await selectedReadout.waitFor({ state: 'detached' });
  await page.mouse.click(componentClick.x, componentClick.y);
  await componentHighlight.waitFor();
  assert.equal(
    await componentHighlight.getAttribute('data-thermal-component-highlight'),
    resistor.id,
  );
  await selectedReadout.waitFor();
  assert.match(await selectedReadout.innerText(), /R1[\s\S]*[\d.]+ °C/);
  assert.equal(
    await selectedReadout.evaluate(
      (readout) => !!readout.closest('[aria-label="Layout board temperature"]'),
    ),
    true,
  );
  const inspectionCamera = await layout.getAttribute('viewBox');
  await page.mouse.move(componentClick.x, componentClick.y);
  await page.mouse.down();
  await page.mouse.move(componentClick.x + 24, componentClick.y + 12);
  await page.mouse.up();
  assert.equal(await layout.getAttribute('viewBox'), inspectionCamera);
  await page.screenshot({ path: 'test-results/thermal-component-inspection.png' });
  const cardBox = await layoutTemperature.boundingBox();
  const drawingBox = await layout.boundingBox();
  assert.ok(
    cardBox.x >= drawingBox.x && cardBox.x + cardBox.width <= drawingBox.x + drawingBox.width,
  );
  assert.ok(
    cardBox.y >= drawingBox.y && cardBox.y + cardBox.height <= drawingBox.y + drawingBox.height,
  );
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
    await page
      .getByRole('button', { name: 'Show temperature in Layout', exact: true })
      .getAttribute('aria-pressed'),
    'true',
  );
  await layout.focus();
  await layout.press('Home');
  const viewWithField = await layout.getAttribute('viewBox');
  const frontPaint = await raster.getAttribute('href');
  const outlines = layout.locator('[data-thermal-component-outlines]');
  const outlineToggle = layoutTemperature.getByRole('button', {
    name: 'Show component outlines',
    exact: true,
  });
  await outlines.waitFor();
  assert.equal(await outlineToggle.getAttribute('aria-pressed'), 'true');
  assert.equal(await outlines.getAttribute('data-thermal-outline-surface'), 'front');
  const frontFootprint = outlines.locator('[data-thermal-outline-footprint]').first();
  await frontFootprint.waitFor();
  const drawnId = await frontFootprint.getAttribute('data-thermal-outline-footprint');
  const nativeFootprint = project.pcb.footprints.find((item) => item.id === drawnId);
  assert.equal(
    await frontFootprint.getAttribute('transform'),
    `translate(${nativeFootprint.x} ${nativeFootprint.y}) rotate(${-nativeFootprint.rotation})`,
  );
  await outlineToggle.click();
  await outlines.waitFor({ state: 'detached' });
  await componentHighlight.waitFor();
  assert.equal(
    await raster.getAttribute('href'),
    frontPaint,
    'Outline visibility never rebuilds the temperature raster.',
  );
  assert.equal(await layout.getAttribute('viewBox'), viewWithField);
  assert.equal(runRequests, 1);
  await outlineToggle.focus();
  assert.equal(
    await outlineToggle.evaluate((button) => {
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        keyCode: 229,
        bubbles: true,
        cancelable: true,
      });
      button.dispatchEvent(event);
      return event.defaultPrevented;
    }),
    true,
  );
  assert.equal(await outlineToggle.getAttribute('aria-pressed'), 'false');
  await outlineToggle.press('Space');
  await outlines.waitFor();
  await page.screenshot({ path: 'test-results/thermal-component-outlines-front.png' });
  assert.match(frontPaint, /^data:image\/png;base64,/);
  assert.equal(
    await layout.locator('[data-thermal-hottest]').getAttribute('data-thermal-hottest'),
    '2',
  );
  const surface = page.getByRole('combobox', { name: 'Thermal surface', exact: true });
  await surface.scrollIntoViewIfNeeded();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
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
  assert.equal(await outlines.getAttribute('data-thermal-outline-surface'), 'back');
  assert.equal(
    await outlines.locator('[data-thermal-outline-footprint]').count(),
    project.pcb.footprints.filter(
      (footprint) =>
        footprint.side === 'back' &&
        footprint.graphics.some(
          (graphic) =>
            ['B.Fab', 'B.SilkS'].includes(graphic.layer) &&
            !['text', 'dimension'].includes(graphic.kind),
        ),
    ).length,
  );
  assert.equal(
    await layout.locator('[data-thermal-hottest]').getAttribute('data-thermal-hottest'),
    '6',
  );
  assert.equal(
    await page.getByRole('button', { name: 'Export temperature map', exact: true }).count(),
    0,
  );
  await page.evaluate(() => window.thermalWorkbenchHost().execute('thermal.exportImage'));
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
  const showTemperature = page.getByRole('button', {
    name: 'Show temperature in Layout',
    exact: true,
  });
  await showTemperature.focus();
  assert.equal(
    await showTemperature.evaluate((button) => {
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        keyCode: 229,
        bubbles: true,
        cancelable: true,
      });
      button.dispatchEvent(event);
      return event.defaultPrevented;
    }),
    true,
  );
  assert.equal(await showTemperature.getAttribute('aria-pressed'), 'true');
  await showTemperature.press('Space');
  await field.waitFor({ state: 'detached' });
  assert.equal(
    await layoutTemperature.isVisible(),
    true,
    'The result card remains usable with the field hidden.',
  );
  assert.equal(await showTemperature.getAttribute('aria-pressed'), 'false');
  assert.equal(await layout.getAttribute('viewBox'), viewWithField);
  assert.equal(
    (await page.evaluate(() => window.thermalWorkbenchHost().query('thermal.status'))).status,
    'completed',
  );
  await showTemperature.click();
  await field.waitFor();
  const probe = page.getByRole('button', { name: 'Probe Layout temperature', exact: true });
  assert.equal(await probe.getAttribute('aria-pressed'), 'false');
  await probe.click();
  assert.equal(await probe.getAttribute('aria-pressed'), 'true');
  const target = savedThermal.result.points[6];
  const projectedTarget = await layout.evaluate((svg, point) => {
    const local = svg.createSVGPoint();
    // Stay a little inside the mesh so the polygon receives the pointer.
    local.x = point.x - 0.25;
    local.y = point.y - 0.25;
    const screen = local.matrixTransform(svg.getScreenCTM());
    return { x: screen.x, y: screen.y };
  }, target);
  await page.mouse.click(projectedTarget.x, projectedTarget.y);
  await waitForAsync(
    page,
    async () => (await window.thermalWorkbenchHost().query('thermal.status')).probe?.node === 6,
  );
  const probed = await page.evaluate(() => window.thermalWorkbenchHost().query('thermal.status'));
  assert.deepEqual(
    probed.probe,
    { ...target, node: 6 },
    'Canvas probing reports the exact real node on the chosen surface.',
  );
  assert.equal(
    await layout.locator('[data-thermal-probe]').getAttribute('data-thermal-probe'),
    '6',
  );
  assert.ok(
    (await layoutTemperature.locator('[data-thermal-probe-readout]').innerText()).includes(
      target.temperatureC.toFixed(2),
    ),
    'The upper-left result card shows the probed temperature.',
  );
  assert.equal(await layout.locator('[data-thermal-probe] text').count(), 0);
  assert.doesNotMatch(
    await layoutTemperature.locator('[data-thermal-probe-readout]').innerText(),
    /Node|mm/,
  );
  const probeSize = await layout.locator('[data-thermal-probe] > circle').boundingBox();
  assert.equal(
    await layout.getAttribute('viewBox'),
    viewWithField,
    'Probing preserves the Layout camera.',
  );
  const canvasBox = await layout.boundingBox();
  await layout.hover({ position: { x: canvasBox.width * 0.75, y: canvasBox.height * 0.75 } });
  await page.mouse.wheel(0, -140);
  await page.waitForFunction(
    (before) =>
      document.querySelector('[data-testid="layout-canvas"]').getAttribute('viewBox') !== before,
    viewWithField,
  );
  const navigatedView = await layout.getAttribute('viewBox');
  const zoomedProbeSize = await layout.locator('[data-thermal-probe] > circle').boundingBox();
  assert.ok(
    Math.abs(probeSize.width - zoomedProbeSize.width) < 0.1,
    'Probe markers retain their screen size while zooming.',
  );
  await page.getByRole('button', { name: 'Schematic', exact: true }).click();
  await page.getByTestId('schematic-canvas').waitFor();
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  await field.waitFor();
  const returnedCamera = await layout.getAttribute('viewBox');
  const returnedView = returnedCamera.split(' ').map(Number);
  const expectedView = navigatedView.split(' ').map(Number);
  assert.ok(
    returnedView.every((value, index) => Math.abs(value - expectedView[index]) < 1e-9),
    'Returning to Layout retains its navigated camera and field within numeric precision.',
  );
  assert.equal(runRequests, 1, 'Surface, visibility, probe and navigation do not solve again.');
  await page.screenshot({ path: 'test-results/thermal-workbench-layout-ui.png' });
  await page.evaluate(() =>
    window.thermalWorkbenchHost().execute('source.update', { draft: 'Pending Source fixture' }),
  );
  assert.equal(
    await componentList.getByRole('button', { name: 'Locate U1', exact: true }).isDisabled(),
    true,
    'Pending Source blocks Thermal locating.',
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
  assert.equal(await layout.getAttribute('viewBox'), returnedCamera);
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
