import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCapabilityHost } from '../api/capabilities';
import { ProjectCore } from '../core/project-core';
import { registerProjectCapabilities } from '../core/register-project';
import { uid } from '../lib/circuit';
import { copyExampleSource } from '../lib/example-copy';
import {
  MODEL_CAD_EXTENSION,
  MODEL_CAD_NATIVE_VARIABLE,
  modelCadFromProject,
  modelCadColor,
  modelCadMaterialColors,
  modelCadGeometryKey,
  modelCadOperandBounds,
  modelCadRequiresPreparation,
  modelCadSelectableEdges,
  modelCadShape,
  newModelCadBooleanObject,
  newModelCadObject,
  validateModelCad,
  validateModelCadObject,
  validateModelCadProfile,
  validateModelCadShape,
  withModelCad,
  type ModelCAD,
  type ModelCadObject,
} from '../lib/model-cad';
import { projectFromNativeFiles, projectNativeFiles } from '../lib/kicad-project';
import { parseProject, serializeProject, validateProject } from '../lib/project';

const source = readFileSync('lib/emc-flyback-example.json', 'utf8');
const fixture = () => withModelCad(parseProject(source), null);
const model = (object: ModelCadObject): ModelCAD => ({ version: 1, objects: [object] });

test('explicit CAD colors validate independently of material and never change geometry keys', () => {
  const box = newModelCadObject(fixture().pcb!, 'box');
  assert.equal(modelCadColor(box), modelCadMaterialColors.aluminium);
  const colored = validateModelCadObject({ ...box, color: '#3A6cF2' });
  assert.equal(modelCadColor(colored), 0x3a6cf2);
  assert.equal(modelCadColor({ ...colored, material: 'pmma' }), 0x3a6cf2);
  assert.equal(modelCadGeometryKey(colored), modelCadGeometryKey(box));
  assert.deepEqual(modelCadShape(colored), modelCadShape(box));
  for (const color of ['red', '#abc', '#12345678', '#12345g', '#123456extra', '', null, 123456])
    assert.throws(() => validateModelCadObject({ ...box, color }), /Invalid/);
  const tool = newModelCadObject(fixture().pcb!, 'cylinder');
  const combined = newModelCadBooleanObject(colored, tool, 'union');
  assert.equal(combined.color, colored.color);
  assert.equal('color' in combined.boolean!.operands[0].shape, false);
});

test('CAD color updates, reset, native round trips and undo retain unrelated project files', () => {
  const project = fixture();
  const box = newModelCadObject(project.pcb!, 'box');
  const core = new ProjectCore(withModelCad(project, model(box)));
  const before = core.getSnapshot();
  const native = core.getNativeFiles();
  const boardId = project.pcb!.id;
  const colored = { ...box, color: '#d94838' };
  core.execute('modelCad.update', { boardId, object: colored });
  assert.equal(core.getSnapshot().undoDepth, before.undoDepth + 1);
  assert.equal(core.getSnapshot().project!.pcb, before.project!.pcb);
  const files = core.getNativeFiles();
  const reopened = projectFromNativeFiles(files);
  assert.equal(modelCadFromProject(reopened)!.objects[0].color, colored.color);
  assert.deepEqual(projectNativeFiles(reopened), files);
  for (const file of files.files.filter((file) => !file.name.endsWith('.kicad_pro')))
    assert.deepEqual(
      file,
      native.files.find((original) => original.name === file.name),
    );
  core.undo();
  assert.deepEqual(core.getNativeFiles(), native);
  core.redo();
  assert.equal(modelCadFromProject(core.getSnapshot().project!)!.objects[0].color, colored.color);
  const copy = core.execute('modelCad.duplicate', {
    boardId,
    ids: [box.id],
    offset: { x: 5, y: 0, z: 0 },
  }) as { objects: ModelCadObject[] };
  assert.equal(copy.objects[0].color, colored.color);
  const reset: ModelCadObject = { ...colored };
  delete reset.color;
  core.execute('modelCad.update', { boardId, object: reset });
  assert.equal(modelCadFromProject(core.getSnapshot().project!)!.objects[0].color, undefined);
  assert.equal(modelCadFromProject(core.getSnapshot().project!)!.objects[1].color, colored.color);
  core.undo();
  assert.equal(modelCadFromProject(core.getSnapshot().project!)!.objects[0].color, colored.color);
});

test('explicit edge treatments address stable individual base edges', () => {
  const box = newModelCadObject(fixture().pcb!, 'box');
  const edges = modelCadSelectableEdges(box);
  assert.equal(edges.length, 12, 'A box has twelve analytic outer edges.');
  assert.deepEqual(
    edges.find((edge) => edge.id === 'side:0'),
    {
      id: 'side:0',
      label: 'Vertical edge 1',
      kind: 'line',
      start: { x: -10, y: -10, z: -5 },
      end: { x: -10, y: -10, z: 5 },
    },
  );
  for (const kind of ['fillet', 'chamfer'] as const) {
    const body = validateModelCadObject({
      ...box,
      edgeTreatment: { kind, distanceMm: 0.5, edges: ['side:0', 'profile:top:2'] },
    });
    assert.deepEqual(modelCadSelectableEdges(body), edges, 'Editing replaces the base treatment.');
    const copy = modelCadShape(body);
    (copy.edgeTreatment!.edges as string[]).push('side:1');
    assert.deepEqual(body.edgeTreatment!.edges, ['side:0', 'profile:top:2']);
    assert.notEqual(
      modelCadGeometryKey(body),
      modelCadGeometryKey({ ...body, edgeTreatment: { kind, distanceMm: 0.5, edges: ['side:1'] } }),
    );
  }
  for (const selected of [[], ['side:0', 'side:0'], ['side:4'], ['profile:top:01'], ['hole:top:1']])
    assert.throws(
      () =>
        validateModelCadObject({
          ...box,
          edgeTreatment: { kind: 'fillet', distanceMm: 0.5, edges: selected },
        }),
      /Invalid|unavailable/,
    );
  const cylinder = newModelCadObject(fixture().pcb!, 'cylinder');
  assert.deepEqual(
    modelCadSelectableEdges(cylinder).map((edge) => edge.id),
    ['profile:top:0', 'profile:bottom:0'],
  );
  const combined = newModelCadBooleanObject(box, cylinder, 'union');
  assert.deepEqual(modelCadSelectableEdges(combined), []);
  const selectedOperand = newModelCadBooleanObject(
    { ...box, edgeTreatment: { kind: 'fillet', distanceMm: 0.5, edges: ['side:0'] } },
    cylinder,
    'union',
  );
  assert.deepEqual(selectedOperand.boolean!.operands[0].shape.edgeTreatment!.edges, ['side:0']);
  assert.throws(
    () =>
      validateModelCadObject({
        ...combined,
        edgeTreatment: { kind: 'fillet', distanceMm: 0.5, edges: ['side:0'] },
      }),
    /unavailable/,
  );
});

test('CAD primitives use native world centres, bounded dimensions and explicit geometry rejection', () => {
  const board = fixture().pcb!;
  const box = newModelCadObject(board, 'box'),
    cylinder = newModelCadObject(board, 'cylinder');
  assert.deepEqual(box.position, { x: 100, y: 88, z: 5.8 });
  assert.deepEqual(box.size, { x: 20, y: 20, z: 10 });
  assert.deepEqual(cylinder.size, { x: 6, y: 6, z: 10 });
  assert.deepEqual(newModelCadObject({ ...board, graphics: [], footprints: [] }, 'box').position, {
    x: 0,
    y: 0,
    z: 5.8,
  });
  assert.ok(Number.isFinite(newModelCadObject({ ...board, graphics: [] }, 'cylinder').position.x));
  assert.throws(
    () => validateModelCadObject({ ...box, position: { ...box.position, z: NaN } }),
    /Invalid object/,
  );
  assert.throws(() => validateModelCadObject({ ...box, code: 'run' }), /Invalid object/);
  assert.throws(() => validateModelCadObject({ ...box, name: '  ' }), /name/);
  assert.throws(
    () => validateModelCadObject({ ...cylinder, size: { ...cylinder.size, y: 5 } }),
    /equal X and Y/,
  );

  assert.throws(
    () => validateModelCad({ version: 1, objects: Array(65).fill(box) }),
    /Invalid model/,
  );
  assert.throws(() => validateModelCad({ version: 1, objects: [box, { ...box }] }), /identities/);
});

test('Core primitive edits, duplication and removal retain electrical identity and whole-project undo', () => {
  const project = fixture(),
    core = new ProjectCore(project),
    boardId = project.pcb!.id;
  const before = core.getSnapshot(),
    initial = core.getNativeFiles();
  const box = newModelCadObject(project.pcb!, 'box');
  core.execute('modelCad.add', { boardId, object: box });
  const updated = {
    ...box,
    position: { ...box.position, x: 110 },
    rotation: { x: 90, y: 45, z: 30 },
  };
  core.execute('modelCad.update', { boardId, object: updated });
  updated.position.x = 115;
  assert.equal(modelCadFromProject(core.getSnapshot().project!)!.objects[0].position.x, 110);
  assert.equal(core.getSnapshot().project!.pcb, before.project!.pcb);
  assert.equal(core.getSnapshot().project!.schematic, before.project!.schematic);
  const current = modelCadFromProject(core.getSnapshot().project!)!.objects[0];
  core.execute('modelCad.update', { boardId, object: current });
  assert.equal(core.getSnapshot().undoDepth, 2, 'same values create no undo item');
  const duplicate = core.execute('modelCad.duplicate', {
    boardId,
    ids: [box.id],
    offset: { x: 5, y: 0, z: -1 },
  }) as { objects: ModelCadObject[] };
  assert.equal(duplicate.objects.length, 1);
  assert.notEqual(duplicate.objects[0].id, box.id);
  assert.deepEqual(duplicate.objects[0].position, { x: 115, y: 88, z: 4.8 });
  assert.deepEqual(duplicate.objects[0].rotation, current.rotation);
  for (const file of core.getNativeFiles().files.filter((f) => !f.name.endsWith('.kicad_pro')))
    assert.equal(file.source, initial.files.find((f) => f.name === file.name)!.source);
  core.execute('modelCad.remove', { boardId, ids: [box.id, duplicate.objects[0].id] });
  assert.equal(modelCadFromProject(core.getSnapshot().project!), null);
  assert.equal(core.getSnapshot().undoDepth, 4);
  core.undo();
  core.undo();
  core.undo();
  core.undo();
  assert.deepEqual(core.getNativeFiles(), initial);
  core.redo();
  core.execute('schematic.add');
  const secondary = core.query('schematic.get', {
    schematicId: core.getSnapshot().project!.additionalSchematics![0].id,
  });
  assert.equal(modelCadFromProject(parseProject(JSON.stringify(secondary))), null);
});

test('invalid CAD proposals fail atomically and cannot reuse project or electrical UUIDs', () => {
  const project = fixture(),
    core = new ProjectCore(project),
    boardId = project.pcb!.id;
  const box = newModelCadObject(project.pcb!, 'box');
  const before = core.getSnapshot();
  assert.throws(
    () => core.execute('modelCad.add', { boardId, object: { ...box, id: project.id } }),
    /duplicate UUID/,
  );
  assert.throws(
    () => core.execute('modelCad.add', { boardId, object: { ...box, id: project.schematic.id } }),
    /duplicate UUID/,
  );
  assert.equal(core.getSnapshot(), before);
  core.execute('modelCad.add', { boardId, object: box });
  assert.throws(() => core.execute('modelCad.add', { boardId, object: box }), /already exists/);
  assert.throws(
    () => core.execute('modelCad.update', { boardId, object: { ...box, id: uid() } }),
    /no longer/,
  );
  const valid = core.getSnapshot();
  assert.throws(
    () =>
      core.execute('modelCad.duplicate', {
        boardId,
        ids: [box.id],
        offset: { x: 100000, y: 0, z: 0 },
      }),
    /Invalid model/,
  );
  assert.throws(
    () => core.execute('modelCad.remove', { boardId, ids: [box.id, uid()] }),
    /no longer/,
  );
  assert.equal(core.getSnapshot(), valid);
  assert.throws(
    () =>
      validateProject({ ...project, pcb: null, extensions: { [MODEL_CAD_EXTENSION]: model(box) } }),
    /requires its PCB/,
  );
});

test('native primitive settings and Source changes preserve other CAD, provenance and unchanged bytes', () => {
  const project = fixture(),
    box = newModelCadObject(project.pcb!, 'box');
  project.extensions['example.test'] = { retained: true };
  const initial = projectNativeFiles(project),
    core = new ProjectCore(withModelCad(project, model(box)));
  const files = core.getNativeFiles(),
    loaded = projectFromNativeFiles(files);
  assert.deepEqual(modelCadFromProject(loaded), model(box));
  assert.deepEqual(projectNativeFiles(loaded), files);
  const pro = files.files.find((file) => file.name.endsWith('.kicad_pro'))!;
  const settings = JSON.parse(pro.source);
  const edit = {
    ...box,
    size: { x: 40, y: 20, z: 5 },
    material: 'pmma',
    opacity: 0.3,
    color: '#3366cc',
  };
  settings.text_variables[MODEL_CAD_NATIVE_VARIABLE] = JSON.stringify(
    model(edit as ModelCadObject),
  );
  core.updateNativeSource(pro.name, JSON.stringify(settings));
  assert.equal(modelCadFromProject(core.previewSource()!)!.objects[0].size.x, 40);
  assert.ok(core.applySource());
  assert.equal(modelCadFromProject(core.getSnapshot().project!)!.objects[0].material, 'pmma');
  assert.equal(modelCadFromProject(core.getSnapshot().project!)!.objects[0].color, '#3366cc');
  assert.deepEqual(core.getSnapshot().project!.extensions['example.test'], { retained: true });
  delete settings.text_variables[MODEL_CAD_NATIVE_VARIABLE];
  core.updateNativeSource(pro.name, JSON.stringify(settings));
  assert.ok(core.applySource());
  assert.equal(modelCadFromProject(core.getSnapshot().project!), null);
  for (const file of core.getNativeFiles().files.filter((f) => !f.name.endsWith('.kicad_pro')))
    assert.equal(file.source, initial.files.find((f) => f.name === file.name)!.source);
  core.undo();
  settings.text_variables[MODEL_CAD_NATIVE_VARIABLE] = '{';
  core.updateNativeSource(pro.name, JSON.stringify(settings));
  const before = core.getSnapshot().project;
  assert.equal(core.applySource(), null);
  assert.equal(core.getSnapshot().project, before);
  assert.match(core.getSnapshot().sourceError, /invalid JSON/);
  assert.ok(core.getSnapshot().sourceDraft);
});

test('copied projects remap CAD feature IDs and native backing settings together', () => {
  const project = fixture(),
    box = newModelCadObject(project.pcb!, 'box');
  const original = withModelCad(project, model(box));
  const copied = copyExampleSource(serializeProject(original));
  const body = modelCadFromProject(copied)!.objects[0];
  assert.notEqual(body.id, box.id);
  assert.deepEqual(body.position, box.position);
  const native = JSON.parse(
    projectNativeFiles(copied).files.find((f) => f.name.endsWith('.kicad_pro'))!.source,
  );
  assert.deepEqual(JSON.parse(native.text_variables[MODEL_CAD_NATIVE_VARIABLE]), model(body));
});

test('closed sketch profiles validate centred extents, and crossings', () => {
  const extrusion = newModelCadObject(fixture().pcb!, 'extrusion');
  assert.deepEqual(extrusion.profile, { kind: 'rectangle' });
  assert.ok(modelCadRequiresPreparation(extrusion));
  assert.equal(modelCadRequiresPreparation(newModelCadObject(fixture().pcb!, 'box')), false);
  const points = [
    { x: -10, y: -10 },
    { x: 10, y: -10 },
    { x: 10, y: 10 },
    { x: -10, y: 10 },
  ];
  const polygon = { ...extrusion, profile: { kind: 'polygon' as const, points } };
  assert.deepEqual(validateModelCadObject(polygon), polygon);
  assert.deepEqual(validateModelCadProfile({ kind: 'circle' }, { x: 20, y: 20 }), {
    kind: 'circle',
  });
  assert.throws(
    () => validateModelCadProfile({ kind: 'circle' }, { x: 20, y: 10 }),
    /equal X and Y/,
  );
  assert.throws(
    () =>
      validateModelCadProfile({ kind: 'polygon', points: [...points, points[0]] }, extrusion.size),
    /closing point/,
  );
  assert.throws(
    () =>
      validateModelCadProfile(
        { kind: 'polygon', points: [points[0], points[2], points[1], points[3]] },
        extrusion.size,
      ),
    /cross or touch/,
  );
  assert.throws(
    () =>
      validateModelCadProfile(
        { kind: 'polygon', points: points.map((p) => ({ ...p, x: p.x + 1 })) },
        extrusion.size,
      ),
    /centred/,
  );
  assert.throws(
    () => validateModelCadProfile({ kind: 'polygon', points }, { x: 19, y: 20 }),
    /match/,
  );
  const triangle = {
    ...polygon,
    profile: {
      kind: 'polygon' as const,
      points: [
        { x: -10, y: -10 },
        { x: 10, y: -10 },
        { x: 0, y: 10 },
      ],
    },
  };
  assert.ok(validateModelCadObject(triangle));
  const chamfer = {
    kind: 'chamfer' as const,
    distanceMm: 1,
    edges: ['profile:top:0', 'profile:bottom:0'],
  };
  assert.ok(validateModelCadObject({ ...polygon, edgeTreatment: chamfer }));
  assert.throws(
    () => validateModelCadObject({ ...polygon, edgeTreatment: { ...chamfer, distanceMm: 5 } }),
    /positive body height/,
  );

  assert.throws(
    () =>
      validateModelCadObject({
        ...newModelCadObject(fixture().pcb!, 'box'),
        profile: { kind: 'rectangle' },
      }),
    /Invalid shape/,
  );
});

test('geometry keys retain exact recipes and ignore only top-level identity and presentation', () => {
  const body = newModelCadObject(fixture().pcb!, 'extrusion');
  const key = modelCadGeometryKey(body),
    shape = modelCadShape(body);
  assert.equal(key, JSON.stringify(shape));
  assert.equal('id' in shape, false);
  assert.notEqual(modelCadGeometryKey({ ...body, size: { ...body.size, z: 11 } }), key);
  assert.notEqual(modelCadGeometryKey({ ...body, profile: { kind: 'circle' } }), key);
  assert.notEqual(
    modelCadGeometryKey({
      ...body,
      edgeTreatment: { kind: 'fillet', distanceMm: 1, edges: ['profile:top:0'] },
    }),
    key,
  );
  shape.size.x = 1;
  assert.equal(modelCadGeometryKey(body), key, 'public shape containers are independent');
  const tool = newModelCadObject(fixture().pcb!, 'cylinder'),
    combined = newModelCadBooleanObject(body, tool, 'difference');
  const movedOperand = structuredClone(combined);
  movedOperand.boolean!.operands[1].position.x += 1;
  assert.notEqual(modelCadGeometryKey(movedOperand), modelCadGeometryKey(combined));
});

test('Boolean recipes preserve transformed operands with bounded conservative envelopes', () => {
  const board = fixture().pcb!,
    target = { ...newModelCadObject(board, 'box'), position: { x: 0, y: 0, z: 0 } },
    tool = { ...newModelCadObject(board, 'box'), position: { x: 15, y: 0, z: 0 } };
  const union = newModelCadBooleanObject(target, tool, 'union');
  assert.deepEqual(union.size, { x: 35, y: 20, z: 10 });
  assert.deepEqual(union.position, { x: 7.5, y: 0, z: 0 });
  assert.deepEqual(
    union.boolean!.operands.map((operand) => operand.position.x),
    [-7.5, 7.5],
  );
  assert.deepEqual(newModelCadBooleanObject(target, tool, 'difference').size, target.size);
  const intersection = newModelCadBooleanObject(target, tool, 'intersection');
  assert.deepEqual(intersection.size, { x: 5, y: 20, z: 10 });
  assert.deepEqual(intersection.position, { x: 7.5, y: 0, z: 0 });
  assert.throws(() => newModelCadBooleanObject(target, target, 'union'), /different bodies/);
  assert.throws(
    () =>
      newModelCadBooleanObject(
        target,
        { ...tool, position: { x: 30, y: 0, z: 0 } },
        'intersection',
      ),
    /Invalid object|positive bounded/,
  );
  assert.throws(
    () => validateModelCadObject({ ...union, size: { ...union.size, x: 34 } }),
    /envelope/,
  );

  const rotated = modelCadOperandBounds({
    shape: { kind: 'box', size: { x: 2, y: 4, z: 6 } },
    position: { x: 10, y: 20, z: 30 },
    rotation: { x: 90, y: 0, z: 0 },
  });
  assert.deepEqual(rotated, { min: { x: 9, y: 17, z: 28 }, max: { x: 11, y: 23, z: 32 } });
  const invalidOperand = structuredClone(modelCadShape(union));
  Object.assign(invalidOperand.boolean!.operands[0].shape, { id: uid() });
  assert.throws(() => validateModelCadShape(invalidOperand), /Invalid shape/);
});

test('advanced geometry requires an exact owned host proof while pose and metadata edits reuse shape', () => {
  const project = fixture(),
    core = new ProjectCore(project),
    boardId = project.pcb!.id,
    body = newModelCadObject(project.pcb!, 'extrusion'),
    before = core.getSnapshot();
  assert.throws(
    () => core.execute('modelCad.add', { boardId, object: body }),
    /Prepare CAD geometry/,
  );
  assert.equal(core.getSnapshot(), before);
  assert.throws(() => core.acceptPreparedModelCadGeometry(body, 'wrong'), /does not match/);
  const prepared = structuredClone(body),
    key = modelCadGeometryKey(prepared);
  core.acceptPreparedModelCadGeometry(prepared, key);
  prepared.size.z = 11;
  assert.throws(
    () => core.execute('modelCad.add', { boardId, object: prepared }),
    /Prepare CAD geometry/,
  );
  assert.equal(core.pendingModelCadGeometry(withModelCad(project, model(body))).length, 0);
  core.execute('modelCad.add', { boardId, object: body });
  const afterAdd = core.getSnapshot();
  assert.equal(afterAdd.undoDepth, 1);
  core.execute('modelCad.update', {
    boardId,
    object: {
      ...body,
      name: 'Moved sketch',
      material: 'pmma',
      opacity: 0.3,
      position: { x: 11, y: 22, z: 33 },
      rotation: { x: 90, y: 0, z: 0 },
    },
  });
  core.execute('modelCad.duplicate', { boardId, ids: [body.id], offset: { x: 5, y: 0, z: 0 } });
  assert.equal(core.getSnapshot().undoDepth, 3);
  assert.equal(modelCadFromProject(core.getSnapshot().project!)!.objects.length, 2);
  const changed = { ...body, size: { ...body.size, z: 12 } };
  assert.throws(
    () => core.execute('modelCad.update', { boardId, object: changed }),
    /Prepare CAD geometry/,
  );
  const otherCore = new ProjectCore(project);
  assert.throws(
    () => otherCore.execute('modelCad.add', { boardId, object: body }),
    /Prepare CAD geometry/,
  );
  for (const file of core
    .getNativeFiles()
    .files.filter((file) => !file.name.endsWith('.kicad_pro')))
    assert.equal(
      file.source,
      projectNativeFiles(project).files.find((initial) => initial.name === file.name)!.source,
    );
});

test('Boolean command previews are independent, deterministic and commit one whole-project undo', () => {
  const project = fixture(),
    core = new ProjectCore(project),
    boardId = project.pcb!.id,
    target = newModelCadObject(project.pcb!, 'box'),
    tool = newModelCadObject(project.pcb!, 'cylinder');
  core.execute('modelCad.add', { boardId, object: target });
  core.execute('modelCad.add', { boardId, object: tool });
  const before = core.getSnapshot(),
    preview = core.previewModelCadCommand('modelCad.boolean', {
      boardId,
      targetId: target.id,
      toolId: tool.id,
      operation: 'difference',
    });
  assert.equal(core.getSnapshot(), before);
  assert.equal(typeof preview.input.resultId, 'string');
  const pending = core.pendingModelCadGeometry(preview.project);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, preview.input.resultId);
  pending[0].size.x = 40;
  assert.equal(core.pendingModelCadGeometry(preview.project)[0].size.x, 20);
  assert.throws(() => core.execute('modelCad.boolean', preview.input), /Prepare CAD geometry/);
  const result = core.pendingModelCadGeometry(preview.project)[0];
  core.acceptPreparedModelCadGeometry(result, modelCadGeometryKey(result));
  core.execute('modelCad.boolean', preview.input);
  assert.equal(core.getSnapshot().undoDepth, before.undoDepth + 1);
  assert.deepEqual(modelCadFromProject(core.getSnapshot().project!)!.objects, [result]);
  core.undo();
  assert.deepEqual(modelCadFromProject(core.getSnapshot().project!)!.objects, [target, tool]);
  core.redo();
  assert.deepEqual(modelCadFromProject(core.getSnapshot().project!)!.objects, [result]);
  core.undo();
  assert.throws(
    () =>
      core.previewModelCadCommand('modelCad.boolean', { ...preview.input, resultId: target.id }),
    /fresh object identity/,
  );
  core.updateSource('pending');
  assert.throws(
    () => core.previewModelCadCommand('modelCad.boolean', preview.input),
    /Apply the Source/,
  );
  core.discardSource();
  core.setEditingBlocked('Closing CAD project.');
  assert.throws(() => core.previewModelCadCommand('modelCad.boolean', preview.input), /Closing/);
  assert.throws(
    () => core.acceptPreparedModelCadGeometry(result, modelCadGeometryKey(result)),
    /Closing/,
  );
});

test('Source, whole-project replacement and materialization cannot bypass geometry preparation', () => {
  const project = fixture(),
    body = newModelCadObject(project.pcb!, 'extrusion'),
    admitted = withModelCad(project, model(body)),
    core = new ProjectCore(admitted),
    changed = { ...body, size: { ...body.size, z: 12 } },
    candidate = withModelCad(admitted, model(changed));
  assert.deepEqual(modelCadFromProject(projectFromNativeFiles(core.getNativeFiles())), model(body));
  assert.equal(core.pendingModelCadGeometry(admitted).length, 0, 'native admission is structural');
  assert.throws(
    () => core.execute('project.replace', { source: serializeProject(candidate) }),
    /Prepare CAD geometry/,
  );
  const basis = core.getSnapshot().project!;
  assert.throws(() => core.materialize(basis, candidate), /Prepare CAD geometry/);
  assert.equal(core.getSnapshot().project, basis);
  const native = core.getNativeFiles(),
    pro = native.files.find((file) => file.name.endsWith('.kicad_pro'))!,
    settings = JSON.parse(pro.source);
  settings.text_variables[MODEL_CAD_NATIVE_VARIABLE] = JSON.stringify(model(changed));
  core.updateNativeSource(pro.name, JSON.stringify(settings));
  assert.equal(core.applySource(), null);
  assert.equal(core.getSnapshot().project, basis);
  assert.ok(core.getSnapshot().sourceDraft);
  assert.match(core.getSnapshot().sourceError, /Prepare CAD geometry/);
  const pending = core.pendingModelCadGeometry(core.previewSource()!);
  core.acceptPreparedModelCadGeometry(pending[0], modelCadGeometryKey(pending[0]));
  assert.ok(core.applySource());
  assert.equal(core.getSnapshot().sourceDraft, null);
  assert.equal(core.getSnapshot().undoDepth, 1);
  core.undo();
  assert.deepEqual(modelCadFromProject(core.getSnapshot().project!), model(body));
  core.execute('project.replace', { source: serializeProject(candidate) });
  assert.deepEqual(modelCadFromProject(core.getSnapshot().project!), model(changed));
});

test('prepared geometry cache is bounded and cleared when a project is loaded', () => {
  const project = fixture(),
    core = new ProjectCore(project),
    body = newModelCadObject(project.pcb!, 'extrusion');
  for (let i = 0; i < 65; i++) {
    const prepared = { ...body, size: { ...body.size, z: 10 + i } };
    core.acceptPreparedModelCadGeometry(prepared, modelCadGeometryKey(prepared));
  }
  assert.equal(core.pendingModelCadGeometry(withModelCad(project, model(body))).length, 1);
  const latest = { ...body, size: { ...body.size, z: 74 } };
  assert.equal(core.pendingModelCadGeometry(withModelCad(project, model(latest))).length, 0);
  core.load(project);
  assert.equal(core.pendingModelCadGeometry(withModelCad(project, model(latest))).length, 1);
});

test('Model CAD capabilities enforce PCB, revision, pending Source and close barriers for both adapters', async () => {
  const project = fixture(),
    core = new ProjectCore(project),
    boardId = project.pcb!.id;
  const host = createCapabilityHost({ revision: () => String(core.getSnapshot().revision) });
  const dispose = registerProjectCapabilities(host, core),
    box = newModelCadObject(project.pcb!, 'box');
  assert.deepEqual(
    host
      .catalog()
      .filter((c) => c.id.startsWith('modelCad.'))
      .map((c) => [c.id, c.owner, c.level]),
    [
      ['modelCad.get', 'core', undefined],
      ['modelCad.sketch.extrude', 'core', 'operation'],
      ['modelCad.add', 'core', 'object'],
      ['modelCad.update', 'core', 'object'],
      ['modelCad.remove', 'core', 'object'],
      ['modelCad.duplicate', 'core', 'operation'],
      ['modelCad.boolean', 'core', 'operation'],
    ],
  );
  await assert.rejects(host.execute('modelCad.add', { boardId: uid(), object: box }), /PCB/);
  await assert.rejects(
    host.execute('modelCad.add', { boardId, object: box }, { expectedRevision: '8' }),
    /project changed/,
  );
  await host.execute(
    'modelCad.add',
    { boardId, object: box },
    { actor: 'human', expectedRevision: '0' },
  );
  core.updateSource('invalid pending source');
  await assert.rejects(
    host.execute('modelCad.remove', { boardId, ids: [box.id] }, { actor: 'agent' }),
    /Apply the Source/,
  );
  assert.ok(((await host.query('modelCad.get', { boardId })) as { modelCad: ModelCAD }).modelCad);
  core.discardSource();
  core.setEditingBlocked('Project is closing.');
  await assert.rejects(host.execute('modelCad.remove', { boardId, ids: [box.id] }), /closing/);
  core.setEditingBlocked(null);
  await host.execute('modelCad.remove', { boardId, ids: [box.id] }, { actor: 'agent' });
  assert.equal(
    ((await host.query('modelCad.get', { boardId })) as { modelCad: null }).modelCad,
    null,
  );
  dispose();
  host.dispose();
});

test('retired enclosure data and rim-group recipes are rejected without conversion', () => {
  const project = fixture();
  assert.throws(
    () => validateProject({ ...project, extensions: { 'org.openpe.enclosure': {} } }),
    /retired enclosure/,
  );
  const native = projectNativeFiles(project);
  const settings = native.files.find((file) => file.name.endsWith('.kicad_pro'))!;
  const input = JSON.parse(settings.source);
  input.text_variables = { ...input.text_variables, OPENPE_ENCLOSURE: '{}' };
  settings.source = JSON.stringify(input);
  assert.throws(() => projectFromNativeFiles(native), /retired enclosure/);
  const body = newModelCadObject(project.pcb!, 'box');
  for (const edges of ['top', 'bottom', 'both'])
    assert.throws(
      () =>
        validateModelCadObject({
          ...body,
          edgeTreatment: { kind: 'fillet', distanceMm: 0.5, edges },
        }),
      /Invalid object/,
    );
  const host = createCapabilityHost();
  const unregister = registerProjectCapabilities(host, new ProjectCore(project));
  try {
    for (const id of ['enclosure.get', 'enclosure.create', 'enclosure.update', 'enclosure.remove'])
      assert.equal(
        host.catalog().some((entry) => entry.id === id),
        false,
      );
  } finally {
    unregister();
    host.dispose();
  }
});
