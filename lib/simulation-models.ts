import { lm2596SourceModel, referenceModels } from './reference-models';
import emcFlybackModels from '../resources/emc-flyback-models-lock.json';

/** Portable references to separate immutable pinned model files. */
export type SimulationModelReference = { id: string; sha256: string; file: string };
export const simulationModelDefinitions = [
  ...[lm2596SourceModel].map((model) => ({
    id: model.id,
    sha256: model.modelSha256,
    file: `models/${model.id.toUpperCase()}.lib`,
  })),
  ...referenceModels.map((model) => ({
    id: model.id,
    sha256: model.modelSha256,
    file: `models/${model.id.replace(/^reference-/, '').toUpperCase()}.lib`,
  })),
  ...emcFlybackModels.models,
];
const definitionsByFile = new Map<string, SimulationModelReference>();
const caseInsensitiveFiles = new Set<string>();
for (const definition of simulationModelDefinitions) {
  if (
    !/^models\/[A-Za-z0-9][A-Za-z0-9_.-]*\.lib$/.test(definition.file) ||
    caseInsensitiveFiles.has(definition.file.toLowerCase())
  )
    throw new Error('Simulation component filenames must be safe and unique.');
  caseInsensitiveFiles.add(definition.file.toLowerCase());
  definitionsByFile.set(definition.file, { ...definition });
}

/** Native imports accept only the current pinned component filename. */
export function simulationModelReferenceForFile(
  file: string,
): SimulationModelReference | undefined {
  const definition = definitionsByFile.get(file);
  return definition && { ...definition };
}

export function validateSimulationModels(models: SimulationModelReference[] | undefined): void {
  if (models === undefined) return;
  if (!Array.isArray(models) || models.length > 32)
    throw new Error('A project supports up to 32 simulation model references.');
  const ids = new Set<string>();
  for (const model of models) {
    if (
      !model ||
      typeof model !== 'object' ||
      Object.keys(model).sort().join(',') !== 'file,id,sha256'
    )
      throw new Error('Invalid simulation model reference. Use a separate verified model file.');
    const definition = simulationModelReferenceForFile(model.file);
    if (
      !definition ||
      model.id !== definition.id ||
      ids.has(model.id) ||
      model.sha256 !== definition.sha256 ||
      model.file !== definition.file
    )
      throw new Error(`Unsupported, duplicate or invalid simulation model reference ${model.id}.`);
    ids.add(model.id);
  }
}
