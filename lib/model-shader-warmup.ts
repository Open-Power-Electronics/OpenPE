/** Bound Three's shader polling and keep renderer disposal with its scene owner.
 * In the bundled Three renderer, dispose clears material program properties;
 * compileAsync then drops those materials on its next 10 ms polling check.
 */
export function prepareModelShaders({
  compile,
  dispose,
  signal,
  timeoutMs = 10000,
}: {
  compile: () => Promise<unknown>;
  dispose: () => void;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (error !== undefined) reject(error);
      else resolve();
    };
    const stop = (error: unknown) => {
      if (settled) return;
      try {
        dispose();
      } catch (cause) {
        finish(cause);
        return;
      }
      finish(error ?? new Error('3D shader preparation failed. Retry the preview.'));
    };
    const abort = () => stop(new Error('Preview cancelled.'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(
      () => stop(new Error('3D shader preparation timed out. Retry the preview.')),
      timeoutMs,
    );
    try {
      void compile().then(() => finish(), stop);
    } catch (error) {
      stop(error);
    }
  });
}
