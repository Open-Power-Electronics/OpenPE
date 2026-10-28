import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { setTimeout as delay } from 'node:timers/promises';
import { bundledWorkbenchCatalog } from '../server/workbench-plugins.mjs';
import { setLayoutVisibility, toggleLayoutVisualization } from './visualization-test-helpers.mjs';

// Real DesktopWorkspace, Core and deferred engines. All native/service state is
// in memory; no Electron, user data, providers, model downloads or solver runs.
const { emptyCircuit, createPart, pinPositions, uid } = await tsImport(
  '../lib/circuit.ts',
  import.meta.url,
);
const { createProject, serializeProject } = await tsImport('../lib/project.ts', import.meta.url);
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const circuit = emptyCircuit();
circuit.title = 'ERC schematic';
circuit.parts.push(createPart(circuit, 'NMOS', 25.4, 25.4));
const ercProject = createProject(circuit);
ercProject.name = 'ERC fixture';
const boardProject = createProject(emptyCircuit());
boardProject.name = 'DRC fixture';
boardProject.pcb = createEmptyPCB();
const board = boardProject.pcb;
board.nets = [
  { id: uid(), name: 'OUT' },
  { id: uid(), name: 'GND' },
];
const boundary = [
  { x: -10, y: -10 },
  { x: 40, y: -10 },
  { x: 40, y: 40 },
  { x: -10, y: 40 },
];
board.graphics.push({
  id: uid(),
  kind: 'polygon',
  layer: 'Edge.Cuts',
  start: boundary[0],
  end: boundary.at(-1),
  points: boundary.slice(1, -1),
  width: 0.05,
});
board.tracks = [
  {
    id: uid(),
    start: { x: 0, y: 5 },
    end: { x: 10, y: 5 },
    width: 0.1,
    layer: 'F.Cu',
    netId: board.nets[0].id,
  },
  {
    id: uid(),
    start: { x: 5, y: 0 },
    end: { x: 5, y: 10 },
    width: 0.4,
    layer: 'F.Cu',
    netId: board.nets[1].id,
  },
];
const footprintId = uid(),
  padId = uid();
board.footprints.push({
  id: footprintId,
  symbolId: null,
  libraryId: 'Fixture:ThroughPad',
  reference: 'J1',
  value: 'Pad',
  x: 20,
  y: 20,
  rotation: 0,
  side: 'front',
  graphics: [],
  pads: [
    {
      id: padId,
      number: '1',
      x: 0,
      y: 0,
      rotation: 0,
      type: 'thru_hole',
      shape: 'circle',
      size: { x: 2, y: 2 },
      drill: 0.5,
      netId: null,
    },
  ],
});
const projectIds = [ercProject.id, boardProject.id];
const documentIds = [uid(), uid()];
const sources = [ercProject, boardProject].map(serializeProject);
let recovery = {
  version: 2,
  documents: sources.map((source, index) => ({
    id: documentIds[index],
    source,
    sourceDraft: null,
    dirty: false,
    filename: `${index ? 'drc' : 'erc'}.kicad_pro`,
    sessions: [{ id: `rules-session-${index}`, messages: [], draft: '' }],
    activeSessionId: `rules-session-${index}`,
  })),
  activeDocumentId: documentIds[0],
  provider: 'codex',
  effort: 'low',
  approvalMode: 'review',
  models: {},
};
const plugins = bundledWorkbenchCatalog();
plugins.plugins = plugins.plugins.map((plugin) => ({ ...plugin, enabled: false }));
const outputDirectory = path.resolve('test-results/design-rules-ui-bundle');
const bundle = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';
      import Workspace from './components/DesktopWorkspace';
      window.ruleTestCores={};window.ruleTestLayoutContexts={};createRoot(document.getElementById('root')).render(<Workspace/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  format: 'esm',
  splitting: true,
  minify: true,
  metafile: true,
  outdir: outputDirectory,
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [
    {
      name: 'observe-real-cores-for-test-edits',
      setup(plugin) {
        plugin.onLoad(
          { filter: /[\\/]components[\\/]LayoutEditor\.tsx$/ },
          async ({ path: file }) => {
            const original = await readFile(file, 'utf8');
            const marker = '    agentContextRef.current = context;';
            assert.ok(
              original.includes(marker),
              'Test observes the real Layout selection context.',
            );
            return {
              contents: original.replace(
                marker,
                `    window.ruleTestLayoutContexts[pcb.id]={selection,inspector,inspectedPadId};\n${marker}`,
              ),
              loader: 'tsx',
              resolveDir: path.dirname(file),
            };
          },
        );
        plugin.onLoad({ filter: /[\\/]core[\\/]project-core\.ts$/ }, async ({ path: file }) => {
          const original = await readFile(file, 'utf8');
          const marker = '    this.assertDraft(options.draft ?? null);';
          assert.ok(
            original.includes(marker),
            'Test instrumentation observes actual Core instances.',
          );
          return {
            contents: original.replace(
              marker,
              `    if(initialProject) window.ruleTestCores[initialProject.id]=this;\n${marker}`,
            ),
            loader: 'ts',
            resolveDir: path.dirname(file),
          };
        });
      },
    },
  ],
});
const outputs = bundle.metafile.outputs;
const entry = Object.keys(outputs).find((file) => outputs[file].entryPoint === '<stdin>');
function staticClosure(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const imported of outputs[file].imports)
    if (!imported.external && imported.kind !== 'dynamic-import')
      staticClosure(imported.path, seen);
  return seen;
}
const startupInputs = [...staticClosure(entry)].flatMap((file) =>
  Object.keys(outputs[file].inputs),
);
for (const engine of ['lib/schematic-erc.ts', 'lib/pcb-drc.ts'])
  assert.equal(startupInputs.includes(engine), false, `${engine} stays outside startup loading.`);
const files = new Map(
  bundle.outputFiles.map((file) => [
    '/bundles/' + path.relative(outputDirectory, file.path).replaceAll('\\', '/'),
    file,
  ]),
);
const engineChunk = (engine) =>
  '/bundles/' +
  path.basename(
    Object.keys(outputs).find((file) => outputs[file].entryPoint === `lib/${engine}.ts`),
  );
const ercChunk = engineChunk('schematic-erc'),
  drcChunk = engineChunk('pcb-drc');
const browser = await chromium.launch({
  headless: true,
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
});
let releaseERC;
const ercReady = new Promise((resolve) => {
  releaseERC = resolve;
});
try {
  const page = await browser.newPage({ viewport: { width: 1480, height: 920 } });
  page.setDefaultTimeout(15000);
  const errors = [],
    requested = new Set();
  let unexpectedRequests = 0;
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
      connection: async () => ({ base: 'http://localhost', token: 'rules-test' }),
      newFile: async () => crypto.randomUUID(),
      releaseFile: async () => {},
      setDirty: async () => {},
      onCloseRequested: () => () => {},
    };
  });
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    requested.add(url.pathname);
    if (files.has(url.pathname)) {
      if (url.pathname === ercChunk) await ercReady;
      const file = files.get(url.pathname);
      return route.fulfill({
        contentType: file.path.endsWith('.css') ? 'text/css' : 'text/javascript',
        body: file.text,
      });
    }
    if (url.pathname === '/api/state') {
      if (route.request().method() === 'POST') recovery = route.request().postDataJSON();
      return route.fulfill({ json: recovery });
    }
    if (url.pathname === '/api/appearance') return route.fulfill({ json: null });
    if (url.pathname === '/api/agents') return route.fulfill({ json: [] });
    if (url.pathname === '/api/models')
      return route.fulfill({ json: { models: [], defaultModel: '' } });
    if (url.pathname === '/api/workbench-plugins') return route.fulfill({ json: plugins });
    if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(url.pathname))
      return route.fulfill({
        contentType: url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        body: await readFile('public' + url.pathname),
      });
    if (url.pathname.startsWith('/api/')) {
      unexpectedRequests++;
      return route.fulfill({ status: 500, json: { error: `Unexpected request: ${url.pathname}` } });
    }
    return route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><div id="root"></div>',
    });
  });
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
    await page.addStyleTag({ content: file.text });
  await page.addScriptTag({
    type: 'module',
    url: 'http://localhost/bundles/' + path.basename(entry),
  });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const settled = async () => {
    // Successful writes hide the saving status. Observe persisted Core content
    // as well, so an undo cannot reuse the previous write's hidden status.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const states = await Promise.all(projectIds.map((_, index) => snapshot(index)));
      if (
        recovery.documents.every(
          (document, index) =>
            document.source === states[index].source &&
            document.sourceDraft === states[index].sourceDraft,
        )
      ) {
        await page.locator('.draft-status:visible').waitFor({ state: 'hidden' });
        return;
      }
      await delay(25);
    }
    assert.fail('Recovery did not persist the current Core content.');
  };
  const snapshot = (index) =>
    page.evaluate((id) => {
      const core = window.ruleTestCores[id],
        state = core.getSnapshot();
      return {
        source: state.source,
        sourceDraft: state.sourceDraft,
        revision: state.revision,
        undoDepth: state.undoDepth,
        redoDepth: state.redoDepth,
        native: core.getNativeFiles(),
      };
    }, projectIds[index]);
  const selectProject = async (index) => {
    await page
      .locator(`.project-navigation [data-project-id="${documentIds[index]}"] button:visible`)
      .click();
    await settled();
  };
  const panel = (kind) => page.getByRole('dialog', { name: `${kind} checks`, exact: true });
  const assertRulePlacement = async (kind, label) => {
    const action = page.locator(`button[aria-label="${label}"]`);
    assert.equal(
      await action.evaluate(
        (element) => !!element.closest('.editor-toolbar .editor-tool-group-end'),
      ),
      true,
      `${kind} belongs to the upper-right toolbar group.`,
    );
    assert.equal(
      (await action.textContent()).trim(),
      '',
      'Rule checks use the shared icon controls.',
    );
    const order = await action.evaluate((element) =>
      [...element.parentElement.querySelectorAll('button')]
        .map((button) => button.getAttribute('aria-label'))
        .slice(-4),
    );
    assert.deepEqual(order, [label, 'Parts list', 'Version history', 'Toggle right sidebar']);
    assert.equal(await panel(kind).getAttribute('aria-modal'), 'true');
    assert.equal(await panel(kind).evaluate((dialog) => dialog.matches(':modal')), true);
    const bounds = await panel(kind).boundingBox();
    const viewport = page.viewportSize();
    assert.ok(
      Math.abs(bounds.x + bounds.width / 2 - viewport.width / 2) <= 1,
      `${kind} opens as an independent centered window: ${JSON.stringify({ bounds, viewport })}`,
    );
    assert.equal(await panel(kind).locator('.inspector-resize').count(), 1);
    const grip = await panel(kind).locator('.inspector-resize').boundingBox();
    assert.ok(Math.abs(grip.x + grip.width - bounds.x - bounds.width) <= 2);
    assert.ok(Math.abs(grip.y + grip.height - bounds.y - bounds.height) <= 2);
  };
  const openERC = async () => {
    await button('Electrical rules (ERC)').click();
    await panel('ERC').waitFor();
    await assertRulePlacement('ERC', 'Electrical rules (ERC)');
  };
  const openDRC = async () => {
    await button('Design rules (DRC)').click();
    await panel('DRC').waitFor();
    await assertRulePlacement('DRC', 'Design rules (DRC)');
  };
  const unchanged = async (index, baseline, reason) =>
    assert.deepEqual(await snapshot(index), baseline, reason);
  const clean = (kind) =>
    panel(kind).getByText('No violations found in checked rules.', { exact: true });
  const layoutContext = () => page.evaluate((id) => window.ruleTestLayoutContexts[id], board.id);
  const markerUncovered = async (kind, testId) => {
    await panel(kind).waitFor({ state: 'detached' });
    await page.waitForFunction((testId) => {
      const marker = document.querySelector(
        `[data-testid="${testId}"] [data-rule-check-marker] circle`,
      );
      if (!marker) return false;
      const point = marker.getBoundingClientRect();
      const drawing = document.querySelector(`[data-testid="${testId}"]`).getBoundingClientRect();
      return (
        point.left >= drawing.left &&
        point.right <= drawing.right &&
        point.top >= drawing.top &&
        point.bottom <= drawing.bottom
      );
    }, testId);
  };
  await page.getByTestId('schematic-canvas').waitFor();
  await settled();
  assert.equal(
    await button('Simulation').count(),
    0,
    'Rule checks remain independent of disabled simulation plugins.',
  );
  assert.equal(
    await page
      .getByRole('group', { name: 'Schematic tools', exact: true })
      .locator('.editor-plugin-actions')
      .count(),
    0,
    'Unavailable plugins leave no empty toolbar group or separator.',
  );
  assert.equal(requested.has(ercChunk), false);
  assert.equal(requested.has(drcChunk), false);
  await openERC();
  assert.equal(requested.has(ercChunk), false, 'Opening the panel does not run an engine.');

  // Hold the first engine import to exercise the actual close barrier while a
  // query is pending. Availability changes may advance revision, never content.
  const beforeBarrier = await snapshot(0);
  await button('Run ERC').click();
  await panel('ERC').getByText('Checking ERC…', { exact: true }).waitFor();
  await page.evaluate(
    (id) => window.ruleTestCores[id].setEditingBlocked('Project is closing.'),
    projectIds[0],
  );
  await panel('ERC').getByText('Project is closing.', { exact: true }).waitFor();
  assert.equal(await button('Run ERC').isDisabled(), true);
  releaseERC();
  await page.waitForFunction(
    (id) => window.ruleTestCores[id].getSnapshot().editingBlocked !== null,
    projectIds[0],
  );
  await page.evaluate((id) => window.ruleTestCores[id].setEditingBlocked(null), projectIds[0]);
  await button('Run ERC').waitFor({ state: 'visible' });
  const afterBarrier = await snapshot(0);
  assert.deepEqual(
    { ...afterBarrier, revision: beforeBarrier.revision },
    beforeBarrier,
    'Lifecycle gates preserve canonical/native bytes and undo.',
  );
  await button('Run ERC').click();
  const ercIssue = panel('ERC').getByRole('button', {
    name: /Locate issue: Q1 pin 1 .*is unconnected/,
  });
  await ercIssue.waitFor();
  assert.equal(requested.has(ercChunk), true);
  await unchanged(0, afterBarrier, 'ERC queries do not change native files, revision or undo.');
  const schematic = page.getByTestId('schematic-canvas');
  const beforeView = await schematic.getAttribute('viewBox');
  await ercIssue.click();
  await schematic.locator('[data-rule-check-marker]').waitFor();
  await markerUncovered('ERC', 'schematic-canvas');
  assert.equal(
    await page.locator('.inspector:visible').count(),
    0,
    'ERC locating keeps Properties dismissed.',
  );
  assert.notEqual(
    await schematic.getAttribute('viewBox'),
    beforeView,
    'Locating ERC pans to the offending pin.',
  );
  assert.equal(
    await schematic
      .getByTestId('part-Q1')
      .evaluate((element) => element.classList.contains('is-selected')),
    true,
  );
  await unchanged(0, afterBarrier, 'Locating an issue changes presentation only.');
  await openERC();
  await button('Resize electrical rules').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await ercIssue.click();
  await markerUncovered('ERC', 'schematic-canvas');
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/design-rules-workspace-erc.png' });
  await openERC();

  // Source drafts invalidate a result and block another query without applying it.
  await page.evaluate((id) => {
    const core = window.ruleTestCores[id],
      files = core.getNativeFiles();
    core.updateNativeSource(files.entry, '{invalid native source');
  }, projectIds[0]);
  await panel('ERC').getByText('Apply Source edits before checking rules.').waitFor();
  assert.equal(await button('Recheck ERC').isDisabled(), true);
  assert.equal(await ercIssue.isDisabled(), true);
  assert.equal(await schematic.locator('[data-rule-check-marker]').count(), 0);
  await page.evaluate((id) => window.ruleTestCores[id].updateSource(null), projectIds[0]);
  await panel('ERC').getByText('Design or limits changed. Recheck ERC.').waitFor();
  assert.equal(
    await ercIssue.isDisabled(),
    true,
    'Clearing a draft does not revive an older revision report.',
  );
  const beforeFix = await snapshot(0);
  const nc = pinPositions(circuit.parts[0], circuit.libraries[circuit.parts[0].libId]).map(
    (point) => ({ id: uid(), ...point }),
  );
  await page.evaluate(
    ({ id, nc }) => {
      const core = window.ruleTestCores[id],
        project = core.getSnapshot().project;
      core.commitProject({ ...project, schematic: { ...project.schematic, noConnects: nc } });
    },
    { id: projectIds[0], nc },
  );
  await panel('ERC').getByText('Design or limits changed. Recheck ERC.').waitFor();
  const fixedERC = await snapshot(0);
  assert.equal(fixedERC.undoDepth, beforeFix.undoDepth + 1);
  await button('Recheck ERC').click();
  await clean('ERC').waitFor();
  await unchanged(0, fixedERC, 'Rechecking a repaired schematic adds no undo or native edits.');
  await page.evaluate((id) => window.ruleTestCores[id].undo(), projectIds[0]);
  await panel('ERC').getByText('Design or limits changed. Recheck ERC.').waitFor();
  assert.equal(
    (await snapshot(0)).source,
    sources[0],
    'One Core undo restores the original electrical fixture.',
  );
  await button('Recheck ERC').click();
  await ercIssue.waitFor();
  await button('Close dialog').click();
  await settled();
  assert.equal(
    recovery.documents[0].dirty,
    false,
    'Undoing to the original baseline clears dirty state.',
  );

  // Another project starts with its own report; switching editors retains only
  // that project's report/settings and clears presentation markers.
  await selectProject(1);
  await openERC();
  assert.equal(await panel('ERC').getByText('Not checked', { exact: true }).isVisible(), true);
  await button('Run ERC').click();
  await clean('ERC').waitFor();
  await button('Close dialog').click();
  await button('Layout').click();
  const layout = page.getByTestId('layout-canvas');
  await layout.waitFor();
  const boardBaseline = await snapshot(1);
  assert.equal(requested.has(drcChunk), false);
  await openDRC();
  assert.equal(
    requested.has(drcChunk),
    false,
    'Opening DRC settings does not load its geometry engine.',
  );
  await button('Run DRC').click();
  const widthIssue = panel('DRC').getByRole('button', {
    name: 'Locate issue: Track width 0.1 mm is below 0.2 mm.',
    exact: true,
  });
  const shortIssue = panel('DRC').getByRole('button', {
    name: /Locate issue: Track touches Track/,
  });
  await widthIssue.waitFor();
  await shortIssue.waitFor();
  assert.equal(requested.has(drcChunk), true);
  await unchanged(
    1,
    boardBaseline,
    'DRC inspects current copper without modifying its native bytes or undo.',
  );
  await shortIssue.click();
  await layout.locator('[data-rule-check-marker]').waitFor();
  await markerUncovered('DRC', 'layout-canvas');
  assert.equal(
    await page.locator('.layout-inspector:visible').count(),
    0,
    'DRC locating keeps Properties dismissed.',
  );
  await unchanged(1, boardBaseline, 'Locating a short remains a presentation action.');
  await toggleLayoutVisualization(page, 'Selection');
  await page
    .getByRole('group', { name: 'Selection', exact: true })
    .getByRole('checkbox', { name: 'Tracks', exact: true })
    .uncheck();
  await toggleLayoutVisualization(page, 'Selection');
  await openDRC();
  await shortIssue.click();
  await markerUncovered('DRC', 'layout-canvas');
  assert.deepEqual(
    (await layoutContext()).selection,
    [],
    'Filtered track violations locate only the marker.',
  );
  assert.equal((await layoutContext()).inspector, false);
  await toggleLayoutVisualization(page, 'Selection');
  await page
    .getByRole('group', { name: 'Selection', exact: true })
    .getByRole('checkbox', { name: 'Tracks', exact: true })
    .check();
  await toggleLayoutVisualization(page, 'Selection');
  await setLayoutVisibility(page, 'F.Cu', false);
  await openDRC();
  await shortIssue.click();
  await markerUncovered('DRC', 'layout-canvas');
  assert.deepEqual(
    (await layoutContext()).selection,
    [],
    'Hidden-layer violations locate only the marker.',
  );
  await setLayoutVisibility(page, 'F.Cu', true);
  await openDRC();
  const annular = panel('DRC').getByRole('spinbutton', {
    name: 'Minimum annular ring (mm)',
    exact: true,
  });
  await annular.fill('1');
  await button('Recheck DRC').click();
  const padIssue = panel('DRC').getByRole('button', {
    name: /Locate issue: J1 pad 1 has .*minimum annular ring/,
  });
  await padIssue.waitFor();
  await padIssue.click();
  await markerUncovered('DRC', 'layout-canvas');
  assert.deepEqual(
    (await layoutContext()).selection,
    [{ kind: 'footprint', id: footprintId }],
    'Footprint and pad issue IDs select the owner exactly once.',
  );
  assert.equal((await layoutContext()).inspector, false);
  await openDRC();
  await annular.fill('0.15');
  await button('Recheck DRC').click();
  await padIssue.waitFor({ state: 'detached' });
  await unchanged(
    1,
    boardBaseline,
    'Filters, visibility, pad locating and checking limits preserve native state.',
  );
  const minimum = panel('DRC').getByRole('spinbutton', {
    name: 'Minimum track width (mm)',
    exact: true,
  });
  await minimum.fill('0.05');
  await panel('DRC').getByText('Design or limits changed. Recheck DRC.').waitFor();
  assert.equal(await shortIssue.isDisabled(), true);
  await button('Recheck DRC').click();
  await shortIssue.waitFor();
  await widthIssue.waitFor({ state: 'detached' });
  await unchanged(
    1,
    boardBaseline,
    'Changing DRC thresholds never edits project settings, native bytes or undo.',
  );
  await page.screenshot({ path: 'test-results/design-rules-workspace-drc.png' });

  await page.evaluate((id) => {
    const core = window.ruleTestCores[id],
      project = core.getSnapshot().project;
    core.commitProject({
      ...project,
      pcb: {
        ...project.pcb,
        tracks: project.pcb.tracks.map((track, index) =>
          index === 1 ? { ...track, layer: 'B.Cu' } : track,
        ),
      },
    });
  }, projectIds[1]);
  await panel('DRC').getByText('Design or limits changed. Recheck DRC.').waitFor();
  assert.equal(await shortIssue.isDisabled(), true);
  const fixedDRC = await snapshot(1);
  await button('Recheck DRC').click();
  await clean('DRC').waitFor();
  await unchanged(1, fixedDRC, 'Rechecking the repaired PCB is read-only.');
  await button('Close dialog').click();
  await button('Schematic').click();
  await openERC();
  await panel('ERC').getByText('Design or limits changed. Recheck ERC.').waitFor();
  await button('Recheck ERC').click();
  await clean('ERC').waitFor();
  await unchanged(
    1,
    fixedDRC,
    'Refreshing another view checks the same current project without edits.',
  );
  await button('Close dialog').click();
  await button('Layout').click();
  await openDRC();
  assert.equal(
    await minimum.inputValue(),
    '0.05',
    'Per-project DRC settings survive view switches.',
  );
  await clean('DRC').waitFor();
  assert.equal(await layout.locator('[data-rule-check-marker]').count(), 0);
  await button('Close dialog').click();
  await page.evaluate((id) => window.ruleTestCores[id].undo(), projectIds[1]);
  await settled();
  assert.equal((await snapshot(1)).source, sources[1]);
  assert.equal(recovery.documents[1].dirty, false);
  await page.evaluate((id) => {
    const core = window.ruleTestCores[id],
      project = core.getSnapshot().project;
    core.commitProject({ ...project, pcb: { ...project.pcb, graphics: [] } });
  }, projectIds[1]);
  await button('Zoom in').click();
  await button('Zoom in').click();
  const beforeOutlineFit = await layout.getAttribute('viewBox');
  const noOutline = await snapshot(1);
  await openDRC();
  await button('Recheck DRC').click();
  const outlineIssue = panel('DRC').locator('li:has(span[aria-description="pcb.outline"]) button');
  await outlineIssue.waitFor();
  await outlineIssue.click();
  await page.waitForFunction(
    (previous) =>
      document.querySelector('[data-testid="layout-canvas"]').getAttribute('viewBox') !== previous,
    beforeOutlineFit,
  );
  assert.deepEqual(
    (await layoutContext()).selection,
    [],
    'Board-wide issues clear selection and fit the board.',
  );
  assert.equal(
    await layout.locator('[data-rule-check-marker]').count(),
    0,
    'A board-wide issue does not invent a point marker.',
  );
  await unchanged(1, noOutline, 'Locating a board-wide issue changes only the viewport.');
  await panel('DRC').waitFor({ state: 'detached' });
  await page.evaluate((id) => window.ruleTestCores[id].undo(), projectIds[1]);
  await settled();
  await selectProject(0);
  await openERC();
  await ercIssue.waitFor();
  assert.equal(await schematic.locator('[data-rule-check-marker]').count(), 0);
  await button('Close dialog').click();
  await settled();
  assert.deepEqual(
    recovery.documents.map((document) => document.source),
    sources,
  );
  assert.equal(
    recovery.documents.every((document) => !document.dirty && document.sourceDraft === null),
    true,
  );
  assert.equal(
    /"(ruleReports|ruleFocus|drcSettings|checkedRules|issues)"/.test(JSON.stringify(recovery)),
    false,
    'Reports, focus markers and checking limits never enter recovery.',
  );
  assert.equal(
    unexpectedRequests,
    0,
    'Checks do not call solver, provider or filesystem service routes.',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Workspace rule checks passed: lazy engines; ERC/DRC locate, stale, repair/recheck and undo; Source/close gates; independent projects/views; unchanged native bytes and transient recovery state.',
  );
} finally {
  releaseERC();
  await browser.close();
}
