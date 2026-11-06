import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  createModelCopperRelief,
  MODEL_COPPER_RELIEF_MICROMETERS,
  MODEL_COPPER_RELIEF_MAX_SIZE,
} from '../components/model-copper-relief';
import { createModelRenderScene } from '../components/model-render-scene';
import {
  createModelBoardDisplayGroups,
  createModelSolderMaskSurface,
  defaultModelBoardDisplay,
} from '../lib/model-board-display';

function rectangle(width: number, height: number) {
  const shape = new THREE.Shape()
    .moveTo(-width / 2, -height / 2)
    .lineTo(width / 2, -height / 2)
    .lineTo(width / 2, height / 2)
    .lineTo(-width / 2, height / 2)
    .closePath();
  return new THREE.ShapeGeometry(shape);
}
function surface(width: number, height: number, layer: string, z: number, x = 0) {
  const mesh = new THREE.Mesh(rectangle(width, height), new THREE.MeshBasicMaterial());
  mesh.position.set(x, 0, z);
  mesh.userData.modelExplosionLayer = layer;
  return mesh;
}
function sample(texture: THREE.DataTexture, x: number, y: number) {
  const uv = new THREE.Vector2(x, y).applyMatrix3(texture.matrix);
  const { data, width, height } = texture.image;
  const column = Math.max(0, Math.min(width - 1, Math.floor(uv.x * width)));
  const row = Math.max(0, Math.min(height - 1, Math.floor(uv.y * height)));
  return Array.from(
    (data as Uint8Array).slice((row * width + column) * 4, (row * width + column) * 4 + 4),
  );
}
function disposeMeshes(meshes: THREE.Mesh[]) {
  for (const mesh of meshes) {
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }
}

test('exact copper triangle edges produce opposing green-coating shoulder normals without changing native geometry or UVs', () => {
  const root = new THREE.Group();
  const mask = surface(10, 8, 'F.Mask', 0.82);
  const copper = surface(0.6, 6, 'F.Cu', 0.815);
  root.add(mask, copper);
  root.updateWorldMatrix(true, true);
  const original = [mask, copper].map((mesh) => ({
    positions: Array.from(mesh.geometry.getAttribute('position').array),
    uv: Array.from(mesh.geometry.getAttribute('uv').array),
    matrix: mesh.matrix.toArray(),
    material: mesh.material.toJSON(),
  }));
  const texture = createModelCopperRelief(mask, [copper])!;
  assert.ok(texture);
  assert.equal(texture.userData.modelCopperReliefMicrometers, MODEL_COPPER_RELIEF_MICROMETERS);
  assert.equal(texture.colorSpace, THREE.NoColorSpace);
  assert.ok(
    sample(texture, -0.3, 0)[0] < 115,
    'The rising left shoulder tilts against the height gradient.',
  );
  assert.ok(
    sample(texture, 0.3, 0)[0] > 140,
    'The falling right shoulder tilts in the opposite direction.',
  );
  assert.deepEqual(
    sample(texture, 0, 0),
    [128, 128, 255, 255],
    'Copper plateau remains locally flat.',
  );
  assert.deepEqual(
    sample(texture, 2, 0),
    [128, 128, 255, 255],
    'Uncovered FR4 has no invented trace relief.',
  );
  [mask, copper].forEach((mesh, index) => {
    assert.deepEqual(
      Array.from(mesh.geometry.getAttribute('position').array),
      original[index].positions,
    );
    assert.deepEqual(Array.from(mesh.geometry.getAttribute('uv').array), original[index].uv);
    assert.deepEqual(mesh.matrix.toArray(), original[index].matrix);
    assert.deepEqual(mesh.material.toJSON(), original[index].material);
  });
  texture.dispose();
  disposeMeshes([mask, copper]);
});

test('relief rasterization follows actual triangular copper coverage rather than its bounding rectangle', () => {
  const mask = surface(10, 8, 'F.Mask', 0.82);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-4, -3, 0, 4, -3, 0, -4, 3, 0], 3),
  );
  const triangle = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  triangle.position.z = 0.815;
  triangle.userData.modelExplosionLayer = 'F.Cu';
  mask.updateWorldMatrix(true, true);
  triangle.updateWorldMatrix(true, true);
  const texture = createModelCopperRelief(mask, [triangle])!;
  const diagonal = sample(texture, 0, 0);
  assert.ok(
    diagonal[0] > 135 && diagonal[1] > 135,
    'The actual oblique triangle edge affects both normal axes.',
  );
  assert.deepEqual(
    sample(texture, 3, 2),
    [128, 128, 255, 255],
    'Empty triangular half is not filled by an AABB approximation.',
  );
  texture.dispose();
  disposeMeshes([mask, triangle]);
});

test('side tags and visibility exclude opposite, internal and hidden copper from mask relief', () => {
  const root = new THREE.Group();
  const mask = surface(10, 8, 'F.Mask', 0.82);
  const front = surface(0.6, 6, 'F.Cu', 0.815, -2);
  const back = surface(0.6, 6, 'B.Cu', -0.815, 2);
  const internal = surface(0.6, 6, 'In1.Cu', 0.4, 0);
  const hidden = surface(0.6, 6, 'F.Cu', 0.815, 1);
  hidden.visible = false;
  const preview = surface(0.6, 6, 'F.Cu', 0.815, -1);
  preview.userData.modelMeasurementExcluded = true;
  root.add(mask, front, back, internal, hidden, preview);
  root.updateWorldMatrix(true, true);
  const baseline = createModelCopperRelief(mask, [front])!;
  const filtered = createModelCopperRelief(mask, [front, back, internal, hidden, preview])!;
  assert.deepEqual(filtered.image.data, baseline.image.data);
  assert.equal(createModelCopperRelief(mask, [back, internal, hidden, preview]), null);
  assert.equal(createModelCopperRelief(mask, []), null);
  baseline.dispose();
  filtered.dispose();
  disposeMeshes([mask, front, back, internal, hidden, preview]);
});

test('mask-local coordinates preserve relief through shared world transforms and require explicit native layer tags', () => {
  const root = new THREE.Group();
  const mask = surface(10, 8, 'F.Mask', 0.82);
  const copper = surface(0.6, 6, 'F.Cu', 0.815);
  root.add(mask, copper);
  root.updateWorldMatrix(true, true);
  const before = createModelCopperRelief(mask, [copper])!;
  root.position.set(120, -60, 12);
  root.rotation.set(0.15, -0.2, 0.35);
  root.updateWorldMatrix(true, true);
  const after = createModelCopperRelief(mask, [copper])!;
  assert.deepEqual(
    after.image.data,
    before.image.data,
    'The same board pattern is evaluated in the mask local frame.',
  );
  delete mask.userData.modelExplosionLayer;
  delete copper.userData.modelExplosionLayer;
  assert.equal(
    createModelCopperRelief(mask, [copper]),
    null,
    'Untagged surfaces receive no inferred layer relief.',
  );
  copper.position.z = -0.815;
  root.updateWorldMatrix(true, true);
  assert.equal(
    createModelCopperRelief(mask, [copper]),
    null,
    'An untagged far surface is not guessed from its position.',
  );
  before.dispose();
  after.dispose();
  disposeMeshes([mask, copper]);
});

test('relief resolution and input work are bounded, and empty or unsupported UVs remain flat', () => {
  const mask = surface(100, 3, 'F.Mask', 0.82);
  const copper = surface(90, 0.4, 'F.Cu', 0.815);
  mask.updateWorldMatrix(true, true);
  copper.updateWorldMatrix(true, true);
  const texture = createModelCopperRelief(mask, [copper])!;
  assert.equal(Math.max(texture.image.width, texture.image.height), MODEL_COPPER_RELIEF_MAX_SIZE);
  assert.ok(texture.image.data);
  assert.ok(texture.image.data.length <= MODEL_COPPER_RELIEF_MAX_SIZE ** 2 * 4);
  const excessive = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  excessive.geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 0, 1, 0], 3),
  );
  excessive.geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(750003), 1));
  excessive.userData.modelExplosionLayer = 'F.Cu';
  excessive.updateWorldMatrix(true, true);
  assert.equal(
    createModelCopperRelief(mask, [excessive]),
    null,
    'Excessive triangle input omits the derived texture without partial publication.',
  );
  mask.geometry.deleteAttribute('uv');
  assert.equal(createModelCopperRelief(mask, [copper]), null);
  texture.dispose();
  disposeMeshes([mask, copper, excessive]);
});

test('physical-scene mask owns and disposes its relief texture while native copper and coating paint stay intact', () => {
  const root = new THREE.Group();
  const groups = createModelBoardDisplayGroups(root, defaultModelBoardDisplay());
  const mask = createModelSolderMaskSurface(rectangle(10, 8));
  mask.position.z = 0.82;
  mask.userData.modelExplosionLayer = 'F.Mask';
  const copper = surface(0.6, 6, 'F.Cu', 0.815);
  groups.mask.add(mask);
  groups.copper.add(copper);
  const render = createModelRenderScene(root);
  render.sync(
    new THREE.Box3(new THREE.Vector3(-5, -4, -0.8), new THREE.Vector3(5, 4, 0.82)),
    false,
  );
  const assembly = render.scene.getObjectByName('OpenPE Render assembly')!;
  const coating = assembly.children.find(
    (mesh) => mesh.userData.modelRenderSource === mask.uuid,
  ) as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
  const relief = coating.material.normalMap!;
  assert.ok(relief instanceof THREE.DataTexture);
  assert.equal(
    coating.material.clearcoatNormalMap,
    relief,
    'The reflective lacquer follows the same coated-copper shoulder normals.',
  );
  assert.equal(coating.material.transmission, 0.26);
  assert.equal((mask.material as THREE.Material).opacity, 0.9);
  assert.equal('normalMap' in mask.material, false);
  let disposals = 0;
  relief.addEventListener('dispose', () => disposals++);
  render.dispose();
  render.dispose();
  assert.equal(disposals, 1);
  mask.geometry.dispose();
  (mask.material as THREE.Material).dispose();
  ((mask.children[0] as THREE.Mesh).material as THREE.Material).dispose();
  disposeMeshes([copper]);
});
