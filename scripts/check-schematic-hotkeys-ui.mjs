import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { bundledWorkbenchCatalog } from '../server/workbench-plugins.mjs';
import { readNativeFiles, readNativeProject } from './source-editor-test-helpers.mjs';
import { openSchematicPanel } from './schematic-visualization-test-helpers.mjs';
import { closeDisplayDrawer } from './visualization-test-helpers.mjs';

const { emptyCircuit, createPart, pinPositions, serializeCircuit, snap, uid } = await tsImport(
  '../lib/circuit.ts',
  import.meta.url,
);
const { createProject, serializeProject, parseProject } = await tsImport(
  '../lib/project.ts',
  import.meta.url,
);
const { partFields } = await tsImport('../lib/library.ts', import.meta.url);
const { projectNativeFiles } = await tsImport('../lib/kicad-project.ts', import.meta.url);
const { fieldId, objectPosition } = await tsImport('../lib/schematic-edit.ts', import.meta.url);
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const { defaultAppearance } = await tsImport('../lib/appearance.ts', import.meta.url);
const { child, children, parseSExpr, val } = await tsImport('../lib/sexpr.ts', import.meta.url);

// Full DesktopWorkspace, with in-memory recovery/native/API fixtures only.
// No Electron, real service, Agent, library download, solver or user file is opened.
const seed = emptyCircuit();
seed.title = 'Hotkey regression';
seed.parts.push(createPart(seed, 'R', 25.4, 25.4));
seed.parts.push(createPart(seed, 'R', 76.2, 25.4));
seed.parts[0].fields = { ...seed.parts[0].fields, Footprint: 'Fixture:R', 'Sim.Params': 'temp=25' };
const [leftPin, rightPin] = seed.parts.map(
  (part) => pinPositions(part, seed.libraries[part.libId])[1],
);
seed.wires = [
  { id: uid(), a: leftPin, b: { x: leftPin.x, y: 45.72 } },
  { id: uid(), a: { x: leftPin.x, y: 45.72 }, b: { x: rightPin.x, y: 45.72 } },
  { id: uid(), a: { x: rightPin.x, y: 45.72 }, b: rightPin },
];
seed.labels = [
  { id: uid(), x: 50.8, y: 45.72, text: 'SIGNAL' },
  { id: uid(), x: 15.24, y: 60.96, text: 'TEST' },
];
seed.noConnects = seed.parts.map((part) => ({
  id: uid(),
  ...pinPositions(part, seed.libraries[part.libId])[0],
}));
const noteId = uid();
const note = [
  'text',
  '"Editable note"',
  ['at', '85.09', '66.04', '0'],
  ['effects', ['font', ['size', '1.27', '1.27']]],
  ['uuid', JSON.stringify(noteId)],
];
const native = parseSExpr(serializeCircuit(seed));
for (const [index, part] of seed.parts.entries()) {
  part.raw = children(native, 'symbol').find((symbol) => val(child(symbol, 'uuid')) === part.id);
  for (const name of ['Reference', 'Value', ...(index ? [] : ['Sim.Params'])]) {
    const property = children(part.raw, 'property').find((item) => val(item) === name);
    const at = child(property, 'at');
    at[1] = String(index ? 85.09 : 40.64);
    at[2] = name === 'Reference' ? '11.43' : name === 'Value' ? '17.78' : '24.13';
    if (name === 'Sim.Params') {
      for (const node of [property, child(property, 'effects')])
        if (node)
          for (let i = node.length - 1; i > 0; i--)
            if (node[i] === 'hide' || (Array.isArray(node[i]) && node[i][0] === 'hide'))
              node.splice(i, 1);
    }
  }
}
seed.original = [...parseSExpr(serializeCircuit(seed)), note];
const fixture = createProject(seed);
fixture.extensions = { 'fixture:hotkeys': { retained: true, numbers: [1, 2, 3] } };
fixture.pcb = createEmptyPCB();
const copperNetId = uid();
const signalNetId = uid();
fixture.pcb.nets = [
  { id: copperNetId, name: 'RETAINED' },
  { id: signalNetId, name: 'SIGNAL' },
];
fixture.pcb.footprints = [
  {
    id: uid(),
    symbolId: seed.parts[0].id,
    libraryId: 'Fixture:R',
    x: 10,
    y: 10,
    rotation: 0,
    side: 'front',
    graphics: [],
    pads: ['1', '2'].map((number, i) => ({
      id: uid(),
      number,
      x: i * 2.54,
      y: 0,
      rotation: 0,
      type: 'smd',
      shape: 'rect',
      size: { x: 1, y: 1 },
      netId: number === '2' ? signalNetId : null,
    })),
  },
];
fixture.pcb.tracks = [
  {
    id: uid(),
    start: { x: 10, y: 15 },
    end: { x: 20, y: 15 },
    width: 0.4,
    layer: 'F.Cu',
    netId: copperNetId,
  },
];
const source = serializeProject(fixture);
const baseline = parseProject(source);
const doc = baseline.schematic;
const [first, second] = doc.parts;
const documentId = uid();
const recovery = () => ({
  version: 2,
  documents: [
    {
      id: documentId,
      source,
      sourceDraft: null,
      dirty: false,
      filename: null,
      sessions: [{ id: 'hotkey-session', messages: [], draft: '' }],
      activeSessionId: 'hotkey-session',
    },
  ],
  activeDocumentId: documentId,
  provider: 'codex',
  effort: 'low',
  approvalMode: 'review',
  models: {},
});
const bundle = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';
    import Workspace from './components/DesktopWorkspace';
    createRoot(document.getElementById('root')).render(<Workspace/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outdir: 'test-results/schematic-hotkeys-ui-bundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [
    {
      name: 'inspect-schematic-properties-core',
      setup(plugin) {
        plugin.onLoad({ filter: /[\\/]components[\\/]Workbench\.tsx$/ }, async ({ path }) => {
          const contents = await readFile(path, 'utf8');
          const anchor = 'const { project, sourceDraft, sourceError } = coreSnapshot;';
          assert.ok(
            contents.includes(anchor),
            'The Properties fixture captures the real Workbench Core.',
          );
          return {
            contents: contents.replace(anchor, anchor + ' window.schematicHotkeysCore = core;'),
            loader: 'tsx',
          };
        });
      },
    },
  ],
});
const styles = await Promise.all(
  ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'].map((file) =>
    readFile(file, 'utf8'),
  ),
);
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
const hasEndpoint = (circuit, p) =>
  circuit.wires.some((wire) =>
    [wire.a, wire.b].some((at) => Math.hypot(at.x - p.x, at.y - p.y) < 1e-6),
  );
// An optional case-name expression keeps a focused investigation isolated.
const casePattern = process.argv[2] ? new RegExp(process.argv[2]) : null;
let completed = 0;

async function run(name, check, appearance = null) {
  if (casePattern && !casePattern.test(name)) return;
  const page = await browser.newPage({ viewport: { width: 1600, height: 1040 } });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let state = recovery();
  await page.addInitScript(() => {
    window.dirtyWrites = [];
    window.recoveryWrites = [];
    window.hotkeySaveRequests = [];
    const realFetch = window.fetch;
    window.fetch = (input, options) => {
      if (String(input).includes('/api/state') && options?.method === 'POST')
        window.recoveryWrites.push(JSON.parse(options.body));
      return realFetch(input, options);
    };
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
      setDirty: async (value) => {
        window.dirtyWrites.push(Boolean(value));
      },
      onCloseRequested: () => () => {},
      save: async (request) => {
        window.hotkeySaveRequests.push(request);
        return { name: request.name };
      },
    };
  });
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/state') {
      if (route.request().method() === 'POST') state = route.request().postDataJSON();
      return route.fulfill({ json: state });
    }
    if (url.pathname === '/api/agent-settings')
      return route.fulfill({ json: { followUpMode: 'queue' } });
    if (url.pathname === '/api/appearance') {
      if (route.request().method() === 'POST') appearance = route.request().postDataJSON();
      return route.fulfill({ json: appearance });
    }
    if (url.pathname === '/api/agents') return route.fulfill({ json: [] });
    if (url.pathname === '/api/models')
      return route.fulfill({ json: { models: [], defaultModel: '' } });
    if (url.pathname === '/api/workbench-plugins')
      return route.fulfill({ json: bundledWorkbenchCatalog() });
    if (url.pathname === '/api/simulation/status')
      return route.fulfill({ json: { available: true, version: 'fixture only' } });
    if (url.pathname === '/api/simulation/result') return route.fulfill({ json: { result: null } });
    if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(url.pathname))
      return route.fulfill({
        contentType: url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        body: await readFile('public' + url.pathname),
      });
    if (url.pathname.startsWith('/api/')) throw new Error(`Unexpected API call: ${url.pathname}`);
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  for (const content of styles) await page.addStyleTag({ content });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const button = (label) => page.getByRole('button', { name: label, exact: true });
  const canvas = page.getByTestId('schematic-canvas');
  await canvas.waitFor();
  try {
    await page.waitForFunction(
      () => document.querySelector('[data-testid="schematic-canvas"]')?.viewBox.baseVal.x !== 0,
    );
  } catch (error) {
    const diagnostic = await page
      .evaluate(() => {
        const svg = document.querySelector('[data-testid="schematic-canvas"]');
        const rect = svg?.getBoundingClientRect();
        const view = svg?.viewBox.baseVal;
        const style = svg ? getComputedStyle(svg) : null;
        let matrix = null;
        let matrixError = null;
        try {
          const current = svg?.getCTM();
          if (current)
            matrix = Object.fromEntries(
              ['a', 'b', 'c', 'd', 'e', 'f'].map((key) => [key, current[key]]),
            );
        } catch (failure) {
          matrixError = String(failure);
        }
        const snapshot = window.schematicHotkeysCore?.getSnapshot();
        const schematic = snapshot?.project?.schematic;
        const firstPart = schematic?.parts[0];
        return {
          readyState: document.readyState,
          pageVisibility: document.visibilityState,
          fonts: document.fonts.status,
          rawViewBox: svg?.getAttribute('viewBox') ?? null,
          viewBox: view ? [view.x, view.y, view.width, view.height] : null,
          rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
          clientDimensions: svg ? [svg.clientWidth, svg.clientHeight] : null,
          isConnected: svg?.isConnected ?? false,
          display: style?.display ?? null,
          visibility: style?.visibility ?? null,
          hiddenAncestor: svg?.closest('[hidden]')?.className ?? null,
          matrix,
          matrixError,
          activeView: svg?.closest('.editor-body')?.getAttribute('data-view') ?? null,
          activeSheet:
            document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? null,
          core: snapshot
            ? {
                revision: snapshot.revision,
                undoDepth: snapshot.undoDepth,
                sourceDraftPending: snapshot.sourceDraft !== null,
                sourceDraftLength: snapshot.sourceDraft?.length ?? 0,
                schematicId: schematic?.id ?? null,
                partCount: schematic?.parts.length ?? 0,
                firstPart: firstPart
                  ? { id: firstPart.id, ref: firstPart.ref, x: firstPart.x, y: firstPart.y }
                  : null,
              }
            : null,
        };
      })
      .catch((failure) => ({ diagnosticError: String(failure) }));
    console.error(
      'Schematic hotkeys setup diagnostic: ' +
        JSON.stringify({ name, pageErrors: errors, diagnostic }),
    );
    throw error;
  }
  await page.waitForFunction(() => window.dirtyWrites.length > 0);
  await canvas.focus();
  const screen = (point) =>
    canvas.evaluate((svg, p) => {
      const at = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
      return { x: at.x, y: at.y };
    }, point);
  const move = async (point) => {
    const at = await screen(point);
    await page.mouse.move(at.x, at.y, { steps: 4 });
  };
  const click = async (point) => {
    const at = await screen(point);
    await page.mouse.click(at.x, at.y);
  };
  const doubleClick = async (point) => {
    const at = await screen(point);
    await page.mouse.dblclick(at.x, at.y);
  };
  const glyph = (testId) =>
    canvas.getByTestId(testId).evaluate((node) => {
      const b = node.getBoundingClientRect();
      const p = new DOMPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2).matrixTransform(
        node.ownerSVGElement.getScreenCTM().inverse(),
      );
      return { x: p.x, y: p.y };
    });
  const inspector = () => page.locator('[aria-label="Object properties"]');
  const draft = () => canvas.getByTestId('schematic-wire-preview');
  const expectClean = async () => {
    assert.equal(
      await page
        .getByRole('group', { name: 'Schematic tools', exact: true, includeHidden: true })
        .getByRole('button', { name: 'Undo', exact: true, includeHidden: true })
        .isDisabled(),
      true,
      `${name}: no undo edit`,
    );
    assert.equal(
      await page.locator('.project-navigation .dirty-dot').count(),
      0,
      `${name}: design remains clean`,
    );
    const snapshots = await page.evaluate(() => ({
      dirty: window.dirtyWrites.at(-1),
      writes: window.recoveryWrites,
    }));
    assert.equal(snapshots.dirty, false);
    for (const write of snapshots.writes)
      for (const item of write.documents)
        if (item.id === documentId) {
          assert.equal(
            item.source,
            source,
            'Recovery never receives provisional drawing geometry.',
          );
          assert.equal(item.dirty, false);
        }
  };
  const currentProject = async () => {
    await button('Source').click();
    const next = await readNativeProject(page);
    // Native Source omits private provenance; recovery owns that assertion.
    const recovered = state.documents.find((item) => item.id === documentId);
    assert.deepEqual(parseProject(recovered.source).extensions, baseline.extensions);
    await button('Schematic').click();
    await canvas.waitFor({ state: 'visible' });
    await canvas.focus();
    return next;
  };
  const currentNativeFiles = async () => {
    await button('Source').click();
    const files = await readNativeFiles(page);
    const recovered = state.documents.find((item) => item.id === documentId);
    assert.deepEqual(parseProject(recovered.source).extensions, baseline.extensions);
    await button('Schematic').click();
    await canvas.waitFor({ state: 'visible' });
    await canvas.focus();
    return files;
  };
  const nativeBaseline = await currentProject();
  const nativeBaselineSource = serializeProject(nativeBaseline);
  const undo = async () => {
    assert.equal(await button('Undo').isEnabled(), true, 'Completed action creates an undo edit.');
    await button('Undo').click();
    assert.equal(await button('Undo').isDisabled(), true, 'One undo restores the entire action.');
    assert.equal(
      serializeProject(await currentProject()),
      nativeBaselineSource,
      'Undo restores all native PCB and schematic content.',
    );
    assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  };
  const startWire = async (point) => {
    await move(point);
    await canvas.focus();
    await canvas.press('w');
    await draft().waitFor({ state: 'attached' });
  };
  const draftStart = async () => {
    const path = await draft().getAttribute('d');
    const match = path.match(/^M\s+([-\d.]+)[ ,]+([-\d.]+)/);
    assert.ok(match, `Wire preview has a real start: ${path}`);
    return { x: Number(match[1]), y: Number(match[2]) };
  };
  const selectedPart = (part) => canvas.getByTestId(`part-${part.ref}`);
  try {
    await check({
      page,
      canvas,
      button,
      move,
      click,
      doubleClick,
      glyph,
      inspector,
      draft,
      expectClean,
      currentProject,
      currentNativeFiles,
      undo,
      startWire,
      draftStart,
      selectedPart,
      nativeBaselineSource,
      nativeBaseline,
    });
    assert.deepEqual(errors, [], `${name}: no renderer errors`);
    completed++;
    console.log(`Schematic hotkeys: ${name}.`);
  } finally {
    await page.close();
  }
}

const settleInspection = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
const inspectionView = (canvas) =>
  canvas.evaluate((svg) => {
    const view = svg.viewBox.baseVal;
    return [view.x, view.y, view.width, view.height];
  });
function expectInspectionViewUnchanged(actual, expected, message) {
  assert.ok(
    actual.every((value, index) => Math.abs(value - expected[index]) < 1e-9),
    message,
  );
}
const inspectionNativeFileSet = (bundle) => ({
  entry: bundle.entry,
  files: bundle.files.toSorted((a, b) => a.name.localeCompare(b.name)),
});

async function panInspectionTargetAway(t) {
  const bounds = await t.canvas.boundingBox();
  assert.ok(bounds, 'The active schematic has a measurable drawing viewport.');
  for (let i = 0; i < 2; i++) {
    await t.page.mouse.move(bounds.x + bounds.width * 0.1, bounds.y + bounds.height * 0.5);
    await t.page.mouse.down({ button: 'middle' });
    await t.page.mouse.move(bounds.x + bounds.width * 0.9, bounds.y + bounds.height * 0.5, {
      steps: 6,
    });
    await t.page.mouse.up({ button: 'middle' });
  }
  const visible = await t.canvas.evaluate((svg, target) => {
    const point = new DOMPoint(target.x, target.y).matrixTransform(svg.getScreenCTM());
    const bounds = svg.getBoundingClientRect();
    return (
      point.x >= bounds.left &&
      point.x <= bounds.right &&
      point.y >= bounds.top &&
      point.y <= bounds.bottom
    );
  }, first);
  assert.equal(visible, false, 'The Locate target starts outside the current view.');
}

async function locateInspectionTarget(t, expectPickupCancelled = false) {
  const panel = await openSchematicPanel(t.page, 'List');
  if (expectPickupCancelled)
    assert.equal(
      await t.canvas.getAttribute('data-move-preview'),
      null,
      'Opening List transfers focus and cancels the pickup before Locate measures the committed symbol.',
    );
  await panel.getByRole('button', { name: `Locate ${first.ref}`, exact: true }).click();
  await panel.waitFor({ state: 'detached' });
  await t.canvas.waitFor({ state: 'visible' });
  await settleInspection(t.page);
  const located = await t.canvas.evaluate((svg, target) => {
    const point = new DOMPoint(target.x, target.y).matrixTransform(svg.getScreenCTM());
    const bounds = svg.getBoundingClientRect();
    return {
      visible:
        point.x >= bounds.left &&
        point.x <= bounds.right &&
        point.y >= bounds.top &&
        point.y <= bounds.bottom,
      dx: point.x - (bounds.left + bounds.width / 2),
      dy: point.y - (bounds.top + bounds.height / 2),
      focused: document.activeElement === svg,
      interaction: svg.parentElement.classList.contains('tool-select'),
    };
  }, first);
  assert.equal(
    located.visible,
    true,
    'Locate reveals the component even after it was panned offscreen.',
  );
  assert.ok(
    Math.abs(located.dx) <= 2 && Math.abs(located.dy) <= 2,
    'Locate centers the target in the schematic viewport.',
  );
  assert.equal(
    located.interaction,
    true,
    'Locate returns to Interaction before the next pointer or keyboard action.',
  );
  assert.equal(located.focused, true, 'Locate restores canvas focus after the List dialog closes.');
  assert.equal(
    await t.selectedPart(first).evaluate((node) => node.classList.contains('is-selected')),
    true,
  );
  await t.expectClean();
}

const partsSearchState = (t) =>
  t.page.evaluate(() => {
    const snapshot = window.schematicHotkeysCore.getSnapshot();
    return { source: snapshot.source, revision: snapshot.revision, undoDepth: snapshot.undoDepth };
  });
async function openPartsSearch(t) {
  const panel = await openSchematicPanel(t.page, 'List');
  const input = panel.getByLabel('Search parts', { exact: true });
  await input.waitFor();
  assert.equal(
    await input.evaluate((node) => document.activeElement === node),
    true,
    'Search starts focused even when a component is selected.',
  );
  return { panel, input };
}
async function expectPartsSearchRows(panel, references) {
  assert.deepEqual(
    await panel
      .getByRole('button', { name: /^Edit / })
      .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
    references.map((reference) => `Edit ${reference}`),
    'Filtered rows retain their original order and actions.',
  );
}
async function expectPartsSearchUnchanged(t, before) {
  assert.deepEqual(await partsSearchState(t), before, 'Searching never changes Core or undo.');
  await t.expectClean();
}

try {
  await run(
    'selection filters All restores mixed and empty categories without edits',
    async (t) => {
      const before = await partsSearchState(t);
      const nativeBefore = await t.currentNativeFiles();
      await t.click(first);
      const panel = await openSchematicPanel(t.page, 'Selection');
      const all = panel.getByRole('checkbox', { name: 'All', exact: true });
      // Labels supply the checkbox names; assert the master separately from each category.
      const names = ['Symbols', 'Wires', 'Labels', 'Text', 'No-connects'];
      assert.equal(await panel.getByRole('checkbox').count(), 6);
      assert.equal(await all.isChecked(), true);
      await panel.getByRole('checkbox', { name: 'Symbols', exact: true }).uncheck();
      assert.equal(await all.evaluate((node) => node.indeterminate), true);
      assert.equal(
        await t.selectedPart(first).evaluate((node) => node.classList.contains('is-selected')),
        false,
      );
      await all.check();
      for (const name of names)
        assert.equal(await panel.getByRole('checkbox', { name, exact: true }).isChecked(), true);
      assert.equal(await all.evaluate((node) => node.indeterminate), false);
      await all.uncheck();
      for (const name of names)
        assert.equal(await panel.getByRole('checkbox', { name, exact: true }).isChecked(), false);
      await t.page.keyboard.press('Escape');
      await panel.waitFor({ state: 'hidden' });
      await t.click(first);
      assert.equal(
        await t.selectedPart(first).evaluate((node) => node.classList.contains('is-selected')),
        false,
      );
      await openSchematicPanel(t.page, 'Selection');
      await all.focus();
      await all.press('Space');
      assert.equal(await all.isChecked(), true, 'Keyboard restores all categories from empty.');
      await t.page.keyboard.press('Escape');
      await t.click(first);
      assert.equal(
        await t.selectedPart(first).evaluate((node) => node.classList.contains('is-selected')),
        true,
      );
      assert.deepEqual(
        await t.currentNativeFiles(),
        nativeBefore,
        'Filters preserve every native file byte.',
      );
      assert.deepEqual(
        await partsSearchState(t),
        before,
        'Filters create no Core revision or undo.',
      );
      await t.expectClean();
    },
  );

  await run(
    'selection filters isolate one category and retain it across editor visits',
    async (t) => {
      const before = await partsSearchState(t);
      const panel = await openSchematicPanel(t.page, 'Selection');
      const names = ['Symbols', 'Wires', 'Labels', 'Text', 'No-connects'];
      for (const only of names) {
        await panel.getByRole('checkbox', { name: only, exact: true }).click({ button: 'right' });
        for (const name of names)
          assert.equal(
            await panel.getByRole('checkbox', { name, exact: true }).isChecked(),
            name === only,
          );
        assert.equal(
          await panel
            .getByRole('checkbox', { name: 'All', exact: true })
            .evaluate((node) => node.indeterminate),
          true,
        );
        assert.equal(
          await panel.isVisible(),
          true,
          'Isolating a category keeps the filter panel open.',
        );
      }
      await panel.getByText('Wires', { exact: true }).click({ button: 'right' });
      await t.page.keyboard.press('Escape');
      await t.click(first);
      assert.equal(
        await t.selectedPart(first).evaluate((node) => node.classList.contains('is-selected')),
        false,
      );
      const wire = doc.wires[1];
      await t.click({ x: 35.56, y: 45.72 });
      assert.equal(
        await t.canvas.locator(`[data-selection-id="${wire.id}"] [data-selection-only]`).count(),
        1,
        'The isolated wire category remains selectable.',
      );
      await t.button('Layout').click();
      await t.page.getByTestId('layout-canvas').waitFor({ state: 'visible' });
      await t.button('Source').click();
      await t.button('Schematic').click();
      await t.canvas.waitFor({ state: 'visible' });
      await openSchematicPanel(t.page, 'Selection');
      for (const name of names)
        assert.equal(
          await panel.getByRole('checkbox', { name, exact: true }).isChecked(),
          name === 'Wires',
        );
      await panel.getByRole('checkbox', { name: 'All', exact: true }).check();
      await t.page.keyboard.press('Escape');
      assert.deepEqual(await partsSearchState(t), before);
      await t.expectClean();
    },
  );

  await run(
    'parts search matches reference display Value and actual Footprint in original order',
    async (t) => {
      const before = await partsSearchState(t);
      const { panel, input } = await openPartsSearch(t);
      await expectPartsSearchRows(panel, [first.ref, second.ref]);
      assert.equal(
        await panel.getByRole('button', { name: 'Clear parts search', exact: true }).count(),
        0,
      );
      for (const [query, references] of [
        [`  ${first.ref.toLowerCase()}  `, [first.ref]],
        [first.value.toUpperCase(), [first.ref, second.ref]],
        ['fIXture:r', [first.ref]],
        ['   ', [first.ref, second.ref]],
      ]) {
        await input.fill(query);
        await expectPartsSearchRows(panel, references);
      }
      await input.fill('No footprint');
      await panel.getByText('No matching components', { exact: true }).waitFor();
      await expectPartsSearchRows(panel, []);
      await t.page.keyboard.press('Escape');
      await panel.waitFor({ state: 'detached' });
      await expectPartsSearchUnchanged(t, before);
    },
  );

  await run(
    'parts search matches a resolved simulation Value instead of its native placeholder',
    async (t) => {
      await t.click(first);
      const value = t.inspector().getByLabel('Component value', { exact: true });
      await value.waitFor();
      await value.fill('${SIM.PARAMS}');
      await value.press('Enter');
      const before = await partsSearchState(t);
      assert.equal(
        before.undoDepth,
        1,
        'Only the explicit Value edit creates an undo transaction.',
      );
      assert.equal(
        await t.page.evaluate(
          (id) =>
            window.schematicHotkeysCore
              .getSnapshot()
              .project.schematic.parts.find((part) => part.id === id).value,
          first.id,
        ),
        '${SIM.PARAMS}',
      );
      const { panel, input } = await openPartsSearch(t);
      await input.fill('25');
      await expectPartsSearchRows(panel, [first.ref]);
      await panel
        .getByRole('button', { name: `Edit ${first.ref}`, exact: true })
        .getByText('25', { exact: true })
        .waitFor();
      await input.fill('${SIM.PARAMS}');
      await panel.getByText('No matching components', { exact: true }).waitFor();
      await expectPartsSearchRows(panel, []);
      assert.deepEqual(
        await partsSearchState(t),
        before,
        'Filtering adds no edit after the Value change.',
      );
      await t.page.keyboard.press('Escape');
      await panel.waitFor({ state: 'detached' });
      await t.undo();
      await t.expectClean();
    },
  );

  await run(
    'parts search no results remain inert and Clear search restores rows and input focus',
    async (t) => {
      const before = await partsSearchState(t);
      const view = await inspectionView(t.canvas);
      const { panel, input } = await openPartsSearch(t);
      await input.fill('missing-search-component');
      await panel.getByText('No matching components', { exact: true }).waitFor();
      await expectPartsSearchRows(panel, []);
      await t.page.keyboard.press('Enter');
      assert.equal(await panel.isVisible(), true);
      assert.equal(await input.evaluate((node) => document.activeElement === node), true);
      expectInspectionViewUnchanged(
        await inspectionView(t.canvas),
        view,
        'An empty result cannot locate a component.',
      );
      await panel.getByRole('button', { name: 'Clear parts search', exact: true }).click();
      assert.equal(await input.inputValue(), '');
      assert.equal(await input.evaluate((node) => document.activeElement === node), true);
      assert.equal(
        await panel.getByRole('button', { name: 'Clear parts search', exact: true }).count(),
        0,
      );
      await expectPartsSearchRows(panel, [first.ref, second.ref]);
      await t.page.keyboard.press('Escape');
      await panel.waitFor({ state: 'detached' });
      assert.equal(
        await t.button('List').evaluate((node) => document.activeElement === node),
        true,
      );
      await expectPartsSearchUnchanged(t, before);
    },
  );

  await run(
    'parts search unique Enter locates an offscreen component and restores Interaction focus',
    async (t) => {
      await panInspectionTargetAway(t);
      await t.button('Wire').click();
      const before = await partsSearchState(t);
      const { panel, input } = await openPartsSearch(t);
      await input.fill(first.ref);
      await expectPartsSearchRows(panel, [first.ref]);
      await t.page.keyboard.press('Enter');
      await panel.waitFor({ state: 'detached' });
      await settleInspection(t.page);
      const located = await t.canvas.evaluate((svg, target) => {
        const point = new DOMPoint(target.x, target.y).matrixTransform(svg.getScreenCTM());
        const bounds = svg.getBoundingClientRect();
        return {
          dx: point.x - (bounds.left + bounds.width / 2),
          dy: point.y - (bounds.top + bounds.height / 2),
          focused: document.activeElement === svg,
          interaction: svg.parentElement.classList.contains('tool-select'),
        };
      }, first);
      assert.ok(
        Math.abs(located.dx) <= 2 && Math.abs(located.dy) <= 2,
        'Enter centers the unique result.',
      );
      assert.equal(located.focused, true);
      assert.equal(located.interaction, true);
      assert.equal(
        await t.selectedPart(first).evaluate((node) => node.classList.contains('is-selected')),
        true,
      );
      await expectPartsSearchUnchanged(t, before);
      assert.equal(serializeProject(await t.currentProject()), t.nativeBaselineSource);
    },
  );

  await run(
    'parts search multiple results Enter retains search selection tool and camera',
    async (t) => {
      await t.click(second);
      await t.button('Wire').click();
      const before = await partsSearchState(t);
      const view = await inspectionView(t.canvas);
      const { panel, input } = await openPartsSearch(t);
      for (const query of ['', 'r', first.value.toUpperCase()]) {
        await input.fill(query);
        await expectPartsSearchRows(panel, [first.ref, second.ref]);
        await t.page.keyboard.press('Enter');
        assert.equal(await panel.isVisible(), true);
        assert.equal(await input.inputValue(), query);
        assert.equal(await input.evaluate((node) => document.activeElement === node), true);
        assert.equal(
          await t.canvas.evaluate((svg) => svg.parentElement.classList.contains('tool-wire')),
          true,
        );
        assert.equal(
          await t.selectedPart(second).evaluate((node) => node.classList.contains('is-selected')),
          true,
        );
        expectInspectionViewUnchanged(
          await inspectionView(t.canvas),
          view,
          'Ambiguous Enter cannot locate the first result.',
        );
      }
      await t.page.keyboard.press('Escape');
      await panel.waitFor({ state: 'detached' });
      assert.equal(
        await t.button('List').evaluate((node) => document.activeElement === node),
        true,
      );
      assert.equal(
        await t.canvas.evaluate((svg) => svg.parentElement.classList.contains('tool-wire')),
        true,
      );
      assert.equal(
        await t.selectedPart(second).evaluate((node) => node.classList.contains('is-selected')),
        true,
      );
      await expectPartsSearchUnchanged(t, before);
    },
  );

  await run(
    'parts search Tab preserves separate Edit and Locate actions and native button activation',
    async (t) => {
      const before = await partsSearchState(t);
      const { panel, input } = await openPartsSearch(t);
      await input.fill('Fixture:R');
      const clear = panel.getByRole('button', { name: 'Clear parts search', exact: true });
      const edit = panel.getByRole('button', { name: `Edit ${first.ref}`, exact: true });
      const locate = panel.getByRole('button', { name: `Locate ${first.ref}`, exact: true });
      for (const target of [clear, edit, locate]) {
        await t.page.keyboard.press('Tab');
        assert.equal(await target.evaluate((node) => document.activeElement === node), true);
      }
      await t.page.keyboard.press('Shift+Tab');
      assert.equal(await edit.evaluate((node) => document.activeElement === node), true);
      await t.page.keyboard.press('Enter');
      await panel.waitFor({ state: 'detached' });
      const reference = t.inspector().getByLabel('Component reference', { exact: true });
      await reference.waitFor();
      assert.equal(await reference.inputValue(), first.ref);
      assert.equal(await reference.evaluate((node) => document.activeElement === node), true);
      await expectPartsSearchUnchanged(t, before);
    },
  );

  for (const composing of [{ isComposing: true }, { keyCode: 229 }])
    await run(
      `parts search IME ${composing.isComposing ? 'composition' : 'legacy 229'} Enter and Escape retain search`,
      async (t) => {
        await t.click(first);
        await t.button('Wire').click();
        const before = await partsSearchState(t);
        const view = await inspectionView(t.canvas);
        const { panel, input } = await openPartsSearch(t);
        await input.fill(first.ref);
        await expectPartsSearchRows(panel, [first.ref]);
        for (const key of ['Enter', 'Escape']) {
          assert.equal(
            await input.evaluate(
              (node, properties) => {
                const event = new KeyboardEvent('keydown', {
                  bubbles: true,
                  cancelable: true,
                  ...properties,
                });
                node.dispatchEvent(event);
                return event.defaultPrevented;
              },
              { key, ...composing },
            ),
            true,
            'IME keys prevent native dismissal and unique-result navigation.',
          );
          assert.equal(await panel.isVisible(), true);
          assert.equal(await input.inputValue(), first.ref);
          assert.equal(await input.evaluate((node) => document.activeElement === node), true);
          expectInspectionViewUnchanged(
            await inspectionView(t.canvas),
            view,
            'IME keys cannot change the camera.',
          );
        }
        await t.page.keyboard.press('Escape');
        await panel.waitFor({ state: 'detached' });
        assert.equal(
          await t.button('List').evaluate((node) => document.activeElement === node),
          true,
        );
        assert.equal(
          await t.canvas.evaluate((svg) => svg.parentElement.classList.contains('tool-wire')),
          true,
        );
        assert.equal(
          await t.selectedPart(first).evaluate((node) => node.classList.contains('is-selected')),
          true,
        );
        await expectPartsSearchUnchanged(t, before);
      },
    );

  await run(
    'parts search fresh reopen resets the query and stays scoped to the active sheet',
    async (t) => {
      let { panel, input } = await openPartsSearch(t);
      await input.fill(first.ref);
      await expectPartsSearchRows(panel, [first.ref]);
      await t.page.keyboard.press('Escape');
      await panel.waitFor({ state: 'detached' });
      ({ panel, input } = await openPartsSearch(t));
      assert.equal(await input.inputValue(), '');
      await expectPartsSearchRows(panel, [first.ref, second.ref]);
      await t.page.keyboard.press('Escape');
      await panel.waitFor({ state: 'detached' });
      await t.expectClean();
      const secondary = await t.page.evaluate(() => {
        const core = window.schematicHotkeysCore;
        core.execute('schematic.add');
        return core.getSnapshot().project.additionalSchematics.at(-1);
      });
      const secondaryTab = t.page.getByRole('tab', {
        name: new RegExp('^' + secondary.title),
        exact: false,
      });
      await secondaryTab.waitFor();
      await secondaryTab.click();
      const before = await partsSearchState(t);
      ({ panel, input } = await openPartsSearch(t));
      assert.equal(await input.inputValue(), '');
      await panel.getByText('No components', { exact: true }).waitFor();
      await expectPartsSearchRows(panel, []);
      await input.fill(first.ref);
      await panel.getByText('No components', { exact: true }).waitFor();
      assert.equal(await panel.getByText('No matching components', { exact: true }).count(), 0);
      await t.page.keyboard.press('Enter');
      assert.equal(
        await panel.isVisible(),
        true,
        'An empty sheet cannot locate a component on another sheet.',
      );
      assert.equal(await secondaryTab.getAttribute('aria-selected'), 'true');
      await t.page.keyboard.press('Escape');
      await panel.waitFor({ state: 'detached' });
      await t.page.getByRole('tab', { name: new RegExp('^' + doc.title), exact: false }).click();
      ({ panel, input } = await openPartsSearch(t));
      assert.equal(await input.inputValue(), '');
      await expectPartsSearchRows(panel, [first.ref, second.ref]);
      await t.page.keyboard.press('Escape');
      await panel.waitFor({ state: 'detached' });
      assert.deepEqual(
        await partsSearchState(t),
        before,
        'Query and navigation add no edit after sheet creation.',
      );
      await t.undo();
      await t.expectClean();
    },
  );

  await run(
    'saved hidden geometry preferences leave components and connections visible and editable',
    async (t) => {
      for (const part of doc.parts) await t.selectedPart(part).waitFor();
      for (const wire of doc.wires)
        await t.canvas.locator(`[data-selection-id="${wire.id}"]`).waitFor({ state: 'attached' });
      for (const label of doc.labels) await t.canvas.getByTestId(`label-${label.text}`).waitFor();
      for (const marker of doc.noConnects)
        await t.canvas.getByTestId(`no-connect-${marker.id}`).waitFor();
      assert.equal(await t.canvas.getByTestId(`annotation-ref-${first.ref}`).count(), 0);
      assert.equal(await t.canvas.getByTestId(`annotation-value-${first.ref}`).isVisible(), false);
      await t.expectClean();
      assert.equal(serializeProject(await t.currentProject()), t.nativeBaselineSource);
      await t.move(first);
      await t.canvas.press('e');
      const input = t.inspector().getByLabel('Component reference', { exact: true });
      await input.waitFor();
      assert.equal(await input.inputValue(), first.ref);
      await t.expectClean();
    },
    {
      ...defaultAppearance,
      schematicLayers: {
        ...defaultAppearance.schematicLayers,
        symbols: false,
        wires: false,
        labels: false,
        noConnects: false,
        references: false,
        values: false,
      },
    },
  );

  for (const entry of ['E', 'double-click', 'List Edit'])
    await run(
      `inspection continuity collapsed sidebar ${entry} reveals and focuses Properties without editing`,
      async (t) => {
        const sidebar = t.page.getByTestId('schematic-properties-panel');
        await t.button('Toggle right sidebar').click();
        await sidebar.waitFor({ state: 'hidden' });
        if (entry === 'E') {
          await t.click(first);
          await t.page.keyboard.press('e');
        } else if (entry === 'double-click') await t.doubleClick(first);
        else {
          const panel = await openSchematicPanel(t.page, 'List');
          await panel.getByRole('button', { name: `Edit ${first.ref}`, exact: true }).click();
          await panel.waitFor({ state: 'detached' });
        }
        await settleInspection(t.page);
        assert.equal(
          await sidebar.isVisible(),
          true,
          'An explicit inspection request reveals the collapsed Properties dock.',
        );
        const input = t.inspector().getByLabel('Component reference', { exact: true });
        assert.equal(await input.isVisible(), true);
        assert.equal(await input.inputValue(), first.ref);
        assert.equal(
          await input.evaluate((node) => document.activeElement === node),
          true,
          'Inspection focuses the requested object after sidebar/dialog transitions.',
        );
        await t.expectClean();
        assert.equal(serializeProject(await t.currentProject()), t.nativeBaselineSource);
      },
    );

  await run(
    'inspection continuity ordinary selection keeps the Schematic sidebar collapsed',
    async (t) => {
      const sidebar = t.page.getByTestId('schematic-properties-panel');
      await t.button('Toggle right sidebar').click();
      await sidebar.waitFor({ state: 'hidden' });
      for (const part of [first, second]) {
        await t.click(part);
        await settleInspection(t.page);
        assert.equal(
          await sidebar.isVisible(),
          false,
          'Ordinary object selection preserves the chosen dock visibility.',
        );
        assert.equal(
          await t.selectedPart(part).evaluate((node) => node.classList.contains('is-selected')),
          true,
        );
        await t.expectClean();
      }
      assert.equal(serializeProject(await t.currentProject()), t.nativeBaselineSource);
    },
  );

  await run(
    'inspection continuity drawing toolbar and empty-selection Drag hand off canvas focus',
    async (t) => {
      for (const tool of ['Wire', 'Interaction mode', 'Annotation mode', 'Drag with connections']) {
        if (tool === 'Drag with connections') {
          await t.page.getByRole('combobox', { name: 'Edit schematic', exact: true }).click();
          await t.page.getByRole('option', { name: tool, exact: true }).click();
        } else await t.button(tool).click();
        await settleInspection(t.page);
        assert.equal(
          await t.canvas.evaluate((node) => document.activeElement === node),
          true,
          `${tool} returns keyboard focus to its drawing.`,
        );
        await t.page.keyboard.press('Escape');
        await t.expectClean();
      }
    },
  );

  await run(
    'inspection continuity Interaction cancels a same-tool M or G pickup before Enter',
    async (t) => {
      for (const key of ['m', 'g']) {
        await t.click(first);
        await t.page.keyboard.press(key);
        await t.move({ x: snap(first.x + 5.08), y: snap(first.y + 2.54) });
        assert.equal(
          await t.canvas.getAttribute('data-move-preview'),
          key === 'g' ? 'drag' : 'move',
        );
        await t.button('Interaction mode').click();
        await settleInspection(t.page);
        assert.equal(await t.canvas.getAttribute('data-move-preview'), null);
        assert.equal(await t.canvas.evaluate((node) => document.activeElement === node), true);
        assert.equal(
          await t.selectedPart(first).evaluate((node) => node.classList.contains('is-selected')),
          true,
        );
        await t.page.keyboard.press('Enter');
        await t.expectClean();
      }
      assert.equal(serializeProject(await t.currentProject()), t.nativeBaselineSource);
    },
  );

  await run(
    'inspection continuity repeated Wire activation retains its route and restores keyboard focus',
    async (t) => {
      await t.startWire({ x: 10.16, y: 10.16 });
      await t.click({ x: 20.32, y: 10.16 });
      await t.move({ x: 30.48, y: 25.4 });
      const route = await t.draft().getAttribute('d');
      await t.button('Wire').click();
      await settleInspection(t.page);
      assert.equal(
        await t.draft().getAttribute('d'),
        route,
        'A same-tool focus request preserves every uncommitted wire leg.',
      );
      assert.equal(await t.canvas.evaluate((node) => document.activeElement === node), true);
      await t.page.keyboard.press('Escape');
      assert.equal(await t.draft().count(), 0);
      assert.equal(
        await t.canvas.locator('..').evaluate((wrap) => wrap.classList.contains('tool-wire')),
        true,
      );
      await t.page.keyboard.press('Escape');
      await t.expectClean();
    },
  );

  for (const action of ['Escape', 'Ctrl+S'])
    await run(
      `inspection continuity marker menu restores keyboard ${action} without placing a label`,
      async (t) => {
        await t.page
          .getByRole('combobox', { name: 'Place electrical marker', exact: true })
          .click();
        await t.page.getByRole('option', { name: 'Net label', exact: true }).click();
        await t.move({ x: 45.72, y: 66.04 });
        assert.equal(
          await t.canvas.locator('..').evaluate((wrap) => wrap.classList.contains('tool-label')),
          true,
        );
        // Keyboard targets the real focus left by the menu. canvas.press() or
        // canvas.focus() here would hide the missing menu-to-editor handoff.
        await t.page.keyboard.press(action === 'Escape' ? 'Escape' : 'ControlOrMeta+s');
        if (action === 'Escape') {
          await settleInspection(t.page);
          assert.equal(
            await t.canvas.locator('..').evaluate((wrap) => wrap.classList.contains('tool-select')),
            true,
            'Escape cancels the marker tool immediately after menu activation.',
          );
          await t.expectClean();
          assert.equal(serializeProject(await t.currentProject()), t.nativeBaselineSource);
        } else {
          await t.page.waitForFunction(() => window.hotkeySaveRequests.length > 0);
          const requests = await t.page.evaluate(() => window.hotkeySaveRequests);
          assert.equal(
            requests.length,
            1,
            'Save reaches the native boundary once after marker menu activation.',
          );
          assert.equal(requests[0].saveAs, false);
          const expectedNative = inspectionNativeFileSet(
            projectNativeFiles(t.nativeBaseline, requests[0].name),
          );
          const savedNative = inspectionNativeFileSet(
            projectNativeFiles(parseProject(requests[0].source), requests[0].name),
          );
          assert.deepEqual(
            savedNative,
            expectedNative,
            'Hover and Save retain every native filename, encoding and source byte without placing a marker.',
          );
          await t.page.waitForFunction(
            () => !document.querySelector('.project-navigation .dirty-dot'),
          );
          assert.equal(
            await t.page.evaluate(() => window.schematicHotkeysCore.getSnapshot().undoDepth),
            0,
          );
          const currentNative = inspectionNativeFileSet(await t.currentNativeFiles());
          assert.deepEqual(
            currentNative,
            expectedNative,
            'The saved destination retains the original native file set byte-for-byte.',
          );
          assert.deepEqual(
            currentNative,
            savedNative,
            'Source reads the exact native file set sent through Save.',
          );
          assert.equal(
            await t.page.evaluate(() => window.schematicHotkeysCore.getSnapshot().undoDepth),
            0,
          );
          assert.equal(await t.page.locator('.project-navigation .dirty-dot').count(), 0);
        }
      },
    );

  await run(
    'inspection continuity List Locate recenters an offscreen target and repeats for the same selection',
    async (t) => {
      await t.click(first);
      for (let attempt = 0; attempt < 2; attempt++) {
        await panInspectionTargetAway(t);
        assert.equal(
          await t.selectedPart(first).evaluate((node) => node.classList.contains('is-selected')),
          true,
          'Navigation retains the same target selection.',
        );
        await t.button('Wire').click();
        await locateInspectionTarget(t);
      }
      assert.equal(serializeProject(await t.currentProject()), t.nativeBaselineSource);
    },
  );

  for (const key of ['m', 'g'])
    await run(
      `inspection continuity List Locate from pending ${key === 'g' ? 'Drag' : 'Move'} ignores uncommitted preview bounds`,
      async (t) => {
        await t.click(first);
        await t.page.keyboard.press(key);
        const distant = await t.canvas.evaluate((svg) => {
          const view = svg.viewBox.baseVal;
          return { x: view.x + view.width * 0.88, y: view.y + view.height * 0.85 };
        });
        await t.move({ x: snap(distant.x), y: snap(distant.y) });
        assert.equal(
          await t.canvas.getAttribute('data-move-preview'),
          key === 'g' ? 'drag' : 'move',
        );
        await locateInspectionTarget(t, true);
        assert.equal(
          await t.canvas.getAttribute('data-move-preview'),
          null,
          'Locate cancels the uncommitted pickup.',
        );
        const view = await inspectionView(t.canvas);
        assert.ok(
          view[2] <= 80 + 1e-9,
          'The small committed symbol stays readable regardless of the distant pickup preview.',
        );
        assert.equal(serializeProject(await t.currentProject()), t.nativeBaselineSource);
      },
    );

  for (const view of ['Layout', 'Model'])
    await run(
      `inspection continuity List Locate from ${view} returns to the visible schematic target`,
      async (t) => {
        await panInspectionTargetAway(t);
        await t.button('Wire').click();
        await t.button(view).click();
        if (view === 'Layout')
          await t.page.getByTestId('layout-canvas').waitFor({ state: 'visible' });
        else await t.page.locator('.pcb-model-canvas').waitFor({ state: 'visible' });
        await locateInspectionTarget(t);
        assert.equal(serializeProject(await t.currentProject()), t.nativeBaselineSource);
      },
    );

  await run(
    'inspection continuity pending Source rejects Locate without a deferred camera or focus replay',
    async (t) => {
      await panInspectionTargetAway(t);
      const before = await inspectionView(t.canvas);
      const panel = await openSchematicPanel(t.page, 'List');
      await panel
        .getByRole('button', { name: `Locate ${first.ref}`, exact: true })
        .evaluate(async (button) => {
          button.click();
          await Promise.resolve();
          const core = window.schematicHotkeysCore;
          const file = core.getNativeFiles().files.find((file) => file.name.endsWith('.kicad_sch'));
          core.execute('source.updateFile', { name: file.name, source: '(' });
        });
      await panel.waitFor({ state: 'detached' });
      await settleInspection(t.page);
      expectInspectionViewUnchanged(
        await inspectionView(t.canvas),
        before,
        'Pending Source rejects the queued navigation before it changes the view.',
      );
      assert.equal(await t.canvas.evaluate((node) => document.activeElement === node), false);
      await t.page.evaluate(() => window.schematicHotkeysCore.discardSource());
      await settleInspection(t.page);
      expectInspectionViewUnchanged(
        await inspectionView(t.canvas),
        before,
        'Discarding Source cannot replay an already rejected Locate.',
      );
      assert.equal(await t.canvas.evaluate((node) => document.activeElement === node), false);
      await t.expectClean();
    },
  );

  await run(
    'inspection continuity hiding Schematic rejects a queued Locate until a new explicit request',
    async (t) => {
      await panInspectionTargetAway(t);
      const before = await inspectionView(t.canvas);
      const sourceButton = await t.button('Source').elementHandle();
      const panel = await openSchematicPanel(t.page, 'List');
      await panel
        .getByRole('button', { name: `Locate ${first.ref}`, exact: true })
        .evaluate(async (button, sourceButton) => {
          button.click();
          await Promise.resolve();
          sourceButton.click();
        }, sourceButton);
      await t.page
        .getByRole('region', { name: 'Project source', exact: true })
        .waitFor({ state: 'visible' });
      await settleInspection(t.page);
      await t.button('Schematic').click();
      await settleInspection(t.page);
      expectInspectionViewUnchanged(
        await inspectionView(t.canvas),
        before,
        'A rejected request stays consumed after the editor becomes visible again.',
      );
      assert.equal(await t.canvas.evaluate((node) => document.activeElement === node), false);
      await t.expectClean();
      await locateInspectionTarget(t);
    },
  );

  await run(
    'inspection continuity switching sheets rejects the previous sheet Locate request',
    async (t) => {
      const secondary = await t.page.evaluate(() => {
        const core = window.schematicHotkeysCore;
        core.execute('schematic.add');
        return core.getSnapshot().project.additionalSchematics.at(-1);
      });
      const secondaryTab = t.page.getByRole('tab', {
        name: new RegExp('^' + secondary.title),
        exact: false,
      });
      await secondaryTab.waitFor();
      const secondaryButton = await secondaryTab.elementHandle();
      await panInspectionTargetAway(t);
      const before = await inspectionView(t.canvas);
      const unchanged = await t.page.evaluate(() => {
        const snapshot = window.schematicHotkeysCore.getSnapshot();
        return { source: snapshot.source, undoDepth: snapshot.undoDepth };
      });
      const panel = await openSchematicPanel(t.page, 'List');
      await panel
        .getByRole('button', { name: `Locate ${first.ref}`, exact: true })
        .evaluate(async (button, secondaryButton) => {
          button.click();
          await Promise.resolve();
          secondaryButton.click();
        }, secondaryButton);
      await t.page.waitForFunction(
        (name) =>
          document.querySelector('[role="tab"][aria-selected="true"]')?.textContent === name,
        secondary.title,
      );
      await settleInspection(t.page);
      await t.page.getByRole('tab', { name: new RegExp('^' + doc.title), exact: false }).click();
      await settleInspection(t.page);
      expectInspectionViewUnchanged(
        await inspectionView(t.canvas),
        before,
        'Returning to the originating sheet preserves its resident camera without stale navigation.',
      );
      assert.equal(await t.canvas.evaluate((node) => document.activeElement === node), false);
      assert.deepEqual(
        await t.page.evaluate(() => {
          const snapshot = window.schematicHotkeysCore.getSnapshot();
          return { source: snapshot.source, undoDepth: snapshot.undoDepth };
        }),
        unchanged,
        'Locate and tab changes do not add another edit to the explicit sheet creation.',
      );
      await t.button('Undo').click();
      assert.equal(await t.button('Undo').isDisabled(), true);
      assert.equal(serializeProject(await t.currentProject()), t.nativeBaselineSource);
      assert.equal(await t.page.locator('.project-navigation .dirty-dot').count(), 0);
    },
  );

  await run('E targets the hovered component and focuses its stable properties', async (t) => {
    await t.move(first);
    await t.canvas.press('e');
    const input = t.inspector().getByLabel('Component reference', { exact: true });
    await input.waitFor();
    assert.equal(await input.inputValue(), first.ref);
    assert.equal(await input.evaluate((node) => document.activeElement === node), true);
    await t.expectClean();
    const value = t.inspector().getByLabel('Component value', { exact: true });
    await value.fill('22k');
    await value.press('Enter');
    const next = await t.currentProject();
    assert.equal(next.schematic.parts.find((part) => part.id === first.id).value, '22k');
    assert.deepEqual(
      next.schematic.parts.find((part) => part.id === second.id),
      t.nativeBaseline.schematic.parts.find((part) => part.id === second.id),
    );
    await t.undo();
  });

  await run(
    'E gives an existing selection priority over a different hovered component',
    async (t) => {
      await t.click(first);
      await t.move(second);
      await t.canvas.press('e');
      const input = t.inspector().getByLabel('Component reference', { exact: true });
      assert.equal(await input.inputValue(), first.ref);
      assert.equal(await input.evaluate((node) => document.activeElement === node), true);
      await t.expectClean();
    },
  );

  for (const field of [
    { name: 'Reference', testId: `annotation-ref-${first.ref}`, value: first.ref, next: 'R9' },
    { name: 'Value', testId: `annotation-value-${first.ref}`, value: first.value, next: '33k' },
    {
      name: 'Sim.Params',
      testId: `annotation-field-${first.ref}-Sim.Params`,
      value: 'temp=25',
      next: 'temp=35',
    },
  ])
    await run(`E opens and edits the independent hovered ${field.name} inspector`, async (t) => {
      await t.move(await t.glyph(field.testId));
      await t.canvas.press('e');
      const input = t.inspector().getByLabel(`${field.name} text`, { exact: true });
      await input.waitFor();
      assert.equal(await input.inputValue(), field.value);
      assert.equal(await input.evaluate((node) => document.activeElement === node), true);
      assert.equal(
        await t.inspector().getByLabel('Component X position', { exact: true }).count(),
        0,
      );
      await t.expectClean();
      await input.fill(field.next);
      await input.press('Enter');
      const next = await t.currentProject();
      const part = next.schematic.parts.find((part) => part.id === first.id);
      assert.equal(
        field.name === 'Reference'
          ? part.ref
          : field.name === 'Value'
            ? part.value
            : partFields(part)['Sim.Params'],
        field.next,
      );
      assert.equal(part.x, first.x);
      assert.equal(part.y, first.y);
      assert.deepEqual(
        next.schematic.parts.find((part) => part.id === second.id),
        t.nativeBaseline.schematic.parts.find((part) => part.id === second.id),
      );
      await t.undo();
    });

  await run('E opens the hovered label name without targeting a component', async (t) => {
    await t.move(await t.glyph('label-TEST'));
    await t.canvas.press('e');
    const input = t.inspector().getByLabel('Net name', { exact: true });
    await input.waitFor();
    assert.equal(await input.inputValue(), 'TEST');
    assert.equal(await input.evaluate((node) => document.activeElement === node), true);
    await t.expectClean();
    await input.fill('RENAMED');
    await input.press('Tab');
    assert.equal(
      (await t.currentProject()).schematic.labels.find((label) => label.id === doc.labels[1].id)
        .text,
      'RENAMED',
    );
    await t.undo();
  });

  await run('Properties regression Net name Escape cancels and Enter commits once', async (t) => {
    await t.move(await t.glyph('label-TEST'));
    await t.canvas.press('e');
    const input = t.inspector().getByLabel('Net name', { exact: true });
    await input.waitFor();
    await input.fill('CANCELLED_NET');
    await input.press('Escape');
    assert.equal(await input.inputValue(), 'TEST', 'Escape discards the local net-name draft.');
    assert.equal(await input.evaluate((node) => document.activeElement === node), true);
    assert.equal(
      await t.canvas.locator('..').evaluate((wrap) => wrap.classList.contains('tool-select')),
      true,
    );
    await input.press('Tab');
    await t.expectClean();
    await input.fill('RENAMED_NET');
    await input.press('Enter');
    assert.equal(await input.evaluate((node) => document.activeElement === node), false);
    assert.equal(
      await t.button('Undo').isEnabled(),
      true,
      'Enter commits before another control receives focus.',
    );
    assert.equal(
      (await t.currentProject()).schematic.labels.find((label) => label.id === doc.labels[1].id)
        .text,
      'RENAMED_NET',
    );
    await t.undo();
  });

  await run('Properties regression Net name observes undo before the next blur', async (t) => {
    await t.move(await t.glyph('label-TEST'));
    await t.canvas.press('e');
    const input = t.inspector().getByLabel('Net name', { exact: true });
    await input.fill('RENAMED_NET');
    await input.press('Tab');
    assert.equal(await t.button('Undo').isEnabled(), true);
    await t.button('Undo').click();
    await t.move(await t.glyph('label-TEST'));
    await t.canvas.press('e');
    await input.waitFor({ state: 'visible' });
    assert.equal(
      await input.inputValue(),
      'TEST',
      'A newer document revision refreshes the net-name field rather than retaining stale DOM text.',
    );
    await input.focus();
    await input.press('Tab');
    await t.expectClean();
    assert.equal(
      (await t.currentProject()).schematic.labels.find((label) => label.id === doc.labels[1].id)
        .text,
      'TEST',
      'An unchanged blur cannot write the pre-undo label back into the project.',
    );
  });

  for (const surface of [
    { name: 'component Value', target: 'component', input: 'Component value', draft: '22k' },
    { name: 'component X', target: 'component', input: 'Component X position', draft: '31.75' },
    { name: 'component Y', target: 'component', input: 'Component Y position', draft: '31.75' },
    { name: 'component rotation', target: 'component', input: 'Component rotation', draft: '90' },
    { name: 'Reference text', target: 'field', input: 'Reference text', draft: 'RX1' },
    { name: 'text X', target: 'field', input: 'Text X position', draft: '43.18' },
    { name: 'text Y', target: 'field', input: 'Text Y position', draft: '43.18' },
    { name: 'Net name', target: 'label', input: 'Net name', draft: 'RENAMED_NET' },
  ])
    for (const composing of [{ isComposing: true }, { keyCode: 229 }])
      await run(
        'Properties regression IME ' +
          surface.name +
          (composing.isComposing ? ' composition' : ' legacy 229'),
        async (t) => {
          if (surface.target === 'component') await t.click(first);
          else {
            await t.move(
              await t.glyph(
                surface.target === 'field' ? `annotation-ref-${first.ref}` : 'label-TEST',
              ),
            );
            await t.canvas.press('e');
          }
          const input = t.inspector().getByLabel(surface.input, { exact: true });
          await input.waitFor();
          const originalValue = await input.inputValue();
          await input.fill(surface.draft);
          for (const key of ['Enter', 'Escape']) {
            await input.dispatchEvent('keydown', {
              key,
              bubbles: true,
              cancelable: true,
              ...composing,
            });
            assert.equal(
              await input.evaluate((node) => document.activeElement === node),
              true,
              'The input method retains focus.',
            );
            assert.equal(
              await input.inputValue(),
              surface.draft,
              'Candidate confirmation/cancellation leaves the local property draft intact.',
            );
            await t.expectClean();
          }
          await input.press('Escape');
          assert.equal(
            await input.inputValue(),
            originalValue,
            'Ordinary Escape still discards the draft.',
          );
          await input.press('Tab');
          await t.expectClean();
          await input.fill(surface.draft);
          await input.press('Enter');
          assert.equal(
            await t.button('Undo').isEnabled(),
            true,
            'Ordinary Enter still commits one edit.',
          );
          await t.undo();
        },
      );

  for (const view of ['Layout', 'Model'])
    for (const surface of [
      { name: 'component Value', target: 'component', input: 'Component value' },
      { name: 'text X', target: 'field', input: 'Text X position' },
    ])
      await run(
        'Properties regression invalid ' + surface.name + ' survives ' + view + ' roundtrip',
        async (t) => {
          if (surface.target === 'component') await t.click(first);
          else {
            await t.move(await t.glyph(`annotation-ref-${first.ref}`));
            await t.canvas.press('e');
          }
          const input = t.inspector().getByLabel(surface.input, { exact: true });
          const originalValue = await input.inputValue();
          await input.fill('');
          await input.press('Tab');
          assert.equal(await input.inputValue(), '');
          const message = await t.inspector().getByRole('alert').innerText();
          assert.ok(message.length > 0, 'The invalid property has an actionable error.');
          await t.expectClean();
          await t.button(view).click();
          if (view === 'Layout')
            await t.page.getByTestId('layout-canvas').waitFor({ state: 'visible' });
          else await t.page.locator('.pcb-model-canvas').waitFor({ state: 'visible' });
          assert.equal(
            await input.isVisible(),
            false,
            'Hidden properties cannot be interacted with.',
          );
          await t.button('Schematic').click();
          await input.waitFor({ state: 'visible' });
          assert.equal(await input.inputValue(), '', 'Returning restores the same invalid draft.');
          assert.equal(await t.inspector().getByRole('alert').innerText(), message);
          await t.expectClean();
          await input.press('Escape');
          assert.equal(await input.inputValue(), originalValue);
          await input.press('Tab');
          await t.expectClean();
        },
      );

  await run(
    'Properties regression pending Source keeps sidebar toggle available and properties read-only',
    async (t) => {
      await t.click(first);
      const properties = t.inspector();
      const sidebar = t.page.getByTestId('schematic-properties-panel');
      const value = properties.getByLabel('Component value', { exact: true });
      await value.fill('');
      await value.press('Tab');
      const message = await properties.getByRole('alert').innerText();
      // Use the same real Core command as an Agent Source update, without
      // changing views or exposing a production renderer API for the fixture.
      await t.page.evaluate(() => {
        const core = window.schematicHotkeysCore;
        const file = core.getNativeFiles().files.find((file) => file.name.endsWith('.kicad_sch'));
        core.execute('source.updateFile', { name: file.name, source: '(' });
      });
      await t.page.waitForFunction(
        () =>
          document.querySelector(
            '[aria-label="Object properties"] input[aria-label="Component value"]',
          )?.disabled === true,
      );
      assert.equal(await properties.evaluate((node) => node.inert), false);
      assert.equal(
        await properties
          .locator('input')
          .evaluateAll((inputs) => inputs.every((input) => input.disabled)),
        true,
        'Both part fields and component geometry visibly disable while Source is pending.',
      );
      assert.equal(
        await properties.getByRole('switch', { name: /^Include .*in SPICE simulation$/ }).count(),
        0,
      );
      for (const name of ['Browse footprints', 'Add field', 'Delete object'])
        assert.equal(
          await properties.getByRole('button', { name, exact: true }).isDisabled(),
          true,
        );
      const toggle = t.page
        .locator('.editor-toolbar:visible')
        .getByRole('button', { name: 'Toggle right sidebar', exact: true });
      await toggle.click();
      await sidebar.waitFor({ state: 'hidden' });
      await toggle.click();
      await sidebar.waitFor({ state: 'visible' });
      assert.equal(
        await value.inputValue(),
        '',
        'Read-only collapse retains the local invalid draft.',
      );
      assert.equal(await value.isDisabled(), true);
      assert.equal(await properties.getByRole('alert').innerText(), message);
      const pending = await t.page.evaluate(() => {
        const snapshot = window.schematicHotkeysCore.getSnapshot();
        return { pending: snapshot.sourceDraft !== null, undoDepth: snapshot.undoDepth };
      });
      assert.deepEqual(
        pending,
        { pending: true, undoDepth: 0 },
        'Toggling never applies Source or creates a design edit.',
      );
      await t.page.evaluate(() => window.schematicHotkeysCore.discardSource());
      await t.page.waitForFunction(
        () =>
          document.querySelector(
            '[aria-label="Object properties"] input[aria-label="Component value"]',
          )?.disabled === false,
      );
      assert.equal(await value.inputValue(), '');
      await value.press('Escape');
      await value.press('Tab');
      await t.expectClean();
    },
  );

  await run('Properties regression hidden draft refreshes after an object undo', async (t) => {
    await t.click(first);
    const input = t.inspector().getByLabel('Component value', { exact: true });
    await input.fill('22k');
    await input.press('Enter');
    assert.equal(await t.button('Undo').isEnabled(), true);
    await input.fill('');
    await input.press('Tab');
    assert.equal(await input.inputValue(), '');
    await t.button('Layout').click();
    await t.page.getByTestId('layout-canvas').waitFor({ state: 'visible' });
    await t.button('Undo').click();
    await t.button('Schematic').click();
    await t.click(first);
    await input.waitFor({ state: 'visible' });
    assert.equal(
      await input.inputValue(),
      first.value,
      'A changed underlying component refreshes its old invalid draft.',
    );
    assert.equal(await t.inspector().getByRole('alert').count(), 0);
    await input.focus();
    await input.press('Tab');
    await t.expectClean();
    assert.equal(serializeProject(await t.currentProject()), t.nativeBaselineSource);
  });

  const propertySaveSurfaces = [
    {
      name: 'component Value',
      target: 'component',
      input: 'Component value',
      valid: '22k',
      invalid: '',
      expected: '22k',
      error: /value|non-empty/i,
      read: (project) => project.schematic.parts.find((part) => part.id === first.id).value,
    },
    {
      name: 'component X',
      target: 'component',
      input: 'Component X position',
      valid: '31.75',
      invalid: '',
      expected: 31.75,
      error: /position|between|range/i,
      read: (project) => project.schematic.parts.find((part) => part.id === first.id).x,
    },
    {
      name: 'component rotation',
      target: 'component',
      input: 'Component rotation',
      valid: '90',
      invalid: '361',
      expected: 90,
      error: /rotation|between|range/i,
      read: (project) => project.schematic.parts.find((part) => part.id === first.id).rotation,
    },
    {
      name: 'Reference text',
      target: 'field',
      input: 'Reference text',
      valid: 'RX1',
      invalid: '',
      expected: 'RX1',
      error: /reference/i,
      read: (project) => project.schematic.parts.find((part) => part.id === first.id).ref,
    },
    {
      name: 'text X',
      target: 'field',
      input: 'Text X position',
      valid: '43.18',
      invalid: '',
      expected: 43.18,
      error: /position|between|range/i,
      read: (project) => objectPosition(project.schematic, fieldId(first.id, 'Reference')).x,
    },
    {
      name: 'Net name',
      target: 'label',
      input: 'Net name',
      valid: 'RENAMED_NET',
      invalid: '',
      expected: 'RENAMED_NET',
      error: /net|label|name/i,
      read: (project) =>
        project.schematic.labels.find((label) => label.id === doc.labels[1].id).text,
    },
  ];
  for (const surface of propertySaveSurfaces)
    await run(`Properties direct save IME guard ${surface.name}`, async (t) => {
      if (surface.target === 'component') await t.click(first);
      else {
        await t.move(
          await t.glyph(surface.target === 'field' ? `annotation-ref-${first.ref}` : 'label-TEST'),
        );
        await t.canvas.press('e');
      }
      const input = t.inspector().getByLabel(surface.input, { exact: true });
      await input.waitFor();
      const originalValue = await input.inputValue();
      await input.fill(surface.valid);
      await t.page.evaluate(() => {
        window.escapedPropertySaveKeys = [];
        window.addEventListener('keydown', (event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's')
            window.escapedPropertySaveKeys.push({
              composing: event.isComposing,
              keyCode: event.keyCode,
              shift: event.shiftKey,
            });
        });
      });
      for (const composing of [{ isComposing: true }, { keyCode: 229 }])
        for (const shiftKey of [false, true]) {
          await input.dispatchEvent('keydown', {
            key: 's',
            code: 'KeyS',
            ctrlKey: true,
            shiftKey,
            bubbles: true,
            cancelable: true,
            ...composing,
          });
          assert.deepEqual(
            await t.page.evaluate(() => window.escapedPropertySaveKeys),
            [],
            'IME Save keys cannot reach the global file shortcut handler.',
          );
          assert.equal(await t.page.evaluate(() => window.hotkeySaveRequests.length), 0);
          assert.equal(await input.inputValue(), surface.valid);
          assert.equal(await input.evaluate((node) => document.activeElement === node), true);
          await t.expectClean();
        }
      await input.press('Escape');
      assert.equal(await input.inputValue(), originalValue);
      await input.press('Tab');
      await t.expectClean();
    });
  for (const surface of propertySaveSurfaces)
    for (const shortcut of [
      { name: 'Ctrl+S', key: 'ControlOrMeta+s', saveAs: false },
      ...(surface.name === 'component Value'
        ? [{ name: 'Ctrl+Shift+S', key: 'ControlOrMeta+Shift+s', saveAs: true }]
        : []),
    ])
      for (const valid of [true, false])
        await run(
          `Properties direct save ${shortcut.name} ${valid ? 'valid' : 'invalid'} ${surface.name} ${valid ? 'commits before saving' : 'blocks saving'}`,
          async (t) => {
            if (surface.target === 'component') await t.click(first);
            else {
              await t.move(
                await t.glyph(
                  surface.target === 'field' ? `annotation-ref-${first.ref}` : 'label-TEST',
                ),
              );
              await t.canvas.press('e');
            }
            const input = t.inspector().getByLabel(surface.input, { exact: true });
            await input.waitFor();
            const before = await t.page.evaluate(
              () => window.schematicHotkeysCore.getSnapshot().source,
            );
            const previousToast = (await t.page.locator('.toast').allTextContents())[0] ?? null;
            await input.fill(valid ? surface.valid : surface.invalid);
            assert.equal(await input.evaluate((node) => document.activeElement === node), true);
            await input.press(shortcut.key);
            // Do not navigate, click or blur before inspecting the save request:
            // those actions would commit the draft and conceal the shortcut bug.
            if (valid) {
              await t.page.waitForFunction(() => window.hotkeySaveRequests.length > 0);
              const requests = await t.page.evaluate(() => window.hotkeySaveRequests);
              assert.equal(
                requests.length,
                1,
                'The shortcut calls the native Save boundary exactly once.',
              );
              assert.equal(requests[0].saveAs, shortcut.saveAs);
              assert.equal(
                surface.read(parseProject(requests[0].source)),
                surface.expected,
                'Save includes the current focused property draft.',
              );
              assert.equal(
                await t.page.evaluate(() => window.schematicHotkeysCore.getSnapshot().undoDepth),
                1,
                'Saving commits the property as one whole-project undo transaction.',
              );
              await t.page.waitForFunction(
                () => !document.querySelector('.project-navigation .dirty-dot'),
              );
              await t.button('Undo').click();
              assert.equal(await t.button('Undo').isDisabled(), true);
              assert.equal(serializeProject(await t.currentProject()), t.nativeBaselineSource);
              assert.equal(
                await t.page.locator('.project-navigation .dirty-dot').count(),
                1,
                'Undo differs from the newly saved baseline.',
              );
            } else {
              await t.page.waitForFunction(
                (previousToast) =>
                  window.hotkeySaveRequests.length > 0 ||
                  document.querySelector('[aria-label="Object properties"] [role="alert"]') ||
                  (!!document.querySelector('.toast') &&
                    document.querySelector('.toast').textContent !== previousToast),
                previousToast,
              );
              assert.equal(
                await t.page.evaluate(() => window.hotkeySaveRequests.length),
                0,
                'An invalid property never reaches native Save.',
              );
              assert.equal(
                await input.inputValue(),
                surface.invalid,
                'The rejected local draft remains available for correction.',
              );
              assert.equal(await input.evaluate((node) => document.activeElement === node), true);
              const errors = await t.inspector().getByRole('alert').allTextContents();
              const toast = (await t.page.locator('.toast').allTextContents())[0] ?? null;
              assert.match(
                [...errors, toast === previousToast ? '' : (toast ?? '')].join('\n'),
                surface.error,
              );
              const unchanged = await t.page.evaluate(() => {
                const snapshot = window.schematicHotkeysCore.getSnapshot();
                return { source: snapshot.source, undoDepth: snapshot.undoDepth };
              });
              assert.deepEqual(unchanged, { source: before, undoDepth: 0 });
              await input.press('Escape');
              await input.press('Tab');
              await t.expectClean();
            }
          },
        );

  await run('E opens the hovered note in the annotation dialog', async (t) => {
    await t.move(await t.glyph(`schematic-text-${noteId}`));
    await t.canvas.press('e');
    const dialog = t.page.getByRole('dialog', { name: 'Edit annotation', exact: true });
    const input = dialog.getByLabel('Annotation text', { exact: true });
    await input.waitFor();
    assert.equal(await input.inputValue(), 'Editable note');
    await t.expectClean();
    await input.fill('Edited note');
    await dialog.getByRole('button', { name: 'Apply', exact: true }).click();
    const next = await t.currentProject();
    assert.equal(
      val(
        children(next.schematic.original, 'text').find(
          (node) => val(child(node, 'uuid')) === noteId,
        ),
      ),
      'Edited note',
    );
    await t.undo();
  });

  await run(
    'Delete uses hover removal and restores schematic PCB and extensions with one undo',
    async (t) => {
      await t.move(first);
      await t.canvas.press('Delete');
      const next = await t.currentProject();
      assert.equal(
        next.schematic.parts.some((part) => part.id === first.id),
        false,
      );
      assert.equal(
        next.schematic.parts.some((part) => part.id === second.id),
        true,
      );
      assert.equal(
        next.schematic.noConnects.some((item) => item.id === doc.noConnects[0].id),
        false,
      );
      assert.equal(
        next.pcb.footprints.some((item) => item.symbolId === first.id),
        false,
      );
      assert.deepEqual(next.pcb.tracks, t.nativeBaseline.pcb.tracks);
      assert.ok(next.schematic.labels.some((label) => label.id === doc.labels[1].id));
      await t.undo();
    },
  );

  await run('Delete uses existing selection before the hovered object', async (t) => {
    await t.click(second);
    await t.move(first);
    await t.canvas.press('Delete');
    const next = await t.currentProject();
    assert.equal(
      next.schematic.parts.some((part) => part.id === first.id),
      true,
    );
    assert.equal(
      next.schematic.parts.some((part) => part.id === second.id),
      false,
    );
    await t.undo();
  });

  for (const item of [
    { name: 'note', testId: `schematic-text-${noteId}`, id: noteId },
    { name: 'label', testId: 'label-TEST', id: doc.labels[1].id },
  ])
    await run(`Delete removes the hovered ${item.name} as one transaction`, async (t) => {
      await t.move(await t.glyph(item.testId));
      await t.canvas.press('Delete');
      const next = await t.currentProject();
      assert.equal(
        item.name === 'note'
          ? children(next.schematic.original, 'text').some(
              (node) => val(child(node, 'uuid')) === item.id,
            )
          : next.schematic.labels.some((label) => label.id === item.id),
        false,
      );
      assert.deepEqual(next.schematic.parts, t.nativeBaseline.schematic.parts);
      await t.undo();
    });

  await run('Delete on independent field text never removes its component', async (t) => {
    await t.move(await t.glyph(`annotation-value-${first.ref}`));
    await t.canvas.press('Delete');
    await t.expectClean();
    assert.equal(serializeProject(await t.currentProject()), t.nativeBaselineSource);
  });

  await run('repeat composing and modified E Delete W cannot edit or start tools', async (t) => {
    await t.move(first);
    for (const key of ['e', 'Delete', 'w']) {
      for (const property of ['repeat', 'isComposing', 'ctrlKey', 'metaKey', 'altKey', 'shiftKey'])
        await t.canvas.dispatchEvent('keydown', { key, [property]: true });
    }
    assert.equal(await t.inspector().count(), 0);
    assert.equal(await t.draft().count(), 0);
    assert.equal(await t.page.locator('.canvas-wrap.tool-wire').count(), 0);
    await t.expectClean();
  });

  await run('text inputs and display drawers own their keys', async (t) => {
    await t.click(first);
    const input = t.inspector().getByLabel('Component value', { exact: true });
    await input.focus();
    await t.move(second);
    for (const key of ['e', 'Delete', 'w']) await input.dispatchEvent('keydown', { key });
    assert.equal(await input.inputValue(), first.value);
    assert.equal(await t.draft().count(), 0);
    await t.expectClean();
    const display = await openSchematicPanel(t.page, 'Visible layers');
    for (const key of ['e', 'Delete', 'w'])
      await display.getByRole('checkbox').first().dispatchEvent('keydown', { key });
    assert.equal(await t.draft().count(), 0);
    await t.expectClean();
    await closeDisplayDrawer(t.page, 'Visualization');
    assert.equal(serializeProject(await t.currentProject()), t.nativeBaselineSource);
  });

  await run(
    'hidden text and a pointer outside the canvas cannot create hover actions',
    async (t) => {
      await t.move(first);
      await t.page.mouse.move(0, 0);
      await t.canvas.focus();
      await t.canvas.press('e');
      await t.canvas.press('Delete');
      assert.equal(await t.inspector().count(), 0);
      await t.expectClean();
      const hiddenText = await Promise.all(
        [
          `annotation-ref-${first.ref}`,
          `annotation-value-${first.ref}`,
          `schematic-text-${noteId}`,
        ].map((testId) => t.glyph(testId)),
      );
      const dialog = await openSchematicPanel(t.page, 'Visible layers');
      for (const label of ['References', 'Values', 'Notes'])
        await dialog.getByRole('checkbox', { name: label, exact: true }).uncheck();
      await closeDisplayDrawer(t.page, 'Visualization');
      for (const point of hiddenText) {
        await t.move(point);
        await t.canvas.focus();
        await t.canvas.press('e');
        await t.canvas.press('Delete');
        assert.equal(await t.inspector().count(), 0);
      }
      assert.equal(await t.selectedPart(first).count(), 1);
      await t.expectClean();
      assert.equal(serializeProject(await t.currentProject()), t.nativeBaselineSource);
    },
  );

  for (const connected of [false, true])
    await run(
      (connected ? 'Drag' : 'Move') +
        ' menu pickup retains the selected pose before pointer re-entry',
      async (t) => {
        await t.click(first);
        const symbol = t.canvas.getByTestId(`symbol-hit-${first.ref}`);
        const originalTransform = await symbol.getAttribute('transform');
        const begin = async () => {
          await t.page.getByRole('combobox', { name: 'Edit schematic', exact: true }).click();
          await t.page
            .getByRole('option', {
              name: connected ? 'Drag with connections' : 'Move selection',
              exact: true,
            })
            .click();
          await t.page.waitForFunction(
            (mode) =>
              document
                .querySelector('[data-testid="schematic-canvas"]')
                ?.getAttribute('data-move-preview') === mode,
            connected ? 'drag' : 'move',
          );
          assert.equal(await symbol.getAttribute('transform'), originalTransform);
          await t.expectClean();
        };
        await begin();
        await t.canvas.press('Enter');
        assert.equal(await t.canvas.getAttribute('data-move-preview'), null);
        await t.expectClean();

        await begin();
        const target = { x: snap(first.x + 5.08), y: snap(first.y + 2.54) };
        await t.move(target);
        await t.canvas.press('Enter');
        const next = await t.currentProject();
        const moved = next.schematic.parts.find((part) => part.id === first.id);
        assert.equal(moved.x, target.x);
        assert.equal(moved.y, target.y);
        if (connected) assert.deepEqual(next.pcb, t.nativeBaseline.pcb);
        else {
          assert.deepEqual(next.schematic.wires, t.nativeBaseline.schematic.wires);
          const physicalBoard = ({ nets: _nets, footprints, ...board }) => ({
            ...board,
            footprints: footprints.map((footprint) => ({
              ...footprint,
              pads: footprint.pads.map(({ netId: _netId, ...pad }) => pad),
            })),
          });
          assert.deepEqual(
            physicalBoard(next.pcb),
            physicalBoard(t.nativeBaseline.pcb),
            'Move retains package poses, pad geometry, copper and saved fills.',
          );
          assert.ok(next.pcb.footprints[0].pads.every((pad) => pad.netId === null));
          for (const net of t.nativeBaseline.pcb.nets)
            assert.deepEqual(
              next.pcb.nets.find((item) => item.id === net.id),
              net,
            );
          const retained = next.pcb.nets.filter(
            (net) => !t.nativeBaseline.pcb.nets.some((item) => item.id === net.id),
          );
          assert.equal(retained.length, 1);
          assert.match(retained[0].name, /^SIGNAL \(retained \d+\)$/);
        }
        await t.undo();
      },
    );

  for (const start of [
    {
      name: 'snapped free pointer',
      pointer: { x: 11, y: 13 },
      expected: { x: snap(11), y: snap(13) },
    },
    { name: 'exact component pin', pointer: leftPin, expected: leftPin },
    {
      name: 'existing wire interior',
      pointer: { x: 38.1, y: 45.72 },
      expected: { x: 38.1, y: 45.72 },
    },
  ])
    await run(`W begins at the ${start.name} without a document edit`, async (t) => {
      await t.startWire(start.pointer);
      assert.deepEqual(await t.draftStart(), start.expected);
      await t.expectClean();
      const end =
        start.name === 'existing wire interior'
          ? { x: start.expected.x, y: start.expected.y + 10.16 }
          : { x: start.expected.x + 10.16, y: start.expected.y + 5.08 };
      await t.move(end);
      await t.canvas.press('Enter');
      assert.equal(await t.draft().count(), 0);
      const next = await t.currentProject();
      assert.ok(
        hasEndpoint(next.schematic, start.expected),
        `Committed start ${JSON.stringify(start.expected)} is retained: ${JSON.stringify(next.schematic.wires)}`,
      );
      assert.ok(
        hasEndpoint(next.schematic, end),
        `Committed head ${JSON.stringify(end)} is retained: ${JSON.stringify(next.schematic.wires)}`,
      );
      if (start.name === 'existing wire interior') {
        assert.equal(
          next.schematic.wires.filter((wire) =>
            [wire.a, wire.b].some((p) => p.x === start.expected.x && p.y === start.expected.y),
          ).length,
          3,
        );
        assert.ok(
          next.schematic.junctions.some(
            (p) => p.x === start.expected.x && p.y === start.expected.y,
          ),
        );
      }
      await t.undo();
    });

  await run(
    'W retains an active route and Delete Backspace only roll back its draft',
    async (t) => {
      await t.click(first);
      const start = { x: 10.16, y: 10.16 };
      await t.startWire(start);
      await t.click({ x: 20.32, y: 10.16 });
      await t.click({ x: 20.32, y: 20.32 });
      await t.move({ x: 30.48, y: 25.4 });
      const original = await t.draft().getAttribute('d');
      assert.equal(await t.draft().getAttribute('data-wire-waypoints'), '2');
      await t.canvas.press('w');
      assert.equal(
        await t.draft().getAttribute('d'),
        original,
        'W does not reset an active route.',
      );
      await t.canvas.press('Backspace');
      const once = await t.draft().getAttribute('d');
      assert.equal(await t.draft().getAttribute('data-wire-waypoints'), '1');
      assert.notEqual(once, original);
      assert.deepEqual(await t.draftStart(), start);
      await t.canvas.press('Delete');
      assert.notEqual(await t.draft().getAttribute('d'), once);
      assert.equal(await t.draft().getAttribute('data-wire-waypoints'), '0');
      await t.canvas.press('Delete');
      await t.canvas.press('Delete');
      assert.equal(await t.draft().count(), 0, 'Backtracking the initial point cancels the route.');
      await t.expectClean();
      assert.equal(
        await t.selectedPart(first).evaluate((node) => node.classList.contains('is-selected')),
        true,
      );
      await t.canvas.press('Escape');
      assert.equal(await t.draft().count(), 0);
      assert.equal(
        await t.selectedPart(first).evaluate((node) => node.classList.contains('is-selected')),
        true,
      );
      await t.expectClean();
    },
  );

  await run(
    'Enter commits every waypoint and the live head in one whole-project edit',
    async (t) => {
      const points = [
        { x: 10.16, y: 10.16 },
        { x: 20.32, y: 10.16 },
        { x: 20.32, y: 20.32 },
        { x: 30.48, y: 25.4 },
      ];
      await t.startWire(points[0]);
      await t.click(points[1]);
      await t.click(points[2]);
      await t.move(points[3]);
      await t.expectClean();
      assert.match(await t.draft().getAttribute('d'), /L 30\.48 25\.4$/);
      await t.canvas.press('Enter');
      const next = await t.currentProject();
      for (const point of points) assert.ok(hasEndpoint(next.schematic, point));
      assert.deepEqual(next.pcb, t.nativeBaseline.pcb);
      await t.undo();
    },
  );

  await run(
    'Escape cancels the route before leaving Wire and preserves selection until Interaction',
    async (t) => {
      await t.click(first);
      await t.startWire({ x: 10.16, y: 10.16 });
      await t.click({ x: 20.32, y: 10.16 });
      await t.move({ x: 30.48, y: 25.4 });
      await t.canvas.press('Escape');
      assert.equal(await t.draft().count(), 0);
      assert.equal(
        await t.canvas.locator('..').evaluate((wrap) => wrap.classList.contains('tool-wire')),
        true,
        'Workbench background Escape cannot exit the drawing tool after route cancellation.',
      );
      assert.equal(
        await t.selectedPart(first).evaluate((node) => node.classList.contains('is-selected')),
        true,
      );
      await t.canvas.dispatchEvent('keydown', { key: 'Escape', repeat: true });
      assert.equal(
        await t.canvas.locator('..').evaluate((wrap) => wrap.classList.contains('tool-wire')),
        true,
        'A held Escape does not turn route cancellation into tool exit.',
      );
      await t.expectClean();

      const restart = { x: 12.7, y: 20.32 };
      await t.click(restart);
      assert.deepEqual(await t.draftStart(), restart, 'A click immediately starts the next route.');
      await t.canvas.press('Escape');
      assert.equal(await t.draft().count(), 0);
      await t.canvas.press('Escape');
      assert.equal(
        await t.canvas.locator('..').evaluate((wrap) => wrap.classList.contains('tool-select')),
        true,
      );
      assert.equal(
        await t.selectedPart(first).evaluate((node) => node.classList.contains('is-selected')),
        true,
        'Leaving Wire retains the existing selection.',
      );
      await t.canvas.press('Escape');
      assert.equal(
        await t.selectedPart(first).evaluate((node) => node.classList.contains('is-selected')),
        false,
        'Interaction Escape clears selection.',
      );
      await t.expectClean();
    },
  );

  await run(
    'Escape and switching tools cancel wire drafts while retaining selection',
    async (t) => {
      await t.click(first);
      for (const key of ['Escape', 'v']) {
        await t.startWire({ x: 10.16, y: 10.16 });
        await t.click({ x: 20.32, y: 10.16 });
        await t.move({ x: 30.48, y: 25.4 });
        await t.canvas.press(key);
        await t.draft().waitFor({ state: 'detached' });
        assert.equal(await t.draft().count(), 0, `${key} cancels the draft.`);
        assert.equal(
          await t.selectedPart(first).evaluate((node) => node.classList.contains('is-selected')),
          true,
        );
        await t.expectClean();
      }
    },
  );

  for (const end of [
    { name: 'free point', point: { x: 20.32, y: 20.32 } },
    { name: 'existing pin', point: rightPin },
    { name: 'existing wire', point: { x: 38.1, y: 45.72 } },
  ])
    await run(
      `double-click finishes at a ${end.name} once without a new zero-length draft`,
      async (t) => {
        const start = { x: 10.16, y: 10.16 };
        await t.startWire(start);
        await t.move(end.point);
        await t.doubleClick(end.point);
        assert.equal(await t.draft().count(), 0);
        const next = await t.currentProject();
        assert.ok(hasEndpoint(next.schematic, start));
        assert.ok(hasEndpoint(next.schematic, end.point));
        await t.undo();
      },
    );

  await run('Wire clicks never add transient probes', async (t) => {
    await t.button('SPICE Simulation').click();
    await t.page.getByRole('region', { name: 'Simulation settings', exact: true }).waitFor();
    // Opening the analysis panel requests a deferred fit before editing starts.
    await t.page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
    const dock = t.page.getByRole('region', { name: 'Simulation waveforms', exact: true });
    assert.equal(await dock.count(), 0);
    await t.startWire(leftPin);
    await t.click({ x: 35.56, y: 35.56 });
    await t.move({ x: 45.72, y: 40.64 });
    assert.equal(await dock.count(), 0);
    await t.expectClean();
    await t.canvas.press('Escape');
    assert.equal(await dock.count(), 0);
    await t.expectClean();
  });

  await run('Enter then immediate W reuses the live pointer without a mouse move', async (t) => {
    const start = { x: 10.16, y: 10.16 };
    const end = { x: 20.32, y: 20.32 };
    await t.startWire(start);
    await t.move(end);
    await t.canvas.press('Enter');
    assert.equal(await t.draft().count(), 0);
    await t.canvas.press('w');
    await t.draft().waitFor({ state: 'attached' });
    assert.deepEqual(await t.draftStart(), end);
    await t.canvas.press('Escape');
    const next = await t.currentProject();
    assert.ok(hasEndpoint(next.schematic, start));
    assert.ok(hasEndpoint(next.schematic, end));
    await t.undo();
  });

  await run('Backspace then immediate Enter commits only the retained waypoint', async (t) => {
    const start = { x: 10.16, y: 10.16 };
    const retained = { x: 20.32, y: 10.16 };
    const removed = { x: 20.32, y: 20.32 };
    await t.startWire(start);
    await t.click(retained);
    await t.click(removed);
    await t.canvas.press('Backspace');
    assert.equal(await t.draft().getAttribute('data-wire-waypoints'), '1');
    await t.expectClean();
    await t.canvas.press('Enter');
    const next = await t.currentProject();
    assert.ok(hasEndpoint(next.schematic, start));
    assert.ok(hasEndpoint(next.schematic, retained));
    assert.equal(
      hasEndpoint(next.schematic, removed),
      false,
      'A stale live cursor cannot restore the removed leg.',
    );
    const newWires = next.schematic.wires.filter(
      (wire) => !doc.wires.some((old) => old.id === wire.id),
    );
    assert.equal(newWires.length, 1);
    assert.equal(newWires[0].a.y, start.y);
    assert.equal(newWires[0].b.y, start.y);
    await t.undo();
  });

  await run('Backspace and Delete restore the posture saved before each waypoint', async (t) => {
    await t.startWire({ x: 10.16, y: 10.16 });
    await t.click({ x: 20.32, y: 20.32 });
    await t.canvas.press('/');
    await t.click({ x: 30.48, y: 30.48 });
    await t.canvas.press('/');
    await t.canvas.press('Backspace');
    await t.move({ x: 35.56, y: 35.56 });
    assert.match(await t.draft().getAttribute('d'), /L 20\.32 35\.56 L 35\.56 35\.56$/);
    await t.canvas.press('Delete');
    await t.move({ x: 35.56, y: 35.56 });
    assert.match(
      await t.draft().getAttribute('d'),
      /^M 10\.16 10\.16 L 35\.56 10\.16 L 35\.56 35\.56$/,
    );
    await t.expectClean();
    await t.canvas.press('Escape');
  });

  await run(
    'wire draft undo redo owns checkpoints and preserves the previous validated edit',
    async (t) => {
      await t.click(first);
      const value = t.inspector().getByLabel('Component value', { exact: true });
      await value.fill('22k');
      await value.press('Enter');
      assert.equal(await t.button('Undo').isEnabled(), true);
      await t.startWire({ x: 10.16, y: 10.16 });
      await t.click({ x: 20.32, y: 10.16 });
      await t.click({ x: 20.32, y: 20.32 });
      await t.canvas.press('Control+z');
      assert.equal(await t.draft().getAttribute('data-wire-waypoints'), '1');
      await t.canvas.press('Control+Shift+z');
      assert.equal(await t.draft().getAttribute('data-wire-waypoints'), '2');
      for (const key of ['Backspace', 'Delete']) {
        await t.canvas.press(key);
        assert.equal(await t.draft().getAttribute('data-wire-waypoints'), '1');
        await t.canvas.press('Control+Shift+z');
        assert.equal(await t.draft().getAttribute('data-wire-waypoints'), '2');
      }
      await t.canvas.dispatchEvent('keydown', { key: 'z', ctrlKey: true, repeat: true });
      assert.equal(await t.draft().getAttribute('data-wire-waypoints'), '2');
      await t.canvas.press('Control+z');
      await t.canvas.press('Control+z');
      assert.equal(await t.draft().getAttribute('data-wire-waypoints'), '0');
      await t.canvas.press('Control+z');
      assert.equal(await t.draft().count(), 0);
      await t.canvas.press('Control+Shift+z');
      assert.equal(await t.draft().getAttribute('data-wire-waypoints'), '0');
      await t.canvas.press('Control+Shift+z');
      assert.equal(await t.draft().getAttribute('data-wire-waypoints'), '1');
      assert.equal(
        await t.canvas.getByTestId(`annotation-value-${first.ref}`).textContent(),
        '22k',
      );
      await t.canvas.press('Escape');
      await t.canvas.press('Escape');
      await t.canvas.press('Control+Shift+z');
      assert.equal(await t.draft().count(), 0, 'Leaving Wire clears its local redo stack.');
      const next = await t.currentProject();
      assert.equal(next.schematic.parts.find((part) => part.id === first.id).value, '22k');
      assert.deepEqual(next.schematic.wires, t.nativeBaseline.schematic.wires);
      await t.undo();
    },
  );

  await run(
    'Explicit Sim.Params inspection restores Properties from the Simulation sidebar',
    async (t) => {
      await t.click(await t.glyph(`annotation-field-${first.ref}-Sim.Params`));
      await t.button('SPICE Simulation').click();
      const settings = t.page.getByRole('region', { name: 'Simulation settings', exact: true });
      await settings.waitFor();
      await t.page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
      await t.canvas.focus();
      await t.canvas.press('e');
      const input = t.inspector().getByLabel('Sim.Params text', { exact: true });
      await input.waitFor();
      assert.equal(await input.inputValue(), 'temp=25');
      assert.equal(await input.evaluate((node) => document.activeElement === node), true);
      assert.equal(await settings.isVisible(), false, 'Inspection closes the Simulation sidebar.');
      assert.equal(
        await t.page.getByTestId('schematic-properties-panel').isVisible(),
        true,
        'The ordinary Properties sidebar contains the field inspector.',
      );
      assert.equal(await t.button('SPICE Simulation').getAttribute('aria-pressed'), 'false');
      await t.expectClean();
      await input.click();
      await input.fill('temp=40');
      await input.press('Enter');
      const next = await t.currentProject();
      assert.equal(
        partFields(next.schematic.parts.find((part) => part.id === first.id))['Sim.Params'],
        'temp=40',
      );
      await t.undo();
    },
  );

  await run('Simulation keeps ordinary component Properties suppressed', async (t) => {
    await t.click(first);
    await t.button('SPICE Simulation').click();
    await t.page.getByRole('region', { name: 'Simulation settings', exact: true }).waitFor();
    await t.page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
    await t.canvas.focus();
    await t.canvas.press('e');
    assert.equal(await t.inspector().count(), 0);
    await t.expectClean();
  });

  await run(
    'a component with hidden reference and value remains editable through its stable inspector',
    async (t) => {
      const layers = await openSchematicPanel(t.page, 'Visible layers');
      for (const name of ['References', 'Values'])
        await layers.getByRole('checkbox', { name, exact: true }).uncheck();
      await closeDisplayDrawer(t.page, 'Visualization');
      assert.equal(await t.selectedPart(first).count(), 1);
      assert.equal(await t.canvas.getByTestId(`annotation-ref-${first.ref}`).count(), 0);
      await t.expectClean();
      await openSchematicPanel(t.page, 'List');
      await t.page
        .getByRole('dialog', { name: 'List', exact: true })
        .getByRole('button', { name: `Edit ${first.ref}`, exact: true })
        .click();
      const input = t.inspector().getByLabel('Component reference', { exact: true });
      await input.waitFor();
      assert.equal(await input.inputValue(), first.ref);
      await t
        .inspector()
        .getByRole('button', { name: 'Delete object', exact: true })
        .press('Enter');
      const next = await t.currentProject();
      assert.equal(
        next.schematic.parts.some((part) => part.id === first.id),
        false,
      );
      assert.equal(
        next.schematic.parts.some((part) => part.id === second.id),
        true,
      );
      assert.deepEqual(next.pcb.tracks, t.nativeBaseline.pcb.tracks);
      await t.undo();
    },
  );
} finally {
  await browser.close();
}
assert.ok(
  completed > 0,
  `No schematic hotkey cases matched ${JSON.stringify(process.argv[2] ?? '')}.`,
);
console.log(`Schematic hotkeys: ${completed} full Workspace cases passed.`);
