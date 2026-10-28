import type { Intersection, Object3D } from 'three';

export type ModelPickOptions = { cad: boolean; components: boolean; board?: boolean };
export type ModelPickResult = {
  cad: {
    id: string;
    local: { x: number; y: number; z: number };
    normal?: { x: number; y: number; z: number };
  } | null;
  footprint: string | null;
  board: boolean;
};

/** Interpret one depth-ordered ray without picking through opaque objects.
 * Transient CAD previews never become saved CAD picks. */
export function modelPickResult(
  intersections: readonly Intersection<Object3D>[],
  options: ModelPickOptions,
): ModelPickResult {
  const result: ModelPickResult = { cad: null, footprint: null, board: false };
  let cadDone = !options.cad,
    componentDone = !options.components,
    boardDone = !options.board;
  for (const hit of intersections) {
    if (cadDone && componentDone && boardDone) break;
    let visible = true,
      preview = false;
    for (let node: Object3D | null = hit.object; node; node = node.parent) {
      if (!node.visible) visible = false;
      if (node.userData.modelCadPreview) preview = true;
    }
    if (!visible) continue;
    if (!boardDone) {
      boardDone = true;
      if (!preview)
        for (let node: Object3D | null = hit.object; node; node = node.parent)
          if (node.userData.modelBoard) {
            result.board = true;
            break;
          }
    }
    if (!cadDone && !preview) {
      cadDone = true;
      if (hit.object.userData.modelCadId) {
        const local = hit.object.worldToLocal(hit.point.clone());
        result.cad = {
          id: hit.object.userData.modelCadId,
          local: { x: local.x, y: -local.y, z: local.z },
          ...(hit.face
            ? { normal: { x: hit.face.normal.x, y: -hit.face.normal.y, z: hit.face.normal.z } }
            : {}),
        };
      }
    }
    if (!componentDone) {
      componentDone = true;
      for (let node: Object3D | null = hit.object; node; node = node.parent)
        if (node.userData.footprintId) {
          result.footprint = node.userData.footprintId as string;
          break;
        }
    }
  }
  return result;
}
