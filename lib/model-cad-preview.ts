import { api } from './bridge';
import { modelCadGeometryKey, validateModelCadObject, type ModelCadObject } from './model-cad';
import type { MeshData } from './model-mesh';

export type ModelCadPreview = { shapeKey: string; meshes: MeshData[] };

/** Bound service observations before they enter retained geometry or a Core preparation. */
export function validateModelCadPreview(input: unknown, shapeKey: string): ModelCadPreview {
  const value = input as Partial<ModelCadPreview> | null;
  if (!value || value.shapeKey !== shapeKey || !Array.isArray(value.meshes))
    throw new Error('The CAD preview does not match the requested geometry.');
  if (!value.meshes.length || value.meshes.length > 64)
    throw new Error('The CAD operation produced no supported solid.');
  let count = 0;
  const meshes = value.meshes.map((mesh) => {
    const positions = mesh?.attributes?.position?.array;
    const normals = mesh?.attributes?.normal?.array;
    const indices = mesh?.index?.array;
    if (
      !Array.isArray(positions) ||
      positions.length < 9 ||
      positions.length % 3 ||
      !positions.every((n) => Number.isFinite(n) && Math.abs(n) <= 1_000_000) ||
      !Array.isArray(indices) ||
      !indices.length ||
      indices.length % 3 ||
      !indices.every((n) => Number.isInteger(n) && n >= 0 && n < positions.length / 3) ||
      (normals !== undefined &&
        (!Array.isArray(normals) ||
          normals.length !== positions.length ||
          !normals.every(Number.isFinite)))
    )
      throw new Error('The CAD kernel returned invalid mesh geometry.');
    count += positions.length + indices.length + (normals?.length ?? 0);
    if (count > 6_000_000) throw new Error('The CAD preview exceeds the supported geometry limit.');
    return {
      attributes: {
        position: { array: [...positions] },
        ...(normals ? { normal: { array: [...normals] } } : {}),
      },
      index: { array: [...indices] },
    };
  });
  return { shapeKey, meshes };
}

type Entry = {
  control: AbortController;
  users: Set<symbol>;
  promise: Promise<ModelCadPreview>;
  result?: ModelCadPreview;
  bytes: number;
};
const previews = new Map<string, Entry>();
function trim() {
  let bytes = [...previews.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  for (const [key, entry] of previews) {
    if (previews.size <= 16 && bytes <= 64 * 1024 * 1024) break;
    if (!entry.result || entry.users.size) continue;
    previews.delete(key);
    bytes -= entry.bytes;
  }
}

/** Presentation/host adapter: fixed local kernel input, shared work, independent public arrays. */
export async function prepareModelCadPreview(
  input: ModelCadObject,
  signal?: AbortSignal,
): Promise<ModelCadPreview> {
  signal?.throwIfAborted();
  const object = validateModelCadObject(input);
  const shapeKey = modelCadGeometryKey(object);
  let entry = previews.get(shapeKey);
  if (!entry) {
    const control = new AbortController();
    const created: Entry = {
      control,
      users: new Set(),
      bytes: 0,
      promise: Promise.resolve(null as unknown as ModelCadPreview),
    };
    entry = created;
    previews.set(shapeKey, entry);
    created.promise = (async () => {
      const response = await api('model-cad/preview', {
        method: 'POST',
        body: JSON.stringify({ object }),
        signal: control.signal,
      });
      const result = validateModelCadPreview(await response.json(), shapeKey);
      control.signal.throwIfAborted();
      created.result = result;
      created.bytes = result.meshes.reduce(
        (sum, mesh) =>
          sum +
          8 *
            (mesh.attributes.position.array.length +
              (mesh.attributes.normal?.array.length ?? 0) +
              mesh.index.array.length),
        0,
      );
      trim();
      return result;
    })().catch((error: unknown) => {
      if (previews.get(shapeKey) === created) previews.delete(shapeKey);
      throw error;
    });
  }
  previews.delete(shapeKey);
  previews.set(shapeKey, entry);
  const consumer = Symbol();
  entry.users.add(consumer);
  let onAbort: (() => void) | undefined;
  try {
    const result = signal
      ? await Promise.race([
          entry.promise,
          new Promise<never>((_, reject) => {
            onAbort = () => reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
            signal.addEventListener('abort', onAbort, { once: true });
            if (signal.aborted) onAbort();
          }),
        ])
      : await entry.promise;
    signal?.throwIfAborted();
    return structuredClone(result);
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    entry.users.delete(consumer);
    if (!entry.result && !entry.users.size) {
      entry.control.abort();
      if (previews.get(shapeKey) === entry) previews.delete(shapeKey);
    }
    trim();
  }
}
