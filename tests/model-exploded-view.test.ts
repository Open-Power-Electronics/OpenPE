import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createEmptyPCB } from '../lib/pcb-layout';
import { modelPlacement } from '../lib/pcb-models';
import { createModelExplodedView, defaultModelExplodedView } from '../lib/model-exploded-view';
import { modelCadMesh } from '../components/model-cad-mesh';
import { modelPickResult } from '../lib/model-picking';
import { modelVisibleBounds } from '../lib/model-visible-bounds';
import {
  createModelBoardDisplayGroups,
  createModelSolderMaskSurface,
  modelBoardDisplayColors,
  defaultModelBoardDisplay,
} from '../lib/model-board-display';
import type { ModelCadObject } from '../lib/model-cad';
import {
  createModelCadEdgeHighlight,
  modelCadEdgePaths,
  pickModelCadEdge,
} from '../components/model-cad-edges';

function fixture() {
  const board = createEmptyPCB();
  board.footprints = [-1, 1].map((side, index) => ({
    id: `part-${index}`,
    symbolId: null,
    libraryId: 'Test:Package',
    x: side * 10,
    y: 0,
    rotation: 0,
    side: side < 0 ? 'back' : 'front',
    pads: [],
    graphics: [],
  }));
  const root = new THREE.Group(),
    components = new THREE.Group(),
    cad = new THREE.Group();
  root.add(components, cad);
  const geometry = new THREE.BoxGeometry(2, 2, 2),
    material = new THREE.MeshBasicMaterial();
  const add = (index: number) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.footprintId = `part-${index}`;
    mesh.position.set(index ? 10 : -10, 0, index ? 2 : -1);
    components.add(mesh);
    return mesh;
  };
  const bottom = add(0),
    top = add(1);
  const body: ModelCadObject = {
    id: 'cover',
    name: 'Cover',
    kind: 'box',
    size: { x: 8, y: 6, z: 2 },
    position: { x: 0, y: 0, z: 5 },
    rotation: { x: 0, y: 0, z: 0 },
    material: 'aluminium',
    opacity: 1,
  };
  const cover = modelCadMesh(body);
  cad.add(cover);
  const layers = createModelBoardDisplayGroups(root, defaultModelBoardDisplay());
  const explosion = createModelExplodedView(board, components, layers);
  root.updateWorldMatrix(true, true);
  return {
    board,
    root,
    components,
    cad,
    geometry,
    material,
    top,
    bottom,
    body,
    cover,
    layers,
    explosion,
    add,
  };
}

function assemblyFixture(side: 'front' | 'back' = 'front') {
  const f = fixture();
  f.components.clear();
  f.board.footprints = [{ ...f.board.footprints[1], side, x: 0, y: 0 }];
  const instances: THREE.Group[] = [];
  const add = (z: number, size: [number, number, number] = [8, 8, 3]) => {
    const group = new THREE.Group();
    group.userData.footprintId = f.board.footprints[0].id;
    group.position.z = side === 'front' ? 0.8 : -0.8;
    const body = new THREE.Mesh(new THREE.BoxGeometry(...size), f.material);
    body.position.z = z;
    group.add(body);
    f.components.add(group);
    instances.push(group);
    return { group, body };
  };
  const dispose = () => {
    for (const instance of instances)
      instance.traverse((node) => {
        if (node instanceof THREE.Mesh) node.geometry.dispose();
      });
    f.geometry.dispose();
    f.material.dispose();
  };
  return { ...f, addInstance: add, dispose };
}

test('assembled geometry overrides footprint side without letting finely tessellated leads dominate', () => {
  for (const side of ['front', 'back'] as const) {
    const f = assemblyFixture(side);
    const sign = side === 'front' ? -1 : 1;
    const { group } = f.addInstance(sign * 5);
    const lead = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 18, 1, 1, 200), f.material);
    group.add(lead);
    const pose = group.position.clone();
    const native = JSON.stringify(f.board);
    const explosion = createModelExplodedView(f.board, f.components, f.layers);
    try {
      explosion.apply({ ...defaultModelExplodedView, distance: 2 });
      assert.equal(group.position.z, pose.z + sign * 8);
      explosion.apply(defaultModelExplodedView);
      assert.deepEqual(group.position, pose);
      assert.equal(JSON.stringify(f.board), native);
    } finally {
      f.dispose();
    }
  }
});

test('side detection includes nested rotations, offsets, nonuniform scale and the PCB coordinate frame', () => {
  const f = assemblyFixture('back');
  const { group, body } = f.addInstance(-4);
  const transformed = new THREE.Group();
  group.remove(body);
  transformed.add(body);
  transformed.rotation.x = Math.PI;
  transformed.position.z = 1;
  transformed.scale.set(2, 0.7, 1.5);
  group.add(transformed);
  // Global camera-scene transforms must not change the board's native Z side.
  f.root.position.set(12, 15, 30);
  f.root.rotation.set(0.4, 0.6, 0.2);
  const pose = group.position.clone();
  const explosion = createModelExplodedView(f.board, f.components, f.layers);
  try {
    explosion.apply({ ...defaultModelExplodedView, distance: 2 });
    assert.equal(group.position.z, pose.z + 8);
    explosion.apply(defaultModelExplodedView);
    assert.deepEqual(group.position, pose);
  } finally {
    f.dispose();
  }
});

test('late instances share one footprint geometry vote and never accumulate exploded offsets', () => {
  const f = assemblyFixture();
  const first = f.addInstance(3, [1, 1, 1]);
  const explosion = createModelExplodedView(f.board, f.components, f.layers);
  const settings = { ...defaultModelExplodedView, distance: 2 };
  try {
    explosion.apply(settings);
    assert.equal(first.group.position.z, 8.8);
    const second = f.addInstance(-5);
    for (let i = 0; i < 3; i++) {
      explosion.apply(settings);
      assert.equal(first.group.position.z, -7.2);
      assert.equal(second.group.position.z, -7.2);
    }
    explosion.apply(defaultModelExplodedView);
    assert.equal(first.group.position.z, 0.8);
    assert.equal(second.group.position.z, 0.8);
  } finally {
    f.dispose();
  }
});

test('balanced, embedded, unavailable and estimated geometry retain footprint side', () => {
  for (const kind of ['balanced', 'embedded', 'unavailable', 'estimated']) {
    const f = assemblyFixture('back');
    const { group, body } = f.addInstance(0.8, [1, 1, kind === 'balanced' ? 8 : 0.2]);
    if (kind === 'unavailable') body.visible = false;
    if (kind === 'estimated') {
      group.userData.estimated = true;
      body.position.z = 8;
    }
    const explosion = createModelExplodedView(f.board, f.components, f.layers);
    try {
      explosion.apply({ ...defaultModelExplodedView, distance: 2 });
      assert.equal(group.position.z, -8.8, kind);
    } finally {
      f.dispose();
    }
  }
});

test('radial geometry uses the assembled body centre and retains the resolved lower side', () => {
  const f = assemblyFixture();
  const { group, body } = f.addInstance(-5);
  body.position.x = 30;
  const explosion = createModelExplodedView(f.board, f.components, f.layers);
  try {
    const settings = { ...defaultModelExplodedView, distance: 2, direction: 'radial' as const };
    explosion.apply(settings);
    assert.ok(group.position.x > 0);
    assert.ok(group.position.z < 0.8);
    const pose = group.position.clone();
    explosion.apply(settings);
    assert.deepEqual(group.position, pose);
    explosion.apply(defaultModelExplodedView);
    assert.deepEqual(group.position.toArray(), [0, 0, 0.8]);
  } finally {
    f.dispose();
  }
});

test('exploded poses are reversible and retain shared geometry, material, native objects and late model instances', () => {
  const f = fixture();
  const native = JSON.stringify([f.board, f.body]);
  const poses = [f.top.position.clone(), f.bottom.position.clone(), f.cover.position.clone()];
  const settings = { ...defaultModelExplodedView, distance: 2 };
  f.explosion.apply(settings);
  assert.equal(f.top.position.z, poses[0].z + 8);
  assert.equal(f.bottom.position.z, poses[1].z - 8);
  assert.deepEqual(f.cover.position, poses[2], 'CAD bodies keep their assembly pose.');
  const first = f.cover.position.clone();
  f.explosion.apply(settings);
  assert.deepEqual(f.cover.position, first, 'Repeated renders must not accumulate offsets.');
  const late = f.add(1);
  f.explosion.apply(settings);
  assert.deepEqual(
    late.position,
    f.top.position,
    'A late STEP instance follows its component group.',
  );
  assert.equal(late.geometry, f.geometry);
  assert.equal(late.material, f.material);
  f.explosion.apply(defaultModelExplodedView);
  assert.deepEqual([f.top.position, f.bottom.position, f.cover.position], poses);
  assert.equal(JSON.stringify([f.board, f.body]), native);
  f.geometry.dispose();
  f.material.dispose();
});

test('radial explosion affects component bounds and picking while CAD bodies remain fixed', () => {
  const f = fixture();
  const coverPose = f.cover.position.clone();
  const before = modelVisibleBounds(f.root);
  const settings = { ...defaultModelExplodedView, distance: 20, direction: 'radial' as const };
  f.explosion.apply(settings);
  assert.ok(f.top.position.x > 10 && f.bottom.position.x < -10);
  assert.deepEqual(f.cover.position, coverPose);
  assert.ok(modelVisibleBounds(f.root).max.x > before.max.x);
  const ray = new THREE.Raycaster(
    f.top.position.clone().add(new THREE.Vector3(0, 0, 100)),
    new THREE.Vector3(0, 0, -1),
  );
  assert.equal(
    modelPickResult(ray.intersectObject(f.root, true), { cad: true, components: true }).footprint,
    'part-1',
  );
  f.explosion.apply(settings);
  f.explosion.apply(defaultModelExplodedView);
  assert.deepEqual(f.cover.position, coverPose);
  assert.throws(() => f.explosion.apply({ ...settings, distance: Infinity }), /distance/);
  f.geometry.dispose();
  f.material.dispose();
});

test('CAD edge picking and highlights retain the assembled pose during PCB explosion', () => {
  const f = fixture();
  f.explosion.apply({ ...defaultModelExplodedView, distance: 2 });
  const body = f.body;
  const camera = new THREE.OrthographicCamera(-30, 30, 30, -30, 0.1, 1000);
  camera.position.set(35, -45, 80);
  camera.lookAt(0, 0, 20);
  camera.updateMatrixWorld(true);
  const path = modelCadEdgePaths(body)[0];
  const local = path.points[0].clone().lerp(path.points[1], 0.5);
  const world = local.applyMatrix4(f.cover.matrixWorld);
  const projected = world.clone().project(camera);
  const edge = pickModelCadEdge({
    object: body,
    camera,
    viewport: { width: 800, height: 800 },
    point: { x: (projected.x + 1) * 400, y: (1 - projected.y) * 400 },
    scene: f.root,
    target: f.cover,
  });
  assert.ok(edge, 'The stationary CAD edge remains selectable.');
  const highlight = createModelCadEdgeHighlight(body, [edge]);
  assert.ok(!modelVisibleBounds(highlight).isEmpty());
  assert.deepEqual(
    modelCadEdgePaths(body).map((item) => item.edge.id),
    modelCadEdgePaths(f.body).map((item) => item.edge.id),
  );
  f.geometry.dispose();
  f.material.dispose();
});

test('four-layer PCB copper, masks and silkscreens separate in physical stack order and restore exactly', () => {
  const board = createEmptyPCB();
  board.layers = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'];
  const root = new THREE.Group(),
    components = new THREE.Group();
  const layers = createModelBoardDisplayGroups(root, defaultModelBoardDisplay());
  const geometry = new THREE.PlaneGeometry(10, 10),
    material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const names = ['B.SilkS', 'B.Mask', 'B.Cu', 'In2.Cu', 'In1.Cu', 'F.Cu', 'F.Mask', 'F.SilkS'];
  const surfaces = names.map((name, index) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData.modelExplosionLayer = name;
    mesh.position.z = (index - 3.5) * 0.1;
    layers[name.endsWith('Mask') ? 'mask' : name.endsWith('SilkS') ? 'silkscreen' : 'copper'].add(
      mesh,
    );
    return mesh;
  });
  const before = surfaces.map((mesh) => mesh.position.clone());
  const explosion = createModelExplodedView(board, components, layers);
  explosion.apply({ ...defaultModelExplodedView, distance: 2, direction: 'vertical' });
  assert.deepEqual(
    surfaces.map((mesh, i) => Number((mesh.position.z - before[i].z).toFixed(6))),
    [-8, -6, -4, -2, 2, 4, 6, 8],
  );
  assert.equal(layers.substrate.position.z, 0, 'The board core remains the assembly reference.');
  explosion.apply({ ...defaultModelExplodedView, distance: 4, direction: 'radial' });
  for (let i = 1; i < surfaces.length; i++)
    assert.ok(surfaces[i].position.z > surfaces[i - 1].position.z);
  explosion.apply(defaultModelExplodedView);
  assert.deepEqual(
    surfaces.map((mesh) => mesh.position),
    before,
  );
  geometry.dispose();
  material.dispose();
});

test('rebuilding an exploded board after a thickness edit retains spread and recalculates both surface/component bases', () => {
  const board = fixture().board;
  const settings = { ...defaultModelExplodedView, distance: 3, direction: 'vertical' as const };
  const geometry = new THREE.PlaneGeometry(1, 1),
    material = new THREE.MeshBasicMaterial();
  const positions = (thickness: number) => {
    const next = { ...board, thickness };
    const groups = createModelBoardDisplayGroups(new THREE.Group(), defaultModelBoardDisplay());
    const components = new THREE.Group();
    const copper = ['F.Cu', 'B.Cu'].map((layer) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.z = (layer === 'F.Cu' ? 1 : -1) * (thickness / 2 + 0.015);
      mesh.userData.modelExplosionLayer = layer;
      groups.copper.add(mesh);
      return mesh;
    });
    const parts = next.footprints.map((footprint) => {
      const mesh = new THREE.Mesh(geometry, material);
      const pose = modelPlacement(footprint, thickness);
      mesh.position.set(pose.x, pose.y, pose.z);
      mesh.userData.footprintId = footprint.id;
      components.add(mesh);
      return mesh;
    });
    const explosion = createModelExplodedView(next, components, groups);
    explosion.apply(settings);
    return {
      copper: copper.map((mesh) => mesh.position.z),
      parts: parts.map((mesh) => mesh.position.z),
    };
  };
  try {
    const before = positions(1.6),
      after = positions(2.4);
    const near = (actual: number, expected: number) =>
      assert.ok(Math.abs(actual - expected) < 1e-9);
    near(after.copper[0] - before.copper[0], 0.4);
    near(after.copper[1] - before.copper[1], -0.4);
    near(after.parts[0] - before.parts[0], -0.4);
    near(after.parts[1] - before.parts[1], 0.4);
    near(after.copper[0] - (2.4 / 2 + 0.015), settings.distance);
    near(after.parts[1] - 2.4 / 2, settings.distance * 4);
    assert.deepEqual(settings, { ...defaultModelExplodedView, distance: 3, direction: 'vertical' });
    assert.equal(board.thickness, 1.6);
  } finally {
    geometry.dispose();
    material.dispose();
  }
});

test('exploded solder-mask sheets are opaque and complete from both sides, retaining apertures and assembly paint', () => {
  const board = createEmptyPCB();
  const native = JSON.stringify(board);
  const groups = createModelBoardDisplayGroups(new THREE.Group(), defaultModelBoardDisplay());
  const outline = new THREE.Shape()
    .moveTo(0, 0)
    .lineTo(10, 0)
    .lineTo(10, 10)
    .lineTo(0, 10)
    .closePath();
  outline.holes.push(
    new THREE.Path().moveTo(4, 4).lineTo(6, 4).lineTo(6, 6).lineTo(4, 6).closePath(),
  );
  const geometry = new THREE.ShapeGeometry(outline);
  const vertices = [...geometry.attributes.position.array];
  const masks = ['F.Mask', 'B.Mask'].map((layer) => {
    const mesh = createModelSolderMaskSurface(geometry);
    mesh.userData.modelExplosionLayer = layer;
    mesh.position.z = layer === 'F.Mask' ? 0.82 : -0.82;
    groups.mask.add(mesh);
    return mesh;
  });
  const otherPaint = new THREE.MeshBasicMaterial({
    color: 0xc3a15f,
    opacity: 0.8,
    transparent: true,
  });
  const copper = new THREE.Mesh(geometry, otherPaint);
  groups.copper.add(copper);
  const explosion = createModelExplodedView(board, new THREE.Group(), groups);
  const identities = masks.map((mask) => mask.material);
  try {
    for (const direction of ['vertical', 'radial'] as const) {
      explosion.apply({ ...defaultModelExplodedView, distance: 3, direction });
      for (const mask of masks) {
        assert.equal(
          mask.material.transparent,
          true,
          'The same lacquer tint remains active on the detached backing.',
        );
        assert.equal(mask.material.opacity, 0.9);
        assert.equal(mask.material.blending, THREE.MultiplyBlending);
        assert.equal(mask.material.premultipliedAlpha, true);
        assert.equal(mask.material.depthWrite, false);
        assert.equal(mask.material.side, THREE.DoubleSide);
        assert.equal(mask.geometry, geometry);
        const backing = mask.children[0] as THREE.Mesh<
          THREE.BufferGeometry,
          THREE.MeshStandardMaterial
        >;
        assert.equal(backing.visible, true);
        assert.equal(backing.geometry, geometry);
        assert.equal(backing.material.transparent, false);
        assert.equal(backing.material.depthWrite, true);
        assert.equal(backing.material.color.getHex(), modelBoardDisplayColors.substrate);
        assert.equal(backing.material.roughness, 0.8);
        assert.equal(mask.material.color.getHex(), modelBoardDisplayColors.mask);
        assert.deepEqual(backing.position.toArray(), [0, 0, 0]);
      }
      for (const side of [1, -1]) {
        const ray = (x: number, y: number) =>
          new THREE.Raycaster(
            new THREE.Vector3(x, y, side * 100),
            new THREE.Vector3(0, 0, -side),
          ).intersectObject(groups.mask, true);
        assert.ok(ray(2, 2).length > 0, 'Both faces retain the whole coating interior.');
        assert.equal(ray(5, 5).length, 0, 'Real pad/drill openings remain empty.');
      }
      const versions = masks.map((mask) => mask.material.version);
      explosion.apply({ ...defaultModelExplodedView, distance: 4, direction });
      assert.deepEqual(
        masks.map((mask) => mask.material.version),
        versions,
        'Navigation does not repeatedly recompile unchanged mask paint.',
      );
    }
    explosion.apply(defaultModelExplodedView);
    for (const [index, mask] of masks.entries()) {
      assert.equal(mask.material, identities[index]);
      assert.equal(mask.material.transparent, true);
      assert.equal(mask.material.opacity, 0.9);
      assert.equal(mask.material.blending, THREE.MultiplyBlending);
      assert.equal(mask.material.premultipliedAlpha, true);
      assert.equal(mask.material.depthWrite, false);
      assert.equal(mask.children[0].visible, false);
      assert.equal(mask.position.z, index === 0 ? 0.82 : -0.82);
    }
    assert.deepEqual([...geometry.attributes.position.array], vertices);
    assert.equal(otherPaint.opacity, 0.8);
    assert.equal(otherPaint.transparent, true);
    assert.equal(otherPaint.blending, THREE.NormalBlending);
    assert.equal(JSON.stringify(board), native);
  } finally {
    geometry.dispose();
    otherPaint.dispose();
    masks.forEach((mask) => {
      mask.material.dispose();
      (
        mask.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
      ).material.dispose();
    });
  }
});
