import type { Point } from './circuit';
import type { BoardLine, PCB } from './pcb';
import { assertPCBSelectionUnlocked, type PCBBounds, type PCBSelection } from './pcb-layout';

export type PCBRectangle = { ids: string[]; bounds: PCBBounds; zoneId?: string };
export type PCBRectangleHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const epsilon = 0.000001;
const equal = (a: Point, b: Point) =>
  Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;
const key = (p: Point) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`;
function rectangleBounds(points: Point[]): PCBBounds | null {
  if (points.length > 1 && equal(points[0], points.at(-1)!)) points = points.slice(0, -1);
  if (points.length !== 4) return null;
  const bounds = {
    minX: Math.min(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxX: Math.max(...points.map((p) => p.x)),
    maxY: Math.max(...points.map((p) => p.y)),
  };
  if (
    bounds.maxX - bounds.minX < 0.001 ||
    bounds.maxY - bounds.minY < 0.001 ||
    new Set(points.map(key)).size !== 4
  )
    return null;
  return points.every((p, i) => {
    const q = points[(i + 1) % points.length];
    return (
      (Math.abs(p.x - bounds.minX) <= epsilon || Math.abs(p.x - bounds.maxX) <= epsilon) &&
      (Math.abs(p.y - bounds.minY) <= epsilon || Math.abs(p.y - bounds.maxY) <= epsilon) &&
      (Math.abs(p.x - q.x) <= epsilon || Math.abs(p.y - q.y) <= epsilon)
    );
  })
    ? bounds
    : null;
}

/** Rectangular Edge.Cuts frames, or the resize bounds of one native board zone. */
export function findPCBRectangle(
  board: PCB,
  selection: readonly PCBSelection[],
): PCBRectangle | null {
  if (selection.length === 1 && selection[0].kind === 'zone') {
    const zone = board.zones.find((z) => z.id === selection[0].id);
    if (!zone || zone.outline.length < 3) return null;
    const bounds = {
      minX: Math.min(...zone.outline.map((p) => p.x)),
      minY: Math.min(...zone.outline.map((p) => p.y)),
      maxX: Math.max(...zone.outline.map((p) => p.x)),
      maxY: Math.max(...zone.outline.map((p) => p.y)),
    };
    return Object.values(bounds).every(Number.isFinite) &&
      bounds.maxX - bounds.minX >= 0.001 &&
      bounds.maxY - bounds.minY >= 0.001
      ? { ids: [zone.id], zoneId: zone.id, bounds }
      : null;
  }
  if (!selection.length || selection.some((s) => s.kind !== 'graphic')) return null;
  const seed = board.graphics.find((g) => g.id === selection[0].id && g.layer === 'Edge.Cuts');
  if (!seed) return null;
  if (seed.kind === 'polygon' && !seed.fill) {
    const bounds = rectangleBounds([seed.start, ...(seed.points ?? []), seed.end]);
    return bounds && selection.every((s) => s.id === seed.id) ? { ids: [seed.id], bounds } : null;
  }
  if (seed.kind) return null;
  const joints = new Map<string, BoardLine[]>();
  for (const g of board.graphics) {
    if (g.layer !== 'Edge.Cuts' || g.kind === 'text' || g.kind === 'dimension') continue;
    for (const p of [g.start, g.end]) {
      const items = joints.get(key(p)) ?? [];
      items.push(g);
      joints.set(key(p), items);
    }
  }
  if (joints.get(key(seed.start))?.length !== 2) return null;
  const edges = [seed],
    points = [seed.start, seed.end];
  let previous = seed,
    at = seed.end;
  while (!equal(at, seed.start) && edges.length <= 4) {
    const incident = joints.get(key(at));
    if (incident?.length !== 2) return null;
    const next = incident.find((g) => g.id !== previous.id)!;
    if (next.kind || edges.includes(next)) return null;
    at = equal(next.start, at) ? next.end : next.start;
    edges.push(next);
    points.push(at);
    previous = next;
  }
  const bounds = edges.length === 4 && equal(at, seed.start) ? rectangleBounds(points) : null;
  const ids = edges.map((g) => g.id);
  return bounds && selection.every((s) => ids.includes(s.id)) ? { ids, bounds } : null;
}

function checkPCBRectangle(board: PCB, rectangle: PCBRectangle): void {
  assertPCBSelectionUnlocked(
    board,
    rectangle.ids.map((id) => ({ kind: rectangle.zoneId ? 'zone' : 'graphic', id })),
  );
  const current = findPCBRectangle(
    board,
    rectangle.ids.map((id) => ({ kind: rectangle.zoneId ? 'zone' : 'graphic', id })),
  );
  if (
    !current ||
    current.zoneId !== rectangle.zoneId ||
    current.ids.length !== rectangle.ids.length ||
    current.ids.some((id) => !rectangle.ids.includes(id)) ||
    (Object.keys(current.bounds) as (keyof PCBBounds)[]).some(
      (k) => current.bounds[k] !== rectangle.bounds[k],
    )
  )
    throw new Error('The selected boundary changed. Select it again before editing.');
}

/** One Properties edit updates every native edge of the selected rectangle. */
export function setPCBRectangleWidth(board: PCB, rectangle: PCBRectangle, width: number): PCB {
  checkPCBRectangle(board, rectangle);
  if (rectangle.zoneId)
    throw new Error('Select a rectangular Edge.Cuts outline to edit line width.');
  if (!Number.isFinite(width) || width < 0.0001 || width > 1000)
    throw new Error('Line width must be between 0.0001 and 1000 mm.');
  const ids = new Set(rectangle.ids);
  return {
    ...board,
    graphics: board.graphics.map((graphic) =>
      ids.has(graphic.id) ? { ...graphic, width } : graphic,
    ),
  };
}

export function resizePCBRectangle(board: PCB, rectangle: PCBRectangle, bounds: PCBBounds): PCB {
  checkPCBRectangle(board, rectangle);
  if (
    Object.values(bounds).some((n) => !Number.isFinite(n) || Math.abs(n) > 100000) ||
    bounds.maxX - bounds.minX < 0.001 ||
    bounds.maxY - bounds.minY < 0.001
  )
    throw new Error('Boundary dimensions must be at least 0.001 mm within ±100000 mm.');
  if ((Object.keys(bounds) as (keyof PCBBounds)[]).every((k) => bounds[k] === rectangle.bounds[k]))
    return board;
  if (rectangle.zoneId) {
    const old = rectangle.bounds;
    const transform = (p: Point): Point => ({
      x:
        bounds.minX === old.minX && bounds.maxX === old.maxX
          ? p.x
          : Number(
              (
                bounds.minX +
                ((p.x - old.minX) * (bounds.maxX - bounds.minX)) / (old.maxX - old.minX)
              ).toFixed(6),
            ),
      y:
        bounds.minY === old.minY && bounds.maxY === old.maxY
          ? p.y
          : Number(
              (
                bounds.minY +
                ((p.y - old.minY) * (bounds.maxY - bounds.minY)) / (old.maxY - old.minY)
              ).toFixed(6),
            ),
    });
    return {
      ...board,
      zones: board.zones.map((zone) =>
        zone.id === rectangle.zoneId
          ? {
              ...zone,
              outline: zone.outline.map(transform),
              ...(zone.holes ? { holes: zone.holes.map((hole) => hole.map(transform)) } : {}),
            }
          : zone,
      ),
    };
  }
  const map = (p: Point): Point => ({
    x:
      bounds.minX === rectangle.bounds.minX && bounds.maxX === rectangle.bounds.maxX
        ? p.x
        : Math.abs(p.x - rectangle.bounds.minX) <= epsilon
          ? bounds.minX
          : bounds.maxX,
    y:
      bounds.minY === rectangle.bounds.minY && bounds.maxY === rectangle.bounds.maxY
        ? p.y
        : Math.abs(p.y - rectangle.bounds.minY) <= epsilon
          ? bounds.minY
          : bounds.maxY,
  });
  const ids = new Set(rectangle.ids);
  return {
    ...board,
    graphics: board.graphics.map((g) =>
      ids.has(g.id)
        ? {
            ...g,
            start: map(g.start),
            end: map(g.end),
            ...(g.points ? { points: g.points.map(map) } : {}),
          }
        : g,
    ),
  };
}

/** Opposite edges stay exact; only dragged axes snap. Crossing clamps at a positive size. */
export function pcbRectangleDragBounds(
  rectangle: PCBRectangle,
  handle: PCBRectangleHandle,
  delta: Point,
  step: number,
): PCBBounds {
  const bounds = { ...rectangle.bounds };
  if (!delta.x && !delta.y) return bounds;
  const snap = (n: number) => Number((step ? Math.round(n / step) * step : n).toFixed(6));
  const minimum = Math.max(0.001, step);
  if (handle.includes('w') && delta.x)
    bounds.minX = Math.min(snap(bounds.minX + delta.x), bounds.maxX - minimum);
  if (handle.includes('e') && delta.x)
    bounds.maxX = Math.max(snap(bounds.maxX + delta.x), bounds.minX + minimum);
  if (handle.includes('n') && delta.y)
    bounds.minY = Math.min(snap(bounds.minY + delta.y), bounds.maxY - minimum);
  if (handle.includes('s') && delta.y)
    bounds.maxY = Math.max(snap(bounds.maxY + delta.y), bounds.minY + minimum);
  return bounds;
}
