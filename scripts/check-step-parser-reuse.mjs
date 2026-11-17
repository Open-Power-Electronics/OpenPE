import { resolveExampleModelRelative } from '../server/library-format.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { createLibraryService, createStepParserPool } from '../server/libraries.mjs';
import { exampleModelBytes } from '../server/example-footprints.mjs';

// Opt-in CPU check: compare every real pinned EMC mesh against a fresh parser.
// No renderer, Electron, network requests or user project files are involved.
const manifest = JSON.parse(
  await readFile('resources/example-catalog/emc-flyback-assets.json', 'utf8'),
);
const service = createLibraryService({ dataDir: '.openpe/step-parser-reuse' });
const models = new Map();
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error('Pinned EMC models must remain offline.');
};
const digest = (meshes) => createHash('sha256').update(JSON.stringify(meshes)).digest('hex');
const heaps = [];
let workerCount = 0;
const pool = createStepParserPool({
  createWorker: () => {
    workerCount++;
    const worker = new Worker(new URL('../server/step-worker.mjs', import.meta.url), {
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    worker.on('message', (result) => {
      if (result.heapBytes) heaps.push(result.heapBytes);
    });
    return worker;
  },
});

function freshConversion(bytes) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('../server/step-worker.mjs', import.meta.url), {
      workerData: bytes,
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('Fresh STEP parser timed out.'));
    }, 45000);
    worker.once('message', (result) => {
      clearTimeout(timer);
      void worker.terminate();
      result.error ? reject(new Error(result.error)) : resolve(result);
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      void worker.terminate();
      reject(error);
    });
  });
}

try {
  for (const entry of manifest.footprints) {
    const detail = await service.request({ action: 'detail', kind: 'footprints', id: entry.id });
    for (const model of entry.models) {
      const relative = resolveExampleModelRelative(Object.keys(manifest.models), model.path);
      if (models.has(relative)) continue;
      const bytes = await exampleModelBytes(entry.id, relative);
      assert.ok(bytes, `${relative}: pinned bytes must be available offline.`);
      const index = detail.models.findIndex((candidate) => candidate.path === model.path);
      assert.ok(index >= 0);
      models.set(relative, { bytes, id: entry.id, index, model: detail.models[index] });
    }
  }
  assert.equal(models.size, 31);
  const reference = new Map();
  let started = performance.now();
  for (const [relative, model] of models) {
    const result = await freshConversion(model.bytes);
    reference.set(relative, digest(result.meshes));
  }
  const freshMs = performance.now() - started;
  started = performance.now();
  for (const [relative, model] of models) {
    const result = await pool.run(model.bytes);
    assert.equal(digest(result.meshes), reference.get(relative), `${relative}: exact mesh bytes.`);
  }
  const reusedMs = performance.now() - started;
  const workersFor31 = workerCount;
  assert.ok(workerCount < 31, 'Bounded parser reuse must avoid one WASM initialization per model.');
  assert.ok(heaps.every((value) => Number.isSafeInteger(value) && value > 0));
  const first = models.entries().next().value;

  // Exercise the public service adapter as well as the pool, including its
  // catalog-index validation and unchanged model metadata/result envelope.
  for (let index = 0; index < 2; index++) {
    const result = await service.model(first[1].id, first[1].index);
    assert.equal(digest(result.meshes), reference.get(first[0]));
    assert.deepEqual(result.model, first[1].model);
    assert.deepEqual(Object.keys(result).sort(), ['meshes', 'model']);
  }
  await assert.rejects(pool.run(Buffer.from('Invalid STEP file.')), /could not be tessellated/);
  assert.equal(digest((await pool.run(first[1].bytes)).meshes), reference.get(first[0]));

  const control = new AbortController();
  const cancelled = pool.run(first[1].bytes, control.signal);
  control.abort();
  await assert.rejects(cancelled, /Preview cancelled/);
  assert.equal(digest((await pool.run(first[1].bytes)).meshes), reference.get(first[0]));

  const timed = createStepParserPool({ timeoutMs: 1 });
  try {
    await assert.rejects(timed.run(first[1].bytes), /timed out/);
    await assert.rejects(timed.run(first[1].bytes), /timed out/);
  } finally {
    timed.close();
  }
  const report = {
    models: models.size,
    freshMs: Math.round(freshMs),
    reusedMs: Math.round(reusedMs),
    workersFor31,
    maxWasmHeapBytes: Math.max(...heaps),
    exactMeshHashes: Object.fromEntries(reference),
  };
  // The later recovery checks start additional parsers; report the assembly
  // count captured before those checks rather than inferring from their paths.
  await mkdir('test-results', { recursive: true });
  await writeFile('test-results/step-parser-reuse.json', JSON.stringify(report, null, 2) + '\n');
  console.log(
    `PASS: ${models.size} exact offline STEP meshes; fresh ${report.freshMs}ms, reused ${report.reusedMs}ms; malformed/cancel/timeout retries and service envelope preserved.`,
  );
} finally {
  pool.close();
  service.close();
  globalThis.fetch = originalFetch;
}
