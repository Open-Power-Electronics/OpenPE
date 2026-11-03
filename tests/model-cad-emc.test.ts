import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ProjectCore } from '../core/project-core';
import { uid } from '../lib/circuit';
import { projectFromNativeFiles } from '../lib/kicad-project';
import {
  MODEL_CAD_NATIVE_VARIABLE,
  modelCadFromProject,
  modelCadRequiresPreparation,
  modelCadGeometryKey,
  withModelCad,
} from '../lib/model-cad';
import { parseProject } from '../lib/project';
import { enclosureStepGeometry } from '../server/enclosure-step.mjs';

test('EMC enclosure rebuilds through general CAD commands, edits and native save with exact undo', () => {
  const example = parseProject(readFileSync('lib/emc-flyback-example.json', 'utf8'));
  const assembly = modelCadFromProject(example)!;
  assert.equal(Object.hasOwn(example.extensions, 'org.openpe.enclosure'), false);
  assert.equal(assembly.objects.length, 4);
  const core = new ProjectCore(withModelCad(example, null));
  const initialProject = core.getSnapshot().project!;
  const initial = core.getNativeFiles();
  const boardId = example.pcb!.id;
  const rebuilt = assembly.objects.map((object) => ({
    ...object,
    id: uid(),
  }));
  for (const object of rebuilt) {
    if (modelCadRequiresPreparation(object))
      core.acceptPreparedModelCadGeometry(object, modelCadGeometryKey(object));
    core.execute('modelCad.add', { boardId, object });
  }
  assert.equal(core.getSnapshot().undoDepth, 4);
  assert.deepEqual(modelCadFromProject(core.getSnapshot().project!)!.objects, rebuilt);
  assert.equal(core.getSnapshot().project!.pcb, initialProject.pcb);
  assert.equal(core.getSnapshot().project!.schematic, initialProject.schematic);

  const cover = rebuilt.find((object) => object.material === 'pmma')!;
  const edited = {
    ...cover,
    opacity: 0.4,
  };
  core.execute('modelCad.update', { boardId, object: edited });
  const saved = core.getNativeFiles();
  const projectFile = saved.files.find((file) => file.name.endsWith('.kicad_pro'))!;
  const variables = JSON.parse(projectFile.source).text_variables;
  assert.equal(variables.OPENPE_ENCLOSURE, undefined);
  assert.deepEqual(
    JSON.parse(variables[MODEL_CAD_NATIVE_VARIABLE]),
    modelCadFromProject(core.getSnapshot().project!),
  );
  const reopened = projectFromNativeFiles(saved);
  assert.deepEqual(modelCadFromProject(reopened), modelCadFromProject(core.getSnapshot().project!));
  for (const file of saved.files.filter((file) => !file.name.endsWith('.kicad_pro')))
    assert.equal(file.source, initial.files.find((before) => before.name === file.name)!.source);
  const step = enclosureStepGeometry(reopened);
  assert.equal((step.match(/Box\(/g) ?? []).length, 2);
  assert.equal((step.match(/Disk\(/g) ?? []).length, 8);
  assert.doesNotMatch(step, /BooleanUnion/);

  core.undo();
  assert.deepEqual(modelCadFromProject(core.getSnapshot().project!)!.objects, rebuilt);
  for (let i = 0; i < rebuilt.length; i++) core.undo();
  assert.deepEqual(core.getNativeFiles(), initial);
  for (let i = 0; i < 5; i++) core.redo();
  assert.deepEqual(core.getNativeFiles(), saved);
});
