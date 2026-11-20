import type { Point } from './circuit';
import type { Pad } from './pcb';
import { child, val, type SExpr } from './sexpr';
import { insidePolygon, polygonEdges, segmentDistance } from './pcb-collision';

type Drill = Pick<Pad, 'drill' | 'drillSlot' | 'drillOffset'>;

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
): Drill {
  if (!node) return {};
  const oval = val(node) === 'oval';
  const offset = child(node, 'offset');
  const dimensions = oval ? 4 : 2;
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
    node.length !== dimensions + Number(!!offset) ||
    node.slice(1, dimensions).some(Array.isArray) ||
    (offset &&
      (node[dimensions] !== offset || offset.length !== 3 || offset.slice(1).some(Array.isArray)))
  )
    fail('Use a round or oval drill with at most one XY offset.');
  const x = offsetValue(node, oval ? 2 : 1);
  const y = oval ? offsetValue(node, 3) : x;
  if (Math.min(x, y) < 0.000001 || Math.max(x, y) > 1000 || (oval && x === y))
    fail('Pad drill dimensions must be between 0.000001 and 1000 mm, with distinct oval axes.');
  const drillOffset = offset && {
    x: -offsetValue(offset, 1) || 0,
    y: -offsetValue(offset, 2) || 0,
  };
  return {
    drill: Math.min(x, y),
    ...(oval ? { drillSlot: { length: Math.max(x, y), axis: x > y ? 'x' : 'y' } } : {}),
    ...(drillOffset ? { drillOffset } : {}),
  };
}

/** Minimum clearance from a drill capsule to the pad outline. */
export function padDrillClearance(
  pad: Drill &
    Pick<Pad, 'size' | 'shape' | 'roundrectRatio' | 'chamfer' | 'chamferRatio' | 'outline'>,
) {
  const [start, end] = localPadDrillLine(pad);
  const drillRadius = pad.drill! / 2;
  if (pad.outline) {
    const land = { outer: pad.outline, holes: [] };
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
