import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { readSource, selectSourceFile, fillSource } from './source-editor-test-helpers.mjs';
import { waitForAsync } from './async-browser-test-helpers.mjs';
import { defaultAgentPreferences, restoreWorkspace } from '../server/workspace-format.mjs';

// Real retained Workbenches and CodeMirror in a mocked headless renderer.
// This never starts Electron, a provider, a solver or a native project write.
const stems = ['lm2735-msop8-sepic', 'lmr12010-sot236-buck'];
const reviewed = JSON.parse(await readFile('resources/example-catalog/ic-datasheets.json', 'utf8'));
const records = stems.map((stem) => reviewed.find((record) => record.example.file === stem));
const ids = stems.map(() => crypto.randomUUID());
const sources = await Promise.all(
  stems.map((stem) => readFile(`tests/fixtures/reference/${stem}.json`, 'utf8')),
);
let recovery = {
  version: 2,
  documents: sources.map((source, index) => ({
    id: ids[index],
    source,
    sourceDraft: null,
    dirty: false,
    filename: `${stems[index]}.kicad_pro`,
    exampleKey: null,
    localExample: false,
    sessions: [{ id: `session-${index}`, messages: [], draft: '' }],
    activeSessionId: `session-${index}`,
  })),
  activeDocumentId: ids[0],
  ...structuredClone(defaultAgentPreferences),
};
restoreWorkspace(recovery);
const bundle = await build({
  stdin: {
    contents: `import React from 'react';import {createRoot} from 'react-dom/client';
    import Workspace from './components/DesktopWorkspace';createRoot(document.getElementById('root')).render(<Workspace/>);`,
    loader: 'tsx',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  outdir: 'test-results/datasheets-ui-bundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [
    {
      name: 'observe-datasheet-host',
      setup(plugin) {
        plugin.onLoad(
          { filter: /[\\/]components[\\/]Workbench\.tsx$/ },
          async ({ path: file }) => ({
            contents: (await readFile(file, 'utf8')).replace(
              'const capabilityPorts = useRef<WorkbenchCapabilityPorts>(null!);',
              `window.datasheetHosts ??= {}; window.datasheetHosts[documentId] = {core, query: (name) => capabilityHost.query(name), context: readWorkspaceContext};
         const capabilityPorts = useRef<WorkbenchCapabilityPorts>(null!);`,
            ),
            resolveDir: path.dirname(file),
            loader: 'tsx',
          }),
        );
      },
    },
  ],
});
const browser = await chromium.launch({
  headless: true,
  channel:
    process.env.OPENPE_BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined),
});
let page;
const errors = [];
try {
  page = await browser.newPage({ viewport: { width: 1480, height: 920 } });
  page.setDefaultTimeout(20000);
  const sent = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(
    ({ records }) => {
      const texts = records.map((record) => JSON.stringify(record, null, 2) + '\n');
      let nextGrant = 0;
      const recordFor = (fileId) => Number(fileId.slice('fixture-grant-'.length));
      const textPreview = (fileId) => ({
        source: texts[recordFor(fileId)],
        bytes: new TextEncoder().encode(texts[recordFor(fileId)]).length,
        binary: false,
        truncated: false,
        readOnly: false,
      });
      const pdf = '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n';
      window.projectFileWrites = [];
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
        listExamples: async () => ({ entries: [], warnings: [] }),
        listRecent: async () => ({ initialized: true, entries: [], warnings: [] }),
        onRecentChanged: () => () => {},
        newFile: async () => `fixture-grant-${nextGrant++}`,
        projectDirectory: async (fileId) => ({
          entries: [
            { name: 'notes', kind: 'directory' },
            { name: 'datasheets', kind: 'directory' },
            { name: 'notes/review.json', kind: 'file', id: `${fileId}:parameters` },
            { name: 'datasheets/controller.pdf', kind: 'file', id: `${fileId}:pdf` },
          ],
          truncated: false,
        }),
        projectFilePreview: async ({ fileId, id }) =>
          id.endsWith(':pdf')
            ? {
                source: `PDF document\nSize: ${pdf.length} bytes\n`,
                bytes: pdf.length,
                binary: true,
                truncated: false,
                readOnly: true,
                pdf: true,
              }
            : textPreview(fileId),
        projectFileWrite: async ({ fileId, id, source, expectedSource }) => {
          if (texts[recordFor(fileId)] !== expectedSource) throw new Error('The file changed.');
          texts[recordFor(fileId)] = source;
          window.projectFileWrites.push({ fileId, id, source });
          return textPreview(fileId);
        },
        projectFilePdf: async () => ({ base64: btoa(pdf), bytes: pdf.length }),
        releaseFile: async () => {},
        setDirty: async () => {},
        onCloseRequested: () => () => {},
      };
    },
    { records },
  );
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/state') {
      if (route.request().method() === 'POST') recovery = route.request().postDataJSON();
      return route.fulfill({ json: recovery });
    }
    if (url.pathname === '/api/agent-settings')
      return route.fulfill({ json: { followUpMode: 'queue' } });
    if (url.pathname === '/api/appearance') return route.fulfill({ json: null });
    if (url.pathname === '/api/agents')
      return route.fulfill({
        json: [{ id: 'codex', available: true, supportsCapabilities: true }],
      });
    if (url.pathname === '/api/models')
      return route.fulfill({
        json: {
          models: [{ id: 'fixture-model', label: 'Fixture model', efforts: [] }],
          defaultModel: 'fixture-model',
        },
      });
    if (url.pathname === '/api/chat') {
      sent.push(route.request().postDataJSON());
      return route.fulfill({
        contentType: 'text/event-stream',
        body: 'data: {"type":"text","text":"IC reference received."}\n\ndata: {"type":"done","outcome":"completed"}\n\n',
      });
    }
    if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(url.pathname))
      return route.fulfill({ body: await readFile('public' + url.pathname) });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.getByTestId('schematic-canvas').waitFor();
  const snapshot = (id) =>
    page.evaluate((id) => {
      const state = window.datasheetHosts[id].core.getSnapshot();
      return {
        source: state.source,
        sourceDraft: state.sourceDraft,
        revision: state.revision,
        undoDepth: state.undoDepth,
      };
    }, id);
  const projectButton = (id) =>
    page
      .getByRole('group', { name: 'Open projects', exact: true })
      .locator(`[data-project-id="${id}"]`)
      .getByRole('button', { name: /, Project \d+(?:,|$)/ });
  const initial = await snapshot(ids[0]);
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  assert.equal(await page.getByRole('navigation', { name: 'Generations', exact: true }).count(), 0);
  await selectSourceFile(page, 'notes/review.json');
  await waitForAsync(page, () =>
    document
      .querySelector('.source-editor-code .cm-content')
      ?.textContent.includes('schema_version'),
  );
  assert.deepEqual(JSON.parse(await readSource(page)), records[0]);
  assert.equal(
    await page.locator('.source-editor-code .cm-content').getAttribute('contenteditable'),
    'true',
  );
  const editedRecord = structuredClone(records[0]);
  editedRecord.extraction.notes.push('User review draft');
  const editedText = JSON.stringify(editedRecord, null, 2) + '\n';
  await fillSource(page, editedText);
  assert.equal(await readSource(page), editedText);
  await page.getByRole('button', { name: 'Save file', exact: true }).click();
  await waitForAsync(page, () => window.projectFileWrites.length === 1);
  assert.equal(await readSource(page), editedText);
  assert.deepEqual(await snapshot(ids[0]), initial);

  // Ordinary directory text stays separate from the reviewed Agent record.
  await page.getByRole('button', { name: 'Schematic', exact: true }).click();
  const hiddenFileContext = await page.evaluate(
    (id) => window.datasheetHosts[id].context(),
    ids[0],
  );
  assert.deepEqual(hiddenFileContext.icDatasheet.record, records[0]);
  assert.ok(!JSON.stringify(hiddenFileContext).includes('User review draft'));
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  assert.equal(await readSource(page), editedText);
  assert.deepEqual(await snapshot(ids[0]), initial);

  // Native drafts and file histories survive visits to real supporting files.
  const nativeFiles = page.getByRole('navigation', { name: 'Project files', exact: true });
  const nativeName = await nativeFiles
    .locator('[data-source-file$=".kicad_pro"]')
    .first()
    .getAttribute('data-source-file');
  await selectSourceFile(page, nativeName);
  await fillSource(page, '{invalid native draft');
  const pending = await snapshot(ids[0]);
  assert.notEqual(pending.sourceDraft, null);
  await selectSourceFile(page, 'notes/review.json');
  assert.equal(await readSource(page), editedText);
  assert.equal(
    await page.getByRole('button', { name: 'Save file', exact: true }).isDisabled(),
    true,
  );
  const queried = await page.evaluate(
    (id) => window.datasheetHosts[id].query('project.datasheet'),
    ids[0],
  );
  assert.equal(queried.status, 'available');
  assert.deepEqual(queried.record, records[0]);
  await selectSourceFile(page, nativeName);
  assert.equal(await readSource(page), '{invalid native draft');
  await page.locator('.source-editor-code .cm-content').press('ControlOrMeta+z');
  assert.equal((await snapshot(ids[0])).sourceDraft, null);

  // A local PDF is displayed through the grant-bound blob viewer.
  await selectSourceFile(page, 'datasheets/controller.pdf');
  await page.locator('iframe.source-editor-pdf').waitFor();
  assert.ok(
    (await page.locator('iframe.source-editor-pdf').getAttribute('src')).startsWith('blob:'),
  );
  assert.equal(await page.getByRole('button', { name: 'Copy', exact: true }).isDisabled(), true);
  await selectSourceFile(page, 'notes/review.json');
  assert.equal(await readSource(page), editedText);

  // Switch projects: each Source and Agent host must keep its own controller.
  await projectButton(ids[1]).click();
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await selectSourceFile(page, 'notes/review.json');
  await waitForAsync(page, () =>
    document
      .querySelector('.source-editor-code .cm-content')
      ?.textContent.includes('schema_version'),
  );
  assert.deepEqual(JSON.parse(await readSource(page)), records[1]);
  const secondContext = await page.evaluate((id) => window.datasheetHosts[id].context(), ids[1]);
  assert.equal(secondContext.icDatasheet.record.ic.family, 'LMR12010');
  const composer = page.getByRole('textbox', { name: 'Message your agent', exact: true });
  await composer.fill('Read the current IC test conditions and datasheet source.');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByText('IC reference received.', { exact: true }).waitFor();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].context.workspace.icDatasheet, undefined);
  await projectButton(ids[0]).click();
  await selectSourceFile(page, 'notes/review.json');
  assert.equal(await readSource(page), editedText);
  assert.equal((await snapshot(ids[0])).undoDepth, initial.undoDepth);
  const staleContext = await page.evaluate(async (id) => {
    const host = window.datasheetHosts[id];
    const reading = host.context().then(
      () => 'unexpected success',
      (error) => error.message,
    );
    host.core.updateSource('{changed during capture');
    const outcome = await reading;
    host.core.discardSource();
    return outcome;
  }, ids[0]);
  assert.match(staleContext, /changed while reading IC specifications/);

  // Controller mismatch affects reviewed context, not the actual supporting file.
  await page.getByRole('button', { name: 'Schematic', exact: true }).click();
  const mismatchContext = await page.evaluate(async (id) => {
    const host = window.datasheetHosts[id];
    const binding = (await host.query('project.datasheet')).bindings[0];
    host.core.execute('part.properties', {
      schematicId: binding.schematicId,
      partId: binding.partId,
      value: 'UNSUPPORTED_TEST_CONTROLLER',
    });
    return host.context();
  }, ids[0]);
  assert.equal(mismatchContext.icDatasheet.status, 'controller-mismatch');
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  assert.equal(await readSource(page), editedText);
  await page.getByRole('button', { name: 'Schematic', exact: true }).click();
  await page.evaluate((id) => window.datasheetHosts[id].core.undo(), ids[0]);
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  assert.equal(await readSource(page), editedText);
  assert.equal((await snapshot(ids[0])).source, initial.source);
  assert.equal((await snapshot(ids[0])).undoDepth, initial.undoDepth);

  // Inactive workbenches defer presentation and reveal the current native file.
  const inactiveNativeName = await nativeFiles
    .locator('[data-source-file]')
    .filter({ hasText: /\.kicad_sch$/ })
    .first()
    .getAttribute('data-source-file');
  assert.ok(inactiveNativeName);
  await selectSourceFile(page, inactiveNativeName);
  const inactiveBaseline = await readSource(page);
  await projectButton(ids[1]).click();
  const inactiveLatest = await page.evaluate(
    async ({ id, name }) => {
      const host = window.datasheetHosts[id];
      const binding = (await host.query('project.datasheet')).bindings[0];
      host.core.execute('part.properties', {
        schematicId: binding.schematicId,
        partId: binding.partId,
        value: 'UNSUPPORTED_TEST_CONTROLLER',
      });
      return host.core.query('source.files').files.find((file) => file.name === name).source;
    },
    { id: ids[0], name: inactiveNativeName },
  );
  assert.notEqual(inactiveLatest, inactiveBaseline);
  assert.equal(
    await projectButton(ids[0]).getAttribute('aria-label'),
    'LM2735 SEPIC, Project 1, Unsaved changes',
  );
  await projectButton(ids[0]).click();
  assert.equal(await readSource(page), inactiveLatest);
  await page.evaluate((id) => window.datasheetHosts[id].core.undo(), ids[0]);
  assert.equal(await readSource(page), inactiveBaseline);
  assert.equal((await snapshot(ids[0])).source, initial.source);
  assert.equal((await snapshot(ids[0])).undoDepth, initial.undoDepth);
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/example-datasheets-source-ui.png' });
  assert.deepEqual(errors, []);
  console.log(
    'IC datasheet UI passed: actual JSON editing/Copy, local PDF viewer, native drafts, project isolation and reviewed Agent context.',
  );
} catch (error) {
  await mkdir('test-results/example-datasheets-ui', { recursive: true });
  await writeFile(
    'test-results/example-datasheets-ui/failure.json',
    JSON.stringify(
      {
        error: error instanceof Error ? error.stack : String(error),
        pageErrors: errors,
        text: page ? (await page.locator('body').innerText()).slice(0, 50_000) : '',
        dom: page ? (await page.content()).slice(0, 500_000) : '',
      },
      null,
      2,
    ),
  );
  if (page) await page.screenshot({ path: 'test-results/example-datasheets-ui/failure.png' });
  throw error;
} finally {
  await browser.close();
}
