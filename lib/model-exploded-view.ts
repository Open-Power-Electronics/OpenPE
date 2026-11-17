import { Matrix4, Mesh, Vector3, type Group, type Object3D } from 'three';
import type { PCB } from './pcb';
import { applyModelSolderMaskExplosion, type ModelBoardDisplayGroups } from './model-board-display';

export type ModelExplodedView = {
  distance: number;
  direction: 'vertical' | 'radial';
};
export const defaultModelExplodedView: ModelExplodedView = {
  distance: 0,
  direction: 'vertical',
};

type AssemblyGeometry = { area: number; above: number; below: number; moment: Vector3 };

/** Surface area, rather than vertex counts, makes the vote independent of tessellation density.
 * Coordinates are the assembled PCB frame, after all native model transforms.
 */
function assemblyGeometry(object: Object3D, frameInverse: Matrix4, thickness: number) {
  const result: AssemblyGeometry = { area: 0, above: 0, below: 0, moment: new Vector3() };
  const a = new Vector3(),
    b = new Vector3(),
    c = new Vector3();
  const u = new Vector3(),
    v = new Vector3(),
    matrix = new Matrix4();
  const area = (a: Vector3, b: Vector3, c: Vector3) =>
    u.subVectors(b, a).cross(v.subVectors(c, a)).length() / 2;
  const clippedArea = (plane: number, sign: number, full: number) => {
    const inside = (point: Vector3) => sign * (point.z - plane) >= 0;
    const ia = inside(a),
      ib = inside(b),
      ic = inside(c);
    if (ia && ib && ic) return full;
    if (!ia && !ib && !ic) return 0;
    const triangle = [a, b, c];
    const polygon: Vector3[] = [];
    for (let i = 0; i < 3; i++) {
      const from = triangle[i],
        to = triangle[(i + 1) % 3];
      if (inside(from)) polygon.push(from);
      if (inside(from) !== inside(to))
        polygon.push(from.clone().lerp(to, (plane - from.z) / (to.z - from.z)));
    }
    let sum = 0;
    for (let i = 1; i + 1 < polygon.length; i++)
      sum += area(polygon[0], polygon[i], polygon[i + 1]);
    return sum;
  };
  object.traverseVisible((node) => {
    if (!(node instanceof Mesh)) return;
    const position = node.geometry.getAttribute('position');
    if (!position) return;
    const index = node.geometry.getIndex();
    matrix.multiplyMatrices(frameInverse, node.matrixWorld);
    const count = index ? index.count : position.count;
    for (let i = 0; i + 2 < count; i += 3) {
      a.fromBufferAttribute(position, index ? index.getX(i) : i).applyMatrix4(matrix);
      b.fromBufferAttribute(position, index ? index.getX(i + 1) : i + 1).applyMatrix4(matrix);
      c.fromBufferAttribute(position, index ? index.getX(i + 2) : i + 2).applyMatrix4(matrix);
      const full = area(a, b, c);
      if (!Number.isFinite(full) || full <= 1e-12) continue;
      result.area += full;
      result.above += clippedArea(thickness / 2, 1, full);
      result.below += clippedArea(-thickness / 2, -1, full);
      result.moment
        .addScaledVector(a, full / 3)
        .addScaledVector(b, full / 3)
        .addScaledVector(c, full / 3);
    }
  });
  return result;
}

/** Scene-local presentation poses. Never changes native objects, geometry or model transforms. */
export function createModelExplodedView(
  board: PCB,
  components: Group,
  layers: ModelBoardDisplayGroups,
) {
  const componentPoses = new WeakMap<Object3D, Vector3>();
  const geometry = new WeakMap<Object3D, AssemblyGeometry>();
  const layerPoses = new WeakMap<Object3D, Vector3>();
  const anchors = new Map(board.footprints.map((f) => [f.id, f]));
  const center = board.footprints.length
    ? new Vector3(
        (Math.min(...board.footprints.map((f) => f.x)) +
          Math.max(...board.footprints.map((f) => f.x))) /
          2,
        -(
          Math.min(...board.footprints.map((f) => f.y)) +
          Math.max(...board.footprints.map((f) => f.y))
        ) / 2,
        0,
      )
    : new Vector3(0, 0, 0);
  const half = board.layers.length / 2;
  const ranks = new Map<string, number>([
    ...board.layers.map(
      (layer, index) => [layer, index < half ? half - index : half - index - 1] as [string, number],
    ),
    ['F.Mask', half + 1],
    ['B.Mask', -half - 1],
    ['F.SilkS', half + 2],
    ['B.SilkS', -half - 2],
  ]);
  const offset = (
    anchor: Vector3,
    side: number,
    amount: number,
    direction: ModelExplodedView['direction'],
  ) => {
    const vector = direction === 'radial' ? anchor.clone().sub(center) : new Vector3(0, 0, side);
    if (vector.lengthSq() < 1e-12) vector.set(0, 0, side);
    return vector.normalize().multiplyScalar(amount);
  };
  return {
    apply(settings: ModelExplodedView) {
      if (!Number.isFinite(settings.distance) || settings.distance < 0 || settings.distance > 1000)
        throw new Error('Exploded distance must be between 0 and 1000 mm.');
      const amount = settings.distance;
      applyModelSolderMaskExplosion(layers.mask, amount > 0);
      for (const group of Object.values(layers))
        for (const object of group.children) {
          const rank = ranks.get(object.userData.modelExplosionLayer);
          if (rank === undefined) continue;
          let base = layerPoses.get(object);
          if (!base) {
            base = object.position.clone();
            layerPoses.set(object, base);
          }
          object.position.copy(base);
          if (amount) object.position.z += rank * amount;
        }
      // Restore every instance before measuring. In particular, a late model must
      // never be compared with another instance's already-exploded geometry.
      for (const object of components.children) {
        const footprint = anchors.get(object.userData.footprintId);
        if (!footprint) continue;
        let base = componentPoses.get(object);
        if (!base) {
          base = object.position.clone();
          componentPoses.set(object, base);
        }
        object.position.copy(base);
      }
      components.updateWorldMatrix(true, true);
      const assembled = new Map<string, AssemblyGeometry>();
      if (amount) {
        const frameInverse = components.matrixWorld.clone().invert();
        for (const object of components.children) {
          const id = object.userData.footprintId as string;
          if (!anchors.has(id) || object.userData.estimated) continue;
          let measured = geometry.get(object);
          if (!measured) {
            measured = assemblyGeometry(object, frameInverse, board.thickness);
            geometry.set(object, measured);
          }
          const combined = assembled.get(id) ?? {
            area: 0,
            above: 0,
            below: 0,
            moment: new Vector3(),
          };
          combined.area += measured.area;
          combined.above += measured.above;
          combined.below += measured.below;
          combined.moment.add(measured.moment);
          assembled.set(id, combined);
        }
      }
      for (const object of components.children) {
        const footprint = anchors.get(object.userData.footprintId);
        if (!footprint) continue;
        let side = footprint.side === 'back' ? -1 : 1;
        const measured = assembled.get(footprint.id);
        // Require substantial geometry outside the laminate and a 3:1 side
        // majority. Balanced/embedded geometry and estimates retain native side.
        if (measured && measured.above + measured.below > measured.area * 0.1) {
          if (measured.above > measured.below * 3) side = 1;
          else if (measured.below > measured.above * 3) side = -1;
        }
        const anchor =
          measured && measured.area > 0
            ? measured.moment.clone().divideScalar(measured.area)
            : new Vector3(footprint.x, -footprint.y, (side * board.thickness) / 2);
        // Radial spread uses the actual XY centre and the resolved side. A long
        // lead crossing the board cannot give radial movement the opposite Z.
        anchor.z = side * Math.max(Math.abs(anchor.z), board.thickness / 2);
        if (amount)
          object.position.add(offset(anchor, side, amount * (half + 3), settings.direction));
      }
      components.updateWorldMatrix(true, true);
      for (const group of Object.values(layers)) group.updateWorldMatrix(true, true);
    },
  };
}
