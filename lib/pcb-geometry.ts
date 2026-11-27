import type { Point } from './circuit';
import type { BoardLine, BoardZone, Pad } from './pcb';
import { pointSegmentDistance } from './pcb-collision';
import { children, val, type SExpr } from './sexpr';
import { pcbTextDisplayValue, pcbTextLineAdvance } from './pcb-text';

export const nativePCBPadRoundRectRatio = 0.25;

export function readPCBPadRoundRectRatio(node: SExpr, fail: (message: string) => never) {
  const [record, duplicate] = children(node, 'roundrect_rratio');
  if (!record) return val(node, 3) === 'roundrect' ? nativePCBPadRoundRectRatio : undefined;
  if (val(node, 3) !== 'roundrect') fail('Only rounded rectangular pads accept a corner ratio.');
  const raw = record[1];
  const ratio = Number(raw);
  if (
    duplicate ||
    record.length !== 2 ||
    typeof raw !== 'string' ||
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) ||
    !(ratio >= 0 && ratio <= 0.5)
  )
    fail('Pad corner ratio must be between 0 and 0.5.');
  return ratio || 0;
}

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
    ...(g.polygonArcs
      ? { polygonArcs: g.polygonArcs.map((arc) => ({ ...arc, mid: point(arc.mid) })) }
      : {}),
    ...(g.text ? { text: { ...g.text, rotation: angle(g.text.rotation) } } : {}),
    ...(g.textBox?.outline
      ? { textBox: { ...g.textBox, outline: g.textBox.outline.map(point) } }
      : {}),
    ...(g.dimension?.caption
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
    ...(z.nativeOutlineArcs
      ? { nativeOutlineArcs: z.nativeOutlineArcs.map((arc) => ({ ...arc, mid: point(arc.mid) })) }
      : {}),
    ...(z.holes ? { holes: z.holes.map((h) => h.map(point)) } : {}),
    ...(z.filledPolygons
      ? { filledPolygons: z.filledPolygons.map((p) => ({ ...p, points: p.points.map(point) })) }
      : {}),
  };
}

export function pcbZoneCircle(zone: BoardZone): { center: Point; radius: number } | undefined {
  if (!zone.nativeCircularOutline) return undefined;
  const [start, mid] = zone.outline;
  return {
    center: { x: (start.x + mid.x) / 2, y: (start.y + mid.y) / 2 },
    radius: Math.hypot(start.x - mid.x, start.y - mid.y) / 2,
  };
}

export function pcbZoneOutlineBoundsPoints(zone: BoardZone): Point[] {
  const circle = pcbZoneCircle(zone);
  if (circle) {
    const { center, radius } = circle;
    return [
      { x: center.x - radius, y: center.y - radius },
      { x: center.x + radius, y: center.y + radius },
    ];
  }
  return zone.nativeOutlineArcs
    ? [
        ...zone.outline,
        ...zone.nativeOutlineArcs.flatMap(({ vertex, mid }) =>
          pcbArcBoundsPoints({ start: zone.outline[vertex], mid, end: zone.outline[vertex + 1] }),
        ),
      ]
    : zone.outline;
}

/** Chords serve pointer hit testing. The native writer and SVG use the arcs. */
export function pcbZoneSelectionVertices(zone: BoardZone): Point[] {
  if (!zone.nativeOutlineArcs) return zone.outline;
  const arcs = new Map(zone.nativeOutlineArcs.map(({ vertex, mid }) => [vertex, mid]));
  return zone.outline.flatMap((start, vertex) => {
    const mid = arcs.get(vertex);
    if (!mid) return [start];
    const arc = pcbArc({ start, mid, end: zone.outline[vertex + 1] })!;
    const divisions = Math.ceil(Math.abs(arc.delta) / (Math.PI / 24));
    return Array.from({ length: divisions }, (_, i) => {
      if (!i) return start;
      const angle = arc.start + (arc.delta * i) / divisions;
      return {
        x: arc.center.x + arc.radius * Math.cos(angle),
        y: arc.center.y + arc.radius * Math.sin(angle),
      };
    });
  });
}

export function pcbCenterMarkStrokes({
  start,
  end,
}: Pick<BoardLine, 'start' | 'end'>): [Point, Point][] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  return [
    [{ x: start.x - dx, y: start.y - dy }, { ...end }],
    [
      { x: start.x + dy, y: start.y - dx },
      { x: start.x - dy, y: start.y + dx },
    ],
  ];
}
export function pcbArc(g: Pick<BoardLine, 'start' | 'mid' | 'end'>) {
  const a = g.start,
    b = g.mid!,
    c = g.end;
  if (!b) return null;
  const ux = b.x - a.x,
    uy = b.y - a.y,
    vx = c.x - a.x,
    vy = c.y - a.y;
  const d = 2 * (ux * vy - uy * vx);
  if (Math.abs(d) < 1e-12) return null;
  const u2 = ux * ux + uy * uy,
    v2 = vx * vx + vy * vy;
  const center = {
    x: a.x + (u2 * vy - v2 * uy) / d,
    y: a.y + (ux * v2 - vx * u2) / d,
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

/** Include only cardinals on the finite sweep, even for a very shallow arc. */
export function pcbArcBoundsPoints(g: Pick<BoardLine, 'start' | 'mid' | 'end'>): Point[] {
  const points = [g.start, g.end];
  const arc = pcbArc(g);
  if (!arc) return points;
  const tau = Math.PI * 2;
  const direction = Math.sign(arc.delta);
  for (const angle of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
    if ((direction * (angle - arc.start) + tau * 2) % tau > Math.abs(arc.delta)) continue;
    points.push({
      x: arc.center.x + arc.radius * Math.cos(angle),
      y: arc.center.y + arc.radius * Math.sin(angle),
    });
  }
  return points;
}
/** Four ordered quarter-circle arcs through the native rounded corners. */
export function pcbRoundedRectArcs(g: BoardLine) {
  const radius = g.roundedRectRadius!;
  const vertices = [g.start, ...g.points!, g.end];
  return vertices.map((vertex, i) => {
    const offset = (neighbor: Point) => {
      const dx = neighbor.x - vertex.x,
        dy = neighbor.y - vertex.y;
      const length = Math.hypot(dx, dy);
      return { x: (dx * radius) / length, y: (dy * radius) / length };
    };
    const before = offset(vertices[(i + 3) % 4]);
    const after = offset(vertices[(i + 1) % 4]);
    return {
      start: { x: vertex.x + before.x, y: vertex.y + before.y },
      center: { x: vertex.x + before.x + after.x, y: vertex.y + before.y + after.y },
      clockwise: before.x * after.y - before.y * after.x < 0,
      end: { x: vertex.x + after.x, y: vertex.y + after.y },
    };
  });
}

export function pcbCurvedPolygonPath(
  vertices: Point[],
  edges: NonNullable<BoardLine['polygonArcs']>,
): string {
  const arcs = new Map(edges.map(({ vertex, mid }) => [vertex, mid]));
  const path = [`M ${vertices[0].x} ${vertices[0].y}`];
  for (let i = 0; i < vertices.length - 1; i++) {
    const end = vertices[i + 1];
    const arc = pcbArc({ start: vertices[i], mid: arcs.get(i), end });
    path.push(
      arc
        ? `A ${arc.radius} ${arc.radius} 0 ${Math.abs(arc.delta) > Math.PI ? 1 : 0} ${arc.delta > 0 ? 1 : 0} ${end.x} ${end.y}`
        : `L ${end.x} ${end.y}`,
    );
  }
  return `${path.join(' ')} Z`;
}

export function pcbBezierIsStationary(g: BoardLine): boolean {
  const { start, end } = g;
  return [end, ...g.points!].every((point) => point.x === start.x && point.y === start.y);
}

/** Subdivide until both inner control points are within the requested chord error. */
export function pcbBezierVertices(g: BoardLine, tolerance = 0.005): Point[] {
  if (pcbBezierIsStationary(g)) return [g.start, g.end];
  const maxDepth = 16;
  const vertices = [g.start];
  const half = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const subdivide = (start: Point, first: Point, second: Point, end: Point, depth: number) => {
    const flat =
      Math.max(pointSegmentDistance(first, start, end), pointSegmentDistance(second, start, end)) <=
      tolerance ** 2;
    // A closed cubic must turn into at least two chords even when it is small.
    if (flat && (depth < maxDepth || start.x !== end.x || start.y !== end.y)) {
      if (vertices.length >= 16384) throw new Error('Bézier subdivision exceeds the vertex limit.');
      vertices.push(end);
      return;
    }
    if (!depth) throw new Error('Bézier subdivision cannot meet the requested geometry tolerance.');
    const a = half(start, first),
      b = half(first, second),
      c = half(second, end);
    const d = half(a, b),
      e = half(b, c);
    const middle = half(d, e);
    subdivide(start, a, d, middle, depth - 1);
    subdivide(middle, e, c, end, depth - 1);
  };
  const [first, second] = g.points!;
  subdivide(g.start, first, second, g.end, maxDepth);
  return vertices;
}

function pcbBezierBoundsPoints(g: BoardLine): Point[] {
  const [first, second] = g.points!;
  const parameters = new Set<number>();
  for (const axis of ['x', 'y'] as const) {
    const c = first[axis] - g.start[axis];
    const d = second[axis] - first[axis];
    const e = g.end[axis] - second[axis];
    const a = c - 2 * d + e;
    const b = 2 * (d - c);
    const discriminant = b * b - 4 * a * c;
    if (a === 0) {
      if (b !== 0) parameters.add(-c / b);
    } else if (discriminant >= 0) {
      const root = Math.sqrt(discriminant);
      parameters.add((-b + root) / (2 * a));
      parameters.add((-b - root) / (2 * a));
    }
  }
  const extrema = [...parameters]
    .filter((t) => t > 0 && t < 1)
    .map((t) => {
      const s = 1 - t;
      const at = (axis: 'x' | 'y') =>
        s ** 3 * g.start[axis] +
        3 * s ** 2 * t * first[axis] +
        3 * s * t ** 2 * second[axis] +
        t ** 3 * g.end[axis];
      return { x: at('x'), y: at('y') };
    });
  return [g.start, ...extrema, g.end];
}

export function pcbGraphicPath(g: BoardLine): string {
  if (g.roundedRectRadius !== undefined) {
    const arcs = pcbRoundedRectArcs(g);
    const radius = g.roundedRectRadius;
    return (
      arcs
        .map(
          (arc, index) =>
            `${index ? 'L' : 'M'} ${arc.start.x} ${arc.start.y} A ${radius} ${radius} 0 0 ${arc.clockwise ? 1 : 0} ${arc.end.x} ${arc.end.y}`,
        )
        .join(' ') + ' Z'
    );
  }
  if (g.polygonArcs)
    return pcbCurvedPolygonPath([g.start, ...(g.points ?? []), g.end], g.polygonArcs);
  if (g.kind === 'polygon')
    return `M ${[g.start, ...(g.points ?? []), g.end].map((p) => `${p.x} ${p.y}`).join(' L ')} Z`;
  if (g.kind === 'curve')
    return `M ${g.start.x} ${g.start.y} C ${[...g.points!, g.end].map(({ x, y }) => `${x} ${y}`).join(' ')}`;
  if (g.kind === 'arc') {
    const arc = pcbArc(g);
    if (arc)
      return `M ${g.start.x} ${g.start.y} A ${arc.radius} ${arc.radius} 0 ${Math.abs(arc.delta) > Math.PI ? 1 : 0} ${arc.delta > 0 ? 1 : 0} ${g.end.x} ${g.end.y}`;
  }
  return `M ${g.start.x} ${g.start.y} L ${g.end.x} ${g.end.y}`;
}
export function pcbGraphicPoints(g: BoardLine): Point[] {
  if (g.text?.hidden) return [];
  if (g.dimension?.type === 'center') return pcbCenterMarkStrokes(g).flat();
  if (g.kind === 'point') {
    const { x, y } = g.start;
    const r = g.width / 2;
    return [
      { x: x - r, y: y - r },
      { x: x + r, y: y + r },
    ];
  }
  if (g.kind === 'curve') return pcbBezierBoundsPoints(g);
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
  if (g.polygonArcs) {
    const vertices = [g.start, ...(g.points ?? []), g.end];
    for (const { vertex, mid } of g.polygonArcs)
      points.push(
        ...pcbArcBoundsPoints({ start: vertices[vertex], mid, end: vertices[vertex + 1] }),
      );
  }
  const t = g.text ?? g.dimension?.caption;
  if (t) {
    const lines = pcbTextDisplayValue(t).split('\n');
    const at = g.dimension?.caption ?? g.start,
      w = Math.max(...lines.map((s) => s.length)) * t.size.x * 0.7,
      h = t.size.y + (lines.length - 1) * pcbTextLineAdvance(t);
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

type TrapezoidPad = Pick<Pad, 'size' | 'trapezoidDelta'>;
const halfPCBUnit = (value: number) => Math.trunc(Math.round(value * 1_000_000) / 2);
const isNativePadDelta = (value: number) =>
  Number.isFinite(value) &&
  Math.abs(value) <= 100000 &&
  Math.abs(value - Number(value.toFixed(6))) <= 1e-9;

/** KiCad divides the integer nanometer size and delta before adding each corner. */
export function pcbPadTrapezoid({ size, trapezoidDelta }: TrapezoidPad): Point[] {
  const x = halfPCBUnit(size.x),
    y = halfPCBUnit(size.y);
  const dx = halfPCBUnit(trapezoidDelta?.x ?? 0),
    dy = halfPCBUnit(trapezoidDelta?.y ?? 0);
  return [
    { x: -x + dy, y: -y - dx },
    { x: x - dy, y: -y + dx },
    { x: x + dy, y: y - dx },
    { x: -x - dy, y: y + dx },
  ].map((point) => ({ x: point.x / 1_000_000, y: point.y / 1_000_000 }));
}

export function validatePCBPadTrapezoid(
  pad: TrapezoidPad & Pick<Pad, 'shape'>,
  fail: (message: string) => never,
) {
  if (pad.shape !== 'trapezoid') {
    if (pad.trapezoidDelta) fail('A rect_delta requires a trapezoid pad.');
    return;
  }
  if (pad.trapezoidDelta && ![pad.trapezoidDelta.x, pad.trapezoidDelta.y].every(isNativePadDelta))
    fail('The trapezoid pad delta must use native coordinate precision.');
  const x = halfPCBUnit(pad.size.x),
    y = halfPCBUnit(pad.size.y);
  const dx = halfPCBUnit(pad.trapezoidDelta?.x ?? 0),
    dy = halfPCBUnit(pad.trapezoidDelta?.y ?? 0);
  if (!(x > 0 && y > 0 && Math.abs(dx) / y + Math.abs(dy) / x < 1))
    fail('The trapezoid pad delta must retain a convex four-corner shape.');
}

export function readPCBPadTrapezoidDelta(
  record: SExpr,
  fail: (message: string) => never,
): Point | undefined {
  const records = children(record, 'rect_delta');
  if (!records.length) return;
  const delta = records[0].slice(1);
  if (
    records.length !== 1 ||
    delta.length !== 2 ||
    !delta.every(
      (item) =>
        typeof item === 'string' && /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(item),
    )
  )
    fail('Invalid native pad rect_delta.');
  const [x, y] = delta.map(Number);
  if (![x, y].every(isNativePadDelta))
    fail('The native pad rect_delta must use native coordinate precision.');
  return { x, y };
}

/** Pad-local path; rounded corners use circular SVG arcs. */
export function pcbPadPath(
  p: Pick<
    Pad,
    'size' | 'roundrectRatio' | 'chamferRatio' | 'chamfer' | 'outline' | 'trapezoidDelta'
  > &
    Partial<Pick<Pad, 'shape'>>,
): string {
  const outline = p.shape === 'trapezoid' ? pcbPadTrapezoid(p) : p.outline;
  if (outline) return `M ${outline.map(({ x, y }) => `${x} ${y}`).join(' L ')} Z`;
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
