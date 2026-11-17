import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectCore } from '../core/project-core';
import { createProject, serializeProject } from '../lib/project';
import { projectFromNativeFiles, projectNativeFiles } from '../lib/kicad-project';

function fixture() {
  const project = projectFromNativeFiles(projectNativeFiles(createProject(), 'Circuit.kicad_pro'));
  project.name = 'Power stage';
  project.extensions = { 'example.org': { retained: true } };
  return new ProjectCore(project);
}

test('Source previews share Apply metadata and validation without changing the original draft or history', () => {
  const core = fixture();
  const file = core.getNativeFiles().files.find((file) => file.name.endsWith('.kicad_sch'))!;
  core.updateNativeSource(file.name, file.source + '\n');
  const before = core.getSnapshot();
  const preview = core.previewSource()!;
  assert.equal(core.getSnapshot(), before);
  assert.equal(preview.id, before.project!.id);
  assert.equal(preview.name, 'Power stage');
  assert.deepEqual(preview.extensions, before.project!.extensions);
  const expected = serializeProject(preview);
  preview.schematic.title = 'Detached preview';
  assert.notEqual(before.project!.schematic.title, preview.schematic.title);
  assert.ok(core.applySource());
  assert.equal(core.getSnapshot().source, expected);
  assert.equal(core.getSnapshot().undoDepth, before.undoDepth + 1);
});

test('Source preview rejects invalid native and recovery drafts without clearing errors or publishing changes', () => {
  for (const draft of ['{invalid', JSON.stringify({ entry: 'Circuit.kicad_pro', files: [] })]) {
    const core = fixture();
    core.updateSource(draft);
    const before = core.getSnapshot();
    assert.throws(() => core.previewSource());
    assert.equal(core.getSnapshot(), before);
    assert.equal(core.applySource(), null);
    const failed = core.getSnapshot();
    assert.ok(failed.sourceError);
    assert.equal(failed.sourceDraft, draft);
    assert.equal(failed.project, before.project);
    assert.equal(failed.undoDepth, before.undoDepth);
    assert.throws(() => core.previewSource());
    assert.equal(core.getSnapshot(), failed);
  }
});

test('Source preview handles canonical drafts and reuses the immutable project without pending edits', () => {
  const core = fixture();
  assert.equal(core.previewSource(), core.getSnapshot().project);
  const canonical = JSON.parse(core.getSnapshot().source);
  canonical.project.name = 'Canonical draft';
  core.updateSource(JSON.stringify(canonical));
  const before = core.getSnapshot();
  const preview = core.previewSource()!;
  assert.equal(preview.name, 'Canonical draft');
  assert.equal(core.getSnapshot(), before);
  assert.ok(core.applySource());
  assert.equal(core.getSnapshot().source, serializeProject(preview));
  assert.equal(new ProjectCore(null).previewSource(), null);
});
