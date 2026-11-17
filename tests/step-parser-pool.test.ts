import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { Worker } from 'node:worker_threads';
import test from 'node:test';
import { createStepParserPool } from '../server/libraries.mjs';

const bytes = new Uint8Array([1, 2, 3]);
const meshes = [{ attributes: { position: { array: [0, 1, 2] } }, index: { array: [0] } }];

class FakeStepWorker extends EventEmitter {
  pending: { requestId: number; bytes: Uint8Array } | null = null;
  terminated = false;
  postMessage(message: { requestId: number; bytes: Uint8Array }) {
    assert.equal(this.pending, null, 'A parser must never execute overlapping conversions.');
    this.pending = message;
  }
  complete(result: { meshes?: typeof meshes; error?: string; heapBytes?: number } = {}) {
    assert.ok(this.pending);
    const requestId = this.pending.requestId;
    this.pending = null;
    this.emit('message', { requestId, meshes, heapBytes: 1024, ...result });
  }
  async terminate() {
    this.terminated = true;
    return 0;
  }
}

function fixture(options: Parameters<typeof createStepParserPool>[0] = {}) {
  const workers: FakeStepWorker[] = [];
  const pool = createStepParserPool({
    idleMs: 10000,
    createWorker: () => {
      const worker = new FakeStepWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
    ...options,
  });
  return { workers, pool };
}

test('31 serialized board conversions reuse one parser and return independent job results', async () => {
  const { pool, workers } = fixture();
  try {
    for (let index = 0; index < 31; index++) {
      const result = pool.run(bytes);
      assert.equal(workers.length, 1);
      const expected = [{ ...meshes[0], name: String(index) }];
      workers[0].complete({ meshes: expected });
      assert.deepEqual(await result, { meshes: expected });
      assert.equal(workers[0].terminated, false);
    }
  } finally {
    pool.close();
  }
  assert.equal(workers[0].terminated, true);
});

test('a board and chooser keep two independent slots, with no third active conversion', async () => {
  const { pool, workers } = fixture();
  try {
    const board = pool.run(bytes);
    const chooser = pool.run(bytes);
    assert.equal(workers.length, 2);
    await assert.rejects(pool.run(bytes), /Two 3D previews/);
    workers[0].complete();
    await board;
    const nextBoard = pool.run(bytes);
    assert.equal(workers.length, 2);
    workers[1].complete();
    workers[0].complete();
    await Promise.all([chooser, nextBoard]);
  } finally {
    pool.close();
  }
});

test('cancelled work terminates only its parser and never delivers a stale result', async () => {
  const { pool, workers } = fixture();
  const control = new AbortController();
  try {
    const cancelled = pool.run(bytes, control.signal);
    const chooser = pool.run(bytes);
    const previousId = workers[0].pending!.requestId;
    control.abort();
    await assert.rejects(cancelled, /Preview cancelled/);
    assert.equal(workers[0].terminated, true);
    assert.equal(workers[1].terminated, false);
    const retry = pool.run(bytes);
    workers[0].emit('message', { requestId: previousId, meshes });
    workers[2].complete();
    workers[1].complete();
    await Promise.all([retry, chooser]);
    await assert.rejects(pool.run(bytes, control.signal), /Preview cancelled/);
    assert.equal(workers.length, 3, 'An already cancelled request never starts a worker.');
  } finally {
    pool.close();
  }
});

test('timeout, malformed input, worker error and unexpected exit reset instead of poisoning retries', async () => {
  const { pool, workers } = fixture({ timeoutMs: 15 });
  try {
    await assert.rejects(pool.run(bytes), /timed out/);
    assert.equal(workers[0].terminated, true);
    const malformed = pool.run(bytes);
    workers[1].complete({ error: 'The STEP model could not be tessellated.' });
    await assert.rejects(malformed, /could not be tessellated/);
    assert.equal(workers[1].terminated, true);
    const broken = pool.run(bytes);
    workers[2].emit('error', new Error('Worker memory limit exceeded.'));
    await assert.rejects(broken, /memory limit/);
    const exited = pool.run(bytes);
    workers[3].emit('exit', 1);
    await assert.rejects(exited, /stopped before conversion completed/);
    const wrongJob = pool.run(bytes);
    workers[4].emit('message', { requestId: -1, meshes });
    await assert.rejects(wrongJob, /unexpected result/);
    const retry = pool.run(bytes);
    workers[5].complete();
    assert.deepEqual(await retry, { meshes });
  } finally {
    pool.close();
  }
});

test('idle, job-count and WASM heap limits release resident parsers after successful results', async () => {
  const { pool, workers } = fixture({ idleMs: 15, maxJobs: 2, maxHeapBytes: 2048 });
  try {
    const first = pool.run(bytes);
    workers[0].complete();
    await first;
    const second = pool.run(bytes);
    workers[0].complete();
    await second;
    assert.equal(workers[0].terminated, true, 'The job limit bounds allocator retention.');
    const large = pool.run(bytes);
    workers[1].complete({ heapBytes: 4096 });
    assert.deepEqual(await large, { meshes }, 'A valid large result remains usable.');
    assert.equal(workers[1].terminated, true, 'A large WASM heap is not retained.');
    const idle = pool.run(bytes);
    workers[2].complete();
    await idle;
    await delay(30);
    assert.equal(workers[2].terminated, true, 'Idle parsers release their worker and WASM heap.');
  } finally {
    pool.close();
  }
});

test('close cancels active conversions, releases idle workers and rejects future work', async () => {
  const { pool, workers } = fixture();
  const active = pool.run(bytes);
  const ready = pool.run(bytes);
  workers[1].complete();
  await ready;
  pool.close();
  await assert.rejects(active, /Preview cancelled/);
  assert.ok(workers.every((worker) => worker.terminated));
  await assert.rejects(pool.run(bytes), /Preview cancelled/);
  pool.close();
});
