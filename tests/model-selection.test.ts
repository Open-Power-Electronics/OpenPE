import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { createModelSelection } from '../lib/model-selection';

function fixture() {
  const root = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: '#387a42',
    opacity: 0.6,
    transparent: true,
  });
  const geometry = new THREE.BoxGeometry();
  const meshes = ['a', 'b'].map((id) => {
    const instance = new THREE.Group();
    instance.userData.footprintId = id;
    const mesh = new THREE.Mesh(geometry, material);
    instance.add(mesh);
    root.add(instance);
    return mesh;
  });
  return { root, material, geometry, meshes, selection: createModelSelection(root) };
}

test('selected 3D instances keep their own paint without changing shared templates, geometry or opacity', () => {
  const { root, material, geometry, meshes, selection } = fixture();
  const before = material.color.clone();
  selection.update(new Set(['a']), true);
  assert.notEqual(meshes[0].material, material);
  assert.equal(meshes[1].material, material);
  assert.deepEqual(material.color, before);
  assert.equal(meshes[0].geometry, geometry);
  assert.equal(meshes[0].material.opacity, material.opacity);
  assert.equal(meshes[0].material.transparent, material.transparent);
  const dark = meshes[0].material.color.clone();
  selection.update(new Set(['a']), true);
  assert.deepEqual(
    meshes[0].material.color,
    dark,
    'Repeated redraw does not accumulate brightness.',
  );
  selection.update(new Set(['a']), false);
  assert.ok(meshes[0].material.color.g < before.g);
  assert.ok(dark.g > before.g);
  assert.ok(
    meshes[0].material.color.g > meshes[0].material.color.r,
    'The source green hue remains.',
  );
  let disposed = 0;
  meshes[0].material.addEventListener('dispose', () => disposed++);
  root.children[0].visible = false;
  selection.update(new Set(['a']), false);
  assert.equal(meshes[0].material, material);
  assert.equal(disposed, 1);
  selection.dispose();
  material.dispose();
  geometry.dispose();
});

test('per-face materials restore exactly for image export, including a failed capture, then dispose their copies', () => {
  const { root, material, geometry, meshes, selection } = fixture();
  const second = new THREE.MeshStandardMaterial({ color: '#ad5538', metalness: 0.7 });
  const original = [material, second];
  (meshes[0] as THREE.Mesh).material = original;
  selection.update(new Set(['a']), true);
  const painted = (meshes[0] as THREE.Mesh).material as THREE.MeshStandardMaterial[];
  assert.equal(painted.length, 2);
  assert.equal(painted[1].metalness, second.metalness);
  assert.ok(painted[1].color.r > painted[1].color.g);
  assert.equal(
    selection.withoutSelection(() => {
      assert.equal((meshes[0] as THREE.Mesh).material, original);
      return 'image';
    }),
    'image',
  );
  assert.equal((meshes[0] as THREE.Mesh).material, painted);
  assert.throws(
    () =>
      selection.withoutSelection(() => {
        throw new Error('capture');
      }),
    /capture/,
  );
  assert.equal((meshes[0] as THREE.Mesh).material, painted);
  let disposed = 0;
  for (const copy of painted) copy.addEventListener('dispose', () => disposed++);
  selection.dispose();
  assert.equal((meshes[0] as THREE.Mesh).material, original);
  assert.equal(meshes[1].material, material);
  assert.equal(disposed, 2);
  assert.equal(root.children.length, 2);
  material.dispose();
  second.dispose();
  geometry.dispose();
});
