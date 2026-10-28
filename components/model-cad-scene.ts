import * as THREE from 'three';
import {
  modelCadGeometryKey,
  modelCadRequiresPreparation,
  type ModelCadObject,
} from '../lib/model-cad';
import { disposeModelGroup, type MeshData } from '../lib/model-mesh';
import { prepareModelCadPreview } from '../lib/model-cad-preview';
import { modelCadKernelMesh, modelCadMesh, setModelCadPose } from './model-cad-mesh';

// Snapshot only the parameters that construct the mesh. Names, feature IDs and
// world poses do not change its local geometry or presentation material.
const meshKey = (body: ModelCadObject) =>
  JSON.stringify([modelCadGeometryKey(body), body.material, body.opacity]);

type Entry = {
  body: ModelCadObject;
  mesh: THREE.Object3D;
  key: string;
  control?: AbortController;
  failed?: boolean;
  pendingMeshes?: readonly MeshData[];
};
type Options = {
  active?: () => boolean;
  onChange?: () => void;
  onError?: (message: string) => void;
  loadAdvanced?: (body: ModelCadObject, signal: AbortSignal) => Promise<readonly MeshData[]>;
};

/** Own one scene-local CAD group, never shared component templates or other previews. */
export function createModelCadScene(
  root: THREE.Group,
  restoreSelection: () => void,
  preview = false,
  options: Options = {},
) {
  const entries = new Map<string, Entry>();
  let order: string[] = [];
  let disposed = false;
  function reorder() {
    const ordered = order.map((id) => entries.get(id)?.mesh).filter((mesh) => !!mesh);
    if (root.children.some((child, index) => child !== ordered[index]))
      for (const mesh of ordered) root.add(mesh);
  }
  function publish(entry: Entry, meshes: readonly MeshData[]) {
    if (options.active?.() === false) {
      // A hidden view retains owned face data, without creating Three resources.
      entry.pendingMeshes = structuredClone(meshes);
      return;
    }
    const mesh = modelCadKernelMesh(entry.body, meshes, preview);
    restoreSelection();
    root.remove(entry.mesh);
    disposeModelGroup(entry.mesh);
    entry.mesh = mesh;
    root.add(mesh);
    reorder();
    options.onChange?.();
  }
  function failed(entry: Entry, error: unknown) {
    if (disposed || entry.control?.signal.aborted || entries.get(entry.body.id) !== entry) return;
    entry.failed = true;
    options.onError?.(error instanceof Error ? error.message : 'CAD preview failed.');
  }
  function load(entry: Entry) {
    if (entry.failed || options.active?.() === false) return;
    if (entry.pendingMeshes) {
      const meshes = entry.pendingMeshes;
      entry.pendingMeshes = undefined;
      try {
        publish(entry, meshes);
      } catch (error) {
        failed(entry, error);
      }
      return;
    }
    if (entry.control) return;
    const control = new AbortController();
    entry.control = control;
    const request = options.loadAdvanced
      ? options.loadAdvanced(entry.body, control.signal)
      : prepareModelCadPreview(entry.body, control.signal).then((result) => result.meshes);
    void request
      .then((meshes) => {
        if (disposed || control.signal.aborted || entries.get(entry.body.id) !== entry) return;
        publish(entry, meshes);
      })
      .catch((error: unknown) => failed(entry, error));
  }
  return {
    update(objects: readonly ModelCadObject[]) {
      if (disposed) return;
      const next = objects.map((body) => ({ body, key: meshKey(body) }));
      const keys = new Map(next.map(({ body, key }) => [body.id, key]));
      const retired = [...entries].filter(([id, entry]) => keys.get(id) !== entry.key);
      // Selection retains its own material copies and detached mesh references.
      // Restore those before removing or disposing any source mesh.
      if (retired.length) restoreSelection();
      for (const [id, entry] of retired) {
        entry.control?.abort();
        entry.pendingMeshes = undefined;
        root.remove(entry.mesh);
        disposeModelGroup(entry.mesh);
        entries.delete(id);
      }
      order = objects.map((body) => body.id);
      for (const { body, key } of next) {
        let entry = entries.get(body.id);
        if (!entry) {
          entry = {
            body,
            mesh: modelCadRequiresPreparation(body)
              ? new THREE.Group()
              : modelCadMesh(body, preview),
            key,
          };
          entries.set(body.id, entry);
          if (modelCadRequiresPreparation(body)) {
            entry.mesh.userData.modelCadId = body.id;
            entry.mesh.userData.modelCadPending = true;
          }
          root.add(entry.mesh);
        }
        entry.body = body;
        setModelCadPose(entry.mesh, body);
        entry.mesh.name = body.name;
        if (modelCadRequiresPreparation(body)) load(entry);
      }
      // Preserve native order for equal-depth picks without detach/attach work
      // during the usual pose update or append-only creation.
      reorder();
    },
    retry() {
      for (const entry of entries.values()) {
        if (!entry.failed) continue;
        entry.failed = false;
        entry.control = undefined;
        load(entry);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      restoreSelection();
      for (const entry of entries.values()) {
        entry.control?.abort();
        entry.pendingMeshes = undefined;
        root.remove(entry.mesh);
        disposeModelGroup(entry.mesh);
      }
      entries.clear();
    },
  };
}
