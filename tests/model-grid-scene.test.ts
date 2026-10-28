import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { createModelGridScene } from '../components/model-grid-scene';

const options = {
  visible: true,
  dark: false,
  spacing: 0.5,
  pixelsPerUnit: 24,
  bounds: { minX: -3, maxX: 4, minY: -2, maxY: 3 },
};

function gridLines(root: THREE.Group) {
  const lines = root.children.find(
    (object): object is THREE.LineSegments => object instanceof THREE.LineSegments,
  );
  assert.ok(lines, 'The grid uses intersecting line segments.');
  return lines;
}

test('Model grid lines share a plane-local origin and the selected spacing in both axes', () => {
  const root = new THREE.Group();
  const scene = createModelGridScene(root);
  try {
    scene.update(options);
    const lines = gridLines(root);
    const positions = lines.geometry.getAttribute('position');
    const xLines: number[] = [];
    const yLines: number[] = [];
    assert.equal(lines.visible, true);
    assert.equal(lines.userData.modelGridDisplaySpacing, options.spacing);
    for (let i = 0; i < positions.count; i += 2) {
      const a = new THREE.Vector3().fromBufferAttribute(positions, i);
      const b = new THREE.Vector3().fromBufferAttribute(positions, i + 1);
      assert.equal(a.z, 0);
      assert.equal(b.z, 0);
      assert.ok(a.x === b.x || a.y === b.y, 'Each line follows a workplane axis.');
      assert.ok(a.distanceTo(b) > 0);
      if (a.x === b.x) xLines.push(a.x);
      else yLines.push(a.y);
    }
    for (const coordinates of [xLines, yLines]) {
      coordinates.sort((a, b) => a - b);
      assert.ok(coordinates.includes(0));
      assert.ok(coordinates.length > 2);
      for (let i = 1; i < coordinates.length; i++)
        assert.equal(coordinates[i] - coordinates[i - 1], options.spacing);
    }
  } finally {
    scene.dispose();
  }
});

test('grid density coarsens by powers of two and remains bounded at extreme view scales', () => {
  const root = new THREE.Group();
  const scene = createModelGridScene(root);
  try {
    for (const pixelsPerUnit of [0.5, 0.001, 0.000000001]) {
      scene.update({
        ...options,
        pixelsPerUnit,
        bounds: { minX: -1e6, maxX: 1e6, minY: -2e6, maxY: 2e6 },
      });
      const lines = gridLines(root);
      const step = Number(lines.userData.modelGridDisplaySpacing);
      assert.ok(Number.isFinite(step));
      assert.ok(step * pixelsPerUnit >= 6);
      assert.ok(Number.isInteger(Math.log2(step / options.spacing)));
      const positions = lines.geometry.getAttribute('position');
      assert.ok(positions.count > 0 && positions.count <= 1028);
      assert.ok(Array.from(positions.array).every(Number.isFinite));
      const bounds = lines.userData.modelGridBounds;
      assert.ok(bounds.minX <= -1e6 && bounds.maxX >= 1e6);
      assert.ok(bounds.minY <= -2e6 && bounds.maxY >= 2e6);
    }
  } finally {
    scene.dispose();
  }
});

test('theme, visibility and unchanged coverage reuse resources; replacement and disposal release them', () => {
  const root = new THREE.Group();
  const unrelated = new THREE.Object3D();
  root.add(unrelated);
  const scene = createModelGridScene(root);
  scene.update(options);
  const lines = gridLines(root);
  const geometry = lines.geometry;
  const material = lines.material as THREE.LineBasicMaterial;
  const color = material.color.getHex();
  const revision = lines.userData.modelGridGeometryRevision;
  let firstDisposals = 0;
  let materialDisposals = 0;
  geometry.addEventListener('dispose', () => firstDisposals++);
  material.addEventListener('dispose', () => materialDisposals++);
  try {
    scene.update({ ...options, dark: true });
    assert.notEqual(material.color.getHex(), color);
    scene.update({ ...options, visible: false });
    assert.equal(lines.visible, false);
    scene.update(options);
    assert.equal(lines.visible, true);
    assert.equal(gridLines(root), lines);
    assert.equal(lines.geometry, geometry);
    assert.equal(lines.material, material);
    assert.equal(lines.userData.modelGridGeometryRevision, revision);
    assert.equal(firstDisposals, 0);
    assert.equal(materialDisposals, 0);

    scene.update({ ...options, spacing: 1 });
    assert.notEqual(lines.geometry, geometry);
    assert.equal(firstDisposals, 1);
    assert.equal(lines.material, material);
    let currentDisposals = 0;
    lines.geometry.addEventListener('dispose', () => currentDisposals++);
    scene.dispose();
    scene.dispose();
    assert.equal(currentDisposals, 1);
    assert.equal(materialDisposals, 1);
    assert.deepEqual(root.children, [unrelated]);
  } finally {
    scene.dispose();
  }
});

test('an edge-on or unavailable grid scale hides the lines without replacing retained geometry', () => {
  const root = new THREE.Group();
  const scene = createModelGridScene(root);
  try {
    scene.update(options);
    const lines = gridLines(root);
    const geometry = lines.geometry;
    for (const pixelsPerUnit of [0, Number.NaN, Number.POSITIVE_INFINITY]) {
      scene.update({ ...options, pixelsPerUnit });
      assert.equal(lines.visible, false);
      assert.equal(lines.geometry, geometry);
    }
    scene.update(options);
    assert.equal(lines.visible, true);
    assert.equal(lines.geometry, geometry);
  } finally {
    scene.dispose();
  }
});
