import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createModelCadOperandGhosts } from '../components/model-cad-operand-ghosts';
import { modelPickResult } from '../lib/model-picking';

function fixture() {
  const scene = new THREE.Group();
  const source = new THREE.Group();
  const ghosts = new THREE.Group();
  const geometry = new THREE.BoxGeometry(10, 8, 6);
  const material = new THREE.MeshBasicMaterial({ color: 0xff6600 });
  function body(id: string, x = 0) {
    const group = new THREE.Group();
    group.userData.modelCadId = id;
    group.position.x = x;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.modelCadId = id;
    group.add(mesh);
    source.add(group);
    return { group, mesh };
  }
  scene.add(source, ghosts);
  const controller = createModelCadOperandGhosts(ghosts);
  return {
    scene,
    source,
    ghosts,
    geometry,
    material,
    body,
    controller,
    dispose: () => {
      controller.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}

test('visible operand ghosts pick the real owner while sharing exact geometry and preserving hidden sources', () => {
  const f = fixture();
  const a = f.body('a');
  const b = f.body('b', 30);
  a.group.visible = false;
  const before = {
    color: f.material.color.getHex(),
    visible: a.group.visible,
    geometry: a.mesh.geometry,
    material: a.mesh.material,
  };
  try {
    f.controller.update(f.source, ['a'], false);
    assert.equal(f.ghosts.children.length, 1);
    const ghost = f.ghosts.children[0];
    const mesh = ghost.children[0] as THREE.Mesh;
    assert.equal(ghost.visible, true);
    assert.equal(mesh.visible, true);
    assert.equal(mesh.geometry, f.geometry);
    assert.notEqual(mesh.material, f.material);
    assert.equal((mesh.material as THREE.MeshBasicMaterial).wireframe, true);
    assert.equal(mesh.userData.modelCadOperandGhost, true);
    assert.equal(mesh.userData.modelCadId, 'a');
    assert.equal(mesh.userData.modelCadPreview, undefined);
    f.scene.updateMatrixWorld(true);
    const hits = new THREE.Raycaster(
      new THREE.Vector3(0, 0, 100),
      new THREE.Vector3(0, 0, -1),
    ).intersectObject(f.scene, true);
    assert.equal(modelPickResult(hits, { cad: true, components: false }).cad?.id, 'a');
    assert.equal(a.group.visible, before.visible);
    assert.equal(a.mesh.geometry, before.geometry);
    assert.equal(a.mesh.material, before.material);
    assert.equal(f.material.color.getHex(), before.color);
    assert.equal(b.group.visible, true, 'An unselected source body is never hidden or ghosted.');
  } finally {
    f.dispose();
  }
});

test('unchanged operand/theme updates retain ghost resources and refresh the exact source pose', () => {
  const f = fixture();
  const a = f.body('a');
  f.source.position.set(2, 3, 4);
  f.ghosts.position.set(-5, 2, 1);
  try {
    f.controller.update(f.source, ['a'], false);
    const ghost = f.ghosts.children[0];
    const mesh = ghost.children[0] as THREE.Mesh;
    const material = mesh.material;
    f.controller.update(f.source, ['a', 'a'], false);
    assert.equal(f.ghosts.children[0], ghost);
    assert.equal((ghost.children[0] as THREE.Mesh).material, material);
    a.group.position.set(13, -4, 7);
    a.group.rotation.set(0.1, 0.2, 0.3);
    f.controller.update(f.source, ['a'], false);
    f.scene.updateMatrixWorld(true);
    assert.equal(f.ghosts.children[0], ghost);
    const point = new THREE.Vector3(1, 2, 3);
    assert.ok(
      a.group.localToWorld(point.clone()).distanceTo(ghost.localToWorld(point.clone())) < 1e-9,
    );
  } finally {
    f.dispose();
  }
});

test('replacement and retirement dispose only independent ghost materials, never source geometry or materials', () => {
  const f = fixture();
  const first = f.body('a');
  let sourceGeometryDisposals = 0;
  let sourceMaterialDisposals = 0;
  f.geometry.addEventListener('dispose', () => sourceGeometryDisposals++);
  f.material.addEventListener('dispose', () => sourceMaterialDisposals++);
  try {
    f.controller.update(f.source, ['a'], false);
    const ghost = f.ghosts.children[0];
    let ghostDisposals = 0;
    ((ghost.children[0] as THREE.Mesh).material as THREE.Material).addEventListener(
      'dispose',
      () => ghostDisposals++,
    );
    f.source.remove(first.group);
    const next = f.body('a', 20);
    f.controller.update(f.source, ['a'], false);
    assert.equal(ghost.parent, null);
    assert.equal(ghostDisposals, 1);
    assert.notEqual(f.ghosts.children[0], ghost);
    assert.equal(f.ghosts.children[0].position.x, next.group.position.x);
    const themed = f.ghosts.children[0];
    let themedDisposals = 0;
    ((themed.children[0] as THREE.Mesh).material as THREE.Material).addEventListener(
      'dispose',
      () => themedDisposals++,
    );
    f.controller.update(f.source, ['a'], true);
    assert.equal(themedDisposals, 1);
    assert.notEqual(f.ghosts.children[0], themed);
    const last = f.ghosts.children[0];
    let lastDisposals = 0;
    ((last.children[0] as THREE.Mesh).material as THREE.Material).addEventListener(
      'dispose',
      () => lastDisposals++,
    );
    f.controller.dispose();
    f.controller.dispose();
    f.controller.update(f.source, ['a'], false);
    assert.equal(lastDisposals, 1);
    assert.equal(f.ghosts.children.length, 0);
    assert.equal(sourceGeometryDisposals, 0);
    assert.equal(sourceMaterialDisposals, 0);
  } finally {
    f.dispose();
  }
});

test('selection changes remove stale operands and advanced subtree ghosts remove preview ownership tags', () => {
  const f = fixture();
  const a = f.body('a');
  f.body('b', 30);
  a.mesh.userData.modelCadPreview = true;
  a.group.userData.modelCadPreview = true;
  a.group.visible = false;
  try {
    f.controller.update(f.source, ['a', 'missing'], false);
    const old = f.ghosts.children[0];
    assert.equal(old.userData.modelCadPreview, undefined);
    assert.equal(old.children[0].userData.modelCadPreview, undefined);
    f.controller.update(f.source, ['b'], false);
    assert.equal(old.parent, null);
    assert.deepEqual(
      f.ghosts.children.map((ghost) => ghost.userData.modelCadId),
      ['b'],
    );
    f.controller.update(f.source, [], false);
    assert.equal(f.ghosts.children.length, 0);
  } finally {
    f.dispose();
  }
});
