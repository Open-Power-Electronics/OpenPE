import type { SimulationResult, SpiceDeck } from './spice';

/** Cursor intent is a time, so live appends and final linearization cannot move it. */
export function waveformCursorIndex(
  time: number[],
  cursor: number | null,
  start: number,
  end: number,
) {
  if (cursor === null) return end;
  let low = start,
    high = end;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (time[middle] < cursor) low = middle + 1;
    else high = middle;
  }
  return low > start && cursor - time[low - 1] < time[low] - cursor ? low - 1 : low;
}

/** Bind completed solver samples to the exact locally validated snapshot's probes. */
export function validatedSimulationResult(value: unknown, deck: SpiceDeck): SimulationResult {
  const result = value as SimulationResult | null;
  if (
    !result ||
    !Array.isArray(result.time) ||
    result.time.length < 2 ||
    result.time.length > 200000 ||
    !Array.isArray(result.traces) ||
    result.traces.length !== deck.traces.length ||
    typeof result.version !== 'string' ||
    !result.version ||
    typeof result.log !== 'string'
  )
    throw new Error(
      'Incompatible simulation response. Restart OpenPE to reload the local service.',
    );
  if (
    result.time.some((t, i, time) => !Number.isFinite(t) || t < 0 || (i > 0 && t <= time[i - 1])) ||
    result.time[0] !== 0 ||
    Math.abs(result.time.at(-1)! - deck.stop) > Math.max(1e-12, deck.stop * 1e-6)
  )
    throw new Error('Incomplete or invalid simulation samples. Run the simulation again.');
  const traces = deck.traces.map((trace, i) => {
    const received = result.traces[i];
    if (
      !received ||
      received.vector !== trace.vector ||
      received.unit !== trace.unit ||
      !Array.isArray(received.values) ||
      received.values.length !== result.time.length ||
      received.values.some((v) => !Number.isFinite(v))
    )
      throw new Error('Invalid simulation trace. Restart OpenPE and run the simulation again.');
    return { ...trace, values: received.values };
  });
  const heat = result.dissipation;
  if (heat !== undefined) {
    const paths = deck.traces.filter((trace) => trace.dissipation);
    if (
      !heat ||
      Object.keys(heat).some((key) => !['startS', 'endS', 'sampleCount', 'powers'].includes(key)) ||
      heat.startS !== deck.stop * 0.8 ||
      heat.endS !== deck.stop ||
      !Number.isSafeInteger(heat.sampleCount) ||
      heat.sampleCount < result.time.length ||
      !Array.isArray(heat.powers) ||
      heat.powers.length !== paths.length ||
      heat.powers.some(
        (power, i) =>
          !power ||
          Object.keys(power).some((key) => !['vector', 'powerW'].includes(key)) ||
          power.vector !== paths[i].vector ||
          !Number.isFinite(power.powerW),
      )
    )
      throw new Error('Invalid full-resolution SPICE heat summary. Run SPICE again.');
  }
  return {
    time: result.time,
    traces,
    version: result.version,
    log: result.log,
    ...(heat
      ? { dissipation: { ...heat, powers: heat.powers.map((power) => ({ ...power })) } }
      : {}),
  };
}

/** Preserve each bucket's extrema in time order, including narrow switching peaks. */
export function waveformIndices(
  values: number[],
  start: number,
  end: number,
  buckets = 700,
): number[] {
  if (end < start) return [];
  const indices = new Set([start, end]);
  const width = Math.max(1, Math.ceil((end - start + 1) / buckets));
  for (let first = start; first <= end; first += width) {
    let min = first,
      max = first;
    for (let i = first + 1; i <= Math.min(end, first + width - 1); i++) {
      if (values[i] < values[min]) min = i;
      if (values[i] > values[max]) max = i;
    }
    indices.add(min);
    indices.add(max);
  }
  return [...indices].sort((a, b) => a - b);
}
