import { type Circuit, type Point, type Wire, pinPositions, uid } from './circuit';
import { child, quote } from './sexpr';
export const samePoint = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) < 0.0001;
export function onWire(p: Point, w: Wire) {
  const dx = w.b.x - w.a.x,
    dy = w.b.y - w.a.y;
  return (
    Math.abs((p.x - w.a.x) * dy - (p.y - w.a.y) * dx) < 0.0001 &&
    p.x >= Math.min(w.a.x, w.b.x) - 0.0001 &&
    p.x <= Math.max(w.a.x, w.b.x) + 0.0001 &&
    p.y >= Math.min(w.a.y, w.b.y) - 0.0001 &&
    p.y <= Math.max(w.a.y, w.b.y) + 0.0001
  );
}
export function wireRoute(start: Point, end: Point, vertical = false): Point[] {
  const corner = vertical ? { x: start.x, y: end.y } : { x: end.x, y: start.y };
  return [start, corner, end].filter((p, i, a) => !i || !samePoint(p, a[i - 1]));
}
/** Split only at route endpoints and pins, never at incidental wire crossings. */
export function commitWireRoute(source: Circuit, points: Point[]): Circuit {
  const d = structuredClone(source);
  const route: Wire[] = points
    .slice(1)
    .flatMap((p, i) => (samePoint(p, points[i]) ? [] : [{ id: uid(), a: points[i], b: p }]));
  if (!route.length) return d;
  const originalIds = new Set(source.wires.map((wire) => wire.id));
  const splitPoints = [
    ...points,
    ...source.parts
      .flatMap((p) => pinPositions(p, source.libraries[p.libId]))
      .filter((p) => route.some((w) => onWire(p, w))),
  ];
  const all = [...d.wires, ...route];
  d.wires = [];
  for (const w of all) {
    const original = originalIds.has(w.id);
    if (original && samePoint(w.a, w.b)) {
      d.wires.push(w);
      continue;
    }
    const splits = [
      w.a,
      ...splitPoints.filter((p) => onWire(p, w) && !samePoint(p, w.a) && !samePoint(p, w.b)),
      w.b,
    ]
      .sort((a, b) => Math.hypot(a.x - w.a.x, a.y - w.a.y) - Math.hypot(b.x - w.a.x, b.y - w.a.y))
      .filter((p, i, a) => !i || !samePoint(p, a[i - 1]));
    for (let i = 1; i < splits.length; i++) {
      const a = splits[i - 1],
        b = splits[i];
      if (
        !original &&
        d.wires.some(
          (other) =>
            (samePoint(other.a, a) && samePoint(other.b, b)) ||
            (samePoint(other.a, b) && samePoint(other.b, a)),
        )
      )
        continue;
      // Array position owns native order. Every derivative keeps its style, with
      // only the first retaining the source identity and subsequent IDs fresh.
      const segment = { ...w, id: i === 1 ? w.id : uid(), a, b };
      if (i > 1 && w.raw) {
        segment.raw = structuredClone(w.raw);
        const uuid = child(segment.raw, 'uuid');
        if (uuid) uuid[1] = quote(segment.id);
        else segment.raw.push(['uuid', quote(segment.id)]);
      }
      d.wires.push(segment);
    }
  }
  for (const p of splitPoints) {
    const degree = d.wires.filter((w) => samePoint(w.a, p) || samePoint(w.b, p)).length;
    if (degree >= 3 && !d.junctions.some((j) => samePoint(j, p)))
      d.junctions.push({ id: uid(), ...p });
  }
  return d;
}
