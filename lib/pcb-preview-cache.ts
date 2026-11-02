import { api } from './bridge';
import type { MeshData } from './model-mesh';
import { footprintModels } from './pcb-models';
import type { SExpr } from './sexpr';

// Bundled library IDs are immutable during a renderer session. Keep CPU data
// only, so scene disposal never invalidates another project's cached models.
export type PreviewFootprint = {
  footprint: SExpr;
  models: { path: string }[];
};
const footprints = new Map<string, PreviewFootprint>();
const meshes = new Map<string, { data: MeshData[]; weight: number }>();
const maxNumbers = 12_000_000;
let numbers = 0;
let modelQueue: Promise<void> = Promise.resolve();

function checkCancelled(signal: AbortSignal) {
  if (signal.aborted) throw new Error('Preview cancelled.');
}

export async function previewFootprint(id: string, signal: AbortSignal): Promise<PreviewFootprint> {
  checkCancelled(signal);
  const cached = footprints.get(id);
  if (cached) {
    footprints.delete(id);
    footprints.set(id, cached);
    return cached;
  }
  const response: { footprint: SExpr; models?: { path: string }[] } = await (
    await api(`libraries/footprints?id=${encodeURIComponent(id)}`, { signal })
  ).json();
  checkCancelled(signal);
  // Catalog choices include pinned instance links absent from the library's
  // placement defaults. Keep their service indices without changing defaults.
  const detail: PreviewFootprint = {
    footprint: response.footprint,
    models: (response.models ?? footprintModels(response.footprint)).map(({ path }) => ({ path })),
  };
  footprints.set(id, detail);
  if (footprints.size > 256) footprints.delete(footprints.keys().next().value!);
  return detail;
}

export function previewModel(id: string, index: number, signal: AbortSignal): Promise<MeshData[]> {
  const key = `${id}:${index}`;
  const cachedModel = () => {
    const cached = meshes.get(key);
    if (!cached) return undefined;
    meshes.delete(key);
    meshes.set(key, cached);
    return cached.data;
  };
  if (signal.aborted) return Promise.reject(new Error('Preview cancelled.'));
  const available = cachedModel();
  if (available) return Promise.resolve(available);
  // One conversion at a time across boards leaves service capacity for the
  // footprint chooser. Check the cache after queueing to share completed work.
  const result = modelQueue.then(async () => {
    checkCancelled(signal);
    const cached = cachedModel();
    if (cached) return cached;
    const data: { meshes: MeshData[] } = await (
      await api(`library-model?id=${encodeURIComponent(id)}&index=${index}`, { signal })
    ).json();
    checkCancelled(signal);
    const weight = data.meshes.reduce(
      (n, mesh) =>
        n +
        mesh.attributes.position.array.length +
        (mesh.attributes.normal?.array.length ?? 0) +
        mesh.index.array.length +
        (mesh.brep_faces?.length ?? 0) * 6,
      0,
    );
    if (weight <= maxNumbers) {
      while (meshes.size && (numbers + weight > maxNumbers || meshes.size >= 128)) {
        const oldest = meshes.keys().next().value!;
        numbers -= meshes.get(oldest)!.weight;
        meshes.delete(oldest);
      }
      meshes.set(key, { data: data.meshes, weight });
      numbers += weight;
    }
    return data.meshes;
  });
  // Failed or cancelled work must neither poison the queue nor enter the cache.
  modelQueue = result.then(
    () => {},
    () => {},
  );
  return result;
}

export async function previewAssignedModel(
  source: string,
  fileId: string | undefined,
  footprintId: string,
  index: number,
  signal: AbortSignal,
): Promise<MeshData[]> {
  const result = await (
    await api('component-model', {
      method: 'POST',
      signal,
      body: JSON.stringify({ source, ...(fileId ? { fileId } : {}), footprintId, index }),
    })
  ).json();
  checkCancelled(signal);
  return result.meshes;
}
