import type { Point } from './circuit';
import type { Polygon } from './pcb-polygons';

export type GeometryBounds = { minX: number; minY: number; maxX: number; maxY: number };
export type BoundsIndex<T> = GeometryBounds & {
  items?: T[];
  left?: BoundsIndex<T>;
  right?: BoundsIndex<T>;
};

export const overlapsBounds = (a: GeometryBounds, b: GeometryBounds, margin: number) =>
  a.minX <= b.maxX + margin &&
  b.minX <= a.maxX + margin &&
  a.minY <= b.maxY + margin &&
  b.minY <= a.maxY + margin;

export const edgeBounds = ([a, b]: [Point, Point]): GeometryBounds => ({
  minX: Math.min(a.x, b.x),
  minY: Math.min(a.y, b.y),
  maxX: Math.max(a.x, b.x),
  maxY: Math.max(a.y, b.y),
});

export function makeBoundsIndex<T extends GeometryBounds>(items: T[]): BoundsIndex<T> {
  const bounds = items.reduce(
    (value, item) => ({
      minX: Math.min(value.minX, item.minX),
      maxX: Math.max(value.maxX, item.maxX),
      minY: Math.min(value.minY, item.minY),
      maxY: Math.max(value.maxY, item.maxY),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
  if (items.length <= 8) return { ...bounds, items };
  const horizontal = bounds.maxX - bounds.minX >= bounds.maxY - bounds.minY;
  items.sort((a, b) =>
    horizontal ? a.minX + a.maxX - b.minX - b.maxX : a.minY + a.maxY - b.minY - b.maxY,
  );
  const middle = Math.floor(items.length / 2);
  return {
    ...bounds,
    left: makeBoundsIndex(items.slice(0, middle)),
    right: makeBoundsIndex(items.slice(middle)),
  };
}

export function queryBoundsIndex<T extends GeometryBounds>(
  node: BoundsIndex<T>,
  bounds: GeometryBounds,
  margin: number,
  visit: (item: T) => void,
  spend: () => void,
): void {
  spend();
  if (!overlapsBounds(node, bounds, margin)) return;
  if (node.items) {
    for (const item of node.items) {
      spend();
      if (overlapsBounds(item, bounds, margin)) visit(item);
    }
  } else {
    queryBoundsIndex(node.left!, bounds, margin, visit, spend);
    queryBoundsIndex(node.right!, bounds, margin, visit, spend);
  }
}

export const squaredDistance = (a: Point, b: Point) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
export function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const length = squaredDistance(a, b);
  const t = length
    ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / length))
    : 0;
  const x = a.x + t * (b.x - a.x),
    y = a.y + t * (b.y - a.y);
  return (p.x - x) ** 2 + (p.y - y) ** 2;
}
export function segmentDistance(a: Point, b: Point, c: Point, d: Point): number {
  const cross = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return 0;
  return Math.min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b),
  );
}
function insideRing(p: Point, ring: Point[], spend: () => void = () => {}): boolean {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    spend();
    const a = ring[i],
      b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
      result = !result;
  }
  return result;
}
export const insidePolygon = (p: Point, polygon: Polygon, spend?: () => void) =>
  insideRing(p, polygon.outer, spend) && !polygon.holes.some((hole) => insideRing(p, hole, spend));

export const polygonEdges = (polygon: Polygon): [Point, Point][] =>
  [polygon.outer, ...polygon.holes].flatMap((ring) =>
    ring.map((p, i): [Point, Point] => [p, ring[(i + 1) % ring.length]]),
  );

/** Copper contact includes the track radius and charges polygon work to its caller. */
export function trackTouchesPolygon(
  track: { start: Point; end: Point; width: number },
  polygon: Polygon,
  spend: () => void,
): boolean {
  if (insidePolygon(track.start, polygon, spend) || insidePolygon(track.end, polygon, spend))
    return true;
  for (let ringIndex = 0; ringIndex <= polygon.holes.length; ringIndex++) {
    const ring = ringIndex ? polygon.holes[ringIndex - 1] : polygon.outer;
    for (let index = 0; index < ring.length; index++) {
      spend();
      if (
        segmentDistance(track.start, track.end, ring[index], ring[(index + 1) % ring.length]) <=
        (track.width / 2 + 0.000001) ** 2
      )
        return true;
    }
  }
  return false;
}
