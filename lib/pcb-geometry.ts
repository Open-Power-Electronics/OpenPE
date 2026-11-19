import type { Point } from './circuit';
import type { BoardLine, BoardZone, Pad } from './pcb';

export function transformPCBGraphic(
  g: BoardLine,
  point: (p: Point) => Point,
  angle: (n: number) => number = (n) => n,
): BoardLine {
  return {
    ...g,
    start: point(g.start),
    end: point(g.end),
    ...(g.mid ? { mid: point(g.mid) } : {}),
    ...(g.points ? { points: g.points.map(point) } : {}),
    ...(g.text ? { text: { ...g.text, rotation: angle(g.text.rotation) } } : {}),
    ...(g.dimension
      ? {
          dimension: {
            ...g.dimension,
            caption: {
              ...g.dimension.caption,
              ...point(g.dimension.caption),
              rotation: angle(g.dimension.caption.rotation),
            },
          },
        }
      : {}),
  };
}
export function transformPCBZone(z: BoardZone, point: (p: Point) => Point): BoardZone {
  return {
    ...z,
    outline: z.outline.map(point),
    ...(z.holes ? { holes: z.holes.map((h) => h.map(point)) } : {}),
    ...(z.filledPolygons
      ? { filledPolygons: z.filledPolygons.map((p) => ({ ...p, points: p.points.map(point) })) }
      : {}),
  };
}
export function pcbArc(g: Pick<BoardLine, 'start' | 'mid' | 'end'>) {
  const a = g.start,
    b = g.mid!,
    c = g.end;
  if (!b) return null;
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const aa = a.x * a.x + a.y * a.y,
    bb = b.x * b.x + b.y * b.y,
    cc = c.x * c.x + c.y * c.y;
  const center = {
    x: (aa * (b.y - c.y) + bb * (c.y - a.y) + cc * (a.y - b.y)) / d,
    y: (aa * (c.x - b.x) + bb * (a.x - c.x) + cc * (b.x - a.x)) / d,
  };
  const start = Math.atan2(a.y - center.y, a.x - center.x),
    mid = Math.atan2(b.y - center.y, b.x - center.x),
    end = Math.atan2(c.y - center.y, c.x - center.x);
  const positive = (v: number) => (v + Math.PI * 4) % (Math.PI * 2);
  const delta =
    positive(mid - start) <= positive(end - start)
      ? positive(end - start)
      : positive(end - start) - Math.PI * 2;
  return { center, radius: Math.hypot(a.x - center.x, a.y - center.y), delta, start };
}
export function pcbGraphicPath(g: BoardLine): string {
  if (g.kind === 'polygon')
    return `M ${[g.start, ...(g.points ?? []), g.end].map((p) => `${p.x} ${p.y}`).join(' L ')} Z`;
  if (g.kind === 'arc') {
    const arc = pcbArc(g);
    if (arc)
      return `M ${g.start.x} ${g.start.y} A ${arc.radius} ${arc.radius} 0 ${Math.abs(arc.delta) > Math.PI ? 1 : 0} ${arc.delta > 0 ? 1 : 0} ${g.end.x} ${g.end.y}`;
  }
  return `M ${g.start.x} ${g.start.y} L ${g.end.x} ${g.end.y}`;
}
export function pcbGraphicPoints(g: BoardLine): Point[] {
  if (g.text?.hidden) return [];
  if (g.kind === 'circle' || g.kind === 'arc') {
    const arc = g.kind === 'arc' ? pcbArc(g) : null,
      center = arc?.center ?? g.start,
      r = arc?.radius ?? Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y);
    return [
      { x: center.x - r, y: center.y - r },
      { x: center.x + r, y: center.y + r },
    ];
  }
  const points = [g.start, g.end, ...(g.points ?? []), ...(g.mid ? [g.mid] : [])];
  const t = g.text ?? g.dimension?.caption;
  if (t) {
    const at = g.dimension?.caption ?? g.start,
      w = Math.max(...t.value.split('\n').map((s) => s.length)) * t.size.x * 0.7,
      h = t.value.split('\n').length * t.size.y;
    const r = Math.hypot(w, h);
    points.push({ x: at.x - r, y: at.y - r }, { x: at.x + r, y: at.y + r });
  }
  return points;
}
export const pcbPadCorners = [
  { x: -1, y: -1, name: 'top_left' },
  { x: 1, y: -1, name: 'top_right' },
  { x: 1, y: 1, name: 'bottom_right' },
  { x: -1, y: 1, name: 'bottom_left' },
] as const;

/** The two endpoints in clockwise pad-local traversal order. */
export function pcbPadChamferEndpoints(
  { x, y }: (typeof pcbPadCorners)[number],
  size: Point,
  cut: number,
): [Point, Point] {
  const horizontal = { x: x * (size.x / 2 - cut), y: (y * size.y) / 2 };
  const vertical = { x: (x * size.x) / 2, y: y * (size.y / 2 - cut) };
  return x === y ? [vertical, horizontal] : [horizontal, vertical];
}

/** Pad-local path; rounded corners use circular SVG arcs. */
export function pcbPadPath(
  p: Pick<Pad, 'size' | 'roundrectRatio' | 'chamferRatio' | 'chamfer' | 'outline'>,
): string {
  if (p.outline) return `M ${p.outline.map(({ x, y }) => `${x} ${y}`).join(' L ')} Z`;
  const x = p.size.x / 2,
    y = p.size.y / 2,
    r = Math.min(p.size.x, p.size.y) * (p.roundrectRatio ?? 0),
    c = Math.min(p.size.x, p.size.y) * (p.chamferRatio ?? 0);
  const cut = (name: NonNullable<Pad['chamfer']>[number]) => (p.chamfer?.includes(name) ? c : r);
  const tl = cut('top_left'),
    tr = cut('top_right'),
    br = cut('bottom_right'),
    bl = cut('bottom_left');
  const corner = (name: NonNullable<Pad['chamfer']>[number], end: string) =>
    p.chamfer?.includes(name) || !r ? `L ${end}` : `A ${r} ${r} 0 0 1 ${end}`;
  return `M ${-x + tl} ${-y} L ${x - tr} ${-y} ${corner('top_right', `${x} ${-y + tr}`)} L ${x} ${y - br} ${corner('bottom_right', `${x - br} ${y}`)} L ${-x + bl} ${y} ${corner('bottom_left', `${-x} ${y - bl}`)} L ${-x} ${-y + tl} ${corner('top_left', `${-x + tl} ${-y}`)} Z`;
}
