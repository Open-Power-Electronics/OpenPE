import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { uid } from '../lib/circuit';
import { modelCadGeometryKey, type ModelCadObject, type ModelCadShape } from '../lib/model-cad';
import { createModelCadPreviewService, modelCadStepGeometry } from '../server/model-cad-kernel.mjs';
import { startServer } from '../server/index.mjs';

const body = (): ModelCadObject => ({
  id: uid(),
  name: 'Sketch body',
  kind: 'extrusion',
  position: { x: 100, y: 80, z: 40 },
  rotation: { x: 17, y: 31, z: 43 },
  size: { x: 20, y: 10, z: 8 },
  material: 'aluminium',
  opacity: 1,
  holes: [],
  profile: {
    kind: 'polygon',
    points: [
      { x: -10, y: -5 },
      { x: 10, y: -5 },
      { x: 8, y: 5 },
      { x: -10, y: 5 },
    ],
  },
});
const mesh = () => ({
  name: 'Untrusted parser label',
  attributes: {
    position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] },
    normal: { array: [0, 0, 1, 0, 0, 1, 0, 0, 1] },
  },
  index: { array: [0, 1, 2] },
});
const parseStep = async () => ({ meshes: [mesh()] });
const createStep = async () => Buffer.from('mock STEP bytes');

test('local kernel source closes polygon profiles and prepares rim operations after extrusion', () => {
  const target = body();
  target.holes = [{ id: uid(), x: 0, y: 0, diameterMm: 2 }];
  target.edgeTreatment = {
    kind: 'chamfer',
    distanceMm: 0.5,
    edges: ['profile:top:0', 'profile:bottom:0'],
  };
  target.name = 'Sketch"; SystemCall("command"); //';
  const source = modelCadStepGeometry(target);
  assert.match(source, /SetFactory\("OpenCASCADE"\)/);
  assert.match(source, /newcl;/);
  assert.match(source, /Curve Loop\(.+\) = \{[^}]+\};/);
  assert.match(source, /Extrude \{0,0,8\} \{ Surface\{[^}]+\}; \};/);
  assert.ok(source.indexOf('Extrude') < source.indexOf('BooleanDifference'));
  assert.ok(source.indexOf('BooleanDifference') < source.indexOf('Chamfer'));
  assert.match(source, /BoundingBox Curve/);
  assert.match(source, /Fabs\(/);
  assert.match(source, /_mass\(\) = Mass Volume\{[^}]+\};/);
  assert.match(source, /Chamfer\{[^}]+\}\{[^}]+\}\{[^}]+\}\{0\.5\};/);
  assert.doesNotMatch(source, /SystemCall|command|Untrusted|Rotate|Translate/);
  const moved = { ...target, position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0 } };
  assert.equal(modelCadStepGeometry(moved), source, 'Preview construction excludes world pose');
});

test('Boolean kernel source uses only allowlisted operations and retains operand poses', () => {
  const cube: ModelCadShape = { kind: 'box', size: { x: 10, y: 10, z: 8 }, holes: [] };
  for (const operation of ['union', 'difference', 'intersection'] as const) {
    const target: ModelCadObject = {
      ...body(),
      kind: 'boolean',
      profile: undefined,
      size: { x: 30, y: 30, z: 30 },
      boolean: {
        operation,
        operands: [
          { shape: cube, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
          { shape: cube, position: { x: 2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 45 } },
        ],
      },
    };
    delete target.profile;
    const source = modelCadStepGeometry(target);
    const command = {
      union: 'BooleanUnion',
      difference: 'BooleanDifference',
      intersection: 'BooleanIntersection',
    }[operation];
    assert.match(
      source,
      new RegExp(`${command}\\{ Volume\\{[^}]+\\}; Delete; \\}\\{ Volume\\{[^}]+\\}; Delete; \\};`),
    );
    assert.match(source, /Translate \{2,0,0\}/);
    assert.match(source, /Rotate \{\{0,0,1\}, \{0,0,0\}, 45\*Pi\/180\}/);
    assert.doesNotMatch(
      source,
      /-15,-15,-15,30,30,30/,
      'Boolean envelope is never built as geometry',
    );
  }
  const invalid = body();
  invalid.profile = {
    kind: 'polygon',
    points: [
      { x: -10, y: -5 },
      { x: 10, y: -5 },
      { x: NaN, y: 5 },
    ],
  };
  assert.throws(() => modelCadStepGeometry(invalid), /Invalid/);
});

test('selected-edge construction resolves exact base curves and rejects ambiguous topology', () => {
  const target: ModelCadObject = {
    ...body(),
    kind: 'box',
    holes: [],
    edgeTreatment: { kind: 'fillet', distanceMm: 0.5, edges: ['side:0', 'profile:top:0'] },
  };
  delete target.profile;
  const source = modelCadStepGeometry(target);
  assert.match(source, /BoundingBox Curve/);
  assert.match(source, /_match == -1 \|\| .+_ambiguous/);
  assert.match(source, /The selected edge is missing or ambiguous/);
  assert.equal((source.match(/_match = -1;/g) ?? []).length, 2);
  assert.equal((source.match(/_curves\(\) \+=/g) ?? []).length, 2);
  assert.match(source, /Fillet\{/);
  assert.doesNotMatch(source, /_rim\d+_min/);
  const chamfer = modelCadStepGeometry({
    ...target,
    edgeTreatment: { kind: 'chamfer', distanceMm: 0.5, edges: ['side:2'] },
  });
  assert.match(chamfer, /Chamfer\{/);
  assert.equal((chamfer.match(/_match = -1;/g) ?? []).length, 1);
  assert.throws(
    () =>
      modelCadStepGeometry({
        ...target,
        edgeTreatment: { kind: 'fillet', distanceMm: 0.5, edges: ['side:99'] },
      }),
    /unavailable/,
  );
});

test('kernel preview cache keys geometry only and retains independent public meshes', async () => {
  let calls = 0;
  const service = createModelCadPreviewService({
    createStep: async () => {
      calls++;
      return createStep();
    },
    parseStep,
  });
  try {
    const target = body();
    target.holes = [{ id: uid(), x: 0, y: 0, diameterMm: 2 }];
    const first = await service.preview(target);
    assert.equal(first.shapeKey, modelCadGeometryKey(target));
    assert.equal(first.meshes[0].name, 'CAD solid 1');
    first.meshes[0].attributes.position.array[0] = 123;
    target.id = uid();
    target.name = 'Renamed';
    target.position.x += 10;
    target.rotation.z += 1;
    target.material = 'plastic';
    target.opacity = 0.5;
    target.holes[0].id = uid();
    const second = await service.preview(target);
    assert.equal(calls, 1);
    assert.equal(second.meshes[0].attributes.position.array[0], 0);
    target.size.z += 1;
    await service.preview(target);
    assert.equal(calls, 2, 'An actual geometry change prepares a new solid');
  } finally {
    service.close();
  }
});

test('invalid and cancelled kernel previews stay retryable', async () => {
  let attempts = 0;
  const service = createModelCadPreviewService({
    createStep: async (_source: string, signal = new AbortController().signal) => {
      attempts++;
      if (attempts === 1)
        return new Promise<never>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
        );
      return createStep();
    },
    parseStep: async () => ({ meshes: attempts === 2 ? [] : [mesh()] }),
  });
  try {
    const control = new AbortController();
    const cancelled = assert.rejects(service.preview(body(), control.signal), /cancelled/);
    control.abort();
    await cancelled;
    await assert.rejects(service.preview(body()), /no bounded solid preview/);
    assert.equal((await service.preview(body())).meshes.length, 1);
    assert.equal(attempts, 3);
  } finally {
    service.close();
  }
});

test('kernel preparation concurrency is bounded and service shutdown cancels active jobs', async () => {
  const signals: AbortSignal[] = [];
  const service = createModelCadPreviewService({
    createStep: async (_source: string, signal = new AbortController().signal) => {
      signals.push(signal);
      return new Promise<never>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
      );
    },
    parseStep,
  });
  const first = assert.rejects(service.preview(body()), /cancelled/);
  const second = assert.rejects(service.preview(body()), /cancelled/);
  await assert.rejects(service.preview(body()), /Two CAD previews/);
  service.close();
  await Promise.all([first, second]);
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal.aborted));
  await assert.rejects(service.preview(body()), /cancelled/);
});

test('CAD preview route requires loopback authentication and one bounded object', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openpe-cad-route-'));
  let calls = 0,
    closed = false;
  const expected = { shapeKey: 'mock geometry', meshes: [mesh()] };
  const server = await startServer({
    dataDir: directory,
    modelCadPreviewFactory: () => ({
      preview: async () => {
        calls++;
        return expected;
      },
      close: () => {
        closed = true;
      },
    }),
  });
  const headers = { 'X-OpenPE-Token': server.token, 'Content-Type': 'application/json' };
  try {
    const url = `${server.base}/api/model-cad/preview`;
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
    assert.equal(
      (
        await fetch(url, {
          method: 'POST',
          headers: { ...headers, Origin: 'https://foreign.example' },
          body: '{}',
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ object: body(), script: 'anything' }),
        })
      ).status,
      400,
    );
    assert.equal(calls, 0);
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ object: body() }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected);
    assert.equal(calls, 1);
  } finally {
    server.close();
    assert.equal(closed, true);
    assert.equal(
      path.dirname(path.resolve(directory)).toLowerCase(),
      path.resolve(os.tmpdir()).toLowerCase(),
    );
    assert.ok(path.basename(directory).startsWith('openpe-cad-route-'));
    await rm(directory, { recursive: true, force: true });
  }
});
