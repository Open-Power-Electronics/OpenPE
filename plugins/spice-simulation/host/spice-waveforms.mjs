import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { readNativeSpiceRows, spiceVectorName } from './spice-raw.mjs';

function dissipationParser(deck) {
  const expected = ['time', ...deck.traces.map((trace) => trace.vector.toLowerCase())];
  const heatStart = deck.stop * 0.8;
  const paths = deck.traces.flatMap((trace, i) => {
    if (!trace.dissipation) return [];
    const path = trace.dissipation;
    const column = (node) => (node === '0' ? -1 : expected.indexOf(`v(${node})`.toLowerCase()));
    const positive = column(path.positiveNode),
      negative = column(path.negativeNode);
    if (
      trace.unit !== 'A' ||
      positive === 0 ||
      negative === 0 ||
      (positive < 0 && path.positiveNode !== '0') ||
      (negative < 0 && path.negativeNode !== '0')
    )
      throw new Error('The generated SPICE heat path lacks its terminal voltage vectors.');
    return [{ vector: trace.vector, current: i + 1, positive, negative, energy: 0 }];
  });
  let previousValues;
  const power = (row, path) =>
    ((path.positive < 0 ? 0 : row[path.positive]) - (path.negative < 0 ? 0 : row[path.negative])) *
    row[path.current];
  return {
    active: paths.length > 0,
    row(values) {
      if (previousValues && values[0] > heatStart && previousValues[0] < deck.stop) {
        const a = Math.max(heatStart, previousValues[0]),
          b = Math.min(deck.stop, values[0]);
        const fraction = (a - previousValues[0]) / (values[0] - previousValues[0]);
        const endFraction = (b - previousValues[0]) / (values[0] - previousValues[0]);
        for (const path of paths) {
          const before = power(previousValues, path),
            after = power(values, path);
          path.energy +=
            (before + (after - before) * fraction + before + (after - before) * endFraction) *
            0.5 *
            (b - a);
          if (!Number.isFinite(path.energy))
            throw new Error('ngspice returned non-finite dissipative energy.');
        }
      }
      previousValues = values;
    },
    finish(sampleCount) {
      return paths.length
        ? {
            startS: heatStart,
            endS: deck.stop,
            sampleCount,
            powers: paths.map((path) => ({
              vector: path.vector,
              powerW: path.energy / (deck.stop - heatStart),
            })),
          }
        : undefined;
    },
  };
}

/** Signed terminal power uses accepted native rows, never interpolated display curves.
 * @param {string} file
 * @param {import('../domain/spice').SpiceDeck} deck
 * @param {AbortSignal} [signal]
 */
export async function readNativeSpiceDissipation(file, deck, signal = undefined) {
  signal?.throwIfAborted();
  const heat = dissipationParser(deck);
  if (!heat.active) return undefined;
  const count = await readNativeSpiceRows(file, deck, heat.row, signal);
  return heat.finish(count);
}

/** Validate every text output row, retaining actual extrema for the display budget. */
function waveformParser(deck) {
  const expected = ['time', ...deck.traces.map((trace) => trace.vector.toLowerCase())];
  const heat = dissipationParser(deck);
  const rowBudget = Math.min(200000, Math.floor(1100000 / expected.length));
  const bucketCount = Math.max(
    1,
    Math.min(2000, Math.floor(rowBudget / (2 * deck.traces.length + 2))),
  );
  let header = false,
    count = 0,
    previousTime = -1,
    reduced = false,
    bucketIndex = -1,
    first,
    last,
    minima,
    maxima;
  let rows = [];
  function flush() {
    if (!first) return;
    rows.push(...[...new Set([first, last, ...minima, ...maxima])].sort((a, b) => a[0] - b[0]));
    first = last = minima = maxima = undefined;
  }
  function reduce(values) {
    const index = Math.min(bucketCount - 1, Math.floor((values[0] / deck.stop) * bucketCount));
    if (index !== bucketIndex) {
      flush();
      bucketIndex = index;
    }
    if (!first) {
      first = values;
      minima = deck.traces.map(() => values);
      maxima = deck.traces.map(() => values);
    }
    last = values;
    for (let i = 1; i < values.length; i++) {
      if (values[i] < minima[i - 1][i]) minima[i - 1] = values;
      if (values[i] > maxima[i - 1][i]) maxima[i - 1] = values;
    }
  }
  return {
    line(line) {
      if (!line.trim()) return;
      const cells = line.trim().split(/\s+/);
      if (!header) {
        if (JSON.stringify(cells.map(spiceVectorName)) !== JSON.stringify(expected))
          throw new Error('ngspice returned unexpected waveform columns.');
        header = true;
        return;
      }
      const values = cells.map(Number);
      if (
        cells.length !== expected.length ||
        values.some((value) => !Number.isFinite(value)) ||
        values[0] < 0 ||
        values[0] <= previousTime ||
        (count === 0 && values[0] !== 0)
      )
        throw new Error('ngspice returned invalid or non-monotonic waveform data.');
      previousTime = values[0];
      count++;
      if (heat.active) heat.row(values);
      if (!reduced && rows.length < rowBudget) rows.push(values);
      else {
        if (!reduced) {
          reduced = true;
          const buffered = rows;
          rows = [];
          for (const row of buffered) reduce(row);
        }
        reduce(values);
      }
    },
    finish() {
      if (!header || count < 2) throw new Error('ngspice returned an invalid sample count.');
      if (Math.abs(previousTime - deck.stop) > Math.max(1e-12, deck.stop * 1e-6))
        throw new Error(
          'ngspice stopped before the requested end time. Review the solver log and circuit.',
        );
      if (reduced) flush();
      return {
        time: rows.map((row) => row[0]),
        traces: deck.traces.map((trace, i) => ({
          ...trace,
          values: rows.map((row) => row[i + 1]),
        })),
        ...(heat.active ? { dissipation: heat.finish(count) } : {}),
      };
    },
  };
}

export function parseWaveforms(text, deck) {
  const parser = waveformParser(deck);
  for (const line of text.split(/\r?\n/)) parser.line(line);
  return parser.finish();
}

/** File size does not gate a run; read incrementally so it cannot exhaust renderer memory.
 * @param {string} file
 * @param {import('../domain/spice').SpiceDeck} deck
 * @param {AbortSignal} [signal]
 */
export async function readWaveforms(file, deck, signal = undefined) {
  const input = createReadStream(file, { encoding: 'utf8', signal });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const parser = waveformParser(deck);
  try {
    for await (const line of lines) {
      signal?.throwIfAborted();
      parser.line(line);
    }
    signal?.throwIfAborted();
    return parser.finish();
  } finally {
    lines.close();
    input.destroy();
  }
}
