import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectCore, type ProjectCoreEvent } from '../core/project-core';
import { emptyCircuit } from '../lib/circuit';
import {
  projectFromNativeFiles,
  projectNativeFiles,
  type KiCadProjectFiles,
} from '../lib/kicad-project';
import { createEmptyPCB } from '../lib/pcb-layout';
import { createProject, importDocument } from '../lib/project';
import { simulationModelDefinitions } from '../lib/simulation-models';

function fixture(withModels = false) {
  const project = createProject();
  project.name = 'Filter';
  project.schematic.title = 'Main schematic';
  project.additionalSchematics = [{ ...emptyCircuit(), title: 'Control schematic' }];
  project.pcb = createEmptyPCB();
  if (withModels) project.simulationModels = [{ ...simulationModelDefinitions[0] }];
  const files = projectNativeFiles(project, 'Filter.kicad_pro');
  files.files.push({ name: 'fp-lib-table', source: '(fp_lib_table (version 7))\n' });
  return new ProjectCore(projectFromNativeFiles(files));
}

const sourceFiles = (core: ProjectCore) => core.query('source.files') as KiCadProjectFiles;
const sourceFile = (core: ProjectCore, name: string) => {
  const file = sourceFiles(core).files.find((file) => file.name === name);
  assert.ok(file, `Project contains ${name}.`);
  return file.source;
};
const editFile = (core: ProjectCore, name: string, source: string) =>
  core.execute('source.updateFile', { name, source }) as KiCadProjectFiles;
const fileMap = (files: KiCadProjectFiles) =>
  new Map(files.files.map((file) => [file.name, file.source]));

test('registered native Source commands stage multiple files and apply one whole-project undo transaction', () => {
  const core = fixture();
  const baseline = core.getSnapshot();
  const originalFiles = sourceFiles(core);
  const events: ProjectCoreEvent['type'][] = [];
  core.subscribe((event) => events.push(event.type));
  const schematic = sourceFile(core, 'Filter.kicad_sch').replace(
    '"Main schematic"',
    '"Edited schematic"',
  );
  const settings = JSON.parse(sourceFile(core, 'Filter.kicad_pro'));
  settings.text_variables = { REVISION: 'C' };
  const settingsSource = JSON.stringify(settings, null, 2) + '\n';
  editFile(core, 'Filter.kicad_sch', schematic);
  const staged = editFile(core, 'Filter.kicad_pro', settingsSource);
  assert.equal(staged.files.find((file) => file.name === 'Filter.kicad_sch')!.source, schematic);
  assert.equal(
    staged.files.find((file) => file.name === 'Filter.kicad_pro')!.source,
    settingsSource,
  );
  assert.equal(core.getSnapshot().project, baseline.project);
  assert.equal(core.getSnapshot().source, baseline.source);
  assert.equal(core.getSnapshot().undoDepth, 0);
  assert.ok(core.getSnapshot().sourceDraft);
  core.execute('source.apply');
  const applied = core.getSnapshot();
  assert.equal(applied.project!.id, baseline.project!.id);
  assert.equal(applied.project!.schematic.title, 'Edited schematic');
  assert.equal(applied.sourceDraft, null);
  assert.equal(applied.undoDepth, 1);
  assert.equal(sourceFile(core, 'Filter.kicad_pro'), settingsSource);
  assert.equal(events.filter((type) => type === 'source.applied').length, 1);
  const appliedFiles = sourceFiles(core);
  assert.equal(core.execute('history.undo'), true);
  assert.equal(core.getSnapshot().source, baseline.source);
  assert.deepEqual(fileMap(sourceFiles(core)), fileMap(originalFiles));
  assert.equal(core.execute('history.redo'), true);
  assert.equal(core.getSnapshot().source, applied.source);
  assert.deepEqual(fileMap(sourceFiles(core)), fileMap(appliedFiles));
});

test('invalid additional schematic blocks every staged edit atomically and survives recovery as exact draft text', () => {
  const core = fixture();
  const baseline = core.getSnapshot();
  const secondaryName = 'Control schematic.kicad_sch';
  const secondary = sourceFile(core, secondaryName);
  const main = sourceFile(core, 'Filter.kicad_sch').replace('"Main schematic"', '"Pending main"');
  const invalidSecondary = secondary + ')\n';
  editFile(core, 'Filter.kicad_sch', main);
  editFile(core, secondaryName, invalidSecondary);
  const draft = core.getSnapshot().sourceDraft;
  assert.ok(draft);
  assert.throws(() => core.execute('source.apply'), /trailing|unexpected|invalid/i);
  const rejected = core.getSnapshot();
  assert.equal(rejected.project, baseline.project);
  assert.equal(rejected.source, baseline.source);
  assert.equal(rejected.undoDepth, 0);
  assert.equal(rejected.sourceDraft, draft);
  assert.ok(rejected.sourceError);
  assert.equal(sourceFile(core, secondaryName), invalidSecondary);
  for (const command of ['history.undo', 'history.redo', 'schematic.add'])
    assert.throws(() => core.execute(command), /Apply the Source/);
  const recovered = new ProjectCore(importDocument(rejected.source), {
    draft: rejected.sourceDraft,
  });
  assert.equal(recovered.getSnapshot().sourceDraft, draft);
  assert.equal(sourceFile(recovered, 'Filter.kicad_sch'), main);
  assert.equal(sourceFile(recovered, secondaryName), invalidSecondary);
  assert.throws(() => recovered.execute('source.apply'), /trailing|unexpected|invalid/i);
  assert.equal(recovered.getSnapshot().source, baseline.source);
  editFile(recovered, secondaryName, secondary);
  recovered.execute('source.apply');
  assert.equal(recovered.getSnapshot().project!.schematic.title, 'Pending main');
  assert.equal(recovered.getSnapshot().sourceDraft, null);
  assert.equal(recovered.getSnapshot().undoDepth, 1);
  assert.equal(recovered.execute('history.undo'), true);
  assert.equal(recovered.getSnapshot().source, baseline.source);
});

test('removing the native project model text variable is authoritative through Apply, undo and redo', () => {
  const core = fixture(true);
  const before = core.getSnapshot();
  const settings = JSON.parse(sourceFile(core, 'Filter.kicad_pro'));
  assert.ok(settings.text_variables.OPENPE_SIMULATION_MODELS);
  delete settings.text_variables.OPENPE_SIMULATION_MODELS;
  editFile(core, 'Filter.kicad_pro', JSON.stringify(settings, null, 2) + '\n');
  core.execute('source.apply');
  assert.equal(core.getSnapshot().project!.simulationModels, undefined);
  assert.equal(
    JSON.parse(sourceFile(core, 'Filter.kicad_pro')).text_variables.OPENPE_SIMULATION_MODELS,
    undefined,
  );
  assert.equal(core.execute('history.undo'), true);
  assert.deepEqual(core.getSnapshot().project!.simulationModels, before.project!.simulationModels);
  assert.ok(
    JSON.parse(sourceFile(core, 'Filter.kicad_pro')).text_variables.OPENPE_SIMULATION_MODELS,
  );
  assert.equal(core.execute('history.redo'), true);
  assert.equal(core.getSnapshot().project!.simulationModels, undefined);
  assert.equal(
    JSON.parse(sourceFile(core, 'Filter.kicad_pro')).text_variables.OPENPE_SIMULATION_MODELS,
    undefined,
  );
});

test('exact native file no-ops retain clean state and reverting the last file edit clears the pending draft', () => {
  const core = fixture();
  const baseline = core.getSnapshot();
  const original = sourceFile(core, 'Filter.kicad_pro');
  editFile(core, 'Filter.kicad_pro', original);
  assert.equal(core.getSnapshot(), baseline);
  editFile(core, 'Filter.kicad_pro', original + '\n');
  assert.notEqual(core.getSnapshot().sourceDraft, null);
  editFile(core, 'Filter.kicad_pro', original);
  assert.equal(core.getSnapshot().sourceDraft, null);
  assert.equal(core.getSnapshot().undoDepth, 0);
  assert.equal(core.getSnapshot().source, baseline.source);
  core.execute('source.apply');
  assert.equal(core.getSnapshot().undoDepth, 0);
  assert.throws(() => editFile(core, '../outside.kicad_sch', ''), /no longer in the project/);
  assert.equal(core.getSnapshot().source, baseline.source);
});

test('Save as native metadata materialization retains existing design undo and rejects stale or pending work', () => {
  const core = fixture();
  const baseline = core.getSnapshot();
  editFile(
    core,
    'Filter.kicad_sch',
    sourceFile(core, 'Filter.kicad_sch').replace('"Main schematic"', '"Saved schematic"'),
  );
  core.execute('source.apply');
  const edited = core.getSnapshot();
  const nativeFiles = projectNativeFiles(edited.project!, 'Personal.kicad_pro');
  assert.equal(core.materialize(edited.project!, { ...edited.project!, nativeFiles }), true);
  const saved = core.getSnapshot();
  assert.equal(saved.undoDepth, 1);
  assert.equal(saved.project!.schematic, edited.project!.schematic);
  assert.equal(sourceFiles(core).entry, 'Personal.kicad_pro');
  assert.ok(sourceFiles(core).files.some((file) => file.name === 'Personal.kicad_sch'));
  assert.ok(sourceFiles(core).files.some((file) => file.name === 'Personal.kicad_pcb'));
  assert.equal(
    JSON.parse(sourceFile(core, 'Personal.kicad_pro')).meta.filename,
    'Personal.kicad_pro',
  );
  assert.equal(core.materialize(edited.project!, edited.project!), false);
  assert.equal(core.execute('history.undo'), true);
  assert.equal(core.getSnapshot().source, baseline.source);
  assert.equal(core.execute('history.redo'), true);
  assert.equal(core.getSnapshot().source, saved.source);
  assert.equal(sourceFiles(core).entry, 'Personal.kicad_pro');
  editFile(core, 'Personal.kicad_pro', '{');
  const pending = core.getSnapshot();
  assert.equal(core.materialize(pending.project!, { ...pending.project!, nativeFiles }), false);
  assert.equal(core.getSnapshot(), pending);
});

test('invalid Latin1 and NUL source text remains visible before and after failed Apply', () => {
  const files = sourceFiles(fixture());
  const name = 'models/vendor.lib';
  const original = '* Vendor model ©\n';
  files.files.push({ name, source: original, encoding: 'latin1' });
  for (const invalid of [original + 'Ω', original + '\0']) {
    const core = new ProjectCore(projectFromNativeFiles(files));
    const baseline = core.getSnapshot();
    editFile(core, name, invalid);
    assert.equal(sourceFile(core, name), invalid);
    assert.equal(sourceFiles(core).files.find((file) => file.name === name)!.encoding, 'latin1');
    const draft = core.getSnapshot().sourceDraft;
    assert.ok(draft);
    assert.throws(() => core.execute('source.apply'), /Invalid KiCad project/);
    assert.equal(sourceFile(core, name), invalid);
    assert.equal(core.getSnapshot().sourceDraft, draft);
    assert.equal(core.getSnapshot().source, baseline.source);
    assert.equal(core.getSnapshot().project, baseline.project);
    assert.equal(core.getSnapshot().undoDepth, 0);
  }
});

test('malformed Source envelopes remain protected drafts without crashing native file queries', () => {
  const core = fixture();
  const baseline = core.getSnapshot();
  const original = sourceFiles(core);
  const draft = JSON.stringify({ entry: 'Filter.kicad_pro', files: [null] });
  core.execute('source.update', { draft });
  assert.deepEqual(sourceFiles(core), original);
  assert.equal(core.getSnapshot().sourceDraft, draft);
  assert.throws(() => core.execute('source.apply'), /Invalid KiCad project/);
  assert.deepEqual(sourceFiles(core), original);
  assert.equal(core.getSnapshot().source, baseline.source);
  assert.equal(core.getSnapshot().sourceDraft, draft);
  assert.equal(core.getSnapshot().undoDepth, 0);
});
