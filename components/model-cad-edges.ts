import * as THREE from 'three';
import {
  modelCadSelectableEdges,
  type ModelCadObject,
  type ModelCadSelectableEdge,
} from '../lib/model-cad';
import { setModelCadPose } from './model-cad-mesh';

export type ModelCadEdgePath = { edge: ModelCadSelectableEdge; points: THREE.Vector3[] };
type Viewport = { width: number; height: number };
type ScreenPoint = { x: number; y: number };
const circleSegments = 64;

/** Exact base-edge identities with bounded display paths in reflected scene-local axes. */
export function modelCadEdgePaths(object: ModelCadObject): ModelCadEdgePath[] {
  return modelCadSelectableEdges(object).map((edge) => ({
    edge,
    points:
      edge.kind === 'line'
        ? [edge.start, edge.end].map((point) => new THREE.Vector3(point.x, -point.y, point.z))
        : Array.from({ length: circleSegments + 1 }, (_, index) => {
            const angle = (index / circleSegments) * Math.PI * 2;
            return new THREE.Vector3(
              edge.center.x + edge.radiusMm * Math.cos(angle),
              -edge.center.y - edge.radiusMm * Math.sin(angle),
              edge.center.z,
            );
          }),
  }));
}

/** Presentation-only edge paint; it never becomes a surface, pick target or document field. */
export function createModelCadEdgeHighlight(
  object: ModelCadObject,
  ids: readonly string[],
  color: THREE.ColorRepresentation = 0x66b3ff,
): THREE.Group {
  const group = new THREE.Group();
  group.userData.modelCadEdgeOverlay = true;
  const selected = new Set(ids);
  const paths = modelCadEdgePaths(object).filter(({ edge }) => selected.has(edge.id));
  if (paths.length) {
    const material = new THREE.LineBasicMaterial({ color, depthTest: true, depthWrite: false });
    for (const { edge, points } of paths) {
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      const line = new THREE.Line(geometry, material);
      line.name = edge.label;
      line.userData.modelCadEdgeId = edge.id;
      line.raycast = () => {};
      line.renderOrder = 20;
      group.add(line);
    }
  }
  setModelCadPose(group, object);
  return group;
}

export function disposeModelCadEdgeHighlight(group: THREE.Group): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  group.traverse((node) => {
    if (!(node instanceof THREE.Line)) return;
    geometries.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : [node.material])
      materials.add(material);
  });
  group.clear();
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}

/** Reconstruct only the untampered base profile for visibility, including polygon/hole cuts. */
function basePickProxy(object: ModelCadObject): THREE.Mesh | null {
  if (object.kind === 'boolean') return null;
  const profile =
    object.kind === 'extrusion'
      ? object.profile!
      : object.kind === 'cylinder'
        ? { kind: 'circle' as const }
        : { kind: 'rectangle' as const };
  const shape = new THREE.Shape();
  if (profile.kind === 'circle') shape.absarc(0, 0, object.size.x / 2, 0, 2 * Math.PI, false);
  else {
    const points =
      profile.kind === 'polygon'
        ? profile.points
        : [
            { x: -object.size.x / 2, y: -object.size.y / 2 },
            { x: object.size.x / 2, y: -object.size.y / 2 },
            { x: object.size.x / 2, y: object.size.y / 2 },
            { x: -object.size.x / 2, y: object.size.y / 2 },
          ];
    shape.moveTo(points[0].x, -points[0].y);
    for (const point of points.slice(1)) shape.lineTo(point.x, -point.y);
    shape.closePath();
  }
  for (const hole of object.holes) {
    const cut = new THREE.Path();
    cut.absarc(hole.x, -hole.y, hole.diameterMm / 2, 0, 2 * Math.PI, false);
    shape.holes.push(cut);
  }
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: object.size.z,
    bevelEnabled: false,
    curveSegments: circleSegments / 2,
  });
  geometry.translate(0, 0, -object.size.z / 2);
  const proxy = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  setModelCadPose(proxy, object);
  proxy.updateMatrixWorld(true);
  return proxy;
}

function visibleObstacle(hit: THREE.Intersection, objectId: string, target?: THREE.Object3D) {
  if (!(hit.object instanceof THREE.Mesh)) return false;
  for (let node: THREE.Object3D | null = hit.object; node; node = node.parent) {
    if (
      !node.visible ||
      node === target ||
      node.userData.modelCadId === objectId ||
      node.userData.modelCadPreview ||
      node.userData.modelCadEdgeOverlay
    )
      return false;
  }
  return true;
}

/** Pick a visible base edge within CSS pixels, independently of zoom or replacement preview. */
export function pickModelCadEdge({
  object,
  camera,
  viewport,
  point,
  scene,
  target,
  tolerancePx = 8,
  allowedKinds,
}: {
  object: ModelCadObject;
  camera: THREE.Camera;
  viewport: Viewport;
  point: ScreenPoint;
  scene: THREE.Object3D;
  /** The current treated mesh is excluded; visibility uses its original base shape. */
  target?: THREE.Object3D;
  tolerancePx?: number;
  allowedKinds?: readonly ('line' | 'circle')[];
}): string | null {
  if (
    ![viewport.width, viewport.height, point.x, point.y, tolerancePx].every(Number.isFinite) ||
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    tolerancePx <= 0 ||
    tolerancePx > 32
  )
    return null;
  const paths = modelCadEdgePaths(object).filter(
    ({ edge }) => !allowedKinds || allowedKinds.includes(edge.kind),
  );
  if (!paths.length) return null;
  const proxy = basePickProxy(object);
  if (!proxy) return null;
  camera.updateMatrixWorld(true);
  scene.updateMatrixWorld(true);
  const candidates: { id: string; distance: number; world: THREE.Vector3 }[] = [];
  try {
    for (const { edge, points } of paths) {
      let closest: (typeof candidates)[number] | undefined;
      for (let index = 0; index < points.length - 1; index++) {
        const a = points[index].clone().applyMatrix4(proxy.matrixWorld);
        const b = points[index + 1].clone().applyMatrix4(proxy.matrixWorld);
        const projectedA = a.clone().project(camera);
        const projectedB = b.clone().project(camera);
        if (
          Math.abs(projectedA.z) > 1 ||
          Math.abs(projectedB.z) > 1 ||
          ![...projectedA.toArray(), ...projectedB.toArray()].every(Number.isFinite)
        )
          continue;
        const ax = ((projectedA.x + 1) * viewport.width) / 2;
        const ay = ((1 - projectedA.y) * viewport.height) / 2;
        const dx = ((projectedB.x - projectedA.x) * viewport.width) / 2;
        const dy = ((projectedA.y - projectedB.y) * viewport.height) / 2;
        const length = dx * dx + dy * dy;
        const t = length
          ? Math.max(0, Math.min(1, ((point.x - ax) * dx + (point.y - ay) * dy) / length))
          : 0;
        const distance = Math.hypot(point.x - ax - t * dx, point.y - ay - t * dy);
        if (distance > tolerancePx || (closest && distance >= closest.distance)) continue;
        // Unproject the interpolated screen depth so perspective does not turn
        // a pixel fraction into an incorrect world-space edge location.
        const world = projectedA.clone().lerp(projectedB, t).unproject(camera);
        closest = { id: edge.id, distance, world };
      }
      if (closest) candidates.push(closest);
    }
    const raycaster = new THREE.Raycaster();
    const cameraPosition = new THREE.Vector3();
    camera.getWorldPosition(cameraPosition);
    candidates.sort(
      (a, b) =>
        a.distance - b.distance ||
        a.world.distanceToSquared(cameraPosition) - b.world.distanceToSquared(cameraPosition),
    );
    const epsilon = Math.max(
      0.0001,
      Math.max(object.size.x, object.size.y, object.size.z) * 0.000002,
    );
    for (const candidate of candidates) {
      const projected = candidate.world.clone().project(camera);
      raycaster.setFromCamera(new THREE.Vector2(projected.x, projected.y), camera);
      const distance = raycaster.ray.origin.distanceTo(candidate.world);
      const hiddenByBase = raycaster
        .intersectObject(proxy, false)
        .some((hit) => hit.distance < distance - epsilon);
      if (hiddenByBase) continue;
      const hiddenByScene = raycaster
        .intersectObject(scene, true)
        .some(
          (hit) => hit.distance < distance - epsilon && visibleObstacle(hit, object.id, target),
        );
      if (!hiddenByScene) return candidate.id;
    }
    return null;
  } finally {
    proxy.geometry.dispose();
    (proxy.material as THREE.Material).dispose();
  }
}
