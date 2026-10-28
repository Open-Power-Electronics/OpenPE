import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  createModelCadSketchScene,
  modelCadSketchFrame,
} from '../components/model-cad-sketch-scene';
import type { ModelCadSketch } from '../components/ModelCadSketchPanel';

const sketch: ModelCadSketch = {
  phase: 'sketch',
  plane: 'XZ',
  origin: { x: 12, y: 18, z: 4 },
  shape: 'polygon',
  points: [
    { x: 0, y: 0 },
    { x: 8, y: 0 },
    { x: 8, y: 6 },
  ],
  cursor: { x: 4, y: 9 },
  closed: false,
};

test('sketch workplanes use the exact native origin and reflected native Y', () => {
  for (const [plane, u, v, normal] of [
    ['XY', [1, 0, 0], [0, -1, 0], [0, 0, 1]],
    ['XZ', [1, 0, 0], [0, 0, 1], [0, 1, 0]],
    ['YZ', [0, -1, 0], [0, 0, 1], [1, 0, 0]],
  ] as const) {
    const frame = modelCadSketchFrame(plane, sketch.origin);
    assert.deepEqual(frame.center.toArray(), [12, -18, 4]);
    assert.deepEqual(frame.u.toArray(), u);
    assert.deepEqual(frame.v.toArray(), v);
    assert.deepEqual(frame.normal.toArray(), normal);
  }
});

test('only drawing shows a dense grid, vertices and cursor; plane setup retains its boundary', () => {
  const root = new THREE.Group();
  const scene = createModelCadSketchScene(root, 100);
  const outline = () =>
    root.children.find(
      (object): object is THREE.Line =>
        object instanceof THREE.Line && Boolean(object.userData.modelCadSketch),
    );
  const positions = () => Array.from(outline()!.geometry.getAttribute('position').array);
  const grid = () => {
    let result: THREE.LineSegments | undefined;
    root.traverse((object) => {
      if (object instanceof THREE.LineSegments && object.userData.modelCadSketchGrid)
        result = object;
    });
    return result;
  };
  const camera = new THREE.OrthographicCamera(-40, 40, 30, -30, 0.1, 1000);
  camera.position.set(12, 82, 4);
  camera.up.set(0, 0, 1);
  camera.lookAt(12, -18, 4);
  camera.updateMatrixWorld(true);
  const updateGrid = () => scene.updateGrid({ camera, width: 800, height: 600 });
  try {
    scene.update({ ...sketch, phase: 'plane', points: [], cursor: null }, false);
    updateGrid();
    assert.equal(grid(), undefined);
    assert.ok(root.children.some((object) => object.userData.modelCadSketchPlane));
    assert.equal(
      root.children.some((object) => object instanceof THREE.Points),
      false,
    );
    assert.equal(outline(), undefined);

    scene.update(sketch, false);
    updateGrid();
    assert.equal(grid()?.visible, true);
    assert.ok(root.children.some((object) => object instanceof THREE.Points));
    assert.deepEqual(positions().slice(-3), [16, -18, 13]);

    const contour = positions();
    scene.update(sketch, false, { visible: false, spacing: 2 });
    updateGrid();
    assert.equal(grid()?.visible, false);
    assert.deepEqual(positions(), contour);
    assert.ok(root.children.some((object) => object.userData.modelCadSketchPlane));

    for (const phase of ['profile', 'extrude'] as const) {
      scene.update({ ...sketch, phase, closed: true }, true);
      updateGrid();
      assert.equal(grid(), undefined);
      assert.equal(root.children.length, 1);
      assert.deepEqual(positions(), [12, -18, 4, 20, -18, 4, 20, -18, 10, 12, -18, 4]);
      assert.equal(
        root.children.some((object) => object instanceof THREE.Points),
        false,
      );
    }
    scene.update(null, false);
    assert.equal(root.children.length, 0);
  } finally {
    scene.dispose();
  }
});
