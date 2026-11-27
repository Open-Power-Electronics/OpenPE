import type { Point } from './circuit';
import type { Pad } from './pcb';
import { child, children, val, type SExpr } from './sexpr';
import { insidePolygon, polygonEdges, segmentDistance } from './pcb-collision';
import { pcbPadTrapezoid } from './pcb-geometry';

type Drill = Pick<Pad, 'drill' | 'drillSlot' | 'drillOffset'>;

type PostMachining = {
  mode: 'counterbore' | 'countersink';
  size?: number;
  depth?: number;
  angle?: number;
};
export type PCBPadPostMachining = Partial<Record<'front' | 'back', PostMachining>>;

export function readPCBPadPostMachining(
  pad: SExpr,
  fail: (message: string) => never,
): PCBPadPostMachining | undefined {
  const machining: PCBPadPostMachining = {};
  for (const side of ['front', 'back'] as const) {
    const fields = children(pad, `${side}_post_machining`);
    const [node] = fields;
    if (!node) continue;
    const mode = node[1];
    if (fields.length !== 1 || (mode !== 'counterbore' && mode !== 'countersink'))
      return fail('Invalid native pad post-machining mode.');
    const result: PostMachining = { mode };
    for (const field of node.slice(2)) {
      if (!Array.isArray(field) || field.length !== 2)
        return fail('Invalid native pad post-machining parameter.');
      const [key, raw] = field;
      if (
        (key !== 'size' && key !== 'depth' && key !== 'angle') ||
        Object.hasOwn(result, key) ||
        typeof raw !== 'string' ||
        !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)
      )
        return fail('Invalid native pad post-machining parameter.');
      const value = Number(raw);
      if (
        !(value > 0 && value <= (key === 'angle' ? 180 : 1000)) ||
        Math.abs(value - Number(value.toFixed(key === 'angle' ? 1 : 6))) > 1e-9
      )
        return fail('Native pad post-machining needs positive values at native precision.');
      result[key] = value;
    }
    machining[side] = result;
  }
  return machining.front || machining.back ? machining : undefined;
}

export function writePCBPadPostMachining(machining: PCBPadPostMachining): string[] {
  const records: string[] = [];
  for (const side of ['front', 'back'] as const) {
    const operation = machining[side];
    if (!operation) continue;
    const values = (['size', 'depth', 'angle'] as const).flatMap((key) =>
      operation[key] === undefined ? [] : [` (${key} ${operation[key]})`],
    );
    records.push(`(${side}_post_machining ${operation.mode}${values.join('')})`);
  }
  return records;
}

/** Diameter at the machined entry surface. The layer cut below it is separate. */
export function pcbPadMachiningOpening(
  pad: Pick<Pad, 'postMachining'>,
  side: 'front' | 'back',
): number | undefined {
  const operation = pad.postMachining?.[side];
  if (!operation?.size) return;
  if (operation.depth) return operation.size;
  if (operation.mode !== 'countersink' || !operation.angle) return;
  const tangent = Math.tan((operation.angle * Math.PI) / 360);
  if (Math.trunc((operation.size * 500_000) / tangent) > 0) return operation.size;
}

export function padDrillSize({ drill = 0, drillSlot }: Drill): Point {
  return {
    x: drillSlot?.axis === 'x' ? drillSlot.length : drill,
    y: drillSlot?.axis === 'y' ? drillSlot.length : drill,
  };
}

/** Tool centreline in the unrotated frame of the copper land. */
export function localPadDrillLine({ drill = 0, drillSlot, drillOffset }: Drill): [Point, Point] {
  const center = drillOffset ?? { x: 0, y: 0 };
  const halfTravel = drillSlot ? (drillSlot.length - drill) / 2 : 0;
  const dx = drillSlot?.axis === 'x' ? halfTravel : 0;
  const dy = drillSlot?.axis === 'y' ? halfTravel : 0;
  return [
    { x: center.x - dx, y: center.y - dy },
    { x: center.x + dx, y: center.y + dy },
  ];
}

/** A native pad's `at` is the drill anchor. Its offset moves the land from that anchor. */
export function readPadDrill(
  node: SExpr | undefined,
  fail: (message: string) => never = (message) => {
    throw new Error(message);
  },
  surfaceMount = false,
): Drill & Pick<Pad, 'nativeRoundDrillY'> {
  if (!node) return {};
  const oval = val(node) === 'oval';
  const offset = child(node, 'offset');
  const dimensions = node.slice(1, offset ? -1 : undefined);
  const validDimensions = surfaceMount
    ? dimensions.length === 0 && offset
    : oval
      ? dimensions.length === 3
      : dimensions.length === 1 || dimensions.length === 2;
  const offsetValue = (n: SExpr, i: number) => {
    const raw = val(n, i),
      value = Number(raw);
    if (
      !raw ||
      !Number.isFinite(value) ||
      Math.abs(value) > 100000 ||
      Math.abs(value - Number(value.toFixed(6))) > 1e-9
    )
      fail('Pad drill needs finite dimensions at 0.000001 mm precision.');
    return value;
  };
  if (
    !validDimensions ||
    dimensions.some(Array.isArray) ||
    (offset &&
      (node.at(-1) !== offset || offset.length !== 3 || offset.slice(1).some(Array.isArray)))
  )
    fail('Use a round or oval drill with at most one XY offset.');
  const drillOffset = offset && {
    x: -offsetValue(offset, 1) || 0,
    y: -offsetValue(offset, 2) || 0,
  };
  if (surfaceMount) return { drillOffset };
  const x = offsetValue(node, oval ? 2 : 1);
  const y = dimensions.length > 1 ? offsetValue(node, dimensions.length) : x;
  if (Math.min(x, y) < 0.000001 || Math.max(x, y) > 1000 || (oval && x === y))
    fail('Pad drill dimensions must be between 0.000001 and 1000 mm, with distinct oval axes.');
  return {
    drill: oval ? Math.min(x, y) : x,
    ...(oval ? { drillSlot: { length: Math.max(x, y), axis: x > y ? 'x' : 'y' } } : {}),
    ...(!oval && dimensions.length === 2 ? { nativeRoundDrillY: y } : {}),
    ...(drillOffset ? { drillOffset } : {}),
  };
}

/** Minimum clearance from a drill capsule to the pad outline. */
export function padDrillClearance(
  pad: Drill &
    Pick<
      Pad,
      | 'size'
      | 'shape'
      | 'roundrectRatio'
      | 'chamfer'
      | 'chamferRatio'
      | 'outline'
      | 'trapezoidDelta'
    >,
) {
  const [start, end] = localPadDrillLine(pad);
  const drillRadius = pad.drill! / 2;
  const outline = pad.shape === 'trapezoid' ? pcbPadTrapezoid(pad) : pad.outline;
  if (outline) {
    const land = { outer: outline, holes: [] };
    if (!insidePolygon(start, land) || !insidePolygon(end, land)) return -drillRadius;
    return (
      Math.sqrt(
        Math.min(...polygonEdges(land).map(([a, b]) => segmentDistance(start, end, a, b))),
      ) - drillRadius
    );
  }
  const halfWidth = pad.size.x / 2,
    halfHeight = pad.size.y / 2;
  const halfSide = Math.min(halfWidth, halfHeight);
  const radius =
    halfSide * (pad.shape === 'circle' || pad.shape === 'oval' ? 1 : 2 * (pad.roundrectRatio ?? 0));
  const clearanceAt = ({ x, y }: Point) => {
    const sx = Math.abs(x) - (halfWidth - radius);
    const sy = Math.abs(y) - (halfHeight - radius);
    let edge =
      radius - Math.hypot(Math.max(0, sx), Math.max(0, sy)) - Math.min(0, Math.max(sx, sy));
    for (const corner of pad.chamfer ?? []) {
      const cx = corner.endsWith('left') ? -x : x;
      const cy = corner.startsWith('top') ? -y : y;
      const cut = 2 * halfSide * (pad.chamferRatio ?? 0);
      edge = Math.min(edge, (halfWidth + halfHeight - cut - cx - cy) / Math.SQRT2);
    }
    return edge - drillRadius;
  };
  return Math.min(clearanceAt(start), clearanceAt(end));
}
