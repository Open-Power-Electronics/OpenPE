import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createModelCadScene } from '../components/model-cad-scene';
import { uid } from '../lib/circuit';
import { validateModelCadObject, type ModelCadObject, type ModelCadVector } from '../lib/model-cad';
import { disposeModelGroup } from '../lib/model-mesh';
import { createModelSelection } from '../lib/model-selection';
import type { MeshData } from '../lib/model-mesh';

const body = (): ModelCadObject =>
  validateModelCadObject({
    id: uid(),
    name: 'Mount',
    kind: 'box',
    position: { x: 100, y: 88, z: 20 },
    rotation: { x: 0, y: 0, z: 0 },
    size: { x: 20, y: 16, z: 10 },
    material: 'aluminium',
    opacity: 1,
  });

function fixture() {
  const root = new THREE.Group();
  const selection = createModelSelection(root, 'modelCadId');
  const scene = createModelCadScene(root, () => selection.dispose());
  const mesh = (id: string) => {
    const found = root.children.find((child) => child.userData.modelCadId === id);
    assert.ok(found instanceof THREE.Mesh);
    return found as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  };
  return { root, selection, scene, mesh };
}

function disposed(geometry: THREE.BufferGeometry, material: THREE.Material) {
  const counts = { geometry: 0, material: 0 };
  geometry.addEventListener('dispose', () => counts.geometry++);
  material.addEventListener('dispose', () => counts.material++);
  return counts;
}

// Independent native intrinsic Rx * Ry * Rz, followed by scene Y reflection.
// This does not use the scene helper's Euler or object matrix.
function scenePoint(object: ModelCadObject, point: ModelCadVector) {
  const angles = [object.rotation.x, object.rotation.y, object.rotation.z].map(
    (angle) => (angle * Math.PI) / 180,
  );
  const [sx, sy, sz] = angles.map(Math.sin);
  const [cx, cy, cz] = angles.map(Math.cos);
  const zx = cz * point.x - sz * point.y;
  const zy = sz * point.x + cz * point.y;
  const yx = cy * zx + sy * point.z;
  const yz = -sy * zx + cy * point.z;
  return new THREE.Vector3(
    yx + object.position.x,
    -(cx * zy - sx * yz + object.position.y),
    sx * zy + cx * yz + object.position.z,
  );
}

function nativeRay(object: ModelCadObject, x: number, y: number) {
  const start = scenePoint(object, { x, y, z: 30 });
  const end = scenePoint(object, { x, y, z: -30 });
  return new THREE.Raycaster(start, end.sub(start).normalize());
}

test('CAD Move and compound Rotate retain mesh resources and apply exact native-axis poses', () => {
  const { root, scene, mesh } = fixture();
  const first = body(),
    other = body();
  scene.update([first, other]);
  const original = mesh(first.id),
    untouched = mesh(other.id);
  const geometry = original.geometry,
    material = original.material;
  const counts = disposed(geometry, material);
  const next = {
    ...first,
    name: 'Moved mount',
    position: { x: 53.8, y: 112.6, z: 6 },
    rotation: { x: 17, y: 31, z: 43 },
  };
  const before = JSON.stringify(next);
  try {
    scene.update([next, structuredClone(other)]);
    assert.equal(mesh(first.id), original);
    assert.equal(original.geometry, geometry);
    assert.equal(original.material, material);
    assert.equal(mesh(other.id), untouched);
    assert.equal(original.name, 'Moved mount');
    assert.deepEqual(counts, { geometry: 0, material: 0 });
    root.updateMatrixWorld(true);
    for (const point of [
      { x: 10, y: 8, z: 5 },
      { x: -10, y: -8, z: -5 },
    ]) {
      const actual = original.localToWorld(new THREE.Vector3(point.x, -point.y, point.z));
      assert.ok(actual.distanceTo(scenePoint(next, point)) < 1e-6);
    }
    assert.equal(nativeRay(next, 3, 2).intersectObject(original).length > 0, true);
    assert.ok(nativeRay(next, 0, 0).intersectObject(original).length > 0);
    assert.equal(JSON.stringify(next), before, 'Presentation must not modify committed CAD data');
  } finally {
    scene.dispose();
  }
  assert.deepEqual(counts, { geometry: 1, material: 1 });
});

const changes: [string, (object: ModelCadObject) => ModelCadObject][] = [
  [
    'kind',
    (object) => ({ ...object, kind: 'cylinder', size: { ...object.size, y: object.size.x } }),
  ],
  ['length', (object) => ({ ...object, size: { ...object.size, x: 24 } })],
  ['width', (object) => ({ ...object, size: { ...object.size, y: 18 } })],
  ['height', (object) => ({ ...object, size: { ...object.size, z: 12 } })],
  ['material', (object) => ({ ...object, material: 'pmma' })],
  ['opacity', (object) => ({ ...object, opacity: 0.35 })],
  ['color', (object) => ({ ...object, color: '#d94838' })],
];

for (const [label, change] of changes)
  test(`CAD ${label} changes replace only the affected mesh and dispose its old resources once`, () => {
    const { scene, mesh } = fixture();
    const first = body(),
      other = body();
    scene.update([first, other]);
    const original = mesh(first.id),
      untouched = mesh(other.id);
    const counts = disposed(original.geometry, original.material);
    const otherCounts = disposed(untouched.geometry, untouched.material);
    try {
      const next = validateModelCadObject(change(first));
      scene.update([next, other]);
      const replacement = mesh(first.id);
      assert.notEqual(replacement, original);
      assert.notEqual(replacement.geometry, original.geometry);
      assert.notEqual(replacement.material, original.material);
      assert.equal(original.parent, null);
      assert.equal(mesh(other.id), untouched);
      assert.deepEqual(counts, { geometry: 1, material: 1 });
      assert.deepEqual(otherCounts, { geometry: 0, material: 0 });
      assert.equal(replacement.material.opacity, next.opacity);
      if (next.color) assert.equal(replacement.material.color.getHexString(), next.color.slice(1));
      assert.equal(replacement.material.transparent, next.opacity < 1);
      assert.equal(replacement.material.depthWrite, next.opacity === 1);
      assert.equal(replacement.material.metalness, next.material === 'aluminium' ? 0.82 : 0.05);
      scene.update([structuredClone(next), other]);
      assert.equal(mesh(first.id), replacement, 'Equivalent next data must not replace resources');
    } finally {
      scene.dispose();
    }
    assert.deepEqual(counts, { geometry: 1, material: 1 });
    assert.deepEqual(otherCounts, { geometry: 1, material: 1 });
  });

test('CAD scene snapshots shape keys and detects mutations even when callers reuse the same body', () => {
  const { scene, mesh } = fixture();
  const object = body();
  scene.update([object]);
  const original = mesh(object.id);
  try {
    object.position.x = 56.8;
    scene.update([object]);
    assert.equal(mesh(object.id), original);
    assert.equal(original.position.x, 56.8);
    object.size.x = 24;
    scene.update([object]);
    assert.notEqual(mesh(object.id), original);
  } finally {
    scene.dispose();
  }
});

test('native object order, names and hole identities retain meshes while a new body ID replaces ownership', () => {
  const { root, scene, mesh } = fixture();
  const first = body(),
    second = body(),
    third = body();
  scene.update([first, second, third]);
  const meshes = [mesh(first.id), mesh(second.id), mesh(third.id)];
  const counts = disposed(meshes[0].geometry, meshes[0].material);
  try {
    scene.update([third, first, second]);
    assert.deepEqual(root.children, [meshes[2], meshes[0], meshes[1]]);
    const renamed = {
      ...first,
      name: 'Renamed',
    };
    scene.update([third, renamed, second]);
    assert.equal(mesh(first.id), meshes[0]);
    assert.equal(mesh(first.id).name, 'Renamed');
    const replacement = { ...renamed, id: uid() };
    scene.update([third, replacement, second]);
    assert.notEqual(mesh(replacement.id), meshes[0]);
    assert.equal(mesh(replacement.id).userData.modelCadId, replacement.id);
    assert.equal(meshes[0].parent, null);
    assert.deepEqual(counts, { geometry: 1, material: 1 });
  } finally {
    scene.dispose();
  }
  assert.deepEqual(counts, { geometry: 1, material: 1 });
});

test('selected pose updates retain independent selection paint and export restores the source material', () => {
  const { scene, selection, mesh } = fixture();
  const object = body(),
    other = body();
  object.opacity = 0.3;
  scene.update([object, other]);
  const original = mesh(object.id),
    source = original.material,
    untouched = mesh(other.id).material;
  const sourceColor = source.color.clone();
  selection.update(new Set([object.id]), true);
  const selected = original.material;
  let selectedDisposals = 0;
  selected.addEventListener('dispose', () => selectedDisposals++);
  try {
    scene.update([
      { ...object, position: { ...object.position, x: 56.8 }, rotation: { x: 0, y: 0, z: 90 } },
      other,
    ]);
    selection.update(new Set([object.id]), true);
    assert.equal(mesh(object.id), original);
    assert.equal(original.material, selected);
    assert.notEqual(selected, source);
    assert.equal(selectedDisposals, 0);
    assert.equal(selected.opacity, 0.3);
    assert.deepEqual(source.color, sourceColor);
    assert.equal(mesh(other.id).material, untouched);
    selection.withoutSelection(() => assert.equal(original.material, source));
    assert.equal(original.material, selected);
    assert.throws(
      () =>
        selection.withoutSelection(() => {
          throw new Error('capture');
        }),
      /capture/,
    );
    assert.equal(original.material, selected);
  } finally {
    scene.dispose();
  }
  assert.equal(selectedDisposals, 1);
});

test('replacement, deletion and final scene cleanup dispose selected copies and source resources once', () => {
  const { root, scene, selection, mesh } = fixture();
  const first = body(),
    second = body();
  scene.update([first, second]);
  const firstMesh = mesh(first.id),
    secondMesh = mesh(second.id);
  const firstCounts = disposed(firstMesh.geometry, firstMesh.material);
  const secondCounts = disposed(secondMesh.geometry, secondMesh.material);
  selection.update(new Set([first.id]), true);
  let oldPaintDisposals = 0;
  firstMesh.material.addEventListener('dispose', () => oldPaintDisposals++);
  const changed = { ...first, opacity: 0.5 };
  scene.update([changed, second]);
  assert.deepEqual(firstCounts, { geometry: 1, material: 1 });
  assert.equal(oldPaintDisposals, 1);
  const replacement = mesh(first.id);
  const replacementCounts = disposed(replacement.geometry, replacement.material);
  selection.update(new Set([first.id]), true);
  let replacementPaintDisposals = 0;
  replacement.material.addEventListener('dispose', () => replacementPaintDisposals++);
  scene.update([second]);
  assert.deepEqual(replacementCounts, { geometry: 1, material: 1 });
  assert.equal(replacementPaintDisposals, 1);
  assert.deepEqual(secondCounts, { geometry: 0, material: 0 });
  selection.update(new Set([second.id]), false);
  let lastPaintDisposals = 0;
  secondMesh.material.addEventListener('dispose', () => lastPaintDisposals++);
  scene.dispose();
  assert.equal(root.children.length, 0);
  assert.deepEqual(secondCounts, { geometry: 1, material: 1 });
  assert.equal(lastPaintDisposals, 1);
  // Match PCBModelPreview: the outer group is disposed after CAD's owner closes.
  const outer = new THREE.Group();
  outer.add(root);
  disposeModelGroup(outer);
  scene.dispose();
  scene.update([first, second]);
  assert.equal(root.children.length, 0, 'A disposed scene cannot publish late meshes');
  assert.deepEqual(firstCounts, { geometry: 1, material: 1 });
  assert.deepEqual(replacementCounts, { geometry: 1, material: 1 });
  assert.deepEqual(secondCounts, { geometry: 1, material: 1 });
  assert.equal(oldPaintDisposals, 1);
  assert.equal(replacementPaintDisposals, 1);
  assert.equal(lastPaintDisposals, 1);
});

test('separate CAD scenes never share geometry, materials or ownership for the same native ID', () => {
  const first = fixture(),
    second = fixture(),
    object = body();
  first.scene.update([object]);
  second.scene.update([object]);
  const one = first.mesh(object.id),
    two = second.mesh(object.id);
  const secondCounts = disposed(two.geometry, two.material);
  assert.notEqual(one, two);
  assert.notEqual(one.geometry, two.geometry);
  assert.notEqual(one.material, two.material);
  first.scene.dispose();
  assert.equal(second.root.children.length, 1);
  assert.deepEqual(secondCounts, { geometry: 0, material: 0 });
  second.scene.dispose();
  assert.deepEqual(secondCounts, { geometry: 1, material: 1 });
});

test('a separate preview retains pose resources and its original translucent material policy', () => {
  for (const opacity of [0.25, 0.8, 1]) {
    const committed = fixture(),
      previewRoot = new THREE.Group(),
      object = body();
    object.opacity = opacity;
    const preview = createModelCadScene(previewRoot, () => {}, true);
    committed.scene.update([object]);
    preview.update([object]);
    const solid = committed.mesh(object.id);
    const translucent = previewRoot.children[0] as THREE.Mesh<
      THREE.BufferGeometry,
      THREE.MeshStandardMaterial
    >;
    const counts = disposed(translucent.geometry, translucent.material);
    try {
      assert.notEqual(translucent.geometry, solid.geometry);
      assert.notEqual(translucent.material, solid.material);
      assert.equal(translucent.material.opacity, Math.min(opacity, 0.45));
      assert.equal(translucent.material.transparent, true);
      assert.equal(translucent.material.depthWrite, false);
      assert.equal(translucent.userData.modelCadPreview, true);
      preview.update([{ ...object, position: { ...object.position, x: 56.8 } }]);
      assert.equal(previewRoot.children[0], translucent);
      assert.equal(translucent.position.x, 56.8);
      assert.equal(translucent.material.opacity, Math.min(opacity, 0.45));
      assert.deepEqual(counts, { geometry: 0, material: 0 });
      assert.equal(solid.position.x, object.position.x);
      assert.equal(solid.material.opacity, opacity);
      preview.update([]);
      assert.equal(previewRoot.children.length, 0);
      assert.deepEqual(counts, { geometry: 1, material: 1 });
      assert.equal(committed.root.children[0], solid);
    } finally {
      preview.dispose();
      committed.scene.dispose();
    }
    assert.deepEqual(counts, { geometry: 1, material: 1 });
  }
});

const advancedBody = (): ModelCadObject => ({
  ...body(),
  kind: 'extrusion',
  profile: { kind: 'rectangle' },
});
const kernelFaces = (): MeshData[] => [
  {
    attributes: {
      position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] },
      normal: { array: [0, 0, 1, 0, 0, 1, 0, 0, 1] },
    },
    index: { array: [0, 1, 2] },
  },
];
function pendingFaces() {
  let resolve!: (meshes: MeshData[]) => void, reject!: (error: Error) => void;
  const promise = new Promise<MeshData[]>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const flushFaces = () => new Promise<void>((resolve) => setImmediate(resolve));
function advancedMesh(root: THREE.Group) {
  assert.equal(root.children.length, 1);
  const group = root.children[0];
  assert.ok(group instanceof THREE.Group);
  assert.ok(group.children[0] instanceof THREE.Mesh);
  return {
    group,
    mesh: group.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>,
  };
}

test('advanced CAD waits for kernel faces and applies the latest pose without refetching', async () => {
  const root = new THREE.Group(),
    pending = pendingFaces();
  let calls = 0,
    changed = 0;
  const scene = createModelCadScene(root, () => {}, false, {
    loadAdvanced: async () => {
      calls++;
      return pending.promise;
    },
    onChange: () => {
      changed++;
    },
  });
  const object = advancedBody(),
    data = kernelFaces(),
    originalData = structuredClone(data);
  try {
    scene.update([object]);
    assert.equal(calls, 1);
    assert.equal(
      root.children[0].children.length,
      0,
      'No estimated geometry is displayed for an unprepared feature',
    );
    const moved = {
      ...object,
      name: 'Current name',
      position: { x: 53, y: 72, z: 10 },
      rotation: { x: 17, y: 31, z: 43 },
    };
    scene.update([moved]);
    assert.equal(calls, 1);
    pending.resolve(data);
    await flushFaces();
    const { group, mesh } = advancedMesh(root);
    assert.equal(group.name, moved.name);
    assert.equal(group.userData.modelCadId, object.id);
    assert.equal(mesh.userData.modelCadId, object.id);
    assert.equal(changed, 1);
    assert.deepEqual(
      [...mesh.geometry.getIndex()!.array],
      [0, 2, 1],
      'Y reflection reverses face winding',
    );
    assert.deepEqual(
      [...mesh.geometry.getAttribute('position').array],
      [0, -0, 0, 1, -0, 0, 0, -1, 0],
    );
    root.updateMatrixWorld(true);
    assert.ok(
      group
        .localToWorld(new THREE.Vector3(0, -1, 0))
        .distanceTo(scenePoint(moved, { x: 0, y: 1, z: 0 })) < 1e-6,
    );
    const counts = disposed(mesh.geometry, mesh.material);
    scene.update([{ ...moved, position: { ...moved.position, x: 60 } }]);
    assert.equal(advancedMesh(root).mesh, mesh);
    assert.equal(calls, 1);
    assert.deepEqual(counts, { geometry: 0, material: 0 });
    data[0].attributes.position.array[0] = 99;
    assert.equal(
      mesh.geometry.getAttribute('position').getX(0),
      0,
      'Retained resources copy public mesh arrays',
    );
    data[0].attributes.position.array[0] = originalData[0].attributes.position.array[0];
    assert.deepEqual(data, originalData, 'Kernel conversion preserves its input face data');
  } finally {
    scene.dispose();
  }
});

test('advanced CAD shape replacement cancels obsolete loading and never publishes late faces', async () => {
  const root = new THREE.Group();
  const jobs: { pending: ReturnType<typeof pendingFaces>; signal: AbortSignal }[] = [];
  let changes = 0;
  const scene = createModelCadScene(root, () => {}, false, {
    loadAdvanced: (_body, signal) => {
      const pending = pendingFaces();
      jobs.push({ pending, signal });
      return pending.promise;
    },
    onChange: () => {
      changes++;
    },
  });
  const object = advancedBody();
  try {
    scene.update([object]);
    scene.update([{ ...object, size: { ...object.size, z: 12 } }]);
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].signal.aborted, true);
    jobs[0].pending.resolve(kernelFaces());
    await flushFaces();
    assert.equal(root.children[0].children.length, 0);
    assert.equal(changes, 0);
    jobs[1].pending.resolve(kernelFaces());
    await flushFaces();
    const mesh = advancedMesh(root).mesh,
      counts = disposed(mesh.geometry, mesh.material);
    assert.equal(changes, 1);
    scene.update([{ ...object, size: { ...object.size, z: 14 } }]);
    assert.deepEqual(counts, { geometry: 1, material: 1 });
    assert.equal(jobs.length, 3);
    scene.dispose();
    assert.equal(jobs[2].signal.aborted, true);
    jobs[2].pending.resolve(kernelFaces());
    await flushFaces();
    assert.equal(root.children.length, 0);
    assert.equal(changes, 1);
    assert.deepEqual(counts, { geometry: 1, material: 1 });
  } finally {
    scene.dispose();
  }
});

test('hidden advanced scenes defer new work and failed preparation has an explicit retry', async () => {
  const root = new THREE.Group();
  let active = false;
  const jobs: ReturnType<typeof pendingFaces>[] = [],
    errors: string[] = [];
  const scene = createModelCadScene(root, () => {}, false, {
    active: () => active,
    loadAdvanced: () => {
      const pending = pendingFaces();
      jobs.push(pending);
      return pending.promise;
    },
    onError: (error) => {
      errors.push(error);
    },
  });
  const object = advancedBody();
  try {
    scene.update([object]);
    assert.equal(jobs.length, 0);
    active = true;
    scene.update([object]);
    assert.equal(jobs.length, 1);
    jobs[0].reject(new Error('Kernel feature failed.'));
    await flushFaces();
    assert.deepEqual(errors, ['Kernel feature failed.']);
    scene.update([object]);
    assert.equal(jobs.length, 1, 'Ordinary updates do not repeat a failed request');
    scene.retry();
    assert.equal(jobs.length, 2);
    jobs[1].resolve(kernelFaces());
    await flushFaces();
    assert.ok(advancedMesh(root).mesh.geometry.getAttribute('position').count > 0);
    assert.deepEqual(errors, ['Kernel feature failed.', '']);
  } finally {
    scene.dispose();
  }
});

test('one failed CAD body stays reported while another loads and through unchanged updates', async () => {
  const root = new THREE.Group();
  const jobs: ReturnType<typeof pendingFaces>[] = [],
    errors: string[] = [];
  const scene = createModelCadScene(root, () => {}, false, {
    loadAdvanced: () => {
      const job = pendingFaces();
      jobs.push(job);
      return job.promise;
    },
    onError: (message) => errors.push(message),
  });
  const first = advancedBody(),
    second = { ...advancedBody(), id: uid() };
  try {
    scene.update([first, second]);
    jobs[0].reject(new Error('Base preview unavailable.'));
    await flushFaces();
    jobs[1].resolve(kernelFaces());
    await flushFaces();
    scene.update([first, second]);
    assert.deepEqual(errors, ['Base preview unavailable.']);
    assert.equal(jobs.length, 2, 'View updates retain the retry gate.');
    scene.update([second]);
    assert.deepEqual(errors, ['Base preview unavailable.', '']);
  } finally {
    scene.dispose();
  }
});

test('advanced preview and committed scenes own separate faces, selection paint and disposal', async () => {
  const object = advancedBody(),
    shared = kernelFaces();
  object.opacity = 0.8;
  const root = new THREE.Group(),
    previewRoot = new THREE.Group();
  const selection = createModelSelection(root, 'modelCadId');
  const committed = createModelCadScene(root, () => selection.dispose(), false, {
    loadAdvanced: async () => shared,
  });
  const preview = createModelCadScene(previewRoot, () => {}, true, {
    loadAdvanced: async () => shared,
  });
  try {
    committed.update([object]);
    preview.update([object]);
    await flushFaces();
    const one = advancedMesh(root).mesh,
      two = advancedMesh(previewRoot).mesh;
    assert.notEqual(one.geometry, two.geometry);
    assert.notEqual(one.material, two.material);
    assert.equal(one.material.opacity, 0.8);
    assert.equal(two.material.opacity, 0.45);
    assert.equal(two.material.depthWrite, false);
    const source = one.material,
      counts = disposed(one.geometry, source),
      otherCounts = disposed(two.geometry, two.material);
    selection.update(new Set([object.id]), true);
    const paint = one.material;
    let paintDisposals = 0;
    paint.addEventListener('dispose', () => {
      paintDisposals++;
    });
    assert.notEqual(paint, source);
    selection.withoutSelection(() => assert.equal(one.material, source));
    assert.equal(one.material, paint);
    committed.update([]);
    assert.deepEqual(counts, { geometry: 1, material: 1 });
    assert.equal(paintDisposals, 1);
    assert.deepEqual(otherCounts, { geometry: 0, material: 0 });
    preview.dispose();
    assert.deepEqual(otherCounts, { geometry: 1, material: 1 });
  } finally {
    committed.dispose();
    preview.dispose();
  }
});

test('kernel results arriving while hidden wait for reveal and use the latest native pose', async () => {
  const root = new THREE.Group(),
    pending = pendingFaces(),
    object = advancedBody();
  let active = true,
    calls = 0,
    changes = 0;
  const scene = createModelCadScene(root, () => {}, false, {
    active: () => active,
    loadAdvanced: () => {
      calls++;
      return pending.promise;
    },
    onChange: () => {
      changes++;
    },
  });
  try {
    scene.update([object]);
    active = false;
    const faces = kernelFaces();
    pending.resolve(faces);
    await flushFaces();
    assert.equal(changes, 0, 'Hidden completion creates no render resources or redraw');
    assert.equal(root.children[0].children.length, 0);
    faces[0].attributes.position.array[3] = 99;
    const moved = {
      ...object,
      name: 'Hidden edit',
      position: { x: 14, y: 22, z: 8 },
      rotation: { x: 17, y: 31, z: 43 },
    };
    scene.update([moved]);
    assert.equal(root.children[0].children.length, 0);
    active = true;
    scene.update([moved]);
    const { group, mesh } = advancedMesh(root);
    assert.equal(calls, 1, 'Reveal reuses the completed kernel result');
    assert.equal(changes, 1);
    assert.equal(group.name, moved.name);
    assert.equal(
      mesh.geometry.getAttribute('position').getX(1),
      1,
      'Deferred faces are independently owned',
    );
    root.updateMatrixWorld(true);
    assert.ok(
      group
        .localToWorld(new THREE.Vector3(1, 0, 0))
        .distanceTo(scenePoint(moved, { x: 1, y: 0, z: 0 })) < 1e-6,
    );
    scene.update([moved]);
    assert.equal(changes, 1, 'Completed deferred faces publish once');
  } finally {
    scene.dispose();
  }
});

test('obsolete hidden kernel results are discarded before the replacement can publish', async () => {
  const root = new THREE.Group(),
    object = advancedBody();
  const jobs: { faces: ReturnType<typeof pendingFaces>; signal: AbortSignal }[] = [];
  let active = true,
    changes = 0;
  const scene = createModelCadScene(root, () => {}, false, {
    active: () => active,
    loadAdvanced: (_body, signal) => {
      const faces = pendingFaces();
      jobs.push({ faces, signal });
      return faces.promise;
    },
    onChange: () => {
      changes++;
    },
  });
  try {
    scene.update([object]);
    active = false;
    jobs[0].faces.resolve(kernelFaces());
    await flushFaces();
    const replacement = { ...object, size: { ...object.size, z: 14 } };
    scene.update([replacement]);
    assert.equal(jobs[0].signal.aborted, true);
    assert.equal(jobs.length, 1, 'Hidden replacement defers its own kernel request');
    active = true;
    scene.update([replacement]);
    assert.equal(jobs.length, 2);
    assert.equal(
      root.children[0].children.length,
      0,
      'Obsolete completed geometry cannot flash on reveal',
    );
    jobs[1].faces.resolve(kernelFaces());
    await flushFaces();
    assert.ok(advancedMesh(root).mesh);
    assert.equal(changes, 1);
  } finally {
    scene.dispose();
  }
});

test('disposing a hidden scene releases deferred results and prevents later publication', async () => {
  const root = new THREE.Group(),
    pending = pendingFaces();
  let active = true,
    changes = 0,
    signal!: AbortSignal;
  const scene = createModelCadScene(root, () => {}, false, {
    active: () => active,
    loadAdvanced: (_body, control) => {
      signal = control;
      return pending.promise;
    },
    onChange: () => {
      changes++;
    },
  });
  const object = advancedBody();
  scene.update([object]);
  active = false;
  pending.resolve(kernelFaces());
  await flushFaces();
  scene.dispose();
  assert.equal(signal.aborted, true);
  active = true;
  scene.update([object]);
  await flushFaces();
  assert.equal(root.children.length, 0);
  assert.equal(changes, 0);
});
