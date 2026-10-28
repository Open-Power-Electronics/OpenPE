import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectCore } from '../core/project-core';
import { createProject, serializeProject } from '../lib/project';
import {
  projectFromNativeFiles,
  projectNativeFiles,
  replaceNativeProjectFile,
} from '../lib/kicad-project';

test('native file and Core Source replacement retain the same independent project metadata', () => {
  const files = projectNativeFiles(createProject(), 'Circuit.kicad_pro');
  files.files.push({ name: 'fp-lib-table', source: '(fp_lib_table (version 7))\n' });
  const project = projectFromNativeFiles(files);
  project.name = 'Power stage';
  project.extensions = { 'example.org': { retained: true } };

  for (const file of files.files) {
    const source = file.source + '\n';
    const next = replaceNativeProjectFile(project, file.name, source);
    const core = new ProjectCore(project);
    core.updateNativeSource(file.name, source);
    assert.ok(core.applySource(), file.name);

    assert.equal(next.id, project.id, file.name);
    assert.equal(next.name, 'Power stage', file.name);
    assert.deepEqual(next.extensions, project.extensions, file.name);
    assert.equal(serializeProject(next), core.getSnapshot().source, file.name);
    assert.equal(project.name, 'Power stage');
  }
});

test('native Source edits preserve the displayed fallback name when an internal project omits it', () => {
  const files = projectNativeFiles(createProject(), 'Circuit.kicad_pro');
  const project = projectFromNativeFiles(files);
  delete project.name;
  project.schematic.title = 'Analog filter';
  const file = projectNativeFiles(project).files.find((file) => file.name === files.entry)!;
  const source = file.source + '\n';
  const core = new ProjectCore(project);
  core.updateNativeSource(file.name, source);
  assert.ok(core.applySource());
  assert.equal(core.getSnapshot().project!.name, 'Analog filter');
  const next = replaceNativeProjectFile(project, file.name, source);
  assert.equal(next.name, 'Analog filter');
  assert.equal(serializeProject(next), core.getSnapshot().source);
});
