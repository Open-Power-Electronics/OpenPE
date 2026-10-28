import test from 'node:test';
import assert from 'node:assert/strict';
import { newModelCadObject, modelCadGeometryKey } from '../lib/model-cad';
import { createEmptyPCB } from '../lib/pcb-layout';
import { prepareModelCadPreview, validateModelCadPreview } from '../lib/model-cad-preview';

const body = () => newModelCadObject(createEmptyPCB(), 'extrusion');
const meshes = () => [
  { attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] } }, index: { array: [0, 1, 2] } },
];

test('CAD observations bind exact geometry and reject malformed meshes before admission', () => {
  const key = modelCadGeometryKey(body());
  const source = { shapeKey: key, meshes: meshes() };
  const parsed = validateModelCadPreview(source, key);
  parsed.meshes[0].attributes.position.array[0] = 500;
  assert.equal(source.meshes[0].attributes.position.array[0], 0);
  assert.throws(() => validateModelCadPreview(source, key + 'changed'), /match/);
  assert.throws(
    () => validateModelCadPreview({ ...source, meshes: [] }, key),
    /no supported solid/,
  );
  source.meshes[0].index.array[2] = 8;
  assert.throws(() => validateModelCadPreview(source, key), /invalid mesh/);
});

test('shared CAD observations cancel per consumer, preserve retry and isolate cached public arrays', async () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      openpe: {
        connection: async () => ({ base: 'http://cad.test', token: 'test' }),
      },
    },
  });
  let calls = 0;
  let cancelled = 0;
  let finish: (() => void) | undefined;
  globalThis.fetch = async (_url, options) => {
    calls++;
    const object = JSON.parse(String(options?.body)).object;
    await new Promise<void>((resolve, reject) => {
      finish = resolve;
      options?.signal?.addEventListener(
        'abort',
        () => {
          cancelled++;
          reject(options.signal?.reason);
        },
        { once: true },
      );
    });
    return new Response(
      JSON.stringify({ shapeKey: modelCadGeometryKey(object), meshes: meshes() }),
    );
  };
  try {
    const object = body();
    object.size.z = 17.31;
    const firstControl = new AbortController();
    const first = prepareModelCadPreview(object, firstControl.signal);
    const second = prepareModelCadPreview({ ...object, name: 'same geometry' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const rejected = assert.rejects(first, /cancelled/);
    firstControl.abort(new Error('consumer cancelled'));
    await rejected;
    assert.equal(cancelled, 0, 'another consumer retains shared work');
    finish!();
    const result = await second;
    result.meshes[0].attributes.position.array[0] = 999;
    const cached = await prepareModelCadPreview(object);
    assert.equal(cached.meshes[0].attributes.position.array[0], 0);
    assert.equal(calls, 1);

    const changed = { ...object, size: { ...object.size, z: 17.32 } };
    const control = new AbortController();
    const pending = prepareModelCadPreview(changed, control.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const aborted = assert.rejects(pending, /last consumer/);
    control.abort(new Error('last consumer'));
    await aborted;
    assert.equal(cancelled, 1);
    const retry = prepareModelCadPreview(changed);
    await new Promise((resolve) => setTimeout(resolve, 0));
    finish!();
    assert.equal((await retry).meshes.length, 1);
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
