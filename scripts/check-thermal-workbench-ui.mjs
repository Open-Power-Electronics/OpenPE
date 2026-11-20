import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { tsImport } from 'tsx/esm/api';
import { waitForAsync } from './async-browser-test-helpers.mjs';
import { toggleLayoutVisualization } from './visualization-test-helpers.mjs';
import { bundledWorkbenchCatalog } from '../server/workbench-plugins.mjs';

const { parseProject, projectNativeFiles, projectSchematics, projectFromNativeFiles } =
  await tsImport('../lib/project.ts', import.meta.url);
const { circuitFingerprint, pinPositions } = await tsImport('../lib/circuit.ts', import.meta.url);
const { schematicTexts } = await tsImport('../lib/schematic-text.ts', import.meta.url);
const { buildSpiceDeck, defaultTransient, spiceNets } = await tsImport(
  '../plugins/spice-simulation/domain/spice.ts',
  import.meta.url,
);
const { partFields, unitGraphics } = await tsImport('../lib/library.ts', import.meta.url);
const { child, children, val } = await tsImport('../lib/sexpr.ts', import.meta.url);
const { prepareThermalModel } = await tsImport(
  '../plugins/layout-thermal/domain/thermal.ts',
  import.meta.url,
);
const { defaultAgentPreferences } = await tsImport('../lib/workspace-state.ts', import.meta.url);
const { defaultAppearance, appearanceVariables } = await tsImport(
  '../lib/appearance.ts',
  import.meta.url,
);
const { validateAgentWorkspaceContext } = await tsImport(
  '../context/agent-workspace-context.ts',
  import.meta.url,
);
const sources = JSON.parse(await readFile('lib/reference-examples.json', 'utf8'));
const contactCheck = process.argv.includes('--parasitics-contact');
const exampleId = contactCheck
  ? 'reference-lm25017-wson8-flybuck'
  : Object.keys(sources).find((id) => /lm2596/i.test(id));
assert.ok(exampleId && sources[exampleId], 'The selected curated example is present.');
const source = sources[exampleId];
const project = parseProject(source);
const placementLibraryId = project.schematic.parts.find((part) => part.ref === 'V1').libId;
const placementDetail = {
  id: placementLibraryId,
  name: placementLibraryId.split(':').at(-1),
  library: placementLibraryId.split(':')[0],
  description: 'Native example symbol used by the isolated section placement check.',
  keywords: 'voltage source',
  symbol: project.schematic.libraries[placementLibraryId],
  units: 1,
};
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
async function runChecks() {
  const page = await browser.newPage({ viewport: { width: 1480, height: 920 } });
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const setTheme = async (mode) => {
    await page.evaluate(
      ({ mode, variables }) => {
        document.documentElement.dataset.theme = mode;
        for (const [name, value] of Object.entries(variables))
          document.documentElement.style.setProperty(name, value);
      },
      { mode, variables: appearanceVariables(defaultAppearance, mode) },
    );
    await page.evaluate(async () => {
      await new Promise(requestAnimationFrame);
      await Promise.all(
        document
          .getAnimations()
          .filter((animation) => Number.isFinite(animation.effect?.getComputedTiming().iterations))
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
  };
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
      listExamples: async () => ({ entries: [], warnings: [] }),
      listRecent: async () => ({ initialized: true, entries: [], warnings: [] }),
      onRecentChanged: () => () => {},
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
    if (url.pathname === '/api/appearance') return route.fulfill({ json: defaultAppearance });
    if (url.pathname === '/api/agents') return route.fulfill({ json: [] });
    if (url.pathname === '/api/models')
      return route.fulfill({ json: { models: [], defaultModel: '' } });
    if (process.argv.includes('--schematic-sections') && url.pathname === '/api/libraries/symbols') {
      if (url.searchParams.has('categories'))
        return route.fulfill({
          json: { categories: [{ id: placementDetail.library, name: placementDetail.library, children: [] }] },
        });
      if (url.searchParams.has('id')) return route.fulfill({ json: placementDetail });
      const result = {
        entries: [placementDetail],
        libraries: [placementDetail.library],
        total: 1,
        nextOffset: null,
      };
      if (route.request().headers().accept === 'application/x-ndjson')
        return route.fulfill({
          contentType: 'application/x-ndjson',
          body: JSON.stringify({ type: 'result', result }) + '\n',
        });
      return route.fulfill({ json: result });
    }
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
  await page.waitForFunction(() => Boolean(window.thermalWorkbenchHost()));
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
  if (process.argv.includes('--schematic-sections')) {
    const canvas = page.getByTestId('schematic-canvas');
    const section = page.locator('.schematic-section-switch');
    const sectionTrigger = section.getByRole('combobox', {
      name: 'Schematic section',
      exact: true,
    });
    const sectionLabels = { hardware: 'Real', simulation: 'Virtual', all: 'All' };
    const settledCamera = () =>
      canvas.evaluate(async (svg) => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        return svg.getAttribute('viewBox');
      });
    const waitForCameraChange = (viewBox) =>
      page.waitForFunction(
        (before) =>
          document.querySelector('[data-testid="schematic-canvas"]').getAttribute('viewBox') !==
          before,
        viewBox,
      );
    const fitSheet = async () => {
      // Start away from the fitted pose so the delayed Fit has an observable result.
      const before = await settledCamera();
      await canvas.hover();
      await page.mouse.wheel(0, -100);
      await waitForCameraChange(before);
      const zoomed = await settledCamera();
      await canvas.press('Space');
      await waitForCameraChange(zoomed);
      return settledCamera();
    };
    const sectionMenu = () => page.getByRole('listbox', { name: 'Schematic section', exact: true });
    const chooseSection = async (value) => {
      const viewport = await settledCamera();
      await sectionTrigger.click();
      await sectionMenu().getByRole('option', { name: sectionLabels[value], exact: true }).click();
      await assertSection(value);
      assert.equal(await settledCamera(), viewport, 'Changing emphasis retains the sheet camera.');
    };
    const readDesign = () =>
      page.evaluate(async () => {
        const host = window.thermalWorkbenchHost();
        return {
          source: await host.query('project.source'),
          history: await host.query('history.get'),
          workspace: await host.query('workbench.state'),
        };
      });
    const sourcePart = project.schematic.parts.find((part) => part.ref === 'V1');
    const membershipPart = project.schematic.parts.find((part) => part.ref === 'R1');
    const hardwarePart = project.schematic.parts.find((part) => part.ref === 'U1');
    assert.ok(sourcePart && membershipPart && hardwarePart);
    const sourcePins = pinPositions(sourcePart, project.schematic.libraries[sourcePart.libId]);
    const touches = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) < 0.00001;
    const sourceWires = project.schematic.wires.filter((wire) =>
      sourcePins.some((pin) => touches(pin, wire.a) || touches(pin, wire.b)),
    );
    assert.equal(sourceWires.length, 2, 'The fixture has two isolated source leads.');
    const sourceLabels = project.schematic.labels.filter((label) =>
      sourceWires.some((wire) => touches(label, wire.a) || touches(label, wire.b)),
    );
    assert.equal(sourceLabels.length, 2);
    const hardwarePins = pinPositions(
      hardwarePart,
      project.schematic.libraries[hardwarePart.libId],
    );
    const markerPins = project.schematic.parts
      .filter((part) => part.ref.startsWith('#'))
      .flatMap((part) => pinPositions(part, project.schematic.libraries[part.libId]));
    const mixedWire = project.schematic.wires.find(
      (wire) =>
        hardwarePins.some((pin) => touches(pin, wire.a) || touches(pin, wire.b)) &&
        markerPins.some((pin) => touches(pin, wire.a) || touches(pin, wire.b)),
    );
    assert.ok(
      mixedWire,
      'The fixture contains a Real component lead attached to a Virtual power marker.',
    );
    const assertSection = async (value) => {
      await waitForAsync(
        page,
        async (expected) =>
          (await window.thermalWorkbenchHost().query('workbench.state')).ui.schematicSection ===
          expected,
        value,
      );
      assert.equal(await sectionTrigger.textContent(), sectionLabels[value]);
    };
    const assertOpacity = async (id, expected) => {
      const target = canvas.locator(`[data-selection-id="${id}"]`).first();
      assert.equal(await target.count(), 1, 'Inactive geometry remains drawn.');
      const opacity = await target.evaluate((element) => {
        let opacity = 1;
        for (
          let node = element;
          node && node.tagName.toLowerCase() !== 'svg';
          node = node.parentElement
        )
          opacity *= Number(getComputedStyle(node).opacity);
        return opacity;
      });
      assert.ok(
        Math.abs(opacity - expected) < 0.001,
        `${id} should have ${expected} opacity, got ${opacity}.`,
      );
    };
    await section.waitFor();
    await page.locator('.toast').waitFor({ state: 'hidden' });
    await sectionTrigger.click();
    assert.deepEqual(await sectionMenu().getByRole('option').allTextContents(), [
      'All',
      'Real',
      'Virtual',
    ]);
    const sectionFieldBounds = await sectionTrigger.boundingBox();
    const sectionPopupBounds = await sectionMenu().boundingBox();
    assert.ok(sectionFieldBounds.width < 100, 'The current-mode trigger stays compact.');
    assert.ok(
      sectionPopupBounds.width >= 127 && sectionPopupBounds.width > sectionFieldBounds.width,
      'The status menu has enough independent width for complete mode names.',
    );
    assert.ok(sectionPopupBounds.y + sectionPopupBounds.height <= sectionFieldBounds.y);
    for (const option of await sectionMenu().getByRole('option').all())
      assert.equal(
        await option.locator('strong').evaluate((label) => {
          const range = document.createRange();
          range.selectNodeContents(label);
          return range.getClientRects().length;
        }),
        1,
        'Each section label stays on one readable line inside the content-sized popup.',
      );
    await page.screenshot({ path: 'test-results/schematic-sections-control-ui.png' });
    await setTheme('dark');
    const darkControl = await sectionTrigger.evaluate((button) => {
      const style = getComputedStyle(button);
      const root = getComputedStyle(document.documentElement);
      const pixel = document.createElement('canvas').getContext('2d');
      const luminance = (color) => {
        pixel.fillStyle = color;
        pixel.fillRect(0, 0, 1, 1);
        return [...pixel.getImageData(0, 0, 1, 1).data]
          .slice(0, 3)
          .map((channel) => channel / 255)
          .map((channel) =>
            channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
          )
          .reduce((total, channel, index) => total + channel * [0.2126, 0.7152, 0.0722][index], 0);
      };
      const foreground = luminance(style.color);
      const background = luminance(style.backgroundColor);
      return {
        color: style.color,
        background: style.backgroundColor,
        surface: root.getPropertyValue('--surface'),
        statusFill: style.getPropertyValue('--status-item-fill'),
        gridBackground: getComputedStyle(
          button.closest('footer').querySelector('.grid-density .select-trigger'),
        ).backgroundColor,
        colorScheme: root.colorScheme,
        contrast:
          (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
      };
    });
    assert.ok(
      darkControl.contrast >= 4.5,
      `The settled dark section trigger is readable: ${JSON.stringify(darkControl)}`,
    );
    console.log('Schematic dark control:', JSON.stringify(darkControl));
    await page.screenshot({ path: 'test-results/schematic-sections-control-dark-ui.png' });
    await setTheme('light');
    await sectionTrigger.press('Escape');
    await assertSection('all');
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const fullFit = await fitSheet();
    const assertFullFit = async () => {
      const expected = fullFit.split(' ').map(Number);
      const current = (await fitSheet()).split(' ').map(Number);
      assert.ok(
        current.every((value, index) => Math.abs(value - expected[index]) < 0.5),
        'Fit retains complete-sheet bounds, allowing the existing measured-text rounding.',
      );
      const bounds = await canvas.evaluate((svg) => {
        const surface = svg.getBoundingClientRect();
        return [...svg.querySelectorAll('.part')].map((part) => {
          const box = part.getBoundingClientRect();
          return (
            box.left >= surface.left &&
            box.right <= surface.right &&
            box.top >= surface.top &&
            box.bottom <= surface.bottom
          );
        });
      });
      assert.equal(bounds.length, project.schematic.parts.length);
      assert.ok(
        bounds.every(Boolean),
        'Fit keeps every component inside the complete-sheet canvas.',
      );
    };
    await chooseSection('hardware');
    await assertSection('hardware');
    await assertFullFit();
    await assertOpacity(sourcePart.id, 0.25);
    await assertOpacity(hardwarePart.id, 1);
    assert.notEqual(val(child(sourcePart.raw, 'on_board')), 'no');
    const before = await readDesign();
    const beforeProject = parseProject(before.source);
    const nativeBefore = projectNativeFiles(beforeProject, 'project.kicad_pro');
    const at = await canvas.evaluate((svg, part) => {
      const point = new DOMPoint(part.x, part.y).matrixTransform(svg.getScreenCTM());
      return { x: point.x, y: point.y };
    }, membershipPart);
    await page.mouse.click(at.x, at.y);
    const membership = page.locator('.part-properties').getByRole('combobox', {
      name: 'Schematic section',
      exact: true,
    });
    await page.getByRole('textbox', { name: 'Component reference', exact: true }).waitFor();
    assert.equal(await membership.count(), 0, 'Real components have no section field in Properties.');
    await page.evaluate(
      (args) => window.thermalWorkbenchHost().execute('part.section', args),
      { schematicId: project.schematic.id, partId: membershipPart.id, section: 'simulation' },
    );
    await waitForAsync(
      page,
      async (expectedUndoDepth) =>
        (await window.thermalWorkbenchHost().query('history.get')).undoDepth === expectedUndoDepth,
      before.history.undoDepth + 1,
    );
    const assigned = await readDesign();
    const assignedProject = parseProject(assigned.source);
    const assignedSource = assignedProject.schematic.parts.find(
      (part) => part.id === membershipPart.id,
    );
    assert.equal(val(child(assignedSource.raw, 'on_board')), 'no');
    assert.equal(assignedSource.excludeFromSimulation, membershipPart.excludeFromSimulation);
    assert.deepEqual(partFields(assignedSource), partFields(membershipPart));
    assert.equal(assigned.history.undoDepth, before.history.undoDepth + 1);
    const nativeAssigned = projectNativeFiles(assignedProject, 'project.kicad_pro');
    const reopened = projectFromNativeFiles(nativeAssigned);
    assert.equal(
      val(
        child(
          reopened.schematic.parts.find((part) => part.id === membershipPart.id).raw,
          'on_board',
        ),
      ),
      'no',
    );
    assert.ok(beforeProject.pcb.footprints.some((part) => part.symbolId === membershipPart.id));
    assert.deepEqual(
      assignedProject.pcb.footprints,
      beforeProject.pcb.footprints.filter((part) => part.symbolId !== membershipPart.id),
      'Moving a packaged part to Virtual removes only its linked package.',
    );
    for (const key of ['tracks', 'vias', 'graphics'])
      assert.deepEqual(
        assignedProject.pcb[key],
        beforeProject.pcb[key],
        `PCB ${key} are retained.`,
      );
    const zoneIdentity = ({ id, layer, outline, holes, netId, fillEnabled }) => ({
      id,
      layer,
      outline,
      holes,
      netId,
      fillEnabled,
    });
    assert.deepEqual(
      assignedProject.pcb.zones.map(zoneIdentity),
      beforeProject.pcb.zones.map(zoneIdentity),
      'Package removal retains zone identities and outlines while refreshing enabled fills.',
    );
    await assertSection('hardware');
    await assertOpacity(sourcePart.id, 0.25);
    await assertOpacity(membershipPart.id, 0.25);
    await assertOpacity(hardwarePart.id, 1);
    for (const item of [...sourceWires, ...sourceLabels]) await assertOpacity(item.id, 0.25);
    await assertOpacity(mixedWire.id, 0.25);
    const mixedPosition = await canvas.evaluate((svg, wire) => {
      const point = new DOMPoint(
        (wire.a.x + wire.b.x) / 2,
        (wire.a.y + wire.b.y) / 2,
      ).matrixTransform(svg.getScreenCTM());
      return { x: point.x, y: point.y };
    }, mixedWire);
    await page.mouse.click(mixedPosition.x, mixedPosition.y);
    assert.ok(
      (await readDesign()).workspace.ui.selection.includes(mixedWire.id),
      'A dimmed wire shared by Real and Virtual remains selectable.',
    );
    await page.screenshot({ path: 'test-results/schematic-sections-hardware-ui.png' });
    const viewBaseline = await readDesign();
    await chooseSection('simulation');
    await assertSection('simulation');
    await assertOpacity(sourcePart.id, 1);
    await assertOpacity(membershipPart.id, 1);
    await assertOpacity(hardwarePart.id, 0.25);
    for (const item of [...sourceWires, ...sourceLabels]) await assertOpacity(item.id, 1);
    await assertOpacity(mixedWire.id, 0.25);
    await assertFullFit();
    const inactivePosition = await canvas.evaluate((svg, part) => {
      const point = new DOMPoint(part.x, part.y).matrixTransform(svg.getScreenCTM());
      return { x: point.x, y: point.y };
    }, hardwarePart);
    await page.mouse.click(inactivePosition.x, inactivePosition.y);
    assert.ok(
      !(await readDesign()).workspace.ui.selection.includes(hardwarePart.id),
      'Dimmed inactive symbols do not accept pointer selection.',
    );
    await canvas.focus();
    await canvas.press('ControlOrMeta+a');
    const selected = (await readDesign()).workspace.ui.selection;
    assert.ok(selected.includes(sourcePart.id));
    assert.ok(
      !selected.includes(hardwarePart.id) && !selected.some((id) => id.includes(hardwarePart.id)),
      'Select all cannot select an inactive object or field dimmed by the active section.',
    );
    const rejected = await page.evaluate(async (id) => {
      try {
        await window.thermalWorkbenchHost().execute('workbench.selection', { ids: [id] });
        return '';
      } catch (error) {
        return error.message;
      }
    }, hardwarePart.id);
    assert.match(rejected, /visible/);
    await canvas.press('Escape');
    const imePrevented = await sectionTrigger.evaluate((button) => {
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        keyCode: 229,
        bubbles: true,
        cancelable: true,
      });
      button.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(imePrevented, true);
    await assertSection('simulation');
    await sectionTrigger.dispatchEvent('compositionstart');
    await sectionTrigger.click();
    await assertSection('simulation');
    assert.equal(await sectionMenu().count(), 0);
    await sectionTrigger.dispatchEvent('compositionend');
    await sectionTrigger.focus();
    await sectionTrigger.press('Enter');
    await sectionMenu().getByRole('option', { name: 'All', exact: true }).click();
    await assertSection('all');
    await assertOpacity(sourcePart.id, 1);
    await assertOpacity(membershipPart.id, 1);
    await assertOpacity(hardwarePart.id, 1);
    await assertOpacity(mixedWire.id, 1);
    assert.equal(await canvas.locator('.part').count(), project.schematic.parts.length);
    const viewed = await readDesign();
    assert.equal(viewed.source, viewBaseline.source);
    assert.deepEqual(viewed.history, viewBaseline.history);
    assert.equal(viewed.workspace.ui.revision, viewBaseline.workspace.ui.revision);
    assert.equal(viewed.workspace.ui.dirty, viewBaseline.workspace.ui.dirty);
    await page.screenshot({ path: 'test-results/schematic-sections-all-ui.png' });
    const sourceMarker = project.schematic.parts.find(
      (part) =>
        part.value === 'GND' &&
        pinPositions(part, project.schematic.libraries[part.libId]).some((pin) =>
          sourceWires.some((wire) => touches(pin, wire.a) || touches(pin, wire.b)),
        ),
    );
    assert.ok(sourceMarker);
    await page.evaluate(
      (id) => window.thermalWorkbenchHost().execute('workbench.selection', { ids: [id] }),
      sourceMarker.id,
    );
    await page.locator('.part-properties').waitFor();
    await waitForAsync(
      page,
      (reference) =>
        document.querySelector('.part-properties input[aria-label="Component reference"]')
          ?.value === reference,
      sourceMarker.ref,
    );
    assert.equal(
      await page
        .locator('.part-properties')
        .getByRole('combobox', { name: 'Schematic section', exact: true })
        .count(),
      0,
      'A power marker without a Footprint remains Virtual without a misleading membership field.',
    );
    await page.evaluate(
      (id) => window.thermalWorkbenchHost().execute('workbench.selection', { ids: [id] }),
      sourcePart.id,
    );
    await waitForAsync(
      page,
      (reference) =>
        document.querySelector('.part-properties input[aria-label="Component reference"]')
          ?.value === reference,
      sourcePart.ref,
    );
    assert.equal(await membership.count(), 0, 'Virtual components have no section field in Properties.');
    const xPosition = page.getByRole('spinbutton', { name: 'Component X position', exact: true });
    await xPosition.fill('100001');
    await sectionTrigger.click();
    await assertSection('all');
    assert.equal(await sectionMenu().count(), 0);
    assert.equal(await xPosition.inputValue(), '100001');
    assert.equal((await readDesign()).source, viewBaseline.source);
    await page.getByRole('button', { name: 'Dismiss notification', exact: true }).click();
    await xPosition.press('Escape');
    await chooseSection('simulation');
    await assertSection('simulation');
    await chooseSection('all');
    await assertSection('all');
    await canvas.focus();
    await canvas.press('w');
    const drawingBounds = await canvas.boundingBox();
    await page.mouse.click(
      drawingBounds.x + drawingBounds.width * 0.48,
      drawingBounds.y + drawingBounds.height * 0.88,
    );
    await canvas.getByTestId('schematic-wire-preview').waitFor({ state: 'attached' });
    await chooseSection('simulation');
    await assertSection('simulation');
    await canvas.getByTestId('schematic-wire-preview').waitFor({ state: 'detached' });
    assert.equal(
      (await readDesign()).source,
      viewBaseline.source,
      'A section switch cancels a provisional wire without accepting geometry.',
    );
    await page.setViewportSize({ width: 1120, height: 780 });
    const position = await section.evaluate((element) => {
      const b = element.getBoundingClientRect();
      const controls = element.parentElement.getBoundingClientRect();
      const footer = element.closest('footer').getBoundingClientRect();
      return {
        right: footer.right - controls.right,
        bottom: footer.bottom - controls.bottom,
        inBounds:
          b.left >= footer.left &&
          b.right <= footer.right &&
          b.top >= footer.top &&
          b.bottom <= footer.bottom,
      };
    });
    assert.ok(
      position.inBounds && position.right <= 12 && position.bottom <= 10,
      'The section switch remains in the drawing footer bottom-right at a compact viewport.',
    );
    await page.setViewportSize({ width: 1480, height: 920 });
    await page.screenshot({ path: 'test-results/schematic-sections-simulation-ui.png' });
    await setTheme('dark');
    await page.screenshot({ path: 'test-results/schematic-sections-simulation-dark-ui.png' });
    await setTheme('light');
    await page.evaluate(() =>
      window.thermalWorkbenchHost().execute('source.update', { draft: 'Pending section fixture' }),
    );
    assert.equal(await sectionTrigger.isDisabled(), true);
    await page.evaluate(() => window.thermalWorkbenchHost().execute('source.discard'));
    await page.evaluate(() => window.thermalWorkbenchHost().execute('history.undo'));
    await waitForAsync(
      page,
      async (expected) =>
        (await window.thermalWorkbenchHost().query('project.source')) === expected,
      before.source,
    );
    await chooseSection('hardware');
    await assertSection('hardware');
    await assertOpacity(sourcePart.id, 0.25);
    await assertOpacity(membershipPart.id, 1);
    const restored = await readDesign();
    assert.equal(restored.history.undoDepth, before.history.undoDepth);
    const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    assert.equal(
      digest(projectNativeFiles(parseProject(restored.source), 'project.kicad_pro')),
      digest(nativeBefore),
      'Undo restores the complete native file set byte for byte.',
    );
    for (const originSection of ['hardware', 'all', 'simulation']) {
      await chooseSection(originSection);
      await assertSection(originSection);
      const placementBaseline = await readDesign();
      const viewport = await canvas.getAttribute('viewBox');
      await page.getByRole('button', { name: 'Add component', exact: true }).click();
      const chooser = page.getByRole('dialog', { name: 'Components', exact: true });
      await chooser.locator('.library-results button[data-index="0"]').waitFor();
      await waitForAsync(page, () => {
        const place = document.querySelector('dialog[open] button[aria-label="Place"]');
        return place && !place.disabled;
      });
      await chooser.getByRole('button', { name: 'Place', exact: true }).click();
      await chooser.waitFor({ state: 'detached' });
      const placementBounds = await canvas.boundingBox();
      await page.mouse.click(
        placementBounds.x + placementBounds.width * 0.55,
        placementBounds.y + placementBounds.height * 0.7,
      );
      await waitForAsync(
        page,
        async (depth) =>
          (await window.thermalWorkbenchHost().query('history.get')).undoDepth === depth,
        placementBaseline.history.undoDepth + 1,
      );
      const placed = await readDesign();
      const placedProject = parseProject(placed.source);
      const added = placedProject.schematic.parts.find(
        (part) => !beforeProject.schematic.parts.some((previous) => previous.id === part.id),
      );
      assert.ok(added);
      assert.equal(partFields(added).Footprint || '', '');
      const boardFlag = val(child(added.raw, 'on_board'));
      if (originSection === 'simulation') assert.equal(boardFlag, 'no');
      else assert.notEqual(boardFlag, 'no', 'Real intent retains native board inclusion/default.');
      await assertSection(originSection === 'all' ? 'all' : 'simulation');
      assert.ok(placed.workspace.ui.selection.includes(added.id));
      assert.equal(await canvas.getByTestId(`part-${added.ref}`).isVisible(), true);
      assert.equal(await canvas.getAttribute('viewBox'), viewport, 'Placement retains the camera.');
      assert.equal(
        digest(placedProject.pcb),
        digest(beforeProject.pcb),
        'No-Footprint placement preserves PCB data.',
      );
      await canvas.press('Escape');
      await page.evaluate(() => window.thermalWorkbenchHost().execute('history.undo'));
      await waitForAsync(
        page,
        async (expected) =>
          (await window.thermalWorkbenchHost().query('project.source')) === expected,
        placementBaseline.source,
      );
    }
    const layoutBaseline = await readDesign();
    await page.getByRole('button', { name: 'Layout', exact: true }).click();
    const nonactive = page.getByRole('combobox', { name: 'Non-active layers', exact: true });
    await nonactive.click();
    const layerMenu = page.getByRole('listbox', { name: 'Non-active layers', exact: true });
    assert.deepEqual(await layerMenu.getByRole('option').allTextContents(), ['All', 'Dim', 'Solo']);
    const layerFieldBounds = await nonactive.boundingBox();
    const layerPopupBounds = await layerMenu.boundingBox();
    assert.ok(
      layerPopupBounds.width >= 127 && layerPopupBounds.width > layerFieldBounds.width,
      'Layout status modes use a readable content-sized popup.',
    );
    for (const option of await layerMenu.getByRole('option').all())
      assert.equal(
        await option.locator('strong').evaluate((label) => {
          const range = document.createRange();
          range.selectNodeContents(label);
          return range.getClientRects().length;
        }),
        1,
        'Every Layout status mode name stays complete on one line.',
      );
    await page.screenshot({ path: 'test-results/schematic-sections-layout-menu-ui.png' });
    await setTheme('dark');
    await page.screenshot({ path: 'test-results/schematic-sections-layout-menu-dark-ui.png' });
    await setTheme('light');
    await layerMenu.getByRole('option', { name: 'Dim', exact: true }).click();
    const layoutViewed = await readDesign();
    assert.equal(layoutViewed.source, layoutBaseline.source);
    assert.deepEqual(layoutViewed.history, layoutBaseline.history);
    assert.equal(layoutViewed.workspace.ui.revision, layoutBaseline.workspace.ui.revision);
    assert.equal(layoutViewed.workspace.ui.dirty, layoutBaseline.workspace.ui.dirty);
    assert.equal(statusRequests, 0);
    assert.equal(runRequests, 0);
    assert.deepEqual(errors, []);
    console.log(
      'Schematic sections passed: All default, Real/Virtual Footprint membership and dimming, shared Fit/camera, native section/package edit and exact undo, new placements, local wire/label isolation, inactive selection gates, IME/draft cancellation, readable compact Schematic/Layout menus, responsive themes and retained PCB copper. No Electron, provider or solver was run.',
    );
    return;
  }
  await page.getByRole('button', { name: 'Layout', exact: true }).click();
  const nativeSidebar = page.getByRole('complementary', { name: 'Layout sidebar', exact: true });
  const sidebarResize = nativeSidebar.locator('..').getByRole('button', {
    name: 'Resize layout sidebar width',
    exact: true,
  });
  const drawing = page.locator('.layout-main .layout-canvas');
  const nativeWidth = (await nativeSidebar.boundingBox()).width;
  assert.ok(Math.abs(nativeWidth - 280) <= 1, 'The native Layout sidebar starts at 280 px.');
  const nativeDrawingWidth = (await drawing.boundingBox()).width;
  if (
    contactCheck ||
    process.argv.includes('--parasitics-dock') ||
    process.argv.includes('--parasitics-study')
  ) {
    const readDesign = () =>
      page.evaluate(async () => {
        const host = window.thermalWorkbenchHost();
        return {
          source: await host.query('project.source'),
          history: await host.query('history.get'),
        };
      });
    const originalDesign = await readDesign();
    const parasiticsButton = page.getByRole('button', { name: 'Layout Parasitics', exact: true });
    const parasitics = page.getByRole('region', { name: 'Layout Parasitics', exact: true });
    const thermal = page.getByRole('region', { name: 'Layout Thermal', exact: true });
    await parasiticsButton.click();
    await parasitics.waitFor();
    await nativeSidebar.waitFor({ state: 'hidden' });
    assert.equal(
      await parasitics.evaluate((panel) =>
        Boolean(panel.closest('.layout-analysis-dock') && !panel.closest('dialog')),
      ),
      true,
      'Layout Parasitics opens inside the shared nonmodal right dock.',
    );
    assert.ok(Math.abs((await parasitics.boundingBox()).width - nativeWidth) <= 1);
    assert.ok(Math.abs((await drawing.boundingBox()).width - nativeDrawingWidth) <= 1);
    const copperInput = await parasitics
      .getByRole('textbox', { name: 'Copper thickness', exact: true })
      .boundingBox();
    const platingInput = await parasitics
      .getByRole('textbox', { name: 'Via plating thickness', exact: true })
      .boundingBox();
    assert.ok(copperInput.x + copperInput.width <= platingInput.x);
    assert.ok(Math.abs(copperInput.y - platingInput.y) <= 1);
    const layout = page.getByTestId('layout-canvas');
    assert.equal(await layout.evaluate((svg) => getComputedStyle(svg).cursor), 'default');
    const initialView = await layout.getAttribute('viewBox');
    const canvas = await layout.boundingBox();
    await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
    await page.mouse.wheel(0, -150);
    await page.waitForFunction(
      (before) =>
        document.querySelector('[data-testid="layout-canvas"]').getAttribute('viewBox') !== before,
      initialView,
    );
    await parasitics.waitFor();

    await layout.press('Home');
    for (const name of ['Net', 'Start terminal', 'End terminal'])
      assert.equal(await parasitics.getByRole('combobox', { name, exact: true }).count(), 0);
    const pads = project.pcb.footprints.flatMap((footprint) => footprint.pads);
    const net = project.pcb.nets.find(
      ({ name }) => name === (contactCheck ? '/VOUT1' : 'Net-(D1-K)'),
    );
    assert.ok(net);
    const terminalPad = (reference, number) => {
      const component = project.schematic.parts.find((part) => part.ref === reference);
      const footprint = project.pcb.footprints.find((item) => item.symbolId === component?.id);
      const pad = footprint?.pads.find((pad) => pad.number === number);
      assert.ok(pad, `The fixture contains ${reference} pad ${number}.`);
      assert.equal(pad.netId, net.id);
      return pad;
    };
    const [start, end] = contactCheck
      ? [terminalPad('D1', '2'), terminalPad('C8', '1')]
      : pads.filter((pad) => pad.netId === net.id);
    const padLabel = (pad) => {
      const owner = project.pcb.footprints.find(({ pads }) => pads.includes(pad));
      const reference = project.schematic.parts.find(({ id }) => id === owner.symbolId)?.ref;
      return `${reference ?? owner.reference ?? owner.libraryId} · Pad ${pad.number || '—'}`;
    };
    const terminals = parasitics.locator('.layout-parasitics-terminals');
    const [via] = project.pcb.vias;
    const viaPad = pads.find((pad) => pad.netId === via.netId);
    async function clickTerminal(selector) {
      const { x, y } = await layout.locator(selector).evaluate((terminal) => {
        const target = terminal.querySelector('[data-layout-via-target]');
        const point = new DOMPoint(target?.cx.baseVal.value ?? 0, target?.cy.baseVal.value ?? 0);
        const screen = point.matrixTransform(terminal.getScreenCTM());
        return { x: screen.x, y: screen.y };
      });
      await page.mouse.click(x, y);
    }
    const clickPad = (pad) => clickTerminal(`[data-pad-id="${pad.id}"]`);
    const clickVia = () => clickTerminal(`[data-via-type][data-selection-id="${via.id}"]`);
    const first = layout.locator('[data-parasitics-terminal="1"]');
    const second = layout.locator('[data-parasitics-terminal="2"]');
    const measure = parasitics.getByRole('button', { name: 'Measure', exact: true });
    assert.equal(
      await measure.count(),
      0,
      'Two valid terminal picks measure automatically without a button.',
    );
    assert.equal(await parasitics.locator('footer').getByRole('status').count(), 0);
    const results = parasitics.locator('.layout-parasitics-results');
    const measuredResistance = results.getByText(/^\d+\.\d{3} mΩ$/);
    assert.deepEqual(await parasitics.getByRole('heading', { level: 3 }).allTextContents(), [
      'Geometry',
      'Terminals',
      'Results',
    ]);
    assert.deepEqual(await terminals.locator('dd').allTextContents(), ['—', '—', '—']);
    assert.deepEqual(await results.locator('dd').allTextContents(), ['—', '—', '—']);
    const thickness = parasitics.getByRole('textbox', { name: 'Copper thickness', exact: true });
    if (contactCheck) {
      assert.equal(start.id, '07849834-bb34-42e2-80ef-179e1baaa6fc');
      assert.equal(end.id, '3ee753a3-1ca6-42ee-95dd-df02a6a91f4d');
      const create = parasitics.getByRole('button', {
        name: 'Add parasitic components',
        exact: true,
      });
      assert.equal(await create.isDisabled(), true);
      await layout.focus();
      await layout.press('Space');
      await layout.evaluate(async () => {
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
      });
      await clickPad(start);
      await first.waitFor();
      await clickPad(end);
      await second.waitFor();
      await measuredResistance.waitFor();
      assert.deepEqual(await terminals.locator('dd').allTextContents(), [
        padLabel(start),
        padLabel(end),
        '/VOUT1',
      ]);
      for (const pad of [start, end])
        await layout.locator(`[data-pad-id="${pad.id}"] [data-selection-only]`).waitFor();
      assert.equal(await parasitics.getByRole('alert').count(), 0);
      assert.equal(
        await create.isEnabled(),
        true,
        'A valid finite endpoint measurement enables schematic addition.',
      );
      const measureContact = (copperThicknessMm, viaPlatingMm = 0.025) =>
        page.evaluate((input) => window.thermalWorkbenchHost().query('parasitics.measure', input), {
          boardId: project.pcb.id,
          startId: start.id,
          endId: end.id,
          copperThicknessMm,
          viaPlatingMm,
        });
      const firstMeasurement = await measureContact(0.035);
      assert.equal(firstMeasurement.netId, net.id);
      assert.equal(firstMeasurement.netName, '/VOUT1');
      for (const key of [
        'shortestLengthMm',
        'shortestResistanceOhm',
        'equivalentResistanceOhm',
        'shortestPartialInductanceNh',
      ])
        assert.ok(
          Number.isFinite(firstMeasurement[key]) && firstMeasurement[key] > 0,
          `${key} is finite and positive.`,
        );
      const shownResistance = () => results.locator('dd').nth(1);
      const numberFormat = new Intl.NumberFormat('en', {
        minimumFractionDigits: 3,
        maximumFractionDigits: 3,
      });
      assert.equal(
        await shownResistance().textContent(),
        `${numberFormat.format(firstMeasurement.equivalentResistanceOhm * 1000)} mΩ`,
      );
      const firstDisplayed = await shownResistance().textContent();
      await thickness.fill('0.07');
      await waitForAsync(
        page,
        (previous) => {
          const value = document.querySelector(
            '.layout-parasitics-results div:nth-child(2) dd',
          )?.textContent;
          return value && value !== '—' && value !== previous;
        },
        firstDisplayed,
      );
      const thicker = await measureContact(0.07);
      assert.ok(
        thicker.equivalentResistanceOhm > 0 &&
          thicker.equivalentResistanceOhm < firstMeasurement.equivalentResistanceOhm,
      );
      assert.equal(thicker.shortestLengthMm, firstMeasurement.shortestLengthMm);
      assert.equal(
        await shownResistance().textContent(),
        `${numberFormat.format(thicker.equivalentResistanceOhm * 1000)} mΩ`,
      );
      assert.equal(await create.isEnabled(), true);
      await thickness.fill('0.035');
      await waitForAsync(
        page,
        (expected) =>
          document.querySelector('.layout-parasitics-results div:nth-child(2) dd')?.textContent ===
          expected,
        firstDisplayed,
      );
      const after = await readDesign();
      const digest = (value) => createHash('sha256').update(value).digest('hex');
      assert.equal(
        digest(after.source),
        digest(originalDesign.source),
        'Measurement never changes project Source.',
      );
      assert.deepEqual(after.history, originalDesign.history);
      const beforeFiles = projectNativeFiles(
        parseProject(originalDesign.source),
        'project.kicad_pro',
      );
      const afterFiles = projectNativeFiles(parseProject(after.source), 'project.kicad_pro');
      assert.equal(
        digest(JSON.stringify(afterFiles)),
        digest(JSON.stringify(beforeFiles)),
        'Measurement and geometry settings preserve every native byte, including the PCB.',
      );
      await page.screenshot({ path: 'test-results/layout-parasitics-contact-ui.png' });
      assert.equal(statusRequests, 0);
      assert.equal(runRequests, 0);
      assert.deepEqual(errors, []);
      console.log(
        `Layout Parasitics contacts passed: actual LM25017 D1.2→C8.1 /VOUT1 picks, R=${firstMeasurement.equivalentResistanceOhm}Ω, L=${firstMeasurement.shortestPartialInductanceNh}nH, thickness reactivity, correct selected IDs, Add availability and unchanged complete native files. No Electron, provider or solver was run.`,
      );
      return;
    }
    await thickness.focus();
    await thickness.dispatchEvent('compositionstart');
    await clickPad(start);
    assert.equal(await first.count(), 0, 'A canvas click cannot pick during IME composition.');
    await thickness.dispatchEvent('compositionend');
    await clickPad(start);
    await first.waitFor();
    assert.deepEqual(await terminals.locator('dd').allTextContents(), [
      padLabel(start),
      '—',
      net.name,
    ]);
    assert.deepEqual(
      await terminals.locator('.layout-parasitics-badge[data-picked="true"]').allTextContents(),
      ['1'],
    );
    const startHighlight = layout.locator(`[data-pad-id="${start.id}"] [data-selection-only]`);
    await startHighlight.waitFor();
    await clickPad(start);
    await clickVia();
    assert.equal(await second.count(), 0, 'Duplicate and different-net picks are ignored.');
    await clickPad(end);
    await second.waitFor();
    assert.deepEqual(await terminals.locator('dd').allTextContents(), [
      padLabel(start),
      padLabel(end),
      net.name,
    ]);
    assert.deepEqual(
      await terminals.locator('.layout-parasitics-badge[data-picked="true"]').allTextContents(),
      ['1', '2'],
    );
    await layout.locator(`[data-pad-id="${end.id}"] [data-selection-only]`).waitFor();
    await measuredResistance.waitFor();
    const clearTerminals = parasitics.getByRole('button', {
      name: 'Clear selected terminals',
      exact: true,
    });
    assert.equal(
      await clearTerminals.evaluate((button) => {
        const key = new KeyboardEvent('keydown', {
          key: 'Enter',
          keyCode: 229,
          bubbles: true,
          cancelable: true,
        });
        button.dispatchEvent(key);
        return key.defaultPrevented;
      }),
      true,
      'IME Enter cannot clear selected terminals inside the dock.',
    );
    assert.deepEqual(await results.locator('dt').allTextContents(), [
      'Distance',
      'Resistance',
      'Partial inductance',
    ]);
    const rowTops = await results
      .locator('dt')
      .evaluateAll((labels) => labels.map((label) => label.getBoundingClientRect().top));
    assert.ok(rowTops[0] < rowTops[1] && rowTops[1] < rowTops[2]);
    assert.match(await results.locator('dd').nth(2).textContent(), /^\d+\.\d{3} nH$/);
    if (process.argv.includes('--parasitics-study')) {
      const beforeStudy = await readDesign();
      const beforeProject = parseProject(beforeStudy.source);
      const beforeNative = projectNativeFiles(beforeProject, 'project.kicad_pro');
      const beforeWorkspace = await page.evaluate(() =>
        window.thermalWorkbenchHost().query('workbench.state'),
      );
      const targetId = beforeWorkspace.ui.activeSchematicId;
      const originalSheet = projectSchematics(beforeProject).find((sheet) => sheet.id === targetId);
      assert.ok(originalSheet, 'The target is an existing selected schematic.');
      const sheetTabs = page.locator('.schematic-file-tabs [role="tab"]');
      const originalTabCount = await sheetTabs.count();
      const measurement = await page.evaluate(
        ({ boardId, startId, endId }) =>
          window.thermalWorkbenchHost().query('parasitics.measure', {
            boardId,
            startId,
            endId,
            copperThicknessMm: 0.035,
            viaPlatingMm: 0.025,
          }),
        { boardId: project.pcb.id, startId: start.id, endId: end.id },
      );
      const create = parasitics.getByRole('button', {
        name: 'Add parasitic components',
        exact: true,
      });
      assert.equal(await create.isEnabled(), true);
      await create.click();
      const schematic = page.getByTestId('schematic-canvas');
      await schematic.waitFor();
      await parasitics.waitFor({ state: 'hidden' });
      const created = await page.evaluate(async () => {
        const host = window.thermalWorkbenchHost();
        return {
          source: await host.query('project.source'),
          history: await host.query('history.get'),
          workspace: await host.query('workbench.state'),
        };
      });
      const createdProject = parseProject(created.source);
      assert.deepEqual(
        projectSchematics(createdProject).map((sheet) => ({ id: sheet.id, title: sheet.title })),
        projectSchematics(beforeProject).map((sheet) => ({ id: sheet.id, title: sheet.title })),
        'Addition retains every existing schematic identity and title without creating a sheet.',
      );
      const study = projectSchematics(createdProject).find((sheet) => sheet.id === targetId);
      assert.equal(await sheetTabs.count(), originalTabCount, 'No schematic tab is added.');
      assert.equal(
        await page
          .locator('.schematic-file-tabs [role="tab"][aria-selected="true"]')
          .getAttribute('aria-description'),
        originalSheet.title,
      );
      assert.equal(created.workspace.ui.view, 'canvas');
      assert.equal(
        created.workspace.ui.schematicSection,
        'simulation',
        'Adding parasitic components reveals their native Simulation section.',
      );
      assert.equal(created.workspace.ui.activeSchematicId, targetId);
      assert.equal(created.history.undoDepth, beforeStudy.history.undoDepth + 1);
      for (const kind of ['parts', 'junctions', 'labels', 'noConnects'])
        for (const original of originalSheet[kind] ?? [])
          assert.deepEqual(
            study[kind]?.find((item) => item.id === original.id),
            original,
            `Existing ${kind} objects and IDs are preserved.`,
          );
      const originalPartIds = new Set(originalSheet.parts.map((part) => part.id));
      const addedParts = study.parts.filter((part) => !originalPartIds.has(part.id));
      const originalLabelIds = new Set(originalSheet.labels.map((label) => label.id));
      const addedLabels = study.labels.filter((label) => !originalLabelIds.has(label.id));
      const originalWireIds = new Set(originalSheet.wires.map((wire) => wire.id));
      const addedWires = study.wires.filter((wire) => !originalWireIds.has(wire.id));
      assert.equal(addedParts.length, 2);
      assert.deepEqual(
        schematicTexts(study.original),
        schematicTexts(originalSheet.original),
        'The compact series circuit adds no fine-print explanation or free text.',
      );
      assert.equal(
        addedParts.find((part) => part.libId === 'Device:R').value,
        `${(measurement.equivalentResistanceOhm * 1000).toFixed(2)}mΩ`,
        'The native resistor Value uses milliohms with two decimal places.',
      );
      assert.equal(
        addedParts.find((part) => part.libId === 'Device:L').value,
        `${measurement.shortestPartialInductanceNh.toFixed(2)}nH`,
        'The native inductor Value uses nanohenries with two decimal places.',
      );
      assert.equal(
        addedLabels.length,
        5,
        'Two block labels and three exact circuit-anchor copies are added.',
      );
      const changedWires = originalSheet.wires.filter(
        (wire) =>
          JSON.stringify(study.wires.find((item) => item.id === wire.id)) !== JSON.stringify(wire),
      );
      assert.equal(changedWires.length, 1, 'Exactly one original same-ID leaf lead is shortened.');
      const originalLead = changedWires[0];
      const shortenedLead = study.wires.find((wire) => wire.id === originalLead.id);
      assert.equal(originalLead.id, '404f4e26-02f5-4866-a5a3-ad1ae0199c59');
      assert.deepEqual(
        { ...shortenedLead, raw: originalLead.raw },
        { ...originalLead, a: { x: 87.63, y: 50.8 } },
      );
      assert.deepEqual(
        shortenedLead.raw.filter((item) => !Array.isArray(item) || item[0] !== 'pts'),
        originalLead.raw.filter((item) => !Array.isArray(item) || item[0] !== 'pts'),
        'The shortened wire retains its native identity and non-coordinate metadata.',
      );
      const endpointSource = (pad) => {
        const footprint = beforeProject.pcb.footprints.find((item) =>
          item.pads.some((item) => item.id === pad.id),
        );
        assert.ok(footprint, 'The selected terminal belongs to a current PCB footprint.');
        const reference =
          beforeProject.schematic.parts.find((part) => part.id === footprint.symbolId)?.ref ??
          footprint.reference;
        assert.ok(
          reference && pad.number,
          'The fixture terminal has an actual reference and pad number.',
        );
        const part = originalSheet.parts.find((part) => part.id === footprint.symbolId);
        assert.ok(part, 'The selected pad has an exact symbol in the target schematic.');
        const library = originalSheet.libraries[part.libId];
        const positions = pinPositions(part, library);
        const pins = unitGraphics(library, part.unit || 1)
          .flatMap((unit) => children(unit, 'pin'))
          .map((pin, index) => ({ number: val(child(pin, 'number')), ...positions[index] }))
          .filter((pin) => pin.number === pad.number);
        assert.equal(pins.length, 1, 'The selected PCB pad maps to one exact schematic pin.');
        return { name: `${reference}.${pad.number}`, point: pins[0] };
      };
      const endpointSources = [endpointSource(start), endpointSource(end)];
      const endpointNames = endpointSources.map(({ name }) => name);
      assert.deepEqual(
        endpointSources.map(({ name, point }) => ({ name, x: point.x, y: point.y })),
        [
          { name: 'U1.2', x: 74.93, y: 50.8 },
          { name: 'L1.1', x: 88.9, y: 50.8 },
        ],
      );
      const sourceCenter = {
        x: (endpointSources[0].point.x + endpointSources[1].point.x) / 2,
        y: (endpointSources[0].point.y + endpointSources[1].point.y) / 2,
      };
      const assertNearSource = (parts, wires, labels) => {
        const points = [...parts, ...labels, ...wires.flatMap((wire) => [wire.a, wire.b])];
        const center = {
          x:
            (Math.min(...points.map((point) => point.x)) +
              Math.max(...points.map((point) => point.x))) /
            2,
          y:
            (Math.min(...points.map((point) => point.y)) +
              Math.max(...points.map((point) => point.y))) /
            2,
        };
        assert.ok(
          Math.hypot(center.x - sourceCenter.x, center.y - sourceCenter.y) <= 40,
          `The compact study stays near the exact U1.2–L1.1 pin pair, got center (${center.x}, ${center.y}).`,
        );
      };
      const row = addedParts[0].y;
      const blockLabels = addedLabels.filter((label) => label.y === row);
      const connectionLabels = addedLabels.filter((label) => label.y !== row);
      assert.equal(blockLabels.length, 2);
      assert.equal(connectionLabels.length, 3);
      assertNearSource(addedParts, addedWires, blockLabels);
      const orderedLabels = [...blockLabels].sort((a, b) => a.x - b.x);
      assert.deepEqual(
        orderedLabels.map((label) => label.text),
        endpointNames.map((name) => `LP_${name}`),
        'The two visible labels identify the selected physical endpoints in start/end order.',
      );
      assert.deepEqual(
        connectionLabels.map(({ text, x, y }) => ({ text, x, y })).sort((a, b) => a.x - b.x),
        [
          { text: orderedLabels[0].text, x: 74.93, y: 50.8 },
          { text: orderedLabels[0].text, x: 87.63, y: 50.8 },
          { text: orderedLabels[1].text, x: 88.9, y: 50.8 },
        ],
        'The circuit labels retain the exact start pin, cut anchor and isolated end pin.',
      );
      const resistor = addedParts.find((part) => part.libId === 'Device:R');
      const inductor = addedParts.find((part) => part.libId === 'Device:L');
      const nets = spiceNets(study);
      const startNode = nets.node(
        study.parts.find((part) => part.ref === 'U1'),
        '2',
      );
      const endNode = nets.node(
        study.parts.find((part) => part.ref === 'L1'),
        '1',
      );
      const middleNode = nets.node(resistor, '2');
      assert.equal(
        new Set([startNode, middleNode, endNode]).size,
        3,
        'No ideal wire bypasses the inserted R/L.',
      );
      assert.equal(nets.node(resistor, '1'), startNode);
      assert.equal(nets.node(inductor, '1'), middleNode);
      assert.equal(nets.node(inductor, '2'), endNode);
      const deck = buildSpiceDeck(study, defaultTransient(study));
      for (const part of addedParts)
        assert.ok(
          deck.traces.some((trace) =>
            trace.targets?.some((target) => target.kind === 'current' && target.id === part.id),
          ),
          `${part.ref} compiles a branch-current target.`,
        );
      assert.equal(addedWires.length, 3, 'Only the terminal leads and series link are added.');
      assert.ok(
        [...addedParts, ...blockLabels].every((object) => object.y === row) &&
          addedWires.every((wire) => wire.a.y === row && wire.b.y === row),
        'The two labelled terminals and series R/L share one straight horizontal row.',
      );
      const endpoints = addedWires.flatMap((wire) => [wire.a, wire.b]);
      assert.ok(
        Math.max(...endpoints.map((point) => point.x)) -
          Math.min(...endpoints.map((point) => point.x)) <=
          45,
        'The extracted series circuit occupies at most 45 mm of wiring width.',
      );
      const addedIds = [...addedParts, ...addedWires, ...blockLabels].map((object) => object.id);
      await waitForAsync(
        page,
        async (expected) => {
          const { ui } = await window.thermalWorkbenchHost().query('workbench.state');
          return (
            ui.selection.length === expected.length &&
            expected.every((id) => ui.selection.includes(id))
          );
        },
        addedIds,
      );
      const selected = (
        await page.evaluate(() => window.thermalWorkbenchHost().query('workbench.state'))
      ).ui.selection;
      assert.deepEqual(
        [...selected].sort(),
        [...addedIds].sort(),
        'Only the movable compact block is selected; circuit-anchor label copies remain fixed.',
      );
      for (const label of addedLabels) {
        assert.equal(label.scope, undefined, 'Series connections use ordinary local labels.');
        await schematic
          .locator(`[data-selection-id="${label.id}"]`)
          .locator('text')
          .first()
          .waitFor();
      }
      await page
        .waitForFunction(
          ({ parts, labels }) => {
            const canvas = document.querySelector('[data-testid="schematic-canvas"]');
            if (!canvas) return false;
            const bounds = canvas.getBoundingClientRect();
            const nodes = [...canvas.querySelectorAll('[data-testid]')];
            const readouts = [
              ...parts.flatMap((ref) =>
                ['ref', 'value'].map((field) =>
                  nodes.find((node) => node.dataset.testid === `annotation-${field}-${ref}`),
                ),
              ),
              ...labels.map((id) =>
                nodes.find((node) => node.dataset.selectionId === id)?.querySelector('text'),
              ),
            ];
            return readouts.every((node) => {
              if (!node) return false;
              const box = node.getBoundingClientRect();
              return (
                box.width > 0 &&
                box.height > 0 &&
                box.x >= bounds.x &&
                box.y >= bounds.y &&
                box.right <= bounds.right &&
                box.bottom <= bounds.bottom
              );
            });
          },
          {
            parts: addedParts.map((part) => part.ref),
            labels: blockLabels.map((label) => label.id),
          },
        )
        .catch(async (error) => {
          await page.screenshot({ path: 'test-results/layout-parasitics-study-ui.png' });
          throw error;
        });
      const readouts = [];
      for (const part of addedParts)
        for (const field of ['ref', 'value'])
          readouts.push({
            name: `${part.ref} ${field}`,
            bounds: await schematic.getByTestId(`annotation-${field}-${part.ref}`).boundingBox(),
          });
      for (const label of blockLabels)
        readouts.push({
          name: label.text,
          bounds: await schematic
            .locator(`[data-selection-id="${label.id}"]`)
            .locator('text')
            .first()
            .boundingBox(),
        });
      await page.screenshot({ path: 'test-results/layout-parasitics-study-ui.png' });
      const schematicBounds = await schematic.boundingBox();
      const selectedBounds = await schematic.evaluate((canvas, ids) => {
        const inverse = canvas.getScreenCTM()?.inverse();
        if (!inverse) return null;
        const nodes = [...canvas.querySelectorAll('[data-selection-id]')].filter((node) =>
          ids.includes(node.dataset.selectionId),
        );
        const points = nodes.flatMap((node) => {
          const bounds = node.getBoundingClientRect();
          return [
            new DOMPoint(bounds.left, bounds.top),
            new DOMPoint(bounds.right, bounds.bottom),
          ].map((point) => point.matrixTransform(inverse));
        });
        if (!points.length) return null;
        return {
          width:
            Math.max(...points.map((point) => point.x)) -
            Math.min(...points.map((point) => point.x)),
          height:
            Math.max(...points.map((point) => point.y)) -
            Math.min(...points.map((point) => point.y)),
          paintedIds: ids.filter((id) =>
            nodes.some(
              (node) =>
                node.dataset.selectionId === id && node.querySelector('[data-selection-only]'),
            ),
          ),
        };
      }, addedIds);
      assert.ok(selectedBounds, 'The complete added selection has measurable drawing bounds.');
      assert.ok(
        selectedBounds.width <= 60 && selectedBounds.height <= 15,
        'The selected circuit stays compact including references, two-decimal values and terminal labels.',
      );
      assert.deepEqual(
        [...selectedBounds.paintedIds].sort(),
        [...addedIds].sort(),
        'Every added component, wire and label has selected paint.',
      );
      const originalTheme = await page.evaluate(
        () => document.documentElement.dataset.theme ?? null,
      );
      await setTheme('dark');
      await page.screenshot({ path: 'test-results/layout-parasitics-study-dark-ui.png' });
      await setTheme(originalTheme ?? 'light');
      await page.evaluate((theme) => {
        if (theme === null) delete document.documentElement.dataset.theme;
        else document.documentElement.dataset.theme = theme;
      }, originalTheme);
      for (const [index, a] of readouts.entries()) {
        assert.ok(a.bounds, `${a.name} must be visibly rendered.`);
        assert.ok(
          a.bounds.x >= schematicBounds.x &&
            a.bounds.y >= schematicBounds.y &&
            a.bounds.x + a.bounds.width <= schematicBounds.x + schematicBounds.width &&
            a.bounds.y + a.bounds.height <= schematicBounds.y + schematicBounds.height,
          `${a.name} must be inside the visible schematic canvas.`,
        );
        for (const b of readouts.slice(index + 1)) {
          assert.ok(b.bounds, `${b.name} must be visibly rendered.`);
          const overlapX =
            Math.min(a.bounds.x + a.bounds.width, b.bounds.x + b.bounds.width) -
            Math.max(a.bounds.x, b.bounds.x);
          const overlapY =
            Math.min(a.bounds.y + a.bounds.height, b.bounds.y + b.bounds.height) -
            Math.max(a.bounds.y, b.bounds.y);
          assert.ok(
            overlapX <= 0.5 || overlapY <= 0.5,
            `${a.name} and ${b.name} must remain readable without overlapping.`,
          );
        }
      }
      const showAll = async () => {
        await page
          .locator('.schematic-section-switch')
          .getByRole('combobox', { name: 'Schematic section', exact: true })
          .click();
        await page
          .getByRole('listbox', { name: 'Schematic section', exact: true })
          .getByRole('option', { name: 'All', exact: true })
          .click();
        await waitForAsync(
          page,
          async () =>
            (await window.thermalWorkbenchHost().query('workbench.state')).ui.schematicSection ===
            'all',
        );
      };
      await showAll();
      await schematic
        .getByTestId(`part-${originalSheet.parts.find((part) => part.ref === 'U1').ref}`)
        .waitFor();
      await schematic.focus();
      await schematic.press('Space');
      const geometryBounds = (ids) =>
        schematic.locator('[data-selection-id]').evaluateAll(
          (nodes, ids) =>
            nodes
              .filter((node) => ids.includes(node.getAttribute('data-selection-id')))
              .map((node) => {
                const { x, y, width, height } = node.getBoundingClientRect();
                return { id: node.getAttribute('data-selection-id'), x, y, width, height };
              })
              .filter((bounds) => bounds.width > 0 || bounds.height > 0)
              .map((bounds) => ({
                ...bounds,
                x: bounds.width ? bounds.x : bounds.x - 0.5,
                y: bounds.height ? bounds.y : bounds.y - 0.5,
                width: Math.max(1, bounds.width),
                height: Math.max(1, bounds.height),
              })),
          ids,
        );
      const assertGeometryApart = async (insertedIds, acceptedIds) => {
        const inserted = await geometryBounds(insertedIds);
        const accepted = await geometryBounds(acceptedIds);
        assert.ok(inserted.length && accepted.length);
        for (const added of inserted)
          for (const original of accepted) {
            const overlapX =
              Math.min(added.x + added.width, original.x + original.width) -
              Math.max(added.x, original.x);
            const overlapY =
              Math.min(added.y + added.height, original.y + original.height) -
              Math.max(added.y, original.y);
            assert.ok(
              overlapX <= 0.5 || overlapY <= 0.5,
              `Inserted object ${added.id} must remain separated from accepted object ${original.id}.`,
            );
          }
      };
      const originalDrawingIds = ['parts', 'wires', 'junctions', 'labels', 'noConnects'].flatMap(
        (kind) => (originalSheet[kind] ?? []).map((object) => object.id),
      );
      await assertGeometryApart(addedIds, originalDrawingIds);
      const createdNative = projectNativeFiles(createdProject, 'project.kicad_pro');
      const reopenedStudy = projectSchematics(projectFromNativeFiles(createdNative)).find(
        (sheet) => sheet.id === targetId,
      );
      assert.ok(reopenedStudy, 'The same study sheet reopens from actual native files.');
      for (const part of addedParts) {
        const reopenedPart = reopenedStudy.parts.find((item) => item.id === part.id);
        assert.ok(reopenedPart, `${part.ref} retains its identity after native Save/reopen.`);
        const fields = partFields(reopenedPart);
        const endpointFields = {
          'OpenPE.Parasitics.BoardId': beforeProject.pcb.id,
          'OpenPE.Parasitics.StartId': start.id,
          'OpenPE.Parasitics.EndId': end.id,
          'OpenPE.Parasitics.Connection': 'series',
          'OpenPE.Parasitics.Role': part.libId === 'Device:R' ? 'resistor' : 'inductor',
          'OpenPE.Parasitics.StartLabel': orderedLabels[0].text,
          'OpenPE.Parasitics.EndLabel': orderedLabels[1].text,
        };
        assert.match(
          fields['OpenPE.Parasitics.GroupId'],
          /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i,
        );
        assert.equal(
          fields['OpenPE.Parasitics.GroupId'],
          partFields(addedParts[0])['OpenPE.Parasitics.GroupId'],
        );
        for (const [key, expected] of Object.entries(endpointFields))
          assert.equal(fields[key], expected, `${part.ref} preserves the exact ${key} identity.`);
        for (const [key, endpoint] of [
          ['OpenPE.Parasitics.Start', endpointNames[0]],
          ['OpenPE.Parasitics.End', endpointNames[1]],
        ])
          assert.ok(
            typeof fields[key] === 'string' && fields[key].includes(endpoint),
            `${part.ref} retains the readable ${endpoint} source endpoint.`,
          );
        for (const key of [
          ...Object.keys(endpointFields),
          'OpenPE.Parasitics.Start',
          'OpenPE.Parasitics.End',
          'OpenPE.Parasitics.GroupId',
        ]) {
          const property = children(reopenedPart.raw, 'property').find((node) => val(node) === key);
          assert.ok(property, `${part.ref} stores ${key} as a real native property.`);
          const effects = child(property, 'effects') ?? [];
          assert.ok(
            property.includes('hide') ||
              val(child(property, 'hide')) === 'yes' ||
              effects.includes('hide') ||
              val(child(effects, 'hide')) === 'yes',
            'Endpoint provenance is hidden native data, without fine print on the canvas.',
          );
        }
      }
      const changedSchematics = beforeNative.files.filter(
        (file) =>
          file.name.endsWith('.kicad_sch') &&
          createdNative.files.find((candidate) => candidate.name === file.name)?.source !==
            file.source,
      );
      assert.equal(changedSchematics.length, 1, 'Only the selected native schematic changes.');
      assert.deepEqual(
        createdNative.files.map((file) => file.name),
        beforeNative.files.map((file) => file.name),
        'No extra native schematic file is created.',
      );
      for (const file of beforeNative.files.filter(
        (file) => /\.kicad_(?:sch|pcb)$/.test(file.name) && file.name !== changedSchematics[0].name,
      )) {
        const createdFile = createdNative.files.find((candidate) => candidate.name === file.name);
        assert.ok(createdFile, `${file.name} is retained.`);
        assert.equal(createdFile.encoding, file.encoding);
        assert.ok(
          createdFile.source === file.source,
          `Adding components preserves the original native bytes of ${file.name}.`,
        );
      }
      await page.screenshot({ path: 'test-results/layout-parasitics-study-overview-ui.png' });
      await page.getByRole('button', { name: 'Layout', exact: true }).click();
      await parasiticsButton.click();
      await parasitics.waitFor();
      assert.deepEqual(await terminals.locator('dd').allTextContents(), ['—', '—', '—']);
      await clickPad(start);
      await clickPad(end);
      await measuredResistance.waitFor();
      await create.click();
      await parasitics
        .getByRole('alert')
        .filter({ hasText: 'This terminal pair already has parasitic study components.' })
        .waitFor();
      const repeated = await readDesign();
      assert.equal(
        repeated.source,
        created.source,
        'A duplicate pair cannot add a parallel bypass or change native geometry.',
      );
      assert.deepEqual(
        repeated.history,
        created.history,
        'Rejected duplicate insertion adds no undo entry.',
      );
      assert.equal(await sheetTabs.count(), originalTabCount);
      await page.screenshot({ path: 'test-results/layout-parasitics-study-repeat-error-ui.png' });
      await parasitics
        .getByRole('button', { name: 'Close Layout Parasitics', exact: true })
        .click();
      await page.getByRole('button', { name: 'Schematic', exact: true }).click();
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await waitForAsync(
        page,
        async (expected) =>
          (await window.thermalWorkbenchHost().query('project.source')) === expected,
        beforeStudy.source,
      );
      const undone = await readDesign();
      assert.equal(undone.source, beforeStudy.source);
      assert.equal(undone.history.undoDepth, beforeStudy.history.undoDepth);
      assert.equal(undone.history.redoDepth, 1);
      const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
      assert.equal(
        digest(projectNativeFiles(parseProject(undone.source), 'project.kicad_pro')),
        digest(beforeNative),
        'One GUI undo restores the complete native file set exactly.',
      );
      assert.equal(await sheetTabs.count(), originalTabCount);
      assert.equal(statusRequests, 0, 'Adding parasitic components cannot start a thermal solver.');
      assert.equal(runRequests, 0);
      assert.deepEqual(errors, []);
      console.log(
        'Layout Parasitics series insertion passed: compact R/L near exact U1.2–L1.1, one same-ID 1.27 mm leaf cut, five native connection labels, distinct SPICE nodes and branch-current targets, movable-block selection, no geometry overlap, native group provenance, two-decimal values, duplicate-pair rejection, exact PCB bytes and one-undo restoration without tabs. No native app, provider or solver was run.',
      );
      return;
    }
    await clickVia();
    await second.waitFor({ state: 'detached' });
    await startHighlight.waitFor({ state: 'detached' });
    const viaHighlight = layout.locator(
      `[data-via-type][data-selection-id="${via.id}"] [data-selection-only]`,
    );
    await viaHighlight.waitFor();
    await measuredResistance.waitFor({ state: 'detached' });
    assert.deepEqual(await results.locator('dd').allTextContents(), ['—', '—', '—']);
    await clickPad(viaPad);
    await second.waitFor();
    await parasitics
      .getByRole('alert')
      .filter({
        hasText: 'Filled copper zones on the selected net are outside the Layout Parasitics model.',
      })
      .waitFor();
    await clearTerminals.click();
    await first.waitFor({ state: 'detached' });
    await viaHighlight.waitFor({ state: 'detached' });
    assert.deepEqual(await terminals.locator('dd').allTextContents(), ['—', '—', '—']);
    assert.deepEqual(await results.locator('dd').allTextContents(), ['—', '—', '—']);
    await clickPad(start);
    await first.waitFor();
    await layout.press('Escape');
    await first.waitFor({ state: 'detached' });
    for (const ref of ['C2', 'J2']) {
      const part = project.schematic.parts.find((item) => item.ref === ref);
      const footprint = project.pcb.footprints.find((item) => item.symbolId === part.id);
      await clickPad(footprint.pads.find((pad) => pad.number === '1'));
    }
    await second.waitFor();
    await measuredResistance.waitFor();
    const outputLength = 2.95 + Math.hypot(2.31, 2.31) + 2.94;
    assert.equal(
      await results.locator('dd').first().textContent(),
      `${outputLength.toFixed(3)} mm`,
    );
    const expected = ((1.724e-5 * outputLength * 1000) / (0.8 * 0.035)).toFixed(3);
    assert.equal(
      await results.locator('dd').nth(1).textContent(),
      `${expected} mΩ`,
      'The LM2596 C2 to J2 output measurement includes rounded track-end contacts.',
    );

    assert.deepEqual(
      await page.evaluate(() => window.thermalWorkbenchHost().execute('thermal.show')),
      { visible: true },
    );
    await thermal.waitFor();
    await parasitics.waitFor({ state: 'hidden' });
    await first.waitFor({ state: 'detached' });
    await parasiticsButton.click();
    await parasitics.waitFor();
    await thermal.waitFor({ state: 'hidden' });
    assert.equal(
      (await page.evaluate(() => window.thermalWorkbenchHost().query('thermal.status'))).visible,
      false,
      'Switching docks retains the Thermal session without displaying it.',
    );
    await parasitics.getByRole('button', { name: /^Close/ }).click();
    await parasitics.waitFor({ state: 'hidden' });
    await nativeSidebar.waitFor();
    assert.equal(
      await parasiticsButton.evaluate((button) => button === document.activeElement),
      true,
    );
    assert.ok(Math.abs((await nativeSidebar.boundingBox()).width - nativeWidth) <= 1);
    assert.ok(Math.abs((await drawing.boundingBox()).width - nativeDrawingWidth) <= 1);

    await toggleLayoutVisualization(page, 'Selection');
    await page.getByRole('checkbox', { name: 'Pads', exact: true }).uncheck();
    await toggleLayoutVisualization(page, 'Selection');
    await parasiticsButton.click();
    await parasitics.waitFor();
    await clickPad(start);
    assert.equal(await first.count(), 0, 'Parasitics respects the ordinary Pads selection filter.');
    await page.evaluate(() =>
      window.thermalWorkbenchHost().execute('workbench.plugins.change', {
        action: 'disable',
        id: 'layout-parasitics@openpe',
      }),
    );
    await parasiticsButton.waitFor({ state: 'hidden' });
    await parasitics.waitFor({ state: 'hidden' });
    await nativeSidebar.waitFor();
    assert.equal(runRequests, 0);
    assert.deepEqual(
      await readDesign(),
      originalDesign,
      'Measurement leaves design and undo unchanged.',
    );
    assert.deepEqual(errors, []);
    console.log(
      'Layout Parasitics dock passed: canvas pad and via picks, measurement, reset, IME guard, Thermal switching, sidebar restoration and plugin teardown.',
    );
    return;
  }
  await page.getByRole('button', { name: 'Layout Thermal', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Layout Thermal', exact: true });
  const heatInput = page.getByRole('combobox', { name: 'Thermal heat input', exact: true });
  await heatInput.press('ArrowDown');
  const heatInputMenu = page.getByRole('listbox', { name: 'Thermal heat input', exact: true });
  await heatInputMenu.waitFor();
  const popupWidth = (await heatInputMenu.boundingBox()).width;
  const triggerWidth = (await heatInput.boundingBox()).width;
  assert.ok(Math.abs(popupWidth - triggerWidth) <= 1);
  await heatInput.press('Home');
  await heatInput.press('Enter');
  await panel.waitFor();
  const expectThermalWidth = async (expected, drawingWidth) => {
    await page.waitForFunction((expected) => {
      const panel = document.querySelector('[aria-label="Layout Thermal"][data-docked]');
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
    await page.getByRole('button', { name: 'Layout Thermal', exact: true }).click();
    await panel.waitFor();
    await expectThermalWidth(width, drawingWidth);
  };
  const closeThermal = async () => {
    await page.getByRole('button', { name: 'Close Layout Thermal', exact: true }).click();
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
  await page.getByRole('button', { name: 'Close Layout Thermal', exact: true }).click();
  await page.getByRole('button', { name: 'Layout Thermal', exact: true }).click();
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
}
try {
  await runChecks();
} finally {
  await browser.close();
}
