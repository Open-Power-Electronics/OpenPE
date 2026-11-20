import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import homeManifest from '../resources/example-catalog/home-manifest.json' with { type: 'json' };
import { emcFlybackModelLock } from './example-models-lock.mjs';
import { readProjectModelFile, verifyProjectModelBytes } from './project-model-files.mjs';
import { simulationModelDefinitions } from './simulation-model-format.mjs';
import { createTiModelStore } from './ti-models.mjs';

const limit = 128 * 1024;
export function createSimulationModelStore(
  dataDir,
  fetcher = fetch,
  projectRoot = fileURLToPath(new URL(`../${homeManifest.sourceRoots.project}/`, import.meta.url)),
  preparedRoot,
) {
  const ti = createTiModelStore(dataDir, fetcher);
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
    if (!model) return ti(id, signal);
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
