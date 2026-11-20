import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { createLibraryService } from '../server/libraries.mjs';
import { bundledWorkbenchCatalog } from '../server/workbench-plugins.mjs';
import { waitForAsync } from './async-browser-test-helpers.mjs';

// Actual Workbench and Model in an isolated browser. Native/network adapters are
// fixtures; no Electron, providers, solvers, profile access or project writes.
const [{ createBlankProject }, { serializeProject }, { defaultAgentPreferences }] =
  await Promise.all([
    tsImport('../lib/create-blank-project.ts', import.meta.url),
    tsImport('../lib/project.ts', import.meta.url),
    tsImport('../lib/workspace-state.ts', import.meta.url),
  ]);
const library = createLibraryService({ allowModelDownloads: false });
const symbol = await library.request({ action: 'detail', kind: 'symbols', id: 'Device:R' });
const footprint = await library.request({
  action: 'detail',
  kind: 'footprints',
  id: 'Resistor_SMD:R_0805_2012Metric',
});
library.close();
const packageId = 'NextPCB:123_fixture';
footprint.id = packageId;
footprint.footprint[1] = '"123_fixture"';
footprint.footprint = footprint.footprint.filter(
  (node) => !Array.isArray(node) || node[0] !== 'model',
);
footprint.projectAssets = true;
const project = createBlankProject();
const corners = [
  [0, 0],
  [30, 0],
  [30, 20],
  [0, 20],
];
project.pcb.graphics = corners.map(([x, y], i) => ({
  id: crypto.randomUUID(),
  layer: 'Edge.Cuts',
  width: 0.1,
  start: { x, y },
  end: { x: corners[(i + 1) % 4][0], y: corners[(i + 1) % 4][1] },
}));
const documentId = crypto.randomUUID();
let recovery = {
  ...defaultAgentPreferences,
  version: 2,
  documents: [
    {
      id: documentId,
      source: serializeProject(project),
      sourceDraft: null,
      dirty: false,
      filename: 'model-sync.kicad_pro',
      sessions: [{ id: 'session', messages: [], draft: '' }],
      activeSessionId: 'session',
    },
  ],
  activeDocumentId: documentId,
};
const bundle = await build({
  stdin: {
    contents: `import React from 'react';import{createRoot}from'react-dom/client';
    import Workspace from './components/DesktopWorkspace';import{createLibraryPart}from'./lib/library';
    window.addFixture=()=>{const core=window.syncCore,circuit=structuredClone(core.getSnapshot().project.schematic);
      const part=createLibraryPart(circuit,window.fixtureSymbol,5,5);part.fields.Footprint='${packageId}';
      circuit.libraries[part.libId]=window.fixtureSymbol;circuit.parts.push(part);core.replaceSchematic(circuit)};
    createRoot(document.getElementById('root')).render(<Workspace/>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outdir: 'test-results/model-sync-bundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [
    {
      name: 'observe-live-model',
      setup(plugin) {
        plugin.onLoad({ filter: /[\\/]Workbench\.tsx$/ }, async ({ path: file }) => {
          const source = await readFile(file, 'utf8');
          const marker = '  const [renameTarget, setRenameTarget] = useState<';
          assert.ok(source.includes(marker));
          return {
            contents: source.replace(marker, '  window.syncCore=core;\n' + marker),
            loader: 'tsx',
            resolveDir: path.dirname(file),
          };
        });
        plugin.onLoad({ filter: /[\\/]PCBModelPreview\.tsx$/ }, async ({ path: file }) => {
          const source = await readFile(file, 'utf8');
          const marker = '          updateScale.current();';
          assert.ok(source.includes(marker));
          return {
            contents: source
              .replace(
                'host.current.appendChild(renderer.domElement);',
                'window.modelCreated++;host.current.appendChild(renderer.domElement);',
              )
              .replace(marker, 'window.modelCamera={camera,orbit};\n' + marker)
              .replace('renderer.dispose();', 'window.modelDisposed++;renderer.dispose();'),
            loader: 'tsx',
            resolveDir: path.dirname(file),
          };
        });
      },
    },
  ],
});
const browser = await chromium.launch({
  headless: true,
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
});
function assertCamera(position, expected) {
  assert.ok(
    position.every((value, index) => Math.abs(value - expected[index]) < 1e-9),
    'The camera remains at the accepted pose.',
  );
}
try {
  const page = await browser.newPage({ viewport: { width: 1180, height: 800 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let requests = 0,
    reject = true,
    release;
  await page.addInitScript(() => {
    window.modelCreated = 0;
    window.modelDisposed = 0;
    window.openpe = {
      titleBarOverlay: false,
      connection: async () => ({ base: 'http://localhost', token: 'test' }),
      projectDirectory: async () => ({ entries: [], truncated: false }),
      listExamples: async () => ({ entries: [], warnings: [] }),
      listRecent: async () => ({ initialized: true, entries: [], warnings: [] }),
      onRecentChanged: () => () => {},
      writeWorkspaceRecovery: async (content) =>
        fetch('/api/state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: content,
        }),
      newFile: async () => crypto.randomUUID(),
      releaseFile: async () => {},
      setDirty: async () => {},
      onCloseRequested: () => () => {},
    };
  });
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/state') {
      if (route.request().method() === 'POST') recovery = route.request().postDataJSON();
      return route.fulfill({ json: recovery });
    }
    if (url.pathname === '/api/appearance') return route.fulfill({ json: null });
    if (url.pathname === '/api/agent-settings')
      return route.fulfill({ json: { followUpMode: 'queue' } });
    if (url.pathname === '/api/agents') return route.fulfill({ json: [] });
    if (url.pathname === '/api/workbench-plugins')
      return route.fulfill({ json: bundledWorkbenchCatalog() });
    if (url.pathname === '/api/library-package') {
      assert.equal(route.request().method(), 'POST');
      assert.deepEqual(route.request().postDataJSON(), { id: packageId });
      requests++;
      if (requests > 1)
        await new Promise((resolve) => {
          release = resolve;
        });
      return reject
        ? route.fulfill({ status: 422, json: { error: 'Fixture package unavailable' } })
        : route.fulfill({ json: { ...footprint, models: [] } });
    }
    if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(url.pathname))
      return route.fulfill({ body: await readFile('public' + url.pathname) });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.evaluate((fixture) => {
    window.fixtureSymbol = fixture;
  }, symbol.symbol);
  await page.addScriptTag({
    content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
  });
  const button = (name) => page.getByRole('button', { name, exact: true });
  await page
    .getByTestId('schematic-canvas')
    .waitFor()
    .catch(async (error) => {
      console.error(errors, await page.locator('body').innerText());
      throw error;
    });
  await button('Model').click();
  await page.waitForFunction(() => window.modelCamera && window.modelCreated === 1);
  await page.evaluate(() => {
    window.retainedCanvas = document.querySelector('.pcb-object-stage canvas');
    window.cameraBefore = window.modelCamera.camera.position.toArray();
  });
  await page.evaluate(() => window.addFixture());
  const banner = page.locator('.model-sync-status');
  await banner.filter({ hasText: 'Fixture package unavailable' }).waitFor();
  assert.equal(requests, 1);
  assert.equal(await page.evaluate(() => window.syncCore.getSnapshot().undoDepth), 1);
  await button('Schematic').click();
  await button('Model').click();
  await banner.filter({ hasText: 'Loading assigned footprints' }).waitFor();
  assert.equal(requests, 2, 'Model-only entry retries without visiting Layout.');
  assert.equal(
    await page.evaluate(() => window.syncCore.getSnapshot().project.pcb.footprints.length),
    0,
  );
  await page.evaluate(() => window.syncCore.setEditingBlocked('Closing fixture'));
  release();
  await banner.filter({ hasText: 'Fixture package unavailable' }).waitFor();
  const retry = button('Retry footprint synchronization');
  assert.equal(await retry.isDisabled(), true);
  await page.evaluate(() => window.syncCore.setEditingBlocked(null));
  await retry.dispatchEvent('keydown', { key: 'Enter', keyCode: 229 });
  await page.waitForTimeout(100);
  assert.equal(requests, 2, 'IME cannot retry.');
  await page.evaluate(() => window.syncCore.updateSource('invalid native draft'));
  assert.equal(await retry.isDisabled(), true, 'Pending Source blocks retries.');
  await page.evaluate(() => window.syncCore.discardSource());
  await banner.filter({ hasText: 'Loading assigned footprints' }).waitFor();
  assert.equal(requests, 3);
  release();
  await banner.filter({ hasText: 'Fixture package unavailable' }).waitFor();
  reject = false;
  await retry.press('Enter');
  await banner.filter({ hasText: 'Loading assigned footprints' }).waitFor();
  assert.equal(requests, 4);
  assert.equal(await page.evaluate(() => window.modelCreated), 1);
  assert.equal(await page.evaluate(() => window.modelDisposed), 0);
  assert.equal(
    await page.evaluate(
      () => window.retainedCanvas === document.querySelector('.pcb-object-stage canvas'),
    ),
    true,
    'Status and retries retain the mounted scene.',
  );
  assertCamera(
    await page.evaluate(() => window.modelCamera.camera.position.toArray()),
    await page.evaluate(() => window.cameraBefore),
  );
  release();
  await banner.waitFor({ state: 'hidden' });
  await waitForAsync(page, () => window.syncCore.getSnapshot().project.pcb.footprints.length === 1);
  assert.equal(
    await page.evaluate(() => window.syncCore.getSnapshot().undoDepth),
    1,
    'Materialization joins the originating edit.',
  );
  assert.ok(
    await page.evaluate(() =>
      window.syncCore
        .getNativeFiles()
        .files.some((file) => file.name === 'footprints/NextPCB.pretty/123_fixture.kicad_mod'),
    ),
  );
  await page.waitForFunction(() => window.modelCreated === 2);
  assert.equal(await page.evaluate(() => window.modelDisposed), 1);
  assertCamera(
    await page.evaluate(() => window.modelCamera.camera.position.toArray()),
    await page.evaluate(() => window.cameraBefore),
  );
  await page.evaluate(() => window.syncCore.undo());
  await waitForAsync(page, () => window.syncCore.getSnapshot().project.pcb.footprints.length === 0);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: Model-only retry, pending/error status, keyboard/IME and Source/close gates, retained canvas/camera and one undo (isolated browser).',
  );
} finally {
  await browser.close();
}
