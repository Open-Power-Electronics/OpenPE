import { compileCapabilitySchema } from '../api/capability-schema';
import {
  thermalConfigSchema,
  thermalNodeIndexSchema,
  thermalResultSchema,
  type ThermalConfig,
  type ThermalResult,
} from '../lib/thermal';
import type { ThermalProbe, ThermalSurface } from '../lib/thermal-view';

export type AgentThermalState = {
  boardId: string | null;
  visible: boolean;
  sourcePending: boolean;
  status: 'idle' | 'detecting' | 'unavailable' | 'running' | 'completed' | 'stopped' | 'failed';
  settings: ThermalConfig | null;
  resultSettings: ThermalConfig | null;
  surface: ThermalSurface;
  probe: ThermalProbe | null;
  error: string;
  solver: { available: boolean; gmsh?: string; elmer?: string; error?: string } | null;
  result: ThermalResult | null;
};

/** Bounded observations expose exact extrema and probes, never the entire volume mesh. */
export function agentThermalContext(state: AgentThermalState) {
  const { result, ...context } = state;
  if (!result) return { ...context, result: null };
  let hottest = 0;
  let coolest = 0;
  for (let i = 1; i < result.points.length; i++) {
    if (result.points[i].temperatureC > result.points[hottest].temperatureC) hottest = i;
    if (result.points[i].temperatureC < result.points[coolest].temperatureC) coolest = i;
  }
  return {
    ...context,
    result: {
      status: result.status,
      basis: result.basis,
      temperature: 'board',
      temperatureUnit: '°C',
      coordinateUnit: 'mm',
      solver: result.solver,
      statistics: result.statistics,
      hottest: { node: hottest, ...result.points[hottest] },
      coolest: { node: coolest, ...result.points[coolest] },
      assumptions: result.assumptions,
      diagnostics: result.diagnostics,
    },
  };
}

export type AgentThermalContext = ReturnType<typeof agentThermalContext>;

const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  required: Object.keys(properties),
  properties,
  additionalProperties: false,
});
const nullable = (schema: unknown) => ({ anyOf: [schema, { type: 'null' }] });
const text = { type: 'string', maxLength: 4096 };
const label = { type: 'string', minLength: 1, maxLength: 256 };
const strings = { type: 'array', maxItems: 128, items: text };
const probe = object({
  node: thermalNodeIndexSchema,
  x: { type: 'number' },
  y: { type: 'number' },
  z: { type: 'number' },
  temperatureC: { type: 'number' },
});
const check = compileCapabilitySchema(
  object({
    boardId: nullable(label),
    visible: { type: 'boolean' },
    sourcePending: { type: 'boolean' },
    status: {
      enum: ['idle', 'detecting', 'unavailable', 'running', 'completed', 'stopped', 'failed'],
    },
    settings: nullable(thermalConfigSchema),
    resultSettings: nullable(thermalConfigSchema),
    surface: { enum: ['front', 'back'] },
    probe: nullable(probe),
    error: text,
    solver: nullable({
      type: 'object',
      required: ['available'],
      properties: { available: { type: 'boolean' }, gmsh: label, elmer: label, error: text },
      additionalProperties: false,
    }),
    result: nullable(
      object({
        status: { const: 'completed' },
        basis: label,
        temperature: { const: 'board' },
        temperatureUnit: { const: '°C' },
        coordinateUnit: { const: 'mm' },
        solver: object({ gmsh: label, elmer: label }),
        statistics: thermalResultSchema.properties.statistics,
        hottest: probe,
        coolest: probe,
        assumptions: strings,
        diagnostics: strings,
      }),
    ),
  }),
);

/** Validate the bounded observed state independently of the renderer and solver. */
export function validateAgentThermalContext(
  value: unknown,
  boardId?: string,
  sourcePending?: boolean,
) {
  const fail = () => {
    throw new Error('Invalid Agent thermal context.');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const short = value as { status?: unknown };
  if (short.status === 'disabled' || short.status === 'not-opened') {
    if (Object.keys(value).length !== 1) fail();
    return;
  }
  if (!check(value).valid) return fail();
  const context = value as AgentThermalContext;
  if (
    (boardId !== undefined && context.boardId !== boardId) ||
    (sourcePending !== undefined && context.sourcePending !== sourcePending)
  )
    fail();
  if (context.sourcePending && (context.result || context.probe)) fail();
  if (context.result) {
    const { statistics, hottest, coolest } = context.result;
    if (
      !context.boardId ||
      !context.resultSettings ||
      !['completed', 'detecting', 'unavailable'].includes(context.status) ||
      statistics.minC > statistics.maxC ||
      statistics.meanC < statistics.minC ||
      statistics.meanC > statistics.maxC ||
      hottest.temperatureC !== statistics.maxC ||
      coolest.temperatureC !== statistics.minC ||
      hottest.node >= statistics.nodeCount ||
      coolest.node >= statistics.nodeCount ||
      (context.probe && context.probe.node >= statistics.nodeCount)
    )
      fail();
  } else if (context.probe) fail();
}
