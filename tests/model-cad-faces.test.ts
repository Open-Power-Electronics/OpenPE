import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import type { ModelCadObject } from '../lib/model-cad';
import {
  createModelCadFaceHighlight,
  disposeModelCadFaceHighlight,
  modelCadFaceAtPoint,
  modelCadSelectableFaces,
} from '../components/model-cad-faces';

const body = (): ModelCadObject => ({
  id: '7d6a9000-0000-4000-a000-000000000001',
  name: 'Body',
  kind: 'box',
  size: { x: 20, y: 16, z: 8 },
  holes: [],
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  material: 'aluminium',
  opacity: 1,
});
const drilled = () => ({
  ...body(),
  holes: [{ id: '7d6a9000-0000-4000-a000-000000000002', x: 2, y: 1, diameterMm: 4 }],
});
const polygon = (): ModelCadObject => ({
  ...body(),
  kind: 'extrusion',
  profile: {
    kind: 'polygon',
    points: [
      { x: -10, y: -8 },
      { x: 10, y: -8 },
      { x: 10, y: 8 },
      { x: 4, y: 8 },
      { x: 4, y: 0 },
      { x: -4, y: 0 },
      { x: -4, y: 8 },
      { x: -10, y: 8 },
    ],
  },
});

test('face catalogs identify bounded analytic caps, profile walls and independent bore walls', () => {
  assert.equal(modelCadSelectableFaces(body()).length, 6);
  assert.equal(modelCadSelectableFaces(drilled()).length, 7);
  assert.equal(modelCadSelectableFaces(polygon()).length, 10);
  const cylinder = { ...body(), kind: 'cylinder' as const, size: { x: 20, y: 20, z: 8 } };
  assert.deepEqual(
    modelCadSelectableFaces(cylinder).map((face) => face.id),
    ['profile:top', 'profile:bottom', 'profile:wall'],
  );
  const first = modelCadSelectableFaces(body());
  const wall = first.find((face) => face.kind === 'wall');
  assert.ok(wall?.kind === 'wall');
  wall.start.x = 999;
  assert.notEqual(
    (modelCadSelectableFaces(body()).find((face) => face.kind === 'wall') as typeof wall).start.x,
    999,
  );
});

test('local hit normals distinguish adjoining caps and walls without selecting triangle identities', () => {
  const object = body();
  assert.equal(modelCadFaceAtPoint(object, { x: 0, y: 0, z: 4 })?.id, 'profile:top');
  assert.equal(modelCadFaceAtPoint(object, { x: 0, y: 0, z: -4 })?.id, 'profile:bottom');
  assert.equal(modelCadFaceAtPoint(object, { x: 0, y: -8, z: 0 })?.id, 'side:0');
  assert.equal(
    modelCadFaceAtPoint(object, { x: 10, y: -8, z: 4 }, { x: 0, y: -1, z: 0 })?.id,
    'side:0',
  );
  assert.equal(
    modelCadFaceAtPoint(object, { x: 10, y: -8, z: 4 }, { x: 0, y: 0, z: 1 })?.id,
    'profile:top',
  );
  assert.equal(modelCadFaceAtPoint(object, { x: 0, y: 0, z: 10 }), null);
  assert.equal(modelCadFaceAtPoint(object, { x: NaN, y: 0, z: 0 }), null);
  const cylinder = { ...object, kind: 'cylinder' as const, size: { x: 20, y: 20, z: 8 } };
  assert.equal(
    modelCadFaceAtPoint(cylinder, { x: 9.999, y: 0, z: 0 }, { x: 1, y: 0, z: 0 })?.id,
    'profile:wall',
  );
});

test('drilled cap picking respects real voids and the inward-facing hole wall', () => {
  const object = drilled();
  assert.equal(modelCadFaceAtPoint(object, { x: 2, y: 1, z: 4 }, { x: 0, y: 0, z: 1 }), null);
  assert.equal(
    modelCadFaceAtPoint(object, { x: 4, y: 1, z: 0 }, { x: -1, y: 0, z: 0 })?.id,
    'hole:0',
  );
  assert.equal(
    modelCadFaceAtPoint(object, { x: 4, y: 1, z: 4 }, { x: 0, y: 0, z: 1 })?.id,
    'profile:top',
  );
  assert.equal(
    modelCadFaceAtPoint(polygon(), { x: 0, y: 4, z: 4 }),
    null,
    'Concave profile void is not a cap.',
  );
  assert.equal(
    modelCadFaceAtPoint(polygon(), { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })?.id,
    'side:4',
  );
  const reverse = polygon();
  if (reverse.profile?.kind === 'polygon') reverse.profile.points.reverse();
  assert.equal(
    modelCadFaceAtPoint(reverse, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 })?.kind,
    'wall',
  );
});

test('cap face paint retains through holes and wall paint has no fabricated end caps', () => {
  const object = drilled();
  const group = createModelCadFaceHighlight(object, ['profile:top', 'hole:0']);
  const cap = group.children[0] as THREE.Mesh;
  const wall = group.children[1] as THREE.Mesh;
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const capProbe = new THREE.Mesh(cap.geometry, material);
  const wallProbe = new THREE.Mesh(wall.geometry, material);
  capProbe.updateMatrixWorld(true);
  wallProbe.updateMatrixWorld(true);
  try {
    const holeRay = new THREE.Raycaster(new THREE.Vector3(2, -1, 20), new THREE.Vector3(0, 0, -1));
    assert.equal(holeRay.intersectObject(capProbe).length, 0);
    assert.equal(holeRay.intersectObject(wallProbe).length, 0);
    assert.ok(
      new THREE.Raycaster(new THREE.Vector3(0, 0, 20), new THREE.Vector3(0, 0, -1)).intersectObject(
        capProbe,
      ).length > 0,
    );
    assert.ok(
      new THREE.Raycaster(new THREE.Vector3(2, -1, 0), new THREE.Vector3(1, 0, 0)).intersectObject(
        wallProbe,
      ).length > 0,
    );
    assert.deepEqual(
      holeRay.intersectObject(group, true),
      [],
      'Paint cannot become a new pick target.',
    );
  } finally {
    material.dispose();
    disposeModelCadFaceHighlight(group);
  }
});

test('face paint retains pose and saved data and releases shared materials and geometry once', () => {
  const object = body();
  object.position = { x: 100, y: 80, z: 40 };
  object.rotation = { x: 0, y: 0, z: 90 };
  const before = JSON.stringify(object);
  const group = createModelCadFaceHighlight(object, ['profile:top', 'side:0'], 0x202020);
  group.updateMatrixWorld(true);
  const point = group.localToWorld(new THREE.Vector3(10, 8, 4));
  assert.ok(point.distanceTo(new THREE.Vector3(108, -90, 44)) < 1e-9);
  assert.equal(JSON.stringify(object), before);
  let geometries = 0;
  let materials = 0;
  for (const mesh of group.children as THREE.Mesh[])
    mesh.geometry.addEventListener('dispose', () => geometries++);
  ((group.children[0] as THREE.Mesh).material as THREE.Material).addEventListener(
    'dispose',
    () => materials++,
  );
  disposeModelCadFaceHighlight(group);
  disposeModelCadFaceHighlight(group);
  assert.equal(geometries, 2);
  assert.equal(materials, 1);
});

test('treated and Boolean topology exposes no fabricated semantic faces', () => {
  const object = {
    ...body(),
    edgeTreatment: { kind: 'fillet' as const, distanceMm: 0.5, edges: ['side:0'] },
  };
  assert.deepEqual(modelCadSelectableFaces(object), []);
  assert.equal(modelCadFaceAtPoint(object, { x: 0, y: 0, z: 4 }), null);
  const overlay = createModelCadFaceHighlight(object, ['profile:top']);
  assert.equal(overlay.children.length, 0);
  disposeModelCadFaceHighlight(overlay);
  const box = { kind: 'box' as const, size: { x: 10, y: 8, z: 4 }, holes: [] };
  const operand = () => ({
    shape: box,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
  });
  assert.deepEqual(
    modelCadSelectableFaces({
      ...body(),
      kind: 'boolean',
      boolean: { operation: 'union', operands: [operand(), operand()] },
    }),
    [],
  );
});
