import { Box3, type BufferGeometry, type Object3D } from 'three';

type BoundedObject = Object3D & {
  geometry?: BufferGeometry;
  boundingBox?: Box3 | null;
  computeBoundingBox?: () => void;
};

/** Match the rendered scene's visibility without counting hidden descendants. */
export function modelVisibleBounds(root: Object3D): Box3 {
  const bounds = new Box3();
  const transformed = new Box3();
  root.updateWorldMatrix(true, true);
  root.traverseVisible((object) => {
    const node = object as BoundedObject;
    if (!node.geometry) return;
    let local: Box3 | null;
    if (node.boundingBox !== undefined) {
      if (node.boundingBox === null) node.computeBoundingBox?.();
      local = node.boundingBox;
    } else {
      if (node.geometry.boundingBox === null) node.geometry.computeBoundingBox();
      local = node.geometry.boundingBox;
    }
    if (local) bounds.union(transformed.copy(local).applyMatrix4(object.matrixWorld));
  });
  return bounds;
}
