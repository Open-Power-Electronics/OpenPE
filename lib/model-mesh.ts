import * as THREE from 'three';

export type MeshData = {
  color?: number[];
  attributes: { position: { array: number[] }; normal?: { array: number[] } };
  index: { array: number[] };
  brep_faces?: { first: number; last: number; color: number[] | null }[];
};
export function modelMeshGroup(meshes: MeshData[]): THREE.Group {
  const group = new THREE.Group();
  for (const m of meshes) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(m.attributes.position.array, 3),
    );
    geometry.setIndex(m.index.array);
    if (m.attributes.normal)
      geometry.setAttribute(
        'normal',
        new THREE.Float32BufferAttribute(m.attributes.normal.array, 3),
      );
    else geometry.computeVertexNormals();
    const material = (rgb: number[]) =>
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(rgb[0], rgb[1], rgb[2]),
        roughness: 0.6,
        metalness: 0.15,
      });
    const baseColor = m.color || [0.45, 0.45, 0.45];
    const materials = [material(baseColor)];
    const byColor = new Map([[JSON.stringify(baseColor), 0]]);
    for (const face of m.brep_faces ?? []) {
      const color = face.color || baseColor,
        key = JSON.stringify(color);
      let index = byColor.get(key);
      if (index === undefined) {
        index = materials.length;
        materials.push(material(color));
        byColor.set(key, index);
      }
      const start = face.first * 3,
        count = (face.last - face.first + 1) * 3,
        previous = geometry.groups.at(-1);
      // STEP faces often split one unchanged material into dozens of draws.
      // Keep index/face ordering exactly and combine only contiguous ranges.
      if (previous?.materialIndex === index && previous.start + previous.count === start)
        previous.count += count;
      else geometry.addGroup(start, count, index);
    }
    // Three.js renders material arrays only through explicit geometry groups.
    // Uncoloured parser meshes may omit face ranges entirely.
    if (!geometry.groups.length) geometry.addGroup(0, m.index.array.length, 0);
    group.add(new THREE.Mesh(geometry, materials));
  }
  return group;
}
/** Retain the exact parser meshes while yielding between bounded build batches. */
export async function modelMeshGroupAsync(
  meshes: MeshData[],
  checkpoint: () => Promise<void>,
  budgetMs = 8,
): Promise<THREE.Group> {
  const group = new THREE.Group();
  let started = performance.now();
  try {
    for (const mesh of meshes) {
      const part = modelMeshGroup([mesh]);
      group.add(...part.children);
      if (performance.now() - started >= budgetMs) {
        await checkpoint();
        started = performance.now();
      }
    }
    return group;
  } catch (error) {
    disposeModelGroup(group);
    throw error;
  }
}
/** Native opacity belongs to this placement, never the cached model template. */
export function cloneModelInstance(template: THREE.Group, opacity?: number): THREE.Group {
  if (opacity !== undefined && (!Number.isFinite(opacity) || opacity < 0 || opacity > 1))
    throw new Error('3D model opacity must be a number from 0 to 1.');
  const instance = template.clone(true);
  if (opacity === undefined) return instance;
  const copies = new Map<THREE.Material, THREE.Material>();
  const material = (original: THREE.Material) => {
    let copy = copies.get(original);
    if (!copy) {
      copy = original.clone();
      copy.opacity = opacity;
      copy.transparent = original.transparent || opacity < 1;
      if (opacity < 1) copy.depthWrite = false;
      copies.set(original, copy);
    }
    return copy;
  };
  instance.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    node.material = Array.isArray(node.material)
      ? node.material.map(material)
      : material(node.material);
  });
  return instance;
}
export function disposeModelGroup(group: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>(),
    materials = new Set<THREE.Material>();
  group.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const m of Array.isArray(object.material) ? object.material : [object.material])
      materials.add(m);
  });
  geometries.forEach((g) => g.dispose());
  materials.forEach((m) => m.dispose());
}
