import type { Point } from '../../../lib/circuit';
import {
  insidePolygon,
  pointSegmentDistance,
  polygonEdges,
  segmentDistance,
} from '../../../lib/pcb-collision';
import type { Polygon } from '../../../lib/pcb-polygons';

export const epsilon = 1e-8;
export type WorkBudget = () => void;
export function workBudget(limit: number): WorkBudget {
  let operations = 0;
  return () => {
    if (++operations > limit)
      throw new Error('EMC review exceeds the bounded geometry work limit.');
  };
}
export function validPoint(point: Point) {
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y) ||
    Math.max(Math.abs(point.x), Math.abs(point.y)) > 100_000
  )
    throw new Error('EMC review contains invalid or out-of-range PCB geometry.');
}
export const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
export const edgesOf = (polygons: Polygon[]) => polygons.flatMap(polygonEdges);

export function withinPolygons(
  point: Point,
  polygons: Polygon[],
  edges: [Point, Point][],
  spend: WorkBudget,
) {
  if (polygons.some((polygon) => insidePolygon(point, polygon, spend))) return true;
  // Include zero-width boundary contact, while preserving open hole interiors.
  return edges.some(([a, b]) => {
    spend();
    return pointSegmentDistance(point, a, b) <= epsilon ** 2;
  });
}
export function nearestEdge(
  a: Point,
  b: Point,
  edges: [Point, Point][],
  spend: WorkBudget,
): number {
  let nearest = Infinity;
  for (const [start, end] of edges) {
    spend();
    nearest = Math.min(nearest, segmentDistance(a, b, start, end));
  }
  return Math.sqrt(nearest);
}

/** Partition at every saved-polygon edge crossing, not at a sampling grid.
 * Midpoint containment is constant in each open interval. Collinear edge spans
 * are partitioned at both endpoints and count as boundary contact. This is only
 * centerline projection evidence, never current-return connectivity. */
export function centerlineCoverage(
  a: Point,
  b: Point,
  polygons: Polygon[],
  edges: [Point, Point][],
  spend: WorkBudget,
): { uncovered: boolean; uncoveredMm: number; location: Point } {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return {
      uncovered: !withinPolygons(a, polygons, edges, spend),
      uncoveredMm: 0,
      location: { ...a },
    };
  }
  const cuts = [0, 1];
  const add = (t: number) => {
    if (t >= -epsilon && t <= 1 + epsilon) cuts.push(Math.max(0, Math.min(1, t)));
  };
  for (const [c, d] of edges) {
    spend();
    const ex = d.x - c.x,
      ey = d.y - c.y;
    const cx = c.x - a.x,
      cy = c.y - a.y;
    const cross = dx * ey - dy * ex;
    if (cross !== 0) {
      const t = (cx * ey - cy * ex) / cross;
      const u = (cx * dy - cy * dx) / cross;
      if (u >= 0 && u <= 1) add(t);
    } else if (cx * dy - cy * dx === 0) {
      const square = length * length;
      add((cx * dx + cy * dy) / square);
      add(((d.x - a.x) * dx + (d.y - a.y) * dy) / square);
    }
  }
  cuts.sort((left, right) => left - right);
  let uncoveredFraction = 0,
    largest = 0,
    location = midpoint(a, b);
  let previous = cuts[0];
  for (let index = 1; index < cuts.length; index++) {
    const next = cuts[index];
    if (next <= previous) continue;
    const fraction = (previous + next) / 2;
    const point = { x: a.x + fraction * dx, y: a.y + fraction * dy };
    if (!withinPolygons(point, polygons, edges, spend)) {
      uncoveredFraction += next - previous;
      if (next - previous > largest) {
        largest = next - previous;
        location = point;
      }
    }
    previous = next;
  }
  return { uncovered: uncoveredFraction > 0, uncoveredMm: uncoveredFraction * length, location };
}
