import assert from 'node:assert/strict';

export const homeSimulationDuration = 0.01;

export function homeSimulationDurationFor(id: string) {
  return id === 'reference-lm27761-wson8-pump' ? 0.005 : homeSimulationDuration;
}

/** Integrate by time, so adaptive/reduced samples do not bias the voltage mean. */
export function voltageWindow(time: number[], values: number[], start: number, end: number) {
  assert.equal(time.length, values.length, 'Voltage sample count differs from time.');
  assert.ok(
    time.length >= 2 && time[0] <= start && time.at(-1)! >= end - 1e-12,
    'Voltage samples do not cover the verification window.',
  );
  let area = 0,
    covered = 0,
    minimum = Infinity,
    maximum = -Infinity;
  for (let i = 1; i < time.length; i++) {
    const a = time[i - 1],
      b = time[i],
      va = values[i - 1],
      vb = values[i];
    assert.ok(
      [a, b, va, vb].every(Number.isFinite) && b > a,
      'Voltage samples must be finite and strictly increasing in time.',
    );
    const left = Math.max(start, a),
      right = Math.min(end, b);
    if (right <= left) continue;
    const first = va + (vb - va) * ((left - a) / (b - a));
    const last = va + (vb - va) * ((right - a) / (b - a));
    area += (first + last) * 0.5 * (right - left);
    covered += right - left;
    minimum = Math.min(minimum, first, last);
    maximum = Math.max(maximum, first, last);
  }
  assert.ok(Math.abs(covered - (end - start)) < 1e-12, 'Incomplete voltage window.');
  return { mean: area / covered, minimum, maximum, peakToPeak: maximum - minimum };
}

/** Both ripple and late drift must pass; a completed startup ramp is insufficient. */
export function verifyHomeOutput(
  time: number[],
  values: number[],
  bounds: [number, number],
  duration = homeSimulationDuration,
) {
  assert.ok(
    Math.abs(time.at(-1)! - duration) < 1e-12,
    `Simulation must complete the requested ${duration * 1000} ms.`,
  );
  const tail = voltageWindow(time, values, duration - 0.002, duration);
  const previous = voltageWindow(time, values, duration - 0.002, duration - 0.001);
  const final = voltageWindow(time, values, duration - 0.001, duration);
  const ripplePercent = (tail.peakToPeak / Math.abs(tail.mean)) * 100;
  const driftPercent = (Math.abs(final.mean - previous.mean) / Math.abs(tail.mean)) * 100;
  const metrics = {
    ...tail,
    previousMean: previous.mean,
    finalMean: final.mean,
    ripplePercent,
    driftPercent,
  };
  assert.ok(
    tail.mean >= bounds[0] && tail.mean <= bounds[1],
    `Output voltage outside expected range: ${JSON.stringify(metrics)}`,
  );
  assert.ok(ripplePercent <= 5, `Output ripple exceeds 5%: ${JSON.stringify(metrics)}`);
  assert.ok(driftPercent <= 1, `Output drift exceeds 1%: ${JSON.stringify(metrics)}`);
  return metrics;
}
