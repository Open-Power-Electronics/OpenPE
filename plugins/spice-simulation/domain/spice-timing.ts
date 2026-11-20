export function validateTransientTiming(config: { stop: number; step: number }) {
  const { stop, step } = config;
  if (typeof stop !== 'number' || !Number.isFinite(stop) || stop <= 0)
    throw new Error('Duration must be a finite number greater than 0 ms.');
  if (typeof step !== 'number' || !Number.isFinite(step) || step <= 0)
    throw new Error('Max. time step must be a finite number greater than 0 µs.');
}

/** Include the end time without imposing a step count or overflowing the ratio. */
export function transientOutputStep({ stop, step }: { stop: number; step: number }) {
  const ratio = stop / step;
  if (!Number.isFinite(ratio)) return step;
  const nearest = Math.round(ratio);
  const roundingError = Math.min(0.25, 4 * Number.EPSILON * Math.max(1, ratio));
  // TSTEP also seeds ngspice's integration. Do not change it for an integer
  // interval count represented just above or below that integer by rounding.
  if (nearest >= 1 && Math.abs(ratio - nearest) <= roundingError) return Math.min(step, stop);
  return Math.min(step, stop / Math.max(1, Math.ceil(ratio)));
}
