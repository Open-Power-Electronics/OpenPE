import type { Point } from '../lib/circuit';
import type { BoardLayer, PCB } from '../lib/pcb';
import { boardPolygons } from '../lib/pcb-polygons';

export const referenceZoneInset = 0.5;
const epsilon = 0.000001;
type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
type Change = { id: string; layer: BoardLayer; before: Point[]; after: Point[] };
function fail(message: string): never {
  throw new Error(`Reference zone boundaries: ${message}`);
}
const round = (value: number) => Number(value.toFixed(6));
const same = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) <= epsilon;
const bounds = (points: Point[]): Bounds => ({
  minX: Math.min(...points.map((point) => point.x)),
  minY: Math.min(...points.map((point) => point.y)),
  maxX: Math.max(...points.map((point) => point.x)),
  maxY: Math.max(...points.map((point) => point.y)),
});
const area = (points: Point[]) =>
  Math.abs(
    points.reduce((sum, point, index) => {
      const next = points[(index + 1) % points.length];
      return sum + point.x * next.y - next.x * point.y;
    }, 0) / 2,
  );

function rectangularBoardBounds(board: PCB): Bounds {
  const polygons = boardPolygons(board);
  if (polygons.length !== 1 || polygons[0].holes.length)
    fail('expected one rectangular board without cutouts.');
  const points = polygons[0].outer;
  const box = bounds(points);
  const expected = (box.maxX - box.minX) * (box.maxY - box.minY);
  if (
    !Number.isFinite(expected) ||
    expected <= epsilon ||
    Math.abs(area(points) - expected) > epsilon ||
    points.some((point, index) => {
      const next = points[(index + 1) % points.length];
      return Math.abs(point.x - next.x) > epsilon && Math.abs(point.y - next.y) > epsilon;
    })
  )
    fail('expected an axis-aligned rectangular board.');
  return box;
}

function inBounds(point: Point, box: Bounds): boolean {
  return (
    point.x >= box.minX - epsilon &&
    point.x <= box.maxX + epsilon &&
    point.y >= box.minY - epsilon &&
    point.y <= box.maxY + epsilon
  );
}

function contains(point: Point, ring: Point[]): boolean {
  let inside = false;
  for (let index = 0; index < ring.length; index++) {
    const a = ring[index];
    const b = ring[(index + 1) % ring.length];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = dx * dx + dy * dy;
    const t = length
      ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length))
      : 0;
    if (Math.hypot(point.x - a.x - dx * t, point.y - a.y - dy * t) <= epsilon) return true;
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside;
}

/** Clip external edges, preserving the source's internal divider lines and ring direction. */
function clipToBounds(outline: Point[], box: Bounds): Point[] {
  const planes: [keyof Point, number, number][] = [
    ['x', box.minX, 1],
    ['x', box.maxX, -1],
    ['y', box.minY, 1],
    ['y', box.maxY, -1],
  ];
  let ring = outline.map((point) => ({ ...point }));
  for (const [axis, value, sign] of planes) {
    const next: Point[] = [];
    for (let index = 0; index < ring.length; index++) {
      const a = ring[(index + ring.length - 1) % ring.length];
      const b = ring[index];
      const aInside = (a[axis] - value) * sign >= -epsilon;
      const bInside = (b[axis] - value) * sign >= -epsilon;
      if (aInside !== bInside) {
        const t = (value - a[axis]) / (b[axis] - a[axis]);
        next.push({ x: round(a.x + t * (b.x - a.x)), y: round(a.y + t * (b.y - a.y)) });
      }
      if (bInside) next.push(b);
    }
    ring = next.filter((point, index) => index === 0 || !same(point, next[index - 1]));
    if (ring.length > 1 && same(ring[0], ring.at(-1)!)) ring.pop();
  }
  if (ring.length < 3 || area(ring) <= epsilon) fail('the inset removes a zone.');
  // Keep a rectangle's original starting corner, rather than introducing a
  // serializer-only ring rotation as clipping traverses the four box planes.
  const anchor = {
    x: Math.max(box.minX, Math.min(box.maxX, outline[0].x)),
    y: Math.max(box.minY, Math.min(box.maxY, outline[0].y)),
  };
  let first = 0;
  for (let index = 1; index < ring.length; index++)
    if (
      Math.hypot(ring[index].x - anchor.x, ring[index].y - anchor.y) <
      Math.hypot(ring[first].x - anchor.x, ring[first].y - anchor.y)
    )
      first = index;
  return [...ring.slice(first), ...ring.slice(0, first)];
}

/** Curated, build-only boundary adjustment; saved copper is never recomputed. */
export function insetReferenceZoneBoundaries(
  board: PCB,
  inset = referenceZoneInset,
): { board: PCB; changes: Change[] } {
  if (!Number.isFinite(inset) || inset <= 0) fail('inset must be a positive finite distance.');
  const outer = rectangularBoardBounds(board);
  const box = {
    minX: round(outer.minX + inset),
    minY: round(outer.minY + inset),
    maxX: round(outer.maxX - inset),
    maxY: round(outer.maxY - inset),
  };
  if (box.maxX - box.minX <= epsilon || box.maxY - box.minY <= epsilon)
    fail('inset leaves no positive board area.');
  const changes: Change[] = [];
  const zones = board.zones.map((zone) => {
    if (zone.keepout || !board.layers.some((layer) => layer === zone.layer)) return zone;
    if (
      zone.outline.length < 3 ||
      zone.outline.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))
    )
      fail(`invalid outline for zone ${zone.id}.`);
    if (zone.outline.every((point) => inBounds(point, box))) return zone;
    if (!zone.filledPolygons?.length) fail(`zone ${zone.id} has no saved copper to preserve.`);
    const outline = clipToBounds(zone.outline, box);
    for (const point of [
      ...zone.filledPolygons.flatMap((polygon) => polygon.points),
      ...(zone.holes ?? []).flat(),
    ])
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || !contains(point, outline))
        fail(`inset would clip saved copper or a cutout in zone ${zone.id}.`);
    changes.push({
      id: zone.id,
      layer: zone.layer,
      before: zone.outline.map((point) => ({ ...point })),
      after: outline.map((point) => ({ ...point })),
    });
    return { ...zone, outline };
  });
  return { board: changes.length ? { ...board, zones } : board, changes };
}
