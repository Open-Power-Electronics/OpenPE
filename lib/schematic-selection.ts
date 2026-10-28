import type { Circuit, Part, Point } from './circuit';
import { unitGraphics } from './library';
import { selectedField } from './schematic-edit';
import { child, children, num } from './sexpr';
import { symbolBodyBounds } from './symbol-bounds';

export type SelectionMode = 'replace' | 'add' | 'toggle' | 'subtract';
export type SchematicSelectionBounds = { x: number; y: number; width: number; height: number };
export type SelectionModifiers = { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean };

export function selectionMode(modifiers: SelectionModifiers): SelectionMode {
  const control = modifiers.ctrlKey || modifiers.metaKey;
  return control
    ? modifiers.shiftKey
      ? 'subtract'
      : 'toggle'
    : modifiers.shiftKey
      ? 'add'
      : 'replace';
}

/** Selection is view state. Preserve order and avoid moving an owner's field twice. */
export function applySelection(
  previous: readonly string[],
  candidates: readonly string[],
  mode: SelectionMode,
): string[] {
  const before = [...new Set(previous)],
    incoming = [...new Set(candidates)],
    selected = new Set(before),
    incomingSet = new Set(incoming);
  const result =
    mode === 'replace'
      ? incoming
      : mode === 'subtract'
        ? before.filter((id) => !incomingSet.has(id))
        : mode === 'toggle'
          ? [
              ...before.filter((id) => !incomingSet.has(id)),
              ...incoming.filter((id) => {
                const field = selectedField(id);
                return !selected.has(id) && (!field || !incomingSet.has(field.id));
              }),
            ]
          : [...before, ...incoming.filter((id) => !selected.has(id))];
  const owners = new Set(result);
  return result.filter((id) => {
    const field = selectedField(id);
    return !field || !owners.has(field.id);
  });
}

type Rectangle = { minX: number; minY: number; maxX: number; maxY: number };
type Shape = {
  polygons: Point[][];
  segments: [Point, Point][];
  disks: { at: Point; radius: number }[];
};
const epsilon = 1e-8;
const inside = (p: Point, r: Rectangle, radius = 0) =>
  p.x - radius >= r.minX - epsilon &&
  p.x + radius <= r.maxX + epsilon &&
  p.y - radius >= r.minY - epsilon &&
  p.y + radius <= r.maxY + epsilon;
const corners = (r: Rectangle): Point[] => [
  { x: r.minX, y: r.minY },
  { x: r.maxX, y: r.minY },
  { x: r.maxX, y: r.maxY },
  { x: r.minX, y: r.maxY },
];
const emptyShape = (): Shape => ({ polygons: [], segments: [], disks: [] });

// Clip the actual line rather than its axis-aligned bounding box. Edge contact counts.
function segmentTouches(a: Point, b: Point, rectangle: Rectangle) {
  let enter = 0,
    leave = 1;
  for (const [origin, delta, min, max] of [
    [a.x, b.x - a.x, rectangle.minX, rectangle.maxX],
    [a.y, b.y - a.y, rectangle.minY, rectangle.maxY],
  ]) {
    if (Math.abs(delta) <= epsilon) {
      if (origin < min - epsilon || origin > max + epsilon) return false;
    } else {
      const t1 = (min - origin) / delta,
        t2 = (max - origin) / delta;
      enter = Math.max(enter, Math.min(t1, t2));
      leave = Math.min(leave, Math.max(t1, t2));
      if (enter > leave + epsilon) return false;
    }
  }
  return true;
}

function inPolygon(point: Point, polygon: Point[]) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i],
      b = polygon[j];
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      result = !result;
  }
  return result;
}

function shapeMatches(shape: Shape, rectangle: Rectangle, contained: boolean) {
  const points = [...shape.polygons.flat(), ...shape.segments.flat()];
  if (contained)
    return (
      (points.length > 0 || shape.disks.length > 0) &&
      points.every((p) => inside(p, rectangle)) &&
      shape.disks.every((disk) => inside(disk.at, rectangle, disk.radius))
    );
  return (
    shape.segments.some(([a, b]) => segmentTouches(a, b, rectangle)) ||
    shape.polygons.some(
      (polygon) =>
        polygon.some((p, i) => segmentTouches(p, polygon[(i + 1) % polygon.length], rectangle)) ||
        corners(rectangle).some((p) => inPolygon(p, polygon)),
    ) ||
    shape.disks.some(({ at, radius }) => {
      const x = Math.max(rectangle.minX, Math.min(rectangle.maxX, at.x)),
        y = Math.max(rectangle.minY, Math.min(rectangle.maxY, at.y));
      return Math.hypot(at.x - x, at.y - y) <= radius + epsilon;
    })
  );
}

function transform(part: Part, point: Point): Point {
  const angle = (-part.rotation * Math.PI) / 180,
    cosine = Math.cos(angle),
    sine = Math.sin(angle);
  return {
    x: part.x + (part.mirror === 'y' ? -1 : 1) * (point.x * cosine - point.y * sine),
    y: part.y + (part.mirror === 'x' ? -1 : 1) * (point.x * sine + point.y * cosine),
  };
}

function boundsPolygon(bounds: SchematicSelectionBounds) {
  return corners({
    minX: bounds.x,
    minY: bounds.y,
    maxX: bounds.x + bounds.width,
    maxY: bounds.y + bounds.height,
  });
}

/**
 * World-coordinate marquee selection. Left-to-right contains complete geometry;
 * right-to-left touches it. Measured text bounds exclude parent annotation groups,
 * invisible glyphs and selection decorations, and never expand symbol body targets.
 * Return every hit so the caller can apply modifiers before normalizing ownership.
 */
export function schematicIdsInRectangle(
  doc: Circuit,
  visibleIds: ReadonlySet<string>,
  start: Point,
  end: Point,
  measuredBounds: ReadonlyMap<string, SchematicSelectionBounds> = new Map(),
): string[] {
  if (![start.x, start.y, end.x, end.y].every(Number.isFinite)) return [];
  const rectangle = {
      minX: Math.min(start.x, end.x),
      minY: Math.min(start.y, end.y),
      maxX: Math.max(start.x, end.x),
      maxY: Math.max(start.y, end.y),
    },
    contained = end.x >= start.x,
    shapes = new Map<string, Shape>();
  for (const part of doc.parts) {
    if (!visibleIds.has(part.id)) continue;
    const library = doc.libraries[part.libId];
    if (!library) continue;
    const shape = emptyShape(),
      bounds = symbolBodyBounds(library, part.unit || 1);
    if (bounds) shape.polygons.push(boundsPolygon(bounds).map((p) => transform(part, p)));
    for (const group of unitGraphics(library, part.unit || 1)) {
      for (const pin of children(group, 'pin')) {
        if (pin.includes('hide') || child(pin, 'hide')?.[1] === 'yes') continue;
        const at = child(pin, 'at'),
          angle = (num(at, 3) * Math.PI) / 180,
          length = num(child(pin, 'length')),
          a = { x: num(at), y: -num(at, 2) },
          b = { x: a.x + length * Math.cos(angle), y: a.y - length * Math.sin(angle) };
        shape.segments.push([transform(part, a), transform(part, b)]);
      }
    }
    shapes.set(part.id, shape);
  }
  for (const wire of doc.wires)
    if (visibleIds.has(wire.id))
      shapes.set(wire.id, { ...emptyShape(), segments: [[wire.a, wire.b]] });
  for (const junction of doc.junctions)
    if (visibleIds.has(junction.id))
      shapes.set(junction.id, { ...emptyShape(), disks: [{ at: junction, radius: 0.6 }] });
  for (const marker of doc.noConnects || []) {
    if (!visibleIds.has(marker.id)) continue;
    const { x, y } = marker;
    shapes.set(marker.id, {
      ...emptyShape(),
      segments: [
        [
          { x: x - 0.65, y: y - 0.65 },
          { x: x + 0.65, y: y + 0.65 },
        ],
        [
          { x: x - 0.65, y: y + 0.65 },
          { x: x + 0.65, y: y - 0.65 },
        ],
      ],
    });
  }
  for (const [id, bounds] of measuredBounds) {
    if (!visibleIds.has(id) || shapes.has(id)) continue;
    if (
      ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
      bounds.width < 0 ||
      bounds.height < 0 ||
      (bounds.width === 0 && bounds.height === 0)
    )
      continue;
    shapes.set(id, { ...emptyShape(), polygons: [boundsPolygon(bounds)] });
  }
  return [...visibleIds].filter((id) => {
    const shape = shapes.get(id);
    return shape && shapeMatches(shape, rectangle, contained);
  });
}
