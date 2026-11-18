import { api } from './bridge';
import { onlineFootprintLibrary } from './library';
import type { FootprintSource } from './pcb-sync';

/** Committed package use prepares portable resources; browsing stays read-only. */
export async function loadLibraryFootprint(
  id: string,
  signal?: AbortSignal,
): Promise<FootprintSource> {
  const online = onlineFootprintLibrary(id);
  const response = await api(
    online ? 'library-package' : `libraries/footprints?id=${encodeURIComponent(id)}`,
    online ? { method: 'POST', body: JSON.stringify({ id }), signal } : { signal },
  );
  const detail = await response.json();
  if (
    detail.id !== id ||
    !Array.isArray(detail.footprint) ||
    detail.error ||
    (online && detail.projectAssets !== true)
  )
    throw new Error(detail.error || 'The prepared footprint is unavailable.');
  return detail;
}
