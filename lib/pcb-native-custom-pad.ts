import type { Point } from './circuit';
import type { BoardLine, Pad } from './pcb';
import {
  pointSegmentDistance,
  polygonEdges,
  segmentDistance,
  squaredDistance,
} from './pcb-collision';
import { pcbArc, transformPCBGraphic } from './pcb-geometry';
import { child, children, val, type SExpr } from './sexpr';

export type NativeCustomPad = {
  clearance: 'outline' | 'convexhull';
  primitives: SExpr[];
};

type Reject = (message: string) => never;
type Shape = Omit<BoardLine, 'id' | 'layer'>;
const maxPrimitives = 64;
const maxPolygonVertices = 512;

function nativeCustomPadPoint(node: SExpr | undefined, reject: Reject): Point {
  if (node?.length !== 3) return reject('Invalid native custom pad point.');
  return { x: nativeCoordinate(node[1], reject), y: nativeCoordinate(node[2], reject) };
}

function nativeCoordinate(value: SExpr[number] | undefined, reject: Reject): number {
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))
    return reject('Invalid native custom pad coordinate or width.');
  const n = Number(value);
  if (
    !Number.isFinite(n) ||
    Math.abs(n) > 100000 ||
    Math.abs(n * 1e6 - Math.round(n * 1e6)) > 0.0001
  )
    return reject('Native custom pad geometry must use bounded nanometre coordinates.');
  return n;
}

function nativeNumberBox(primitive: SExpr, reject: Reject) {
  if (
    primitive.length !== 4 ||
    children(primitive, 'start').length !== 1 ||
    children(primitive, 'end').length !== 1 ||
    child(primitive, 'fill')?.length !== 2 ||
    val(child(primitive, 'fill')) !== 'no'
  )
    return reject('Invalid native pad label box.');
  const start = nativeCustomPadPoint(child(primitive, 'start'), reject);
  const end = nativeCustomPadPoint(child(primitive, 'end'), reject);
  const size = { x: Math.abs(end.x - start.x), y: Math.abs(end.y - start.y) };
  if (!size.x || !size.y) return reject('Degenerate native pad label box.');
  return { size, center: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 } };
}

export function nativeCustomPadLabelBox(pad: Pad) {
  const box = pad.nativeCustomPad?.primitives.find((primitive) => primitive[0] === 'gr_bbox');
  if (box)
    return nativeNumberBox(box, (message) => {
      throw new Error(message);
    });
}

/** Project the validated native primitives for display. The source records own
 * the geometry written to KiCad, including widths and the independent anchor. */
export function nativeCustomPadShapes(record: NativeCustomPad, reject: Reject): Shape[] {
  if (
    !['outline', 'convexhull'].includes(record.clearance) ||
    record.primitives.length > maxPrimitives
  )
    return reject('Unsupported native custom pad clearance or primitive count.');

  const number = (value: SExpr[number] | undefined) => nativeCoordinate(value, reject);
  const point = (node: SExpr | undefined) => nativeCustomPadPoint(node, reject);
  const copper = record.primitives.filter((primitive) => {
    if (primitive[0] !== 'gr_bbox') return true;
    nativeNumberBox(primitive, reject);
    return false;
  });
  return copper.map((primitive): Shape => {
    const kind = primitive[0];
    const keys =
      kind === 'gr_line' || kind === 'gr_rect'
        ? ['start', 'end']
        : kind === 'gr_arc'
          ? ['start', 'mid', 'end']
          : kind === 'gr_circle'
            ? ['center', 'end']
            : kind === 'gr_poly'
              ? ['pts']
              : reject(`Unsupported native custom pad primitive ${kind}.`);
    const fillable = kind === 'gr_poly' || kind === 'gr_circle' || kind === 'gr_rect';
    const allowed = new Set([...keys, 'width', ...(fillable ? ['fill'] : [])]);
    const seen = new Set<string>();
    for (const field of primitive.slice(1)) {
      if (
        !Array.isArray(field) ||
        typeof field[0] !== 'string' ||
        !allowed.has(field[0]) ||
        seen.has(field[0])
      )
        return reject('Invalid or repeated native custom pad primitive field.');
      seen.add(field[0]);
    }
    const widthNode = child(primitive, 'width');
    const fillNode = child(primitive, 'fill');
    if (
      widthNode?.length !== 2 ||
      (fillNode && (fillNode.length !== 2 || !['yes', 'no'].includes(val(fillNode))))
    )
      return reject('Invalid native custom pad stroke or fill.');
    const width = number(widthNode[1]);
    const fill = val(fillNode) === 'yes';
    if (width < 0 || width > 1000 || (!width && !fill))
      return reject('Native custom pad strokes need positive width or a solid fill.');
    if (kind === 'gr_poly') {
      const field = child(primitive, 'pts');
      const coords = field ? children(field, 'xy') : [];
      if (
        coords.length < 3 ||
        coords.length > maxPolygonVertices ||
        coords.length !== field!.length - 1
      )
        return reject('Native custom pad polygon exceeds the supported vertex range.');
      const points = coords.map(point);
      if (new Set(points.map(({ x, y }) => `${x},${y}`)).size < 3)
        return reject('Degenerate native custom pad polygon.');
      return {
        kind: 'polygon',
        width,
        fill,
        start: points[0],
        end: points.at(-1)!,
        points: points.slice(1, -1),
      };
    }
    const start = point(child(primitive, kind === 'gr_circle' ? 'center' : 'start'));
    const end = point(child(primitive, 'end'));
    if (kind === 'gr_rect') {
      if (start.x === end.x || start.y === end.y)
        return reject('Degenerate native custom pad rectangle.');
      return {
        kind: 'polygon',
        width,
        fill,
        start,
        end: { x: start.x, y: end.y },
        points: [{ x: end.x, y: start.y }, end],
      };
    }
    if (kind === 'gr_arc') {
      const arc = { kind: 'arc' as const, width, start, end, mid: point(child(primitive, 'mid')) };
      if (!pcbArc(arc)) return reject('Degenerate native custom pad arc.');
      return arc;
    }
    if (kind === 'gr_circle') {
      if (start.x === end.x && start.y === end.y)
        return reject('Degenerate native custom pad circle.');
      return { kind: 'circle', width, fill, start, end };
    }
    return { width, start, end };
  });
}

export function nativeCustomPadGraphics(pad: Pad): BoardLine[] {
  if (!pad.nativeCustomPad) return [];
  return nativeCustomPadShapes(pad.nativeCustomPad, (message) => {
    throw new Error(message);
  }).map((shape, index) => ({ ...shape, id: `${pad.id}:${index}`, layer: 'F.Cu' }));
}

export function nativeCustomPadAnchor(pad: Pad): Pad | undefined {
  const shape = pad.customAnchor === 'circle' ? 'circle' : 'rect';
  const diameter = (2 * Math.floor(Math.round(pad.size.x * 1_000_000) / 2)) / 1_000_000;
  const size = shape === 'circle' ? { x: diameter, y: diameter } : pad.size;
  if (!size.x || !size.y) return undefined;
  return { ...pad, shape, size, nativeCustomPad: undefined, outline: undefined };
}

/** A filled Gerber region requires a simple closed contour. Dark primitive unions preserve holes between shapes. */
export function nativeCustomPadPlotGraphics(pad: Pad, place: (point: Point) => Point): BoardLine[] {
  return nativeCustomPadGraphics(pad).map((graphic) => {
    const shape = transformPCBGraphic(graphic, place);
    if (shape.kind !== 'polygon') return shape;
    const vertices = [shape.start, ...(shape.points ?? []), shape.end]
      .map(({ x, y }) => ({ x: Math.round(x * 1e6) / 1e6, y: Math.round(y * 1e6) / 1e6 }))
      .filter((point, index, ring) => !index || squaredDistance(point, ring[index - 1]) > 0);
    if (squaredDistance(vertices[0], vertices.at(-1)!) === 0) vertices.pop();
    for (let i = 0; i + 3 < vertices.length;) {
      if (
        squaredDistance(vertices[i], vertices[i + 2]) === 0 &&
        squaredDistance(vertices[i + 1], vertices[i + 3]) === 0
      ) {
        // A→B→A→B has the same winding and stroked area as A→B.
        vertices.splice(i + 2, 2);
        i = Math.max(0, i - 2);
      } else i++;
    }
    if (vertices.length < 3)
      throw new Error('A native custom pad polygon collapses at Gerber resolution.');
    if (shape.fill) {
      const edges = polygonEdges({ outer: vertices, holes: [] });
      for (const [i, edge] of edges.entries()) {
        const [a, b] = edge;
        const c = vertices[(i + 2) % edges.length];
        if (pointSegmentDistance(a, b, c) < 1e-16 || pointSegmentDistance(c, a, b) < 1e-16)
          throw new Error('A native custom pad contains an overlapping polygon edge.');
        for (let j = i + 2; j < edges.length; j++) {
          if (i === 0 && j === edges.length - 1) continue;
          if (segmentDistance(...edge, ...edges[j]) < 1e-16)
            throw new Error('A native custom pad contains a non-simple filled polygon.');
        }
      }
    }
    return { ...shape, start: vertices[0], points: vertices.slice(1, -1), end: vertices.at(-1)! };
  });
}
