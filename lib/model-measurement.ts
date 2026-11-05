import {
  Box3,
  Vector3,
  type BufferGeometry,
  type Intersection,
  type Material,
  type Object3D,
} from 'three';
import type { MeasurementPoint } from './canvas-measurement';

/** Rendered component body center; captions, hidden meshes and previews are excluded. */
function componentCenter(component: Object3D): MeasurementPoint | null {
  const bounds = new Box3();
  const visit = (node: Object3D) => {
    if (!node.visible || node.userData.modelCadPreview || node.userData.modelMeasurementExcluded)
      return;
    const mesh = node as Object3D & { geometry?: BufferGeometry; material?: Material | Material[] };
    const materials =
      mesh.material && (Array.isArray(mesh.material) ? mesh.material : [mesh.material]);
    if (mesh.geometry && materials?.some((material) => material.visible && material.opacity > 0)) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (mesh.geometry.boundingBox)
        bounds.union(mesh.geometry.boundingBox.clone().applyMatrix4(node.matrixWorld));
    }
    for (const child of node.children) visit(child);
  };
  visit(component);
  if (bounds.isEmpty()) return null;
  const center = bounds.getCenter(new Vector3());
  return [center.x, center.y, center.z].every(Number.isFinite)
    ? { x: center.x, y: -center.y, z: center.z }
    : null;
}

/** Measure the visible displayed surface, never hidden or transient preview geometry. */
export function modelMeasurementPoint(
  hits: readonly Intersection<Object3D>[],
  snap?: {
    project: (point: MeasurementPoint) => { x: number; y: number } | null;
    pointer: { x: number; y: number };
    tolerance: number;
    visible: (point: MeasurementPoint, component?: Object3D) => boolean;
  },
): MeasurementPoint | null {
  for (const hit of hits) {
    const material = (hit.object as Object3D & { material?: Material | Material[] }).material;
    const faceMaterial = Array.isArray(material)
      ? material[hit.face?.materialIndex ?? 0]
      : material;
    if (faceMaterial && (!faceMaterial.visible || faceMaterial.opacity === 0)) continue;
    if (
      typeof hit.object.userData.modelMeasurementVisibleAtUV === 'function' &&
      !hit.object.userData.modelMeasurementVisibleAtUV(hit.uv)
    )
      continue;
    let surface = false;
    let excluded = false;
    let estimated = false;
    let component: Object3D | undefined;
    for (let node: Object3D | null = hit.object; node; node = node.parent) {
      if (!node.visible || node.userData.modelCadPreview || node.userData.modelMeasurementExcluded)
        excluded = true;
      if (node.userData.modelBoard || node.userData.modelCadId || node.userData.footprintId)
        surface = true;
      if (node.userData.estimated) estimated = true;
      if (node.userData.footprintId) component = node;
    }
    if (!excluded && surface && [hit.point.x, hit.point.y, hit.point.z].every(Number.isFinite)) {
      const point: MeasurementPoint = {
        x: hit.point.x,
        y: -hit.point.y,
        z: hit.point.z,
        ...(estimated ? { estimated: true } : {}),
      };
      const position = (hit.object as Object3D & { geometry?: BufferGeometry }).geometry?.attributes
        .position;
      if (snap && component) {
        const center = componentCenter(component);
        const screen = center && snap.project(center);
        if (
          center &&
          screen &&
          Math.hypot(screen.x - snap.pointer.x, screen.y - snap.pointer.y) <= snap.tolerance &&
          snap.visible(center, component)
        )
          return { ...center, ...(estimated ? { estimated: true } : {}), snapped: true };
      }
      if (snap && hit.face && position) {
        const candidates = [hit.face.a, hit.face.b, hit.face.c]
          .map((index) => {
            const vertex = new Vector3()
              .fromBufferAttribute(position, index)
              .applyMatrix4(hit.object.matrixWorld);
            const at: MeasurementPoint = {
              x: vertex.x,
              y: -vertex.y,
              z: vertex.z,
              ...(estimated ? { estimated: true as const } : {}),
            };
            const screen = snap.project(at);
            return {
              at,
              distance: screen
                ? Math.hypot(screen.x - snap.pointer.x, screen.y - snap.pointer.y)
                : Infinity,
            };
          })
          .filter((candidate) => candidate.distance <= snap.tolerance)
          .sort((a, b) => a.distance - b.distance);
        const candidate = candidates.find(({ at }) => snap.visible(at));
        if (candidate) return { ...candidate.at, snapped: true };
      }
      return point;
    }
  }
  return null;
}
