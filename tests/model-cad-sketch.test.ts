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
  prepareModelCadSketchCorners,
  modelCadSketchContourOutline,
  pickModelCadSketchContour,
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
  input.contours[0] = prepareModelCadSketchCorners(input.contours[0], {
    kind: 'fillet',
    distanceMm: 2,
    corners: [0, 1, 2, 3],
  });
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

test('sketch fillets/chamfers retain analytic selected-corner recipes and preview tangent geometry', () => {
  const contour = sketch().contours[0];
  const before = structuredClone(contour);
  const rounded = prepareModelCadSketchCorners(contour, {
    kind: 'fillet',
    distanceMm: 2,
    corners: [0, 1, 2, 3],
  });
  const outline = modelCadSketchContourOutline(rounded);
  assert.ok(outline.length > 40);
  const near = (point: { x: number; y: number }, x: number, y: number) =>
    Math.hypot(point.x - x, point.y - y) < 1e-6;
  assert.ok(outline.some((point) => near(point, -10, -6)));
  assert.ok(outline.some((point) => near(point, -8, -8)));
  assert.ok(!outline.some((point) => near(point, -10, -8)));
  const arcCenter = { x: -8, y: -6 };
  for (const point of outline.filter((point) => point.x <= -8 && point.y <= -6))
    assert.ok(Math.abs(Math.hypot(point.x - arcCenter.x, point.y - arcCenter.y) - 2) < 1e-6);
  const chamfered = prepareModelCadSketchCorners(contour, {
    kind: 'chamfer',
    distanceMm: 2,
    corners: [0],
  });
  assert.deepEqual(modelCadSketchContourOutline(chamfered), [
    { x: -10, y: -6 },
    { x: -8, y: -8 },
    { x: 10, y: -8 },
    { x: 10, y: 8 },
    { x: -10, y: 8 },
  ]);
  const input = { ...sketch(), contours: [rounded] };
  const body = extrudeModelCadSketch(input);
  assert.deepEqual(body.profile, { kind: 'rectangle' });
  assert.deepEqual(body.edgeTreatment, {
    kind: 'fillet',
    distanceMm: 2,
    edges: ['side:0', 'side:1', 'side:2', 'side:3'],
  });
  assert.deepEqual(prepareModelCadSketchCorners(chamfered, null), contour);
  assert.deepEqual(contour, before);
  rounded.cornerTreatment!.corners[0] = 3;
  assert.equal(body.edgeTreatment!.edges[0], 'side:0');
});

test('polygon corner treatments support both windings and reject missing, reflex, collinear and overlapping corners', () => {
  const points = [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 20 },
    { x: 0, y: 20 },
  ];
  for (const vertices of [points, [...points].reverse()]) {
    const contour = prepareModelCadSketchContour('polygon', vertices);
    const rounded = prepareModelCadSketchCorners(contour, {
      kind: 'fillet',
      distanceMm: 2,
      corners: [0, 1, 2, 3],
    });
    const outline = modelCadSketchContourOutline(rounded);
    assert.ok(
      outline.every(
        (point) =>
          point.x >= -1e-6 && point.x <= 20 + 1e-6 && point.y >= -1e-6 && point.y <= 20 + 1e-6,
      ),
    );
    const area =
      outline.reduce((sum, point, index) => {
        const next = outline[(index + 1) % outline.length];
        return sum + point.x * next.y - point.y * next.x;
      }, 0) / 2;
    assert.ok(Math.abs(Math.abs(area) - (400 - 4 * (4 - Math.PI))) < 0.2);
  }
  const contour = sketch().contours[0];
  for (const treatment of [
    { kind: 'fillet', distanceMm: 0, corners: [0] },
    { kind: 'fillet', distanceMm: NaN, corners: [0] },
    { kind: 'fillet', distanceMm: 8, corners: [0] },
    { kind: 'fillet', distanceMm: 1, corners: [4] },
    { kind: 'fillet', distanceMm: 1, corners: [0, 0] },
    { kind: 'fillet', distanceMm: 1, corners: [] },
    { kind: 'fillet', distanceMm: 1, corners: [0.5] },
    { kind: 'unsupported', distanceMm: 1, corners: [0] },
    { kind: 'fillet', distanceMm: 1, corners: [0], extra: true },
  ])
    assert.throws(() =>
      extrudeModelCadSketch({
        ...sketch(),
        contours: [{ ...contour, cornerTreatment: treatment }],
      }),
    );
  assert.throws(
    () =>
      prepareModelCadSketchCorners(sketch().contours[1], {
        kind: 'fillet',
        distanceMm: 1,
        corners: [0],
      }),
    /Circles/,
  );
  const concave = prepareModelCadSketchContour('polygon', [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 10, y: 10 },
    { x: 20, y: 20 },
    { x: 0, y: 20 },
  ]);
  assert.throws(
    () => prepareModelCadSketchCorners(concave, { kind: 'fillet', distanceMm: 1, corners: [2] }),
    /convex/,
  );
  const shortEdge = prepareModelCadSketchContour('polygon', [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 20 },
    { x: 19.5, y: 20 },
    { x: 0, y: 10 },
  ]);
  assert.throws(
    () =>
      prepareModelCadSketchCorners(shortEdge, { kind: 'fillet', distanceMm: 1, corners: [2, 3] }),
    /overlap/,
  );
});

test('sketch operation picking prioritizes indexed corners and nearest outlines before nested interiors', () => {
  const outer = prepareModelCadSketchCorners(sketch().contours[0], {
    kind: 'fillet',
    distanceMm: 2,
    corners: [0, 1, 2, 3],
  });
  const cut = sketch().contours[1];
  assert.deepEqual(pickModelCadSketchContour([outer, cut], { x: -9.9, y: -8 }, 0.2), {
    contour: 0,
    corner: 0,
  });
  assert.deepEqual(pickModelCadSketchContour([outer, cut], { x: -9.99, y: 0 }, 0.2), {
    contour: 0,
  });
  assert.deepEqual(pickModelCadSketchContour([outer, cut], { x: 2, y: 1 }, 0.2), { contour: 1 });
  assert.deepEqual(pickModelCadSketchContour([outer, cut], { x: 7, y: 0 }, 0.2), { contour: 0 });
  assert.equal(pickModelCadSketchContour([outer, cut], { x: 99, y: 99 }, 0.2), null);
  assert.equal(pickModelCadSketchContour([outer], { x: NaN, y: 0 }, 1), null);
  assert.equal(pickModelCadSketchContour([outer], { x: 0, y: 0 }, -1), null);
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
