import { parseProject } from '../lib/project';
import { projectDatasheetContext, type ProjectDatasheetContext } from '../lib/example-datasheets';
import type { AgentSimulationContext } from './agent-simulation-context';
import { validateAgentThermalContext, type AgentThermalContext } from './agent-thermal-context';
export { agentPromptContext } from './agent-prompt-context';

export type AgentWorkspaceContext = {
  version: 1;
  capturedAt: string;
  project: unknown;
  source: { pending: boolean; draft: string | null; error: string };
  ui: Record<string, unknown>;
  icDatasheet?: ProjectDatasheetContext;
  simulation: AgentSimulationContext | { status: 'disabled' | 'not-opened' };
  thermal?: AgentThermalContext | { status: 'disabled' | 'not-opened' };
};

/** The payload is observed renderer state, never executable instructions or a solver input. */
export function validateAgentWorkspaceContext(value: unknown, circuitId?: string, basis?: string) {
  if (value === undefined) return;
  const context = value as AgentWorkspaceContext;
  const fail = () => {
    throw new Error('Invalid Agent workspace context.');
  };
  let nodes = 0;
  function finiteJSON(item: unknown, depth = 0) {
    if (++nodes > 1000000 || depth > 64) fail();
    if (typeof item === 'number' && !Number.isFinite(item)) fail();
    else if (Array.isArray(item)) item.forEach((entry) => finiteJSON(entry, depth + 1));
    else if (item && typeof item === 'object')
      Object.values(item).forEach((entry) => finiteJSON(entry, depth + 1));
    else if (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) fail();
  }
  finiteJSON(value);
  if (
    !context ||
    context.version !== 1 ||
    typeof context.capturedAt !== 'string' ||
    !Number.isFinite(Date.parse(context.capturedAt)) ||
    !context.source ||
    typeof context.source.pending !== 'boolean' ||
    typeof context.source.error !== 'string' ||
    !(context.source.draft === null || typeof context.source.draft === 'string') ||
    (context.source.draft?.length ?? 0) > 8 * 1024 * 1024 ||
    !context.ui ||
    Array.isArray(context.ui) ||
    !context.simulation
  )
    fail();
  const project = parseProject(JSON.stringify(context.project));
  const active = [project.schematic, ...(project.additionalSchematics ?? [])].find(
    (file) => file.id === circuitId,
  );
  if (!active || context.ui.activeSchematicId !== circuitId) fail();
  if (context.icDatasheet !== undefined) {
    // Client observations must match the bundled reviewed data and current IC.
    // Object key order is not part of the JSON contract.
    const canonical = (item: unknown): string => {
      if (Array.isArray(item)) return '[' + item.map(canonical).join(',') + ']';
      if (item && typeof item === 'object')
        return (
          '{' +
          Object.keys(item)
            .sort()
            .map(
              (key) =>
                JSON.stringify(key) + ':' + canonical((item as Record<string, unknown>)[key]),
            )
            .join(',') +
          '}'
        );
      return JSON.stringify(item);
    };
    if (canonical(context.icDatasheet) !== canonical(projectDatasheetContext(project))) fail();
  }
  if (context.thermal !== undefined) {
    validateAgentThermalContext(context.thermal, project.pcb?.id, context.source.pending);
    if (!project.pcb && 'boardId' in context.thermal && context.thermal.boardId !== null) fail();
  }
  const simulation = context.simulation;
  if (['disabled', 'not-opened'].includes(simulation.status)) {
    if ('result' in simulation || 'circuitId' in simulation) fail();
    return;
  }
  if (
    !('circuitId' in simulation) ||
    ![
      'idle',
      'detecting',
      'unavailable',
      'blocked',
      'running',
      'completed',
      'stopped',
      'failed',
    ].includes(simulation.status)
  )
    fail();
  if (
    'circuitId' in simulation &&
    (simulation.circuitId !== circuitId || simulation.basis !== basis)
  )
    fail();
  if ('result' in simulation && simulation.result) {
    if (
      context.source.pending ||
      !['running', 'completed', 'stopped'].includes(simulation.status) ||
      !['live', 'completed', 'partial'].includes(simulation.result.status) ||
      (simulation.result.status === 'live') !== (simulation.status === 'running') ||
      (simulation.result.status === 'partial') !== (simulation.status === 'stopped') ||
      !Array.isArray(simulation.result.traces) ||
      simulation.result.sampleCount < 2
    )
      fail();
    const result = simulation.result;
    if (
      result.sampleCount > 200000 ||
      !Number.isInteger(result.sampleCount) ||
      result.timeUnit !== 's' ||
      !Array.isArray(result.timeRange) ||
      result.timeRange.length !== 2 ||
      result.timeRange.some((t) => typeof t !== 'number' || !Number.isFinite(t)) ||
      result.timeRange[0] < 0 ||
      result.timeRange[0] >= result.timeRange[1] ||
      !result.traces.length ||
      result.traces.length > 4096 ||
      new Set(result.traces.map((trace) => trace.vector)).size !== result.traces.length ||
      Object.keys(result).some(
        (key) =>
          !['status', 'sampleCount', 'timeUnit', 'timeRange', 'sampling', 'traces'].includes(key),
      )
    )
      fail();
    let points = 0;
    for (const trace of result.traces) {
      if (
        typeof trace.vector !== 'string' ||
        !trace.vector ||
        typeof trace.label !== 'string' ||
        !['V', 'A'].includes(trace.unit) ||
        !trace.statistics ||
        Object.values(trace.statistics).some((v) => typeof v !== 'number' || !Number.isFinite(v)) ||
        trace.statistics.min > trace.statistics.max
      )
        fail();
      for (const samples of [
        trace.samples,
        ...(trace.visibleWindow ? [trace.visibleWindow.samples] : []),
      ]) {
        if (
          !Array.isArray(samples) ||
          !samples.length ||
          (points += samples.length) > 65000 ||
          samples.some(
            (pair, i) =>
              !Array.isArray(pair) ||
              pair.length !== 2 ||
              pair.some((v) => typeof v !== 'number' || !Number.isFinite(v)) ||
              pair[0] < result.timeRange[0] ||
              pair[0] > result.timeRange[1] ||
              (i > 0 && pair[0] <= samples[i - 1][0]),
          )
        )
          fail();
      }
    }
  }
}
