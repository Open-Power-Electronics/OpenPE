import manifest from '../resources/example-catalog/footprints/emc-flyback/manifest.json' with { type: 'json' };

/** Placement pin shared by example generation and the analytical STEP generator. */
export function emcAnalyticalModels() {
  const models = manifest.analyticalModels;
  if (!models || Array.isArray(models) || !Object.keys(models).length)
    throw new Error('The EMC manifest has no analytical models.');
  return models;
}

export function emcAnalyticalReplacement(filename) {
  for (const [relative, entry] of Object.entries(emcAnalyticalModels())) {
    if (entry.replaces === filename) return { relative, entry };
  }
  return null;
}
