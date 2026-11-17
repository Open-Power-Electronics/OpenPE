import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import { ProjectCore } from '../core/project-core';
import { createProject, findSchematic } from '../lib/project';
import { circuitFingerprint } from '../lib/circuit';
import { agentProject } from '../lib/agent-project-access';
import { agentSource } from '../context/agent-workspace-context';

// Exercise the production closure without mounting a browser or replacing its
// asynchronous capture logic with a test implementation.
const source = await readFile(new URL('../components/Workbench.tsx', import.meta.url), 'utf8');
const file = ts.createSourceFile(
  'Workbench.tsx',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
function find(node: ts.Node): ts.FunctionDeclaration | undefined {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'readWorkspaceContext') return node;
  return ts.forEachChild(node, find);
}
const declaration = find(file);
assert.ok(declaration, 'The current Workbench owns its Agent workspace observation.');
const compiled = ts.transpileModule(`(${declaration.getText(file)})`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(active: boolean) {
  const core = new ProjectCore(createProject());
  const schematicId = core.getSnapshot().project!.schematic.id;
  let ready!: () => void;
  const datasheet = new Promise<null>((resolve) => {
    ready = () => resolve(null);
  });
  let captures = 0;
  const contextActive = { current: active };
  const presentation = { text: 'Origin project controls', controls: [], drawings: [] };
  const read = new vm.Script(compiled, {
    filename: 'Workbench.readWorkspaceContext.js',
  }).runInNewContext({
    core,
    agentProject,
    agentSource,
    active,
    contextActive,
    activeSchematicRef: { current: schematicId },
    findSchematic,
    readProjectDatasheet: () => datasheet,
    spiceAvailable: false,
    thermalAvailable: false,
    sourceFileFrom: (files: { name: string }[]) => files[0],
    datasheetReader: null,
    screen: 'workspace',
    view: 'canvas',
    tool: 'select',
    selection: [],
    inspectedPartId: null,
    filename: 'project.kicad_pro',
    diskObservationSelected: false,
    cleanSourceRef: { current: core.getSnapshot().source },
    filenameRef: { current: 'project.kicad_pro' },
    nativeProjectDirty: () => false,
    layers: {},
    selectionFilters: {},
    grid: true,
    gridSpacing: 1.27,
    layoutGridSpacing: 0.25,
    modelGridSpacing: 1,
    fileViewports: { current: new Map() },
    pcb3DView: { current: null },
    layoutAgentContext: { current: null },
    modal: null,
    toast: '',
    getProjects: () => [],
    captureAgentPresentation: () => {
      captures++;
      return presentation;
    },
    circuitFingerprint,
  }) as () => Promise<{ ui: { active: boolean; presentation: { text: string } } }>;
  return { core, read, ready, contextActive, captures: () => captures, presentation };
}

for (const active of [true, false]) {
  test(`workspace observation rejects a project switch while references load (initial active=${active})`, async () => {
    const state = fixture(active);
    const revision = state.core.getSnapshot().revision;
    const pending = state.read();
    // Switching projects changes presentation ownership, without editing the
    // originating project or moving its selected schematic.
    state.contextActive.current = !active;
    state.presentation.text = 'Other project private controls';
    state.ready();
    await assert.rejects(pending, /project or active file changed/);
    assert.equal(state.core.getSnapshot().revision, revision);
    assert.equal(state.captures(), 0, 'Never inspect controls belonging to the other project.');
  });
}

test('stable active and inactive observations retain their presentation boundary', async () => {
  for (const active of [true, false]) {
    const state = fixture(active);
    const pending = state.read();
    state.ready();
    const context = await pending;
    assert.equal(context.ui.active, active);
    assert.equal(state.captures(), active ? 1 : 0);
    assert.equal(context.ui.presentation.text, active ? state.presentation.text : '');
  }
});

test('workspace observation rejects a Source draft change while references load', async () => {
  const state = fixture(true);
  const pending = state.read();
  state.core.updateSource('private invalid draft');
  state.ready();
  await assert.rejects(pending, /project or active file changed/);
  assert.equal(state.captures(), 0);
});

test('explicit workspace observation contains only Source metadata for an invalid draft', async () => {
  const state = fixture(true);
  state.core.updateSource('private invalid model text');
  const pending = state.read();
  state.ready();
  const context = await pending;
  assert.doesNotMatch(JSON.stringify(context), /private invalid model text|nativeFiles/);
  assert.deepEqual(JSON.parse(JSON.stringify((context as any).source)), {
    pending: true,
    draft: null,
    error: '',
    draftCharacters: 'private invalid model text'.length,
  });
});
