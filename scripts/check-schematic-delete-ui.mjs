import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { readNativeProject } from './source-editor-test-helpers.mjs';
import { bundledWorkbenchCatalog } from '../server/workbench-plugins.mjs';

// Real workspace, recovered proposal and mocked services; no providers or Electron.
const { createPart, emptyCircuit, pinPositions, uid } = await tsImport(
  '../lib/circuit.ts',
  import.meta.url,
);
const { createProject, parseProject, serializeProject } = await tsImport(
  '../lib/project.ts',
  import.meta.url,
);
const { defaultAgentPreferences } = await tsImport('../lib/workspace-state.ts', import.meta.url);
const d = emptyCircuit();
d.parts.push(createPart(d, 'R', 25.4, 25.4), createPart(d, 'C', 76.2, 25.4));
for (const part of d.parts) part.rotation = 180;
const [a, b] = d.parts.map((p) => pinPositions(p, d.libraries[p.libId])[0]);
d.wires = [
  { id: uid(), a, b: { x: a.x, y: 50.8 } },
  { id: uid(), a: { x: a.x, y: 50.8 }, b: { x: b.x, y: 50.8 } },
  { id: uid(), a: { x: b.x, y: 50.8 }, b },
];
d.labels.push({ id: uid(), x: 50.8, y: 50.8, text: 'LEAD' });
const project = createProject(d);
project.extensions.note = { retained: true };
const source = serializeProject(project);
let baseline;
const proposal = 'Remove R1.\n\n```openpe\n[{"type":"removePart","ref":"R1"}]\n```';
const plugins = bundledWorkbenchCatalog();
let state = {
  version: 2,
  documents: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      source,
      sourceDraft: null,
      dirty: false,
      filename: 'delete.kicad_pro',
      sessions: [
        {
          id: 'delete-session',
          messages: [{ id: 'proposal', role: 'assistant', text: proposal, outcome: 'completed' }],
          draft: '',
        },
      ],
      activeSessionId: 'delete-session',
    },
  ],
  activeDocumentId: '00000000-0000-4000-8000-000000000001',
  ...defaultAgentPreferences,
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
  outdir: 'test-results/schematic-delete-ui-bundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
await mkdir('test-results/schematic-delete', { recursive: true });
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  await page.addInitScript(() => {
    window.openpe = {
      titleBarOverlay: false,
      listExamples: async () => ({ entries: [], warnings: [] }),
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
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/state') {
      if (route.request().method() === 'GET') return route.fulfill({ json: state });
      state = route.request().postDataJSON();
      return route.fulfill({ json: null });
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
    if (url.pathname.startsWith('/api/')) throw new Error(`Unexpected API call: ${url.pathname}`);
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const canvas = page.getByTestId('schematic-canvas');
  await canvas.waitFor().catch(async (error) => {
    console.error(errors, await page.locator('body').innerText());
    await page.screenshot({ path: 'test-results/schematic-delete/startup-failure.png' });
    throw error;
  });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="schematic-canvas"]')?.viewBox.baseVal.x !== 0,
  );
  async function currentProject() {
    await button('Source').click();
    const current = await readNativeProject(page).catch(async (error) => {
      console.error(errors, await page.locator('body').innerText());
      await page.screenshot({ path: 'test-results/schematic-delete/source-failure.png' });
      throw error;
    });
    // Private provenance is asserted at the explicit recovery IPC boundary.
    assert.deepEqual(parseProject(state.documents[0].source).extensions, project.extensions);
    await button('Schematic').click();
    await canvas.waitFor();
    return current;
  }
  baseline ??= await currentProject();
  async function checkDeleteFooter(name) {
    const inspector = page.getByRole('complementary', { name: 'Object properties', exact: true });
    await inspector.getByRole('button', { name: 'Delete object', exact: true }).waitFor();
    assert.equal(
      await inspector.evaluate((el) => {
        const footer = el.querySelector('.inspector-footer').getBoundingClientRect();
        const action = el.querySelector('.property-delete-action').getBoundingClientRect();
        const body = el.querySelector('.inspector-body').getBoundingClientRect();
        const panel = el.getBoundingClientRect();
        return (
          Math.abs(panel.bottom - footer.bottom) < 1 &&
          Math.abs(footer.right - action.right - 12) < 1 &&
          Math.abs(footer.bottom - action.bottom - 6) < 1 &&
          body.bottom <= footer.top + 1
        );
      }),
      true,
      'Deletion stays at the panel bottom right, outside the scrolling fields.',
    );
    const before = await inspector
      .getByRole('button', { name: 'Delete object', exact: true })
      .boundingBox();
    await inspector.locator('.inspector-body').evaluate((el) => (el.scrollTop = el.scrollHeight));
    assert.deepEqual(
      await inspector.getByRole('button', { name: 'Delete object', exact: true }).boundingBox(),
      before,
      'Scrolling fields retains the deletion button position.',
    );
    await page.screenshot({ path: 'test-results/schematic-delete/' + name + '-footer.png' });
  }
  await page.getByTestId('label-LEAD').click();
  await checkDeleteFooter('label');
  await page.getByTestId('part-R1').click();
  await page.keyboard.press('Delete');
  const manual = await currentProject();
  assert.deepEqual(
    manual.schematic.parts.map((p) => p.ref),
    ['C1'],
  );
  assert.deepEqual(manual.schematic.wires, []);
  assert.deepEqual(manual.schematic.labels, []);
  await button('Undo').click();
  assert.deepEqual(
    await currentProject(),
    baseline,
    'one undo restores the part and complete wire route',
  );
  await button('Redo').click();
  assert.deepEqual(await currentProject(), manual);
  await button('Undo').click();
  assert.deepEqual(await currentProject(), baseline);

  await page.getByTestId('part-R1').click();
  await checkDeleteFooter('component');
  await button('Delete object').click();
  assert.deepEqual(await currentProject(), manual, 'Properties deletion uses the same cleanup');
  await button('Undo').click();
  assert.deepEqual(await currentProject(), baseline);

  await button('Apply to schematic').click();
  assert.deepEqual(
    await currentProject(),
    manual,
    'applying an Agent removal matches manual deletion',
  );
  await button('Undo').click();
  assert.deepEqual(
    await currentProject(),
    baseline,
    'Agent deletion is also one whole-project undo',
  );
  await button('Redo').click();
  assert.deepEqual(await currentProject(), manual);
  await page.screenshot({ path: 'test-results/schematic-delete/agent-deletion.png' });
  assert.deepEqual(errors, []);
  console.log(
    'Component deletion: Delete key, Properties and Agent proposal remove the same complete leads and orphan labels; native whole-project undo/redo passed.',
  );
} finally {
  await browser.close();
}
