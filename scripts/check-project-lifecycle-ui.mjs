import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { bundledWorkbenchCatalog } from '../server/workbench-plugins.mjs';
import { fillSource, readSource } from './source-editor-test-helpers.mjs';

// Isolated real React editors with in-memory native/service adapters only.
// No Electron instance, provider, solver or native project files are touched.
const { createProject, serializeProject } = await tsImport('../lib/project.ts', import.meta.url);
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
    if (url.pathname === '/api/agent-settings')
      return route.fulfill({ json: { followUpMode: 'queue' } });
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
  const rename = async (name) => {
    await navigation().first().click({ button: 'right' });
    assert.equal(
      await page.getByRole('menuitem', { name: 'Duplicate project', exact: true }).count(),
      0,
    );
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill(name);
    await button('Rename').click();
  };
  await page.getByTestId('schematic-canvas').waitFor();
  await rename('Power stage review');
  await page.getByRole('tab', { name: /^Power stage review(?:,|$)/ }).waitFor();
  assert.equal(await navigation().count(), 1);
  await button('Source').click();
  const originalText = await readSource(page);
  const settings = JSON.parse(originalText);
  assert.equal(settings.text_variables.OPENPE_PROJECT_NAME, 'Power stage review');
  settings.text_variables.REVISION = 'Draft edit';
  const draftText = JSON.stringify(settings, null, 2) + '\n';
  await fillSource(page, draftText);
  await rename('Retryable name');
  await page
    .getByRole('alert')
    .getByText('Apply the Source edits before changing the project.')
    .waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: 'Name', exact: true }).inputValue(),
    'Retryable name',
  );
  await button('Cancel').click();
  assert.equal(await readSource(page), draftText);
  assert.equal(await navigation().count(), 1);
  assert.equal((await page.evaluate(() => window.lifecycleGrants)).length, 1);

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
    'Project lifecycle passed: project renaming, retained metadata and Source, pending-draft protection, and hidden solver detection cancellation/retry.',
  );
} finally {
  await browser.close();
}
