import { formatTestProjectSource } from './format-test-project.mjs';
import {
  parseProject,
  serializeProject,
  projectNativeFiles,
  projectFromNativeFiles,
} from '../server/project-format.mjs';
// Native KiCad net numbers/names are reparsed into derived net IDs. Compare
// physical objects independently while checking renamed connectivity explicitly.
const physicalItems = (items) =>
  JSON.parse(JSON.stringify(items, (key, value) => (key === 'netId' ? undefined : value)));
const documentBoard = (project) => {
  const board = structuredClone(project.pcb);
  board.footprints = physicalItems(board.footprints);
  board.tracks = physicalItems(board.tracks);
  board.vias = physicalItems(board.vias);
  board.zones = physicalItems(board.zones);
  return board;
};
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { tsImport } from 'tsx/esm/api';
import { child, children, parseSExpr, val } from '../lib/sexpr.ts';
import {
  fillSource,
  readSource,
  readNativeProject,
  fillNativeProject,
  selectSourceFile,
} from './source-editor-test-helpers.mjs';

// Isolated full workspace: no Electron, provider, solver or native file access.
const { defaultAgentPreferences } = await tsImport('../lib/workspace-state.ts', import.meta.url);
const fixture = parseProject(formatTestProjectSource());
// This test exercises physical package synchronization, so assign the source
// embedded packages explicitly rather than treating virtual parts as physical.
for (const footprint of fixture.pcb.footprints) {
  const part = fixture.schematic.parts.find((part) => part.id === footprint.symbolId);
  (part.fields ??= {}).Footprint = footprint.libraryId;
}
const source = serializeProject(
  projectFromNativeFiles(projectNativeFiles(fixture, 'layout.kicad_pro')),
);

const footprintId = 'Connector_PinHeader_2.54mm:PinHeader_1x02_P2.54mm_Vertical';
const footprint = parseSExpr(
  await readFile(
    'resources/kicad/10.0.0/footprints/Connector_PinHeader_2.54mm.pretty/PinHeader_1x02_P2.54mm_Vertical.kicad_mod',
    'utf8',
  ),
);
const footprintEntry = {
  id: footprintId,
  name: 'PinHeader_1x02_P2.54mm_Vertical',
  library: 'Connector_PinHeader_2.54mm',
  description: 'Official two-pin header',
  keywords: '',
};
let saved = source;
let footprintGate = null;
let state = {
  version: 2,
  documents: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      source,
      sourceDraft: null,
      dirty: false,
      filename: 'layout.kicad_pro',
      sessions: [{ id: 'layout-session', messages: [], draft: '' }],
      activeSessionId: 'layout-session',
    },
  ],
  activeDocumentId: '00000000-0000-4000-8000-000000000001',
  provider: 'codex',
  effort: 'low',
  approvalMode: 'review',
  models: { ...defaultAgentPreferences.models },
};
const bundle = await build({
  stdin: {
    contents:
      "import React from 'react'; import {createRoot} from 'react-dom/client'; import Workspace from './components/DesktopWorkspace'; createRoot(document.getElementById('root')).render(<Workspace/>);",
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  plugins: [
    {
      name: 'isolated-home-data',
      setup(plugin) {
        // Home catalogs are outside this test; keep the workspace check independent
        // of generated example downloads and never alter the production catalog.
        plugin.onResolve(
          { filter: /(?:reference-examples\.json|pebench\/manifest\.json)$/ },
          (args) => ({ path: args.path, namespace: 'home-fixture' }),
        );
        plugin.onLoad({ filter: /.*/, namespace: 'home-fixture' }, (args) => ({
          contents: JSON.stringify(args.path.includes('manifest') ? { examples: [] } : {}),
          loader: 'json',
        }));
      },
    },
  ],
  bundle: true,
  write: false,
  outdir: 'test-results/layout-sync-ui-bundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
});
const browser = await chromium.launch({
  channel: process.platform === 'win32' ? 'msedge' : undefined,
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1460, height: 900 } });
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(error);
  });
  await page.exposeFunction('writeLayoutSave', (value) => {
    saved = value;
  });
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
      listExamples: async () => ({ entries: [], warnings: [] }),
      listRecent: async () => ({ initialized: true, entries: [], warnings: [] }),
      onRecentChanged: () => () => {},
      projectDirectory: async () => ({ entries: [], truncated: false }),
      setDirty: async () => {},
      onCloseRequested: () => () => {},
      save: async ({ source }) => {
        await window.writeLayoutSave(source);
        return { name: 'layout.kicad_pro' };
      },
      historyList: async () => ({ version: '', commits: [], more: false, needsSave: true }),
    };
  });
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/state') {
      if (route.request().method() === 'POST') state = route.request().postDataJSON();
      return route.fulfill({ json: state });
    }
    if (url.pathname === '/api/agent-settings')
      return route.fulfill({ json: { followUpMode: 'queue' } });
    if (url.pathname === '/api/appearance') return route.fulfill({ json: null });
    if (url.pathname === '/api/agents') return route.fulfill({ json: [] });
    if (url.pathname === '/api/models')
      return route.fulfill({ json: { models: [], defaultModel: '' } });
    if (url.pathname === '/api/libraries/footprints') {
      if (url.searchParams.get('id') === 'Test:Unavailable')
        return route.fulfill({
          status: 404,
          json: { error: 'Assigned footprint is unavailable.' },
        });
      if (url.searchParams.has('id') && footprintGate) await footprintGate;
      return route.fulfill({
        json: url.searchParams.has('id')
          ? { ...footprintEntry, footprint, pads: ['1', '2'], models: [] }
          : { entries: [footprintEntry], libraries: ['Connector_PinHeader_2.54mm'], total: 1 },
      });
    }
    if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(url.pathname))
      return route.fulfill({
        contentType: url.pathname.endsWith('.svg') ? 'image/svg+xml' : 'image/png',
        body: await readFile('public' + url.pathname),
      });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  for (const path of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(path, 'utf8') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const button = (name) => page.getByRole('button', { name, exact: true });
  await page.getByTestId('schematic-canvas').waitFor();
  await button('Layout').click();
  const canvas = page.getByTestId('layout-canvas');
  await canvas.waitFor();
  assert.equal(await button('Update PCB from schematic').count(), 0);
  await page.waitForFunction(
    () => !document.body.innerText.includes('Loading assigned footprints'),
  );
  await button('Source').click();
  const baseline = await readNativeProject(page);
  await button('Layout').click();
  assert.equal(await page.locator('.project-navigation .dirty-dot').count(), 0);
  const owner = baseline.pcb.footprints[0];
  const reference = owner.graphics.find((graphic) => graphic.text?.property === 'Reference');
  const part = baseline.schematic.parts.find((part) => part.id === owner.symbolId);
  await canvas.locator(`[data-footprint-text="${reference.id}"] text`).click();
  const content = page.getByRole('textbox', { name: 'Text content', exact: true });
  assert.equal(await content.inputValue(), part.ref);
  await content.fill('R97');
  await content.dispatchEvent('compositionstart');
  await content.press('Escape');
  assert.equal(await content.inputValue(), 'R97');
  await content.dispatchEvent('compositionend');
  await content.press('Enter');
  await button('Source').click();
  const renamedPart = await readNativeProject(page);
  assert.equal(renamedPart.schematic.parts.find(({ id }) => id === part.id).ref, 'R97');
  const renamedReference = renamedPart.pcb.footprints
    .find(({ id }) => id === owner.id)
    .graphics.find(({ id }) => id === reference.id);
  assert.deepEqual(renamedReference.start, reference.start);
  const boardFile = renamedPart.nativeFiles.files.find(({ name }) => name === 'layout.kicad_pcb');
  const nativeBoard = parseSExpr(boardFile.source);
  const nativeFootprint = children(nativeBoard, 'footprint').find(
    (item) => val(child(item, 'uuid')) === owner.id,
  );
  const nativeReference = children(nativeFootprint, 'property').find(
    (item) => val(item) === 'Reference',
  );
  assert.equal(val(nativeReference, 2), 'R97');
  await button('Layout').click();
  await button('Undo').click();
  await button('Source').click();
  assert.deepEqual(await readNativeProject(page), baseline);
  await button('Layout').click();
  console.log('Footprint Reference text edits both native files and undoes in one step.');

  await button('Annotation mode').click();
  await canvas.locator('[data-pad-id]').first().click();
  await page
    .getByRole('textbox', { name: 'Annotation comment' })
    .fill('Preserve this placement during schematic changes.');
  await button('Add').click();
  const screenshot = await page.locator('.annotation-attachments img').first().getAttribute('src');
  await button('Source').click();
  const edited = structuredClone(baseline);
  edited.schematic.labels[0].text = 'RENAMED_INPUT';
  await fillNativeProject(page, edited);
  await button('Layout').click();
  await button('Source').click();
  const renamed = await readNativeProject(page);
  assert.ok(documentBoard(renamed).nets.some((n) => n.name === 'RENAMED_INPUT'));
  assert.deepEqual(documentBoard(renamed).footprints, documentBoard(baseline).footprints);
  assert.deepEqual(documentBoard(renamed).tracks, documentBoard(baseline).tracks);
  assert.deepEqual(documentBoard(renamed).vias, documentBoard(baseline).vias);
  assert.equal(
    await page.locator('.annotation-attachments img').first().getAttribute('src'),
    screenshot,
  );
  await button('Layout').click();
  await button('Interaction mode').click();
  await button('Undo').click();
  await button('Source').click();
  assert.deepEqual(
    await readNativeProject(page),
    baseline,
    'One undo restores both schematic and PCB.',
  );
  await button('Layout').click();
  await button('Redo').click();
  await canvas.press('Control+s');
  await page.getByText('Save project', { exact: true }).waitFor();
  const savedProject = projectFromNativeFiles(
    projectNativeFiles(parseProject(saved), 'layout.kicad_pro'),
  );
  const byName = (a, b) => a.name.localeCompare(b.name);
  assert.deepEqual(
    savedProject.nativeFiles.files.toSorted(byName),
    renamed.nativeFiles.files.toSorted(byName),
  );
  await button('Source').click();
  const assigned = structuredClone(renamed);
  const added = structuredClone(assigned.schematic.parts[0]);
  added.id = '00000000-0000-4000-8000-000000000099';
  added.ref = 'R99';
  added.x = 101.6;
  added.y = 101.6;
  added.fields = { Footprint: footprintId };
  delete added.raw;
  assigned.schematic.parts.push(added);
  let releaseFootprint;
  footprintGate = new Promise((resolve) => {
    releaseFootprint = resolve;
  });
  await fillNativeProject(page, assigned);
  await button('Layout').click();
  await page.getByText('Loading assigned footprints…', { exact: true }).waitFor();
  await button('Source').click();
  await selectSourceFile(page, 'layout.kicad_sch');
  await fillSource(page, '(kicad_sch invalid pending draft');
  releaseFootprint();
  footprintGate = null;
  await page.waitForTimeout(100);
  assert.equal(
    await readSource(page),
    '(kicad_sch invalid pending draft',
    'A late footprint response never overwrites Source.',
  );
  await fillNativeProject(page, renamed);
  await button('Layout').click();
  await button('Source').click();
  assert.deepEqual(
    await readNativeProject(page),
    renamed,
    'A stale request cannot restore a discarded component.',
  );
  await fillNativeProject(page, assigned);
  await button('Layout').click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="layout-canvas"] [data-pad-id]').length > 4,
  );
  await button('Source').click();
  const populated = await readNativeProject(page);
  assert.equal(
    documentBoard(populated).footprints.length,
    documentBoard(renamed).footprints.length + 1,
  );
  assert.deepEqual(
    documentBoard(populated).footprints.slice(0, documentBoard(renamed).footprints.length),
    documentBoard(renamed).footprints,
  );
  assert.deepEqual(documentBoard(populated).tracks, documentBoard(renamed).tracks);
  assert.equal(documentBoard(populated).footprints.at(-1).symbolId, added.id);
  assert.equal(documentBoard(populated).footprints.at(-1).libraryId, footprintId);
  assert.equal(
    await page.locator('.annotation-attachments img').first().getAttribute('src'),
    screenshot,
  );
  await button('Layout').click();
  await button('Undo').click();
  await button('Source').click();
  assert.deepEqual(
    await readNativeProject(page),
    renamed,
    'Footprint loading coalesces into the original edit.',
  );
  await selectSourceFile(page, 'layout.kicad_sch');
  await fillSource(page, '(kicad_sch invalid draft');
  await button('Layout').click();
  assert.equal(await canvas.isVisible(), false);
  assert.equal(await readSource(page), '(kicad_sch invalid draft');
  const unavailable = structuredClone(renamed);
  (unavailable.schematic.parts[0].fields ??= {}).Footprint = 'Test:Unavailable';
  await fillNativeProject(page, unavailable);
  await button('Layout').click();
  await page.getByRole('alert').filter({ hasText: 'Assigned footprint is unavailable.' }).waitFor();
  const beforeFailedSave = saved;
  await canvas.press('Control+s');
  await page.getByText('Assigned footprint is unavailable.', { exact: true }).waitFor();
  assert.equal(saved, beforeFailedSave, 'An unresolved package cannot be saved as synchronized.');
  await button('Source').click();
  assert.deepEqual(
    documentBoard(await readNativeProject(page)),
    documentBoard(renamed),
    'Failed loads preserve the complete previous board.',
  );
  await fillNativeProject(page, renamed);
  await button('Layout').click();
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/layout-auto-sync.png' });
  assert.deepEqual(errors, []);
  console.log(
    'Automatic PCB connectivity, assigned footprint loading, single-step undo, save, Source protection and immutable annotations passed.',
  );
} finally {
  await browser.close();
}
