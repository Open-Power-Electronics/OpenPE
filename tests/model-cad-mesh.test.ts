import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { modelCadKernelMesh, modelCadMesh } from '../components/model-cad-mesh';
import { uid } from '../lib/circuit';
import { validateModelCadObject, type ModelCadObject, type ModelCadVector } from '../lib/model-cad';
import { disposeModelGroup } from '../lib/model-mesh';
import { createModelSelection } from '../lib/model-selection';

const body = (kind: ModelCadObject['kind'] = 'box'): ModelCadObject =>
  validateModelCadObject({
    id: uid(),
    name: 'Mount',
    kind,
    position: { x: 100, y: 88, z: 20 },
    rotation: { x: 0, y: 0, z: 0 },
    size: { x: 20, y: kind === 'box' ? 16 : 20, z: 10 },
    material: 'aluminium',
    opacity: 1,
  });

test('custom colors reach primitive, kernel and translucent preview materials and survive selection', () => {
  const colored = validateModelCadObject({ ...body(), color: '#d94838', opacity: 0.8 });
  const face = {
    attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] } },
    index: { array: [0, 1, 2] },
  };
  const root = new THREE.Group();
  const selection = createModelSelection(root, 'modelCadId');
  const surfaces = [
    modelCadMesh(colored),
    modelCadMesh(colored, true),
    modelCadKernelMesh(colored, [face]),
    modelCadKernelMesh(colored, [face], true),
  ];
  root.add(...surfaces);
  try {
    root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      assert.equal(node.material.color.getHexString(), 'd94838');
      assert.equal(node.material.opacity, node.userData.modelCadPreview ? 0.45 : 0.8);
    });
    selection.update(new Set([colored.id]), true);
    selection.withoutSelection(() =>
      root.traverse((node) => {
        if (node instanceof THREE.Mesh) assert.equal(node.material.color.getHexString(), 'd94838');
      }),
    );
    selection.dispose();
    root.traverse((node) => {
      if (node instanceof THREE.Mesh) assert.equal(node.material.color.getHexString(), 'd94838');
    });
  } finally {
    selection.dispose();
    disposeModelGroup(root);
  }
});

// Independent native-axis Rx * Ry * Rz transform, followed by the scene's Y
// reflection. This deliberately does not use the mesh's Three transform.
function scenePoint(object: ModelCadObject, point: ModelCadVector) {
  const radians = (angle: number) => (angle * Math.PI) / 180;
  const [sx, sy, sz] = [object.rotation.x, object.rotation.y, object.rotation.z].map((a) =>
    Math.sin(radians(a)),
  );
  const [cx, cy, cz] = [object.rotation.x, object.rotation.y, object.rotation.z].map((a) =>
    Math.cos(radians(a)),
  );
  const zx = cz * point.x - sz * point.y,
    zy = sz * point.x + cz * point.y;
  const yx = cy * zx + sy * point.z,
    yz = -sy * zx + cy * point.z;
  return new THREE.Vector3(
    yx + object.position.x,
    -(cx * zy - sx * yz + object.position.y),
    sx * zy + cx * yz + object.position.z,
  );
}
function localRay(object: ModelCadObject, x: number, y: number, direction = -1) {
  const start = scenePoint(object, { x, y, z: direction * -30 });
  const end = scenePoint(object, { x, y, z: direction * 30 });
  return new THREE.Raycaster(start, end.sub(start).normalize());
}

test('box and cylinder meshes retain solid caps and native-axis bounds', () => {
  for (const kind of ['box', 'cylinder'] as const) {
    const object = body(kind),
      mesh = modelCadMesh(object);
    mesh.updateMatrixWorld(true);
    try {
      for (const direction of [-1, 1]) {
        assert.ok(
          localRay(object, 0, 0, direction).intersectObject(mesh).length >= 1,
          `${kind} material outside the cut must remain solid`,
        );
      }
    } finally {
      disposeModelGroup(mesh);
    }
  }
});

test('compound XYZ poses match independently transformed native geometry', () => {
  const object = body();
  object.position = { x: 10, y: 20, z: 30 };
  object.size = { x: 12, y: 8, z: 6 };
  object.rotation = { x: 17, y: 31, z: 43 };
  const mesh = modelCadMesh(validateModelCadObject(object));
  mesh.updateMatrixWorld(true);
  try {
    const corners: THREE.Vector3[] = [];
    for (const x of [-6, 6])
      for (const y of [-4, 4])
        for (const z of [-3, 3]) corners.push(scenePoint(object, { x, y, z }));
    const expected = new THREE.Box3().setFromPoints(corners),
      actual = new THREE.Box3().setFromObject(mesh, true);
    assert.ok(actual.min.distanceTo(expected.min) < 1e-6);
    assert.ok(actual.max.distanceTo(expected.max) < 1e-6);
    assert.ok(actual.max.y < 0, 'The complete native world pose must be reflected across scene Y');
    assert.equal(
      localRay(object, 2, 1).intersectObject(mesh).length >= 1,
      true,
      'The primitive surface rotates and translates with its body',
    );
    assert.ok(localRay(object, -2, -1).intersectObject(mesh).length >= 1);
  } finally {
    disposeModelGroup(mesh);
  }
});

test('preview opacity belongs to independent presentation materials and never changes CAD parameters', () => {
  for (const opacity of [0.2, 0.8, 1]) {
    const object = body();
    object.opacity = opacity;
    object.material = 'pmma';
    const before = JSON.stringify(object);
    Object.freeze(object.position);
    Object.freeze(object.rotation);
    Object.freeze(object.size);
    Object.freeze(object);
    const original = modelCadMesh(object),
      preview = modelCadMesh(object, true);
    try {
      assert.notEqual(original.material, preview.material);
      assert.equal(original.material.opacity, opacity);
      assert.equal(preview.material.opacity, Math.min(opacity, 0.45));
      assert.equal(preview.material.transparent, true);
      assert.equal(preview.material.depthWrite, false);
      assert.equal(original.material.depthWrite, opacity === 1);
      assert.equal(original.material.side, THREE.FrontSide);
      assert.equal(preview.material.side, THREE.FrontSide);
      assert.equal(original.userData.modelCadId, object.id);
      assert.equal(preview.userData.modelCadPreview, true);
      assert.equal(JSON.stringify(object), before);
    } finally {
      disposeModelGroup(original);
      disposeModelGroup(preview);
    }
  }
});

test('CAD selection uses its own identity and material copies while preserving hue, opacity and other bodies', () => {
  const object = body();
  object.opacity = 0.3;
  const mesh = modelCadMesh(object),
    other = modelCadMesh({ ...object, id: uid() }),
    group = new THREE.Group();
  group.add(mesh, other);
  const original = mesh.material,
    otherMaterial = other.material,
    originalColor = original.color.clone(),
    otherColor = otherMaterial.color.clone(),
    selection = createModelSelection(group, 'modelCadId');
  try {
    selection.update(new Set([object.id]), true);
    assert.notEqual(mesh.material, original);
    assert.equal(other.material, otherMaterial);
    assert.deepEqual(other.material.color, otherColor);
    assert.deepEqual(original.color, originalColor);
    assert.equal(mesh.material.opacity, 0.3);
    assert.equal(mesh.material.depthWrite, false);
    assert.equal(mesh.material.side, THREE.FrontSide);
    assert.equal(mesh.material.metalness, original.metalness);
    assert.ok(
      mesh.material.color.r > originalColor.r,
      'Dark-scene selection brightens the source paint',
    );
    assert.ok(
      mesh.material.color.b > mesh.material.color.g &&
        mesh.material.color.g > mesh.material.color.r,
      'Selection retains the source blue-gray hue',
    );
    selection.update(new Set([object.id]), false);
    assert.ok(
      mesh.material.color.r < originalColor.r,
      'Light-scene selection darkens the same source paint',
    );
    assert.equal(mesh.material.opacity, 0.3);
    selection.withoutSelection(() => assert.equal(mesh.material, original));
    let disposed = 0;
    mesh.material.addEventListener('dispose', () => disposed++);
    selection.dispose();
    assert.equal(mesh.material, original);
    assert.equal(disposed, 1);
    assert.equal(other.material, otherMaterial);
  } finally {
    selection.dispose();
    disposeModelGroup(group);
  }
});
