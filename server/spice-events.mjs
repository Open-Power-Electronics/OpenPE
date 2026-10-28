/** One bounded packet in flight; a stalled reader cannot accumulate waveforms. */
export async function sendSpiceEvent(res, event, signal) {
  if (signal.aborted || res.destroyed) throw new Error('Simulation cancelled.');
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  if (Buffer.byteLength(frame) > 64 * 1024 * 1024)
    throw new Error('Simulation event exceeded its output limit.');
  if (res.write(frame)) return;
  await new Promise((resolve, reject) => {
    const done = (error) => {
      clearTimeout(timer);
      res.off('drain', drain);
      res.off('close', cancel);
      signal.removeEventListener('abort', cancel);
      error ? reject(error) : resolve();
    };
    const drain = () => done();
    const cancel = () => done(new Error('Simulation cancelled.'));
    const timer = setTimeout(
      () => done(new Error('Waveform streaming stalled. Retry the simulation.')),
      5000,
    );
    res.once('drain', drain);
    res.once('close', cancel);
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted || res.destroyed) cancel();
  });
}
