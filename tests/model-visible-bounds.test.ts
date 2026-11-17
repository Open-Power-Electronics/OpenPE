import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { modelVisibleBounds } from '../lib/model-visible-bounds';

test('visible Model bounds preserve transformed scene extents when all geometry is visible', () => {
  const root = new THREE.Group();
  const nested = new THREE.Group();
  const geometry = new THREE.BoxGeometry(20, 12, 4);
  const material = new THREE.MeshBasicMaterial();
  try {
    root.position.set(7, -8, 9);
    root.rotation.set(0.2, -0.1, 0.3);
    nested.position.set(20, 30, 10);
    nested.rotation.set(-0.4, 0.3, 0.1);
    nested.scale.set(2, 1, 0.5);
    const plate = new THREE.Mesh(geometry, material);
    plate.position.set(1000, -30, 4);
    root.add(nested);
    nested.add(plate);
    root.updateWorldMatrix(true, true);
    const originalPose = plate.position.toArray();
    assert.deepEqual(modelVisibleBounds(root), new THREE.Box3().setFromObject(root));
    assert.deepEqual(plate.position.toArray(), originalPose, 'Fitting cannot move scene objects.');
  } finally {
    geometry.dispose();
    material.dispose();
  }
});

test('visible Model bounds follow CAD, components, enclosure and suppressed source-case visibility', () => {
  const root = new THREE.Group();
  const geometry = new THREE.BoxGeometry(10, 10, 2);
  const material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.3 });
  const add = (x: number) => {
    const group = new THREE.Group();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.x = x;
    group.add(mesh);
    root.add(group);
    return { group, mesh };
  };
  try {
    add(0);
    const cad = add(1000);
    const components = add(300);
    const sourceCase = add(-1500);
    const enclosure = add(-200);
    cad.group.visible = false;
    components.group.visible = false;
    sourceCase.mesh.visible = false;
    enclosure.group.visible = false;
    const baseline = modelVisibleBounds(root);
    assert.deepEqual(baseline.min.toArray(), [-5, -5, -1]);
    assert.deepEqual(baseline.max.toArray(), [5, 5, 1]);

    cad.group.visible = true;
    assert.equal(modelVisibleBounds(root).max.x, 1005, 'Visible remote solids participate in Fit.');
    cad.group.visible = false;
    assert.deepEqual(
      modelVisibleBounds(root),
      baseline,
      'Hidden CAD cannot shrink the board view.',
    );

    components.group.visible = true;
    assert.equal(modelVisibleBounds(root).max.x, 305);
    components.group.visible = false;
    assert.deepEqual(
      modelVisibleBounds(root),
      baseline,
      'A hidden component ancestor excludes its meshes.',
    );

    enclosure.group.visible = true;
    assert.equal(
      modelVisibleBounds(root).min.x,
      -205,
      'Visible transparent covers still participate.',
    );
    assert.equal(sourceCase.mesh.visible, false, 'Suppressed source cases remain suppressed.');
    enclosure.group.visible = false;
    assert.deepEqual(
      modelVisibleBounds(root),
      baseline,
      'Hiding the enclosure does not restore its source case.',
    );
    sourceCase.mesh.visible = true;
    assert.equal(
      modelVisibleBounds(root).min.x,
      -1505,
      'An actually visible source case participates.',
    );
  } finally {
    geometry.dispose();
    material.dispose();
  }
});

test('visible Model bounds keep the finite origin fallback when no geometry is visible', () => {
  const root = new THREE.Group();
  const geometry = new THREE.BoxGeometry(10, 10, 2);
  const material = new THREE.MeshBasicMaterial();
  try {
    const hidden = new THREE.Mesh(geometry, material);
    hidden.position.set(1000, 2000, 3000);
    root.add(hidden, new THREE.Group());
    root.visible = false;
    const bounds = modelVisibleBounds(root);
    assert.equal(bounds.isEmpty(), true);
    assert.deepEqual(bounds.getCenter(new THREE.Vector3()).toArray(), [0, 0, 0]);
    assert.deepEqual(bounds.getSize(new THREE.Vector3()).toArray(), [0, 0, 0]);
    root.visible = true;
    hidden.visible = false;
    assert.equal(modelVisibleBounds(root).isEmpty(), true);
  } finally {
    geometry.dispose();
    material.dispose();
  }
});
