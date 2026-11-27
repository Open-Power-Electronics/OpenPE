import Clipper from 'clipper-lib';
import type { Point } from './circuit';
import type { Pad } from './pcb';
import {
  insidePolygon,
  pointSegmentDistance,
  polygonEdges,
  segmentDistance,
} from './pcb-collision';
import { customPadVertexLimit } from './pcb-custom-pad-limits';
import { child, children, val, type SExpr } from './sexpr';
import { nativeCustomPadShapes, type NativeCustomPad } from './pcb-native-custom-pad';
import { pcbGraphicPoints, pcbPadTrapezoid } from './pcb-geometry';

type Reject = (message: string) => never;

const nmPerMm = 1_000_000;
const rectangleLimit = 16;
function nativeNanometres(value: number, reject: Reject) {
  const nm = Math.round(value * nmPerMm);
  if (!Number.isFinite(value) || Math.abs(value) > 100000 || Math.abs(value - nm / nmPerMm) > 1e-9)
    reject('Custom pad rectangles require native coordinate precision.');
  return nm;
}

function readPadPolygon(polygon: SExpr, reject: Reject): Point[] {
  const points = child(polygon, 'pts');
  const width = child(polygon, 'width');
  const fill = child(polygon, 'fill');
  if (
    polygon[0] !== 'gr_poly' ||
    polygon.length !== 4 ||
    width?.length !== 2 ||
    !val(width) ||
    Number(val(width)) !== 0 ||
    fill?.length !== 2 ||
    val(fill) !== 'yes' ||
    !points ||
    points.length < 4 ||
    points.length > customPadVertexLimit + 1
  )
    reject(
      `Custom pad polygons must be filled and unstroked with 3–${customPadVertexLimit} vertices.`,
    );
  return points.slice(1).map((point) => {
    if (
      !Array.isArray(point) ||
      point[0] !== 'xy' ||
      point.length !== 3 ||
      !val(point) ||
      !val(point, 2)
    )
      reject('Invalid custom pad vertex.');
    return { x: Number(val(point)), y: Number(val(point, 2)) };
  });
}

function rectanglePath(left: number, top: number, right: number, bottom: number): Clipper.Path {
  return [
    { X: left, Y: top },
    { X: right, Y: top },
    { X: right, Y: bottom },
    { X: left, Y: bottom },
  ];
}

/** Axis-aligned intersections stay on the native nanometre grid. */
function mergePadRectangles(pad: SExpr, polygons: Point[][], reject: Reject): Point[] {
  const size = child(pad, 'size');
  const width = nativeNanometres(Number(val(size)), reject);
  const height = nativeNanometres(Number(val(size, 2)), reject);
  if (size?.length !== 3 || width <= 0 || height <= 0 || width % 2 || height % 2)
    reject('Compound custom pads require a rectangular anchor on the native grid.');
  const paths = polygons.map((polygon) => {
    const points = polygon.map(({ x, y }) => ({
      x: nativeNanometres(x, reject),
      y: nativeNanometres(y, reject),
    }));
    const xs = [...new Set(points.map(({ x }) => x))].sort((a, b) => a - b);
    const ys = [...new Set(points.map(({ y }) => y))].sort((a, b) => a - b);
    if (
      points.length !== 4 ||
      xs.length !== 2 ||
      ys.length !== 2 ||
      points.some((point, i) => {
        const next = points[(i + 1) % points.length];
        return (point.x === next.x) === (point.y === next.y);
      }) ||
      new Set(points.map(({ x, y }) => `${x},${y}`)).size !== 4
    )
      reject('Compound custom pad primitives must be axis-aligned rectangles.');
    return rectanglePath(xs[0], ys[0], xs[1], ys[1]);
  });
  paths.unshift(rectanglePath(-width / 2, -height / 2, width / 2, height / 2));
  const clipper = new Clipper.Clipper();
  clipper.StrictlySimple = true;
  const tree = new Clipper.PolyTree();
  clipper.AddPaths(paths, Clipper.PolyType.ptSubject, true);
  clipper.Execute(
    Clipper.ClipType.ctUnion,
    tree,
    Clipper.PolyFillType.pftNonZero,
    Clipper.PolyFillType.pftNonZero,
  );
  const regions = Clipper.JS.PolyTreeToExPolygons(tree);
  if (regions.length !== 1 || regions[0].holes.length)
    reject('Compound custom pads require a single outline without holes.');
  return regions[0].outer.map(({ X, Y }) => ({ x: X / nmPerMm, y: Y / nmPerMm }));
}

export function readCustomPad(pad: SExpr, reject: Reject): Pick<Pad, 'outline' | 'customAnchor'> {
  const options = children(pad, 'options');
  const primitives = children(pad, 'primitives');
  if (val(pad, 3) !== 'custom') {
    if (options.length) reject('The pad uses unsupported options.');
    if (primitives.length) reject('The pad uses unsupported primitives.');
    return {};
  }
  const option = options[0];
  const clearance = option && children(option, 'clearance')[0];
  const anchor = option && children(option, 'anchor')[0];
  const anchorShape = val(anchor);
  if (
    options.length !== 1 ||
    option.length !== 3 ||
    clearance?.length !== 2 ||
    val(clearance) !== 'outline' ||
    anchor?.length !== 2 ||
    !['rect', 'circle'].includes(anchorShape)
  )
    reject('Custom pads require outline clearance and a rectangular or circular anchor.');
  const records = primitives[0]?.slice(1) ?? [];
  if (primitives.length !== 1 || !records.length || records.length > rectangleLimit)
    reject(`Custom pads require one polygon or up to ${rectangleLimit} rectangular primitives.`);
  const polygons = records.map((record) => {
    if (!Array.isArray(record)) reject('Invalid custom pad primitive.');
    return readPadPolygon(record, reject);
  });
  if (polygons.length > 1 && anchorShape !== 'rect')
    reject('Compound custom pads require a rectangular anchor.');
  const outline = polygons.length === 1 ? polygons[0] : mergePadRectangles(pad, polygons, reject);
  return { outline, ...(anchorShape === 'circle' ? { customAnchor: 'circle' } : {}) };
}

/** Board import also retains checked KiCad primitives beyond the editable polygon subset. */
export function readBoardCustomPad(
  pad: SExpr,
  geometry: Pick<Pad, 'shape' | 'type' | 'size' | 'drillOffset'>,
  reject: Reject,
): Pick<Pad, 'outline' | 'customAnchor' | 'nativeCustomPad'> {
  if (val(pad, 3) !== 'custom') return readCustomPad(pad, reject);
  const options = children(pad, 'options');
  const primitives = children(pad, 'primitives');
  const option = options[0];
  const anchor = child(option ?? [], 'anchor');
  const clearanceField = child(option ?? [], 'clearance');
  const clearance = val(clearanceField);
  const circular = val(anchor) === 'circle';
  if (
    options.length !== 1 ||
    option.length !== 3 ||
    anchor?.length !== 2 ||
    (!circular && val(anchor) !== 'rect') ||
    clearanceField?.length !== 2 ||
    (clearance !== 'outline' && clearance !== 'convexhull') ||
    primitives.length !== 1
  )
    return reject('Invalid native custom pad options.');
  const records = primitives[0]
    .slice(1)
    .map((record) =>
      Array.isArray(record) ? record : reject('Invalid native custom pad primitive.'),
    );
  const nativeCustomPad: NativeCustomPad = { clearance, primitives: records };
  if (!records.length) return { nativeCustomPad, ...(circular ? { customAnchor: 'circle' } : {}) };
  try {
    const simple = readCustomPad(pad, reject);
    validateCustomPad({ ...geometry, ...simple }, reject);
    return simple;
  } catch {
    // The wider native representation receives its own strict grammar below.
  }
  nativeCustomPadShapes(nativeCustomPad, reject);
  return { nativeCustomPad, ...(circular ? { customAnchor: 'circle' } : {}) };
}

/** Intersect the segment parameter with the rectangle's open interior. */
function entersAnchor(a: Point, b: Point, half: Point): boolean {
  let start = 0;
  let end = 1;
  for (const axis of ['x', 'y'] as const) {
    const delta = b[axis] - a[axis];
    if (delta === 0) {
      if (Math.abs(a[axis]) >= half[axis]) return false;
      continue;
    }
    const first = (-half[axis] - a[axis]) / delta;
    const last = (half[axis] - a[axis]) / delta;
    start = Math.max(start, Math.min(first, last));
    end = Math.min(end, Math.max(first, last));
  }
  return start < end;
}

type PadBounds = Pick<Pad, 'size' | 'outline' | 'nativeCustomPad' | 'shape' | 'trapezoidDelta'>;

export function padBoundPoints(pad: PadBounds): Point[] {
  const { size, outline, nativeCustomPad } = pad;
  if (pad.shape === 'trapezoid') return pcbPadTrapezoid(pad);
  if (nativeCustomPad) {
    const shapes = nativeCustomPadShapes(nativeCustomPad, (message) => {
      throw new Error(message);
    });
    const points = [
      { x: -size.x / 2, y: -size.y / 2 },
      { x: size.x / 2, y: size.y / 2 },
      ...shapes.flatMap((shape) =>
        pcbGraphicPoints({ ...shape, id: '', layer: 'F.Cu' }).flatMap(({ x, y }) => [
          { x: x - shape.width / 2, y: y - shape.width / 2 },
          { x: x + shape.width / 2, y: y + shape.width / 2 },
        ]),
      ),
    ];
    const minX = Math.min(...points.map(({ x }) => x)),
      maxX = Math.max(...points.map(({ x }) => x));
    const minY = Math.min(...points.map(({ y }) => y)),
      maxY = Math.max(...points.map(({ y }) => y));
    return [
      { x: minX, y: minY },
      { x: minX, y: maxY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
    ];
  }
  return (
    outline ?? [
      { x: -size.x / 2, y: -size.y / 2 },
      { x: size.x / 2, y: -size.y / 2 },
      { x: size.x / 2, y: size.y / 2 },
      { x: -size.x / 2, y: size.y / 2 },
    ]
  );
}

export function padReach(pad: PadBounds): number {
  const { size, outline, nativeCustomPad } = pad;
  if (nativeCustomPad || pad.shape === 'trapezoid')
    return Math.max(...padBoundPoints(pad).map(({ x, y }) => Math.hypot(x, y)));
  return outline
    ? Math.max(...outline.map(({ x, y }) => Math.hypot(x, y)))
    : Math.hypot(size.x, size.y) / 2;
}

export function padExtent(pad: Omit<PadBounds, 'nativeCustomPad'>): Point {
  const { size } = pad;
  const outline = pad.shape === 'trapezoid' ? pcbPadTrapezoid(pad) : pad.outline;
  if (!outline) return size;
  const x = outline.map((point) => point.x);
  const y = outline.map((point) => point.y);
  return { x: Math.max(...x) - Math.min(...x), y: Math.max(...y) - Math.min(...y) };
}

export function validateCustomPad(
  {
    shape,
    type,
    size,
    outline,
    customAnchor,
    drillOffset,
    nativeCustomPad,
  }: Pick<
    Pad,
    'shape' | 'type' | 'size' | 'outline' | 'customAnchor' | 'drillOffset' | 'nativeCustomPad'
  >,
  reject: Reject,
) {
  if (shape !== 'custom') {
    if (outline !== undefined || customAnchor !== undefined || nativeCustomPad !== undefined)
      reject('Custom pad fields require a custom pad.');
    return;
  }
  if (nativeCustomPad) {
    if (
      outline ||
      (type !== 'smd' && type !== 'thru_hole') ||
      ![size.x, size.y].every((dimension) => Number.isFinite(dimension) && dimension > 0)
    )
      reject('Invalid retained native custom pad.');
    nativeCustomPadShapes(nativeCustomPad, reject);
    return;
  }
  if ((type !== 'smd' && type !== 'thru_hole') || drillOffset)
    reject('Custom pads require surface mounting or a centred plated drill.');
  if (
    !outline ||
    outline.length < 3 ||
    outline.length > customPadVertexLimit ||
    outline.some(({ x, y }) =>
      [x, y].some(
        (value) =>
          !Number.isFinite(value) ||
          Math.abs(value) > 100000 ||
          Math.abs(value - Number(value.toFixed(6))) > 1e-9,
      ),
    ) ||
    new Set(outline.map(({ x, y }) => `${x},${y}`)).size !== outline.length
  )
    reject('Custom pad vertices must be distinct and use native coordinate precision.');
  const polygon = { outer: outline, holes: [] };
  const edges = polygonEdges(polygon);
  const coincident = 1e-18;
  for (const [i, [a, b]] of edges.entries()) {
    const next = edges[(i + 1) % edges.length][1];
    if (
      // Adjacent edges can share their endpoint, but must never double back.
      segmentDistance(a, a, b, next) <= coincident ||
      segmentDistance(next, next, a, b) <= coincident ||
      edges
        .slice(i + 2, i ? undefined : -1)
        .some(([c, d]) => segmentDistance(a, b, c, d) <= coincident)
    )
      reject('A custom pad polygon must be simple and non-self-intersecting.');
  }
  if (![size.x, size.y].every((dimension) => Number.isFinite(dimension) && dimension > 0))
    reject('Custom pad anchors require a positive size.');
  if (customAnchor === 'circle') {
    if (size.x !== size.y) reject('A circular custom pad anchor requires equal dimensions.');
    const center = { x: 0, y: 0 };
    // KiCad divides integer-nanometre pad sizes by two when constructing the anchor.
    const radius = Math.floor(Math.round(size.x * 1_000_000) / 2) / 1_000_000;
    const edgeDistance = Math.min(...edges.map(([a, b]) => pointSegmentDistance(center, a, b)));
    const onBoundary = edgeDistance <= 1e-24;
    if (
      (!insidePolygon(center, polygon) && !onBoundary) ||
      Math.sqrt(edgeDistance) + 1e-12 < radius
    )
      reject('A custom pad polygon must fully enclose its circular anchor.');
    return;
  }
  const half = { x: size.x / 2, y: size.y / 2 };
  if (!insidePolygon({ x: 0, y: 0 }, polygon) || edges.some(([a, b]) => entersAnchor(a, b, half)))
    reject('A custom pad polygon must fully enclose its rectangular anchor.');
}
