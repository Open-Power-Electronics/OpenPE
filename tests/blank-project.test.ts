import test from 'node:test';
import assert from 'node:assert/strict';
import { ProjectCore } from '../core/project-core';
import { createBlankProject } from '../lib/create-blank-project';
import { projectFromNativeFiles } from '../lib/kicad-project';
import { modelCadFromProject, MODEL_CAD_NATIVE_VARIABLE } from '../lib/model-cad';
import { nativeProjectDirty } from '../lib/native-project-dirty';
import { newModelCadObject } from '../lib/model-cad';

test('new projects admit complete empty native files and Model CAD before any view opens', () => {
  const project = createBlankProject();
  const core = new ProjectCore(project, { nativeEntryName: 'untitled.kicad_pro' });
  const baseline = core.getSnapshot();
  const files = core.getNativeFiles();
  assert.equal(project.name, 'Untitled project');
  assert.equal(project.schematic.title, 'Schematic 1');
  assert.deepEqual(files.files.map((file) => file.name).sort(), [
    'untitled.kicad_pcb',
    'untitled.kicad_pro',
    'untitled.kicad_sch',
  ]);
  const settings = JSON.parse(files.files.find((file) => file.name === files.entry)!.source);
  assert.deepEqual(JSON.parse(settings.text_variables[MODEL_CAD_NATIVE_VARIABLE]), {
    version: 1,
    objects: [],
  });
  const reopened = projectFromNativeFiles(files);
  assert.ok(reopened.pcb);
  for (const key of ['footprints', 'tracks', 'vias', 'graphics', 'zones'] as const)
    assert.deepEqual(reopened.pcb[key], []);
  assert.deepEqual(modelCadFromProject(reopened), { version: 1, objects: [] });
  assert.equal(baseline.undoDepth, 0);
  assert.equal(core.getSnapshot(), baseline);
  assert.equal(nativeProjectDirty(baseline.project, baseline.source, files.entry), false);
  assert.notEqual(createBlankProject().pcb!.id, project.pcb!.id);
});

test('blank Model accepts a first solid through Core and undo restores the complete clean file set', () => {
  const project = createBlankProject();
  const core = new ProjectCore(project, { nativeEntryName: 'untitled.kicad_pro' });
  const baseline = core.getSnapshot();
  const files = core.getNativeFiles();
  const object = newModelCadObject(project.pcb!, 'box');
  core.execute('modelCad.add', { boardId: project.pcb!.id, object });
  assert.equal(modelCadFromProject(core.getSnapshot().project!)!.objects.length, 1);
  assert.equal(core.getSnapshot().undoDepth, 1);
  assert.equal(nativeProjectDirty(core.getSnapshot().project, baseline.source, files.entry), true);
  core.execute('history.undo');
  assert.deepEqual(core.getNativeFiles(), files);
  assert.equal(nativeProjectDirty(core.getSnapshot().project, baseline.source, files.entry), false);
});
