import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import {
  cloneModelInstance,
  disposeModelGroup,
  modelMeshGroup,
  type MeshData,
} from '../lib/model-mesh';

test('STEP rendering combines only contiguous equal-colour faces without changing triangles or source metadata', () => {
  const data: MeshData = {
    color: [0.1, 0.2, 0.3],
    attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] } },
    index: { array: Array.from({ length: 30 }, (_, index) => index % 3) },
    brep_faces: [
      { first: 0, last: 0, color: null },
      { first: 1, last: 1, color: [0.1, 0.2, 0.3] },
      { first: 2, last: 3, color: [0.7, 0.4, 0.1] },
      { first: 4, last: 4, color: [0.7, 0.4, 0.1] },
      { first: 6, last: 6, color: [0.7, 0.4, 0.1] },
      { first: 7, last: 7, color: null },
      { first: 8, last: 9, color: [0.7, 0.4, 0.1] },
    ],
  };
  const before = structuredClone(data);
  const group = modelMeshGroup([data]);
  const mesh = group.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial[]>;
  assert.deepEqual(Array.from(mesh.geometry.index!.array), data.index.array);
  assert.deepEqual(
    Array.from(mesh.geometry.attributes.position.array),
    data.attributes.position.array,
  );
  assert.deepEqual(mesh.geometry.groups, [
    { start: 0, count: 6, materialIndex: 0 },
    { start: 6, count: 9, materialIndex: 1 },
    { start: 18, count: 3, materialIndex: 1 },
    { start: 21, count: 3, materialIndex: 0 },
    { start: 24, count: 6, materialIndex: 1 },
  ]);
  assert.equal(mesh.material.length, 2);
  assert.deepEqual(mesh.material[0].color.toArray(), data.color);
  assert.deepEqual(mesh.material[1].color.toArray(), data.brep_faces![2].color);
  assert.deepEqual(data, before);
  const instance = cloneModelInstance(group, 0.4);
  const copy = instance.children[0] as typeof mesh;
  assert.equal(copy.geometry, mesh.geometry);
  assert.notEqual(copy.material[0], mesh.material[0]);
  assert.equal(copy.material[0].opacity, 0.4);
  assert.equal(mesh.material[0].opacity, 1);
  disposeModelGroup(instance);
  disposeModelGroup(group);
});
