import { fileMenuAction } from './file-menu-test-helpers.mjs';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { readSource } from './source-editor-test-helpers.mjs';

// Isolated real renderer: no Electron, native files, solver or Agent requests.
const { emptyCircuit, createPart, pinPositions, parseCircuit, uid } = await tsImport(
  '../lib/circuit.ts',
  import.meta.url,
);
const { createProject, serializeProject } = await tsImport('../lib/project.ts', import.meta.url);
const { projectNetGroups } = await tsImport('../lib/project-net-groups.ts', import.meta.url);
const { onWire } = await tsImport('../lib/wiring.ts', import.meta.url);
const { defaultAppearance } = await tsImport('../lib/appearance.ts', import.meta.url);
const d = emptyCircuit();
d.parts.push(createPart(d, 'R', 25.4, 25.4), createPart(d, 'C', 76.2, 25.4));
for (const p of d.parts) p.rotation = 180;
const [a, b] = d.parts.map((p) => pinPositions(p, d.libraries[p.libId])[0]);
d.wires = [
  { id: uid(), a, b: { x: a.x, y: 40.64 } },
  { id: uid(), a: { x: a.x, y: 40.64 }, b: { x: b.x, y: 40.64 } },
  { id: uid(), a: { x: b.x, y: 40.64 }, b },
];
d.labels.push({ id: uid(), x: 50.8, y: 40.64, text: 'SIGNAL' });
d.labels.push({ id: uid(), ...b, text: 'OUTPUT', scope: 'global', shape: 'input' });
const middleId = d.wires[1].id;
const source = serializeProject(createProject(d));
const topology = (circuit) =>
  projectNetGroups(circuit)
    .map((g) => [...g.pins, ...g.labels.map((index) => circuit.labels[index].id)].sort())
    .filter((g) => g.length)
    .sort();
let state = {
  version: 2,
  documents: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      source,
      sourceDraft: null,
      dirty: false,
      filename: null,
      sessions: [{ id: 'wire-drag-session', messages: [], draft: '' }],
      activeSessionId: 'wire-drag-session',
    },
  ],
  activeDocumentId: '00000000-0000-4000-8000-000000000001',
  provider: 'codex',
  effort: 'low',
  approvalMode: 'review',
  models: {},
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
  outdir: 'test-results/schematic-drag-bundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
await mkdir('test-results/schematic-drag', { recursive: true });
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(10000);
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
      connection: async () => ({ base: 'http://localhost', token: 'test' }),
      newFile: async () => crypto.randomUUID(),
      releaseFile: async () => {},
      setDirty: async () => {},
      onCloseRequested: () => () => {},
    };
  });
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/state') {
      if (route.request().method() === 'GET') return route.fulfill({ json: state });
      state = route.request().postDataJSON();
      return route.fulfill({ json: null });
    }
    if (url.pathname === '/api/appearance')
      return route.fulfill({ json: { ...defaultAppearance, leftButtonDrag: 'drag-any' } });
    if (url.pathname === '/api/agents') return route.fulfill({ json: [] });
    if (url.pathname === '/api/models')
      return route.fulfill({ json: { models: [], defaultModel: '' } });
    if (url.pathname === '/api/workbench-plugins') return route.fulfill({ json: { plugins: [] } });
    if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(url.pathname))
      return route.fulfill({
        contentType: url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        body: await readFile('public' + url.pathname),
      });
    if (url.pathname.startsWith('/api/')) throw new Error(`Unexpected API call: ${url.pathname}`);
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  for (const output of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
    await page.addStyleTag({ content: output.text });
  await page.addScriptTag({
    content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
  });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const canvas = page.getByTestId('schematic-canvas');
  await canvas.waitFor();
  // Wait for the initial deferred fit, which deliberately cancels active gestures.
  await page.waitForFunction(
    () => document.querySelector('[data-testid="schematic-canvas"]')?.viewBox.baseVal.x !== 0,
  );
  const at = (x, y) =>
    canvas.evaluate(
      (svg, p) => {
        const point = new DOMPoint(p.x, p.y).matrixTransform(svg.getScreenCTM());
        return { x: point.x, y: point.y };
      },
      { x, y },
    );
  const line = (id) => canvas.locator(`[data-selection-id="${id}"] > g > line`);
  const geometry = (id) =>
    line(id).evaluate((node) =>
      ['x1', 'y1', 'x2', 'y2'].map((name) => Number(node.getAttribute(name))),
    );
  const renderedWires = () =>
    canvas.evaluate((svg) =>
      [...svg.children].flatMap((group) => {
        const line = group.querySelector(':scope > g > line');
        if (!group.hasAttribute('data-selection-id') || !line) return [];
        return [
          {
            id: group.getAttribute('data-selection-id'),
            a: { x: Number(line.getAttribute('x1')), y: Number(line.getAttribute('y1')) },
            b: { x: Number(line.getAttribute('x2')), y: Number(line.getAttribute('y2')) },
          },
        ];
      }),
    );
  async function currentCircuit() {
    await button('Source').click();
    await page
      .getByRole('navigation', { name: 'Project files', exact: true })
      .getByRole('button', { name: /\.kicad_sch$/ })
      .click();
    const circuit = parseCircuit(await readSource(page));
    await button('Schematic').click();
    await canvas.waitFor();
    return circuit;
  }
  const baseline = await currentCircuit();
  // Grabbing either label's text preserves its electrical anchor and attached wires.
  for (const label of baseline.labels) {
    const target = {
      x: Number((label.x + 5.08).toFixed(4)),
      y: Number((label.y + 5.08).toFixed(4)),
    };
    const labelNode = canvas.locator(`[data-selection-id="${label.id}"]`);
    async function dragLabel() {
      const bounds = await labelNode.locator(':scope > g > text').boundingBox();
      assert.ok(bounds);
      const start = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      const origin = await at(label.x, label.y);
      const end = await at(target.x, target.y);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x + end.x - origin.x, start.y + end.y - origin.y, {
        steps: 8,
      });
    }
    await dragLabel();
    const labelWires = await renderedWires();
    assert.match(
      await labelNode.getAttribute('transform'),
      new RegExp(`^translate\\(${target.x} ${target.y}\\)`),
    );
    assert.ok(
      labelWires.some((wire) => onWire(target, wire)),
      'Wires follow the label preview.',
    );
    assert.notDeepEqual(
      labelWires,
      baseline.wires.map(({ id, a, b }) => ({ id, a, b })),
    );
    await page.mouse.up();
    const labelMoved = await currentCircuit();
    assert.deepEqual(
      labelMoved.wires.map(({ id, a, b }) => ({ id, a, b })),
      labelWires,
      'Label release commits the exact preview, including generated wire IDs.',
    );
    assert.deepEqual(labelMoved.parts, baseline.parts);
    assert.deepEqual(topology(labelMoved), topology(baseline));
    await button('Undo').click();
    assert.deepEqual(await currentCircuit(), baseline, 'One undo restores the label and wires.');
    await button('Redo').click();
    assert.deepEqual(await currentCircuit(), labelMoved);
    await button('Undo').click();
    await dragLabel();
    await page.keyboard.press('Escape');
    await page.mouse.up();
    assert.deepEqual(await currentCircuit(), baseline, 'Escape discards the label reroute.');
    await labelNode.locator(':scope > g > text').click();
    await page.keyboard.press('ArrowDown');
    const labelNudged = await currentCircuit();
    assert.equal(
      labelNudged.labels.find((item) => item.id === label.id).y,
      Number((label.y + 1.27).toFixed(4)),
    );
    assert.ok(
      labelNudged.wires.some((wire) =>
        onWire(
          labelNudged.labels.find((item) => item.id === label.id),
          wire,
        ),
      ),
    );
    assert.deepEqual(topology(labelNudged), topology(baseline));
    await button('Undo').click();
    assert.deepEqual(await currentCircuit(), baseline);
  }
  const start = await at(38.1, 40.64);
  const end = await at(43.18, 45.72); // Tangential motion must not move a horizontal wire along X.
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 8 });
  assert.deepEqual(await geometry(middleId), [25.4, 45.72, 76.2, 45.72]);
  assert.deepEqual(await geometry(d.wires[0].id), [a.x, a.y, a.x, 45.72]);
  assert.deepEqual(await geometry(d.wires[2].id), [b.x, 45.72, b.x, b.y]);
  const highlight = canvas.locator(
    `[data-selection-id="${middleId}"] > g > [data-selection-only] > line`,
  );
  assert.equal(await highlight.getAttribute('stroke-linecap'), 'square');
  assert.equal(await line(middleId).getAttribute('stroke-linecap'), 'square');
  assert.equal(Number(await highlight.getAttribute('stroke-width')), 0.28);
  await page.screenshot({ path: 'test-results/schematic-drag/preview.png' });
  await page.mouse.up();
  const moved = await currentCircuit();
  assert.equal(moved.wires.length, 3);
  assert.deepEqual(moved.parts, baseline.parts);
  assert.equal(moved.labels[0].y, 45.72);
  assert.deepEqual(topology(moved), topology(baseline));
  await button('Undo').click();
  assert.deepEqual(
    await currentCircuit(),
    baseline,
    'one undo restores all wire and label changes',
  );
  await button('Redo').click();
  assert.deepEqual(await currentCircuit(), moved);

  // Cancellation removes the live reroute without committing any geometry.
  const cancelStart = await at(38.1, 45.72);
  const cancelEnd = await at(38.1, 50.8);
  await page.mouse.move(cancelStart.x, cancelStart.y);
  await page.mouse.down();
  await page.mouse.move(cancelEnd.x, cancelEnd.y, { steps: 8 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.equal(await highlight.count(), 1, 'Cancelling a drag retains the selected wire.');
  await page.keyboard.press('Escape');
  assert.equal(await highlight.count(), 0, 'A subsequent Escape clears selection.');
  assert.deepEqual(await currentCircuit(), moved);

  // Vertical slide keeps the stationary pin connected with a horizontal stub.
  const verticalStart = await at(a.x, 35.56);
  const verticalEnd = await at(a.x + 5.08, 40.64);
  await page.mouse.move(verticalStart.x, verticalStart.y);
  await page.mouse.down();
  await page.mouse.move(verticalEnd.x, verticalEnd.y, { steps: 8 });
  assert.deepEqual(await geometry(d.wires[0].id), [30.48, a.y, 30.48, 45.72]);
  const shownWires = await renderedWires();
  assert.equal(shownWires.length, 4, 'The pointer preview contains its generated reconnect.');
  await page.mouse.up();
  const vertical = await currentCircuit();
  assert.equal(vertical.wires.length, 4);
  assert.deepEqual(
    vertical.wires.map(({ id, a, b }) => ({ id, a, b })),
    shownWires,
    'Pointer release commits the exact rendered wire geometry and generated UUIDs.',
  );
  assert.deepEqual(topology(vertical), topology(baseline));
  assert.deepEqual(vertical.parts, baseline.parts);
  await button('Undo').click();
  assert.deepEqual(await currentCircuit(), moved);

  // Arrow nudges in Interaction mode also preserve wire connections.
  const nudge = await at(38.1, 45.72);
  await page.mouse.click(nudge.x, nudge.y);
  await page.keyboard.press('ArrowDown');
  const nudged = await currentCircuit();
  assert.equal(nudged.wires.find((w) => w.id === middleId).a.y, 46.99);
  assert.deepEqual(topology(nudged), topology(baseline));

  // A wire-containing group retains connections even when grabbed by its symbol.
  const partStart = await at(25.4, 25.4);
  await page.keyboard.down('Shift');
  await page.mouse.click(partStart.x, partStart.y);
  await page.keyboard.up('Shift');
  const partEnd = await at(30.48, 30.48);
  await page.mouse.move(partStart.x, partStart.y);
  await page.mouse.down();
  await page.mouse.move(partEnd.x, partEnd.y, { steps: 8 });
  assert.deepEqual(await geometry(middleId), [30.48, 52.07, 81.28, 52.07]);
  await page.mouse.up();
  const grouped = await currentCircuit();
  assert.deepEqual(topology(grouped), topology(baseline));
  assert.equal(grouped.parts[0].x, 30.48);
  assert.deepEqual(grouped.parts[1], baseline.parts[1]);
  await button('Undo').click();
  assert.deepEqual(await currentCircuit(), nudged);
  // Menu commands must pick up only after Select restores focus to its trigger.
  for (const connected of [false, true]) {
    const menuStart = await at(25.4, 25.4);
    await page.mouse.click(menuStart.x, menuStart.y);
    if (connected) await canvas.press('w');
    await page.getByRole('combobox', { name: 'Edit schematic', exact: true }).click();
    await page
      .getByRole('option', {
        name: connected ? 'Drag with connections' : 'Move selection',
        exact: true,
      })
      .click();
    await page.waitForFunction(
      (expected) =>
        document
          .querySelector('[data-testid="schematic-canvas"]')
          ?.getAttribute('data-move-preview') === expected,
      connected ? 'drag' : 'move',
    );
    assert.equal(await canvas.evaluate((svg) => document.activeElement === svg), true);
    const menuEnd = await at(30.48, 30.48);
    await page.mouse.move(menuEnd.x, menuEnd.y, { steps: 4 });
    await page.keyboard.press('Enter');
    const menuMoved = await currentCircuit();
    assert.equal(menuMoved.parts[0].x, 30.48);
    assert.equal(menuMoved.parts[0].y, 30.48);
    assert.deepEqual(menuMoved.parts[1], nudged.parts[1]);
    if (connected) assert.deepEqual(topology(menuMoved), topology(nudged));
    else assert.deepEqual(menuMoved.wires, nudged.wires);
    await button('Undo').click();
    assert.deepEqual(await currentCircuit(), nudged);
  }
  // Ignored modified/composing hotkeys must not fall through to Workbench actions.
  const guardedStart = await at(25.4, 25.4);
  await page.mouse.click(guardedStart.x, guardedStart.y);
  await canvas.evaluate((svg) => {
    for (const key of ['g', 'r', 'x', 'y'])
      for (const modifiers of [{ altKey: true }, { isComposing: true }])
        svg.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...modifiers }));
  });
  assert.equal(
    await canvas.locator('..').evaluate((wrap) => wrap.classList.contains('tool-select')),
    true,
  );
  assert.equal(await canvas.getAttribute('data-move-preview'), null);
  assert.deepEqual(await currentCircuit(), nudged);

  const tabs = page.getByRole('tablist', { name: 'Schematic files' });
  await fileMenuAction(page, 'New file');
  const firstSheet = await tabs.getByRole('tab').first().innerText();
  const secondSheet = await tabs.getByRole('tab', { selected: true }).innerText();
  await tabs
    .getByRole('tab')
    .filter({ has: page.getByText(firstSheet, { exact: true }) })
    .click();
  const remountStart = await at(25.4, 25.4);
  await page.mouse.click(remountStart.x, remountStart.y);
  await page.getByRole('combobox', { name: 'Edit schematic', exact: true }).click();
  await page.getByRole('option', { name: 'Move selection', exact: true }).click();
  await page.waitForFunction(() =>
    document.querySelector('[data-testid="schematic-canvas"]')?.hasAttribute('data-move-preview'),
  );
  await canvas.press('Escape');
  await tabs
    .getByRole('tab')
    .filter({ has: page.getByText(secondSheet, { exact: true }) })
    .click();
  await tabs
    .getByRole('tab')
    .filter({ has: page.getByText(firstSheet, { exact: true }) })
    .click();
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(
    await canvas.getAttribute('data-move-preview'),
    null,
    'A consumed menu request never replays after sheet remount.',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Schematic drag: connected local/global label dragging and nudges, horizontal/vertical wire previews, stationary pins, exact preview commits, single undo/redo, cancellation, group dragging and unchanged highlight geometry passed.',
  );
} finally {
  await browser.close();
}
