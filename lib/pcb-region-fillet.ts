import type { Point } from './circuit';
import type { BoardLine, BoardZone, PCB } from './pcb';

export type PCBRegionTarget = { kind: 'zone' | 'graphic'; id: string };
export const PCB_REGION_FILLET_TOLERANCE_MM = 0.01;
const maxPoints = 10000;
const epsilon = 1e-9;
const cross = (a: Point, b: Point, c: Point) =>
  (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const rounded = (point: Point): Point => ({
  x: Number(point.x.toFixed(6)),
  y: Number(point.y.toFixed(6)),
});

function region(board: PCB, target: PCBRegionTarget): BoardZone | BoardLine {
  const item =
    target.kind === 'zone'
      ? board.zones.find((zone) => zone.id === target.id)
      : target.kind === 'graphic'
        ? board.graphics.find((graphic) => graphic.id === target.id)
        : undefined;
  if (!item) throw new Error('The selected board region no longer exists.');
  if (item.locked) throw new Error('Unlock the region before rounding its corners.');
  if (target.kind === 'graphic' && (item as BoardLine).kind !== 'polygon')
    throw new Error('Select one polygon region to round its corners.');
  return item;
}

function onSegment(a: Point, b: Point, p: Point): boolean {
  return (
    Math.abs(cross(a, b, p)) <= epsilon &&
    p.x >= Math.min(a.x, b.x) - epsilon &&
    p.x <= Math.max(a.x, b.x) + epsilon &&
    p.y >= Math.min(a.y, b.y) - epsilon &&
    p.y <= Math.max(a.y, b.y) + epsilon
  );
}

function intersects(a: Point, b: Point, c: Point, d: Point): boolean {
  const abC = cross(a, b, c),
    abD = cross(a, b, d),
    cdA = cross(c, d, a),
    cdB = cross(c, d, b);
  return (
    (((abC > epsilon && abD < -epsilon) || (abC < -epsilon && abD > epsilon)) &&
      ((cdA > epsilon && cdB < -epsilon) || (cdA < -epsilon && cdB > epsilon))) ||
    onSegment(a, b, c) ||
    onSegment(a, b, d) ||
    onSegment(c, d, a) ||
    onSegment(c, d, b)
  );
}

/** Rounded board regions remain native straight-edged polygons, within 0.01 mm
 * of circular fillets. This exact preparation is shared by preview and Core. */
export function pcbRegionFilletOutline(
  board: PCB,
  target: PCBRegionTarget,
  radius: number,
): Point[] {
  if (!Number.isFinite(radius) || radius <= 0 || radius > 1000)
    throw new Error('Fillet radius must be greater than zero and at most 1000 mm.');
  const item = region(board, target);
  const source =
    target.kind === 'zone'
      ? (item as BoardZone).outline
      : [(item as BoardLine).start, ...((item as BoardLine).points ?? []), (item as BoardLine).end];
  const points =
    source.length > 1 && same(source[0], source.at(-1)!) ? source.slice(0, -1) : source;
  if (points.length < 3 || points.length > maxPoints)
    throw new Error('A region fillet requires 3–10000 polygon vertices.');
  if (
    points.some(
      (p) =>
        !Number.isFinite(p.x) ||
        !Number.isFinite(p.y) ||
        Math.abs(p.x) > 100000 ||
        Math.abs(p.y) > 100000,
    )
  )
    throw new Error('Region vertices must be finite and within ±100000 mm.');
  let work = 0;
  const spend = () => {
    if (++work > 2_000_000) throw new Error('Region fillet exceeds the geometry work limit.');
  };
  for (let i = 0; i < points.length; i++) {
    const next = (i + 1) % points.length;
    if (same(points[i], points[next])) throw new Error('Region edges must have positive length.');
    for (let j = i + 1; j < points.length; j++) {
      if (j === next || (j + 1) % points.length === i) continue;
      spend();
      if (intersects(points[i], points[next], points[j], points[(j + 1) % points.length]))
        throw new Error('Round corners requires a simple polygon without self-intersections.');
    }
  }
  const area = points.reduce(
    (sum, p, i) => sum + cross(points[0], p, points[(i + 1) % points.length]),
    0,
  );
  const orientation = Math.sign(area);
  if (Math.abs(area) <= epsilon) throw new Error('The region must enclose positive area.');
  const corners = points.map((p, i) => {
    const previous = points[(i + points.length - 1) % points.length],
      next = points[(i + 1) % points.length];
    if (cross(previous, p, next) * orientation <= epsilon)
      throw new Error('Round corners supports convex, non-collinear polygon corners.');
    const a = Math.hypot(previous.x - p.x, previous.y - p.y),
      b = Math.hypot(next.x - p.x, next.y - p.y);
    const u = { x: (previous.x - p.x) / a, y: (previous.y - p.y) / a },
      v = { x: (next.x - p.x) / b, y: (next.y - p.y) / b };
    const angle = Math.acos(Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y)));
    const trim = radius / Math.tan(angle / 2);
    const start = { x: p.x + u.x * trim, y: p.y + u.y * trim },
      end = { x: p.x + v.x * trim, y: p.y + v.y * trim };
    const bisectorLength = Math.hypot(u.x + v.x, u.y + v.y),
      offset = radius / Math.sin(angle / 2);
    const center = {
      x: p.x + ((u.x + v.x) * offset) / bisectorLength,
      y: p.y + ((u.y + v.y) * offset) / bisectorLength,
    };
    return { trim, start, end, center, sweep: orientation * (Math.PI - angle) };
  });
  for (let i = 0; i < points.length; i++) {
    const next = (i + 1) % points.length;
    if (
      corners[i].trim + corners[next].trim >=
      Math.hypot(points[i].x - points[next].x, points[i].y - points[next].y) - 0.000001
    )
      throw new Error('Fillets overlap along a region edge. Reduce the radius.');
  }
  // Reserve the six-decimal quantization error inside the advertised tolerance.
  const step = Math.min(
    Math.PI / 12,
    2 * Math.acos(Math.max(-1, 1 - (PCB_REGION_FILLET_TOLERANCE_MM - 0.000001) / radius)),
  );
  const outline: Point[] = [];
  for (const { start, end, center, sweep } of corners) {
    const segments = Math.max(1, Math.ceil(Math.abs(sweep) / step));
    if (!Number.isFinite(segments) || outline.length + segments + 1 > maxPoints)
      throw new Error('Rounded regions support at most 10000 polygon vertices.');
    const angle = Math.atan2(start.y - center.y, start.x - center.x);
    for (let i = 0; i <= segments; i++)
      outline.push(
        rounded(
          i === 0
            ? start
            : i === segments
              ? end
              : {
                  x: center.x + radius * Math.cos(angle + (sweep * i) / segments),
                  y: center.y + radius * Math.sin(angle + (sweep * i) / segments),
                },
        ),
      );
  }
  if (outline.some((p, i) => same(p, outline[(i + 1) % outline.length])))
    throw new Error('The radius is too small for native polygon precision.');
  if (target.kind === 'zone') {
    for (const hole of (item as BoardZone).holes ?? [])
      for (const p of hole)
        for (let i = 0; i < outline.length; i++) {
          spend();
          if (cross(outline[i], outline[(i + 1) % outline.length], p) * orientation <= epsilon)
            throw new Error('The rounded region would intersect a cutout. Reduce the radius.');
        }
  }
  return outline;
}

/** Preserve IDs, metadata and unrelated geometry; Core refreshes accepted fills. */
export function preparePCBRegionFillet(board: PCB, target: PCBRegionTarget, radius: number): PCB {
  const outline = pcbRegionFilletOutline(board, target, radius);
  return target.kind === 'zone'
    ? {
        ...board,
        zones: board.zones.map((zone) => (zone.id === target.id ? { ...zone, outline } : zone)),
      }
    : {
        ...board,
        graphics: board.graphics.map((graphic) =>
          graphic.id === target.id
            ? {
                ...graphic,
                start: outline[0],
                points: outline.slice(1, -1),
                end: outline.at(-1)!,
              }
            : graphic,
        ),
      };
}
