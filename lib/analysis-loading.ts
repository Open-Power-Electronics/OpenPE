/** Give the loading UI a painted frame before serializing or preparing large results.
 * Abort remains effective while a hidden/inactive document is waiting for a frame. */
export function paintAnalysisLoading(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let frame: number | undefined;
    const abort = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      signal.removeEventListener('abort', abort);
      reject(signal.reason ?? new DOMException('Result loading cancelled.', 'AbortError'));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) abort();
        else resolve();
      });
    });
  });
}
