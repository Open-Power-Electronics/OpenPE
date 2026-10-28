/** Curated TI DC/DC support. Electrical symbols and footprints remain official KiCad data. */
import referenceModelLock from '../resources/reference-models-lock.json';
export const referenceModels = referenceModelLock.models;
export const tiModels = [
  {
    id: 'lm2596-3.3',
    voltage: 3.3,
    archive: 'snvma65',
    file: 'LM2596_3P3_TRANS.LIB',
    subcircuit: 'LM2596_3P3_TRANS',
    sha256: 'b387d7bdc153fc515d7f979b6d60634415b158957ce9b3682b3e3842f48bcc66',
    modelSha256: '433ac0453d98beb58abf8f0bd60cd674e573846b08f3056118049b71ad8c66d3',
  },
  {
    id: 'lm2596-5',
    voltage: 5,
    archive: 'snvma62',
    file: 'LM2596_5P0_TRANS.LIB',
    subcircuit: 'LM2596_5P0_TRANS',
    sha256: 'c8d6730cb669b577e013acd14653ef2be12035e778b3b4449e384c93bab8636f',
    modelSha256: 'bf883d939dbdce9c9146f9fd6d6c090e7cfb7afb5aaa01b6b8391ca06dbe8134',
  },
  {
    id: 'lm2596-12',
    voltage: 12,
    archive: 'snvma63',
    file: 'LM2596_12P0_TRANS.LIB',
    subcircuit: 'LM2596_12P0_TRANS',
    sha256: '8157546e5e9d715c0d891339cbcedc92424b9dc72e0fd63ee2fc88789940c091',
    modelSha256: '4dea9cd7347281c5dce060fbdc4d58c887ffeba2d8d2213541a6507ad8d2d0a5',
  },
] as const;
/** OpenPE derivative, never an official TI adjustable model or a chooser model. */
export const lm2596AdjustableDerivedModel = {
  id: 'openpe-lm2596-adj',
  library: 'OpenPE:lm2596-adj-derived',
  subcircuit: 'OPENPE_DERIVED_LM2596_ADJ_TRANS',
  sourceModelId: tiModels[1].id,
  sourceSha256: tiModels[1].modelSha256,
  sourceSubcircuit: tiModels[1].subcircuit,
  referenceVoltage: 1.235,
  description:
    'OpenPE-derived adjustable model based on the official TI LM2596 5 V model; internal feedback divider removed. Not a TI-issued ADJ model.',
} as const;
export const tiDcdcParts = tiModels.flatMap((model) =>
  (['S', 'T'] as const).map((pkg) => ({
    id: `Regulator_Switching:LM2596${pkg}-${model.voltage}`,
    name: `LM2596${pkg}-${model.voltage}`,
    library: 'Regulator_Switching',
    description: `Texas Instruments · ${model.voltage} V, 3 A Buck · 150 kHz · ${pkg === 'S' ? 'TO-263-5' : 'TO-220-5'}`,
    keywords: 'TI Texas Instruments DC/DC buck regulator power supply',
    footprint:
      pkg === 'S'
        ? 'Package_TO_SOT_SMD:TO-263-5_TabPin3'
        : 'Package_TO_SOT_THT:TO-220-5_P3.4x3.7mm_StaggerOdd_Lead3.8mm_Vertical',
    model,
  })),
);
export const tiPart = (id: string) => tiDcdcParts.find((part) => part.id === id);
export const tiDatasheet = 'https://www.ti.com/lit/ds/symlink/lm2596.pdf';
export const tiProduct = 'https://www.ti.com/product/LM2596';
