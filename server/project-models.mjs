import {
  validateSimulationModels,
  simulationModelDefinitions,
} from './simulation-model-format.mjs';
import { verifyProjectModelBytes } from './project-model-files.mjs';

/** Each request owns its model collection; no project bytes populate the shared cache. */
export function projectSimulationModels(project, fallback, files, fileId) {
  validateSimulationModels(project.simulationModels);
  const models = [...(project.simulationModels ?? [])];
  const loaded = new Map();
  return {
    models,
    async store(id, signal) {
      signal.throwIfAborted();
      const definition =
        models.find((model) => model.id === id) ??
        simulationModelDefinitions.find((model) => model.id === id);
      if (!definition) throw new Error('Unsupported simulation model.');
      if (loaded.has(id)) return loaded.get(id);
      let bytes = fileId && files ? await files.read(fileId, definition) : null;
      if (!bytes) {
        if (!fallback) throw new Error('Simulation model storage is unavailable. Restart OpenPE.');
        bytes = await fallback(id, signal);
      }
      signal.throwIfAborted();
      verifyProjectModelBytes(definition, bytes);
      if (fileId && files) await files.write(fileId, definition, bytes);
      if (!models.some((model) => model.id === id)) models.push({ ...definition });
      loaded.set(id, bytes);
      return bytes;
    },
  };
}
