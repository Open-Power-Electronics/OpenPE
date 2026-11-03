import * as THREE from 'three';
import type { ModelCadObject, ModelCadPoint, ModelCadVector } from '../lib/model-cad';
import { modelCadSelectableFaceIds } from '../lib/model-cad-selection';
import { setModelCadPose } from './model-cad-mesh';

export type ModelCadSelectableFace =
  | { id: string; label: string; kind: 'cap'; side: 'top' | 'bottom' }
  | {
      id: string;
      label: string;
      kind: 'wall';
      start: ModelCadPoint;
      end: ModelCadPoint;
      normal: ModelCadVector;
    }
  | {
      id: string;
      label: string;
      kind: 'cylinder';
      center: ModelCadPoint;
      radiusMm: number;
    };

function profilePoints(object: ModelCadObject): ModelCadPoint[] {
  return object.kind === 'extrusion' && object.profile?.kind === 'polygon'
    ? object.profile.points.map((point) => ({ ...point }))
    : [
        { x: -object.size.x / 2, y: -object.size.y / 2 },
        { x: object.size.x / 2, y: -object.size.y / 2 },
        { x: object.size.x / 2, y: object.size.y / 2 },
        { x: -object.size.x / 2, y: object.size.y / 2 },
      ];
}

function circular(object: ModelCadObject) {
  return (
    object.kind === 'cylinder' || (object.kind === 'extrusion' && object.profile?.kind === 'circle')
  );
}

/** Base analytic faces have stable semantic names; treated/Boolean topology stays body-selectable. */
export function modelCadSelectableFaces(object: ModelCadObject): ModelCadSelectableFace[] {
  const ids = modelCadSelectableFaceIds(object);
  if (!ids.length) return [];
  const faces: ModelCadSelectableFace[] = [
    { id: 'profile:top', label: 'Top face', kind: 'cap', side: 'top' },
    { id: 'profile:bottom', label: 'Bottom face', kind: 'cap', side: 'bottom' },
  ];
  if (circular(object))
    faces.push({
      id: 'profile:wall',
      label: 'Outer wall',
      kind: 'cylinder',
      center: { x: 0, y: 0 },
      radiusMm: object.size.x / 2,
    });
  else {
    const points = profilePoints(object);
    const area = points.reduce((sum, a, i) => {
      const b = points[(i + 1) % points.length];
      return sum + a.x * b.y - b.x * a.y;
    }, 0);
    for (const [index, start] of points.entries()) {
      const end = points[(index + 1) % points.length];
      const length = Math.hypot(end.x - start.x, end.y - start.y);
      const sign = area >= 0 ? 1 : -1;
      faces.push({
        id: `side:${index}`,
        label: `Side face ${index + 1}`,
        kind: 'wall',
        start: { ...start },
        end: { ...end },
        normal: {
          x: (sign * (end.y - start.y)) / length,
          y: (sign * (start.x - end.x)) / length,
          z: 0,
        },
      });
    }
  }
  return faces.filter((face) => ids.includes(face.id));
}

function segmentDistance(point: ModelCadPoint, a: ModelCadPoint, b: ModelCadPoint) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const fraction = Math.max(
    0,
    Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy)),
  );
  return Math.hypot(point.x - a.x - fraction * dx, point.y - a.y - fraction * dy);
}

function inProfile(object: ModelCadObject, point: ModelCadPoint, epsilon: number) {
  if (circular(object)) return Math.hypot(point.x, point.y) <= object.size.x / 2 + epsilon;
  const points = profilePoints(object);
  let inside = false;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    if (segmentDistance(point, a, b) <= epsilon) return true;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}

/** Resolve a visible ray hit already transformed to native body-local point/normal axes. */
export function modelCadFaceAtPoint(
  object: ModelCadObject,
  point: ModelCadVector,
  normal?: ModelCadVector,
): ModelCadSelectableFace | null {
  if (
    ![point.x, point.y, point.z, ...(normal ? [normal.x, normal.y, normal.z] : [])].every(
      Number.isFinite,
    )
  )
    return null;
  const tolerance = Math.max(0.0001, Math.max(object.size.x, object.size.y, object.size.z) * 0.001);
  if (Math.abs(point.z) > object.size.z / 2 + tolerance) return null;
  const direction = normal ? new THREE.Vector3(normal.x, normal.y, normal.z).normalize() : null;
  const candidates: { face: ModelCadSelectableFace; distance: number; alignment: number }[] = [];
  for (const face of modelCadSelectableFaces(object)) {
    let distance: number;
    let expected: THREE.Vector3;
    if (face.kind === 'cap') {
      if (!inProfile(object, point, tolerance)) continue;
      const sign = face.side === 'top' ? 1 : -1;
      distance = Math.abs(point.z - (sign * object.size.z) / 2);
      expected = new THREE.Vector3(0, 0, sign);
    } else if (face.kind === 'wall') {
      distance = segmentDistance(point, face.start, face.end);
      expected = new THREE.Vector3(face.normal.x, face.normal.y, 0);
    } else {
      const dx = point.x - face.center.x;
      const dy = point.y - face.center.y;
      distance = Math.abs(Math.hypot(dx, dy) - face.radiusMm);
      expected = new THREE.Vector3(dx, dy, 0).normalize();
    }
    const alignment = direction ? direction.dot(expected) : 0;
    if (distance <= tolerance && (!direction || alignment > 0.5))
      candidates.push({ face, distance, alignment });
  }
  candidates.sort((a, b) =>
    direction ? b.alignment - a.alignment || a.distance - b.distance : a.distance - b.distance,
  );
  return candidates[0]?.face ?? null;
}

function capGeometry(object: ModelCadObject) {
  const shape = new THREE.Shape();
  if (circular(object)) shape.absarc(0, 0, object.size.x / 2, 0, 2 * Math.PI, false);
  else {
    const points = profilePoints(object);
    shape.moveTo(points[0].x, -points[0].y);
    points.slice(1).forEach((point) => shape.lineTo(point.x, -point.y));
    shape.closePath();
  }

  return new THREE.ShapeGeometry(shape, 48);
}

/** Isolated transient face paint; raycasting and native/project mutation are disabled. */
export function createModelCadFaceHighlight(
  object: ModelCadObject,
  faceIds: readonly string[],
  color: THREE.ColorRepresentation = 0x66b3ff,
): THREE.Group {
  const group = new THREE.Group();
  group.userData.modelCadFaceOverlay = true;
  const selected = new Set(faceIds);
  const faces = modelCadSelectableFaces(object).filter((face) => selected.has(face.id));
  if (faces.length) {
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.32,
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    });
    for (const face of faces) {
      let geometry: THREE.BufferGeometry;
      if (face.kind === 'cap') {
        geometry = capGeometry(object);
        geometry.translate(0, 0, ((face.side === 'top' ? 1 : -1) * object.size.z) / 2);
      } else if (face.kind === 'wall') {
        const { start: a, end: b } = face;
        const z = object.size.z / 2;
        geometry = new THREE.BufferGeometry();
        geometry.setAttribute(
          'position',
          new THREE.Float32BufferAttribute(
            [a.x, -a.y, -z, b.x, -b.y, -z, b.x, -b.y, z, a.x, -a.y, z],
            3,
          ),
        );
        geometry.setIndex([0, 1, 2, 0, 2, 3]);
        geometry.computeVertexNormals();
      } else {
        geometry = new THREE.CylinderGeometry(
          face.radiusMm,
          face.radiusMm,
          object.size.z,
          96,
          1,
          true,
        );
        geometry.rotateX(Math.PI / 2);
        geometry.translate(face.center.x, -face.center.y, 0);
      }
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = face.label;
      mesh.userData.modelCadFaceId = face.id;
      mesh.raycast = () => {};
      mesh.renderOrder = 20;
      group.add(mesh);
    }
  }
  setModelCadPose(group, object);
  return group;
}

export function disposeModelCadFaceHighlight(group: THREE.Group): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  group.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return;
    geometries.add(node.geometry);
    for (const material of Array.isArray(node.material) ? node.material : [node.material])
      materials.add(material);
  });
  group.clear();
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}
