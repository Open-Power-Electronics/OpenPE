import test from 'node:test';
import assert from 'node:assert/strict';
import { modelCameraClipping, type ModelCameraBounds } from '../lib/model-camera-clipping';

type Point3 = { x: number; y: number; z: number };
const bounds: ModelCameraBounds = {
  center: { x: 100, y: -88, z: 14 },
  radius: Math.hypot(56, 47, 16.5),
};
const samplePoints = Array.from({ length: 13 }, (_, latitude) => {
  const angle = (latitude * Math.PI) / 12;
  return Array.from({ length: 24 }, (_, longitude) => ({
    x: bounds.center.x + bounds.radius * Math.sin(angle) * Math.cos((longitude * Math.PI) / 12),
    y: bounds.center.y + bounds.radius * Math.sin(angle) * Math.sin((longitude * Math.PI) / 12),
    z: bounds.center.z + bounds.radius * Math.cos(angle),
  }));
}).flat();
function depth(point: Point3, eye: Point3, target: Point3) {
  const direction = { x: target.x - eye.x, y: target.y - eye.y, z: target.z - eye.z };
  const length = Math.hypot(direction.x, direction.y, direction.z);
  return (
    ((point.x - eye.x) * direction.x +
      (point.y - eye.y) * direction.y +
      (point.z - eye.z) * direction.z) /
    length
  );
}

test('clipping encloses visible assembly faces during orbit, pan and extreme zoom', () => {
  const before = structuredClone(bounds);
  for (const distance of [0.01, 1, 20, 100, 300, 30_000]) {
    for (const angle of [0, Math.PI / 4, Math.PI / 2, Math.PI]) {
      const position = {
        x: bounds.center.x + distance * Math.sin(angle),
        y: bounds.center.y + distance * Math.cos(angle),
        z: bounds.center.z + distance / 3,
      };
      for (const pan of [0, 30, -300]) {
        const target = { ...bounds.center, x: bounds.center.x + pan };
        const planes = modelCameraClipping({ position, target, bounds });
        assert.ok(Number.isFinite(planes.near) && planes.near > 0);
        assert.ok(Number.isFinite(planes.far) && planes.far > planes.near);
        for (const point of samplePoints) {
          const z = depth(point, position, target);
          if (z < 0.001) continue;
          assert.ok(
            z >= planes.near && z <= planes.far,
            `Face depth ${z} outside ${JSON.stringify(planes)}`,
          );
        }
      }
    }
  }
  assert.deepEqual(bounds, before, 'Camera presentation never changes assembly bounds');
});

test('typical EMC perspective depth distinguishes adjacent copper, mask and silkscreen planes', () => {
  const position = { x: 200, y: -228, z: 214 };
  const target = bounds.center;
  const { near, far } = modelCameraClipping({ position, target, bounds });
  const surface = { ...bounds.center, z: 0.8 };
  const adjacent = { ...surface, z: surface.z + 0.005 };
  const depthCode = (z: number) =>
    Math.round((far / (far - near) - (far * near) / ((far - near) * z)) * (2 ** 24 - 1));
  assert.ok(
    Math.abs(
      depthCode(depth(surface, position, target)) - depthCode(depth(adjacent, position, target)),
    ) > 8,
    'PCB layers retain multiple depth steps even at an oblique view',
  );
  assert.ok(
    (far - near) / (2 ** 24 - 1) < 0.0001,
    'Orthographic depth also separates the same layers',
  );
});

test('camera inside the assembly retains nearby front faces and handles empty or invalid views', () => {
  const position = bounds.center;
  const target = { ...position, z: position.z + 10 };
  const planes = modelCameraClipping({ position, target, bounds });
  assert.ok(planes.near <= 0.01);
  assert.ok(planes.far > bounds.radius);
  for (const input of [
    { position, target, bounds: null },
    { position, target: position, bounds },
    { position: { x: NaN, y: Infinity, z: 0 }, target, bounds },
    { position, target, bounds: { center: target, radius: -1 } },
    { position, target, bounds: { center: target, radius: Infinity } },
  ]) {
    const next = modelCameraClipping(input);
    assert.ok(Number.isFinite(next.near) && next.near > 0);
    assert.ok(Number.isFinite(next.far) && next.far > next.near);
  }
});
