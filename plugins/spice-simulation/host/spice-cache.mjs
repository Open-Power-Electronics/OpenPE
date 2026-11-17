/** Only completed solver results enter this bounded, process-local LRU. */
export function createSpiceResultCache(maxBytes = 16 * 1024 * 1024, maxEntries = 2) {
  /** @type {Map<string, { size: number, result: import('../domain/spice').SimulationResult }>} */
  const entries = new Map();
  let bytes = 0;
  return {
    /** @param {string} key */
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      entries.set(key, entry);
      return structuredClone(entry.result);
    },
    /** @param {string} key @param {import('../domain/spice').SimulationResult} result */
    set(key, result) {
      const size =
        8 * (result.time.length + result.traces.reduce((sum, t) => sum + t.values.length, 0)) +
        Buffer.byteLength(
          JSON.stringify({
            ...result,
            time: [],
            traces: result.traces.map((t) => ({ ...t, values: [] })),
          }),
        );
      const old = entries.get(key);
      if (old) {
        bytes -= old.size;
        entries.delete(key);
      }
      if (size > maxBytes) return;
      while (entries.size && (entries.size >= maxEntries || bytes + size > maxBytes)) {
        const oldest = entries.keys().next().value;
        bytes -= entries.get(oldest).size;
        entries.delete(oldest);
      }
      entries.set(key, { size, result: structuredClone(result) });
      bytes += size;
    },
  };
}
