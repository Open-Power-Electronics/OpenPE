import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { bundledWorkbenchCatalog } from '../server/workbench-plugins.mjs';
import { parseProject, projectNativeFiles } from '../server/project-format.mjs';
import { fillSource, readSource } from './source-editor-test-helpers.mjs';

// Code-split renderer and in-memory native/service fixtures. No Electron or user data.
const source = await readFile('tests/fixtures/rc-filter.openpe.json', 'utf8');
const emcSource = await readFile('lib/emc-flyback-example.json', 'utf8');
const homeManifest = JSON.parse(
  await readFile('resources/example-catalog/home-manifest.json', 'utf8'),
);
const homeCatalog = [...homeManifest.recent, ...homeManifest.examples];
assert.equal(homeCatalog.length, 10);
assert.equal(new Set(homeCatalog.map((entry) => entry.id)).size, 10);
const projectId = '00000000-0000-4000-8000-000000000001';
let recovery = {
  version: 2,
  documents: [
    {
      id: projectId,
      source,
      sourceDraft: null,
      dirty: false,
      filename: 'rc.kicad_pro',
      sessions: [{ id: 'session-one', messages: [], draft: '' }],
      activeSessionId: 'session-one',
    },
  ],
  activeDocumentId: projectId,
  provider: 'codex',
  effort: 'low',
  approvalMode: 'review',
  models: {},
};
const outputDirectory = path.resolve('test-results/startup-ui-bundle');
const options = {
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import Workspace from './components/DesktopWorkspace';
      const LibraryChooser = React.lazy(() => import('./components/LibraryChooser'));
      const root = createRoot(document.getElementById('root'));
      root.render(<Workspace/>);
      window.showFootprints = () => root.render(<React.Suspense fallback={null}><LibraryChooser kind="footprints" onClose={()=>{}} onChoose={()=>{}}/></React.Suspense>);`,
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
      name: 'count-local-example-factories',
      setup(builder) {
        builder.onLoad(
          { filter: /[\\/]lib[\\/]create-home-example\.ts$/ },
          async ({ path: file }) => {
            const original = await readFile(file, 'utf8');
            const marker = "  return id === 'emc-flyback-demo'";
            assert.ok(
              original.includes(marker),
              'Instrumentation counts the real example factory.',
            );
            return {
              contents: original.replace(marker, `  window.localExampleFactories++;\n${marker}`),
              loader: 'ts',
              resolveDir: path.dirname(file),
            };
          },
        );
      },
    },
  ],
};
const bundle = await build(options);
const entry = Object.keys(bundle.metafile.outputs).find(
  (file) => bundle.metafile.outputs[file].entryPoint === '<stdin>',
);
function staticClosure(metafile, file, visited = new Set()) {
  if (visited.has(file)) return visited;
  visited.add(file);
  for (const dependency of metafile.outputs[file].imports)
    if (!dependency.external && dependency.kind !== 'dynamic-import')
      staticClosure(metafile, dependency.path, visited);
  return visited;
}
const startupFiles = staticClosure(bundle.metafile, entry);
const startupInputs = [...startupFiles].flatMap((file) =>
  Object.keys(bundle.metafile.outputs[file].inputs),
);
for (const deferred of [
  '@codemirror/',
  'node_modules/three/',
  'components/SimulationDialog.tsx',
  'components/LayoutEditor.tsx',
  'components/LibraryChooser.tsx',
  'components/ProjectHistoryDialog.tsx',
  'components/PluginsPage.tsx',
  'components/SettingsDialog.tsx',
  'components/AboutDialog.tsx',
  'components/AgentMarkdown.tsx',
  'node_modules/katex/',
  'node_modules/react-markdown/',
  'lib/reference-examples.json',
  'lib/emc-flyback-example.json',
])
  assert.ok(
    !startupInputs.some((input) => input.includes(deferred)),
    `${deferred} stays out of startup imports.`,
  );

// Compare identical current source with the editor import boundaries made eager.
const eager = await build({
  ...options,
  plugins: [
    {
      name: 'eager-startup-baseline',
      setup(build) {
        build.onLoad(
          { filter: /[\\/]components[\\/](Workbench|LibraryChooser)\.tsx$/ },
          async ({ path }) => ({
            contents: (await readFile(path, 'utf8')).replace(
              /const (SourceEditor|SimulationDialog|ModelPreview|LayoutEditor|LibraryChooser|ProjectHistoryDialog|PluginsPage|SettingsDialog|AboutDialog) = lazy\(\(\) => import\('\.\/(\w+)'\)\);/g,
              "import $1 from './$2';",
            ),
            loader: 'tsx',
          }),
        );
      },
    },
  ],
});
const startupBytes = (result) => {
  const first = Object.keys(result.metafile.outputs).find(
    (file) => result.metafile.outputs[file].entryPoint === '<stdin>',
  );
  return [...staticClosure(result.metafile, first)].reduce(
    (sum, file) => sum + result.metafile.outputs[file].bytes,
    0,
  );
};
const beforeBytes = startupBytes(eager),
  afterBytes = startupBytes(bundle);
assert.ok(
  afterBytes < beforeBytes - 700_000,
  'Deferred tools remove their substantial code from initial loading.',
);
const eagerMarkdown = await build({
  ...options,
  plugins: [
    {
      name: 'eager-markdown-baseline',
      setup(builder) {
        builder.onLoad({ filter: /[\\/]components[\\/]Chat\.tsx$/ }, async ({ path }) => ({
          contents: (await readFile(path, 'utf8')).replace(
            "const AgentMarkdown = lazy(() => import('./AgentMarkdown'));",
            "import AgentMarkdown from './AgentMarkdown';",
          ),
          loader: 'tsx',
        }));
      },
    },
  ],
});
const eagerMarkdownBytes = startupBytes(eagerMarkdown);
assert.ok(
  eagerMarkdownBytes - afterBytes > 300_000,
  'Response formatting stays out of the initial renderer load.',
);

const files = new Map(
  bundle.outputFiles.map((file) => [
    '/bundles/' + path.relative(outputDirectory, file.path).replaceAll('\\', '/'),
    file.text,
  ]),
);
const exampleDataChunks = new Set(
  Object.entries(bundle.metafile.outputs)
    .filter(([, output]) =>
      Object.keys(output.inputs).some((input) => input.endsWith('lib/reference-examples.json')),
    )
    .map(([file]) => '/bundles/' + path.basename(file)),
);
assert.ok(exampleDataChunks.size, 'Home example data is emitted in a deferred chunk.');
const chunkFor = (component) =>
  '/bundles/' +
  path.basename(
    Object.keys(bundle.metafile.outputs).find(
      (file) => bundle.metafile.outputs[file].entryPoint === `components/${component}.tsx`,
    ),
  );
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  const errors = [],
    requested = new Set();
  let modelRequests = 0,
    simulationChecks = 0;
  let releaseMarkdown;
  const markdownReady = new Promise((resolve) => {
    releaseMarkdown = resolve;
  });
  let releaseSettings;
  const settingsReady = new Promise((resolve) => {
    releaseSettings = resolve;
  });
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(15000);
  await page.addInitScript(() => {
    window.localExampleFactories = 0;
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
    requested.add(url.pathname);
    if (url.pathname === chunkFor('AgentMarkdown')) await markdownReady;
    if (url.pathname === chunkFor('SettingsDialog')) await settingsReady;
    if (files.has(url.pathname))
      return route.fulfill({ contentType: 'text/javascript', body: files.get(url.pathname) });
    if (url.pathname === '/api/state') {
      if (route.request().method() === 'POST') recovery = route.request().postDataJSON();
      return route.fulfill({ json: recovery });
    }
    if (url.pathname === '/api/workbench-plugins')
      return route.fulfill({ json: bundledWorkbenchCatalog() });
    if (url.pathname === '/api/appearance') return route.fulfill({ json: null });
    if (url.pathname === '/api/agents') return route.fulfill({ json: [] });
    if (url.pathname === '/api/simulation/status') {
      simulationChecks++;
      return route.fulfill({ json: { available: false, error: 'Isolated renderer fixture.' } });
    }
    if (url.pathname === '/api/libraries/footprints') {
      const entry = {
        id: 'Fixture:Pad',
        name: 'Pad',
        library: 'Fixture',
        description: 'Test footprint',
      };
      return route.fulfill({
        json: url.searchParams.has('id')
          ? {
              ...entry,
              footprint: [
                'footprint',
                'Pad',
                ['pad', '1', 'smd', 'rect', ['at', '0', '0'], ['size', '1', '1']],
              ],
              pads: ['1'],
              models: [{ path: 'Fixture.step' }],
            }
          : { entries: [entry], libraries: ['Fixture'], total: 1 },
      });
    }
    if (url.pathname === '/api/library-model') {
      modelRequests++;
      return route.fulfill({
        status: 422,
        json: { error: 'The linked 3D model is unavailable. The 2D footprint can still be used.' },
      });
    }
    if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(url.pathname))
      return route.fulfill({ body: await readFile('public' + url.pathname) });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  const mount = async () => {
    await page.goto('http://localhost');
    for (const file of ['app/globals.css', 'app/workspace.css'])
      await page.addStyleTag({ content: await readFile(file, 'utf8') });
    await page.addScriptTag({
      type: 'module',
      url: 'http://localhost/bundles/' + path.basename(entry),
    });
  };
  await mount();
  const button = (name) => page.getByRole('button', { name, exact: true });
  await page.getByTestId('schematic-canvas').waitFor();
  assert.equal(
    await page.locator('.cm-editor').count(),
    0,
    'Hidden Source is not initialized during recovery.',
  );
  for (const component of [
    'SourceEditor',
    'SimulationDialog',
    'ModelPreview',
    'LayoutEditor',
    'AgentMarkdown',
    'LibraryChooser',
    'ProjectHistoryDialog',
    'PluginsPage',
    'SettingsDialog',
    'AboutDialog',
  ])
    assert.equal(
      requested.has(chunkFor(component)),
      false,
      `${component} is not downloaded on startup.`,
    );
  assert.equal(simulationChecks, 0);
  assert.equal(
    [...requested].some((url) => exampleDataChunks.has(url)),
    false,
    'Recovering a project does not fetch Home example data.',
  );
  await button('Settings').click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  const loadingSettings = page.getByRole('dialog', { name: 'Settings', exact: true });
  await loadingSettings.getByRole('status').waitFor();
  assert.ok(
    await loadingSettings.evaluate((dialog) => dialog.matches(':modal')),
    'Deferred dialogs block background input while their code loads.',
  );
  await page.keyboard.press('Escape');
  await loadingSettings.waitFor({ state: 'hidden' });
  releaseSettings();
  await button('Settings').click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Appearance', exact: true }).waitFor();
  await button('Done').click();
  await button('Plugins').click();
  await page.getByRole('button', { name: /^Marketplace/ }).waitFor();
  assert.ok(requested.has(chunkFor('PluginsPage')));
  await page.getByRole('button', { name: 'Return to workspace', exact: true }).click();
  recovery.documents[0].sessions[0].messages = [
    { id: 'user', role: 'user', text: '**Literal question**' },
    {
      id: 'assistant',
      role: 'assistant',
      text: '**Output** $V=5$\n\n```openpe\n{"ops":[]}\n```',
    },
  ];
  await mount();
  await page.getByTestId('schematic-canvas').waitFor();
  const reply = page.locator('.agent-markdown');
  await reply.getByText('**Output** $V=5$', { exact: true }).waitFor();
  assert.doesNotMatch(await reply.innerText(), /ops|openpe/);
  assert.equal(await reply.locator('strong').count(), 0);
  assert.equal(
    await page.locator('.message.user .message-text').innerText(),
    '**Literal question**',
  );
  assert.ok(
    requested.has(chunkFor('AgentMarkdown')),
    'Recovered replies load their formatter on demand.',
  );
  releaseMarkdown();
  await reply.locator('strong').getByText('Output', { exact: true }).waitFor();
  await reply.locator('.katex').waitFor();
  assert.doesNotMatch(await reply.innerText(), /ops|openpe/);
  await button('Layout').click();
  await page.getByTestId('layout-canvas').waitFor();
  assert.ok(requested.has(chunkFor('LayoutEditor')));
  await page.evaluate(() => {
    window.originalLayout = document.querySelector('[data-testid="layout-canvas"]');
  });
  await button('Schematic').click();
  await button('Layout').click();
  assert.ok(
    await page.evaluate(
      () => window.originalLayout === document.querySelector('[data-testid="layout-canvas"]'),
    ),
    'Layout stays mounted after first use.',
  );
  await button('Schematic').click();
  await button('Source').click();
  await page.getByRole('textbox', { name: 'Project file source', exact: true }).waitFor();
  assert.ok(requested.has(chunkFor('SourceEditor')));
  const original = await readSource(page);
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  await page.evaluate(() => {
    window.originalEditor = document.querySelector('.cm-editor');
  });
  await fillSource(page, original + ' ');
  await button('Home').click();
  await page.locator(`[data-project-id="${projectId}"] button:visible`).click();
  assert.equal(
    await readSource(page),
    original + ' ',
    'Returning retains the pending Source draft.',
  );
  const editor = page.getByRole('textbox', { name: 'Project file source', exact: true });
  await editor.press('ControlOrMeta+z');
  assert.equal(await readSource(page), original, 'Text undo survives Home navigation.');
  await page.waitForFunction(
    () => document.querySelectorAll('.project-navigation .dirty-dot').length === 0,
  );
  await button('Schematic').click();
  await button('Source').click();
  assert.ok(
    await page.evaluate(() => window.originalEditor === document.querySelector('.cm-editor')),
    'The same Source editor remains mounted after first use.',
  );
  await button('Schematic').click();
  assert.equal(requested.has(chunkFor('SimulationDialog')), false);
  await button('SPICE Simulation').click();
  const settings = page.getByRole('region', { name: 'Simulation settings', exact: true });
  await settings.waitFor();
  assert.ok(requested.has(chunkFor('SimulationDialog')));
  await page.getByLabel('Duration (ms)', { exact: true }).fill('3');
  await button('Close simulation settings').click();
  await button('SPICE Simulation').click();
  assert.equal(await page.getByLabel('Duration (ms)', { exact: true }).inputValue(), '3');
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);

  await page.evaluate(() => window.showFootprints());
  await page.getByLabel('Footprint preview', { exact: true }).waitFor();
  assert.equal(
    requested.has(chunkFor('ModelPreview')),
    false,
    '2D browsing does not load Three.js.',
  );
  assert.equal(modelRequests, 0);
  await button('3D model').click();
  await page
    .getByText('The linked 3D model is unavailable. The 2D footprint can still be used.', {
      exact: true,
    })
    .waitFor();
  assert.ok(requested.has(chunkFor('ModelPreview')));
  assert.equal(modelRequests, 1);
  await button('Footprint').click();
  await page.getByLabel('Footprint preview', { exact: true }).waitFor();

  const recoveredDraft = projectNativeFiles(parseProject(recovery.documents[0].source));
  recoveredDraft.files[0].source = '{unfinished';
  recovery.documents[0].sourceDraft = JSON.stringify(recoveredDraft);
  await mount();
  await page.getByRole('textbox', { name: 'Project file source', exact: true }).waitFor();
  assert.equal(
    await readSource(page),
    '{unfinished',
    'A recovered draft initializes Source immediately.',
  );
  await button('Schematic').click();
  assert.equal(await readSource(page), '{unfinished', 'Invalid recovered Source remains editable.');
  recovery = { ...recovery, documents: [], activeDocumentId: null };
  await mount();
  await page.getByRole('textbox', { name: 'Describe your circuit', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('alert').count(),
    0,
    'Home starts without example preflight warnings.',
  );
  await page.waitForFunction(
    (count) => document.querySelectorAll('.home-example-preview svg').length === count,
    homeCatalog.length,
  );
  assert.ok(
    [...requested].some((url) => exampleDataChunks.has(url)),
    'Home loads full example data when idle previews need it.',
  );
  await button('Open LM2596 Buck example').click();
  await page.getByTestId('schematic-canvas').waitFor();
  assert.equal(
    await page.locator('.project-navigation .dirty-dot').count(),
    0,
    'Opening a deferred example starts clean.',
  );
  // Native opening uses the host's prepared project instead of first building
  // and discarding a fresh full-board example in the renderer.
  await button('Home').click();
  const factoriesBeforeNativeOpen = await page.evaluate(() => window.localExampleFactories);
  const nativeId = '00000000-0000-4000-8000-000000000002';
  await page.evaluate(
    ({ source, id }) => {
      window.nativeExampleOpens = 0;
      window.openpe.openDefaultExample = async (key) => {
        window.nativeExampleOpens++;
        if (key !== 'example:emc-flyback-demo') throw new Error('Unexpected native example.');
        return { id, source, fileId: 'native-emc', filename: 'project.kicad_pro' };
      };
    },
    { source: emcSource, id: nativeId },
  );
  await button('Open EMC Flyback example').click();
  await page.locator(`[data-project-id="${nativeId}"]`).waitFor();
  await page.getByTestId('schematic-canvas').waitFor();
  assert.equal(await page.getByTestId('schematic-canvas').locator('.part').count(), 140);
  assert.equal(
    await page.evaluate(() => window.localExampleFactories),
    factoriesBeforeNativeOpen,
    'Native EMC opening never constructs a discarded renderer example.',
  );
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  await button('Home').click();
  await button('Open EMC Flyback example').click();
  await page.getByTestId('schematic-canvas').waitFor();
  assert.equal(
    await page.evaluate(() => window.nativeExampleOpens),
    1,
    'Reopening an active native example selects its retained editor.',
  );
  assert.equal(await page.locator(`[data-project-id="${nativeId}"]`).count(), 1);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      beforeBytes,
      afterBytes,
      eagerMarkdownBytes,
      deferredMarkdownBytes: eagerMarkdownBytes - afterBytes,
      reductionPercent: +((1 - afterBytes / beforeBytes) * 100).toFixed(1),
    }),
  );
  console.log(
    'Startup: deferred module requests, Source history/dirty state/recovery, simulation settings retention and 2D/3D first use passed.',
  );
} finally {
  await browser.close();
}
