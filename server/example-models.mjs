import path from 'node:path';
import { fileURLToPath } from 'node:url';
import homeManifest from '../resources/example-catalog/home-manifest.json' with { type: 'json' };
import { emcFlybackModelLock } from './example-models-lock.mjs';
import { readProjectModelFile } from './project-model-files.mjs';
import { createTiModelStore } from './ti-models.mjs';

export function createSimulationModelStore(
  dataDir,
  fetcher = fetch,
  projectRoot = fileURLToPath(new URL(`../${homeManifest.sourceRoots.project}/`, import.meta.url)),
) {
  const ti = createTiModelStore(dataDir, fetcher);
  return async (id, signal) => {
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
