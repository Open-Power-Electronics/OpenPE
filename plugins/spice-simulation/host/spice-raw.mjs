import { lstat, open } from 'node:fs/promises';

// ngspice names saved device currents i(@device[param]) in raw files. Quoted
// names select these saved vectors after load, rather than the final device value.
export const spiceVectorName = (value) =>
  value
    .toLowerCase()
    .replace(/^"(.+)"$/, '$1')
    .replace(/^i\((@[^)]+)\)$/, '$1');

/** Keep the generated analysis/timing intact, and write its native samples live. */
export function liveSpiceNetlist(deck) {
  const analyses = [...deck.netlist.matchAll(/^tran (.+)$/gm)];
  if (analyses.length !== 1 || !deck.netlist.includes('.control\n'))
    throw new Error('Unsupported transient output. Rebuild OpenPE and retry.');
  const vectors = deck.traces
    .map(({ vector }) => (vector.startsWith('@') ? `"i(${vector})"` : vector))
    .join(' ');
  return deck.netlist
    .replace('.control\n', `.tran ${analyses[0][1]}\n.control\nset filetype=binary\n`)
    .replace(/^tran .+$/m, 'run waveforms.raw\nload waveforms.raw')
    .replace(/^wrdata waveforms.txt .+$/m, `wrdata waveforms.txt ${vectors}`);
}

function nativeHeader(bytes, deck) {
  const text = bytes.toString('ascii');
  const binary = /\r?\nBinary:\r?\n/.exec(text);
  if (!binary) return null;
  const source = text.slice(0, binary.index);
  const names = [...source.matchAll(/^\s*(\d+)\s+(\S+)\s+(time|voltage|current)\s*$/gm)];
  const expected = ['time', ...deck.traces.map(({ vector }) => vector.toLowerCase())];
  if (
    !/^Flags: real\s*$/m.test(source) ||
    !/^Plotname: Transient Analysis\s*$/m.test(source) ||
    Number(/^No\. Variables:\s*(\d+)/m.exec(source)?.[1]) !== expected.length ||
    names.length !== expected.length ||
    names.some((name, i) => Number(name[1]) !== i)
  )
    throw new Error('Unexpected native waveform columns.');
  const normalized = names.map((name) => spiceVectorName(name[2]));
  if (new Set(normalized).size !== expected.length || normalized[0] !== 'time')
    throw new Error('Unexpected native waveform columns.');
  const columns = expected.map((name) => normalized.indexOf(name));
  if (columns.some((column) => column < 0)) throw new Error('Missing native waveform vector.');
  if (
    columns.some(
      (column, i) =>
        names[column][3] !==
        (i === 0 ? 'time' : deck.traces[i - 1].unit === 'V' ? 'voltage' : 'current'),
    )
  )
    throw new Error('Unexpected native waveform units.');
  return {
    columns,
    offset: binary.index + binary[0].length,
    sampleCount: Number(/^No\. Points:\s*(\d+)/m.exec(source)?.[1]),
  };
}

async function readExactly(handle, bytes, position, signal) {
  let offset = 0;
  while (offset < bytes.length) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(
      bytes,
      offset,
      bytes.length - offset,
      position + offset,
    );
    if (!bytesRead) throw new Error('Incomplete native waveform payload.');
    offset += bytesRead;
  }
}

/** Read every completed native row covering the final power window before display transforms.
 * UIC may start after zero; no initial sample is fabricated. Memory is bounded by one chunk.
 * @param {string} file
 * @param {import('../domain/spice').SpiceDeck} deck
 * @param {(values: number[]) => void} receive
 * @param {AbortSignal} [signal]
 */
export async function readNativeSpiceRows(file, deck, receive, signal = undefined) {
  signal?.throwIfAborted();
  const initial = await lstat(file);
  if (!initial.isFile() || initial.isSymbolicLink())
    throw new Error('Invalid native waveform file.');
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.dev !== initial.dev || info.ino !== initial.ino)
      throw new Error('The native waveform file changed while opening.');
    const prefix = Buffer.alloc(Math.min(info.size, 65536));
    await readExactly(handle, prefix, 0, signal);
    const header = nativeHeader(prefix, deck);
    if (!header) throw new Error('Invalid native waveform header.');
    const rowBytes = (deck.traces.length + 1) * 8;
    const payload = info.size - header.offset;
    if (
      !Number.isSafeInteger(header.sampleCount) ||
      header.sampleCount < 2 ||
      payload % rowBytes !== 0 ||
      payload / rowBytes !== header.sampleCount
    )
      throw new Error('Incomplete native waveform payload.');
    const rowsPerChunk = Math.max(1, Math.floor(1048576 / rowBytes));
    let count = 0,
      previousTime = -1;
    while (count < header.sampleCount) {
      signal?.throwIfAborted();
      const rows = Math.min(rowsPerChunk, header.sampleCount - count);
      const chunk = Buffer.alloc(rows * rowBytes);
      const position = header.offset + count * rowBytes;
      await readExactly(handle, chunk, position, signal);
      for (let row = 0; row < rows; row++) {
        signal?.throwIfAborted();
        const values = header.columns.map((column) =>
          chunk.readDoubleLE(row * rowBytes + column * 8),
        );
        const time = values[0];
        if (
          values.some((value) => !Number.isFinite(value)) ||
          time < 0 ||
          time <= previousTime ||
          time > deck.stop + Math.max(1e-12, deck.stop * 1e-6)
        )
          throw new Error('Invalid or non-monotonic native waveform samples.');
        if (count === 0 && row === 0 && time > deck.stop * 0.8)
          throw new Error('Incomplete native waveform averaging coverage.');
        previousTime = time;
        receive(values);
      }
      count += rows;
    }
    if (Math.abs(previousTime - deck.stop) > Math.max(1e-12, deck.stop * 1e-6))
      throw new Error('Incomplete native waveform endpoint.');
    const final = await handle.stat();
    const current = await lstat(file);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(
        (name) => info[name] !== final[name] || info[name] !== current[name],
      )
    )
      throw new Error('The native waveform file changed while reading.');
    signal?.throwIfAborted();
    return count;
  } finally {
    await handle.close();
  }
}

/** Read only complete native little-endian rows. Polling never overlaps, and
 * backpressure bounds both pending work and the size of each emitted packet. */
export function createSpiceRawReader(file, deck, receive, inspect) {
  let handle,
    columns,
    offset = 0,
    count = 0,
    previousTime = -1,
    pending,
    closed = false;
  const rowBytes = (deck.traces.length + 1) * 8;
  const rowsPerPacket = Math.max(1, Math.min(2048, Math.floor(32768 / (deck.traces.length + 1))));
  const reduced = /^linearize$/m.test(deck.netlist);
  const rowBudget = Math.min(200000, Math.floor(1100000 / (deck.traces.length + 1)));
  const bucketCount = Math.min(
    2000,
    Math.max(1, Math.floor(rowBudget / (2 * deck.traces.length + 2))),
  );
  let bucketIndex = -1,
    first,
    last,
    minima,
    maxima;
  const staged = [];
  function flushBucket() {
    if (!first) return;
    const rows = [...new Set([first, last, ...minima, ...maxima])].sort((a, b) => a[0] - b[0]);
    staged.push(...rows);
    first = last = minima = maxima = undefined;
  }
  function accept(values) {
    if (!reduced) {
      staged.push(values);
      return;
    }
    const index = Math.min(bucketCount - 1, Math.floor((values[0] / deck.stop) * bucketCount));
    if (index !== bucketIndex) {
      flushBucket();
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
    if (values[0] >= deck.stop) flushBucket();
  }
  async function read() {
    if (closed) return;
    if (!handle) {
      try {
        handle = await open(file, 'r');
      } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
      }
    }
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('Invalid native waveform file.');
    if (!columns) {
      const header = Buffer.alloc(Math.min(stat.size, 65536));
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      const parsed = nativeHeader(header.subarray(0, bytesRead), deck);
      if (!parsed) {
        if (stat.size >= 65536) throw new Error('Invalid native waveform header.');
        return;
      }
      columns = parsed.columns;
      offset = parsed.offset;
    }
    const available = Math.floor((stat.size - offset) / rowBytes);
    for (let remaining = available; remaining > 0 && !closed;) {
      const rows = Math.min(remaining, rowsPerPacket);
      const buffer = Buffer.alloc(rows * rowBytes);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      const complete = Math.floor(bytesRead / rowBytes);
      if (!complete) return;
      for (let row = 0; row < complete; row++) {
        const values = columns.map((column) => buffer.readDoubleLE(row * rowBytes + column * 8));
        const time = values[0];
        if (
          values.some((value) => !Number.isFinite(value)) ||
          time < 0 ||
          time <= previousTime ||
          time > deck.stop + Math.max(1e-12, deck.stop * 1e-6)
        )
          throw new Error('Invalid or non-monotonic native waveform samples.');
        previousTime = time;
        inspect?.(time);
        accept(values);
      }
      offset += complete * rowBytes;
      remaining -= complete;
      while (staged.length) {
        // A full preview stops appending; the solver continues to the requested end time.
        // The completed file is validated and reduced independently for display.
        const rows = staged.splice(0, rowsPerPacket).slice(0, Math.max(0, rowBudget - count));
        if (!rows.length) continue;
        const packet = {
          offset: count,
          time: rows.map((row) => row[0]),
          values: deck.traces.map((_, i) => rows.map((row) => row[i + 1])),
        };
        count += rows.length;
        await receive(packet);
      }
    }
  }
  return {
    poll() {
      if (!pending)
        pending = read().finally(() => {
          pending = undefined;
        });
      return pending;
    },
    async close() {
      closed = true;
      try {
        await pending;
      } finally {
        await handle?.close();
      }
    },
  };
}
