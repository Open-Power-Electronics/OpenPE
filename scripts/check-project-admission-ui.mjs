import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { bundledWorkbenchCatalog } from '../server/workbench-plugins.mjs';
import { parseProject, projectNativeFiles } from '../server/project-format.mjs';
import { readNativeFiles } from './source-editor-test-helpers.mjs';

// Real development Strict Mode workspace/Core with in-memory native/service
// adapters. No desktop profile, provider, solver or project file is touched.
const source = await readFile('lib/emc-flyback-example.json', 'utf8');
const native = projectNativeFiles(parseProject(source), 'project.kicad_pro');
const id = '00000000-0000-4000-8000-000000000023';
const bundle = await build({
  stdin: {
    contents: `import React from 'react';import{createRoot}from'react-dom/client';
      import Workspace from './components/DesktopWorkspace';
      window.admissionMetrics={imports:0,stages:0,reads:0,hits:0,releases:0,fallbacks:0,savedFallbacks:0};
      createRoot(document.getElementById('root')).render(<React.StrictMode><Workspace/></React.StrictMode>);`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  platform: 'browser',
  outdir: 'test-results/project-admission-ui-bundle',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [
    {
      name: 'admission-boundary-counts',
      setup(builder) {
        builder.onLoad(
          { filter: /[\\/](project-admission\.ts|DesktopWorkspace\.tsx|Workbench\.tsx)$/ },
          async ({ path: file }) => {
            let code = await readFile(file, 'utf8');
            const replace = (marker, replacement) => {
              assert.ok(code.includes(marker), `Instrumentation stays attached: ${marker}`);
              code = code.replace(marker, replacement);
            };
            if (file.endsWith('project-admission.ts')) {
              replace(
                'stage(id: string, input: Project): string {',
                'stage(id: string, input: Project): string { window.admissionMetrics.stages++;',
              );
              replace(
                'const entry = pending.get(id);',
                'const entry = pending.get(id); window.admissionMetrics.reads++; if(entry?.source===source)window.admissionMetrics.hits++;',
              );
              replace(
                'pending.delete(id);',
                'if(pending.has(id))window.admissionMetrics.releases++; pending.delete(id);',
              );
            } else if (file.endsWith('DesktopWorkspace.tsx')) {
              replace(
                'project = importDocument(local.source);',
                'window.admissionMetrics.imports++; project = importDocument(local.source);',
              );
            } else {
              replace(
                'importDocument(initialState.source)',
                '(window.admissionMetrics.fallbacks++, importDocument(initialState.source))',
              );
              replace(
                'parseProject(cleanSource)',
                '(window.admissionMetrics.savedFallbacks++, parseProject(cleanSource))',
              );
            }
            return {
              contents: code,
              loader: file.endsWith('.tsx') ? 'tsx' : 'ts',
              resolveDir: path.dirname(file),
            };
          },
        );
      },
    },
  ],
});
const browser = await chromium.launch({
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
  headless: true,
});
const errors = [];
const preferences = { provider: 'codex', effort: 'low', approvalMode: 'review', models: {} };
async function mount(recover) {
  const page = await browser.newPage({ viewport: { width: 1480, height: 920 } });
  page.setDefaultTimeout(45000);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(
    ({ source, id }) => {
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
        openDefaultExample: async (key) => {
          if (key !== 'example:emc-flyback-demo') throw new Error('Unexpected example.');
          return { id, source, fileId: 'native-admission-emc', filename: 'project.kicad_pro' };
        },
      };
    },
    { source, id },
  );
  const state = {
    version: 2,
    documents: recover
      ? [
          {
            id,
            source,
            sourceDraft: null,
            dirty: false,
            filename: 'project.kicad_pro',
            sessions: [{ id: 'first', messages: [], draft: '' }],
            activeSessionId: 'first',
          },
        ]
      : [],
    activeDocumentId: recover ? id : null,
    ...preferences,
  };
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/state') return route.fulfill({ json: state });
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
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  for (const file of bundle.outputFiles.filter((file) => file.path.endsWith('.css')))
    await page.addStyleTag({ content: file.text });
  await page.addScriptTag({
    content: bundle.outputFiles.find((file) => file.path.endsWith('.js')).text,
  });
  return page;
}
try {
  const page = await mount(false);
  await page.getByRole('button', { name: 'Open EMC Flyback example', exact: true }).click();
  const canvas = page.getByTestId('schematic-canvas');
  await canvas.waitFor();
  await page.waitForFunction(() => window.admissionMetrics.releases === 1);
  const admitted = await page.evaluate(() => window.admissionMetrics);
  assert.deepEqual(admitted, {
    imports: 1,
    stages: 1,
    reads: 2,
    hits: 2,
    releases: 1,
    fallbacks: 0,
    savedFallbacks: 0,
  });
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  const opened = await readNativeFiles(page);
  assert.deepEqual(opened, native);
  await page.getByRole('button', { name: 'Schematic', exact: true }).click();
  await page.getByTestId('symbol-hit-R1').click();
  await canvas.focus();
  await canvas.press('ArrowRight');
  await page.locator('.dirty-dot').first().waitFor();
  await canvas.press('Control+z');
  await page.waitForFunction(() => !document.querySelector('.dirty-dot'));
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  assert.deepEqual(await readNativeFiles(page), opened);
  await page.close();
  const recovered = await mount(true);
  await recovered.getByTestId('schematic-canvas').waitFor();
  const fallback = await recovered.evaluate(() => window.admissionMetrics);
  assert.equal(fallback.imports, 0);
  assert.equal(fallback.stages, 0);
  assert.equal(fallback.reads, 2);
  assert.equal(fallback.hits, 0);
  assert.equal(fallback.fallbacks, 2);
  assert.equal(fallback.savedFallbacks, 0);
  assert.equal(await recovered.locator('.project-navigation .dirty-dot').count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ admitted, fallback }));
  console.log(
    'Project admission passed: one native import, exact Source handoff through Strict Mode, release after registration, native bytes/undo and independent recovery fallback.',
  );
} finally {
  await browser.close();
}
