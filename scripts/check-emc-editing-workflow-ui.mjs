import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { createLibraryService } from '../server/libraries.mjs';
import { bundledWorkbenchCatalog } from '../server/workbench-plugins.mjs';
import { prepareExampleFootprints } from '../server/example-footprints.mjs';
import { prepareProjectModelFiles } from '../server/project-model-files.mjs';
import { createSimulationModelStore } from '../server/example-models.mjs';
import { createEnclosureStep } from '../server/enclosure-step.mjs';
import { atomicWrite } from '../server/atomic-write.mjs';
import {
  fillSource,
  readNativeFiles,
  readNativeProject,
  readSource,
  selectSourceFile,
} from './source-editor-test-helpers.mjs';

// One real EMC project through DesktopWorkspace, Core and native Source. Library
// ports use pinned offline files. The picker is fixed to a fresh test folder;
// Save, native reopening and STEP use the real host implementations. No Electron,
// user destinations, provider, solver or network download is involved.
const source = await readFile('lib/emc-flyback-example.json', 'utf8');
const { modelCadFromProject, MODEL_CAD_NATIVE_VARIABLE } = await tsImport(
  '../lib/model-cad.ts',
  import.meta.url,
);
const { padDrillPosition } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const { parseProject, serializeProject } = await tsImport('../lib/project.ts', import.meta.url);
const { projectNetGroups } = await tsImport('../lib/project-net-groups.ts', import.meta.url);
const electricalTopology = (circuit) =>
  projectNetGroups(circuit)
    .map((group) => ({
      pins: [...group.pins].sort(),
      labels: group.labels
        .map((index) => [circuit.labels[index].id, circuit.labels[index].text])
        .sort((a, b) => a[0].localeCompare(b[0])),
    }))
    .filter((group) => group.pins.length || group.labels.length)
    .map((group) => JSON.stringify(group))
    .sort();
const { projectNativeFiles, projectFromNativeFiles } = await tsImport(
  '../lib/kicad-project.ts',
  import.meta.url,
);
const require = createRequire(import.meta.url);
const { createNativeSave } = require('../electron/native-save.cjs');
const { FileGrants } = require('../electron/file-grants.cjs');
const { readNativeProject: readNativeProjectFile } = require('../electron/native-project.cjs');
const fileGrants = new FileGrants();
const projectId = '00000000-0000-4000-8000-000000000024';
let recovery = {
  version: 2,
  documents: [
    {
      id: projectId,
      source,
      sourceDraft: null,
      dirty: false,
      filename: 'emc-flyback.kicad_pro',
      exampleKey: null,
      localExample: false,
      sessions: [{ id: 'emc-editing', messages: [], draft: '' }],
      activeSessionId: 'emc-editing',
    },
  ],
  activeDocumentId: projectId,
  provider: 'codex',
  effort: 'low',
  approvalMode: 'review',
  models: {},
};
const bundle = await build({
  stdin: {
    contents:
      "import React from 'react';import{createRoot}from'react-dom/client';import Workspace from './components/DesktopWorkspace';createRoot(document.getElementById('root')).render(<Workspace/>);",
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  outdir: 'test-results/emc-editing-workflow/bundle',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [
    {
      name: 'expose-workflow-capability-host',
      setup(plugin) {
        plugin.onLoad({ filter: /[\\/]Workbench\.tsx$/ }, async (args) => {
          const source = await readFile(args.path, 'utf8');
          const marker = '  const [activeSchematicId, setActiveSchematicId] = useState(';
          assert.ok(source.includes(marker));
          return {
            contents: source.replace(
              marker,
              '  if (active) window.workflowCapabilityHost = capabilityHost;\n' + marker,
            ),
            loader: 'tsx',
            resolveDir: path.dirname(args.path),
          };
        });
      },
    },
  ],
});
await mkdir('test-results/emc-editing-workflow', { recursive: true });
const nativeDirectory = await mkdtemp(path.resolve('test-results/emc-editing-workflow/native-'));
const nativeFile = path.join(nativeDirectory, 'emc-flyback.kicad_pro');
const modelStore = createSimulationModelStore(nativeDirectory, async () => {
  throw new Error('Native EMC Save must use pinned offline models.');
});
const nativeSave = createNativeSave({
  parseProject,
  projectNativeFiles,
  fileGrants,
  dataDir: nativeDirectory,
  atomicWrite,
  showSaveDialog: async () => ({ canceled: false, filePath: nativeFile }),
  prepareProjectFiles: async (project, file, sourceFile) => {
    await prepareExampleFootprints(project, file);
    await prepareProjectModelFiles(
      project,
      file,
      sourceFile,
      modelStore,
      new AbortController().signal,
    );
  },
});
const libraries = createLibraryService({ dataDir: '.openpe/emc-editing-workflow' });
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('EMC editing must use pinned offline resources.');
};
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    channel:
      process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  });
  const page = await browser.newPage({ viewport: { width: 1520, height: 980 } });
  page.setDefaultTimeout(20000);
  const errors = [],
    requests = [],
    modelRequests = new Set();
  let saves = 0,
    ignoreRecoveryWrites = false;
  page.on('pageerror', (error) => errors.push(error.message));
  await page.exposeFunction('workflowNewFile', () => fileGrants.create());
  await page.exposeFunction('workflowAcceptOpen', () => fileGrants.create(nativeFile));
  await page.exposeFunction('workflowOpen', async () => ({
    source: serializeProject(projectFromNativeFiles(await readNativeProjectFile(nativeFile))),
    name: path.basename(nativeFile),
    native: true,
  }));
  await page.exposeFunction('workflowSave', async (options) => {
    const result = await nativeSave(options);
    saves++;
    return result;
  });
  await page.exposeFunction('workflowExportStep', async (options) => {
    const bytes = await createEnclosureStep(parseProject(options.source));
    assert.ok(bytes.toString('ascii').includes('MANIFOLD_SOLID_BREP('));
    assert.ok(
      bytes.toString('ascii').includes('CYLINDRICAL_SURFACE('),
      'The exported plate retains analytical drilled holes.',
    );
    await writeFile(path.join(nativeDirectory, 'emc-assembly.step'), bytes);
    return { name: 'emc-assembly.step' };
  });
  await page.addInitScript(() => {
    window.workflowExports = [];
    window.openpe = {
      titleBarOverlay: true,
      writeWorkspaceRecovery: async (content) => {
        await fetch('http://localhost/api/state', {
          method: content === null ? 'DELETE' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: content ?? undefined,
        });
      },
      connection: async () => ({ base: 'http://localhost', token: 'emc-workflow' }),
      newFile: () => window.workflowNewFile(),
      open: () => window.workflowOpen(),
      acceptOpen: () => window.workflowAcceptOpen(),
      save: (options) => window.workflowSave(options),
      releaseFile: async () => {},
      setDirty: async () => {},
      onCloseRequested: () => () => {},
      historyList: async () => ({ version: '', commits: [], more: false, needsSave: true }),
      exportEnclosure: async (options) => {
        window.workflowExports.push(options);
        return window.workflowExportStep(options);
      },
    };
  });
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/state') {
      if (route.request().method() === 'POST' && !ignoreRecoveryWrites)
        recovery = route.request().postDataJSON();
      return route.fulfill({ json: recovery });
    }
    if (url.pathname === '/api/agent-settings')
      return route.fulfill({ json: { followUpMode: 'queue' } });
    if (url.pathname === '/api/appearance') return route.fulfill({ json: null });
    if (url.pathname === '/api/agents') return route.fulfill({ json: [] });
    if (url.pathname === '/api/models')
      return route.fulfill({ json: { models: [], defaultModel: '' } });
    if (url.pathname === '/api/workbench-plugins')
      return route.fulfill({ json: bundledWorkbenchCatalog() });
    if (url.pathname === '/api/libraries/footprints') {
      requests.push(url.searchParams.get('id'));
      return route.fulfill({
        json: await libraries.request({
          action: 'detail',
          kind: 'footprints',
          id: url.searchParams.get('id'),
        }),
      });
    }
    if (url.pathname === '/api/library-model') {
      const id = url.searchParams.get('id'),
        index = Number(url.searchParams.get('index'));
      modelRequests.add(`${id}:${index}`);
      return route.fulfill({ json: await libraries.model(id, index) });
    }
    if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(url.pathname))
      return route.fulfill({
        contentType: url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        body: await readFile('public' + url.pathname),
      });
    if (url.pathname.startsWith('/api/'))
      throw new Error(`Unexpected workflow API: ${url.pathname}`);
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  const mount = async () => {
    await page.goto('http://localhost');
    for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
      await page.addStyleTag({ content: await readFile(file, 'utf8') });
    for (const output of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
      await page.addStyleTag({ content: output.text });
    await page.addScriptTag({
      content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
    });
  };
  await mount();
  const button = (name) => page.getByRole('button', { name, exact: true });
  const schematic = page.getByTestId('schematic-canvas');
  const native = async () => {
    await button('Source').click();
    return readNativeFiles(page);
  };
  const nativeProject = async () => {
    await button('Source').click();
    return readNativeProject(page);
  };
  const clean = async () =>
    assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  await schematic.waitFor();
  const original = await native();
  const baseline = await readNativeProject(page);
  assert.equal(baseline.schematic.parts.length, 150);
  assert.equal(baseline.pcb.footprints.length, 88);
  assert.equal(baseline.pcb.tracks.length, 336);
  await clean();

  // Find a real resistor through the public list, edit it, visit both other
  // editors, then undo from Layout. All native files must recover exact bytes.
  await button('Schematic').click();
  const resistor = schematic.getByTestId('part-R1');
  const drawingBounds = await schematic.boundingBox();
  assert.ok(drawingBounds);
  for (let i = 0; i < 2; i++) {
    await page.mouse.move(
      drawingBounds.x + drawingBounds.width * 0.25,
      drawingBounds.y + drawingBounds.height * 0.5,
    );
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(
      drawingBounds.x + drawingBounds.width * 0.9,
      drawingBounds.y + drawingBounds.height * 0.5,
      { steps: 4 },
    );
    await page.mouse.up({ button: 'middle' });
  }
  const visibleResistor = () =>
    resistor.evaluate((node) => {
      const body = node.getBoundingClientRect();
      const drawing = node.ownerSVGElement.getBoundingClientRect();
      return (
        body.left >= drawing.left &&
        body.right <= drawing.right &&
        body.top >= drawing.top &&
        body.bottom <= drawing.bottom
      );
    });
  assert.equal(await visibleResistor(), false, 'The EMC resistor starts outside the panned view.');
  await button('List').click();
  const partsList = page.getByRole('dialog', { name: 'List', exact: true });
  const partsSearch = partsList.getByRole('textbox', { name: 'Search parts', exact: true });
  assert.equal(await partsList.locator('.parts-panel-row').count(), 88);
  assert.equal(await partsSearch.evaluate((node) => document.activeElement === node), true);
  const partsWidth = partsList.getByRole('button', {
    name: 'Resize list left',
    exact: true,
  });
  for (let i = 0; i < 40 && (await partsList.boundingBox()).width > 340; i++)
    await partsWidth.press('ArrowRight');
  assert.ok(Math.abs((await partsList.boundingBox()).width - 340) < 1);
  const partsHeader = partsList.locator('.parts-panel-navigation');
  const headerBeforeScroll = await partsHeader.boundingBox();
  await partsList.locator('.dialog-content').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  const compactList = await partsList.evaluate((dialog) => {
    const content = dialog.querySelector('.dialog-content');
    const search = dialog.querySelector('input');
    const heading = dialog.querySelector('.parts-panel-navigation');
    const lastLocate = [...dialog.querySelectorAll('.parts-panel-locate')].at(-1);
    const bounds = dialog.getBoundingClientRect();
    return {
      scrolled: content.scrollTop > 0,
      horizontalOverflow: content.scrollWidth - content.clientWidth,
      searchRight: search.getBoundingClientRect().right,
      locateRight: lastLocate.getBoundingClientRect().right,
      right: bounds.right,
      headingTop: heading.getBoundingClientRect().top,
    };
  });
  assert.equal(compactList.scrolled, true);
  assert.ok(
    compactList.horizontalOverflow <= 1,
    'Dense parts remain within the minimum panel width.',
  );
  assert.ok(
    compactList.searchRight < compactList.right && compactList.locateRight < compactList.right,
  );
  assert.ok(
    Math.abs(compactList.headingTop - headerBeforeScroll.y) <= 1,
    'Search and column headings remain visible while scrolling.',
  );
  await page.screenshot({ path: 'test-results/emc-editing-workflow/parts-search-compact.png' });
  await partsWidth.press('Home');
  await partsList.locator('.dialog-content').evaluate((node) => {
    node.scrollTop = 0;
  });
  await partsSearch.fill('no such EMC component');
  await partsList.getByText('No matching components', { exact: true }).waitFor();
  assert.equal(await partsList.locator('.parts-panel-row').count(), 0);
  await partsList.getByRole('button', { name: 'Clear parts search', exact: true }).click();
  assert.equal(await partsSearch.inputValue(), '');
  assert.equal(await partsSearch.evaluate((node) => document.activeElement === node), true);
  assert.equal(await partsList.locator('.parts-panel-row').count(), 88);
  await partsSearch.fill('r1');
  const matchingParts = await partsList.locator('.parts-panel-edit strong').allTextContents();
  assert.ok(matchingParts.length > 1 && matchingParts.length < 88);
  assert.ok(matchingParts.includes('R1'));
  await partsSearch.press('Enter');
  assert.equal(await partsList.isVisible(), true, 'Ambiguous searches never locate the first row.');
  await page.screenshot({ path: 'test-results/emc-editing-workflow/parts-search.png' });
  await partsList.getByRole('button', { name: 'Locate R1', exact: true }).click();
  await page.waitForFunction(() => {
    const drawing = document.querySelector('[data-testid="schematic-canvas"]');
    const node = drawing?.querySelector('[data-testid="part-R1"]');
    if (!drawing || !node || document.activeElement !== drawing) return false;
    const area = drawing.getBoundingClientRect(),
      body = node.getBoundingClientRect();
    return (
      body.left >= area.left &&
      body.right <= area.right &&
      body.top >= area.top &&
      body.bottom <= area.bottom
    );
  });
  assert.equal(await visibleResistor(), true, 'Locate reveals the real EMC component.');
  assert.deepEqual(await native(), original, 'Locating EMC content never edits native files.');
  await clean();
  await button('Schematic').click();
  await button('List').click();
  assert.equal(await partsSearch.inputValue(), '', 'Reopening starts with all current components.');
  await partsSearch.fill('R1');
  await partsList.getByRole('button', { name: 'Edit R1', exact: true }).click();
  const properties = page.getByRole('complementary', { name: 'Object properties', exact: true });
  const value = properties.getByRole('textbox', { name: 'Component value', exact: true });
  const resistorValue = await value.inputValue();
  const nextValue = resistorValue === '100k' ? '110k' : '100k';
  await value.fill(nextValue);
  await value.press('Enter');
  let current = await nativeProject();
  assert.equal(current.schematic.parts.find((part) => part.ref === 'R1').value, nextValue);
  assert.deepEqual(current.pcb.tracks, baseline.pcb.tracks);
  await button('Layout').click();
  await page.getByTestId('layout-canvas').waitFor();
  await button('Model').click();
  await page.waitForFunction(
    () =>
      document.querySelector('.pcb-model-canvas canvas') &&
      !document.querySelector('.pcb-model-status'),
    null,
    { timeout: 90000 },
  );
  await page.screenshot({ path: 'test-results/emc-editing-workflow/model.png' });
  await button('Layout').click();
  await button('Undo').click();
  assert.deepEqual(
    await native(),
    original,
    'A cross-view schematic undo restores every original native file.',
  );
  await clean();
  console.log(
    'EMC workflow: component edit, Layout/Model navigation and cross-view undo retain all native files.',
  );

  // Exercise electrical geometry on the actual dense sheet. Include the short
  // LEDP lead collapsing into its moving endpoint, where pin-only checks miss
  // a stranded net label. Read the rendered wire identities before committing.
  for (const move of [
    { key: 'ArrowRight', x: 167.64, y: 74.93 },
    { key: 'ArrowDown', x: 165.1, y: 77.47 },
  ]) {
    await button('Schematic').click();
    await button('List').click();
    await partsSearch.fill('R1');
    await partsList.getByRole('button', { name: 'Locate R1', exact: true }).click();
    await page.waitForFunction(
      () => document.activeElement === document.querySelector('[data-testid="schematic-canvas"]'),
    );
    await resistor.hover();
    await page.keyboard.press('g');
    await page.keyboard.press(move.key);
    await page.keyboard.press(move.key);
    assert.equal(await schematic.getAttribute('data-move-preview'), 'drag');
    const previewPosition = await resistor.evaluate((node) => {
      const matrix = node
        .querySelector(':scope > g[transform]')
        .transform.baseVal.consolidate().matrix;
      return { x: matrix.e, y: matrix.f };
    });
    assert.ok(
      Math.abs(previewPosition.x - move.x) < 1e-4 && Math.abs(previewPosition.y - move.y) < 1e-4,
    );
    const previewWires = await schematic
      .locator('g[data-selection-id] > line[data-export-exclude]')
      .evaluateAll((lines) =>
        lines
          .map((line) => ({
            id: line.parentElement.dataset.selectionId,
            a: { x: Number(line.getAttribute('x1')), y: Number(line.getAttribute('y1')) },
            b: { x: Number(line.getAttribute('x2')), y: Number(line.getAttribute('y2')) },
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      );
    assert.ok(previewWires.length > 0);
    assert.equal(
      await button('Undo').isDisabled(),
      true,
      'The connected drag remains an uncommitted preview.',
    );
    await clean();
    await page.keyboard.press('Enter');
    assert.equal(await schematic.getAttribute('data-move-preview'), null);
    current = await nativeProject();
    const movedPart = current.schematic.parts.find((part) => part.ref === 'R1');
    assert.equal(movedPart.x, move.x);
    assert.equal(movedPart.y, move.y);
    assert.deepEqual(
      electricalTopology(current.schematic),
      electricalTopology(baseline.schematic),
      'Connected dragging preserves every pin and net-label association.',
    );
    assert.deepEqual(
      current.schematic.wires
        .map(({ id, a, b }) => ({ id, a, b }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      previewWires,
      'Native wires retain the exact rendered preview, including generated UUIDs.',
    );
    assert.deepEqual(current.pcb, baseline.pcb);
    const draggedFiles = await readNativeFiles(page);
    for (const file of original.files.filter((file) => !file.name.endsWith('.kicad_sch')))
      assert.deepEqual(
        draggedFiles.files.find((item) => item.name === file.name),
        file,
        'Schematic pose edits retain other native file bytes.',
      );
    await button('Model').click();
    await button('Layout').click();
    await button('Undo').click();
    assert.equal(
      await button('Undo').isDisabled(),
      true,
      'One cross-view undo restores the complete connected drag.',
    );
    assert.deepEqual(await native(), original);
    await clean();
  }
  console.log(
    'EMC workflow: connected drag previews commit exact wires and retain all pin/label nets, including a collapsed lead; cross-view undo restores native bytes.',
  );

  // Inspect existing copper beneath the source enclosure footprint; lock-only
  // Properties changes keep tracks/fills and Source intact and undo once.
  await button('Layout').click();
  const layout = page.getByTestId('layout-canvas');
  const track = baseline.pcb.tracks.find(
    (item) =>
      !item.locked &&
      Math.hypot(item.start.x - 64.8625, item.start.y - 53.8) < 0.00001 &&
      Math.hypot(item.end.x - 61, item.end.y - 57.6625) < 0.00001,
  );
  assert.ok(track, 'The pinned EMC copper fixture remains present.');
  const location = await layout.evaluate((svg, item) => {
    const point = new DOMPoint(
      (item.start.x + item.end.x) / 2,
      (item.start.y + item.end.y) / 2,
    ).matrixTransform(svg.getScreenCTM());
    return { x: point.x, y: point.y };
  }, track);
  await page.mouse.click(location.x, location.y);
  const locked = page
    .getByRole('complementary', { name: 'Layout properties', exact: true })
    .getByRole('checkbox', { name: 'Locked', exact: true });
  await locked.check();
  current = await nativeProject();
  assert.equal(current.pcb.tracks.find((item) => item.id === track.id).locked, true);
  assert.deepEqual(
    current.pcb.zones,
    baseline.pcb.zones,
    'Locking retains saved copper fill geometry.',
  );
  assert.deepEqual(current.schematic, baseline.schematic);
  await button('Model').click();
  await button('Undo').click();
  assert.deepEqual(
    await native(),
    original,
    'Model Undo restores a Layout edit without normalizing native files.',
  );
  await clean();
  console.log(
    'EMC workflow: exact copper picking, track Properties and cross-view undo retain source fills and schematic.',
  );

  await button('Layout').click();
  await page.mouse.move(location.x, location.y);
  await layout.focus();
  await page.keyboard.press('x');
  const routePreview = layout.locator('[data-route-preview]');
  await routePreview.waitFor({ state: 'attached' });
  await page.keyboard.press('v');
  await layout.locator('[data-route-via-preview]').waitFor();
  await button('Model').click();
  await routePreview.waitFor({ state: 'detached' });
  await button('Layout').click();
  await layout.focus();
  await page.keyboard.press('Enter');
  assert.equal(await layout.locator('[data-route-preview], [data-route-via-preview]').count(), 0);
  assert.deepEqual(
    await native(),
    original,
    'EMC navigation cancels routing and its pending via without partial copper.',
  );
  await clean();
  console.log(
    'EMC workflow: routing starts on actual copper and view navigation cancels its entire pending via transaction.',
  );

  // Commit a real PGND detour between exact existing track endpoints, then undo
  // from Model. The locked source copper is an anchor and remains unchanged.
  {
    const pgndStart = baseline.pcb.tracks.find(
      (item) => item.id === '33cdc88b-d74e-4100-8239-7380156abb0b',
    );
    const pgndEnd = baseline.pcb.tracks.find(
      (item) => item.id === '21ecff59-f796-4cb9-8e5d-1f813b755424',
    );
    assert.ok(pgndStart && pgndEnd, 'The pinned PGND endpoint tracks remain present.');
    assert.deepEqual(pgndStart.start, { x: 77.78, y: 119 });
    assert.deepEqual(pgndEnd.start, { x: 81.7638, y: 124.0353 });
    assert.equal(pgndStart.locked, true);
    assert.equal(pgndStart.netId, pgndEnd.netId);
    assert.equal(baseline.pcb.nets.find((item) => item.id === pgndStart.netId).name, 'PGND');
    await button('Layout').click();
    const pgndScreen = (point) =>
      layout.evaluate((svg, at) => {
        const screen = new DOMPoint(at.x, at.y).matrixTransform(svg.getScreenCTM());
        return {
          x: screen.x,
          y: screen.y,
          onCanvas: svg.contains(document.elementFromPoint(screen.x, screen.y)),
        };
      }, point);
    const pgndPickup = await pgndScreen(pgndStart.start);
    assert.equal(pgndPickup.onCanvas, true, 'The route pickup is outside floating controls.');
    await page.mouse.move(pgndPickup.x, pgndPickup.y);
    await layout.focus();
    await page.keyboard.press('x');
    const pgndPreview = layout.locator('[data-route-preview]');
    await pgndPreview.waitFor({ state: 'attached' });
    const pgndSettings = page.getByRole('complementary', { name: 'Routing settings', exact: true });
    assert.deepEqual(
      await pgndSettings
        .getByRole('spinbutton')
        .evaluateAll((fields) => fields.map((field) => field.getAttribute('aria-label'))),
      ['Track width (mm)', 'Via diameter (mm)', 'Via drill (mm)'],
    );
    assert.equal(await pgndSettings.getByRole('combobox').count(), 0);
    assert.equal(
      await pgndSettings.getByRole('spinbutton', { name: 'Track width (mm)' }).inputValue(),
      '0.4',
    );
    const pgndDestination = await pgndScreen(pgndEnd.start);
    assert.equal(
      pgndDestination.onCanvas,
      true,
      'The route destination is outside floating controls.',
    );
    await page.mouse.move(pgndDestination.x, pgndDestination.y);
    await page.waitForFunction(
      (end) =>
        document
          .querySelector('[data-testid="layout-canvas"] [data-route-preview]')
          ?.getAttribute('points')
          ?.trim()
          .split(/\s+/)
          .at(-1) === `${end.x},${end.y}`,
      pgndEnd.start,
    );
    const pgndPoints = (await pgndPreview.getAttribute('points'))
      .trim()
      .split(/\s+/)
      .map((point) => {
        const [x, y] = point.split(',').map(Number);
        return { x, y };
      });
    assert.equal(pgndPoints.length, 6, 'The real copper requires a five-segment detour.');
    assert.deepEqual(pgndPoints[0], pgndStart.start);
    assert.deepEqual(pgndPoints.at(-1), pgndEnd.start);
    assert.ok(pgndPoints.some((point) => point.x > pgndEnd.start.x + 0.5));
    assert.equal(await pgndPreview.getAttribute('data-route-blocked'), 'false');
    assert.equal(await layout.evaluate((svg) => document.activeElement === svg), true);
    await page.keyboard.press('Enter');
    await pgndPreview.waitFor({ state: 'detached' });

    const pgndNative = await native();
    const pgndProject = await readNativeProject(page);
    const pgndOriginalIds = new Set(baseline.pcb.tracks.map((item) => item.id));
    const pgndAdded = pgndProject.pcb.tracks.filter((item) => !pgndOriginalIds.has(item.id));
    assert.equal(pgndProject.pcb.tracks.length, 364);
    assert.equal(pgndAdded.length, 5);
    assert.equal(new Set(pgndProject.pcb.tracks.map((item) => item.id)).size, 364);
    assert.deepEqual(
      pgndProject.pcb.tracks.filter((item) => pgndOriginalIds.has(item.id)),
      baseline.pcb.tracks,
      'The route retains every original track, including its lock metadata.',
    );
    assert.deepEqual(
      pgndAdded.map(({ start, end, width, layer, netId }) => ({ start, end, width, layer, netId })),
      pgndPoints.slice(1).map((end, index) => ({
        start: pgndPoints[index],
        end,
        width: 0.4,
        layer: 'F.Cu',
        netId: pgndStart.netId,
      })),
      'Source contains exactly the displayed route after one Enter.',
    );
    const pgndRules = (zones) =>
      zones.map((zone) => {
        const rule = { ...zone };
        delete rule.filledPolygons;
        return rule;
      });
    // Match the PCB writer's 12-decimal precision when native local pad offsets
    // are reconstructed from board poses (0.4374999999999998 becomes 0.4375).
    const pgndNativePrecision = (value) =>
      JSON.parse(
        JSON.stringify(value, (_key, item) =>
          typeof item === 'number' ? Number(item.toFixed(12)) : item,
        ),
      );
    assert.ok(baseline.pcb.zones.some((zone) => zone.filledPolygons !== undefined));
    assert.equal(
      pgndProject.pcb.zones.some((zone) => zone.filledPolygons !== undefined),
      false,
    );
    assert.deepEqual(
      pgndNativePrecision({
        ...pgndProject.pcb,
        tracks: baseline.pcb.tracks,
        zones: pgndRules(pgndProject.pcb.zones),
      }),
      pgndNativePrecision({ ...baseline.pcb, zones: pgndRules(baseline.pcb.zones) }),
      'Only appended tracks and invalidated fills change the PCB; zone rules and other objects stay intact.',
    );
    const pgndMetadata = (project) => {
      const metadata = { ...project };
      delete metadata.pcb;
      delete metadata.nativeFiles;
      return metadata;
    };
    assert.deepEqual(pgndMetadata(pgndProject), pgndMetadata(baseline));
    const pgndPCBFile = original.files.find((file) => file.name.endsWith('.kicad_pcb'));
    assert.ok(pgndPCBFile);
    const pgndPCBSource = pgndNative.files.find((file) => file.name === pgndPCBFile.name).source;
    assert.notEqual(pgndPCBSource, pgndPCBFile.source);
    assert.deepEqual(pgndNative, {
      ...original,
      files: original.files.map((file) =>
        file.name === pgndPCBFile.name ? { ...file, source: pgndPCBSource } : file,
      ),
    });
    assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 1);
    await button('Model').click();
    await button('Undo').click();
    assert.deepEqual(
      await native(),
      original,
      'One Model Undo restores every pre-route native byte.',
    );
    await clean();
    console.log(
      'EMC workflow: exact PGND endpoint routing commits its live detour once and Model Undo restores all native files.',
    );
  }

  // Edit the existing generic cover through native Source, then build a drilled
  // plate using the Model UI. Both paths share Core and the STEP adapter.
  const originalAssembly = modelCadFromProject(baseline);
  assert.equal(originalAssembly.objects.length, 4);
  const originalCover = originalAssembly.objects.find((object) => object.material === 'pmma');
  assert.ok(originalCover, 'The pinned EMC project includes its editable generic CAD cover.');
  await button('Source').click();
  await selectSourceFile(page, original.entry);
  const coverSettings = JSON.parse(await readSource(page));
  const coverCad = JSON.parse(coverSettings.text_variables[MODEL_CAD_NATIVE_VARIABLE]);
  coverCad.objects.find((object) => object.id === originalCover.id).size.z += 1;
  coverSettings.text_variables[MODEL_CAD_NATIVE_VARIABLE] = JSON.stringify(coverCad);
  await fillSource(page, JSON.stringify(coverSettings, null, 2) + '\n');
  await page
    .getByRole('region', { name: 'Project source', exact: true })
    .getByRole('button', { name: 'Apply', exact: true })
    .click();
  current = await nativeProject();
  assert.equal(
    modelCadFromProject(current).objects.find((object) => object.id === originalCover.id).size.z,
    originalCover.size.z + 1,
  );
  assert.deepEqual(current.pcb, baseline.pcb);
  await button('Model').click();
  await button('Place box').click();
  const box = page.getByRole('complementary', { name: 'Box settings', exact: true });
  await box.getByLabel('Solid name', { exact: true }).fill('EMC end plate');
  await box.getByLabel('Length (mm)', { exact: true }).fill('24');
  await box.getByLabel('Width (mm)', { exact: true }).fill('18');
  await box.getByLabel('Height (mm)', { exact: true }).fill('4');
  const modelCanvas = page.locator('.pcb-model-canvas');
  await modelCanvas.focus();
  await page.keyboard.press('r');
  await page.keyboard.press('Enter');
  await box.waitFor({ state: 'hidden' });
  current = await nativeProject();
  const solids = modelCadFromProject(current).objects;
  const plate = solids.find((object) => object.name === 'EMC end plate');
  assert.equal(solids.length, originalAssembly.objects.length + 1);
  assert.ok(plate);
  assert.deepEqual(plate.size, { x: 24, y: 18, z: 4 });
  assert.equal(plate.rotation.z, 90);
  assert.deepEqual(current.pcb, baseline.pcb);
  const plateFiles = await readNativeFiles(page);
  await button('Model').click();
  const plateProperties = page.getByRole('complementary', {
    name: 'Solid properties settings',
    exact: true,
  });
  await plateProperties.getByLabel('Length (mm)', { exact: true }).fill('26');
  assert.equal(
    await button('Drill through hole').count(),
    0,
    'The dedicated drilling tool is absent.',
  );
  assert.equal(
    await page.getByRole('complementary', { name: 'Hole settings', exact: true }).count(),
    0,
  );
  assert.deepEqual(await native(), plateFiles, 'A local plate draft preserve every native file.');
  await button('Model').click();
  assert.equal(await plateProperties.getByLabel('Length (mm)', { exact: true }).inputValue(), '26');
  assert.equal(await button('Drill through hole').count(), 0);

  // Apply a real native CAD change while Model retains a different local draft.
  // The accepted Source revision must invalidate, rather than replace, that draft.
  await button('Source').click();
  assert.match(plateFiles.entry, /\.kicad_pro$/);
  await selectSourceFile(page, plateFiles.entry);
  const acceptedPlateSettings = await readSource(page);
  assert.equal(
    acceptedPlateSettings,
    plateFiles.files.find((file) => file.name === plateFiles.entry).source,
  );
  const settings = JSON.parse(acceptedPlateSettings);
  const sourceCad = JSON.parse(settings.text_variables[MODEL_CAD_NATIVE_VARIABLE]);
  const sourcePlate = sourceCad.objects.find((object) => object.id === plate.id);
  assert.ok(sourcePlate, 'The selected EMC plate is stored in the actual native project file.');
  assert.equal(sourcePlate.size.x, 24);
  sourcePlate.size.x = 25;
  settings.text_variables[MODEL_CAD_NATIVE_VARIABLE] = JSON.stringify(sourceCad);
  const editedPlateSettings = JSON.stringify(settings, null, 2) + '\n';
  await fillSource(page, editedPlateSettings);
  assert.equal(await readSource(page), editedPlateSettings);
  const sourceApply = page
    .getByRole('region', { name: 'Project source', exact: true })
    .getByRole('button', { name: 'Apply', exact: true });
  await sourceApply.click();
  assert.equal(await sourceApply.isDisabled(), true);
  const sourceEditedPlateFiles = await readNativeFiles(page);
  assert.deepEqual(sourceEditedPlateFiles, {
    ...plateFiles,
    files: plateFiles.files.map((file) =>
      file.name === plateFiles.entry ? { ...file, source: editedPlateSettings } : file,
    ),
  });
  assert.equal(
    modelCadFromProject(await readNativeProject(page)).objects.find(
      (object) => object.id === plate.id,
    ).size.x,
    25,
    'Source Apply accepts the persisted plate change independently of the local draft.',
  );
  await button('Model').click();
  await plateProperties.getByRole('alert').filter({ hasText: 'project changed' }).waitFor();
  assert.equal(await plateProperties.getByLabel('Length (mm)', { exact: true }).inputValue(), '26');
  assert.equal(
    await plateProperties.getByLabel('Solid name', { exact: true }).inputValue(),
    plate.name,
  );
  assert.equal(
    await plateProperties.getByRole('button', { name: 'Apply', exact: true }).isDisabled(),
    true,
    'A retained EMC Properties draft cannot overwrite the newer Source revision.',
  );
  assert.equal(await button('Drill through hole').count(), 0);
  await plateProperties
    .getByRole('button', { name: 'Reload solid parameters', exact: true })
    .click();
  assert.equal(await plateProperties.getByLabel('Length (mm)', { exact: true }).inputValue(), '25');
  assert.equal(
    await button('Drill through hole').count(),
    0,
    'Reloading the accepted plate does not add a drilling tool.',
  );

  await button('Layout').click();
  await button('Undo').click();
  assert.deepEqual(
    await native(),
    plateFiles,
    'One cross-view Undo restores every native byte before the Source CAD edit.',
  );
  await button('Model').click();
  assert.equal(await plateProperties.getByLabel('Length (mm)', { exact: true }).inputValue(), '24');
  assert.equal(
    await plateProperties.getByLabel('Solid name', { exact: true }).inputValue(),
    plate.name,
  );
  await button('Layout').click();
  await button('Redo').click();
  assert.deepEqual(await native(), sourceEditedPlateFiles);
  await button('Model').click();
  assert.equal(await plateProperties.getByLabel('Length (mm)', { exact: true }).inputValue(), '25');
  await button('Layout').click();
  await button('Undo').click();
  assert.deepEqual(await native(), plateFiles);
  await button('Model').click();
  assert.equal(await plateProperties.getByLabel('Length (mm)', { exact: true }).inputValue(), '24');
  console.log(
    'EMC workflow: Model readiness after Source history',
    await page.evaluate(() => {
      const preview = [...document.querySelectorAll('[aria-label="3D board preview"]')].find(
        (node) => node.getClientRects().length,
      );
      const inspector = preview?.querySelector('[aria-label="Solid properties settings"]');
      const length = inspector?.querySelector('[aria-label="Length (mm)"]');
      return {
        visible: Boolean(preview),
        status: [...(preview?.querySelectorAll('.pcb-model-status') ?? [])].map(
          (node) => node.textContent,
        ),
        retry: [...(preview?.querySelectorAll('button') ?? [])].some(
          (node) => node.textContent === 'Retry 3D preview',
        ),
        disabled: Object.fromEntries(
          ['Place box', 'Create sketch'].map((name) => [
            name,
            preview?.querySelector(`button[aria-label="${name}"]`)?.disabled ?? null,
          ]),
        ),
        tool: preview?.querySelector('.pcb-model-canvas')?.dataset.cadTool,
        annotationPressed: preview
          ?.querySelector('[aria-label="Annotation mode"]')
          ?.getAttribute('aria-pressed'),
        unapplied: inspector?.querySelector('header')?.textContent.includes('Unapplied') ?? false,
        alerts: [...(inspector?.querySelectorAll('[role="alert"]') ?? [])].map(
          (node) => node.textContent,
        ),
        length: length?.value,
        lengthDisabled: length?.disabled,
        reloadDisabled: inspector?.querySelector('[aria-label="Reload solid parameters"]')
          ?.disabled,
        applyDisabled: inspector?.querySelector('button[type="submit"]')?.disabled,
      };
    }),
  );
  await page.waitForFunction(() => {
    const preview = [...document.querySelectorAll('[aria-label="3D board preview"]')].find(
      (node) => node.getClientRects().length,
    );
    const canvas = preview?.querySelector('.pcb-model-canvas canvas');
    return canvas?.width > 0 && !preview?.querySelector('.pcb-model-status');
  });
  assert.equal(await button('Drill through hole').count(), 0);
  // The following standoff commit clears only this undone Source edit's redo;
  // the cover edit, plate and standoff construction still undo in three steps.
  await button('Place cylinder').click();
  const cylinder = page.getByRole('complementary', { name: 'Cylinder settings', exact: true });
  const mountingHole = baseline.pcb.footprints.flatMap((footprint) =>
    footprint.pads
      .filter((pad) => pad.type === 'np_thru_hole' && pad.drill)
      .map((pad) => ({ position: padDrillPosition(footprint, pad), drill: pad.drill })),
  )[0];
  assert.ok(mountingHole, 'The real PCB supplies a non-plated mounting-hole location.');
  await cylinder.getByLabel('Solid name', { exact: true }).fill('EMC mounting standoff');
  await cylinder.getByLabel('Diameter (mm)', { exact: true }).fill('6');
  await cylinder.getByLabel('Height (mm)', { exact: true }).fill('12');
  await cylinder
    .getByLabel('Solid X position (mm)', { exact: true })
    .fill(String(mountingHole.position.x));
  await cylinder
    .getByLabel('Solid Y position (mm)', { exact: true })
    .fill(String(mountingHole.position.y));
  await cylinder
    .getByLabel('Solid Z position (mm)', { exact: true })
    .fill(String(-baseline.pcb.thickness / 2 - 6));
  await modelCanvas.focus();
  await page.keyboard.press('Enter');
  await cylinder.waitFor({ state: 'hidden' });
  current = await nativeProject();
  const standoff = modelCadFromProject(current).objects.find(
    (object) => object.name === 'EMC mounting standoff',
  );
  assert.equal(standoff.kind, 'cylinder');
  assert.deepEqual(standoff.size, { x: 6, y: 6, z: 12 });
  assert.deepEqual(standoff.position, {
    ...mountingHole.position,
    z: -baseline.pcb.thickness / 2 - 6,
  });
  assert.deepEqual(current.pcb, baseline.pcb);
  const mechanicalFiles = await readNativeFiles(page);
  await button('Model').click();
  assert.equal(
    await button('Export model STEP').count(),
    0,
    'Model has no STEP export toolbar action.',
  );
  assert.equal(
    await page.evaluate(
      () =>
        window.workflowCapabilityHost.catalog().find((item) => item.id === 'enclosure.exportStep')
          ?.available,
    ),
    true,
  );
  await page.evaluate(() =>
    window.workflowCapabilityHost.execute('enclosure.exportStep', {}, { actor: 'human' }),
  );
  await page.waitForFunction(() => window.workflowExports.length === 1);
  const exported = parseProject(await page.evaluate(() => window.workflowExports[0].source));
  assert.deepEqual(modelCadFromProject(exported), modelCadFromProject(current));
  await button('Undo').click();
  current = await nativeProject();
  assert.equal(
    modelCadFromProject(current).objects.length,
    solids.length,
    'One undo removes the complete standoff and its drilled feature.',
  );
  assert.deepEqual(modelCadFromProject(current).objects, solids);
  await button('Layout').click();
  await button('Undo').click();
  current = await nativeProject();
  assert.equal(
    modelCadFromProject(current)?.objects.length ?? 0,
    originalAssembly.objects.length,
    'The next undo removes the plate.',
  );
  await button('Layout').click();
  await button('Undo').click();
  assert.deepEqual(
    await native(),
    original,
    'Three independent CAD undo transactions recover every original native byte.',
  );
  await clean();
  // Redo the three independent construction edits, save through the real native
  // writer/asset preparation and open the disk files in a fresh workspace.
  await button('Model').click();
  await button('Redo').click();
  await button('Redo').click();
  await button('Redo').click();
  assert.deepEqual(await native(), mechanicalFiles);
  await button('Model').click();
  await modelCanvas.focus();
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => !document.querySelector('.project-navigation .dirty-dot'));
  assert.equal(saves, 1, 'One Save writes the complete native project.');
  const saved = await native();
  const byName = (bundle) => ({
    ...bundle,
    files: [...bundle.files].sort((a, b) => a.name.localeCompare(b.name)),
  });
  assert.deepEqual(byName(await readNativeProjectFile(nativeFile)), byName(saved));
  const diskProject = projectFromNativeFiles(await readNativeProjectFile(nativeFile));
  assert.deepEqual(modelCadFromProject(diskProject), modelCadFromProject(exported));
  ignoreRecoveryWrites = true;
  recovery = null;
  await mount();
  await button('Open project').click();
  await schematic.waitFor();
  assert.deepEqual(
    byName(await native()),
    byName(saved),
    'Reopening from disk retains native data without recovery.',
  );
  await button('Model').click();
  await page.waitForFunction(
    () =>
      document.querySelector('.pcb-model-canvas canvas') &&
      !document.querySelector('.pcb-model-status'),
    null,
    { timeout: 90000 },
  );
  await clean();
  console.log(
    'EMC workflow: real native Save, pinned asset preparation, STEP export and fresh disk reopen retain the complete assembly.',
  );
  assert.ok(
    requests.length > 0 && modelRequests.size > 0,
    'The full EMC Model uses real pinned offline component resources.',
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      workflow: 'EMC Flyback',
      symbols: baseline.schematic.parts.length,
      footprints: baseline.pcb.footprints.length,
      tracks: baseline.pcb.tracks.length,
      offlineModels: modelRequests.size,
      covered: [
        'component Properties',
        'dense copper picking',
        'track lock Properties',
        'three-view navigation',
        'enclosure',
        'dimensioned drilled plate',
        'mounting-hole-aligned standoff',
        'rotation preview',
        'native Save/reopen',
        'STEP export',
        'native Source',
        'whole-project undo',
        'clean baseline',
      ],
    }),
  );
} finally {
  try {
    await browser?.close();
  } finally {
    libraries.close();
    globalThis.fetch = originalFetch;
  }
}
