import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { modelMeasurementPoint } from '../lib/model-measurement';

test('Model measurements use displayed world surfaces reflected into native XYZ axes', () => {
  const geometry = new THREE.BoxGeometry(2, 2, 2);
  const material = new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(5, -7, 2);
  mesh.userData.footprintId = 'component';
  mesh.userData.estimated = true;
  mesh.updateMatrixWorld(true);
  try {
    const hits = new THREE.Raycaster(
      new THREE.Vector3(5, -7, 20),
      new THREE.Vector3(0, 0, -1),
    ).intersectObject(mesh, true);
    const point = modelMeasurementPoint(hits);
    assert.deepEqual(point, { x: 5, y: 7, z: 3, estimated: true });
    hits[0].point.x = 500;
    assert.equal(point!.x, 5, 'Readouts never retain a mutable shared ray intersection.');
  } finally {
    geometry.dispose();
    material.dispose();
  }
});

test('visible component body centers snap ahead of surface vertices and recheck component occlusion', () => {
  const root = new THREE.Group();
  root.userData.footprintId = 'component';
  root.position.set(5, -7, 2);
  root.rotation.z = Math.PI / 2;
  const geometry = new THREE.BoxGeometry(2, 4, 2);
  const material = new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh(geometry, material);
  root.add(mesh);
  const hidden = new THREE.Mesh(geometry, material);
  hidden.visible = false;
  hidden.position.x = 100;
  root.add(hidden);
  root.updateMatrixWorld(true);
  const hits = new THREE.Raycaster(
    new THREE.Vector3(5, -7, 20),
    new THREE.Vector3(0, 0, -1),
  ).intersectObject(root, true);
  const options = {
    project: (point: { x: number; y: number }) => ({ x: point.x * 10, y: point.y * 10 }),
    pointer: { x: 50, y: 70 },
    tolerance: 8,
    visible: (_: unknown, component?: THREE.Object3D) => component === root,
  };
  try {
    assert.deepEqual(modelMeasurementPoint(hits, options), { x: 5, y: 7, z: 2, snapped: true });
    assert.deepEqual(modelMeasurementPoint(hits, { ...options, visible: () => false }), {
      x: 5,
      y: 7,
      z: 3,
    });
    assert.deepEqual(modelMeasurementPoint(hits), { x: 5, y: 7, z: 3 });
    assert.equal(
      modelMeasurementPoint(hits, { ...options, pointer: { x: 60, y: 70 } })?.snapped,
      undefined,
    );
    root.visible = false;
    assert.equal(modelMeasurementPoint(hits, options), null);
  } finally {
    geometry.dispose();
    material.dispose();
  }
});

test('measurement ignores hidden ancestors, helpers and CAD previews while selecting visible board surfaces', () => {
  const root = new THREE.Group();
  const geometry = new THREE.BoxGeometry(10, 10, 1);
  const material = new THREE.MeshBasicMaterial();
  const add = (z: number) => {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.z = z;
    group.add(mesh);
    root.add(group);
    return group;
  };
  const hidden = add(8);
  hidden.userData.modelBoard = true;
  hidden.visible = false;
  const preview = add(6);
  preview.userData.modelCadPreview = true;
  preview.children[0].userData.modelCadId = 'preview';
  const helper = add(4);
  helper.userData.modelMeasurementExcluded = true;
  helper.children[0].userData.modelCadId = 'edge-highlight';
  add(2);
  const board = add(0);
  board.userData.modelBoard = true;
  try {
    root.updateMatrixWorld(true);
    const hits = new THREE.Raycaster(
      new THREE.Vector3(0, 0, 20),
      new THREE.Vector3(0, 0, -1),
    ).intersectObject(root, true);
    const point = modelMeasurementPoint(hits);
    assert.equal(point?.z, 0.5);
    board.visible = false;
    assert.equal(modelMeasurementPoint(hits), null);
  } finally {
    geometry.dispose();
    material.dispose();
  }
});

test('fully transparent or disabled materials do not hide measurable surfaces behind them', () => {
  const root = new THREE.Group();
  const geometry = new THREE.BoxGeometry(10, 10, 1);
  const invisible = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 });
  const visible = new THREE.MeshBasicMaterial();
  const cover = new THREE.Mesh(geometry, invisible);
  cover.position.z = 5;
  cover.userData.modelCadId = 'cover';
  const board = new THREE.Mesh(geometry, visible);
  board.userData.modelBoard = true;
  root.add(cover, board);
  root.updateMatrixWorld(true);
  const hits = new THREE.Raycaster(
    new THREE.Vector3(0, 0, 20),
    new THREE.Vector3(0, 0, -1),
  ).intersectObject(root, true);
  try {
    assert.equal(modelMeasurementPoint(hits)?.z, 0.5);
    invisible.opacity = 0.5;
    assert.equal(modelMeasurementPoint(hits)?.z, 5.5);
    invisible.visible = false;
    assert.equal(modelMeasurementPoint(hits)?.z, 0.5);
  } finally {
    geometry.dispose();
    invisible.dispose();
    visible.dispose();
  }
});

test('nearby visible mesh vertices snap while occluded vertices and transparent text pixels do not', () => {
  const geometry = new THREE.PlaneGeometry(10, 10);
  const material = new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.userData.modelBoard = true;
  mesh.updateMatrixWorld(true);
  const hits = new THREE.Raycaster(
    new THREE.Vector3(-4.7, 4.8, 10),
    new THREE.Vector3(0, 0, -1),
  ).intersectObject(mesh, true);
  const options = {
    project: (point: { x: number; y: number }) => ({ x: point.x + 100, y: point.y + 100 }),
    pointer: { x: 95.3, y: 95.2 },
    tolerance: 1,
    visible: () => true,
  };
  try {
    assert.deepEqual(modelMeasurementPoint(hits, options), { x: -5, y: -5, z: 0, snapped: true });
    assert.equal(
      modelMeasurementPoint(hits, { ...options, visible: () => false })?.snapped,
      undefined,
    );
    assert.equal(
      modelMeasurementPoint(hits)?.snapped,
      undefined,
      'Free picking bypasses vertex attraction.',
    );
    mesh.userData.modelMeasurementVisibleAtUV = () => false;
    assert.equal(
      modelMeasurementPoint(hits, options),
      null,
      'Transparent text-plane texels are not surfaces.',
    );
  } finally {
    geometry.dispose();
    material.dispose();
  }
});
