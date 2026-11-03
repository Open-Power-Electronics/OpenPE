import test from 'node:test';
import assert from 'node:assert/strict';
import { createCapabilityHost } from '../api/capabilities';
import { ProjectCore } from '../core/project-core';
import { registerProjectCapabilities } from '../core/register-project';
import { emptyCircuit, uid } from '../lib/circuit';
import { createEmptyPCB } from '../lib/pcb-layout';
import { createProject, projectFromNativeFiles } from '../lib/project';
import { modelCadFromProject, modelCadGeometryKey, validateModelCadObject } from '../lib/model-cad';
import {
  extrudeModelCadSketch,
  modelCadSketchOutlines,
  prepareModelCadSketchContour,
  type ModelCadSketchExtrusion,
} from '../lib/model-cad-sketch';

const sketch = (): ModelCadSketchExtrusion => ({
  id: uid(),
  name: 'Mounting plate',
  plane: 'XY',
  origin: { x: 30, y: 20, z: 5 },
  distance: 8,
  direction: 'positive',
  material: 'aluminium',
  opacity: 1,
  contours: [
    prepareModelCadSketchContour('rectangle', [
      { x: -10, y: -8 },
      { x: 10, y: 8 },
    ]),
    prepareModelCadSketchContour(
      'circle',
      [
        { x: 2, y: 1 },
        { x: 4, y: 1 },
      ],
      'difference',
    ),
  ],
});
const project = () => {
  const value = createProject(emptyCircuit());
  value.pcb = createEmptyPCB();
  return value;
};

test('planar Difference extrudes exact analytic operands, retains pose and never creates a local-hole field', () => {
  const input = sketch(),
    before = structuredClone(input);
  const body = extrudeModelCadSketch(input);
  assert.equal(body.id, input.id);
  assert.equal(body.kind, 'boolean');
  assert.equal(body.boolean!.operation, 'difference');
  assert.deepEqual(body.size, { x: 20, y: 16, z: 8 });
  assert.deepEqual(body.position, { x: 30, y: 20, z: 9 });
  const [outer, cut] = body.boolean!.operands;
  assert.deepEqual(outer.shape.profile, { kind: 'rectangle' });
  assert.deepEqual(cut.shape.profile, { kind: 'circle' });
  assert.deepEqual(cut.shape.size, { x: 4, y: 4, z: 8 });
  assert.deepEqual(cut.position, { x: 2, y: 1, z: 0 });
  assert.doesNotMatch(JSON.stringify(body), /holes|diameterMm/);
  assert.deepEqual(input, before);
  input.contours[1].position.x = 7;
  assert.equal(cut.position.x, 2, 'Accepted recipes own their independent input containers.');
});

test('sketch outlines preview inner contours, ordered Union and Intersection without replacing analytic geometry', () => {
  const input = sketch();
  const outlines = modelCadSketchOutlines(input.contours);
  assert.equal(outlines.length, 2);
  assert.ok(outlines.some((points) => points.length === 128));
  const square = prepareModelCadSketchContour(
    'rectangle',
    [
      { x: 5, y: -4 },
      { x: 15, y: 4 },
    ],
    'union',
  );
  const joined = extrudeModelCadSketch({ ...input, contours: [input.contours[0], square] });
  assert.deepEqual(joined.size, { x: 25, y: 16, z: 8 });
  assert.deepEqual(joined.position, { x: 32.5, y: 20, z: 9 });
  const overlap = extrudeModelCadSketch({
    ...input,
    contours: [input.contours[0], { ...square, operation: 'intersection' }],
  });
  assert.deepEqual(overlap.size, { x: 5, y: 8, z: 8 });
  assert.deepEqual(overlap.position, { x: 37.5, y: 20, z: 9 });
  assert.equal(
    modelCadSketchOutlines([input.contours[0], { ...input.contours[0], operation: 'difference' }])
      .length,
    0,
  );
});

test('contour extrusion maps local XY and common depth consistently across all three workplanes and directions', () => {
  for (const plane of ['XY', 'XZ', 'YZ'] as const)
    for (const direction of ['positive', 'negative', 'symmetric'] as const) {
      const input = { ...sketch(), plane, direction };
      const offset = direction === 'symmetric' ? 0 : direction === 'positive' ? 4 : -4;
      const body = extrudeModelCadSketch(input);
      assert.deepEqual(body.position, {
        x: 30 + (plane === 'YZ' ? offset : 0),
        y: 20 - (plane === 'XZ' ? offset : 0),
        z: 5 + (plane === 'XY' ? offset : 0),
      });
      assert.deepEqual(
        body.rotation,
        plane === 'XY'
          ? { x: 0, y: 0, z: 0 }
          : plane === 'XZ'
            ? { x: 90, y: 0, z: 0 }
            : { x: 90, y: 90, z: 0 },
      );
      assert.deepEqual(body.boolean!.operands[1].position, { x: 2, y: 1, z: 0 });
    }
});

test('sketch extrusion rejects unsupported fields, open/degenerate/crossing contours and aggregate limits', () => {
  const input = sketch();
  for (const invalid of [
    { ...input, holes: [] },
    { ...input, distance: NaN },
    { ...input, distance: 0 },
    { ...input, plane: 'free' },
    { ...input, contours: [] },
    { ...input, contours: Array.from({ length: 7 }, () => input.contours[0]) },
    { ...input, contours: [{ ...input.contours[0], operation: 'difference' }] },
    { ...input, contours: [{ ...input.contours[0], profile: { kind: 'rectangle', holes: [] } }] },
  ])
    assert.throws(() => extrudeModelCadSketch(invalid));
  assert.throws(() =>
    prepareModelCadSketchContour('rectangle', [
      { x: 0, y: 0 },
      { x: 0, y: 8 },
    ]),
  );
  assert.throws(() =>
    prepareModelCadSketchContour('circle', [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ]),
  );
  assert.throws(() =>
    prepareModelCadSketchContour('polygon', [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 10, y: 0 },
    ]),
  );
  const body = extrudeModelCadSketch(input);
  assert.throws(() => validateModelCadObject({ ...body, holes: [] }), /Invalid object/);
  assert.throws(
    () =>
      validateModelCadObject({
        ...body,
        boolean: {
          ...body.boolean,
          operands: body.boolean!.operands.map((operand) => ({
            ...operand,
            shape: { ...operand.shape, holes: [] },
          })),
        },
      }),
    /Invalid object|Invalid shape/,
  );
});

test('human and Agent sketch extrusion share exact preparation, native files, one undo edit and lifecycle gates', async () => {
  const input = sketch(),
    initial = project();
  const executions = [];
  for (const actor of ['human', 'agent'] as const) {
    const core = new ProjectCore(initial),
      host = createCapabilityHost();
    let preparations = 0;
    const unregister = registerProjectCapabilities(host, core, {
      prepareModelCad: async (objects, signal) => {
        signal.throwIfAborted();
        assert.deepEqual(objects, [extrudeModelCadSketch(input)]);
        preparations++;
        core.acceptPreparedModelCadGeometry(objects[0], modelCadGeometryKey(objects[0]));
      },
    });
    try {
      const before = core.getNativeFiles(),
        basis = core.getSnapshot();
      assert.throws(
        () => core.execute('modelCad.sketch.extrude', { boardId: initial.pcb!.id, sketch: input }),
        /Prepare CAD/,
      );
      const result = await host.execute(
        'modelCad.sketch.extrude',
        { boardId: initial.pcb!.id, sketch: input },
        { actor, expectedRevision: String(basis.revision) },
      );
      assert.equal(preparations, 1);
      assert.equal(core.getSnapshot().undoDepth, basis.undoDepth + 1);
      const native = core.getNativeFiles();
      assert.deepEqual(modelCadFromProject(projectFromNativeFiles(native))!.objects, [
        extrudeModelCadSketch(input),
      ]);
      for (const file of native.files.filter((file) => !file.name.endsWith('.kicad_pro')))
        assert.deepEqual(
          file,
          before.files.find((original) => original.name === file.name),
        );
      executions.push({ native, result });
      core.undo();
      assert.deepEqual(core.getNativeFiles(), before);
      core.redo();
      assert.deepEqual(core.getNativeFiles(), native);
      await assert.rejects(
        host.execute(
          'modelCad.sketch.extrude',
          { boardId: initial.pcb!.id, sketch: { ...input, id: uid() } },
          { actor, expectedRevision: String(basis.revision) },
        ),
        /project changed/i,
      );
      core.updateSource(core.getSnapshot().source + ' ');
      await assert.rejects(
        host.execute(
          'modelCad.sketch.extrude',
          { boardId: initial.pcb!.id, sketch: input },
          { actor },
        ),
        /Source/,
      );
      core.updateSource(null);
      core.setEditingBlocked('Closing project.');
      await assert.rejects(
        host.execute(
          'modelCad.sketch.extrude',
          { boardId: initial.pcb!.id, sketch: input },
          { actor },
        ),
        /Closing project/,
      );
    } finally {
      unregister();
      host.dispose();
    }
  }
  assert.deepEqual(executions[0], executions[1]);
});

test('native admission rejects retired local-hole parameters without changing the supplied files', () => {
  const core = new ProjectCore(project());
  const files = core.getNativeFiles();
  const settings = files.files.find((file) => file.name.endsWith('.kicad_pro'))!;
  const parsed = JSON.parse(settings.source);
  (parsed.text_variables ??= {}).OPENPE_MODEL_CAD = JSON.stringify({
    version: 1,
    objects: [{ ...extrudeModelCadSketch(sketch()), holes: [] }],
  });
  settings.source = JSON.stringify(parsed, null, 2) + '\n';
  const before = structuredClone(files);
  assert.throws(() => projectFromNativeFiles(files), /Invalid model|additional properties/);
  assert.deepEqual(files, before);
});
