import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import {
  createModelCadEdgeHighlight,
  disposeModelCadEdgeHighlight,
  modelCadEdgePaths,
  pickModelCadEdge,
} from '../components/model-cad-edges';
import { type ModelCadObject } from '../lib/model-cad';

const body = (): ModelCadObject => ({
  id: '7d6a9000-0000-4000-a000-000000000001',
  name: 'Editable block',
  kind: 'box',
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  size: { x: 20, y: 16, z: 8 },
  holes: [],
  material: 'aluminium',
  opacity: 1,
});
const viewport = { width: 800, height: 600 };
function cameraAt(x = 0, y = 0, z = 100) {
  const camera = new THREE.OrthographicCamera(-40, 40, 30, -30, 0.1, 1000);
  camera.position.set(x, y, z);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}
function screen(world: THREE.Vector3, camera: THREE.Camera) {
  const projected = world.clone().project(camera);
  return {
    x: ((projected.x + 1) * viewport.width) / 2,
    y: ((1 - projected.y) * viewport.height) / 2,
  };
}
// Independent native Rx * Ry * Rz followed by the scene's Y reflection.
function transformed(object: ModelCadObject, p: { x: number; y: number; z: number }) {
  const radians = Math.PI / 180;
  const [sx, sy, sz] = [object.rotation.x, object.rotation.y, object.rotation.z].map((a) =>
    Math.sin(a * radians),
  );
  const [cx, cy, cz] = [object.rotation.x, object.rotation.y, object.rotation.z].map((a) =>
    Math.cos(a * radians),
  );
  const zx = cz * p.x - sz * p.y;
  const zy = sz * p.x + cz * p.y;
  const yx = cy * zx + sy * p.z;
  const yz = -sy * zx + cy * p.z;
  return new THREE.Vector3(
    yx + object.position.x,
    -(cx * zy - sx * yz + object.position.y),
    sx * zy + cx * yz + object.position.z,
  );
}

test('edge paths retain exact semantic lines and bounded reflected circular and hole rims', () => {
  const object = body();
  object.holes = [{ id: '7d6a9000-0000-4000-a000-000000000002', x: 2, y: 1, diameterMm: 3 }];
  const before = JSON.stringify(object);
  const paths = modelCadEdgePaths(object);
  assert.equal(paths.length, 14);
  assert.deepEqual(
    paths.find(({ edge }) => edge.id === 'side:0')!.points.map((p) => p.toArray()),
    [
      [-10, 8, -4],
      [-10, 8, 4],
    ],
  );
  const hole = paths.find(({ edge }) => edge.id === 'hole:top:0')!;
  assert.equal(hole.points.length, 65);
  assert.ok(hole.points[0].distanceTo(hole.points.at(-1)!) < 1e-12);
  assert.deepEqual(hole.points[0].toArray(), [3.5, -1, 4]);
  paths[0].points[0].x = 999;
  assert.notEqual(modelCadEdgePaths(object)[0].points[0].x, 999);
  assert.equal(JSON.stringify(object), before);
  const cylinder = { ...body(), kind: 'cylinder' as const, size: { x: 20, y: 20, z: 8 } };
  assert.deepEqual(
    modelCadEdgePaths(cylinder).map(({ edge }) => edge.id),
    ['profile:top:0', 'profile:bottom:0'],
  );
});

test('edge highlights pose exact local edges, never raycast and dispose owned resources once', () => {
  const object = body();
  object.position = { x: 100, y: 80, z: 40 };
  object.rotation = { x: 17, y: 31, z: 43 };
  const group = createModelCadEdgeHighlight(object, ['side:0', 'profile:top:0'], 0x202020);
  assert.equal(group.children.length, 2);
  group.updateMatrixWorld(true);
  const line = group.children.find(
    (node) => node.userData.modelCadEdgeId === 'side:0',
  ) as THREE.Line;
  assert.ok(
    line
      .localToWorld(new THREE.Vector3(-10, 8, 4))
      .distanceTo(transformed(object, { x: -10, y: -8, z: 4 })) < 1e-9,
  );
  assert.equal((line.material as THREE.LineBasicMaterial).color.getHex(), 0x202020);
  let materials = 0;
  let geometries = 0;
  (line.material as THREE.Material).addEventListener('dispose', () => materials++);
  for (const child of group.children as THREE.Line[])
    child.geometry.addEventListener('dispose', () => geometries++);
  const ray = new THREE.Raycaster(new THREE.Vector3(100, -80, 100), new THREE.Vector3(0, 0, -1));
  assert.deepEqual(ray.intersectObject(group, true), []);
  disposeModelCadEdgeHighlight(group);
  disposeModelCadEdgeHighlight(group);
  assert.equal(materials, 1, 'Shared line material is released once.');
  assert.equal(geometries, 2);
  assert.equal(group.children.length, 0);
});

test('edge picking uses screen pixels and chooses visible front edges instead of coincident back edges', () => {
  const object = body();
  const camera = cameraAt();
  const scene = new THREE.Group();
  const point = screen(new THREE.Vector3(0, 8, 4), camera);
  for (const zoom of [0.5, 1, 3]) {
    camera.zoom = zoom;
    camera.updateProjectionMatrix();
    const current = screen(new THREE.Vector3(0, 8, 4), camera);
    assert.equal(
      pickModelCadEdge({
        object,
        camera,
        viewport,
        scene,
        point: { ...current, y: current.y - 6 },
      }),
      'profile:top:0',
    );
    assert.equal(
      pickModelCadEdge({
        object,
        camera,
        viewport,
        scene,
        point: { ...current, y: current.y - 9 },
      }),
      null,
    );
  }
  camera.zoom = 1;
  camera.updateProjectionMatrix();
  assert.equal(pickModelCadEdge({ object, camera, viewport, scene, point }), 'profile:top:0');
  const iso = cameraAt(30, 25, 40);
  assert.equal(
    pickModelCadEdge({
      object,
      camera: iso,
      viewport,
      scene,
      point: screen(new THREE.Vector3(10, 8, 0), iso),
    }),
    'side:1',
  );
  assert.equal(
    pickModelCadEdge({
      object,
      camera: iso,
      viewport,
      scene,
      point: screen(new THREE.Vector3(-10, -8, 0), iso),
    }),
    null,
  );
});

test('scene obstacles occlude edge picks while hidden ancestors and replacement previews do not', () => {
  const object = body();
  const camera = cameraAt();
  const scene = new THREE.Group();
  const obstacleRoot = new THREE.Group();
  const obstacle = new THREE.Mesh(new THREE.BoxGeometry(6, 6, 4), new THREE.MeshBasicMaterial());
  obstacle.position.set(0, 8, 20);
  obstacleRoot.add(obstacle);
  scene.add(obstacleRoot);
  const options = {
    object,
    camera,
    viewport,
    scene,
    point: screen(new THREE.Vector3(0, 8, 4), camera),
  };
  try {
    assert.equal(pickModelCadEdge(options), null);
    obstacleRoot.visible = false;
    assert.equal(pickModelCadEdge(options), 'profile:top:0');
    obstacleRoot.visible = true;
    obstacleRoot.userData.modelCadPreview = true;
    assert.equal(pickModelCadEdge(options), 'profile:top:0');
    delete obstacleRoot.userData.modelCadPreview;
    obstacleRoot.userData.modelCadId = object.id;
    assert.equal(
      pickModelCadEdge({ ...options, target: obstacleRoot }),
      'profile:top:0',
      'An existing treated mesh cannot hide the base edge that its replacement edits.',
    );
    delete obstacleRoot.userData.modelCadId;
    assert.equal(pickModelCadEdge({ ...options, target: obstacleRoot }), 'profile:top:0');
  } finally {
    obstacle.geometry.dispose();
    obstacle.material.dispose();
  }
});

test('circle, drilled and polygon extrusion edges use the same raw-base visibility without kernel meshes', () => {
  const camera = cameraAt();
  const scene = new THREE.Group();
  const cylinder = { ...body(), kind: 'cylinder' as const, size: { x: 20, y: 20, z: 8 } };
  assert.equal(
    pickModelCadEdge({
      object: cylinder,
      camera,
      viewport,
      scene,
      point: screen(new THREE.Vector3(10, 0, 4), camera),
    }),
    'profile:top:0',
  );
  const drilled = body();
  drilled.holes = [{ id: '7d6a9000-0000-4000-a000-000000000002', x: 0, y: 0, diameterMm: 4 }];
  assert.equal(
    pickModelCadEdge({
      object: drilled,
      camera,
      viewport,
      scene,
      point: screen(new THREE.Vector3(2, 0, 4), camera),
    }),
    'hole:top:0',
  );
  const polygon: ModelCadObject = {
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
  };
  assert.equal(
    pickModelCadEdge({
      object: polygon,
      camera,
      viewport,
      scene,
      point: screen(new THREE.Vector3(0, 0, 4), camera),
    }),
    'profile:top:4',
  );
});

test('perspective edge picks retain compound native poses and the saved object', () => {
  const object = body();
  object.position = { x: 100, y: 80, z: 40 };
  object.rotation = { x: 17, y: 31, z: 43 };
  object.edgeTreatment = { kind: 'fillet', distanceMm: 0.5, edges: ['side:0'] };
  const before = JSON.stringify(object);
  const camera = new THREE.PerspectiveCamera(40, viewport.width / viewport.height, 0.1, 1000);
  camera.position.copy(transformed(object, { x: 0, y: 0, z: 100 }));
  camera.up.copy(
    transformed(object, { x: 0, y: -1, z: 0 }).sub(transformed(object, { x: 0, y: 0, z: 0 })),
  );
  camera.lookAt(transformed(object, { x: 0, y: 0, z: 0 }));
  camera.updateMatrixWorld(true);
  const scene = new THREE.Group();
  assert.equal(
    pickModelCadEdge({
      object,
      camera,
      viewport,
      scene,
      point: screen(transformed(object, { x: 0, y: -8, z: 4 }), camera),
    }),
    'profile:top:0',
  );
  assert.equal(JSON.stringify(object), before);
  assert.equal(
    pickModelCadEdge({
      object,
      camera,
      viewport: { width: 0, height: 100 },
      scene,
      point: { x: 0, y: 0 },
    }),
    null,
  );
});

test('Boolean topology cannot acquire fabricated tessellation edge identities', () => {
  const box = { kind: 'box' as const, size: { x: 10, y: 8, z: 4 }, holes: [] };
  const operand = () => ({
    shape: box,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
  });
  const object: ModelCadObject = {
    ...body(),
    kind: 'boolean',
    boolean: { operation: 'union', operands: [operand(), operand()] },
  };
  assert.deepEqual(modelCadEdgePaths(object), []);
  const overlay = createModelCadEdgeHighlight(object, ['profile:top:0']);
  assert.equal(overlay.children.length, 0);
  disposeModelCadEdgeHighlight(overlay);
  assert.equal(
    pickModelCadEdge({
      object,
      camera: cameraAt(),
      viewport,
      point: { x: 400, y: 300 },
      scene: new THREE.Group(),
    }),
    null,
  );
});
