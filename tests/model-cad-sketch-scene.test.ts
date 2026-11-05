import assert from 'node:assert/strict';
import test from 'node:test';
import {
  prepareModelCadSketchContour,
  prepareModelCadSketchCorners,
} from '../lib/model-cad-sketch';
import * as THREE from 'three';
import {
  createModelCadSketchScene,
  modelCadSketchFrame,
} from '../components/model-cad-sketch-scene';
import type { ModelCadSketch } from '../components/ModelCadSketchPanel';

const sketch: ModelCadSketch = {
  phase: 'sketch',
  contours: [],
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

test('sketch modification highlights the selected rounded contour and original indexed corners only while drawing', () => {
  const root = new THREE.Group(),
    scene = createModelCadSketchScene(root, 100);
  const contour = prepareModelCadSketchCorners(
    prepareModelCadSketchContour('rectangle', [
      { x: 0, y: 0 },
      { x: 20, y: 16 },
    ]),
    { kind: 'fillet', distanceMm: 2, corners: [0, 1, 2, 3] },
  );
  const selected = { ...sketch, points: [], contours: [contour], selectedContour: 0 };
  try {
    scene.update(selected, false);
    const highlights = root.children.filter((node) => node.userData.modelCadSketchSelection);
    assert.equal(highlights.length, 2);
    const line = highlights.find((node) => node instanceof THREE.Line) as THREE.Line;
    assert.ok(line.geometry.getAttribute('position').count > 40);
    assert.deepEqual(new THREE.Raycaster().intersectObjects(highlights, true), []);
    scene.update({ ...selected, phase: 'profile' }, true);
    assert.equal(
      root.children.some((node) => node.userData.modelCadSketchSelection),
      false,
    );
  } finally {
    scene.dispose();
  }
});

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
      scene.update(
        {
          ...sketch,
          phase,
          closed: true,
          contours: [prepareModelCadSketchContour(sketch.shape, sketch.points)],
        },
        true,
      );
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

test('plane setup shows an exact translucent surface and releases each replaced preview', () => {
  const root = new THREE.Group();
  const scene = createModelCadSketchScene(root, 100);
  let disposals = 0;
  try {
    for (const plane of ['XY', 'XZ', 'YZ'] as const) {
      const origin = { x: 45.5, y: 212, z: -7.25 };
      scene.update({ ...sketch, phase: 'plane', plane, origin, points: [], cursor: null }, false);
      const surface = root.children.find((node) => node instanceof THREE.Mesh) as THREE.Mesh;
      assert.ok(surface?.userData.modelCadSketchPlane);
      surface.geometry.addEventListener('dispose', () => disposals++);
      const material = surface.material as THREE.MeshBasicMaterial;
      assert.equal(material.transparent, true);
      assert.equal(material.side, THREE.DoubleSide);
      assert.equal(material.depthWrite, false);
      root.updateMatrixWorld(true);
      const center = surface.localToWorld(new THREE.Vector3());
      assert.deepEqual(center.toArray(), [45.5, -212, -7.25]);
      const frame = modelCadSketchFrame(plane, origin);
      const raycaster = new THREE.Raycaster(
        center.clone().add(frame.normal),
        frame.normal.clone().negate(),
      );
      assert.deepEqual(raycaster.intersectObject(root, true), []);
      const corner = surface.localToWorld(new THREE.Vector3(60, 60, 0));
      assert.ok(corner.sub(center).dot(frame.normal) === 0);
    }
    scene.update(null, false);
    assert.equal(root.children.length, 0);
    assert.equal(disposals, 3);
  } finally {
    scene.dispose();
  }
});

test('remote planes stay inside their finite clipping range independently of the drawing grid', () => {
  const root = new THREE.Group();
  const scene = createModelCadSketchScene(root, 100);
  const camera = new THREE.OrthographicCamera(-40, 40, 30, -30, 0.1, 100);
  camera.position.set(12, 88, 4);
  camera.up.set(0, 0, 1);
  camera.lookAt(12, -212, 4);
  camera.updateMatrixWorld(true);
  const remote = { ...sketch, phase: 'plane' as const, origin: { x: 12, y: 212, z: 4 } };
  try {
    scene.update(remote, false);
    const clipping = scene.clippingRange(camera)!;
    assert.ok(clipping.near < 300 && clipping.far > 300);
    scene.update(remote, false, { visible: false, spacing: 10 });
    assert.deepEqual(scene.clippingRange(camera), clipping);
    scene.update({ ...remote, phase: 'sketch' }, false);
    assert.deepEqual(scene.clippingRange(camera), clipping);
    scene.update({ ...remote, phase: 'profile' }, false);
    assert.equal(scene.clippingRange(camera), null);
    scene.update(null, false);
    assert.equal(scene.clippingRange(camera), null);
  } finally {
    scene.dispose();
  }
});
