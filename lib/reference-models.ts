import referenceModelLock from '../resources/reference-models-lock.json';

export const referenceModels = referenceModelLock.models;

/** Pinned 5 V source for the Home LM2596 adjustable derivative. */
export const lm2596SourceModel = {
  id: 'lm2596-5',
  archive: 'snvma62',
  file: 'LM2596_5P0_TRANS.LIB',
  subcircuit: 'LM2596_5P0_TRANS',
  sha256: 'c8d6730cb669b577e013acd14653ef2be12035e778b3b4449e384c93bab8636f',
  modelSha256: 'bf883d939dbdce9c9146f9fd6d6c090e7cfb7afb5aaa01b6b8391ca06dbe8134',
} as const;

export const controllerModelSources = [lm2596SourceModel, ...referenceModels];

/** OpenPE derivative, never an official TI adjustable model. */
export const lm2596AdjustableDerivedModel = {
  id: 'openpe-lm2596-adj',
  library: 'OpenPE:lm2596-adj-derived',
  subcircuit: 'OPENPE_DERIVED_LM2596_ADJ_TRANS',
  sourceModelId: lm2596SourceModel.id,
  sourceSha256: lm2596SourceModel.modelSha256,
  sourceSubcircuit: lm2596SourceModel.subcircuit,
  referenceVoltage: 1.235,
  description:
    'OpenPE-derived adjustable model based on the official TI LM2596 5 V model; internal feedback divider removed. Not a TI-issued ADJ model.',
} as const;
