import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { modelCadMesh } from '../components/model-cad-mesh';
import type { ModelCadObject } from '../lib/model-cad';
import { modelPickResult } from '../lib/model-picking';

const all = { cad: true, components: true };

function fixture() {
  const scene = new THREE.Group();
  const geometry = new THREE.BoxGeometry(10, 10, 2);
  const material = new THREE.MeshBasicMaterial();
  function add(z: number, data: Record<string, unknown>) {
    const parent = new THREE.Group();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.z = z;
    Object.assign(mesh.userData, data);
    parent.add(mesh);
    scene.add(parent);
    return { parent, mesh };
  }
  const preview = add(30, { modelCadId: 'preview', modelCadPreview: true });
  const cad = add(20, { modelCadId: 'saved-cad' });
  const component = add(10, {});
  component.parent.userData.footprintId = 'component';
  const board = add(0, {});
  const ray = (bottom = false) => {
    scene.updateMatrixWorld(true);
    return new THREE.Raycaster(
      new THREE.Vector3(0, 0, bottom ? -100 : 100),
      new THREE.Vector3(0, 0, bottom ? 1 : -1),
    ).intersectObject(scene, true);
  };
  return {
    scene,
    preview,
    cad,
    component,
    board,
    ray,
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}

test('one depth-ordered ray retains CAD-preview and component occlusion policies', () => {
  const f = fixture();
  try {
    const result = modelPickResult(f.ray(), all);
    assert.equal(result.cad?.id, 'saved-cad', 'CAD picking skips transient previews.');
    assert.equal(result.cad?.local.z, 1);
    assert.equal(result.footprint, null, 'An opaque CAD preview occludes component inspection.');
    f.preview.parent.visible = false;
    assert.equal(
      modelPickResult(f.ray(), all).footprint,
      null,
      'A saved CAD solid also occludes a component.',
    );
    f.cad.parent.visible = false;
    const underneath = modelPickResult(f.ray(), all);
    assert.equal(underneath.cad, null);
    assert.equal(
      underneath.footprint,
      'component',
      'Native component identities resolve from their ancestors.',
    );
  } finally {
    f.dispose();
  }
});

test('hidden ancestors and disabled selection categories cannot expose objects behind nearer geometry', () => {
  const f = fixture();
  try {
    f.preview.parent.visible = false;
    assert.deepEqual(
      modelPickResult(f.ray(), { cad: false, components: true }),
      {
        cad: null,
        footprint: null,
      },
      'Disabling CAD selection does not make its opaque solid transparent to component picking.',
    );
    f.cad.parent.visible = false;
    assert.equal(modelPickResult(f.ray(), { cad: false, components: true }).footprint, 'component');
    assert.deepEqual(modelPickResult(f.ray(), { cad: false, components: false }), {
      cad: null,
      footprint: null,
    });
    f.component.parent.visible = false;
    assert.equal(
      modelPickResult(f.ray(), all).footprint,
      null,
      'A hidden component parent excludes every child mesh.',
    );
    f.component.parent.visible = true;
    assert.deepEqual(
      modelPickResult(f.ray(true), all),
      {
        cad: null,
        footprint: null,
      },
      'The PCB underside occludes all more distant objects when inspecting from below.',
    );
    f.board.parent.visible = false;
    const underside = modelPickResult(f.ray(true), all);
    assert.equal(underside.footprint, 'component');
    assert.equal(underside.cad, null, 'A nearer component occludes a more distant CAD solid.');
  } finally {
    f.dispose();
  }
});

test('shared ray results retain exact CAD local drilling coordinates through compound poses', () => {
  const body: ModelCadObject = {
    id: '03dca76b-41ae-44e3-8935-aebf970960dd',
    name: 'Rotated bracket',
    kind: 'box',
    size: { x: 20, y: 16, z: 8 },
    position: { x: 100, y: 80, z: 14 },
    rotation: { x: 20, y: 30, z: 40 },
    material: 'aluminium',
    opacity: 1,
    holes: [],
  };
  const saved = JSON.stringify(body);
  const group = new THREE.Group();
  group.position.set(10, -20, 3);
  group.rotation.set(0.1, 0.2, -0.1);
  const mesh = modelCadMesh(body);
  group.add(mesh);
  group.updateMatrixWorld(true);
  const local = new THREE.Vector3(1, -2, 4);
  const surface = mesh.localToWorld(local.clone());
  const direction = new THREE.Vector3(0, 0, -1).transformDirection(mesh.matrixWorld);
  const intersections = new THREE.Raycaster(
    surface.clone().addScaledVector(direction, -20),
    direction,
  ).intersectObject(group, true);
  const beforePoints = intersections.map((hit) => hit.point.toArray());
  const result = modelPickResult(intersections, all);
  assert.equal(result.cad?.id, body.id);
  for (const [key, expected] of Object.entries({ x: 1, y: 2, z: 4 }))
    assert.ok(Math.abs(result.cad!.local[key as 'x' | 'y' | 'z'] - expected) < 1e-9);
  assert.deepEqual(
    intersections.map((hit) => hit.point.toArray()),
    beforePoints,
    'Picking does not mutate shared hit positions.',
  );
  assert.equal(JSON.stringify(body), saved, 'Picking retains saved CAD data.');
  mesh.geometry.dispose();
  (mesh.material as THREE.Material).dispose();
});

test('separate rays never reuse a previous target or camera direction', () => {
  const f = fixture();
  try {
    const first = modelPickResult(f.ray(), all);
    f.scene.updateMatrixWorld(true);
    const secondRay = new THREE.Raycaster(
      new THREE.Vector3(30, 0, 100),
      new THREE.Vector3(0, 0, -1),
    );
    const second = modelPickResult(secondRay.intersectObject(f.scene, true), all);
    assert.equal(first.cad?.id, 'saved-cad');
    assert.deepEqual(second, { cad: null, footprint: null });
    assert.equal(modelPickResult(f.ray(), all).cad?.id, 'saved-cad');
  } finally {
    f.dispose();
  }
});
