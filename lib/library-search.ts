import { api } from './bridge';
import type { LibraryEntry } from './library';

export type LibrarySearchProgress = { completed: number; total: number };
export type LibrarySearchPage = {
  entries: LibraryEntry[];
  libraries: string[];
  total: number;
  nextOffset?: number | null;
};

export function isLibrarySearchProgress(value: unknown): value is LibrarySearchProgress {
  if (!value || typeof value !== 'object') return false;
  const { completed, total } = value as Partial<LibrarySearchProgress>;
  return (
    typeof completed === 'number' &&
    typeof total === 'number' &&
    Number.isSafeInteger(completed) &&
    Number.isSafeInteger(total) &&
    total > 0 &&
    completed >= 0 &&
    completed <= total
  );
}

export async function readLibrarySearch(
  {
    kind,
    query = '',
    library = '',
    category = '',
    offset = 0,
    includeAssetStatus = false,
  }: {
    kind: 'symbols' | 'footprints';
    query?: string;
    library?: string;
    category?: string;
    offset?: number;
    includeAssetStatus?: boolean;
  },
  signal: AbortSignal,
  onProgress?: (value: LibrarySearchProgress) => void,
): Promise<LibrarySearchPage> {
  const params = new URLSearchParams({ q: query, library, offset: String(offset) });
  if (category) params.set('category', category);
  if (includeAssetStatus) params.set('includeAssetStatus', '1');
  const stream = includeAssetStatus && onProgress;
  const response = await api(`libraries/${kind}?${params}`, {
    signal,
    ...(stream && { headers: { Accept: 'application/x-ndjson' } }),
  });
  if (!stream) return response.json();
  if (
    !response.body ||
    response.headers.get('content-type')?.split(';')[0] !== 'application/x-ndjson'
  )
    throw new Error('Invalid library search response.');

  const reader = response.body
    .pipeThrough(new TextDecoderStream('utf-8', { fatal: true }))
    .getReader();
  const maxFrameLength = 512 * 1024;
  let pending = '';
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) throw new Error('Library search ended before the results arrived.');
      pending += value;
      let end = pending.indexOf('\n');
      while (end >= 0) {
        if (end > maxFrameLength) throw new Error('Library search response is too large.');
        const frame = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        signal.throwIfAborted();
        if (frame?.type === 'result') return frame.result;
        if (frame?.type === 'error' && typeof frame.error === 'string')
          throw Object.assign(new Error(frame.error), { code: frame.code });
        if (frame?.type !== 'progress' || !isLibrarySearchProgress(frame))
          throw new Error('Invalid library search progress.');
        stream({ completed: frame.completed, total: frame.total });
        end = pending.indexOf('\n');
      }
      if (pending.length > maxFrameLength) throw new Error('Library search response is too large.');
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
