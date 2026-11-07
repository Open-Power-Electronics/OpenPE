import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { fillSource, readSource, selectSourceFile } from './source-editor-test-helpers.mjs';

// A real Workbench/Core in an isolated renderer. All native and service actions
// stay in memory; this never opens Electron or writes a user's project.
const { createProject, importDocument, serializeProject } = await tsImport(
  '../lib/project.ts',
  import.meta.url,
);
const { emptyCircuit, createPart } = await tsImport('../lib/circuit.ts', import.meta.url);
const { createEmptyPCB } = await tsImport('../lib/pcb-layout.ts', import.meta.url);
const { defaultAgentPreferences } = await tsImport('../lib/workspace-state.ts', import.meta.url);
const { projectFromNativeFiles, projectNativeFiles } = await tsImport(
  '../lib/kicad-project.ts',
  import.meta.url,
);
const project = createProject();
project.name = 'Native circuit';
project.schematic.title = 'Main schematic';
project.schematic.parts.push(createPart(project.schematic, 'R', 50.8, 38.1));
project.additionalSchematics = [{ ...emptyCircuit(), title: 'Control schematic' }];
project.pcb = createEmptyPCB();
const native = projectNativeFiles(project, 'circuit.kicad_pro');
native.files.push(
  { name: 'sym-lib-table', source: '(sym_lib_table\n  (version 7)\n)\n' },
  { name: 'fp-lib-table', source: '(fp_lib_table\n  (version 7)\n)\n' },
  {
    name: 'models/controller.lib',
    source: '* Vendor ©\n.SUBCKT CONTROLLER IN OUT\nR1 IN OUT 1k\n.ENDS\n',
    encoding: 'latin1',
  },
);
const source = serializeProject(projectFromNativeFiles(native));
const initialFiles = projectNativeFiles(importDocument(source));
for (const file of native.files)
  assert.equal(
    initialFiles.files.find((item) => item.name === file.name)?.source,
    file.source,
    `Recovery retains exact native bytes for ${file.name}.`,
  );
const documentId = crypto.randomUUID();
let recovery = {
  version: 2,
  documents: [
    {
      id: documentId,
      source,
      sourceDraft: null,
      dirty: false,
      filename: native.entry,
      sessions: [{ id: 'session', messages: [], draft: '' }],
      activeSessionId: 'session',
    },
  ],
  activeDocumentId: documentId,
  provider: 'codex',
  effort: 'low',
  approvalMode: 'review',
  models: { ...defaultAgentPreferences.models },
};
const bundle = await build({
  stdin: {
    contents: `import React from 'react'; import {createRoot} from 'react-dom/client';
      import {EditorView} from '@codemirror/view';
      import {undoDepth, redoDepth} from '@codemirror/commands';
      import {ProjectCore} from './core/project-core';
      import Workspace from './components/DesktopWorkspace';
      window.nativeSourceReads = 0;
      window.nativeSourceBeforePaint = [];
      const getNativeFiles = ProjectCore.prototype.getNativeFiles;
      ProjectCore.prototype.getNativeFiles = function(...args) {
        window.nativeSourceReads++;
        return getNativeFiles.apply(this, args);
      };
      window.inspectSource = () => {
        const view = EditorView.findFromDOM(document.querySelector('.source-editor-code .cm-editor'));
        return {text:view.state.doc.toString(), selection:view.state.selection.toJSON(),
          undo:undoDepth(view.state), redo:redoDepth(view.state)};
      };
      createRoot(document.getElementById('root')).render(<Workspace/>);`,
    loader: 'tsx',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  outdir: 'test-results/native-source-ui-bundle',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [
    {
      name: 'inspect-native-source-core',
      setup(plugin) {
        plugin.onLoad(
          { filter: /[\\/]components[\\/]Workbench\.tsx$/ },
          async ({ path: file }) => ({
            contents: (await readFile(file, 'utf8'))
              .replace(
                'const { project, sourceDraft, sourceError } = coreSnapshot;',
                'const { project, sourceDraft, sourceError } = coreSnapshot; window.nativeSourceCore = core;',
              )
              .replace(
                '  const sourceReadOnly =',
                `window.nativeSourcePresentation = {entry:nativeSource.entry,
                files:nativeSource.files, name:activeSourceFile?.name, visible:sourceVisible};
              useLayoutEffect(()=>{
                if(sourceVisible && document.querySelector('.cm-editor'))
                  window.nativeSourceBeforePaint.push(window.inspectSource().text);
              },[sourceVisible,nativeSource,activeSourceFile]);
              const sourceReadOnly =`,
              )
              .replace(
                '  const capabilityPorts = useRef<WorkbenchCapabilityPorts>(null!);',
                `window.readNativeSourceContext = readWorkspaceContext;
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
try {
  const page = await browser.newPage({ viewport: { width: 1480, height: 920 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(error);
  });
  await page.addInitScript(() => {
    window.nativeSaveRequests = [];
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
      save: async (options) => {
        window.nativeSaveRequests.push(options);
        return { name: 'circuit.kicad_pro' };
      },
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
    if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(url.pathname))
      return route.fulfill({ body: await readFile('public' + url.pathname) });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const files = page.getByRole('navigation', { name: 'Project files', exact: true });
  const selectFile = async (name) => {
    await selectSourceFile(page, name);
    await page.waitForFunction(
      (name) => document.querySelector('.source-editor-title > span').textContent === name,
      name,
    );
  };
  const inspect = () => page.evaluate(() => window.inspectSource());
  const settle = () =>
    page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
  const coreSnapshot = () =>
    page.evaluate(() => {
      const { undoDepth, redoDepth, sourceDraft, sourceError } =
        window.nativeSourceCore.getSnapshot();
      return { undoDepth, redoDepth, sourceDraft, sourceError };
    });
  const headerDirty = page.locator('.breadcrumb > .dirty-dot');
  await page.getByTestId('schematic-canvas').waitFor().catch(async (error) => {
    console.error(await page.locator('body').innerText());
    throw error;
  });
  assert.equal(await headerDirty.count(), 0, 'Opening starts with a clean project title.');
  await button('Source').click();
  await files.waitFor();
  assert.deepEqual(
    (
      await files
        .locator('[data-source-file]')
        .evaluateAll((items) => items.map((item) => item.dataset.sourceFile))
    ).sort(),
    native.files.map((file) => file.name).sort(),
  );
  assert.ok(
    await page.locator('.source-editor-code .source-token-key').count(),
    'Project settings use JSON syntax colors.',
  );
  assert.equal(await readSource(page), initialFiles.files[0].source);
  const initialHistory = (await coreSnapshot()).undoDepth;

  // A mounted hidden Source view must not eagerly assemble native files on
  // schematic edits. Reveal synchronizes current bytes before its first paint.
  await selectFile('fp-lib-table');
  const sourceText = page.getByRole('textbox', { name: 'Project file source', exact: true });
  await sourceText.focus();
  await sourceText.press('ControlOrMeta+End');
  await sourceText.press('Space');
  await sourceText.press('ControlOrMeta+z');
  await sourceText.press('ControlOrMeta+Home');
  await sourceText.press('ArrowRight');
  await page.waitForFunction(() => window.nativeSourceCore.getSnapshot().sourceDraft === null);
  const supportHistory = await inspect();
  assert.ok(supportHistory.redo > 0, 'The unchanged support file retains real text history.');
  await selectFile('circuit.kicad_sch');
  await button('Schematic').click();
  await settle();
  const readsBeforeEditing = await page.evaluate(() => window.nativeSourceReads);
  const savedBaseline = await page.evaluate(() => window.nativeSourceCore.getSnapshot().source);
  const canvas = page.getByTestId('schematic-canvas');
  for (let index = 0; index < 3; index++) {
    await page.getByTestId('symbol-hit-R1').click();
    await canvas.press('ArrowRight');
    await canvas.press('ControlOrMeta+z');
  }
  await page.getByTestId('symbol-hit-R1').click();
  await canvas.press('ArrowRight');
  await settle();
  assert.equal(
    await page.evaluate(() => window.nativeSourceReads),
    readsBeforeEditing,
    'Hidden Source presentation performs no native materialization across schematic edits/undo.',
  );
  const latest = await page.evaluate(() => {
    const state = window.nativeSourceCore.getSnapshot();
    const files = window.nativeSourceCore.query('source.files');
    return {
      source: state.source,
      schematic: files.files.find((file) => file.name === 'circuit.kicad_sch').source,
    };
  });
  assert.notEqual(latest.source, savedBaseline);
  await headerDirty.waitFor();
  assert.equal(await headerDirty.getAttribute('aria-label'), 'Unsaved changes');
  const titleBounds = await page.locator('.breadcrumb strong').boundingBox();
  const dotBounds = await headerDirty.boundingBox();
  assert.equal(dotBounds.width, 5);
  assert.equal(dotBounds.height, 5);
  assert.ok(dotBounds.x >= titleBounds.x + titleBounds.width);
  assert.ok(
    dotBounds.y >= titleBounds.y &&
      dotBounds.y + dotBounds.height < titleBounds.y + titleBounds.height / 2,
    'The dot sits at the upper right of the project name.',
  );
  await mkdir('test-results', { recursive: true });
  await page.locator('.app-header').screenshot({ path: 'test-results/project-title-dirty.png' });
  const hiddenContext = await page.evaluate(() => window.readNativeSourceContext());
  assert.equal(hiddenContext.ui.sourceFile, 'circuit.kicad_sch');
  assert.equal(hiddenContext.ui.sourceReadOnly, false);
  assert.equal(hiddenContext.ui.dirty, true);
  await button('Source').click();
  assert.equal(await readSource(page), latest.schematic);
  assert.equal(
    await page.evaluate(() => window.nativeSourceBeforePaint.at(-1)),
    latest.schematic,
    'The revealed Source contains current native bytes before paint.',
  );
  await selectFile('fp-lib-table');
  assert.deepEqual(
    await inspect(),
    supportHistory,
    'Unchanged files retain local history and selection.',
  );
  await button('Schematic').click();
  await canvas.focus();
  await canvas.press('ControlOrMeta+z');
  await settle();
  assert.equal(
    await page.evaluate(() => window.nativeSourceCore.getSnapshot().source),
    savedBaseline,
  );
  assert.equal(
    await page.locator('.dirty-dot').count(),
    0,
    'Source presentation never changes the dirty baseline.',
  );
  assert.equal(await headerDirty.count(), 0, 'Undo to saved bytes clears the title dot.');

  // Context resolves current names independently of the deferred presentation.
  await button('Source').click();
  const secondary = initialFiles.files.find(
    (file) => file.name.endsWith('.kicad_sch') && file.name !== 'circuit.kicad_sch',
  );
  await selectFile(secondary.name);
  await button('Schematic').click();
  await page.evaluate(() => {
    const core = window.nativeSourceCore;
    core.execute('schematic.remove', {
      schematicId: core.getSnapshot().project.additionalSchematics[0].id,
    });
  });
  await settle();
  const removedContext = await page.evaluate(() => window.readNativeSourceContext());
  assert.equal(
    removedContext.ui.sourceFile,
    native.entry,
    'A removed selected file falls back to the live first native file.',
  );
  await button('Source').click();
  assert.equal(await files.getByRole('button', { name: secondary.name, exact: true }).count(), 0);
  assert.equal(await page.locator('.source-editor-title > span').textContent(), native.entry);
  await button('Schematic').click();
  await canvas.focus();
  await canvas.press('ControlOrMeta+z');
  await settle();
  const restoredContext = await page.evaluate(() => window.readNativeSourceContext());
  assert.equal(
    restoredContext.ui.sourceFile,
    secondary.name,
    'Restoring a file retains its resident Source selection.',
  );
  assert.equal(restoredContext.ui.dirty, false);

  // Agent Source changes refresh the protected draft even while its editor is hidden.
  await button('Source').click();
  await selectFile('circuit.kicad_sch');
  await button('Schematic').click();
  await page.evaluate(() =>
    window.nativeSourceCore.execute('source.updateFile', {
      name: 'circuit.kicad_sch',
      source: '(',
    }),
  );
  await settle();
  assert.equal(
    await page.evaluate(
      () =>
        window.nativeSourcePresentation.files.find((file) => file.name === 'circuit.kicad_sch')
          .source,
    ),
    '(',
    'A nonempty hidden draft stays current in the Source presentation.',
  );
  const pendingContext = await page.evaluate(() => window.readNativeSourceContext());
  assert.equal(pendingContext.source.pending, true);
  await headerDirty.waitFor();
  assert.equal(pendingContext.ui.sourceFile, 'circuit.kicad_sch');
  const blocked = await page.evaluate(() => {
    try {
      const core = window.nativeSourceCore;
      core.execute('schematic.move', {
        schematicId: core.getSnapshot().project.schematic.id,
        ids: [core.getSnapshot().project.schematic.parts[0].id],
        delta: { x: 1.27, y: 0 },
      });
      return 'unexpected edit';
    } catch (error) {
      return error.message;
    }
  });
  assert.match(blocked, /Source/i);
  await page.evaluate(() => window.nativeSourceCore.discardSource());
  await settle();
  const discardedContext = await page.evaluate(() => window.readNativeSourceContext());
  assert.equal(discardedContext.source.pending, false);
  assert.equal(discardedContext.ui.dirty, false);
  assert.equal(
    await headerDirty.count(),
    0,
    'Discarding the pending Source draft clears the title dot.',
  );
  await page.evaluate(() =>
    window.nativeSourceCore.execute('source.updateFile', {
      name: 'circuit.kicad_sch',
      source: '(',
    }),
  );
  await settle();
  await button('Source').click();
  assert.equal(await readSource(page), '(');
  await button('Apply').click();
  await page.locator('.source-editor-error').waitFor();
  assert.notEqual((await coreSnapshot()).sourceDraft, null);
  await page.evaluate(() => window.nativeSourceCore.discardSource());
  await settle();
  assert.equal((await coreSnapshot()).sourceDraft, null);
  assert.equal((await coreSnapshot()).undoDepth, initialHistory);
  assert.equal(await page.locator('.dirty-dot').count(), 0);
  await selectFile(native.entry);

  await fillSource(page, '{');
  const invalidJSONState = await inspect();
  await button('Apply').click();
  await page.locator('.source-editor-error').waitFor();
  assert.equal(
    (await coreSnapshot()).undoDepth,
    initialHistory,
    'Invalid native files never commit.',
  );
  const main = initialFiles.files.find((file) => file.name === 'circuit.kicad_sch');
  await selectFile(main.name);
  assert.equal(await readSource(page), main.source);
  assert.ok(
    await page.locator('.source-editor-code .source-bracket-0').count(),
    'Schematics use S-expression bracket colors.',
  );
  assert.ok(
    await page.locator('.source-editor-code .source-token-key').count(),
    'S-expression heads have syntax colors.',
  );
  const editedMain = main.source.replace('"Main schematic"', '"Edited schematic"');
  assert.notEqual(editedMain, main.source);
  await fillSource(page, editedMain);
  const mainTextState = await inspect();

  await selectFile(native.entry);
  assert.deepEqual(
    await inspect(),
    invalidJSONState,
    'File switches retain an invalid draft, text selection and local history.',
  );
  const editor = page.getByRole('textbox', { name: 'Project file source', exact: true });
  await editor.focus();
  await editor.press('ControlOrMeta+z');
  assert.equal(
    await readSource(page),
    initialFiles.files[0].source,
    'Local undo affects only the selected file.',
  );
  await editor.focus();
  await editor.press('ControlOrMeta+Shift+z');
  assert.equal(await readSource(page), '{');
  const editedSettings =
    JSON.stringify(
      { ...JSON.parse(initialFiles.files[0].source), board: { copper_layer_count: 2 } },
      null,
      2,
    ) + '\n';
  await fillSource(page, editedSettings);
  await selectFile(main.name);
  assert.deepEqual(
    await inspect(),
    mainTextState,
    'The second file retains its separate text history.',
  );
  await selectFile('circuit.kicad_pcb');
  assert.equal(
    await readSource(page),
    initialFiles.files.find((file) => file.name === 'circuit.kicad_pcb').source,
  );
  await selectFile('fp-lib-table');
  assert.equal(await readSource(page), '(fp_lib_table\n  (version 7)\n)\n');
  await selectFile('models/controller.lib');
  assert.equal(
    await readSource(page),
    native.files.at(-1).source,
    'Source also exposes project support files verbatim.',
  );
  assert.match(await page.locator('.source-editor .status-format').textContent(), /ISO-8859-1/);
  const originalModel = native.files.at(-1).source;
  await fillSource(page, originalModel + 'Ω');
  await selectFile(native.entry);
  await selectFile('models/controller.lib');
  assert.equal(
    await readSource(page),
    originalModel + 'Ω',
    'Invalid encoding drafts survive file switching.',
  );
  await button('Apply').click();
  await page.locator('.source-editor-error').waitFor();
  assert.equal(
    await readSource(page),
    originalModel + 'Ω',
    'Failed Apply retains the invalid model source.',
  );
  await editor.focus();
  await editor.press('ControlOrMeta+z');
  assert.equal(
    await readSource(page),
    originalModel,
    'Local undo restores valid original model bytes.',
  );
  await selectFile(native.entry);
  assert.match(await page.locator('.source-editor .status-format').textContent(), /UTF-8/);
  assert.equal(
    await readSource(page),
    editedSettings,
    'Copy returns only the selected native file.',
  );
  const beforeFileSwitch = await inspect();
  const sourcePanel = page.getByRole('region', { name: 'Project source', exact: true });
  for (const name of ['Visualization', 'Selection']) {
    assert.equal(await sourcePanel.getByRole('group', { name, exact: true }).count(), 0);
    assert.equal(await sourcePanel.getByRole('button', { name, exact: true }).count(), 0);
  }
  await selectFile(main.name);
  assert.equal(await readSource(page), editedMain);
  await selectFile(native.entry);
  assert.deepEqual(
    await inspect(),
    beforeFileSwitch,
    'Source file switching preserves text, selection and local history without display drawers.',
  );

  await button('Apply').click();
  await page.waitForFunction(() => window.nativeSourceCore.getSnapshot().sourceDraft === null);
  assert.equal(
    (await coreSnapshot()).undoDepth,
    initialHistory + 1,
    'All changed files apply through one Core transaction.',
  );
  await button('Schematic').click();
  await button('Undo').click();
  await button('Source').click();
  await selectFile(native.entry);
  assert.equal(
    await readSource(page),
    initialFiles.files[0].source,
    'Whole-project undo restores project settings.',
  );
  await selectFile(main.name);
  assert.equal(
    await readSource(page),
    main.source,
    'The same undo restores the changed schematic file.',
  );
  await editor.focus();
  await editor.press('ControlOrMeta+z');
  assert.equal(
    await readSource(page),
    main.source,
    'External project replacement resets stale per-file text history.',
  );
  await editor.focus();
  await editor.dispatchEvent('keydown', {
    key: 's',
    code: 'KeyS',
    ctrlKey: true,
    isComposing: true,
  });
  assert.equal(
    await page.evaluate(() => window.nativeSaveRequests.length),
    0,
    'IME input never triggers Save.',
  );
  await editor.press('ControlOrMeta+s');
  await page.waitForFunction(() => window.nativeSaveRequests.length === 1);
  await headerDirty.waitFor({ state: 'detached' });
  await editor.focus();
  await editor.press('Escape');
  await editor.press('Tab');
  assert.equal(
    await editor.evaluate((element) => element === document.activeElement),
    false,
    'Escape then Tab leaves the code editor.',
  );
  await mkdir('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/native-source-ui.png' });
  assert.deepEqual(errors, []);
  console.log(
    'Native Source UI passed: all project files, exact copy, JSON/S-expression syntax, per-file drafts/history and atomic Apply/Undo.',
  );
} finally {
  await browser.close();
}
