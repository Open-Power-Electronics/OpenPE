import type { Point } from './circuit';
import type { Polygon } from './pcb-polygons';

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
