import { runCanvasAction } from './canvas-context-menu-test-helpers.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import { bundledWorkbenchCatalog } from '../server/workbench-plugins.mjs';
import { fillSource, readSource, selectSourceFile } from './source-editor-test-helpers.mjs';

// Actual workspace components in an isolated headless browser, with in-memory
// service/native fixtures. No Electron, profiles, providers, solvers or file writes.
const { parseProject, serializeProject } = await tsImport('../lib/project.ts', import.meta.url);
const { defaultAgentPreferences } = await tsImport('../lib/workspace-state.ts', import.meta.url);
const { parseSExpr, child, children, val, writeSExpr } = await tsImport(
  '../lib/sexpr.ts',
  import.meta.url,
);
const source = await readFile('tests/fixtures/rc-filter.openpe.json', 'utf8');
const projects = ['First project', 'Second project'].map((name) => {
  const document = JSON.parse(source);
  document.project.id = crypto.randomUUID();
  document.project.name = name;
  document.schematic.id = crypto.randomUUID();
  return parseProject(JSON.stringify(document));
});
const ids = projects.map(() => crypto.randomUUID());
let recovery = {
  version: 2,
  documents: projects.map((project, index) => ({
    id: ids[index],
    source: serializeProject(project),
    sourceDraft: null,
    dirty: false,
    filename: `project-${index}.kicad_pro`,
    sessions: [{ id: `session-${index}`, messages: [], draft: '' }],
    activeSessionId: `session-${index}`,
  })),
  activeDocumentId: ids[0],
  ...structuredClone(defaultAgentPreferences),
};
const bundle = await build({
  stdin: {
    contents: `import React,{useState} from 'react'; import {createRoot} from 'react-dom/client';
      import Workspace from './components/DesktopWorkspace';
      import SourceEditor from './components/SourceEditor';
      import{WorkspacePresentationContext,createWorkspacePresentation}from'./components/WorkspacePresentation';
      window.renderCounts = {workbench:{}, schematic:{}, layout:{}, chat:{},source:{},toolbarModes:{},toolbarPlace:{},appHeader:{},navigationActions:{},navigationSettings:{},properties:{},projectNavigation:{},statusBars:{},toolbarChrome:0};
      window.propertiesActions = {};
      window.workbenchRuntime={};window.detectionCompletions={};
      window.layoutActions = {};window.syncStatuses={};
      const root=createRoot(document.getElementById('root'));root.render(<Workspace/>);
      window.showReferenceStatusFixture=()=>{
        const presentation=createWorkspacePresentation();window.referencePresentation=presentation;window.referenceChanges=0;
        function ReferenceFixture(){const[name,setName]=useState('reference.json'),[status,setStatus]=useState(undefined);
          window.setReferenceStatus=setStatus;
          return <WorkspacePresentationContext.Provider value={presentation}><SourceEditor active visible
            value={name==='reference.json'?'{}':'(kicad_sch)'} files={[{name:'project.kicad_sch',source:'(kicad_sch)'}]}
            referenceFiles={[{name:'reference.json',label:'Controller reference',source:'{}',readOnly:true}]}
            activeFile={name} onSelectFile={setName} pending error="" status={status}
            onChange={()=>window.referenceChanges++} onApply={()=>{}} onCopy={()=>{}}/></WorkspacePresentationContext.Provider>;
        }root.render(<ReferenceFixture/>);
      };`,
    resolveDir: process.cwd(),
    loader: 'tsx',
  },
  bundle: true,
  write: false,
  outdir: 'test-results/render-isolation-ui-bundle',
  platform: 'browser',
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.OPENPE_RENDER_MODE || 'production'),
  },
  plugins: [
    {
      name: 'count-real-editor-renders',
      setup(plugin) {
        plugin.onLoad(
          {
            filter:
              /[\\/]components[\\/](Workbench|Canvas|LayoutEditor|Chat|PartProperties|DesktopWorkspace|ProjectNavigation|EditorStatusBar|SourceEditor)\.tsx$/,
          },
          async ({ path: file }) => {
            const component = path.basename(file, '.tsx');
            if (component === 'DesktopWorkspace') {
              const original = await readFile(file, 'utf8');
              const marker =
                '  const [presentation, setPresentation] = useState(createWorkspacePresentation);';
              assert.ok(original.includes(marker), 'Find the actual workspace presentation host.');
              return {
                contents: original.replace(
                  marker,
                  marker +
                    '\nwindow.workspacePresentation={getProjects,setProjects,setDraftStatus};',
                ),
                loader: 'tsx',
                resolveDir: path.dirname(file),
              };
            }
            const category = {
              Workbench: 'workbench',
              Canvas: 'schematic',
              LayoutEditor: 'layout',
              Chat: 'chat',
              PartProperties: 'properties',
              ProjectNavigation: 'projectNavigation',
              EditorStatusBar: 'statusBars',
              SourceEditor: 'source',
            }[component];
            const identity = {
              Workbench: 'documentId',
              Canvas: 'doc.id',
              LayoutEditor: 'schematic.id',
              Chat: 'sessionId',
              PartProperties: 'part.id',
              ProjectNavigation: "activeId ?? 'home'",
              EditorStatusBar: 'mode',
              SourceEditor: 'activeFile ?? "default"',
            }[component];
            const marker = {
              Workbench: '  const prepareProject = useRef',
              Canvas: '  const svg = useRef<SVGSVGElement>(null);',
              LayoutEditor: '  const empty = useMemo',
              Chat: '  const [busy, setBusy] = useState(false);',
              PartProperties: '  const fields = partFields(part);',
              ProjectNavigation:
                '  const projects = useWorkspaceProjects(fallbackProjects, active);',
              EditorStatusBar: '  const draftStatus = useWorkspaceDraftStatus',
              SourceEditor: '  const fileName = activeFile',
            }[component];
            let original = await readFile(file, 'utf8');
            if (component === 'Workbench') {
              const detectionState = '  const [detecting, setDetecting] = useState(false);';
              assert.ok(original.includes(detectionState));
              original = original.replace(
                detectionState,
                detectionState +
                  '\nuseLayoutEffect(()=>{window.workbenchRuntime[documentId]={core,active,detecting,datasheetReady:Boolean(datasheetReader),detections:window.detectionCompletions[documentId]||0}});',
              );
              const detectionEnd = '    } finally {\n      setDetecting(false);\n    }';
              assert.ok(original.includes(detectionEnd));
              original = original.replace(
                detectionEnd,
                '    } finally {\n      setDetecting(false);\n      window.detectionCompletions[documentId]=(window.detectionCompletions[documentId]||0)+1;\n    }',
              );
              const syncStatus =
                "      const next = typeof update === 'function' ? update(current) : update;";
              assert.ok(original.includes(syncStatus));
              original = original.replace(
                syncStatus,
                syncStatus +
                  '\n(window.syncStatuses[documentId]??=[]).push({pending:next.pending,error:next.error});',
              );
              const toolbarRender = '    return children();';
              assert.ok(original.includes(toolbarRender));
              original = original.replace(
                toolbarRender,
                '    window.renderCounts.toolbarChrome++;\n' + toolbarRender,
              );
              for (const [name, group] of [
                ['schematicModeActions', 'toolbarModes'],
                ['schematicPlaceActions', 'toolbarPlace'],
                ['appHeader', 'appHeader'],
                ['workspaceNavigationActions', 'navigationActions'],
                ['workspaceNavigationSettings', 'navigationSettings'],
              ]) {
                const expression = `const ${name} = useMemo(\n    () => (`;
                assert.ok(original.includes(expression), `Instrumentation finds ${name}.`);
                original = original.replace(
                  expression,
                  `${expression}\nwindow.renderCounts.${group}[documentId]=(window.renderCounts.${group}[documentId]||0)+1,`,
                );
              }
            }
            assert.ok(
              original.includes(marker),
              `${component} render instrumentation is attached.`,
            );
            return {
              contents: original.replace(
                marker,
                `  window.renderCounts.${category}[${identity}] =
                  (window.renderCounts.${category}[${identity}] || 0) + 1;\n${
                    component === 'PartProperties'
                      ? 'window.propertiesActions[part.id] = { onSave, part, fields: partFields(part) };\n'
                      : component === 'LayoutEditor'
                        ? 'window.layoutActions[schematic.id] = {board,onCommit};\n'
                        : ''
                  }${marker}`,
              ),
              loader: 'tsx',
              resolveDir: path.dirname(file),
            };
          },
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
    console.error(`Renderer error: ${error.message}`);
  });
  await page.addInitScript((nativeTitlebar) => {
    window.openpe = {
      titleBarOverlay: nativeTitlebar,
      connection: async () => ({ base: 'http://localhost', token: 'test' }),
      projectDirectory: async () => ({ entries: [], truncated: false }),
      projectFilePreview: async () => {
        throw new Error('This fixture has no host-observed files.');
      },
      writeWorkspaceRecovery: async (content) => {
        await fetch('http://localhost/api/state', {
          method: content === null ? 'DELETE' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: content ?? undefined,
        });
      },
      newFile: async () => crypto.randomUUID(),
      releaseFile: async () => {},
      setDirty: async () => {},
      onCloseRequested: () => () => {},
    };
  }, process.env.OPENPE_NATIVE_TITLEBAR === '1');
  await page.route('http://localhost/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/state') {
      if (route.request().method() === 'POST') recovery = route.request().postDataJSON();
      return route.fulfill({ json: recovery });
    }
    if (url.pathname === '/api/appearance') return route.fulfill({ json: null });
    if (url.pathname === '/api/agents') return route.fulfill({ json: [] });
    if (url.pathname === '/api/workbench-plugins')
      return route.fulfill({ json: bundledWorkbenchCatalog() });
    if (/^\/(brand|agents|cursors)\/[\w.-]+\.(svg|png)$/.test(url.pathname))
      return route.fulfill({ body: await readFile('public' + url.pathname) });
    return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
  });
  await page.goto('http://localhost');
  const initialSaved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/state' && response.request().method() === 'POST',
  );
  // A later awaited assertion reports this failure without an early unhandled rejection.
  initialSaved.catch(() => {});
  for (const file of ['app/globals.css', 'app/workspace.css', 'app/layout-editor.css'])
    await page.addStyleTag({ content: await readFile(file, 'utf8') });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const button = (name) => page.getByRole('button', { name, exact: true });
  const counts = () => page.evaluate(() => window.renderCounts);
  const settled = async () => {
    await initialSaved;
    await page
      .locator('.draft-status:visible')
      .filter({ hasText: 'Saving draft' })
      .waitFor({ state: 'hidden' });
    assert.equal(await page.getByText('Draft save failed', { exact: true }).count(), 0);
    await page.waitForTimeout(100);
  };
  const selectProject = (index) =>
    page.locator(`.project-navigation [data-project-id="${ids[index]}"] button:visible`).click();

  await page
    .getByTestId('schematic-canvas')
    .waitFor()
    .catch(async (error) => {
      console.error((await page.locator('body').innerText()).slice(0, 1500));
      throw error;
    });
  await page
    .getByRole('group', { name: 'Schematic tools', exact: true })
    .getByRole('combobox', { name: 'Edit schematic', exact: true })
    .click();
  await page.getByRole('listbox', { name: 'Edit schematic', exact: true }).waitFor();
  // Change view without an outside pointer event: hiding itself must deactivate
  // an open toolbar menu and remove its keyboard handling.
  await button('Layout').evaluate((element) => element.click());
  await page.getByTestId('layout-canvas').waitFor();
  await page.evaluate(() => {
    window.retainedLayout = document.querySelector('[data-testid="layout-canvas"]');
  });
  await button('Schematic').click();
  await settled();
  const canvas = page.getByTestId('schematic-canvas');
  const bounds = await canvas.boundingBox();
  const beforeHover = await counts();
  const beforeCoordinates = await page.locator('.status-coordinate:visible').textContent();
  for (let index = 0; index < 20; index++)
    await page.mouse.move(
      bounds.x + bounds.width * 0.2 + index * 3,
      bounds.y + bounds.height * 0.2,
    );
  await page.waitForTimeout(100);
  assert.deepEqual(
    await counts(),
    beforeHover,
    'Idle hover does not render Workbench or either editor.',
  );
  assert.notEqual(
    await page.locator('.status-coordinate:visible').textContent(),
    beforeCoordinates,
    'Coordinates continue following the pointer without rendering the editor tree.',
  );

  // Exercise actual DesktopWorkspace state publications independently of a Core
  // edit. Only active navigation/status leaves may render; runtime observations
  // keep their existing, current getter while inactive workbenches stay detached.
  await page
    .locator(`.project-navigation [data-project-id="${ids[0]}"]`)
    .click({ button: 'right' });
  await page.getByRole('menu', { name: 'Project file actions', exact: true }).waitFor();
  const beforePresentation = await counts();
  const navigationBefore = await page.evaluate(() => window.workspacePresentation.getProjects());
  await page.evaluate((id) => {
    const host = window.workspacePresentation;
    host.setProjects((current) =>
      current.map((project) =>
        project.id === id
          ? { ...project, title: 'Current navigation title', unsaved: true }
          : project,
      ),
    );
    host.setDraftStatus('Saving draft');
  }, ids[1]);
  await page
    .getByRole('button', {
      name: 'Current navigation title, Project 2, Unsaved changes',
      exact: true,
    })
    .waitFor();
  await page
    .locator('.draft-status:visible')
    .filter({ hasText: /^Saving draft$/ })
    .waitFor();
  const afterPresentation = await counts();
  assert.deepEqual(
    afterPresentation.workbench,
    beforePresentation.workbench,
    'Dirty-list and recovery-status publications do not render any Workbench.',
  );
  assert.deepEqual(
    afterPresentation.schematic,
    beforePresentation.schematic,
    'Presentation publications do not render schematic editors.',
  );
  assert.deepEqual(
    afterPresentation.layout,
    beforePresentation.layout,
    'Presentation publications do not render retained Layout editors.',
  );
  assert.equal(
    afterPresentation.projectNavigation[ids[1]],
    beforePresentation.projectNavigation[ids[1]],
    'Inactive navigation does not subscribe to list updates.',
  );
  assert.ok(
    afterPresentation.projectNavigation[ids[0]] > beforePresentation.projectNavigation[ids[0]],
  );
  assert.equal(
    (await page.evaluate(() => window.workspacePresentation.getProjects()))[1].title,
    'Current navigation title',
    'Runtime project observations read the current list.',
  );
  assert.equal(
    await page.getByRole('menu', { name: 'Project file actions', exact: true }).count(),
    1,
    'A current project list keeps its origin-bound menu.',
  );
  await page.evaluate(() => window.workspacePresentation.setDraftStatus('Draft saved'));
  await page
    .locator('.draft-status:visible')
    .filter({ hasText: /^Saving draft$/ })
    .waitFor({ state: 'hidden' });
  assert.deepEqual(
    (await counts()).workbench,
    beforePresentation.workbench,
    'Saving completion also renders only the status leaf.',
  );
  // Switch without outside pointer dismissal: deactivation must close the body
  // portal, and the newly active navigation must subscribe with the latest list.
  const priorDetections = await page.evaluate((id) => window.detectionCompletions[id] || 0, ids[1]);
  await page
    .locator(`.project-navigation [data-project-id="${ids[1]}"] button`)
    .evaluate((button) => button.click());
  await page
    .getByRole('menu', { name: 'Project file actions', exact: true })
    .waitFor({ state: 'detached' });
  assert.equal(
    await page
      .getByRole('button', {
        name: 'Current navigation title, Project 2, Unsaved changes',
        exact: true,
      })
      .count(),
    1,
  );
  await page.waitForFunction(
    ({ id, prior }) => {
      const current = window.workbenchRuntime[id];
      return (
        current?.active &&
        !current.detecting &&
        current.datasheetReady &&
        current.detections > prior
      );
    },
    { id: ids[1], prior: priorDetections },
  );
  await selectProject(0);
  await page.evaluate(
    (projects) => window.workspacePresentation.setProjects(projects),
    navigationBefore,
  );
  await settled();

  const beforeDraft = await counts();
  const message = page.getByRole('textbox', { name: 'Message your agent', exact: true });
  const draftSaved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/state' &&
      response.request().method() === 'POST' &&
      response.request().postDataJSON().documents[0].sessions[0].draft ===
        'Keep this composer draft',
  );
  await message.fill('Keep this composer draft');
  await draftSaved;
  await settled();
  const afterDraft = await counts();
  for (const group of [
    'toolbarModes',
    'toolbarPlace',
    'appHeader',
    'navigationActions',
    'navigationSettings',
  ])
    assert.equal(
      afterDraft[group][ids[0]],
      beforeDraft[group][ids[0]],
      `${group} JSX survives conversation/recovery updates.`,
    );
  assert.equal(
    afterDraft.schematic[projects[0].schematic.id],
    beforeDraft.schematic[projects[0].schematic.id],
    'Composer and recovery updates do not render the active schematic.',
  );
  assert.equal(
    afterDraft.layout[projects[0].schematic.id],
    beforeDraft.layout[projects[0].schematic.id],
    'Composer and recovery updates do not render the retained Layout editor.',
  );
  assert.equal(
    afterDraft.workbench[ids[1]],
    beforeDraft.workbench[ids[1]],
    'A composer/recovery update does not render the inactive project.',
  );
  assert.equal(
    afterDraft.workbench.home,
    beforeDraft.workbench.home,
    'Draft save status does not render the retained Home workbench.',
  );
  assert.equal(
    afterDraft.schematic[projects[1].schematic.id],
    beforeDraft.schematic[projects[1].schematic.id],
    'The inactive schematic is not rendered by another project session update.',
  );
  assert.equal(recovery.documents[0].sessions[0].draft, 'Keep this composer draft');
  assert.equal(recovery.documents[0].source, serializeProject(projects[0]));
  assert.equal(
    recovery.documents[0].dirty,
    false,
    'Conversation changes preserve the clean baseline.',
  );
  assert.equal(recovery.documents.length, 2, 'Recovery still contains both complete projects.');

  const beforeEdit = await counts();
  await page.getByTestId('symbol-hit-R1').click();
  const resistorId = projects[0].schematic.parts.find((part) => part.ref === 'R1').id;
  const editResistor = (value) =>
    page.evaluate(
      ({ projectId, schematicId, partId, value }) =>
        window.workbenchRuntime[projectId].core.execute('part.properties', {
          schematicId,
          partId,
          value,
        }),
      { projectId: ids[0], schematicId: projects[0].schematic.id, partId: resistorId, value },
    );
  await page.getByLabel('Component reference', { exact: true }).waitFor();
  await page.evaluate((id) => {
    window.retainedR1Save = window.propertiesActions[id].onSave;
  }, resistorId);
  const afterSelection = await counts();
  const editSaved = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/state' &&
      response.request().method() === 'POST' &&
      response.request().postDataJSON().documents[0].dirty === true,
  );
  await canvas.press('ArrowRight');
  await editSaved;
  await settled();
  const afterEdit = await counts();
  for (const group of [
    'toolbarModes',
    'toolbarPlace',
    'appHeader',
    'navigationActions',
    'navigationSettings',
  ])
    assert.equal(
      afterEdit[group][ids[0]],
      beforeEdit[group][ids[0]],
      `${group} JSX survives selection and a schematic pose edit.`,
    );
  assert.equal(
    afterEdit.properties[resistorId],
    afterSelection.properties[resistorId],
    'A schematic pose edit retains the property form while geometry inputs stay live.',
  );
  assert.equal(
    afterEdit.chat['session-0'],
    beforeEdit.chat['session-0'],
    'Selection and design edits do not render an unchanged conversation.',
  );
  assert.equal(
    afterEdit.workbench[ids[1]],
    beforeEdit.workbench[ids[1]],
    'Another project dirty indicator does not render the inactive workbench.',
  );
  assert.equal(
    afterEdit.workbench.home,
    beforeEdit.workbench.home,
    'Project navigation changes do not render the inactive Home workbench.',
  );
  assert.notEqual(recovery.documents[0].source, serializeProject(projects[0]));
  await selectProject(1);
  assert.equal(
    await page.locator(`.project-navigation [data-project-id="${ids[0]}"] .dirty-dot`).count(),
    1,
    'Activation refreshes navigation with current dirty indicators.',
  );
  await selectProject(0);
  await canvas.press('Control+z');
  await page.waitForFunction(() => !document.querySelector('.dirty-dot'));
  await settled();
  const afterUndo = await counts();
  for (const group of ['toolbarModes', 'toolbarPlace', 'appHeader', 'navigationActions'])
    assert.equal(
      afterUndo[group][ids[0]],
      beforeEdit[group][ids[0]],
      `${group} JSX survives undo and selection clearing.`,
    );
  await runCanvasAction(page, 'Zoom in');
  await runCanvasAction(page, 'Zoom out');
  await settled();
  const afterCamera = await counts();
  for (const group of [
    'toolbarModes',
    'toolbarPlace',
    'appHeader',
    'navigationActions',
    'navigationSettings',
  ])
    assert.equal(
      afterCamera[group][ids[0]],
      afterUndo[group][ids[0]],
      `${group} JSX survives camera changes.`,
    );

  await selectProject(1);
  assert.equal(await message.inputValue(), '');
  await selectProject(0);
  assert.equal(
    await message.inputValue(),
    'Keep this composer draft',
    'Activation retains local state.',
  );
  await button('Layout').click();
  assert.equal(
    await page.evaluate(
      () => window.retainedLayout === document.querySelector('[data-testid="layout-canvas"]'),
    ),
    true,
    'Editor switching keeps the original mounted Layout canvas.',
  );
  await page
    .getByRole('listbox', { name: 'Edit schematic', exact: true })
    .waitFor({ state: 'hidden' });
  const originalThickness = await page.evaluate(
    (id) => {
      window.syncStatuses[id.document] = [];
      const { board, onCommit } = window.layoutActions[id.schematic];
      if (!onCommit({ ...board, thickness: board.thickness + 0.1 }))
        throw new Error('Pure board edit was rejected.');
      return board.thickness;
    },
    { document: ids[0], schematic: projects[0].schematic.id },
  );
  await page.waitForFunction(
    ({ id, thickness }) => window.layoutActions[id].board.thickness === thickness,
    { id: projects[0].schematic.id, thickness: originalThickness + 0.1 },
  );
  const afterCoreBoardCommit = await counts();
  await settled();
  const afterBoardRecovery = await counts();
  assert.deepEqual(
    afterBoardRecovery.workbench,
    afterCoreBoardCommit.workbench,
    'A real Core PCB commit schedules no additional Workbench render for navigation or draft persistence.',
  );
  assert.deepEqual(
    afterBoardRecovery.layout,
    afterCoreBoardCommit.layout,
    'Draft persistence does not render the current Layout editor.',
  );
  assert.equal(
    await page.evaluate((id) => window.syncStatuses[id].some((status) => status.pending), ids[0]),
    false,
    'A real Core-owned pure PCB edit never emits footprint-loading state.',
  );
  assert.equal(await page.getByText('Loading assigned footprints…', { exact: true }).count(), 0);
  await page.getByTestId('layout-canvas').press('Control+z');
  await page.waitForFunction(
    ({ id, thickness }) => window.layoutActions[id].board.thickness === thickness,
    { id: projects[0].schematic.id, thickness: originalThickness },
  );
  await settled();
  assert.equal(
    await page.evaluate((id) => window.syncStatuses[id].some((status) => status.pending), ids[0]),
    false,
    'Undo to an already prepared PCB never flashes loading.',
  );
  const beforeHiddenEdits = (await counts()).toolbarChrome;
  for (const value of ['1.1k', '1.2k', '1.3k']) {
    assert.equal(
      await page.evaluate(
        ({ id, value }) => {
          const { part, fields } = window.propertiesActions[id];
          return window.retainedR1Save(part.ref, value, fields);
        },
        { id: resistorId, value },
      ),
      false,
      'A hidden property form cannot apply a retained human callback.',
    );
    await editResistor(value);
    await page.waitForFunction(
      (value) =>
        document.querySelector('[data-testid="annotation-value-R1"]')?.textContent === value,
      value,
    );
    assert.equal(
      (await counts()).toolbarChrome,
      beforeHiddenEdits,
      'Hidden Schematic toolbar builds no JSX for a design commit.',
    );
  }
  const layoutCanvas = page.getByTestId('layout-canvas');
  for (const value of [
    '1.2k',
    '1.1k',
    projects[0].schematic.parts.find((part) => part.ref === 'R1').value,
  ]) {
    await layoutCanvas.press('Control+z');
    await page.waitForFunction(
      (value) =>
        document.querySelector('[data-testid="annotation-value-R1"]')?.textContent === value,
      value,
    );
    assert.equal(
      (await counts()).toolbarChrome,
      beforeHiddenEdits,
      'Hidden menus do not intercept Layout undo or build toolbar JSX.',
    );
  }
  await button('Schematic').click();
  const schematicTools = page.getByRole('group', { name: 'Schematic tools', exact: true });
  assert.equal(
    await schematicTools.getByRole('button', { name: 'Undo', exact: true }).isDisabled(),
    true,
    'Revealing receives current undo availability.',
  );
  assert.equal(
    await schematicTools.getByRole('button', { name: 'Redo', exact: true }).isEnabled(),
    true,
    'Revealing receives current redo availability.',
  );
  await button('Source').click();
  const schematicFile = await page
    .getByRole('navigation', { name: 'Project files', exact: true })
    .locator('[data-source-file]')
    .filter({ hasText: /\.kicad_sch$/ })
    .first()
    .getAttribute('data-source-file');
  await selectSourceFile(page, schematicFile);
  const currentNative = await readSource(page);
  const updatedNative = parseSExpr(currentNative);
  const resistor = children(updatedNative, 'symbol').find((symbol) =>
    children(symbol, 'property').some(
      (property) => val(property) === 'Reference' && val(property, 2) === 'R1',
    ),
  );
  assert.ok(resistor, 'The native fixture contains R1.');
  children(resistor, 'property').find((property) => val(property) === 'Value')[2] =
    JSON.stringify('2k');
  const libraryId = val(child(resistor, 'lib_id'));
  const library = children(child(updatedNative, 'lib_symbols'), 'symbol').find(
    (symbol) => val(symbol) === libraryId,
  );
  assert.ok(library, 'R1 has its exact embedded library.');
  children(library, 'property').find((property) => val(property) === 'Value')[2] = JSON.stringify(
    'retained-library-default',
  );
  const placeBeforeDraft = (await counts()).toolbarPlace[ids[0]];
  const headerBeforeDraft = (await counts()).appHeader[ids[0]];
  await fillSource(page, '(');
  await page
    .getByRole('region', { name: 'Project source', exact: true })
    .getByRole('button', { name: 'Apply', exact: true })
    .waitFor();
  await page.waitForFunction(
    () => !document.querySelector('.source-editor button[aria-label="Apply"]').disabled,
  );
  await button('Layout').click();
  assert.equal(
    await page.getByRole('region', { name: 'Project source', exact: true }).isVisible(),
    true,
    'The file-bar view callback checks the latest invalid Source draft.',
  );
  await page.getByRole('combobox', { name: 'File', exact: true }).click();
  await page.getByRole('option', { name: 'Save', exact: true }).click();
  assert.equal(await readSource(page), '(', 'The retained File action preserves invalid Source.');
  assert.equal(
    (await counts()).appHeader[ids[0]],
    headerBeforeDraft,
    'Source draft/error changes retain header JSX while actions stay fresh.',
  );
  assert.equal(
    await page.evaluate((id) => {
      const { part, fields } = window.propertiesActions[id];
      return window.retainedR1Save(part.ref, 'blocked value', fields);
    }, resistorId),
    false,
    'A retained stable-ID property callback reads the current Source barrier.',
  );
  assert.equal(
    (await counts()).toolbarPlace[ids[0]],
    placeBeforeDraft,
    'Pending Source retains the placement group JSX.',
  );
  // Replay a retained hidden control: its stable action must consult the latest
  // Source barrier even when its JSX predates that draft.
  const marker = page.locator(
    '[aria-label="Schematic tools"] [role="combobox"][aria-label="Place electrical marker"]',
  );
  await marker.evaluate((button) => button.click());
  await page.getByRole('option', { name: 'Net label', exact: true }).click();
  assert.equal(
    await page.getByRole('region', { name: 'Project source', exact: true }).isVisible(),
    true,
    'An invalid latest Source draft blocks retained placement actions.',
  );
  assert.equal(await readSource(page), '(');
  assert.equal(
    (await counts()).toolbarPlace[ids[0]],
    placeBeforeDraft,
    'Source errors do not recreate placement JSX.',
  );
  assert.ok(await canvas.evaluate((svg) => svg.parentElement.classList.contains('tool-select')));
  await fillSource(page, writeSExpr(updatedNative) + '\n');
  await marker.evaluate((button) => button.click());
  await page.getByRole('option', { name: 'Net label', exact: true }).click();
  await canvas.waitFor({ state: 'visible' });
  assert.equal(
    await page
      .getByRole('group', { name: 'Editor view', exact: true })
      .getByRole('button', { name: 'Schematic', exact: true })
      .getAttribute('aria-pressed'),
    'true',
    'The document bar displays the actual active editor view.',
  );
  assert.equal(
    await page.getByTestId('annotation-value-R1').textContent(),
    '2k',
    'Retained placement applies the latest valid Source before choosing a tool.',
  );
  assert.ok(await canvas.evaluate((svg) => svg.parentElement.classList.contains('tool-label')));
  await button('Interaction mode').click();
  assert.ok(await canvas.evaluate((svg) => svg.parentElement.classList.contains('tool-select')));
  await button('Wire').click();
  assert.ok(
    await canvas.evaluate((svg) => svg.parentElement.classList.contains('tool-wire')),
    'Retained Wire action still chooses its current tool.',
  );
  await button('Interaction mode').click();
  const capacitorValue = await page.getByTestId('annotation-value-C1').textContent();
  await page.getByTestId('symbol-hit-C1').click();
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="Component reference"]')?.value === 'C1',
  );
  assert.equal(
    await page.evaluate((id) => {
      const { part, fields } = window.propertiesActions[id];
      return window.retainedR1Save(part.ref, '3k', fields);
    }, resistorId),
    false,
    'An earlier form callback cannot edit after the inspected component changes.',
  );
  assert.equal(await page.getByTestId('annotation-value-R1').textContent(), '2k');
  await editResistor('3k');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="annotation-value-R1"]')?.textContent === '3k',
  );
  assert.equal(await page.getByTestId('annotation-value-C1').textContent(), capacitorValue);
  assert.equal(await page.getByLabel('Component reference', { exact: true }).inputValue(), 'C1');
  await button('Source').click();
  await selectSourceFile(page, schematicFile.trim());
  const afterStableSave = parseSExpr(await readSource(page));
  const retainedLibrary = children(child(afterStableSave, 'lib_symbols'), 'symbol').find(
    (symbol) => val(symbol) === libraryId,
  );
  assert.equal(
    val(
      children(retainedLibrary, 'property').find((property) => val(property) === 'Value'),
      2,
    ),
    'retained-library-default',
    'An explicit Core property command preserves the latest Source library change.',
  );
  await page.evaluate(() => window.showReferenceStatusFixture());
  await page.getByText('Read-only reference · Native edits pending', { exact: true }).waitFor();
  const beforeReferenceStatus = await counts();
  await page.evaluate(() => window.referencePresentation.publishDraftStatus('Saving draft'));
  await page.waitForTimeout(40);
  assert.equal(
    await page.getByText('Read-only reference · Native edits pending', { exact: true }).count(),
    1,
    'Recovery status cannot replace a read-only Source reference status.',
  );
  assert.deepEqual(
    (await counts()).source,
    beforeReferenceStatus.source,
    'Recovery status does not render the reference editor.',
  );
  await selectSourceFile(page, 'project.kicad_sch');
  await page.getByText('Saving draft', { exact: true }).waitFor();
  const beforeNativeStatus = await counts();
  await page.evaluate(() => window.referencePresentation.publishDraftStatus('Draft save failed'));
  await page.getByText('Draft save failed', { exact: true }).waitFor();
  assert.deepEqual(
    (await counts()).source,
    beforeNativeStatus.source,
    'Native Source recovery status updates only its status leaf.',
  );
  assert.equal(await page.evaluate(() => window.referenceChanges), 0);
  await page.evaluate(() => window.setReferenceStatus('Fixture status'));
  await page.getByText('Fixture status', { exact: true }).waitFor();
  await page.evaluate(() => window.referencePresentation.publishDraftStatus('Saving draft'));
  await page.waitForTimeout(40);
  assert.equal(
    await page.getByText('Fixture status', { exact: true }).count(),
    1,
    'Existing explicit status props remain an independent fixture fallback.',
  );
  assert.deepEqual(errors, []);
  console.log(
    'Render isolation verified: idle hover, workspace recovery, inactive projects, retained editors/toolbars and current Source guards/actions.',
  );
} finally {
  await browser.close();
}
