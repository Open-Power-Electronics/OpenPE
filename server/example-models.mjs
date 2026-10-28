import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { exampleModelLock } from './example-models-lock.mjs';
import { createTiModelStore } from './ti-models.mjs';
import { fetchModelResponse } from './model-download.mjs';

const limit = 128 * 1024;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function createExampleModelStore(dataDir, fetcher = fetch) {
  return async (id, signal) => {
    const model = exampleModelLock.models.find((item) => item.id === id);
    if (!model) throw new Error('Unsupported example simulation model.');
    signal.throwIfAborted();
    const directory = path.join(dataDir, 'example-models');
    const file = path.join(directory, `${model.sha256}.lib`);
    try {
      if ((await stat(file)).size <= limit) {
        const bytes = await readFile(file);
        signal.throwIfAborted();
        if (digest(bytes) === model.sha256) return bytes;
      }
    } catch (error) {
      if (signal.aborted) throw error;
    }
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
    // URLs are compiled, commit-pinned constants. Neither IDs nor redirects choose a URL.
    const response = await fetchModelResponse(
      fetcher,
      model.url,
      { signal: bounded, redirect: 'error' },
      'KiCad example',
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(
        `Example model download failed (${response.status}). Check your connection and retry.`,
      );
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw new Error('Example model download exceeded 128 KB.');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (digest(bytes) !== model.sha256)
      throw new Error(
        'Example model failed its integrity check. Update OpenPE before using this model.',
      );
    bounded.throwIfAborted();
    await mkdir(directory, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes);
      bounded.throwIfAborted();
      await rename(temporary, file);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    return bytes;
  };
}
export function createSimulationModelStore(dataDir, fetcher = fetch) {
  const examples = createExampleModelStore(dataDir, fetcher),
    ti = createTiModelStore(dataDir, fetcher);
  return (id, signal) => (id.startsWith('example-') ? examples(id, signal) : ti(id, signal));
}
