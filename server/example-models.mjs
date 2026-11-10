import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, writeFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exampleModelLock, emcFlybackModelLock } from './example-models-lock.mjs';
import { readProjectModelFile, verifyProjectModelBytes } from './project-model-files.mjs';
import { simulationModelDefinitions } from './simulation-model-format.mjs';
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
export function createSimulationModelStore(
  dataDir,
  fetcher = fetch,
  projectRoot = fileURLToPath(new URL('../project/', import.meta.url)),
  preparedRoot,
) {
  const examples = createExampleModelStore(dataDir, fetcher),
    ti = createTiModelStore(dataDir, fetcher);
  return async (id, signal) => {
    if (preparedRoot) {
      const definition = simulationModelDefinitions.find((entry) => entry.id === id);
      if (!definition) throw new Error('Unsupported simulation model identity.');
      signal.throwIfAborted();
      const file = path.join(preparedRoot, `${definition.id}-${definition.sha256}.lib`);
      const handle = await open(file, 'r').catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (handle) {
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size > limit) throw new Error('Invalid prepared model file.');
          const bytes = Buffer.alloc(limit + 1);
          let size = 0;
          while (size < bytes.length) {
            signal.throwIfAborted();
            const { bytesRead } = await handle.read(bytes, size, bytes.length - size, null);
            if (!bytesRead) break;
            size += bytesRead;
          }
          return verifyProjectModelBytes(definition, bytes.subarray(0, size));
        } finally {
          await handle.close();
        }
      }
    }
    const model = emcFlybackModelLock.models.find((entry) => entry.id === id);
    if (!model) return id.startsWith('example-') ? examples(id, signal) : ti(id, signal);
    signal.throwIfAborted();
    const bytes = await readProjectModelFile(
      path.join(projectRoot, 'emc-flyback/emc-flyback.kicad_pro'),
      model,
    );
    signal.throwIfAborted();
    if (!bytes) throw new Error(`Missing bundled EMC Flyback model ${model.file}. Repair OpenPE.`);
    return bytes;
  };
}
