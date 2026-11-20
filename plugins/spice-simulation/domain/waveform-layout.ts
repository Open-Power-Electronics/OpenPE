export const waveformGridColumns = 4;
export const waveformGridRows = 3;

export function waveformGrid(layout: string) {
  const match = /^([1-3])x([1-4])$/.exec(layout);
  return match ? { rows: Number(match[1]), columns: Number(match[2]) } : null;
}

/** Auto fills each row. Explicit grids retain chosen dimensions and add rows
 * when their capacity is exceeded, without hiding any traces. */
export function waveformRows(
  count: number,
  layout: string,
  width: number,
  height: number,
): number[] {
  if (count <= 0) return [];
  const grid = waveformGrid(layout);
  if (grid) return Array(Math.max(grid.rows, Math.ceil(count / grid.columns))).fill(grid.columns);
  let columns = 1;
  if (layout === 'auto') {
    let best = Infinity;
    for (let candidate = 1; candidate <= count; candidate++) {
      const rows = Math.ceil(count / candidate);
      const w = Math.max(1, width) / candidate;
      const h = Math.max(1, height) / rows;
      const overflow = Math.max(0, 220 / w - 1) + Math.max(0, 128 / h - 1);
      const score = overflow * 10 + Math.abs(Math.log(w / h / 2.4));
      if (score < best) {
        best = score;
        columns = candidate;
      }
    }
  }
  columns = Math.min(count, columns);
  return Array.from({ length: Math.ceil(count / columns) }, (_, row) =>
    Math.min(columns, count - row * columns),
  );
}
