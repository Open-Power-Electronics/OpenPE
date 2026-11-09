import { runCanvasAction } from './canvas-context-menu-test-helpers.mjs';
import { fileMenuAction } from './file-menu-test-helpers.mjs';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { bundledWorkbenchCatalog } from '../server/workbench-plugins.mjs';
import { tsImport } from 'tsx/esm/api';
import { readSource, fillSource } from './source-editor-test-helpers.mjs';
import { openSchematicPanel } from './schematic-visualization-test-helpers.mjs';
const { switchingStageFixture } = await tsImport(
  '../tests/fixtures/switching-stage.ts',
  import.meta.url,
);
const { createProject, serializeProject, parseProject } = await tsImport(
  '../lib/project.ts',
  import.meta.url,
);
const { buildSpiceDeck } = await tsImport('../lib/spice.ts', import.meta.url);
const { defaultAgentPreferences } = await tsImport('../lib/workspace-state.ts', import.meta.url);
const { projectNativeFiles } = await tsImport('../lib/kicad-project.ts', import.meta.url);
const { children, parseSExpr, quote, val, writeSExpr } = await tsImport(
  '../lib/sexpr.ts',
  import.meta.url,
);
function editNativePart(text, reference, changes) {
  const root = parseSExpr(text);
  const symbol = children(root, 'symbol').find((node) =>
    children(node, 'property').some(
      (field) => val(field) === 'Reference' && val(field, 2) === reference,
    ),
  );
  assert.ok(symbol, `Native schematic contains ${reference}.`);
  for (const [name, value] of Object.entries(changes)) {
    const field = children(symbol, 'property').find((field) => val(field) === name);
    assert.ok(field, `${reference} contains native ${name}.`);
    field[2] = quote(value);
  }
  return writeSExpr(root) + '\n';
}
const { appearanceVariables, defaultAppearance } = await tsImport(
  '../lib/appearance.ts',
  import.meta.url,
);
// Isolated renderer with deterministic solver fixtures; no desktop or real solver.
await mkdir('test-results', { recursive: true });
const circuit = switchingStageFixture();
const source = serializeProject(createProject(circuit));
let expectedSource = source;
const workbench = bundledWorkbenchCatalog();
let state = {
  version: 2,
  documents: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      source,
      sourceDraft: null,
      dirty: false,
      filename: 'buck.kicad_pro',
      sessions: [{ id: 'session-one', messages: [], draft: '' }],
      activeSessionId: 'session-one',
    },
  ],
  activeDocumentId: '00000000-0000-4000-8000-000000000001',
  provider: 'codex',
  effort: 'low',
  approvalMode: 'review',
  models: { ...defaultAgentPreferences.models },
};
const bundle = await build({
  stdin: {
    contents:
      "import React from 'react'; import {createRoot} from 'react-dom/client'; import Workspace from './components/DesktopWorkspace'; createRoot(document.getElementById('root')).render(<Workspace/>);",
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outdir: 'test-results/simulation-ui-bundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [
    {
      name: 'observe-simulation-fixture-core',
      setup(plugin) {
        plugin.onLoad({ filter: /[\\/]components[\\/]Workbench\.tsx$/ }, async ({ path: file }) => {
          const original = await readFile(file, 'utf8');
          const marker = 'const { project, sourceDraft, sourceError } = coreSnapshot;';
          const hostMarker = 'const [activeSchematicId, setActiveSchematicId] = useState(';
          assert.ok(
            original.includes(marker) && original.includes(hostMarker),
            'Observe the real Workbench Core and capability host.',
          );
          return {
            contents: original
              .replace(marker, marker + '\nwindow.simulationTestCore = core;')
              .replace(hostMarker, 'window.simulationTestHost = capabilityHost;\n' + hostMarker),
            resolveDir: path.dirname(file),
            loader: 'tsx',
          };
        });
      },
    },
  ],
});
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(15000);
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
      connection: async () => ({ base: 'http://localhost', token: 'test' }),
      newFile: async () => crypto.randomUUID(),
      releaseFile: async () => {},
      projectDirectory: async () => ({ entries: [], truncated: false }),
      setDirty: async () => {},
      onCloseRequested: () => () => {},
    };
  });
  let requests = 0;
  let constantValue = null;
  let holdRun = false;
  let heldRoute;
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/workbench-plugins') {
      if (route.request().method() === 'POST') {
        const { action } = route.request().postDataJSON();
        workbench.plugins[0].installed = action !== 'uninstall';
        workbench.plugins[0].enabled = action === 'install' || action === 'enable';
        return route.fulfill({ json: { ok: true } });
      }
      return route.fulfill({ json: { ...workbench, updatedAt: Date.now() } });
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
    if (url.pathname === '/api/state') {
      if (route.request().method() === 'POST') state = route.request().postDataJSON();
      return route.fulfill({ json: state });
    }
    if (url.pathname === '/api/agent-settings')
      return route.fulfill({ json: { followUpMode: 'queue' } });
    if (url.pathname === '/api/appearance') return route.fulfill({ json: null });
    if (url.pathname === '/api/agents') return route.fulfill({ json: [] });
    if (url.pathname === '/api/models')
      return route.fulfill({ json: { models: [], defaultModel: '' } });
    if (url.pathname === '/api/simulation/status')
      return route.fulfill({ json: { available: true, version: 'fixture ngspice' } });
    if (url.pathname === '/api/simulation/result') return route.fulfill({ json: { result: null } });
    if (url.pathname === '/api/simulation/transient') {
      const payload = route.request().postDataJSON();
      assert.deepEqual(JSON.parse(payload.source), JSON.parse(expectedSource));
      requests++;
      if (holdRun) {
        heldRoute = route;
        return;
      }
      const deck = buildSpiceDeck(parseProject(payload.source).schematic, payload.config);
      return route.fulfill({
        json: {
          version: 'fixture ngspice',
          log: 'Controlled fixture, not solver output.',
          time: Array.from({ length: 801 }, (_, i) => (i * 0.002) / 800),
          traces: deck.traces.map((t) => ({
            ...t,
            values: Array.from({ length: 801 }, (_, i) => {
              if (constantValue !== null) return constantValue;
              const time = (i * 0.002) / 800;
              const rise = 1 - Math.exp(-time / 0.00022);
              return (
                rise *
                (t.unit === 'V'
                  ? 12 + 0.35 * Math.sin(time * 2 * Math.PI * 20000)
                  : 1.2 + 0.25 * (2 * ((time * 20000) % 1) - 1))
              );
            }),
          })),
        },
      });
    }
    if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(url.pathname))
      return route.fulfill({
        contentType: url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        body: await readFile('public' + url.pathname),
      });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  await page.addStyleTag({ content: await readFile('app/globals.css', 'utf8') });
  await page.addStyleTag({ content: await readFile('app/workspace.css', 'utf8') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const canvas = page.getByTestId('schematic-canvas');
  await canvas.waitFor();
  const button = (name) => page.getByRole('button', { name, exact: true });
  const settings = page.getByRole('region', { name: 'Simulation settings' });
  const dock = page.getByRole('region', { name: 'Simulation waveforms' });
  const settingsHost = page.locator('.simulation-settings-host');
  const propertiesSidebar = page.getByTestId('schematic-properties-panel');
  const chat = page.locator('.chat-panel:visible');
  const originalChat = await chat.boundingBox();
  const composer = page.getByPlaceholder('Work with Codex', { exact: true });
  await composer.fill('Keep this Agent draft while probing.');
  async function openSimulation() {
    if (!(await settings.isVisible())) await button('SPICE Simulation').click();
  }
  const sourceSnapshot = () =>
    page.evaluate(() => {
      const core = window.simulationTestCore,
        snapshot = core.getSnapshot();
      return {
        source: snapshot.source,
        sourceDraft: snapshot.sourceDraft,
        undoDepth: snapshot.undoDepth,
        redoDepth: snapshot.redoDepth,
        native: core.getNativeFiles(),
      };
    });
  const primarySimulationSource = () =>
    page.evaluate(() => {
      const core = window.simulationTestCore;
      return JSON.stringify(
        core.query('schematic.get', { schematicId: core.getSnapshot().project.schematic.id }),
      );
    });
  async function selectSchematicSource() {
    const snapshot = await sourceSnapshot();
    const name = snapshot.native.entry.replace(/\.kicad_pro$/i, '.kicad_sch');
    assert.ok(snapshot.native.files.some((file) => file.name === name));
    await page
      .getByRole('navigation', { name: 'Project files', exact: true })
      .getByRole('button', { name, exact: true })
      .click();
    return name;
  }
  assert.equal(
    await page
      .getByRole('group', { name: 'Canvas modes', exact: true })
      .getByRole('button')
      .count(),
    2,
  );
  assert.equal(await button('Simulation mode').count(), 0);
  assert.equal(
    await page
      .getByRole('group', { name: 'Analysis and display', exact: true })
      .getByRole('button', { name: 'Component properties', exact: true })
      .count(),
    0,
  );
  await propertiesSidebar.waitFor();
  const ordinarySidebarWidth = (await propertiesSidebar.boundingBox()).width;
  const cameraTransform = () =>
    canvas.evaluate((svg) => {
      const { a, b, c, d, e, f } = svg.getScreenCTM();
      return { a, b, c, d, e, f };
    });
  async function assertCameraRetained(expected, message) {
    // Catch delayed automatic Fit as well as the immediate panel transition.
    await page.waitForTimeout(120);
    const actual = await cameraTransform();
    for (const key of Object.keys(expected))
      assert.ok(Math.abs(actual[key] - expected[key]) < 0.01, `${message} (${key}).`);
  }
  async function assertSidebarWidth(expected, message) {
    await settings.waitFor();
    assert.ok(Math.abs((await settingsHost.boundingBox()).width - expected) < 1, message);
  }
  await canvas.press('Space');
  await page.waitForTimeout(120);
  const fittedCamera = await cameraTransform();
  await runCanvasAction(page, 'Zoom in');
  const zoomedCamera = await cameraTransform();
  assert.ok(zoomedCamera.a > fittedCamera.a, 'The camera fixture starts with a custom zoom.');
  const panBounds = await canvas.boundingBox();
  const panStart = { x: panBounds.x + panBounds.width / 3, y: panBounds.y + panBounds.height / 3 };
  await page.mouse.move(panStart.x, panStart.y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(panStart.x + 37, panStart.y + 23, { steps: 6 });
  await page.mouse.up({ button: 'middle' });
  const retainedCamera = await cameraTransform();
  assert.ok(
    Math.abs(retainedCamera.e - zoomedCamera.e) > 30 &&
      Math.abs(retainedCamera.f - zoomedCamera.f) > 20,
    'The camera fixture starts with a custom pan.',
  );
  await openSimulation();
  await assertSidebarWidth(ordinarySidebarWidth, 'Simulation keeps the ordinary sidebar width.');
  await assertCameraRetained(retainedCamera, 'Opening Simulation preserves the current camera');
  await button('SPICE Simulation').click();
  await assertCameraRetained(
    retainedCamera,
    'Clicking Simulation again preserves the current camera',
  );
  await button('Close simulation settings').click();
  await propertiesSidebar.waitFor();
  await assertCameraRetained(retainedCamera, 'Closing Simulation preserves the current camera');
  await openSimulation();
  await assertCameraRetained(retainedCamera, 'Reopening Simulation preserves the current camera');
  await button('Close simulation settings').click();
  await propertiesSidebar.waitFor();
  const sidebarResize = propertiesSidebar.locator('..').getByRole('button', {
    name: 'Resize properties width',
    exact: true,
  });
  await sidebarResize.press('ArrowLeft');
  await sidebarResize.press('ArrowLeft');
  const resizedSidebarWidth = (await propertiesSidebar.boundingBox()).width;
  assert.ok(resizedSidebarWidth > ordinarySidebarWidth + 16, 'Resize the ordinary sidebar first.');
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const resizedCamera = await cameraTransform();
  await openSimulation();
  await assertSidebarWidth(
    resizedSidebarWidth,
    'Simulation keeps the resized ordinary sidebar width.',
  );
  await assertCameraRetained(
    resizedCamera,
    'Opening Simulation after resizing preserves the camera',
  );
  await button('Close simulation settings').click();
  await propertiesSidebar.waitFor();
  await page.evaluate(() =>
    window.simulationTestHost.execute('simulation.show', {}, { actor: 'agent' }),
  );
  await assertSidebarWidth(
    resizedSidebarWidth,
    'The Simulation capability keeps the sidebar width.',
  );
  await assertCameraRetained(
    resizedCamera,
    'The Simulation capability preserves the current camera',
  );
  await button('Close simulation settings').click();
  await propertiesSidebar.waitFor();
  await sidebarResize.press('Home');
  console.log('Simulation sidebar width and camera retention passed for toolbar and Agent entry.');
  await openSimulation();
  await canvas.press('Space');
  await page.waitForTimeout(120);
  assert.equal(await dock.count(), 0, 'Waveforms stay hidden until a canvas probe.');
  assert.equal(
    await page.locator('.simulation-host:visible').count(),
    0,
    'Hidden dock reserves no canvas space.',
  );
  assert.equal(requests, 0, 'Opening simulation never starts a solver.');
  assert.equal(await settings.getByText('Models and netlist', { exact: true }).count(), 0);
  assert.equal(await settings.getByText('Ideal switching · Buck', { exact: true }).count(), 0);
  assert.equal(await button('Check bundled ngspice').count(), 0);
  await settings.waitFor();
  assert.equal(
    await button('Simulate').count(),
    0,
    'No duplicate start action in the upper-right toolbar.',
  );
  assert.equal(await page.getByRole('dialog').count(), 0, 'Settings are nonmodal.');
  const settingsBox = await settings.boundingBox(),
    canvasBox = await canvas.boundingBox(),
    drawingBox = await page.locator('.schematic-drawing:visible').boundingBox();
  assert.ok(
    Math.abs(canvasBox.x + canvasBox.width - settingsBox.x) < 2,
    'Settings dock beside the schematic without covering its drawing.',
  );
  assert.ok(
    Math.abs(settingsBox.y - drawingBox.y) < 2 &&
      Math.abs(settingsBox.height - drawingBox.height) < 2,
    'The settings dock fills the drawing height.',
  );
  await assertSidebarWidth(
    ordinarySidebarWidth,
    'Resetting Properties restores the shared sidebar width.',
  );
  assert.equal(
    await propertiesSidebar.isVisible(),
    false,
    'Simulation replaces the ordinary Properties sidebar.',
  );
  const settingRows = await settings.locator('.simulation-field').evaluateAll((rows) =>
    rows.map((row) => {
      const bounds = row.getBoundingClientRect();
      const label = row.querySelector(':scope > span').getBoundingClientRect();
      const control = row.querySelector('input, .select-trigger').getBoundingClientRect();
      return {
        x: bounds.x,
        top: bounds.top,
        bottom: bounds.bottom,
        labelRight: label.right,
        controlLeft: control.left,
      };
    }),
  );
  assert.ok(settingRows.length > 1);
  assert.ok(
    settingRows.every(
      (row, index) =>
        row.labelRight <= row.controlLeft &&
        Math.abs(row.x - settingRows[0].x) < 1 &&
        (!index || settingRows[index - 1].bottom <= row.top),
    ),
    'Settings use one labeled control row per field.',
  );
  const chatBox = await chat.boundingBox();
  assert.equal(chatBox.width, originalChat.width, 'Simulation preserves the Agent panel width.');
  assert.ok(chatBox.x + chatBox.width <= settingsBox.x, 'Settings sit to the right of Agent.');
  assert.equal(await composer.inputValue(), 'Keep this Agent draft while probing.');
  assert.equal(
    await page.getByRole('separator', { name: 'Resize simulation settings' }).count(),
    0,
  );
  const waveformResize = page.getByRole('separator', { name: 'Resize waveform panel' });
  async function dragDivider(handle, dx, dy, cancel = false) {
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 6 });
    if (cancel) await page.keyboard.press('Escape');
    await page.mouse.up();
  }
  async function clickCanvasTarget(target, { modifiers = [], clickCount = 1 } = {}) {
    await target.waitFor({ state: 'visible' });
    for (let attempt = 0; attempt < 4; attempt++) {
      const point = await target.evaluate((element) => {
        const svg = element.closest('[data-testid="schematic-canvas"]');
        const bounds = element.getBoundingClientRect();
        const canvas = svg.getBoundingClientRect();
        const owner = element.closest('[data-selection-id]')?.getAttribute('data-selection-id');
        const pin = element.closest('[data-probe-pin]');
        const matches = (hit) =>
          hit &&
          svg.contains(hit) &&
          !hit.closest('.simulation-settings-host') &&
          (pin
            ? hit.closest('[data-probe-pin]') === pin
            : owner &&
              hit.closest('[data-selection-id]')?.getAttribute('data-selection-id') === owner);
        for (const [x, y] of [
          [0.5, 0.5],
          [0.25, 0.5],
          [0.75, 0.5],
          [0.5, 0.25],
          [0.5, 0.75],
        ]) {
          const at = { x: bounds.x + bounds.width * x, y: bounds.y + bounds.height * y };
          if (
            at.x > canvas.left + 4 &&
            at.x < canvas.right - 4 &&
            at.y > canvas.top + 4 &&
            at.y < canvas.bottom - 4 &&
            matches(document.elementFromPoint(at.x, at.y))
          )
            return { click: at };
        }
        const panel = document.querySelector('.simulation-settings-host:not([hidden])');
        const panelBounds = panel?.getBoundingClientRect();
        const clearRight = panelBounds?.width ? panelBounds.left : canvas.right;
        const destination = {
          x: canvas.x + Math.max(20, Math.min(90, (clearRight - canvas.x) / 2)),
          y: canvas.y + canvas.height / 2,
        };
        const start = [0.5, 0.75, 0.25]
          .map((fraction) => ({ x: destination.x, y: canvas.y + canvas.height * fraction }))
          .find((at) => svg.contains(document.elementFromPoint(at.x, at.y)));
        return {
          start,
          dx: Math.max(
            -canvas.width * 0.7,
            Math.min(canvas.width * 0.7, destination.x - bounds.x - bounds.width / 2),
          ),
          dy: Math.max(
            -canvas.height * 0.7,
            Math.min(canvas.height * 0.7, destination.y - bounds.y - bounds.height / 2),
          ),
          viewBox: svg.getAttribute('viewBox'),
        };
      });
      if (point.click) {
        for (const modifier of modifiers) await page.keyboard.down(modifier);
        try {
          // Use the visible symbol or pin after the drawing viewport settles.
          await page.mouse.click(point.click.x, point.click.y, { clickCount });
        } finally {
          for (const modifier of [...modifiers].reverse()) await page.keyboard.up(modifier);
        }
        return;
      }
      assert.ok(point.start && attempt < 3, 'Canvas target must be reachable outside settings.');
      await page.mouse.move(point.start.x, point.start.y);
      await page.mouse.down({ button: 'middle' });
      await page.mouse.move(point.start.x + point.dx, point.start.y + point.dy, { steps: 6 });
      await page.mouse.up({ button: 'middle' });
      await page.waitForFunction(
        (previous) =>
          document.querySelector('[data-testid="schematic-canvas"]').getAttribute('viewBox') !==
          previous,
        point.viewBox,
      );
    }
  }
  await button('Interaction mode').click();
  assert.equal(
    (await canvas.boundingBox()).width,
    canvasBox.width,
    'Interaction mode preserves the docked drawing width.',
  );
  await openSimulation();
  assert.ok(Math.abs((await settings.boundingBox()).width - settingsBox.width) < 2);
  await openSimulation();
  await button('Run').click();
  await page.locator('.simulation-result-controls').waitFor({ state: 'attached' });
  assert.equal(await settings.isVisible(), true, 'Settings stay usable after running.');
  assert.equal(await dock.count(), 0, 'Completing a run does not open the dock.');
  assert.equal(await page.locator('.simulation-host:visible').count(), 0);
  assert.ok((await canvas.boundingBox()).height >= canvasBox.height - 1);
  assert.equal(await page.getByText('Solver log', { exact: true }).count(), 0);
  assert.equal(await page.getByText('fixture ngspice', { exact: true }).count(), 0);
  assert.equal(requests, 1);
  const inductor = page.getByTestId('symbol-hit-L1');
  await clickCanvasTarget(inductor);
  await dock.getByText('I(L1)', { exact: true }).waitFor();
  assert.equal(
    await dock.locator('.simulation-waveform').count(),
    1,
    'First probe selects only the requested trace.',
  );
  const originalDock = await dock.boundingBox();
  await dragDivider(waveformResize, 0, -96);
  assert.ok(Math.abs((await dock.boundingBox()).height - originalDock.height - 96) < 2);
  assert.ok((await canvas.boundingBox()).height >= 120);
  await waveformResize.press('ArrowDown');
  assert.ok(Math.abs((await dock.boundingBox()).height - originalDock.height - 80) < 2);
  await dragDivider(waveformResize, 0, -1000);
  assert.ok((await canvas.boundingBox()).height >= 120, 'Dock cannot consume entire canvas.');
  await waveformResize.press('Home');
  assert.ok(Math.abs((await dock.boundingBox()).height - originalDock.height) < 2);
  assert.equal(
    await page.locator('.project-navigation .dirty-dot').count(),
    0,
    'Resizing is presentation only.',
  );

  const properties = page.getByRole('complementary', { name: 'Object properties' });
  assert.equal(
    await page.getByTestId('part-L1').evaluate((el) => el.classList.contains('is-selected')),
    true,
  );
  assert.equal(await properties.isVisible(), false, 'Probing never opens Properties.');
  await canvas.press('e');
  assert.equal(
    await properties.isVisible(),
    false,
    'Properties shortcut cannot replace simulation settings.',
  );
  await clickCanvasTarget(inductor, { clickCount: 2 });
  assert.equal(await properties.isVisible(), false, 'Double-clicking keeps Properties hidden.');
  assert.equal(await settings.isVisible(), true, 'Simulation settings remain resident.');
  await button('SPICE Simulation').click();
  assert.equal(
    await settings.isVisible(),
    true,
    'The Simulation action keeps the resident sidebar open.',
  );
  const tracesBeforeSidebar = await dock.locator('.simulation-waveform').count();
  const durationBeforeSidebar = await settings
    .getByLabel('Duration (ms)', { exact: true })
    .inputValue();
  const requestsBeforeSidebar = requests;
  await button('Toggle right sidebar').click();
  await propertiesSidebar.waitFor();
  assert.equal(await settings.isVisible(), false, 'The sidebar action restores Properties.');
  assert.equal(await dock.count(), 0, 'Restoring Properties hides the waveform dock.');
  await openSchematicPanel(page, 'Visible layers');
  await page.keyboard.press('Escape');
  await openSimulation();
  await dock.getByText('I(L1)', { exact: true }).waitFor();
  assert.equal(await propertiesSidebar.isVisible(), false);
  assert.equal(
    await settings.getByLabel('Duration (ms)', { exact: true }).inputValue(),
    durationBeforeSidebar,
    'Returning from Properties retains simulation settings.',
  );
  assert.equal(await dock.locator('.simulation-waveform').count(), tracesBeforeSidebar);
  assert.equal(requests, requestsBeforeSidebar, 'Restoring the simulation sidebar never reruns.');
  const count = await dock.locator('.simulation-waveform').count();
  await clickCanvasTarget(inductor);
  assert.equal(
    await dock.locator('.simulation-waveform').count(),
    count,
    'Repeated probing does not duplicate traces.',
  );
  assert.equal(await properties.isVisible(), false);
  const pin = page.locator(
    '[data-probe-part="' + circuit.parts.find((p) => p.ref === 'L1').id + '"][data-probe-pin="0"]',
  );
  await clickCanvasTarget(pin);
  assert.equal(
    await dock.locator('.simulation-waveform').count(),
    count + 1,
    'Pin click selects voltage, not component current.',
  );
  assert.equal(
    await page.getByTestId('part-L1').evaluate((el) => el.classList.contains('is-selected')),
    true,
  );
  assert.equal(await properties.isVisible(), false);
  await canvas.press('Space');
  await clickCanvasTarget(page.getByTestId('symbol-hit-C1'), { modifiers: ['Shift'] });
  assert.equal(
    await page.locator('.part.is-selected').count(),
    2,
    'Shift-click extends selection while simulation is available.',
  );
  assert.equal(await properties.isVisible(), false);
  await clickCanvasTarget(page.getByTestId('annotation-value-L1'));
  assert.equal(await properties.isVisible(), false);
  assert.equal(await settings.isVisible(), true);
  assert.equal(await properties.isVisible(), false);
  await canvas.click({ position: { x: 15, y: 15 } });
  assert.equal(
    await properties.isVisible(),
    false,
    'Clicking empty canvas keeps Properties hidden.',
  );
  assert.equal(await page.locator('.part.is-selected').count(), 0);
  await clickCanvasTarget(inductor);
  assert.equal(await properties.isVisible(), false);
  await canvas.focus();
  await button('Annotation mode').click();
  await openSimulation();
  assert.equal(
    await page.locator('.canvas-wrap.tool-annotate').count(),
    1,
    'Opening simulation preserves Annotation mode.',
  );
  assert.equal(await settings.isVisible(), true, 'Annotation keeps simulation settings open.');
  await clickCanvasTarget(inductor);
  await dock.getByText('I(L1)', { exact: true }).waitFor();
  await canvas.focus();
  await canvas.press('Delete');
  await canvas.press('r');
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  assert.equal(await properties.isVisible(), false);
  assert.equal(await page.getByTestId('part-L1').count(), 1);
  const cursor = dock.getByRole('slider', { name: /cursor A$/ }).first();
  const cursorB = dock.getByRole('slider', { name: /cursor B$/ }).first();
  assert.equal(await cursor.count(), 1);
  assert.equal(await cursorB.count(), 0);
  await dock.getByRole('button', { name: 'Add second cursor', exact: true }).click();
  await cursor.focus();
  await cursor.press('End');
  assert.equal(await cursor.getAttribute('aria-valuenow'), '0.002');
  await cursorB.press('Home');
  assert.equal(await cursorB.getAttribute('aria-valuenow'), '0');
  assert.equal(await cursor.getAttribute('aria-valuenow'), '0.002');
  await cursorB.press('End');
  await dock
    .locator('.simulation-waveform > svg')
    .first()
    .click({ position: { x: 60, y: 45 } });
  assert.equal(await cursor.getAttribute('aria-valuenow'), '0');
  assert.equal(await cursorB.getAttribute('aria-valuenow'), '0.002');
  assert.equal(
    await page.locator('.canvas-wrap.tool-annotate').count(),
    1,
    'Waveform cursor interactions preserve Annotation mode.',
  );
  await page.screenshot({ path: 'test-results/simulation-probes-light.png' });
  await button('Interaction mode').click();
  assert.equal(await properties.isVisible(), false);
  const cb = await canvas.boundingBox(),
    db = await dock.boundingBox();
  assert.ok(cb.height > 100 && db.height <= 340 && cb.y + cb.height <= db.y + 1);
  await page.setViewportSize({ width: 1100, height: 740 });
  await page.evaluate(
    (variables) => {
      document.documentElement.dataset.theme = 'dark';
      for (const [key, value] of Object.entries(variables))
        document.documentElement.style.setProperty(key, value);
    },
    appearanceVariables(defaultAppearance, 'dark'),
  );
  await canvas.press('Space');
  const plotBox = await dock.locator('.simulation-plots').boundingBox();
  const firstChart = await dock.locator('.simulation-waveform > svg').first().boundingBox();
  assert.ok(
    firstChart.y + firstChart.height <= plotBox.y + plotBox.height + 1,
    'Compact dock shows the entire first chart, including time ticks.',
  );
  await page.screenshot({ path: 'test-results/simulation-probes-dark.png' });
  await dragDivider(waveformResize, 0, -130);
  const cursorHit = cursor.locator('.simulation-cursor-hit');
  await cursor.press('Home');
  const cursorStart = await cursorHit.boundingBox();
  await cursor.press('End');
  const cursorEnd = await cursorHit.boundingBox();
  await cursor.press('Home');
  const cursorHome = await cursorHit.boundingBox();
  assert.ok(cursorStart && cursorEnd && cursorHome);
  assert.ok(cursorEnd.x > cursorStart.x, 'Home and End expose distinct native time positions.');
  const midpoint = (cursorStart.x + cursorStart.width / 2 + cursorEnd.x + cursorEnd.width / 2) / 2;
  const cursorPoint = {
    x: cursorHome.x + cursorHome.width / 2,
    y: cursorHome.y + cursorHome.height / 2,
  };
  assert.equal(
    await page.evaluate(
      ({ x, y }) =>
        document
          .elementFromPoint(x, y)
          ?.closest('[data-waveform-cursor]')
          ?.getAttribute('data-waveform-cursor'),
      cursorPoint,
    ),
    '0',
    'Cursor A handle is reachable without a covering control or cursor.',
  );
  await page.mouse.move(cursorPoint.x, cursorPoint.y);
  await page.mouse.down();
  await page.mouse.move(midpoint, cursorPoint.y, { steps: 4 });
  await page.mouse.up();
  assert.ok(
    Math.abs(Number(await cursor.getAttribute('aria-valuenow')) - 0.001) < 0.00002,
    'Dragging Cursor A to its measured midpoint follows native sample time after resize.',
  );
  await page.screenshot({ path: 'test-results/simulation-resized-dark.png' });
  await waveformResize.press('Home');
  assert.equal(await dock.evaluate((el) => el.scrollWidth > el.clientWidth), false);
  assert.equal(await settings.evaluate((el) => el.scrollWidth > el.clientWidth), false);
  assert.equal(await composer.isEditable(), true);
  const compactChat = await chat.boundingBox(),
    compactSettings = await settings.boundingBox();
  assert.ok(compactChat.x + compactChat.width <= compactSettings.x);
  assert.ok(await button('Run').isVisible());
  await page.setViewportSize({ width: 1280, height: 850 });
  await button('Interaction mode').click();
  assert.equal(await dock.count(), 1, 'Mode switching keeps waveforms visible.');
  await button('Close simulation settings').click();
  assert.equal(await dock.count(), 0, 'Closing the window exits simulation and hides waveforms.');
  assert.equal(await button('SPICE Simulation').getAttribute('aria-pressed'), 'false');
  await canvas.press('Space');
  // Fit is intentionally deferred until canvas resize settles.
  await page.waitForTimeout(120);
  await clickCanvasTarget(inductor);
  await properties.waitFor();
  assert.equal(
    await properties.getByLabel('Component reference', { exact: true }).inputValue(),
    'L1',
    'Ordinary component properties return after exiting simulation.',
  );
  assert.equal(await dock.count(), 0, 'Clicks outside simulation do not reopen waveforms.');
  const beforePropertiesDraft = await sourceSnapshot();
  const referenceDraft = properties.getByLabel('Component reference', { exact: true });
  await referenceDraft.fill('');
  await openSimulation();
  await settings.waitFor();
  assert.equal(await propertiesSidebar.isVisible(), false);
  await button('Close simulation settings').click();
  await properties.waitFor();
  assert.equal(
    await referenceDraft.inputValue(),
    '',
    'An invalid Properties draft survives opening and closing the Simulation sidebar.',
  );
  assert.deepEqual(await sourceSnapshot(), beforePropertiesDraft);
  await referenceDraft.press('Escape');
  assert.equal(await referenceDraft.inputValue(), 'L1');
  await openSimulation();
  await dock.getByText('I(L1)', { exact: true }).waitFor();
  await openSimulation();
  const displayedWaveforms = async () => ({
    paths: await dock
      .locator('.simulation-trace')
      .evaluateAll((paths) => paths.map((p) => p.getAttribute('d'))),
    cursors: await dock
      .getByRole('slider')
      .evaluateAll((sliders) => sliders.map((s) => s.getAttribute('aria-valuenow'))),
  });
  const completedWaveforms = await displayedWaveforms();
  assert.ok(completedWaveforms.paths.length && completedWaveforms.cursors.length);
  const completedRequests = requests;
  await settings.getByLabel('Input voltage (V)', { exact: true }).fill('18');
  assert.deepEqual(
    await displayedWaveforms(),
    completedWaveforms,
    'Electrical parameter edits retain completed samples, view and cursors.',
  );
  await settings.getByLabel('Input voltage (V)', { exact: true }).fill('24');
  const inputSelection = settings.getByRole('combobox', { name: 'DC input', exact: true });
  await inputSelection.click();
  await page.getByRole('option', { name: /^J2 ·/ }).click();
  assert.deepEqual(
    await displayedWaveforms(),
    completedWaveforms,
    'Terminal selection edits retain the displayed result.',
  );
  await inputSelection.click();
  await page.getByRole('option', { name: /^J1 ·/ }).click();
  await page.getByLabel('Duty cycle (%)', { exact: true }).fill('0');
  assert.equal(await button('Run').isDisabled(), true);
  assert.deepEqual(
    await displayedWaveforms(),
    completedWaveforms,
    'Invalid parameter drafts leave completed waveforms visible.',
  );
  assert.equal(requests, completedRequests, 'Editing setup parameters never starts a solver.');
  const validationAlert = settings.getByRole('alert');
  await validationAlert.waitFor();
  assert.equal(await settings.locator('.simulation-settings-footer [role="alert"]').count(), 1);
  const validationBox = await validationAlert.boundingBox();
  const runBox = await button('Run').boundingBox();
  assert.ok(
    validationBox.y + validationBox.height <= runBox.y,
    'Validation errors wrap above Run in the fixed footer.',
  );
  await button('Interaction mode').click();
  assert.equal(await settings.isVisible(), true);
  await button('Close simulation settings').click();
  assert.equal(await settings.count(), 0);
  assert.equal(await page.locator('.chat-panel:visible').count(), 1);
  assert.equal(await cursor.count(), 0, 'Closing simulation settings hides waveform cursors.');
  await openSimulation();
  assert.equal(
    await page.getByLabel('Duty cycle (%)', { exact: true }).inputValue(),
    '0',
    'Closing simulation settings preserves settings.',
  );
  await page.getByLabel('Duty cycle (%)', { exact: true }).fill('50');
  await openSimulation();
  await button('Run').click();
  await dock.getByRole('group', { name: 'Waveform controls' }).waitFor();
  assert.equal(await settings.isVisible(), true, 'Settings stay usable after running.');
  await button('Source').click();
  const beforeDraft = await sourceSnapshot();
  const nativeEntry = beforeDraft.native.files.find(
    (file) => file.name === beforeDraft.native.entry,
  );
  assert.ok(nativeEntry);
  assert.equal(
    await readSource(page),
    nativeEntry.source,
    'Source shows the native project file, not a private snapshot.',
  );
  assert.deepEqual(JSON.parse(beforeDraft.source), JSON.parse(source));
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  await fillSource(page, '{invalid');
  await button('Schematic').click();
  assert.equal(await canvas.isVisible(), false, 'Invalid Source blocks canvas entry.');
  const pendingDraft = await sourceSnapshot();
  assert.equal(
    pendingDraft.source,
    beforeDraft.source,
    'An invalid native draft does not change validated content.',
  );
  assert.equal(pendingDraft.undoDepth, beforeDraft.undoDepth);
  assert.notEqual(pendingDraft.sourceDraft, null);
  await fillSource(page, nativeEntry.source);
  await button('Schematic').click();
  assert.deepEqual(
    await sourceSnapshot(),
    beforeDraft,
    'Restoring the native text leaves design, undo and source files unchanged.',
  );
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  assert.equal(await cursor.count(), 0, 'Pending Source discards prior results.');
  assert.equal(await dock.count(), 0, 'Pending Source clears the old probe intent.');
  await openSimulation();
  await canvas.press('Space');
  await clickCanvasTarget(inductor);
  await dock.getByText('Run the simulation to inspect this point.', { exact: true }).waitFor();
  assert.equal(await properties.isVisible(), false);
  holdRun = true;
  await openSimulation();
  const requested = page.waitForRequest('**/api/simulation/transient');
  await openSimulation();
  await button('Run').click();
  await button('Stop').waitFor();
  await requested;
  await button('Stop').click();
  await button('Run').waitFor();
  await button('Interaction mode').click();
  if (heldRoute) await heldRoute.abort().catch(() => {});
  assert.equal(await cursor.count(), 0, 'Cancelled runs never expose waveforms.');
  await openSimulation();
  const abandoned = page.waitForRequest('**/api/simulation/transient');
  await openSimulation();
  await button('Run').click();
  await abandoned;
  await button('Stop').waitFor();
  await button('Annotation mode').click();
  assert.equal(await button('Stop').isVisible(), true, 'Switching modes keeps the solver running.');
  await button('Interaction mode').click();
  assert.equal(await button('Stop').isVisible(), true);
  await button('Close simulation settings').click();
  await openSimulation();
  await button('Run').waitFor();
  await settings.getByRole('alert').filter({ hasText: 'Simulation cancelled.' }).waitFor();
  if (heldRoute) await heldRoute.abort().catch(() => {});
  const leavingSchematic = page.waitForRequest('**/api/simulation/transient');
  await button('Run').click();
  await leavingSchematic;
  await button('Stop').waitFor();
  await button('Source').click();
  await button('Schematic').click();
  await openSimulation();
  await button('Run').waitFor();
  await settings.getByRole('alert').filter({ hasText: 'Simulation cancelled.' }).waitFor();
  if (heldRoute) await heldRoute.abort().catch(() => {});
  assert.equal(await cursor.count(), 0, 'Leaving the schematic cancels an active run.');
  holdRun = false;
  await openSimulation();
  await button('Run').click();
  await dock.getByRole('group', { name: 'Waveform controls' }).waitFor();
  assert.equal(await settings.isVisible(), true, 'Settings stay usable after running.');
  await fileMenuAction(page, 'New file');
  assert.equal(
    await cursor.count(),
    0,
    "A different schematic cannot display the prior file's traces.",
  );
  await page.getByRole('tab', { name: 'Switching-stage test fixture', exact: true }).click();
  await openSimulation();
  assert.equal(await cursor.count(), 0, 'Switching back requires a new validated run.');
  await button('Source').click();
  const schematicName = await selectSchematicSource();
  const buckNative = projectNativeFiles(
    parseProject(await readFile('tests/fixtures/kicad/kicad-buck.openpe.json', 'utf8')),
    'buck.kicad_pro',
  );
  const buckSchematic = buckNative.files.find((file) => file.name === 'buck.kicad_sch');
  assert.ok(buckSchematic);
  await fillSource(page, buckSchematic.source);
  await button('Apply').click();
  assert.equal(
    await readSource(page),
    buckSchematic.source,
    `Apply commits ${schematicName} as native schematic text.`,
  );
  expectedSource = await primarySimulationSource();
  await button('Schematic').click();
  await openSimulation();
  await settings.getByLabel('Duration (ms)', { exact: true }).waitFor();
  async function probeBuckOutput() {
    const capacitor = parseProject(expectedSource).schematic.parts.find(
      (part) => part.ref === 'C101',
    );
    await clickCanvasTarget(
      page.locator('[data-probe-part="' + capacitor.id + '"][data-probe-pin="0"]'),
    );
    assert.equal(await properties.isVisible(), false);
  }

  for (const name of [
    'Input voltage (V)',
    'PWM frequency (kHz)',
    'Duty cycle (%)',
    'DC input',
    'Pulse source',
    'Output capacitor',
    'Switch',
    'Output inductor',
  ])
    assert.equal(
      await settings.getByLabel(name, { exact: true }).count(),
      0,
      name + ' is derived from the schematic.',
    );
  assert.equal(await settings.locator('input').count(), 2);
  await button('Run').click();
  await page.locator('.simulation-result-controls').waitFor({ state: 'attached' });
  assert.equal(await dock.count(), 0, 'New circuits require a fresh probe even after running.');
  await probeBuckOutput();
  await dock.getByRole('group', { name: 'Waveform controls' }).waitFor();
  assert.equal(
    await dock
      .getByText('No current trace for this object. Probe a connected pin or wire for voltage.', {
        exact: true,
      })
      .count(),
    0,
    'Stale probes cannot leak across project replacements.',
  );
  await page.screenshot({ path: 'test-results/simulation-bundled-buck.png' });
  await button('Source').click();
  await selectSchematicSource();
  const edited = editNativePart(
    editNativePart(await readSource(page), 'V102', { Value: '18' }),
    'V101',
    { 'Sim.Params': 'y1=0 y2=15 td=20n tr=20n tf=20n tw=20u per=100u' },
  );
  await fillSource(page, edited);
  await button('Apply').click();
  expectedSource = await primarySimulationSource();
  await button('Schematic').click();
  await openSimulation();
  assert.equal(await cursor.count(), 0, 'Circuit changes invalidate prior results.');
  constantValue = 0;
  const rerun = page.waitForRequest('**/api/simulation/transient');
  await openSimulation();
  await button('Run').click();
  const payload = (await rerun).postDataJSON();
  assert.equal(payload.config.voltage, 18);
  assert.equal(payload.config.frequency, 10000);
  assert.equal(payload.config.duty, 20);
  assert.equal(await dock.count(), 0);
  await probeBuckOutput();
  await dock.getByRole('group', { name: 'Waveform controls' }).waitFor();
  assert.match(
    await dock
      .getByRole('slider', { name: /cursor A$/ })
      .first()
      .getAttribute('aria-valuetext'),
    /, 0 V$/,
  );
  assert.doesNotMatch(
    await dock.locator('.simulation-trace').first().getAttribute('d'),
    /NaN|Infinity/,
    'Zero-valued traces retain valid scales.',
  );
  constantValue = -0.00042;
  await openSimulation();
  await button('Run').click();
  await dock
    .getByRole('slider', { name: /cursor A$/ })
    .first()
    .filter({ has: page.locator('.simulation-cursor-value') })
    .waitFor();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[role="slider"]')].some((el) =>
      el.getAttribute('aria-valuetext')?.endsWith(', -420 µV'),
    ),
  );
  assert.doesNotMatch(
    await dock.locator('.simulation-trace').first().getAttribute('d'),
    /NaN|Infinity/,
    'Constant negative signals use finite engineering scales.',
  );
  await button('Source').click();
  await selectSchematicSource();
  const unsupported = editNativePart(await readSource(page), 'Q1', {
    'Sim.Library': 'unavailable.mod',
  });
  await fillSource(page, unsupported);
  const unsupportedRecovered = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/state') &&
      response.request().method() === 'POST' &&
      response
        .request()
        .postDataJSON()
        .documents.some((document) => document.source.includes('unavailable.mod')),
  );
  await button('Apply').click();
  await button('Schematic').click();
  await openSimulation();
  await settings.getByRole('alert').waitFor();
  assert.match(await settings.getByRole('alert').innerText(), /unavailable.mod/);
  assert.equal(await button('Run').isDisabled(), true);
  await unsupportedRecovered;
  const beforePluginEdit = state.documents.map(({ source, sourceDraft, dirty }) => ({
    source,
    sourceDraft,
    dirty,
  }));
  await button('Plugins').click();
  await page.getByRole('button', { name: /^Marketplace / }).click();
  await page.getByRole('switch', { name: 'SPICE Simulation enabled' }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="SPICE Simulation enabled"]')
        ?.getAttribute('aria-checked') === 'false',
  );
  await button('Return to workspace').click();
  assert.equal(await button('SPICE Simulation').count(), 0);
  assert.equal(await settings.count(), 0);
  assert.equal(await dock.count(), 0);
  assert.deepEqual(
    state.documents.map(({ source, sourceDraft, dirty }) => ({ source, sourceDraft, dirty })),
    beforePluginEdit,
    'Plugin changes preserve complete design data and dirty state.',
  );
  await button('Plugins').click();
  await page.getByRole('switch', { name: 'SPICE Simulation enabled' }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('[aria-label="SPICE Simulation enabled"]')
        ?.getAttribute('aria-checked') === 'true',
  );
  await button('Return to workspace').click();
  await button('SPICE Simulation').waitFor();
  await openSimulation();
  await settings.waitFor();
  assert.deepEqual(errors, []);
  console.log(
    'Simulation renderer: docked settings/sidebar restoration, waveform pointer/keyboard resize, clamping, cancellation/reset, responsive themed plots, zero/negative scales, shared cursor, probing, setup-edit result retention, footer validation errors, settings persistence and Source invalidation passed.',
  );
} finally {
  await browser.close();
}
