import * as THREE from 'three';

type Entry = {
  source: THREE.Object3D;
  shape: string;
  dark: boolean;
  ghost: THREE.Object3D;
  material: THREE.MeshBasicMaterial;
};

/** Own only operand ghost objects/materials; exact committed geometry remains source-owned. */
export function createModelCadOperandGhosts(root: THREE.Group) {
  const entries = new Map<string, Entry>();
  let disposed = false;
  root.userData.modelCadOperandGhost = true;
  function retire(id: string) {
    const entry = entries.get(id);
    if (!entry) return;
    root.remove(entry.ghost);
    entry.material.dispose();
    entries.delete(id);
  }
  function shapeKey(source: THREE.Object3D) {
    const meshes: string[] = [];
    source.traverse((node) => {
      if (node instanceof THREE.Mesh) meshes.push(`${node.uuid}:${node.geometry.uuid}`);
    });
    return meshes.join('|');
  }
  function pose(source: THREE.Object3D, ghost: THREE.Object3D) {
    source.updateWorldMatrix(true, true);
    root.updateWorldMatrix(true, false);
    ghost.matrix.copy(root.matrixWorld).invert().multiply(source.matrixWorld);
    ghost.matrix.decompose(ghost.position, ghost.quaternion, ghost.scale);
    ghost.visible = true;
    ghost.updateMatrix();
  }
  return {
    update(source: THREE.Group, ids: readonly string[], dark: boolean) {
      if (disposed) return;
      const requested = [...new Set(ids)];
      const available = new Map(source.children.map((child) => [child.userData.modelCadId, child]));
      for (const [id, entry] of entries) {
        const next = available.get(id);
        if (
          !requested.includes(id) ||
          next !== entry.source ||
          dark !== entry.dark ||
          shapeKey(next) !== entry.shape
        )
          retire(id);
      }
      for (const id of requested) {
        const original = available.get(id);
        if (!original) continue;
        let entry = entries.get(id);
        if (!entry) {
          const shape = shapeKey(original);
          if (!shape) continue;
          const ghost = original.clone(true);
          const material = new THREE.MeshBasicMaterial({
            color: dark ? 0xc0c7cf : 0x5c646b,
            wireframe: true,
            transparent: true,
            opacity: dark ? 0.38 : 0.3,
            depthWrite: false,
            depthTest: true,
            side: THREE.DoubleSide,
          });
          ghost.traverse((node) => {
            delete node.userData.modelCadPreview;
            delete node.userData.modelCadPending;
            node.userData.modelCadId = id;
            node.userData.modelCadOperandGhost = true;
            if (node instanceof THREE.Mesh) {
              node.material = material;
              node.visible = true;
            }
          });
          entry = { source: original, shape, dark, ghost, material };
          entries.set(id, entry);
          root.add(ghost);
        }
        pose(original, entry.ghost);
      }
      const ordered = requested.map((id) => entries.get(id)?.ghost).filter((ghost) => !!ghost);
      if (root.children.some((child, index) => child !== ordered[index]))
        for (const ghost of ordered) root.add(ghost);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const id of [...entries.keys()]) retire(id);
    },
  };
}
