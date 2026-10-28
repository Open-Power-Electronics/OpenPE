import type { SimulationResult, SpiceDeck } from './spice';

export type SimulationSamples = { offset: number; time: number[]; values: number[][] };

/** Append only finite, contiguous samples belonging to the locally generated probes. */
export function appendSimulationSamples(
  previous: SimulationResult | null,
  value: unknown,
  deck: SpiceDeck,
): SimulationResult {
  const packet = value as SimulationSamples | null;
  const offset = previous?.time.length ?? 0;
  if (
    !packet ||
    packet.offset !== offset ||
    !Array.isArray(packet.time) ||
    !packet.time.length ||
    packet.time.length > 2048 ||
    offset + packet.time.length > 200000 ||
    !Array.isArray(packet.values) ||
    packet.values.length !== deck.traces.length ||
    packet.values.some(
      (values) =>
        !Array.isArray(values) ||
        values.length !== packet.time.length ||
        values.some((v) => !Number.isFinite(v)),
    )
  )
    throw new Error('Invalid live simulation samples. Run the simulation again.');
  let last = previous?.time.at(-1) ?? -1;
  for (const time of packet.time) {
    if (
      !Number.isFinite(time) ||
      time < 0 ||
      time <= last ||
      time > deck.stop + Math.max(1e-12, deck.stop * 1e-6)
    )
      throw new Error('Invalid live simulation time. Run the simulation again.');
    last = time;
  }
  return {
    version: '',
    log: '',
    time: [...(previous?.time ?? []), ...packet.time],
    traces: deck.traces.map((trace, i) => ({
      ...trace,
      values: [...(previous?.traces[i].values ?? []), ...packet.values[i]],
    })),
  };
}

/** Bounded SSE decoder; EOF without a validated completed event is a failure. */
export async function readSimulationEvents(
  body: ReadableStream<Uint8Array>,
  receive: (event: { type: string; [key: string]: unknown }) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '',
    bytes = 0,
    completed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      bytes += value?.byteLength ?? 0;
      if (bytes > 96 * 1024 * 1024) throw new Error('Simulation stream exceeded its output limit.');
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 64 * 1024 * 1024)
        throw new Error('Simulation event exceeded its size limit.');
      let end;
      while ((end = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, end.index);
        buffer = buffer.slice(end.index + end[0].length);
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        const event = JSON.parse(data);
        if (completed || !event || !['started', 'samples', 'result', 'error'].includes(event.type))
          throw new Error('Incompatible simulation stream. Restart OpenPE.');
        if (event.type === 'error')
          throw Object.assign(
            new Error(typeof event.message === 'string' ? event.message : 'Simulation failed.'),
            { code: event.code === 'OPENPE_SPICE_CONVERGENCE' ? event.code : undefined },
          );
        receive(event);
        if (event.type === 'result') completed = true;
      }
      if (done) break;
    }
    if (!completed || buffer.trim())
      throw new Error('Simulation disconnected before completion. Run it again.');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
