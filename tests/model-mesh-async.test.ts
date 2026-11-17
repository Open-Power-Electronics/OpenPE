import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  disposeModelGroup,
  modelMeshGroup,
  modelMeshGroupAsync,
  type MeshData,
} from '../lib/model-mesh';

function meshData(offset: number): MeshData {
  return {
    color: [0.2, 0.4, 0.6],
    attributes: {
      position: { array: [offset, 0, 0, offset + 1, 0, 0, offset, 1, 0] },
      normal: { array: [0, 0, 1, 0, 0, 1, 0, 0, 1] },
    },
    index: { array: [0, 1, 2, 0, 2, 1, 0, 1, 2] },
    brep_faces: [
      { first: 0, last: 0, color: null },
      { first: 1, last: 1, color: [0.2, 0.4, 0.6] },
      { first: 2, last: 2, color: [0.8, 0.7, 0.2] },
    ],
  };
}

function snapshot(group: THREE.Group) {
  return group.children.map((child) => {
    const mesh = child as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial[]>;
    return {
      positions: Array.from(mesh.geometry.attributes.position.array),
      normals: Array.from(mesh.geometry.attributes.normal.array),
      indices: Array.from(mesh.geometry.index!.array),
      groups: mesh.geometry.groups,
      materials: mesh.material.map((material) => ({
        color: material.color.toArray(),
        metalness: material.metalness,
        roughness: material.roughness,
        opacity: material.opacity,
      })),
    };
  });
}

test('yielded STEP mesh construction retains mesh order, geometry, face draws and material appearance', async () => {
  const data = [meshData(0), meshData(2), meshData(4)],
    before = structuredClone(data);
  const sync = modelMeshGroup(data);
  let acceptedInputs = 0;
  const asyncGroup = await modelMeshGroupAsync(
    data,
    async () => {
      await new Promise<void>((resolve) =>
        setTimeout(() => {
          acceptedInputs++;
          resolve();
        }, 0),
      );
    },
    0,
  );
  assert.equal(
    acceptedInputs,
    data.length,
    'Each forced checkpoint lets a queued input task complete.',
  );
  assert.deepEqual(snapshot(asyncGroup), snapshot(sync));
  assert.deepEqual(data, before);
  assert.notEqual(asyncGroup.children[0], sync.children[0]);
  disposeModelGroup(sync);
  disposeModelGroup(asyncGroup);
});

test('a cancelled STEP build disposes partial geometry and materials without publishing a template', async () => {
  const originalGeometry = THREE.BufferGeometry.prototype.dispose;
  const originalMaterial = THREE.Material.prototype.dispose;
  const geometry = new Set<THREE.BufferGeometry>(),
    materials = new Set<THREE.Material>();
  THREE.BufferGeometry.prototype.dispose = function () {
    geometry.add(this);
    originalGeometry.call(this);
  };
  THREE.Material.prototype.dispose = function () {
    materials.add(this);
    originalMaterial.call(this);
  };
  let checkpoints = 0;
  try {
    await assert.rejects(
      modelMeshGroupAsync(
        [meshData(0), meshData(2), meshData(4)],
        async () => {
          if (++checkpoints === 2) throw new Error('Preview cancelled.');
        },
        0,
      ),
      /Preview cancelled/,
    );
    assert.equal(checkpoints, 2);
    assert.equal(geometry.size, 2, 'Every constructed partial mesh releases its geometry.');
    assert.equal(materials.size, 4, 'Both per-mesh face materials are released.');
  } finally {
    THREE.BufferGeometry.prototype.dispose = originalGeometry;
    THREE.Material.prototype.dispose = originalMaterial;
  }
});
