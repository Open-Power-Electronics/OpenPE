import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  applyModelBoardDisplay,
  createModelBoardDisplayGroups,
  defaultModelBoardDisplay,
  modelBoardDisplayLayers,
} from '../lib/model-board-display';
import { modelPickResult } from '../lib/model-picking';
import { modelVisibleBounds } from '../lib/model-visible-bounds';

test('one copper control hides tracks, pads, vias and zones from picking and Fit without changing geometry', () => {
  const root = new THREE.Group();
  const display = defaultModelBoardDisplay();
  const groups = createModelBoardDisplayGroups(root, display);
  const geometry = new THREE.BoxGeometry(10, 10, 1);
  const material = new THREE.MeshBasicMaterial({ color: 0xc3a15f });
  try {
    const substrate = new THREE.Mesh(geometry, material);
    const copper = ['track', 'pad', 'via', 'zone'].map((name, index) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = name;
      mesh.position.set(100 + index * 20, 0, 2);
      return mesh;
    });
    groups.substrate.add(substrate);
    groups.copper.add(...copper);
    root.updateMatrixWorld(true);
    const geometryBefore = [...geometry.attributes.position.array];
    const poses = copper.map((mesh) => mesh.matrixWorld.clone());
    const hit = (x: number) =>
      modelPickResult(
        new THREE.Raycaster(
          new THREE.Vector3(x, 0, 20),
          new THREE.Vector3(0, 0, -1),
        ).intersectObject(root, true),
        { cad: false, components: false, board: true },
      );
    for (const mesh of copper) assert.equal(hit(mesh.position.x).board, true);
    assert.equal(modelVisibleBounds(root).max.x, 165);
    applyModelBoardDisplay(groups, { ...display, copper: false });
    for (const mesh of copper)
      assert.equal(
        hit(mesh.position.x).board,
        false,
        `Hidden ${mesh.name} must not remain pickable.`,
      );
    assert.equal(modelVisibleBounds(root).max.x, 5, 'Fit excludes hidden copper.');
    assert.equal(groups.mask.visible, true, 'Copper and mask remain independent.');
    assert.equal(groups.silkscreen.visible, true);
    for (const [index, mesh] of copper.entries()) {
      assert.equal(mesh.material, material);
      assert.equal(mesh.geometry, geometry);
      assert.deepEqual(mesh.matrixWorld, poses[index]);
    }
    assert.deepEqual([...geometry.attributes.position.array], geometryBefore);
    applyModelBoardDisplay(groups, display);
    for (const mesh of copper) assert.equal(hit(mesh.position.x).board, true);
    assert.equal(modelVisibleBounds(root).max.x, 165);
  } finally {
    geometry.dispose();
    material.dispose();
  }
});

test('hiding every PCB surface reveals components behind it and stays effective for late meshes', () => {
  const root = new THREE.Group();
  const display = defaultModelBoardDisplay();
  const groups = createModelBoardDisplayGroups(root, display);
  const geometry = new THREE.BoxGeometry(10, 10, 1);
  const material = new THREE.MeshBasicMaterial();
  const component = new THREE.Mesh(geometry, material);
  component.userData.footprintId = 'component';
  component.position.z = -10;
  root.add(component);
  try {
    const hidden = { ...display };
    for (const { key } of modelBoardDisplayLayers) {
      groups[key].add(new THREE.Mesh(geometry, material));
      hidden[key] = false;
    }
    const pick = () => {
      root.updateMatrixWorld(true);
      return modelPickResult(
        new THREE.Raycaster(
          new THREE.Vector3(0, 0, 20),
          new THREE.Vector3(0, 0, -1),
        ).intersectObject(root, true),
        { cad: false, components: true, board: true },
      );
    };
    assert.equal(pick().board, true);
    assert.equal(pick().footprint, null);
    applyModelBoardDisplay(groups, hidden);
    groups.silkscreen.add(new THREE.Mesh(geometry, material));
    assert.equal(pick().board, false);
    assert.equal(pick().footprint, 'component');
    assert.equal(modelVisibleBounds(root).max.z, -9.5);
    assert.equal(component.visible, true);
    const rebuilt = createModelBoardDisplayGroups(new THREE.Group(), hidden);
    assert.ok(Object.values(rebuilt).every((group) => !group.visible));
  } finally {
    geometry.dispose();
    material.dispose();
  }
});

test('mask and silk groups retain compositing order across display toggles', () => {
  const display = defaultModelBoardDisplay();
  const groups = createModelBoardDisplayGroups(new THREE.Group(), display);
  applyModelBoardDisplay(groups, { ...display, mask: false });
  assert.equal(groups.copper.visible, true);
  assert.equal(groups.silkscreen.visible, true);
  for (const { key } of modelBoardDisplayLayers) {
    assert.equal(groups[key].userData.modelBoard, true);
    assert.equal(groups[key].renderOrder, key === 'silkscreen' ? 2 : key === 'mask' ? 1 : 0);
  }
});
