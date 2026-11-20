export type WaveformAxis = { min: number; max: number; step?: number };
export type WaveformView = {
  range: 'full' | 'tail';
  time: WaveformAxis | null;
  values: Record<string, WaveformAxis>;
};
export const initialWaveformView = (): WaveformView => ({ range: 'full', time: null, values: {} });
export type WaveformHistory = {
  past: WaveformView[];
  present: WaveformView;
  future: WaveformView[];
};
export const initialWaveformHistory = (): WaveformHistory => ({
  past: [],
  present: initialWaveformView(),
  future: [],
});
export function changeWaveformView(history: WaveformHistory, next: WaveformView): WaveformHistory {
  if (JSON.stringify(history.present) === JSON.stringify(next)) return history;
  return { past: [...history.past, history.present].slice(-64), present: next, future: [] };
}
export function navigateWaveformView(
  history: WaveformHistory,
  direction: 'back' | 'forward',
): WaveformHistory {
  if (direction === 'back')
    return history.past.length
      ? {
          past: history.past.slice(0, -1),
          present: history.past.at(-1)!,
          future: [history.present, ...history.future],
        }
      : history;
  return history.future.length
    ? {
        past: [...history.past, history.present],
        present: history.future[0],
        future: history.future.slice(1),
      }
    : history;
}
export function validWaveformAxis(axis: WaveformAxis): boolean {
  const span = axis.max - axis.min;
  return (
    Number.isFinite(axis.min) &&
    Number.isFinite(axis.max) &&
    Number.isFinite(span) &&
    span >
      Math.max(
        Number.MIN_VALUE,
        Math.max(Math.abs(axis.min), Math.abs(axis.max)) * Number.EPSILON * 16,
      ) &&
    (axis.step === undefined ||
      (Number.isFinite(axis.step) && axis.step > 0 && span / axis.step <= 100 && axis.step <= span))
  );
}
/** Scale about the view centre, clamping time to available samples and resetting tick spacing. */
export function zoomWaveformAxis(
  axis: WaveformAxis,
  factor: number,
  bounds?: WaveformAxis,
): WaveformAxis | null {
  if (!validWaveformAxis(axis) || !Number.isFinite(factor) || factor <= 0) return null;
  if (bounds && !validWaveformAxis(bounds)) return null;
  if (
    bounds &&
    (axis.max - axis.min) * factor >= (bounds.max - bounds.min) * (1 - Number.EPSILON * 8)
  )
    return { min: bounds.min, max: bounds.max };
  const span = Math.min(
    (axis.max - axis.min) * factor,
    bounds ? bounds.max - bounds.min : Infinity,
  );
  let min = axis.min + (axis.max - axis.min - span) / 2;
  if (bounds) min = Math.max(bounds.min, Math.min(bounds.max - span, min));
  const next = { min, max: bounds ? Math.min(bounds.max, min + span) : min + span };
  return validWaveformAxis(next) ? next : null;
}
/** Translate an axis without changing its scale or explicit tick spacing. */
export function panWaveformAxis(
  axis: WaveformAxis,
  delta: number,
  bounds?: WaveformAxis,
): WaveformAxis | null {
  if (!validWaveformAxis(axis) || !Number.isFinite(delta)) return null;
  const span = axis.max - axis.min;
  if (bounds && (!validWaveformAxis(bounds) || span > bounds.max - bounds.min)) return null;
  let min = axis.min + delta;
  if (bounds) min = Math.max(bounds.min, Math.min(bounds.max - span, min));
  const next = { ...axis, min, max: bounds ? Math.min(bounds.max, min + span) : min + span };
  return validWaveformAxis(next) ? next : null;
}
export function niceWaveformStep(span: number, divisions = 4) {
  const rough = span / divisions;
  const power = 10 ** Math.floor(Math.log10(rough));
  return ([1, 2, 2.5, 5, 10].find((n) => n * power >= rough) ?? 10) * power;
}
export function waveformTicks(axis: WaveformAxis, divisions = 4): number[] {
  const step = axis.step ?? niceWaveformStep(axis.max - axis.min, divisions);
  if (!Number.isFinite(step) || step <= 0) return [];
  const first = Math.ceil(axis.min / step - 1e-10);
  const count = Math.min(101, Math.max(0, Math.floor(axis.max / step + 1e-10) - first + 1));
  return Array.from({ length: count }, (_, i) => Number(((first + i) * step).toPrecision(12)));
}
/** Real samples inside the view; callers include neighbours when drawing clipped segments. */
export function waveformSampleWindow(time: number[], axis: WaveformAxis): [number, number] {
  const bound = (value: number, upper: boolean) => {
    let low = 0,
      high = time.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (time[mid] < value || (upper && time[mid] === value)) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  return [bound(axis.min, false), bound(axis.max, true) - 1];
}
export function validWaveformTime(time: number[], axis: WaveformAxis) {
  const [first, last] = waveformSampleWindow(time, axis);
  return validWaveformAxis(axis) && axis.min >= time[0] && axis.max <= time.at(-1)! && first < last;
}
/** Strict engineering notation, with an optional matching physical unit. */
export function parseWaveformNumber(text: string, unit: 's' | 'V' | 'A'): number {
  let value = text.trim();
  if (value.endsWith(unit)) value = value.slice(0, -unit.length).trim();
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(meg|[pnuµμmkKMG])?$/i.exec(value);
  if (!match) return NaN;
  const suffix = match[2] ?? '';
  const scales: Record<string, number> = {
    p: -12,
    n: -9,
    u: -6,
    µ: -6,
    μ: -6,
    m: -3,
    k: 3,
    K: 3,
    M: 6,
    G: 9,
    meg: 6,
  };
  const [mantissa, exponent = '0'] = match[1].toLowerCase().split('e');
  return Number(
    `${mantissa}e${Number(exponent) + (suffix ? (scales[suffix] ?? scales[suffix.toLowerCase()]) : 0)}`,
  );
}
