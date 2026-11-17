import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createModelGroundScene } from '../components/model-ground-scene';
import { modelScaleLength, modelScaleRadius } from '../components/model-scale';
import { modelScaleAxes } from '../components/ModelSpatialScale';
const display = { gridVisible: true };
const position = (object: THREE.Object3D) => object.getWorldPosition(new THREE.Vector3()).toArray();

test('the ground follows the PCB underside, rejects picks and retains geometry across display changes', () => {
  const root = new THREE.Group();
  const scene = createModelGroundScene(root);
  const options = {
    ...display,
    bounds: new THREE.Box3(new THREE.Vector3(-20, -30, -2), new THREE.Vector3(40, 30, 10)),
    boardThickness: 1.6,
    boardCenter: { x: 10, y: 20 },
    spacing: 1,
    unitsPerPixel: 0.1,
    dark: false,
    visible: true,
  };
  try {
    scene.update(options);
    const surface = root.children[0] as THREE.Mesh;
    assert.deepEqual(position(surface), [10, -20, -1.6 / 2 - 0.05]);
    const xAxis = root.children[3] as THREE.Mesh;
    const yAxis = root.children[4] as THREE.Mesh;
    assert.deepEqual(position(xAxis), position(surface));
    assert.deepEqual(position(yAxis), position(surface));
    assert.equal(xAxis.scale.y, options.unitsPerPixel * 4);
    assert.equal(yAxis.scale.x, options.unitsPerPixel * 4);
    assert.equal(root.children.length, 5, 'The floor contains no letter annotations.');
    const lines = root.children[1] as THREE.LineSegments;
    const geometry = lines.geometry;
    scene.update({ ...options, dark: true });
    assert.equal(lines.geometry, geometry);
    scene.update({
      ...options,
      bounds: new THREE.Box3(new THREE.Vector3(-20, -30, -50), new THREE.Vector3(40, 30, 100)),
    });
    assert.equal(position(surface)[2], -options.boardThickness / 2 - 0.05);
    assert.equal(lines.geometry, geometry, 'Bodies below the PCB do not move the ground.');
    scene.update({ ...options, visible: false });
    assert.equal(root.visible, false);
    scene.update(options);
    assert.equal(lines.geometry, geometry);
    root.updateMatrixWorld(true);
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 100), new THREE.Vector3(0, 0, -1));
    assert.deepEqual(ray.intersectObject(root, true), []);
    let disposals = 0;
    geometry.addEventListener('dispose', () => disposals++);
    scene.update({ ...options, boardThickness: 3.2 });
    assert.equal(position(surface)[2], -3.2 / 2 - 0.05);
    assert.equal(disposals, 0, 'PCB thickness moves the plane without replacing its geometry.');
    scene.update({ ...options, spacing: 2 });
    assert.equal(disposals, 1, 'Grid density changes replace only the line geometry.');
    scene.dispose();
    scene.dispose();
    assert.equal(disposals, 1);
    assert.equal(root.children.length, 0);
  } finally {
    scene.dispose();
  }
});

test('empty assemblies and extreme zoom retain finite bounded ground geometry', () => {
  const root = new THREE.Group();
  const scene = createModelGroundScene(root);
  try {
    for (const bounds of [
      new THREE.Box3(),
      new THREE.Box3(new THREE.Vector3(-1e6, -1e6, -100), new THREE.Vector3(1e6, 1e6, 100)),
    ]) {
      for (const unitsPerPixel of [0.00001, 0.1, 100000]) {
        scene.update({
          ...display,
          bounds,
          boardThickness: 1.6,
          boardCenter: { x: 0, y: 0 },
          unitsPerPixel,
          spacing: 0.5,
          dark: false,
          visible: true,
        });
        let vertices = 0;
        for (const node of root.children.slice(1, 3) as THREE.LineSegments[]) {
          const positions = node.geometry.getAttribute('position');
          vertices += positions.count;
          assert.ok(Array.from(positions.array).every(Number.isFinite));
        }
        assert.ok(vertices > 0 && vertices < 1100);
      }
    }
  } finally {
    scene.dispose();
  }
});

test('zoom and grid changes retain exact symmetric floor edges and the PCB-centered colored axes', () => {
  const root = new THREE.Group();
  const scene = createModelGroundScene(root);
  const bounds = new THREE.Box3(
    new THREE.Vector3(95.25, -144.5, 0),
    new THREE.Vector3(164.75, -100.5, 0),
  );
  const boardCenter = { x: 130, y: 122.5 };
  try {
    let frame: number[] | undefined;
    for (const unitsPerPixel of [0.00001, 0.1, 1, 10, 10000]) {
      for (const spacing of [0.5, 1, 5, 10]) {
        scene.update({
          ...display,
          bounds,
          boardCenter,
          boardThickness: 1.6,
          unitsPerPixel,
          spacing,
          dark: false,
          visible: true,
        });
        const surface = root.children[0] as THREE.Mesh;
        const current = [...position(surface), ...surface.scale.toArray()];
        frame ??= current;
        assert.deepEqual(
          current,
          frame,
          'Zoom and grid density cannot move or resize the world-space floor.',
        );
        for (const axis of root.children.slice(3) as THREE.Mesh[]) {
          assert.deepEqual(position(axis), position(surface));
          assert.ok(
            axis.material instanceof THREE.MeshBasicMaterial,
            'Colored strips have real WebGL width.',
          );
        }
      }
    }
  } finally {
    scene.dispose();
  }
});

test('the fixed XY reference retains resources through independent plane and grid visibility', () => {
  const root = new THREE.Group();
  const scene = createModelGroundScene(root);
  const bounds = new THREE.Box3(new THREE.Vector3(100, -140, 0), new THREE.Vector3(160, -100, 0));
  const options = {
    ...display,
    bounds,
    boardCenter: { x: 130, y: 120 },
    boardThickness: 1.6,
    spacing: 5,
    unitsPerPixel: 0.5,
    dark: false,
    visible: true,
  };
  try {
    scene.update(options);
    root.updateMatrixWorld(true);
    const lines = root.children[1] as THREE.LineSegments;
    const geometry = lines.geometry;
    const points = geometry.getAttribute('position');
    for (let index = 0; index < points.count; index++) {
      const point = root.localToWorld(new THREE.Vector3().fromBufferAttribute(points, index));
      assert.equal(point.z, -1.6 / 2 - 0.05);
    }
    assert.deepEqual(position(root.children[0]), [130, -120, -1.6 / 2 - 0.05]);
    for (const name of ['x', 'y']) assert.ok(root.getObjectByName(`model-ground-axis-${name}`));
    scene.update({ ...options, gridVisible: false });
    assert.equal(root.visible, true);
    assert.equal(root.children[0].visible, true);
    assert.ok(root.children.slice(1, 3).every((line) => !line.visible));
    assert.ok(root.children.slice(3).every((axis) => axis.visible));
    scene.update({ ...options, visible: false });
    assert.equal(root.visible, false);
    scene.update(options);
    assert.equal(root.visible, true);
    assert.ok(root.children.slice(1, 3).every((line) => line.visible));
    assert.equal(lines.geometry, geometry, 'Visibility changes retain grid geometry.');
  } finally {
    scene.dispose();
  }
});

test('compact Model engineering references stay bounded at extreme zoom levels', () => {
  for (const spacing of [1e-9, 0.00001, 0.001, 0.1, 1, 10, 10000, 1e9]) {
    const length = modelScaleLength(spacing);
    assert.ok(length > 0 && Number.isFinite(length));
    assert.ok(length / spacing <= modelScaleRadius + 1e-9);
    assert.ok(length / spacing >= 28 - 1e-9, 'Zoomed-out axes retain readable arm lengths.');
  }
});

test('3D ruler follows the camera and uses native reflected Y for either projection', () => {
  for (const camera of [new THREE.PerspectiveCamera(), new THREE.OrthographicCamera()]) {
    camera.up.set(0, 1, 0);
    camera.position.set(0, 0, 100);
    camera.lookAt(0, 0, 0);
    assert.deepEqual(modelScaleAxes(camera), [
      { x: 1, y: -0 },
      { x: 0, y: 1 },
      { x: 0, y: -0 },
    ]);
    camera.up.set(0, 0, 1);
    camera.position.set(100, -100, 100);
    camera.lookAt(0, 0, 0);
    const axes = modelScaleAxes(camera);
    assert.ok(axes.every((axis) => Math.hypot(axis.x, axis.y) > 0.5));
    assert.ok(axes[2].y < -0.5);
  }
});
