import { compileCapabilitySchema } from '../../../api/capability-schema';
import type { Circuit, Point } from '../../../lib/circuit';
import type {
  SimulationResult,
  SpiceDeck,
  TransientConfig,
} from '../../spice-simulation/domain/spice';
import { validatedSimulationResult } from '../../spice-simulation/domain/waveform';
import type { CopperLayer, PCB } from '../../../lib/pcb';
import type { Polygon } from '../../../lib/pcb-polygons';
import { prepareThermalGeometry } from './thermal-geometry';

export type ThermalSpiceWindow = { startS: number; endS: number };
export type ThermalSpiceSource = ThermalSpiceWindow & {
  config: TransientConfig;
  /** Host SHA-256 of the complete verified samples and their compiled deck. */
  resultBasis: string;
};
export type ThermalSpiceImport = {
  heatSources: { footprintId: string; powerW: number }[];
  spiceSource: ThermalSpiceSource;
  losses: { footprintId: string; reference: string; powerW: number; method: string }[];
  assumptions: string[];
};

/** A read-only analysis scenario. These settings never enter the native design. */
export type ThermalConfig = {
  ambientC: number;
  /** Convective heat transfer coefficients, W/(m² K). */
  convection: { top: number; bottom: number; edge: number };
  /** Front to back, in the board's copper-layer order. */
  copperThicknessMm: number[];
  /** Isotropic conductivities, W/(m K). */
  dielectricConductivity: number;
  copperConductivity: number;
  viaPlatingMm: number;
  meshSizeMm: number;
  /** Heat entering the PCB through the selected footprint's pad area, W. */
  heatSources: { footprintId: string; powerW: number }[];
  /** Optional verified electrical input provenance, never native design content. */
  spiceSource?: ThermalSpiceSource;
};

export type ThermalModel = {
  version: 1;
  boardId: string;
  units: 'mm';
  basis: string;
  config: ThermalConfig;
  /** Closed board area with mechanical cutouts and all drill holes removed. */
  board: Polygon[];
  /** Copper takes precedence over dielectric in these z intervals. */
  layers: { layer: CopperLayer; zMin: number; zMax: number; polygons: Polygon[] }[];
  /** Remaining thickness is explicitly divided into equal dielectric gaps. */
  dielectricLayers: { zMin: number; zMax: number }[];
  barrels: (Point & {
    id: string;
    innerRadiusMm: number;
    outerRadiusMm: number;
    /** The exact polygonal annulus used for both meshing and material assignment. */
    polygons: Polygon[];
    zMin: number;
    zMax: number;
  })[];
  sources: {
    footprintId: string;
    reference?: string;
    powerW: number;
    side: 'front' | 'back';
    polygons: Polygon[];
    areaMm2: number;
  }[];
  notices: string[];
  assumptions: string[];
};

export type ThermalResult = {
  version: 1;
  status: 'completed';
  basis: string;
  solver: { gmsh: string; elmer: string };
  /** Actual finite element nodes, millimetres and degrees Celsius. */
  points: (Point & { z: number; temperatureC: number })[];
  /** Indices into points; boundary faces include the top, bottom and edges. */
  triangles: [number, number, number][];
  statistics: {
    minC: number;
    maxC: number;
    meanC: number;
    inputPowerW: number;
    outputPowerW: number;
    energyImbalanceRelative: number;
    nodeCount: number;
    elementCount: number;
  };
  assumptions: string[];
  diagnostics: string[];
};

const THERMAL_LIMITS = {
  points: 200000,
  triangles: 250000,
  footprints: 256,
  pads: 3000,
  copperObjects: 12000,
  vertices: 120000,
} as const;
export const thermalNodeIndexSchema = {
  type: 'integer',
  minimum: 0,
  maximum: THERMAL_LIMITS.points - 1,
} as const;

const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const bounded = (minimum: number, maximum: number) => ({ type: 'number', minimum, maximum });
const positive = (maximum: number) => ({ type: 'number', exclusiveMinimum: 0, maximum });
const text = { type: 'string', minLength: 1, maxLength: 256 };
const temperature = bounded(-273.15, 100000);
const strings = { type: 'array', maxItems: 128, items: { type: 'string', maxLength: 4096 } };
const spiceWindowProperties = { startS: bounded(0, 1000000), endS: positive(1000000) };
const spiceSourceSchema = object({
  ...spiceWindowProperties,
  resultBasis: { type: 'string', pattern: '^[a-f0-9]{64}$' },
  config: object({
    ...Object.fromEntries(
      ['inputId', 'pwmId', 'outputId', 'switchId', 'currentId'].map((key) => [
        key,
        { type: 'string', maxLength: 256 },
      ]),
    ),
    voltage: { type: 'number' },
    frequency: { type: 'number' },
    duty: { type: 'number' },
    stop: positive(1000000),
    step: positive(1000000),
  }),
});

/** Only the bounded interpreted schema subset; no runtime compilation/eval. */
const thermalConfigProperties = {
  ambientC: { type: 'number', exclusiveMinimum: -273.15, maximum: 1000 },
  convection: object({
    top: bounded(0, 100000),
    bottom: bounded(0, 100000),
    edge: bounded(0, 100000),
  }),
  copperThicknessMm: { type: 'array', minItems: 2, maxItems: 4, items: positive(10) },
  dielectricConductivity: positive(100000),
  copperConductivity: positive(100000),
  viaPlatingMm: positive(1),
  meshSizeMm: positive(1000),
  heatSources: {
    type: 'array',
    maxItems: THERMAL_LIMITS.footprints,
    items: object({ footprintId: text, powerW: bounded(0, 1000000) }),
  },
  spiceSource: spiceSourceSchema,
};
export const thermalConfigSchema = {
  ...object(thermalConfigProperties),
  required: Object.keys(thermalConfigProperties).filter((key) => key !== 'spiceSource'),
};
const checkSpiceImport = compileCapabilitySchema(
  object({
    heatSources: thermalConfigProperties.heatSources,
    spiceSource: spiceSourceSchema,
    losses: {
      type: 'array',
      maxItems: THERMAL_LIMITS.footprints,
      items: object({
        footprintId: text,
        reference: text,
        powerW: bounded(0, 1000000),
        method: text,
      }),
    },
    assumptions: strings,
  }),
);

export const thermalResultSchema = object({
  version: { const: 1 },
  status: { const: 'completed' },
  basis: text,
  solver: object({ gmsh: text, elmer: text }),
  points: {
    type: 'array',
    minItems: 3,
    maxItems: THERMAL_LIMITS.points,
    items: object({
      x: bounded(-100000, 100000),
      y: bounded(-100000, 100000),
      z: bounded(-1000, 1000),
      temperatureC: temperature,
    }),
  },
  triangles: {
    type: 'array',
    minItems: 1,
    maxItems: THERMAL_LIMITS.triangles,
    items: {
      type: 'array',
      minItems: 3,
      maxItems: 3,
      items: thermalNodeIndexSchema,
    },
  },
  statistics: object({
    minC: temperature,
    maxC: temperature,
    meanC: temperature,
    inputPowerW: positive(256000000),
    outputPowerW: bounded(0, 512000000),
    energyImbalanceRelative: bounded(0, 1000000),
    nodeCount: { type: 'integer', minimum: 3, maximum: THERMAL_LIMITS.points },
    elementCount: { type: 'integer', minimum: 1, maximum: 4000000 },
  }),
  assumptions: strings,
  diagnostics: strings,
});

const checkConfig = compileCapabilitySchema(thermalConfigSchema);
const checkResult = compileCapabilitySchema(thermalResultSchema);

export function defaultThermalConfig(board: PCB): ThermalConfig {
  return {
    ambientC: 25,
    convection: { top: 10, bottom: 10, edge: 5 },
    copperThicknessMm: board.layers.map(() => 0.035),
    dielectricConductivity: 0.3,
    copperConductivity: 400,
    viaPlatingMm: 0.025,
    meshSizeMm: 2,
    heatSources: [],
  };
}

/** Validate configuration without assuming that an unconfigured scenario is runnable. */
export function validateThermalConfig(input: unknown, board?: PCB): ThermalConfig {
  const checked = checkConfig(input);
  if (!checked.valid) throw new Error(`Invalid thermal settings: ${checked.error}.`);
  const config = structuredClone(input) as ThermalConfig;
  if (
    config.spiceSource &&
    (config.spiceSource.startS !== config.spiceSource.config.stop * 0.8 ||
      config.spiceSource.endS !== config.spiceSource.config.stop)
  )
    throw new Error('SPICE heat inputs require the final 20% interval of the completed transient.');
  if (![2, 4].includes(config.copperThicknessMm.length))
    throw new Error('Thermal settings require two or four copper thicknesses.');
  if (
    new Set(config.heatSources.map((source) => source.footprintId)).size !==
    config.heatSources.length
  )
    throw new Error('Each footprint may have only one thermal heat source.');
  if (board) {
    if (config.copperThicknessMm.length !== board.layers.length)
      throw new Error('Provide one copper thickness for each PCB copper layer.');
    const copperThickness = config.copperThicknessMm.reduce((sum, thickness) => sum + thickness, 0);
    if (!Number.isFinite(board.thickness) || board.thickness <= copperThickness)
      throw new Error('The total copper thickness must be smaller than the PCB thickness.');
    const footprintIds = new Set(board.footprints.map((footprint) => footprint.id));
    for (const source of config.heatSources)
      if (!footprintIds.has(source.footprintId))
        throw new Error(`Thermal heat source ${source.footprintId} no longer belongs to this PCB.`);
  }
  return config;
}

/** A compact presentation freshness token; the host separately hashes solver inputs. */
export function thermalFingerprint(input: unknown): string {
  const source = JSON.stringify(input);
  let a = 2166136261,
    b = 5381;
  for (let i = 0; i < source.length; i++) {
    a = Math.imul(a ^ source.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ source.charCodeAt(i);
  }
  return `thermal-v1:${source.length}:${a >>> 0}:${b >>> 0}`;
}

export function prepareThermalModel(board: PCB, input: unknown): ThermalModel {
  const config = validateThermalConfig(input, board);
  if (!config.heatSources.some((source) => source.powerW > 0))
    throw new Error('Assign positive heat entering the PCB to at least one footprint.');
  if (!Object.values(config.convection).some((coefficient) => coefficient > 0))
    throw new Error(
      'Steady-state thermal analysis requires at least one positive convection coefficient.',
    );
  const geometry = prepareThermalGeometry(board, config);
  const body = {
    version: 1 as const,
    boardId: board.id,
    units: 'mm' as const,
    config,
    ...geometry,
    assumptions: [
      'Steady-state linear conduction with isotropic, constant material conductivities.',
      'The remaining board thickness is divided equally between copper layers; this is an explicit stackup assumption.',
      "Configured power enters the PCB uniformly through each footprint side's copper pad area; component junction and case temperatures are not modelled.",
      'Copper layers contain the saved fills, tracks, pads and supported copper artwork. Disabled or explicitly empty fills contribute no copper.',
      'Plated through holes use the configured common barrel thickness. Circular boundaries are approximated by the shared PCB polygon geometry.',
      'Convection coefficients and ambient temperature are prescribed; airflow, radiation, solder mask and external heatsinks are not modelled.',
      config.spiceSource
        ? `Heat inputs are signed average V·I from completed SPICE samples between ${config.spiceSource.startS} and ${config.spiceSource.endS} s; all supported dissipative power is assumed to enter the linked footprint pads. Unmodelled losses are not inferred.`
        : 'Material values and power are user-specified analysis assumptions, not properties inferred from STEP appearance or SPICE waveforms.',
    ],
  };
  return { ...body, basis: thermalFingerprint(body) };
}

export function validateThermalSpiceImport(input: unknown, board?: PCB): ThermalSpiceImport {
  const checked = checkSpiceImport(input);
  if (!checked.valid) throw new Error(`Invalid SPICE heat sources: ${checked.error}.`);
  const imported = structuredClone(input) as ThermalSpiceImport;
  const { startS, endS, config } = imported.spiceSource;
  if (
    startS !== config.stop * 0.8 ||
    endS !== config.stop ||
    !imported.heatSources.some((source) => source.powerW > 0)
  )
    throw new Error('No positive supported SPICE heat sources in this averaging interval.');
  const ids = new Set(imported.heatSources.map((source) => source.footprintId));
  if (
    ids.size !== imported.heatSources.length ||
    imported.losses.length !== ids.size ||
    new Set(imported.losses.map((loss) => loss.footprintId)).size !== ids.size ||
    imported.losses.some(
      (loss) =>
        !imported.heatSources.some(
          (source) => source.footprintId === loss.footprintId && source.powerW === loss.powerW,
        ),
    )
  )
    throw new Error('SPICE heat sources do not match their device measurements.');
  if (
    board &&
    imported.heatSources.some(
      (source) => !board.footprints.some((footprint) => footprint.id === source.footprintId),
    )
  )
    throw new Error('The SPICE heat sources no longer belong to this PCB.');
  return imported;
}

/** Import the compiler's full-resolution dissipative paths only. Never rectify signed power or
 * infer losses from an ideal reactive element, source, or transformer. */
export function deriveThermalSpiceSources(
  circuit: Circuit,
  board: PCB,
  deck: SpiceDeck,
  input: SimulationResult,
) {
  const result = validatedSimulationResult(input, deck);
  const summary = result.dissipation;
  if (!summary || summary.startS !== deck.stop * 0.8 || summary.endS !== deck.stop)
    throw new Error(
      'Run SPICE Simulation again to record full-resolution heat inputs over the final 20% of the transient.',
    );
  const window = { startS: summary.startS, endS: summary.endS };
  const losses: ThermalSpiceImport['losses'] = [];
  for (const footprint of board.footprints) {
    const part = circuit.parts.find((part) => part.id === footprint.symbolId);
    if (!part) continue;
    const currents = result.traces.filter(
      (trace) =>
        trace.unit === 'A' &&
        trace.dissipation &&
        trace.targets?.some((target) => target.kind === 'current' && target.id === part.id),
    );
    if (!currents.length) continue;
    if (
      currents.length !== 1 ||
      board.footprints.filter((other) => other.symbolId === part.id).length !== 1
    )
      throw new Error(
        `${part.ref}: SPICE heat input requires one unambiguous linked footprint and dissipative path.`,
      );
    const trace = currents[0],
      path = trace.dissipation!;
    const average = summary.powers.find((power) => power.vector === trace.vector)?.powerW;
    if (average === undefined || !Number.isFinite(average) || average < -1e-9 || average > 1000000)
      throw new Error(
        `${part.ref}: invalid or negative average dissipative power. Choose a suitable completed interval.`,
      );
    losses.push({
      footprintId: footprint.id,
      reference: part.ref,
      powerW: Math.max(0, average),
      method: path.method,
    });
  }
  if (!losses.some((loss) => loss.powerW > 0))
    throw new Error(
      'No positive supported SPICE losses map to this PCB. Run SPICE with linked dissipative components first.',
    );
  return {
    window,
    heatSources: losses.map(({ footprintId, powerW }) => ({ footprintId, powerW })),
    losses,
    assumptions: [
      `Signed instantaneous terminal V·I is integrated from ${summary.sampleCount} full-resolution native SPICE output samples before waveform display reduction, over the final 20% of the completed transient. Switching peaks between native output samples remain unresolved.`,
      'Only compiler-declared dissipative paths with one stable linked footprint are included. Reactive energy, sources, ideal transformer windings and unsupported controller losses are excluded.',
      'MOSFET drain-to-source power excludes gate-drive and unmodelled package losses. All imported power is assumed to enter PCB pads; junction/case temperature and package-to-air heat division are not modelled.',
      'The selected interval is explicit and does not automatically establish steady electrical operation.',
    ],
  };
}

/** Reject incomplete, nonfinite or inconsistent solver output before presentation. */
export function validateThermalResult(input: unknown): ThermalResult {
  const checked = checkResult(input);
  if (!checked.valid) throw new Error(`Invalid thermal result: ${checked.error}.`);
  const result = input as ThermalResult;
  let min = Infinity,
    max = -Infinity;
  for (const point of result.points) {
    min = Math.min(min, point.temperatureC);
    max = Math.max(max, point.temperatureC);
  }
  const close = (a: number, b: number) =>
    Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));
  const stats = result.statistics;
  if (
    !close(min, stats.minC) ||
    !close(max, stats.maxC) ||
    stats.meanC < min - 1e-6 ||
    stats.meanC > max + 1e-6
  )
    throw new Error('Thermal result temperature statistics do not match its finite element nodes.');
  if (stats.nodeCount !== result.points.length)
    throw new Error('Thermal result node count does not match its finite element nodes.');
  const imbalance = Math.abs(stats.outputPowerW - stats.inputPowerW) / stats.inputPowerW;
  if (!close(imbalance, stats.energyImbalanceRelative))
    throw new Error('Thermal result energy balance does not match its reported heat flows.');
  for (const triangle of result.triangles) {
    if (triangle.some((index) => index >= result.points.length) || new Set(triangle).size !== 3)
      throw new Error('Thermal result contains an invalid boundary triangle.');
    const [a, b, c] = triangle.map((index) => result.points[index]);
    const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
    if (Math.hypot(u.y * v.z - u.z * v.y, u.z * v.x - u.x * v.z, u.x * v.y - u.y * v.x) === 0)
      throw new Error('Thermal result contains a zero-area boundary triangle.');
  }
  return structuredClone(result);
}
