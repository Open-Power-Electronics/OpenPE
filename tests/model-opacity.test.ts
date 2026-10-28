import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { cloneModelInstance, disposeModelGroup } from '../lib/model-mesh';
import { createModelSelection } from '../lib/model-selection';

test('native opacity owns material copies per instance and selection preserves their alpha', () => {
  const template = new THREE.Group();
  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshStandardMaterial({ color: '#387a42', opacity: 1 });
  const face = new THREE.MeshStandardMaterial({ color: '#ad5538', metalness: 0.7 });
  template.add(new THREE.Mesh(geometry, [material, face]));
  const root = new THREE.Group();
  const cover = cloneModelInstance(template, 0.3);
  const other = cloneModelInstance(template, 0.8);
  cover.userData.footprintId = 'cover';
  other.userData.footprintId = 'other';
  root.add(cover, other);
  const coverMesh = cover.children[0] as THREE.Mesh<
    THREE.BufferGeometry,
    THREE.MeshStandardMaterial[]
  >;
  const otherMesh = other.children[0] as typeof coverMesh;
  const original = coverMesh.material;
  assert.equal(coverMesh.geometry, geometry);
  assert.notEqual(original[0], material);
  assert.notEqual(original[0], otherMesh.material[0]);
  assert.equal(original[0].opacity, 0.3);
  assert.equal(original[1].opacity, 0.3);
  assert.equal(original[1].metalness, face.metalness);
  assert.equal(original[0].transparent, true);
  assert.equal(original[0].depthWrite, false);
  assert.equal(material.opacity, 1);
  assert.equal(material.transparent, false);
  assert.equal(material.depthWrite, true);
  const selection = createModelSelection(root);
  selection.update(new Set(['cover']), true);
  assert.equal(coverMesh.material[0].opacity, 0.3);
  assert.equal(otherMesh.material[0].opacity, 0.8);
  assert.equal(material.opacity, 1);
  selection.withoutSelection(() => assert.equal(coverMesh.material, original));
  selection.dispose();
  assert.equal(coverMesh.material, original);
  let disposed = 0;
  for (const copy of original) copy.addEventListener('dispose', () => disposed++);
  disposeModelGroup(cover);
  assert.equal(disposed, 2, 'Every instance-owned face material is released once.');
  assert.equal(material.opacity, 1);
  disposeModelGroup(other);
  disposeModelGroup(template);
});

test('absent native opacity retains shared templates and invalid opacity fails before cloning', () => {
  const template = new THREE.Group();
  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshStandardMaterial({ opacity: 0.6, transparent: true });
  template.add(new THREE.Mesh(geometry, material));
  const instance = cloneModelInstance(template);
  assert.equal((instance.children[0] as THREE.Mesh).material, material);
  for (const opacity of [-0.1, 1.1, NaN, Infinity])
    assert.throws(() => cloneModelInstance(template, opacity), /opacity/);
  assert.equal(material.opacity, 0.6);
  disposeModelGroup(template);
});
