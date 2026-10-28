import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { bundledWorkbenchCatalog } from '../server/workbench-plugins.mjs';
import { fillSource, readSource } from './source-editor-test-helpers.mjs';

// Isolated real React editors with in-memory native/service adapters only.
// No Electron instance, provider, solver or native project files are touched.
const { createProject, parseProject, serializeProject } = await tsImport(
  '../lib/project.ts',
  import.meta.url,
);
const { projectNativeFiles, projectFromNativeFiles } = await tsImport(
  '../lib/kicad-project.ts',
  import.meta.url,
);
const { switchingStageFixture } = await tsImport(
  '../tests/fixtures/switching-stage.ts',
  import.meta.url,
);
const files = projectNativeFiles(createProject(), 'circuit.kicad_pro');
const project = projectFromNativeFiles(files);
project.name = 'Power stage';
project.extensions = { 'example.org': { retained: true } };
const source = serializeProject(project);
const documentId = crypto.randomUUID();
let recovery = {
  version: 2,
  documents: [
    {
      id: documentId,
      source,
      sourceDraft: null,
      dirty: false,
      filename: files.entry,
      sessions: [{ id: 'session-one', messages: [], draft: '' }],
      activeSessionId: 'session-one',
    },
  ],
  activeDocumentId: documentId,
  provider: 'codex',
  effort: 'low',
  approvalMode: 'review',
  models: {},
};
const entry = async (contents, name) =>
  build({
    stdin: { contents, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true,
    write: false,
    outfile: `test-results/${name}.js`,
    platform: 'browser',
    define: { 'process.env.NODE_ENV': '"development"' },
  });
const [workspaceBundle, simulationBundle] = await Promise.all([
  entry(
    `import React from 'react'; import {createRoot} from 'react-dom/client';
     import Workspace from './components/DesktopWorkspace';
     createRoot(document.getElementById('root')).render(<Workspace/>);`,
    'lifecycle-workspace',
  ),
  entry(
    `import React,{useState,useRef} from 'react';import{createRoot}from'react-dom/client';
     import Simulation from './components/SimulationDialog';
     const project=${JSON.stringify(createProject(switchingStageFixture()))};
     function Harness(){const[visible,setVisible]=useState(true);const settings=useRef(null);
       const waveforms=useRef(null);const context=useRef(null);
       window.simulationLifecycle={setVisible,read:()=>context.current?.()};
       return <><div ref={settings}/><div ref={waveforms}/><Simulation project={project}
         visible={visible} sourcePending={false} probe={null} settingsHost={settings}
         waveformHost={waveforms} agentContextRef={context} onWaveformVisibilityChange={()=>{}}/></>;}
     createRoot(document.getElementById('root')).render(<Harness/>);`,
    'lifecycle-simulation',
  ),
]);
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
const errors = [];
async function mount(page, bundle) {
  page.setDefaultTimeout(15000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
    await page.addStyleTag({ content: file.text });
  await page.addScriptTag({
    content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
  });
}
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  await page.addInitScript(() => {
    window.lifecycleGrants = [];
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
      newFile: async () => {
        const grant = crypto.randomUUID();
        window.lifecycleGrants.push(grant);
        return grant;
      },
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
    if (url.pathname === '/api/agents') return route.fulfill({ json: [] });
    if (url.pathname === '/api/models')
      return route.fulfill({ json: { models: [], defaultModel: '' } });
    if (url.pathname === '/api/workbench-plugins')
      return route.fulfill({ json: bundledWorkbenchCatalog() });
    if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(url.pathname))
      return route.fulfill({ body: await readFile('public' + url.pathname) });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await mount(page, workspaceBundle);
  const button = (name) => page.getByRole('button', { name, exact: true });
  const navigation = () => page.locator('.project-navigation:visible [data-project-id]');
  const duplicate = async (index, count) => {
    const persisted = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/state' &&
        response.request().method() === 'POST' &&
        response.request().postDataJSON().documents.length === count,
    );
    await navigation().nth(index).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Duplicate project', exact: true }).click();
    await persisted;
    assert.equal(await navigation().count(), count);
    return recovery.documents.at(-1);
  };
  await page.getByTestId('schematic-canvas').waitFor();
  const cleanCopy = await duplicate(0, 2);
  assert.equal(parseProject(cleanCopy.source).name, 'Power stage copy');
  assert.equal(cleanCopy.sourceDraft, null);
  assert.notEqual(cleanCopy.id, documentId, 'A duplicate owns a separate editor identity.');

  await navigation().first().locator('button').click();
  await button('Source').click();
  const originalText = await readSource(page);
  const settings = JSON.parse(originalText);
  settings.text_variables = { REVISION: 'Draft edit' };
  const draftText = JSON.stringify(settings, null, 2) + '\n';
  await fillSource(page, draftText);
  const draftCopy = await duplicate(0, 3);
  const duplicated = parseProject(draftCopy.source);
  assert.equal(duplicated.name, 'Power stage copy');
  assert.equal(duplicated.id, project.id, 'Native document UUIDs retain their existing links.');
  assert.equal(duplicated.schematic.id, project.schematic.id);
  assert.deepEqual(duplicated.extensions, project.extensions);
  assert.equal(draftCopy.sourceDraft, null);
  assert.deepEqual(
    JSON.parse(
      projectNativeFiles(duplicated).files.find((file) => file.name.endsWith('.kicad_pro')).source,
    ),
    { ...settings, meta: { ...settings.meta, filename: 'circuit-copy.kicad_pro' } },
  );
  const original = recovery.documents.find((item) => item.id === documentId);
  assert.equal(original.source, source, 'Duplicate never applies the original Source draft.');
  assert.equal(JSON.parse(original.sourceDraft).files[0].source, draftText);
  assert.equal(new Set(recovery.documents.map((item) => item.id)).size, 3);
  assert.equal(new Set(await page.evaluate(() => window.lifecycleGrants)).size, 3);

  await navigation().first().locator('button').click();
  assert.equal(await readSource(page), draftText);
  await fillSource(page, '{invalid native JSON');
  await navigation().first().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Duplicate project', exact: true }).click();
  await page.getByText(/\.kicad_pro file must contain valid JSON/).waitFor();
  assert.equal(await navigation().count(), 3);
  assert.equal(await readSource(page), '{invalid native JSON');
  assert.equal((await page.evaluate(() => window.lifecycleGrants)).length, 3);

  const simulation = await browser.newPage();
  await simulation.addInitScript(() => {
    window.detectionRequests = [];
    window.openpe = {
      connection: async () => ({ base: 'http://localhost', token: 'test' }),
    };
    window.fetch = async (_url, options) =>
      new Promise((resolve, reject) => {
        const request = { aborted: false, resolve };
        window.detectionRequests.push(request);
        options.signal.addEventListener('abort', () => {
          request.aborted = true;
          reject(new DOMException('Cancelled fixture detection.', 'AbortError'));
        });
      });
  });
  await simulation.route('http://localhost/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }),
  );
  await mount(simulation, simulationBundle);
  await simulation.waitForFunction(() => window.detectionRequests.length === 1);
  await simulation.evaluate(() => window.simulationLifecycle.setVisible(false));
  await simulation.waitForFunction(() => window.detectionRequests[0].aborted);
  await simulation.waitForFunction(() => window.simulationLifecycle.read().status !== 'detecting');
  await simulation.evaluate(() => window.simulationLifecycle.setVisible(true));
  await simulation.waitForFunction(() => window.detectionRequests.length === 2);
  await simulation.evaluate(() => {
    window.detectionRequests[1].resolve(
      new Response(JSON.stringify({ available: true }), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
  await simulation.waitForFunction(() => window.simulationLifecycle.read().status === 'idle');
  assert.deepEqual(errors, []);
  console.log(
    'Project lifecycle passed: independent clean/draft copies, retained metadata and Source, invalid-draft protection, and hidden solver detection cancellation/retry.',
  );
} finally {
  await browser.close();
}
