import { api } from './bridge';
import { onlineFootprintLibrary } from './library';
import { attachOnlineFootprint, projectFootprintSource } from './library-project-assets';
import type { FootprintSource } from './pcb-sync';
import type { Project } from './project';

/** Prepare native backing even when this symbol has no linked PCB instance. */
export async function prepareSchematicPackage(project: Project, id: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!onlineFootprintLibrary(id) || projectFootprintSource(project, id)) return project.nativeFiles;
  const detail = await loadLibraryFootprint(id, signal);
  signal.throwIfAborted();
  return attachOnlineFootprint(project, detail).nativeFiles;
}

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
