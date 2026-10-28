import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectCore } from '../core/project-core';
import {
  projectFromNativeFiles,
  projectNativeFiles,
  replaceNativeProjectFile,
} from '../lib/kicad-project';
import { createNativeProjectDirtyChecker, nativeProjectDirty } from '../lib/native-project-dirty';
import { createProject, serializeProject, type Project } from '../lib/project';

function fixture(): Project {
  const project = createProject();
  project.name = 'Filter';
  project.schematic.title = 'Original schematic';
  const files = projectNativeFiles(project, 'Filter.kicad_pro');
  files.files.push({ name: 'fp-lib-table', source: '(fp_lib_table (version 7))\n' });
  return projectFromNativeFiles(files);
}

test('native dirty state handles missing projects, missing baselines and identical snapshots', () => {
  const project = fixture();
  const source = serializeProject(project);
  assert.equal(nativeProjectDirty(null, null, 'Filter.kicad_pro'), false);
  assert.equal(nativeProjectDirty(null, source, 'Filter.kicad_pro'), false);
  assert.equal(nativeProjectDirty(project, null, 'Filter.kicad_pro'), true);
  assert.equal(nativeProjectDirty(project, source, 'Filter.kicad_pro'), false);
  assert.equal(nativeProjectDirty(structuredClone(project), source, 'Filter.kicad_pro'), false);
  assert.equal(nativeProjectDirty(project, 'invalid baseline', 'Filter.kicad_pro'), true);
});

test('native materialization does not dirty equivalent saved bytes or returning to them through model undo', () => {
  const project = fixture();
  project.schematic.title = 'Saved schematic';
  const core = new ProjectCore(project);
  const original = core.getSnapshot().project!;
  core.commitProject({
    ...original,
    schematic: { ...original.schematic, title: 'Temporary schematic' },
  });
  const temporary = core.getSnapshot().project!;
  core.commitProject({
    ...temporary,
    schematic: { ...temporary.schematic, title: 'Saved schematic' },
  });
  const saving = core.getSnapshot().project!;
  const nativeFiles = projectNativeFiles(saving, 'Filter.kicad_pro');
  assert.equal(core.materialize(saving, { ...saving, nativeFiles }), true);
  const savedSource = core.getSnapshot().source;
  assert.equal(
    serializeProject(original),
    savedSource,
    'Private snapshots materialize the same current native bytes before and after Save.',
  );
  assert.equal(nativeProjectDirty(original, savedSource, 'Filter.kicad_pro'), false);
  assert.equal(core.undo(), true);
  assert.equal(
    nativeProjectDirty(core.getSnapshot().project, savedSource, 'Filter.kicad_pro'),
    true,
  );
  assert.equal(core.undo(), true);
  assert.equal(core.getSnapshot().project, original);
  assert.equal(
    nativeProjectDirty(core.getSnapshot().project, savedSource, 'Filter.kicad_pro'),
    false,
  );
});

test('Save as compares both snapshots at the same destination and ignores native file list order', () => {
  const project = fixture();
  const baseline = serializeProject(project);
  const renamed = { ...project, nativeFiles: projectNativeFiles(project, 'Personal.kicad_pro') };
  renamed.nativeFiles.files.reverse();
  assert.notEqual(serializeProject(renamed), baseline);
  assert.equal(nativeProjectDirty(renamed, baseline, 'Personal.kicad_pro'), false);
  const changed = { ...renamed, schematic: { ...renamed.schematic, title: 'Changed schematic' } };
  assert.equal(nativeProjectDirty(changed, baseline, 'Personal.kicad_pro'), true);
});

test('intentional native JSON, schematic whitespace and auxiliary source changes remain dirty', () => {
  const project = fixture();
  const baseline = serializeProject(project);
  const native = projectNativeFiles(project);
  for (const name of ['Filter.kicad_pro', 'Filter.kicad_sch', 'fp-lib-table']) {
    const file = native.files.find((file) => file.name === name)!;
    const edited = replaceNativeProjectFile(project, name, file.source + '\n');
    assert.equal(nativeProjectDirty(edited, baseline, 'Filter.kicad_pro'), true, name);
  }
  const changed = replaceNativeProjectFile(
    project,
    'fp-lib-table',
    '(fp_lib_table (version 7)\n)\n',
  );
  assert.equal(nativeProjectDirty(changed, baseline, 'Filter.kicad_pro'), true);
});

test('native file encoding changes remain dirty even when decoded source text is identical', () => {
  const files = projectNativeFiles(fixture());
  files.files.push({ name: 'models/vendor.lib', source: '* Vendor model: ©\n' });
  const project = projectFromNativeFiles(files);
  const baseline = serializeProject(project);
  const changed = structuredClone(project);
  changed.nativeFiles!.files.find((file) => file.name === 'models/vendor.lib')!.encoding = 'latin1';
  assert.equal(nativeProjectDirty(changed, baseline, 'Filter.kicad_pro'), true);
  assert.equal(nativeProjectDirty(project, serializeProject(changed), 'Filter.kicad_pro'), true);
  assert.equal(nativeProjectDirty(changed, serializeProject(changed), 'Filter.kicad_pro'), false);
});

test('a workbench dirty checker follows successive edits, undo, saves and destination changes', () => {
  const dirty = createNativeProjectDirtyChecker();
  const core = new ProjectCore(fixture());
  const initial = core.getSnapshot();
  const changed = (title: string) => {
    const project = core.getSnapshot().project!;
    core.commitProject({ ...project, schematic: { ...project.schematic, title } });
    return core.getSnapshot();
  };
  const first = changed('First edit');
  assert.equal(dirty(first.project, initial.source, 'Filter.kicad_pro'), true);
  const second = changed('Second edit');
  assert.equal(dirty(second.project, initial.source, 'Filter.kicad_pro'), true);
  assert.equal(core.undo(), true);
  assert.equal(dirty(core.getSnapshot().project, initial.source, 'Filter.kicad_pro'), true);
  assert.equal(core.undo(), true);
  assert.equal(dirty(core.getSnapshot().project, initial.source, 'Filter.kicad_pro'), false);

  // Saving establishes a different baseline; Save as compares native bytes at
  // the new destination, including renamed instance metadata and supporting text.
  const renamed = projectFromNativeFiles(projectNativeFiles(first.project!, 'Personal.kicad_pro'));
  assert.equal(dirty(renamed, first.source, 'Personal.kicad_pro'), false);
  assert.equal(dirty(second.project, first.source, 'Personal.kicad_pro'), true);
  const renamedSource = serializeProject(renamed);
  assert.equal(dirty(initial.project, renamedSource, 'Personal.kicad_pro'), true);
  assert.equal(dirty(initial.project, 'invalid baseline', 'Filter.kicad_pro'), true);
  assert.equal(dirty(initial.project, initial.source, 'Filter.kicad_pro'), false);
  assert.equal(dirty(initial.project, null, 'Filter.kicad_pro'), true);
  assert.equal(dirty(null, renamedSource, 'Personal.kicad_pro'), false);
  assert.equal(dirty(renamed, first.source, 'Personal.kicad_pro'), false);

  const mutable = structuredClone(first.project!);
  assert.equal(dirty(mutable, initial.source, 'Filter.kicad_pro'), true);
  mutable.schematic.title = initial.project!.schematic.title;
  assert.equal(dirty(mutable, initial.source, 'Filter.kicad_pro'), false);
});
