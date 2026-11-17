import { api } from './bridge';
import type { FootprintSource } from './pcb-sync';

/** Committed package use prepares portable resources; browsing stays read-only. */
export async function loadLibraryFootprint(
  id: string,
  signal?: AbortSignal,
): Promise<FootprintSource> {
  const nextpcb = id.startsWith('NextPCB:');
  const response = await api(
    nextpcb ? 'library-package' : `libraries/footprints?id=${encodeURIComponent(id)}`,
    nextpcb ? { method: 'POST', body: JSON.stringify({ id }), signal } : { signal },
  );
  const detail = await response.json();
  if (
    detail.id !== id ||
    !Array.isArray(detail.footprint) ||
    detail.error ||
    (nextpcb && detail.projectAssets !== true)
  )
    throw new Error(detail.error || 'The prepared footprint is unavailable.');
  return detail;
}
