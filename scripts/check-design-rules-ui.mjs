import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultAgentPreferences } from '../server/workspace-format.mjs';
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
  models: { ...defaultAgentPreferences.models },
};
const plugins = bundledWorkbenchCatalog();
plugins.plugins = plugins.plugins.map((plugin) => ({ ...plugin, enabled: false }));
const outputDirectory = path.resolve('test-results/design-rules-ui-bundle');
const bundle = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';
      import Workspace from './components/DesktopWorkspace';
      window.ruleTestCores={};window.ruleTestLayoutContexts={};window.ruleTestRuns=[];window.ruleTestInitialDelays={};createRoot(document.getElementById('root')).render(<Workspace/>);`,
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
        plugin.onLoad({ filter: /[\\/]components[\\/]Workbench\.tsx$/ }, async ({ path: file }) => {
          const original = await readFile(file, 'utf8');
          const marker = '      if (remaining > 0) {';
          assert.ok(original.includes(marker), 'Test observes the real rule scheduler delay.');
          return {
            contents: original.replace(
              marker,
              `      window.ruleTestInitialDelays[kind] ??= Math.max(0, remaining);\n${marker}`,
            ),
            loader: 'tsx',
            resolveDir: path.dirname(file),
          };
        });
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
            contents: original
              .replace(
                'private async checkRules(id: string, args: Record<string, any>, signal?: AbortSignal) {',
                `private async checkRules(id: string, args: Record<string, any>, signal?: AbortSignal) {
    window.ruleTestRuns.push(id);
    if(window.ruleTestFailures?.[id]) {
      window.ruleTestFailures[id]--;
      throw new Error('Fixture rule check failed.');
    }`,
              )
              .replace(
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
// Footprint drawing also uses the DRC implementation for its edit validation.
assert.equal(
  startupInputs.includes('lib/schematic-erc.ts'),
  false,
  'ERC stays outside startup loading.',
);
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
let releaseERC, releaseDRC;
const ercReady = new Promise((resolve) => {
  releaseERC = resolve;
});
const drcReady = new Promise((resolve) => {
  releaseDRC = resolve;
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
      listExamples: async () => ({ entries: [], warnings: [] }),
      listRecent: async () => ({ initialized: true, entries: [], warnings: [] }),
      onRecentChanged: () => () => {},
      projectDirectory: async () => ({ entries: [], truncated: false }),
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
      if (url.pathname === drcChunk) await drcReady;
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
    if (url.pathname === '/api/agent-settings')
      return route.fulfill({ json: { followUpMode: 'queue' } });
    if (url.pathname === '/api/appearance') return route.fulfill({ json: null });
    if (url.pathname === '/api/agents') return route.fulfill({ json: [] });
    if (url.pathname === '/api/models')
      return route.fulfill({ json: { models: [], defaultModel: '' } });
    if (url.pathname === '/api/workbench-plugins') return route.fulfill({ json: plugins });
    if (url.pathname === '/api/libraries/footprints')
      return route.fulfill({ json: { footprint: ['footprint', '"Fixture"'], models: [] } });
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
  await page.evaluate(() => {
    const requestIdle = window.requestIdleCallback.bind(window);
    const cancelIdle = window.cancelIdleCallback.bind(window);
    let waiting;
    window.requestIdleCallback = (callback, options) => {
      if (options || !window.releaseRuleIdle) return requestIdle(callback, options);
      waiting = callback;
      window.ruleIdleWaiting = true;
      return -1;
    };
    window.cancelIdleCallback = (id) => {
      if (id === -1) {
        waiting = undefined;
        window.ruleIdleWaiting = false;
      } else cancelIdle(id);
    };
    window.holdRuleIdle = () => {
      window.releaseRuleIdle = () => {
        window.releaseRuleIdle = undefined;
        window.ruleIdleWaiting = false;
        const callback = waiting;
        waiting = undefined;
        callback?.({ didTimeout: false, timeRemaining: () => 20 });
      };
    };
    window.holdRuleIdle();
  });
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
    await page.addStyleTag({ content: file.text });
  await page.addScriptTag({
    type: 'module',
    url: 'http://localhost/bundles/' + path.basename(entry),
  });
  const recoveryToast = page.getByRole('status').filter({
    hasText: 'Recovered your previous project draft.',
  });
  await recoveryToast.waitFor();
  assert.equal(await recoveryToast.getByRole('button').count(), 0);
  await recoveryToast.waitFor({ state: 'hidden', timeout: 3000 });
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
      .locator(
        `.project-navigation [data-project-id="${documentIds[index]}"] button.navigation-button:visible`,
      )
      .click();
    await settled();
  };
  const panel = () => page.getByRole('dialog', { name: 'Rule', exact: true });
  const ruleButton = button('Rule');
  const assertRulePlacement = async (kind) => {
    const action = page.locator('button[aria-label="Rule"]:visible');
    assert.equal(await action.count(), 1, 'Rule uses one footer summary.');
    assert.equal(
      await action.evaluate((element) => !!element.closest('.status-bar')),
      true,
      'Rule opens from the error/warning counts in the editor footer.',
    );
    assert.equal(await action.locator('.rule-status-count').count(), 2);
    assert.equal(
      await action.locator('[data-rule-warnings]').evaluate((element) => {
        const probe = document.createElement('span');
        probe.style.color =
          Number(element.getAttribute('data-rule-warnings')) > 0
            ? 'var(--rule-warning-ink)'
            : 'var(--muted)';
        element.append(probe);
        const expectedColor = getComputedStyle(probe).color;
        probe.remove();
        return getComputedStyle(element).color === expectedColor;
      }),
      true,
      'Footer warnings are amber for positive counts and gray otherwise.',
    );
    const order = await page
      .locator('.editor-mode-actions:visible')
      .evaluate((element) =>
        [...element.querySelectorAll('button')].map((button) => button.getAttribute('aria-label')),
      );
    const sourceView =
      (await page.locator('.editor').getAttribute('data-editor-view')) === 'source';
    assert.deepEqual(order, [
      'Draw component',
      'List',
      'Git',
      ...(sourceView ? [] : ['Toggle right sidebar']),
    ]);
    assert.equal(await page.locator('.editor-mode-actions [aria-label="Rule"]').count(), 0);
    assert.equal(await page.getByRole('combobox', { name: 'Editor mode', exact: true }).count(), 0);
    assert.equal(await page.locator('.editor-toolbar [aria-label="Rule"]').count(), 0);
    const bounds = await panel(kind).boundingBox();
    const drawing = await panel(kind).locator('xpath=../..').boundingBox();
    const footer = await action
      .locator('xpath=ancestor::*[contains(@class, "status-bar")]')
      .first()
      .boundingBox();
    const trigger = await action.boundingBox();
    assert.ok(Math.abs(bounds.x - trigger.x) <= 1);
    const maxWidths = { ERC: 384, DRC: 384, Model: 480 };
    const maxWidth = maxWidths[kind];
    assert.ok(bounds.width <= maxWidth + 1 && bounds.width <= drawing.width - 8);
    assert.ok(bounds.y > drawing.y);
    assert.ok(Math.abs(bounds.y + bounds.height + 8 - footer.y) <= 2);
    assert.equal(await panel(kind).getByRole('tab').count(), 0);
    if (kind === 'Model')
      await panel(kind).getByRole('separator', { name: 'Resize Rule panel' }).waitFor();
    assert.equal(await page.locator('dialog[open]').count(), 0);
    assert.equal(await ruleButton.getAttribute('aria-expanded'), 'true');
    assert.equal(
      await ruleButton.getAttribute('aria-controls'),
      await panel(kind).getAttribute('id'),
    );
  };
  const runCount = (id) =>
    page.evaluate((id) => window.ruleTestRuns.filter((value) => value === id).length, id);
  const waitForRun = (id, count) =>
    page.waitForFunction(
      ({ id, count }) => window.ruleTestRuns.filter((value) => value === id).length >= count,
      { id, count },
    );
  const assertUnknownCounts = async (state) => {
    for (const severity of ['errors', 'warnings']) {
      const count = ruleButton.locator(`[data-rule-${severity}]`);
      assert.equal(await count.getAttribute(`data-rule-${severity}`), 'unknown');
      assert.equal((await count.textContent()).trim(), '—');
    }
    const text = await ruleButton.textContent();
    if (state) assert.ok(text.includes(state));
    else assert.doesNotMatch(text, /Outdated|Checking/);
  };
  const waitForFooterCounts = async () => {
    await page.waitForFunction(() => {
      const counts = [...document.querySelectorAll('.rule-status')].find(
        (element) => element.getClientRects().length,
      );
      return (
        counts &&
        ['errors', 'warnings'].every((label) =>
          /^\d+$/.test(
            counts.querySelector(`[data-rule-${label}]`)?.getAttribute(`data-rule-${label}`) ?? '',
          ),
        )
      );
    });
  };
  const assertCurrentCounts = async (kind) => {
    for (const [severity, label] of [
      ['error', 'errors'],
      ['warning', 'warnings'],
    ]) {
      const expected = await panel(kind).locator(`button[data-severity="${severity}"]`).count();
      const count = ruleButton.locator(`[data-rule-${label}]`);
      assert.equal(await count.getAttribute(`data-rule-${label}`), String(expected));
      assert.equal((await count.textContent()).trim(), String(expected));
      if (severity === 'warning') {
        assert.equal(await count.locator('svg.lucide-triangle-alert').count(), 1);
        assert.equal(
          await count.evaluate((element, hasWarnings) => {
            const probe = document.createElement('span');
            probe.style.color = hasWarnings ? 'var(--rule-warning-ink)' : 'var(--muted)';
            document.body.append(probe);
            const expectedColor = getComputedStyle(probe).color;
            probe.remove();
            return getComputedStyle(element).color === expectedColor;
          }, expected > 0),
          true,
          'The warning triangle keeps its shape and changes color with the count.',
        );
      }
      if (severity === 'error' && expected > 0) {
        assert.equal(await count.locator('svg.lucide-circle-x').count(), 1);
        assert.equal(await count.locator('svg.lucide-circle-check').count(), 0);
      }
      if (
        severity === 'error' &&
        expected === 0 &&
        (await ruleButton.getAttribute('data-complete')) === 'true'
      ) {
        assert.equal(await count.locator('svg.lucide-circle-check').count(), 1);
        assert.equal(await count.locator('svg.lucide-circle-x').count(), 0);
        assert.equal(
          await count.evaluate((element) => {
            const probe = document.createElement('span');
            probe.style.color = 'var(--brand-ink)';
            document.body.append(probe);
            const expectedColor = getComputedStyle(probe).color;
            probe.remove();
            return getComputedStyle(element).color === expectedColor;
          }),
          true,
          'A complete current check with no errors shows the error count in green.',
        );
      }
    }
  };
  const assertViewReport = async () => {
    const view = await page.locator('.editor').getAttribute('data-editor-view');
    const expected = view === '3d' ? 'Model checks' : view === 'layout' ? 'DRC' : 'ERC';
    await panel().getByRole('heading', { name: expected, exact: true }).waitFor();
  };
  const waitForRuleReady = (kind) =>
    panel(kind)
      .getByRole('button', { name: new RegExp(`^(Run|Recheck) ${kind}$`) })
      .and(panel(kind).locator('button:enabled'))
      .waitFor();
  const openERC = async (wait = true, keyboard = false) => {
    const count = await runCount('schematic.erc');
    if (keyboard) {
      await ruleButton.focus();
      await page.keyboard.press('Enter');
    } else await ruleButton.click();
    await panel('ERC').waitFor();
    await assertViewReport();
    await assertRulePlacement('ERC');
    await waitForRun('schematic.erc', count + 1);
    if (wait) await waitForRuleReady('ERC');
    assert.equal(
      await runCount('schematic.erc'),
      count + 1,
      'Opening ERC queues exactly one idle ERC check.',
    );
  };
  const openDRC = async () => {
    const count = await runCount('layout.drc');
    await ruleButton.click();
    await panel('DRC').waitFor();
    await assertViewReport();
    await assertRulePlacement('DRC');
    await waitForRun('layout.drc', count + 1);
    await waitForRuleReady('DRC');
    assert.equal(
      await runCount('layout.drc'),
      count + 1,
      'Opening DRC queues exactly one idle DRC check.',
    );
  };
  const unchanged = async (index, baseline, reason) =>
    assert.deepEqual(await snapshot(index), baseline, reason);
  const clean = (kind) => panel(kind).getByText('No violations', { exact: true });
  const layoutContext = () => page.evaluate((id) => window.ruleTestLayoutContexts[id], board.id);
  const markerUncovered = async (kind, testId) => {
    assert.equal(await panel(kind).isVisible(), true, 'Locating keeps Rule open.');
    await page.waitForFunction((testId) => {
      const marker = document.querySelector(
        `[data-testid="${testId}"] [data-rule-check-marker] circle`,
      );
      if (!marker) return false;
      const point = marker.getBoundingClientRect();
      const drawing = document.querySelector(`[data-testid="${testId}"]`).getBoundingClientRect();
      const popup = document
        .querySelector('[role="dialog"][aria-label="Rule"]')
        .getBoundingClientRect();
      return (
        point.left >= drawing.left &&
        point.right <= drawing.right &&
        point.top >= drawing.top &&
        point.bottom <= drawing.bottom &&
        (point.left >= popup.right || point.bottom <= popup.top)
      );
    }, testId);
  };
  const assertWindowResize = async (testId) => {
    const canvas = page.getByTestId(testId);
    await canvas.waitFor();
    const viewport = page.viewportSize();
    const measure = () =>
      canvas.evaluate((svg) => {
        const { x, y, width, height } = svg.viewBox.baseVal;
        const chat = document.querySelector('.chat-panel:not([hidden])');
        const composer = chat.querySelector('.composer');
        const transcript = chat.querySelector('.chat-transcript');
        const editor = svg.closest('.editor');
        const left = chat.getBoundingClientRect().left;
        return {
          center: [x + width / 2, y + height / 2],
          scale: width / svg.getBoundingClientRect().width,
          gap: editor.getBoundingClientRect().left - composer.getBoundingClientRect().right,
          leftInsets: [
            parseFloat(getComputedStyle(chat.querySelector('.chat-header')).paddingLeft),
            composer.getBoundingClientRect().left - left,
            transcript.getBoundingClientRect().left - left,
          ],
        };
      });
    const before = await measure();
    for (const size of [{ width: 3840, height: 2088 }, viewport]) {
      await page.setViewportSize(size);
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      const after = await measure();
      assert.ok(Math.abs(after.gap - 12) < 1, 'The Agent-to-editor gap stays at 12 px.');
      assert.deepEqual(after.leftInsets, [12, 12, 12], 'Agent content keeps its left inset.');
      assert.ok(Math.abs(after.scale - before.scale) < 0.001, 'Window resize keeps drawing scale.');
      assert.ok(
        after.center.every((coordinate, axis) => Math.abs(coordinate - before.center[axis]) < 0.1),
        `Window resize keeps the drawing center: ${before.center} → ${after.center}.`,
      );
    }
  };
  await assertWindowResize('schematic-canvas');
  await settled();
  assert.equal(await button('Refresh rules').count(), 0);
  assert.equal(
    await button('SPICE Simulation').count(),
    0,
    'Rule remain independent of disabled simulation plugins.',
  );
  assert.equal(
    await page
      .getByRole('group', { name: 'Schematic tools', exact: true })
      .locator('.editor-plugin-actions')
      .count(),
    0,
    'Unavailable plugins leave no empty toolbar group or separator.',
  );
  assert.equal(requested.has(drcChunk), false);
  await page.waitForFunction(() => window.ruleIdleWaiting);
  assert.equal(
    await page.evaluate(() => window.ruleTestInitialDelays.erc),
    0,
    'An untouched project queues its first ERC without a settle timer.',
  );
  assert.equal(await runCount('schematic.erc'), 0, 'Settling alone cannot start a check.');
  await page.evaluate(() => {
    window.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 9, buttons: 1 }));
    window.releaseRuleIdle();
  });
  await delay(1700);
  assert.equal(await runCount('schematic.erc'), 0, 'A held pointer defers the idle check.');
  await page.evaluate(() => {
    window.holdRuleIdle();
    window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 9 }));
  });
  await page.waitForFunction(() => window.ruleIdleWaiting);
  assert.equal(await runCount('schematic.erc'), 0, 'Pointer cancellation queues a new idle check.');
  await page.evaluate(() => window.releaseRuleIdle());
  await page.waitForFunction(() => window.ruleTestRuns.includes('schematic.erc'));
  await page.waitForFunction(() =>
    document.querySelector('.rule-status[aria-description*="Checking"]'),
  );
  assert.equal(
    requested.has(ercChunk),
    true,
    'The active workspace automatically loads its current check after settling.',
  );
  await assertUnknownCounts('Checking…');
  assert.equal(await panel().count(), 0, 'Automatic checks do not open Rule.');
  assert.equal(await page.locator('.editor-mode-actions [aria-label="Rule"]').count(), 0);
  assert.equal(
    await ruleButton.evaluate((element) => {
      for (const key of ['Enter', ' ']) {
        const event = new KeyboardEvent('keydown', {
          key,
          keyCode: 229,
          bubbles: true,
          cancelable: true,
        });
        element.dispatchEvent(event);
        if (!event.defaultPrevented) return false;
      }
      return true;
    }),
    true,
    'IME activation cannot open a window or run a check.',
  );
  assert.equal(await runCount('schematic.erc'), 1, 'IME does not add a second automatic check.');
  assert.equal(await panel('ERC').count(), 0);
  await openERC(false);
  assert.equal(
    requested.has(ercChunk),
    true,
    'Opening ERC keeps the lazy engine available for the idle refresh.',
  );

  // Hold the first engine import to exercise the actual close barrier while a
  // query is pending. Availability changes may advance revision, never content.
  const beforeBarrier = await snapshot(0);
  await panel('ERC').getByText('Checking ERC…', { exact: true }).waitFor();
  await assertUnknownCounts('Checking…');
  await page.evaluate(
    (id) => window.ruleTestCores[id].setEditingBlocked('Project is closing.'),
    projectIds[0],
  );
  await panel('ERC').getByText('Project is closing.', { exact: true }).waitFor();
  assert.equal(await button('Run ERC').isDisabled(), true);
  assert.equal(await page.locator('button[aria-label="Rule"]:visible').isDisabled(), true);
  releaseERC();
  await page.waitForFunction(
    (id) => window.ruleTestCores[id].getSnapshot().editingBlocked !== null,
    projectIds[0],
  );
  await page.evaluate((id) => {
    window.holdRuleIdle();
    window.ruleTestCores[id].setEditingBlocked(null);
  }, projectIds[0]);
  await page.waitForFunction(() => window.ruleIdleWaiting);
  await button('Run ERC').waitFor({ state: 'visible' });
  const afterBarrier = await snapshot(0);
  assert.deepEqual(
    { ...afterBarrier, revision: beforeBarrier.revision },
    beforeBarrier,
    'Lifecycle gates preserve canonical/native bytes and undo.',
  );
  await button('Run ERC').click();
  await page.evaluate(() => window.releaseRuleIdle());
  const ercIssue = panel('ERC').getByRole('button', {
    name: /Locate issue: Q1 pin 1 .*is unconnected/,
  });
  await ercIssue.waitFor();
  await assertCurrentCounts('ERC');
  await button('Close Rule').click();
  await page.evaluate(() => window.holdRuleIdle());
  const beforeIdleOpen = await runCount('schematic.erc');
  await ruleButton.click();
  await ercIssue.waitFor();
  assert.equal(await ercIssue.isEnabled(), true, 'The retained report is available immediately.');
  await page.waitForFunction(() => window.ruleIdleWaiting);
  assert.equal(await runCount('schematic.erc'), beforeIdleOpen, 'Opening waits for browser idle.');
  await button('Recheck ERC').click();
  await waitForRun('schematic.erc', beforeIdleOpen + 1);
  await page.waitForFunction(() => !window.ruleIdleWaiting);
  await page.evaluate(() => window.releaseRuleIdle());
  await waitForFooterCounts();
  assert.equal(
    await runCount('schematic.erc'),
    beforeIdleOpen + 1,
    'Recheck replaces the idle run.',
  );
  assert.equal(await ercIssue.getAttribute('title'), null);
  assert.equal(await ercIssue.locator('button, input, a').count(), 0);
  assert.equal(await panel('ERC').locator('.lucide-locate-fixed').count(), 0);
  const ercRowBox = await ercIssue.boundingBox();
  const ercItemBox = await ercIssue.locator('..').boundingBox();
  assert.ok(
    Math.abs(ercRowBox.x - ercItemBox.x) <= 1 && Math.abs(ercRowBox.width - ercItemBox.width) <= 1,
    'ERC locating covers the entire issue row.',
  );
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/design-rules-panel-erc.png' });
  assert.equal(requested.has(ercChunk), true);
  await unchanged(0, afterBarrier, 'ERC queries do not change native files, revision or undo.');
  const schematic = page.getByTestId('schematic-canvas');
  const beforeView = await schematic.getAttribute('viewBox');
  await ercIssue.click({ position: { x: ercRowBox.width / 2, y: ercRowBox.height / 2 } });
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
  await button('Source').click();
  await openERC();
  const sourceERCRuns = await runCount('schematic.erc');
  await ercIssue.click();
  await schematic.waitFor();
  await markerUncovered('ERC', 'schematic-canvas');
  assert.equal(await runCount('schematic.erc'), sourceERCRuns);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/design-rules-workspace-erc.png' });

  // Source drafts invalidate a result and block another query without applying it.
  await page.evaluate((id) => {
    const core = window.ruleTestCores[id],
      files = core.getNativeFiles();
    core.updateNativeSource(files.entry, '{invalid native source');
  }, projectIds[0]);
  await panel('ERC').getByText('Apply Source edits before checking rules.').waitFor();
  assert.equal(await button('Recheck ERC').isDisabled(), true);
  assert.equal(await page.locator('button[aria-label="Rule"]:visible').isDisabled(), true);
  assert.equal(await ercIssue.isDisabled(), true);
  assert.equal(await schematic.locator('[data-rule-check-marker]').count(), 0);
  await page.evaluate((id) => {
    window.holdRuleIdle();
    window.ruleTestCores[id].updateSource(null);
  }, projectIds[0]);
  await page.waitForFunction(() => window.ruleIdleWaiting);
  await assertUnknownCounts();
  assert.equal(
    await panel('ERC')
      .getByText(/Outdated|Design or limits changed/)
      .count(),
    0,
  );
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
  const fixedERC = await snapshot(0);
  assert.equal(fixedERC.undoDepth, beforeFix.undoDepth + 1);
  await page.evaluate(() => window.releaseRuleIdle());
  await clean('ERC').waitFor();
  await assertCurrentCounts('ERC');
  await unchanged(0, fixedERC, 'Rechecking a repaired schematic adds no undo or native edits.');
  await page.evaluate((id) => window.ruleTestCores[id].undo(), projectIds[0]);
  assert.equal(
    (await snapshot(0)).source,
    sources[0],
    'One Core undo restores the original electrical fixture.',
  );
  await button('Recheck ERC').click();
  await ercIssue.waitFor();
  await button('Close Rule').click();
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
  await clean('ERC').waitFor();
  await button('Close Rule').click();
  const layout = page.getByTestId('layout-canvas');
  assert.equal(requested.has(drcChunk), false);
  const beforeLayoutAdmission = await snapshot(1);
  const initialDRCRuns = await runCount('layout.drc');
  await button('Layout').click();
  await page.waitForFunction(() => window.ruleTestRuns.includes('layout.drc'));
  assert.ok(
    (await page.evaluate(() => window.ruleTestInitialDelays.drc)) <= 50,
    'First Layout admission waits only for the short quiet-input interval.',
  );
  await assertUnknownCounts('Checking…');
  assert.equal(await panel().count(), 0, 'First Layout admission checks DRC without opening Rule.');
  // Opening Rule cancels the previous check and queues a refresh for idle time.
  // Closing it must restart the missing check instead of stranding the footer.
  await ruleButton.click();
  await assertViewReport();
  await panel().getByRole('heading', { name: 'DRC', exact: true }).waitFor();
  await panel().getByText('Checking DRC…', { exact: true }).waitFor();
  const beforePanelCloseRuns = await runCount('layout.drc');
  await ruleButton.click();
  await panel().waitFor({ state: 'detached' });
  assert.equal(await ruleButton.getAttribute('aria-expanded'), 'false');
  assert.equal(await ruleButton.evaluate((element) => document.activeElement === element), true);
  releaseDRC();
  await waitForFooterCounts();
  assert.equal(
    await runCount('layout.drc'),
    beforePanelCloseRuns + 1,
    'Closing Rule restarts one cancelled current-view DRC check.',
  );
  assert.ok(beforePanelCloseRuns > initialDRCRuns);
  assert.equal(await panel().count(), 0);
  await assertWindowResize('layout-canvas');
  await unchanged(
    1,
    beforeLayoutAdmission,
    'Automatic Layout DRC leaves the complete native project and undo unchanged.',
  );

  // A failure is attempted once per exact basis. Opening Rule can retry it.
  const beforeFailure = await snapshot(1);
  await page.evaluate((id) => {
    window.ruleTestFailures = { 'layout.drc': 1 };
    const core = window.ruleTestCores[id];
    core.setEditingBlocked('Fixture revision barrier.');
    core.setEditingBlocked(null);
  }, projectIds[1]);
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.rule-status')].some(
      (element) => element.getClientRects().length && element.textContent.includes('Check failed'),
    ),
  );
  await assertUnknownCounts('Check failed');
  const failedRuns = await runCount('layout.drc');
  await delay(1700);
  assert.equal(
    await runCount('layout.drc'),
    failedRuns,
    'A failed automatic basis does not retry in a loop.',
  );
  await ruleButton.click();
  await panel().getByText('Checking DRC…', { exact: true }).waitFor({ state: 'hidden' });
  await waitForFooterCounts();
  assert.equal(
    await runCount('layout.drc'),
    failedRuns + 1,
    'Opening Rule retries a failed basis exactly once.',
  );
  await button('Close Rule').click();
  const afterFailure = await snapshot(1);
  assert.deepEqual({ ...afterFailure, revision: beforeFailure.revision }, beforeFailure);

  const beforeRapid = await runCount('layout.drc');
  await page.evaluate(async (id) => {
    const core = window.ruleTestCores[id];
    for (let index = 0; index < 3; index++) {
      core.setEditingBlocked('Fixture changing revision.');
      core.setEditingBlocked(null);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }, projectIds[1]);
  await waitForFooterCounts();
  assert.equal(
    await runCount('layout.drc'),
    beforeRapid + 1,
    'Rapid revisions coalesce into one settled check.',
  );
  const beforePending = await runCount('layout.drc');
  await page.evaluate((id) => {
    const core = window.ruleTestCores[id];
    core.updateNativeSource(core.getNativeFiles().entry, '{invalid native source');
  }, projectIds[1]);
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[aria-label="Rule"]')].some(
      (element) => element.getClientRects().length && element.disabled,
    ),
  );
  await delay(1700);
  assert.equal(
    await runCount('layout.drc'),
    beforePending,
    'Pending Source blocks automatic checks.',
  );
  await page.evaluate((id) => window.ruleTestCores[id].updateSource(null), projectIds[1]);
  await waitForFooterCounts();
  assert.equal(await runCount('layout.drc'), beforePending + 1);
  const boardBaseline = await snapshot(1);
  await openDRC();
  assert.equal(await page.locator('.editor').getAttribute('data-editor-view'), 'layout');
  assert.equal(
    requested.has(drcChunk),
    true,
    'The geometry engine remains available after automatic Layout DRC.',
  );
  const widthIssue = panel('DRC').getByRole('button', {
    name: 'Locate issue: Track width 0.1 mm is below 0.2 mm.',
    exact: true,
  });
  const shortIssue = panel('DRC').getByRole('button', {
    name: /Locate issue: Track touches Track/,
  });
  await widthIssue.waitFor();
  await shortIssue.waitFor();
  await page.screenshot({ path: 'test-results/design-rules-panel-drc.png' });
  assert.equal(requested.has(drcChunk), true);
  await unchanged(
    1,
    boardBaseline,
    'DRC inspects current copper without modifying its native bytes or undo.',
  );
  await shortIssue.click();
  await layout.waitFor();
  await layout.locator('[data-rule-check-marker]').waitFor();
  await markerUncovered('DRC', 'layout-canvas');
  assert.equal(
    await page.locator('.layout-inspector:visible').count(),
    0,
    'DRC locating keeps Properties dismissed.',
  );
  await unchanged(1, boardBaseline, 'Locating a short remains a presentation action.');
  await assertCurrentCounts('DRC');
  await button('Close Rule').click();
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
  await shortIssue.click();
  await markerUncovered('DRC', 'layout-canvas');
  assert.deepEqual(
    (await layoutContext()).selection,
    [],
    'Hidden-layer violations locate only the marker.',
  );
  await setLayoutVisibility(page, 'F.Cu', true);
  const clearance = panel('DRC').getByRole('spinbutton', {
    name: 'Minimum copper clearance (board-wide) (mm)',
    exact: true,
  });
  const beforeInvalidEdit = await runCount('layout.drc');
  await clearance.fill('1000.1');
  assert.equal(Number(await clearance.inputValue()), 1000.1);
  assert.equal(await clearance.getAttribute('aria-invalid'), 'true');
  assert.equal(await button('Recheck DRC').isDisabled(), true);
  assert.equal(
    await runCount('layout.drc'),
    beforeInvalidEdit,
    'An invalid DRC draft blocks rechecking.',
  );
  await clearance.fill('0.15');
  const editAnnular = async (value) => {
    await button('DRC settings').click();
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
    const categories = settings.getByRole('tablist', { name: 'Settings sections' });
    await categories.waitFor();
    assert.deepEqual(await categories.getByRole('tab').allTextContents(), [
      'Appearance',
      'Rule',
      'Agents',
    ]);
    const ruleTabs = settings.getByRole('tablist', { name: 'Rule settings', exact: true });
    const ruleTab = (name) => ruleTabs.getByRole('tab', { name, exact: true });
    const rulePage = (name) => settings.getByRole('tabpanel', { name, exact: true });
    const copper = rulePage('Copper & Routing');
    assert.equal(await ruleTab('Copper & Routing').getAttribute('aria-selected'), 'true');
    assert.equal(
      await copper
        .getByRole('group', { name: 'Connectivity', exact: true })
        .getByRole('combobox')
        .count(),
      2,
    );
    await ruleTab('Schematic').click();
    const conflictSeverity = settings.getByRole('combobox', { name: 'Output conflict severity' });
    assert.equal(await conflictSeverity.getAttribute('aria-description'), 'Error');
    await conflictSeverity.click();
    const conflictOptions = settings.getByRole('listbox', { name: 'Output conflict severity' });
    await conflictOptions.waitFor();
    assert.deepEqual(await conflictOptions.getByRole('option').allTextContents(), [
      'Error',
      'Warning',
      'Off',
    ]);
    await conflictSeverity.press('Escape');
    assert.equal(
      await settings.getByRole('button', { name: 'Apply rules', exact: true }).count(),
      0,
    );
    const holesTab = ruleTab('Holes & Vias');
    await holesTab.click();
    const holes = rulePage('Holes & Vias');
    const viaCopper = holes.getByRole('group', { name: 'Via & pad copper', exact: true });
    const severity = viaCopper.getByRole('combobox', { name: 'Minimum annular ring severity' });
    assert.equal(await severity.getAttribute('aria-description'), 'Error');
    assert.equal(await severity.locator('svg.lucide-circle-alert').count(), 1);
    await severity.click();
    const choices = settings.getByRole('listbox', { name: 'Minimum annular ring severity' });
    await choices.waitFor();
    assert.equal(
      await choices
        .getByRole('option', { name: 'Warning', exact: true })
        .locator('svg.lucide-triangle-alert')
        .count(),
      1,
    );
    await severity.press('Escape');
    const rows = await holes
      .getByRole('spinbutton')
      .evaluateAll((inputs) => inputs.map((input) => input.getBoundingClientRect().top));
    assert.equal(rows.length, 5);
    assert.ok(
      rows.slice(1).every((top, index) => rows[index] < top),
      'Each threshold occupies its own row.',
    );
    const annular = viaCopper.getByRole('spinbutton', {
      name: 'Minimum annular ring (mm)',
      exact: true,
    });
    const done = settings.getByRole('button', { name: 'Done', exact: true });
    const reset = settings.getByRole('button', { name: 'Reset to default', exact: true });
    await annular.fill('1000.1');
    const boardTab = ruleTab('Board & Placement');
    await boardTab.click();
    const outline = rulePage('Board & Placement').getByRole('group', {
      name: 'Outline & keepouts',
      exact: true,
    });
    await outline.getByRole('combobox', { name: 'Board outline severity', exact: true }).waitFor();
    await outline
      .getByRole('spinbutton', { name: 'Copper to board edge (mm)', exact: true })
      .waitFor();
    await boardTab.press('ArrowLeft');
    assert.equal(await holesTab.getAttribute('aria-selected'), 'true');
    assert.equal(await holesTab.evaluate((tab) => document.activeElement === tab), true);
    assert.equal(await annular.inputValue(), '1000.1', 'Changing tabs retains the invalid draft.');
    await done.click();
    assert.equal(await settings.isVisible(), true);
    assert.equal(await annular.getAttribute('aria-invalid'), 'true');
    const runsBeforeReset = await runCount('layout.drc');
    await reset.click();
    const confirmation = page.getByRole('dialog', { name: 'Reset rule settings?', exact: true });
    const cancelReset = confirmation.getByRole('button', { name: 'Cancel', exact: true });
    await cancelReset.waitFor();
    assert.equal(await confirmation.locator(':scope > .dialog-content').count(), 0);
    assert.equal(await confirmation.getAttribute('aria-describedby'), null);
    assert.equal(await confirmation.getByRole('button', { name: 'Maximize dialog' }).count(), 0);
    assert.equal(await confirmation.getByRole('button', { name: 'Close dialog' }).count(), 1);
    assert.equal(await cancelReset.evaluate((button) => document.activeElement === button), true);
    await cancelReset.click();
    await confirmation.waitFor({ state: 'hidden' });
    assert.equal(await reset.evaluate((button) => document.activeElement === button), true);
    assert.equal(await annular.inputValue(), '1000.1');
    await reset.press('Enter');
    await confirmation.getByRole('button', { name: 'Reset', exact: true }).click();
    await confirmation.waitFor({ state: 'hidden' });
    assert.equal(await settings.isVisible(), true);
    assert.equal(await annular.inputValue(), '0.05');
    assert.equal(await runCount('layout.drc'), runsBeforeReset);
    await annular.fill(value);
    await annular.dispatchEvent('compositionstart');
    await done.dispatchEvent('click');
    assert.equal(await settings.isVisible(), true);
    await annular.dispatchEvent('compositionend');
    await done.click();
    await settings.waitFor({ state: 'hidden' });
    await openDRC();
  };
  await editAnnular('1');
  const padIssue = panel('DRC').getByRole('button', {
    name: /Locate issue: J1 pad 1 has .*minimum annular ring/,
  });
  await padIssue.waitFor();
  assert.equal(await padIssue.locator('button').count(), 0);
  const padTag = await padIssue.getByText('J1 pad 1', { exact: true }).boundingBox();
  const padRuleName = await padIssue.getByText('Annular ring', { exact: true }).boundingBox();
  assert.ok(padTag.x > padRuleName.x + padRuleName.width);
  assert.ok(Math.abs(padTag.y - padRuleName.y) <= 2);
  await padIssue.focus();
  await padIssue.press('Enter');
  await markerUncovered('DRC', 'layout-canvas');
  assert.deepEqual(
    (await layoutContext()).selection,
    [{ kind: 'footprint', id: footprintId }],
    'Footprint and pad issue IDs select the owner exactly once.',
  );
  assert.equal((await layoutContext()).inspector, false);
  await editAnnular('0.15');
  await padIssue.waitFor({ state: 'detached' });
  const updatedAnnular = await snapshot(1);
  const nativeRules = ({ native }) =>
    JSON.parse(native.files.find((file) => file.name === native.entry).source).board.design_settings
      .rules;
  const siblingSources = ({ native }) => native.files.filter((file) => file.name !== native.entry);
  assert.equal(nativeRules(updatedAnnular).min_via_annular_width, 0.15);
  assert.equal(updatedAnnular.undoDepth, boardBaseline.undoDepth + 2);
  assert.deepEqual(siblingSources(updatedAnnular), siblingSources(boardBaseline));
  const minimum = panel('DRC').getByRole('spinbutton', {
    name: 'Minimum track width (mm)',
    exact: true,
  });
  await minimum.fill('0.05');
  assert.equal(
    await panel('DRC')
      .getByText(/Outdated|Design or limits changed/)
      .count(),
    0,
  );
  assert.equal(await shortIssue.isDisabled(), true);
  await button('Recheck DRC').click();
  await shortIssue.waitFor();
  await widthIssue.waitFor({ state: 'detached' });
  const updatedWidth = await snapshot(1);
  assert.equal(nativeRules(updatedWidth).min_track_width, 0.05);
  assert.equal(updatedWidth.undoDepth, updatedAnnular.undoDepth + 1);
  assert.deepEqual(siblingSources(updatedWidth), siblingSources(boardBaseline));
  await page.screenshot({ path: 'test-results/design-rules-workspace-drc.png' });

  await page.evaluate((id) => {
    window.holdRuleIdle();
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
  await page.waitForFunction(() => window.ruleIdleWaiting);
  assert.equal(await shortIssue.isDisabled(), true);
  await assertUnknownCounts();
  const fixedDRC = await snapshot(1);
  await page.evaluate(() => window.releaseRuleIdle());
  await clean('DRC').waitFor();
  await assertCurrentCounts('DRC');
  await unchanged(1, fixedDRC, 'Rechecking the repaired PCB is read-only.');
  await button('Close Rule').click();
  await button('Schematic').click();
  await openERC();
  await clean('ERC').waitFor();
  await unchanged(
    1,
    fixedDRC,
    'Refreshing another view checks the same current project without edits.',
  );
  await button('Close Rule').click();
  await button('Layout').click();
  await openDRC();
  assert.equal(
    await minimum.inputValue(),
    '0.05',
    'Per-project DRC settings survive view switches.',
  );
  await clean('DRC').waitFor();
  assert.equal(await layout.locator('[data-rule-check-marker]').count(), 0);
  await button('Close Rule').click();
  await page.evaluate(
    ({ id, undoDepth }) => {
      const core = window.ruleTestCores[id];
      while (core.getSnapshot().undoDepth > undoDepth) core.undo();
    },
    { id: projectIds[1], undoDepth: boardBaseline.undoDepth },
  );
  await settled();
  assert.equal((await snapshot(1)).source, sources[1]);
  assert.equal(recovery.documents[1].dirty, false);
  await page.evaluate((id) => {
    const core = window.ruleTestCores[id],
      project = core.getSnapshot().project;
    core.commitProject({ ...project, pcb: { ...project.pcb, graphics: [] } });
  }, projectIds[1]);
  const beforeZoom = await layout.getAttribute('viewBox');
  await layout.hover();
  await page.mouse.wheel(0, -480);
  await page.waitForFunction(
    (previous) =>
      document.querySelector('[data-testid="layout-canvas"]').getAttribute('viewBox') !== previous,
    beforeZoom,
  );
  const beforeOutlineFit = await layout.getAttribute('viewBox');
  const noOutline = await snapshot(1);
  await waitForFooterCounts();
  await openDRC();
  await button('Recheck DRC').click();
  const outlineIssue = panel('DRC').locator('li:has(span[aria-description="pcb.outline"]) button');
  await outlineIssue.waitFor();
  await outlineIssue.focus();
  await outlineIssue.press('Space');
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
  assert.equal(await panel('DRC').isVisible(), true);
  await button('Close Rule').click();
  await page.evaluate((id) => window.ruleTestCores[id].undo(), projectIds[1]);
  await settled();
  const navigationBaseline = await snapshot(1);
  await waitForFooterCounts();
  await openDRC();
  await button('Source').click();
  await panel().waitFor({ state: 'detached' });
  assert.equal(
    await ruleButton.evaluate((element) => !!element.closest('.source-editor .status-bar')),
    true,
  );
  assert.ok(
    (await page.locator('.source-editor .status-coordinate:visible').textContent()).includes('Ln '),
  );
  await waitForFooterCounts();
  await openERC();
  await clean('ERC').waitFor();
  assert.equal(await page.locator('.editor').getAttribute('data-editor-view'), 'source');
  await button('Model').click();
  await panel().waitFor({ state: 'detached' });
  await unchanged(1, navigationBaseline, 'Changing views preserves native files and undo.');
  const modelDRCRuns = await runCount('layout.drc');
  await page.waitForFunction(
    () =>
      document.querySelector('.pcb-model-canvas canvas') &&
      !document.querySelector('.pcb-model-status'),
  );
  await waitForFooterCounts();
  assert.equal(
    await ruleButton.locator('[data-rule-errors]').getAttribute('data-rule-errors'),
    '0',
  );
  assert.equal(
    await ruleButton.locator('[data-rule-warnings]').getAttribute('data-rule-warnings'),
    '1',
    'First Model admission publishes its own missing-model warning before Rule opens.',
  );
  assert.equal(
    await runCount('layout.drc'),
    modelDRCRuns,
    'Model uses its own preview counts, not DRC.',
  );
  await ruleButton.click();
  await assertRulePlacement('Model');
  await assertViewReport();
  assert.equal(
    await runCount('layout.drc'),
    modelDRCRuns,
    'Opening the Model report does not run DRC.',
  );
  assert.equal(
    await page.locator('.pcb-model-issues').count(),
    0,
    'Editable Model has no separate issue control.',
  );
  const modelIssue = panel().getByRole('button', { name: 'Locate J1: No 3D model', exact: true });
  await modelIssue.waitFor();
  await modelIssue.click();
  assert.equal(await panel().isVisible(), true);
  assert.equal(await page.locator('.editor').getAttribute('data-editor-view'), '3d');
  assert.equal(
    await page
      .getByRole('region', { name: 'Component properties', exact: true })
      .getByRole('textbox', { name: 'Reference', exact: true })
      .inputValue(),
    'J1',
  );
  await unchanged(
    1,
    navigationBaseline,
    'Model issue inspection and locating preserve native files, revision and undo.',
  );
  await selectProject(0);
  await openERC(true, true);
  assert.equal(await modelIssue.count(), 0, 'Other projects never expose retained model issues.');
  const inactiveDRCRuns = await runCount('layout.drc');
  await page.evaluate((id) => {
    const core = window.ruleTestCores[id];
    core.setEditingBlocked('Inactive fixture changed.');
    core.setEditingBlocked(null);
  }, projectIds[1]);
  await delay(1700);
  assert.equal(
    await runCount('layout.drc'),
    inactiveDRCRuns,
    'An inactive project cannot schedule a footer check.',
  );
  await ercIssue.waitFor();
  assert.equal(await schematic.locator('[data-rule-check-marker]').count(), 0);
  await button('Close Rule').click();
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
    'Workspace rule checks passed: settled automatic counts, panel retry/IME, Layout cancellation/restart, Model preview severity/reload, lazy engines; ERC/DRC locating, stale reports, Source/close/project gates; unchanged native files, undo and recovery.',
  );
} finally {
  releaseERC();
  releaseDRC();
  await browser.close();
}
