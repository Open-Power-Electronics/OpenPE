// Translate transport failures without hiding HTTP, size or integrity failures.
export async function fetchModelResponse(fetcher, url, options, provider) {
  try {
    return await fetcher(url, options);
  } catch (error) {
    if (error?.code === 'OPENPE_MODEL_FILES_MISSING') throw error;
    if (options.signal?.aborted && options.signal.reason?.name !== 'TimeoutError') throw error;
    throw new Error(
      `${provider} simulation model download ${options.signal?.aborted ? 'timed out' : 'could not connect'}. Check your internet connection and system proxy, then retry. Successfully downloaded models are cached for offline use.`,
      { cause: error },
    );
  }
}
