export class CatalogHttpError extends Error {
  constructor(provider, status) {
    super(
      status === 403
        ? `${provider} denied the request (HTTP 403).`
        : `${provider} request failed (${status}). Retry when online.`,
    );
    this.status = status;
  }
}

export async function readCatalogBytes(provider, fetcher, url, options, maximum, signal) {
  signal.throwIfAborted();
  const response = await fetcher(url, {
    ...options,
    signal,
    redirect: 'error',
    credentials: 'omit',
  });
  if (!response.ok || response.redirected || (response.url && response.url !== url)) {
    await response.body?.cancel();
    throw new CatalogHttpError(provider, response.status);
  }
  const announced = response.headers.get('content-length');
  if (announced && (!/^\d+$/.test(announced) || Number(announced) > maximum)) {
    await response.body?.cancel();
    throw new Error(`${provider} response exceeds its supported size limit.`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`${provider} returned an empty response.`);
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximum)
        throw new Error(`${provider} response exceeds its supported size limit.`);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  signal.throwIfAborted();
  return Buffer.concat(chunks);
}
