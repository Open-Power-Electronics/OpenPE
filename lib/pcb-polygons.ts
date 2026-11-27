import Clipper from 'clipper-lib';
import type { Point } from './circuit';
import type { BoardLine, BoardZone, CopperLayer, Footprint, Pad, PCB } from './pcb';
import {
  pcbArc,
  pcbBezierIsStationary,
  pcbBezierVertices,
  pcbPadChamferEndpoints,
  pcbPadCorners,
  pcbPadTrapezoid,
  pcbRoundedRectArcs,
  transformPCBGraphic,
  transformPCBZone,
  pcbZoneCircle,
  pcbCurvedPolygonPath,
} from './pcb-geometry';
import {
  hasNativePCBTeardrops,
  invalidatePCBFill,
  isUnassignedSavedCopperZone,
  pcbFillInputsChanged,
  requireSupportedPCBCopper,
  samePCBTrackCopper,
} from './pcb';
import {
  defaultPCBIslandAreaMin,
  pcbPadCopperClearance,
  pcbPadZoneConnection,
  pcbZoneLayerActive,
} from './pcb-zone-settings';
import {
  footprintPoint,
  padDrillLine,
  padDrillPosition,
  padPosition,
  padRotation,
} from './pcb-layout';
import { isOwnedPCB, isOwnedProjectNode, ownProjectData } from './immutable-project';
import { padCopperLayers, partitionPCBRoutingCopper } from './pcb-connectivity';
import { borrowPCBPadCopperContour } from './pcb-pad-contour';
import {
  matchingPCBClearanceRule,
  pcbRuleNetClass,
  readPCBDesignRuleSourceTexts,
  samePCBFillRules,
  type PCBFillRuleContext,
  type PCBRuleOperand,
} from './pcb-clearance-sources';
import { loadKiCadPCBDesignRuleLimits, workbenchPCBDesignRules } from './design-rule-checks';
import {
  edgeBounds,
  insidePolygon,
  makeBoundsIndex,
  pointSegmentDistance,
  polygonEdges,
  queryBoundsIndex,
  segmentDistance,
  squaredDistance,
} from './pcb-collision';
import { padReach } from './pcb-custom-pad';
import { nativeCustomPadAnchor, nativeCustomPadGraphics } from './pcb-native-custom-pad';

export type Polygon = { outer: Point[]; holes: Point[][] };
type CopperFillPolygon = Polygon & { island?: true };
export const polygonResolution = 0.0001; // Millimetres per integer clipping coordinate.
const scale = 1 / polygonResolution;
const maxContourVertices = 20_000;
const integer = (points: Point[]) =>
  points.map((p) => ({ X: Math.round(p.x * scale), Y: Math.round(p.y * scale) }));
const decimal = (points: Clipper.Path) => points.map((p) => ({ x: p.X / scale, y: p.Y / scale }));
function oriented(points: Point[], positive = true) {
  const path = integer(points);
  return Clipper.Clipper.Orientation(path) === positive ? path : path.reverse();
}
const paths = (polygons: Polygon[]): Clipper.Paths =>
  polygons.flatMap((p) => [oriented(p.outer), ...p.holes.map((h) => oriented(h, false))]);
function operation(subject: Polygon[], clip: Polygon[], type: Clipper.ClipType): Polygon[] {
  if (!subject.length) return [];
  const engine = new Clipper.Clipper(),
    tree = new Clipper.PolyTree();
  engine.AddPaths(paths(subject), Clipper.PolyType.ptSubject, true);
  engine.AddPaths(paths(clip), Clipper.PolyType.ptClip, true);
  engine.Execute(type, tree, Clipper.PolyFillType.pftNonZero, Clipper.PolyFillType.pftNonZero);
  return Clipper.JS.PolyTreeToExPolygons(tree).map((p) => ({
    outer: decimal(p.outer),
    holes: p.holes.map(decimal),
  }));
}
export const subtractPolygons = (a: Polygon[], b: Polygon[]) =>
  operation(a, b, Clipper.ClipType.ctDifference);
export const intersectPolygons = (a: Polygon[], b: Polygon[]) =>
  operation(a, b, Clipper.ClipType.ctIntersection);
function offset(polygons: Polygon[], amount: number, arcTolerance = 0.01): Polygon[] {
  if (!amount) return polygons;
  const engine = new Clipper.ClipperOffset(2, arcTolerance * scale),
    tree = new Clipper.PolyTree();
  engine.AddPaths(paths(polygons), Clipper.JoinType.jtRound, Clipper.EndType.etClosedPolygon);
  engine.Execute(tree, amount * scale);
  return Clipper.JS.PolyTreeToExPolygons(tree).map((p) => ({
    outer: decimal(p.outer),
    holes: p.holes.map(decimal),
  }));
}
export const offsetPolygons = offset;
function circleSideCount(radius: number): number {
  return Math.min(128, Math.max(24, Math.ceil(Math.PI * Math.sqrt(Math.max(radius, 0.01) / 0.01))));
}
function boundedArcSegments(sweep: number, radius: number, tolerance: number): number {
  // The sagitta of one chord is 2r sin²(sweep / 4).
  if (!(radius > 0)) throw new Error('A circular contour has a degenerate radius.');
  const segmentAngle = 4 * Math.asin(Math.sqrt(Math.min(0.5, tolerance / (2 * radius))));
  const count = Math.ceil(Math.abs(sweep) / segmentAngle);
  if (!Number.isSafeInteger(count) || count >= maxContourVertices)
    throw new Error('Arc subdivision exceeds the contour vertex limit.');
  return Math.max(1, count);
}
export function circlePolygon(at: Point, radius: number, tolerance?: number): Point[] {
  const count =
    tolerance === undefined
      ? circleSideCount(radius)
      : Math.max(3, boundedArcSegments(2 * Math.PI, radius, tolerance));
  return Array.from({ length: count }, (_, i) => ({
    x: at.x + radius * Math.cos((i * Math.PI * 2) / count),
    y: at.y + radius * Math.sin((i * Math.PI * 2) / count),
  }));
}
export function padDrillPolygon(footprint: Footprint, pad: Pad): Point[] {
  const radius = pad.drill! / 2;
  if (!pad.drillSlot) return circlePolygon(padDrillPosition(footprint, pad), radius);
  const [start, end] = padDrillLine(footprint, pad);
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const steps = Math.ceil(circleSideCount(radius) / 2);
  return [end, start].flatMap((point, i) =>
    Array.from({ length: steps + 1 }, (_, j) => {
      const theta = angle + (i - 0.5 + j / steps) * Math.PI;
      return { x: point.x + radius * Math.cos(theta), y: point.y + radius * Math.sin(theta) };
    }),
  );
}
function strokedPath(
  points: Point[],
  width: number,
  closed: boolean,
  arcTolerance = 0.01,
): Polygon[] {
  if (points.length < 2 || width <= 0) return [];
  const engine = new Clipper.ClipperOffset(2, arcTolerance * scale),
    tree = new Clipper.PolyTree();
  engine.AddPath(
    integer(points),
    Clipper.JoinType.jtRound,
    closed ? Clipper.EndType.etClosedLine : Clipper.EndType.etOpenRound,
  );
  engine.Execute(tree, (width * scale) / 2);
  return Clipper.JS.PolyTreeToExPolygons(tree).map((p) => ({
    outer: decimal(p.outer),
    holes: p.holes.map(decimal),
  }));
}
export function strokePolygon(points: Point[], width: number): Polygon[] {
  return strokedPath(points, width, false);
}
export function graphicVertices(g: BoardLine, curveTolerance?: number): Point[] {
  if (g.roundedRectRadius !== undefined) {
    const radius = g.roundedRectRadius;
    const count =
      curveTolerance === undefined
        ? Math.min(512, Math.max(8, Math.ceil((Math.PI / 2) * Math.sqrt(radius / 0.01))))
        : boundedArcSegments(Math.PI / 2, radius, curveTolerance);
    if (count * 4 + 4 > maxContourVertices)
      throw new Error('Rounded rectangle subdivision exceeds the contour vertex limit.');
    return pcbRoundedRectArcs(g).flatMap((arc) => {
      const angle = Math.atan2(arc.start.y - arc.center.y, arc.start.x - arc.center.x);
      const step = ((arc.clockwise ? 1 : -1) * Math.PI) / (2 * count);
      return [
        arc.start,
        ...Array.from({ length: count - 1 }, (_, index) => ({
          x: arc.center.x + radius * Math.cos(angle + step * (index + 1)),
          y: arc.center.y + radius * Math.sin(angle + step * (index + 1)),
        })),
        arc.end,
      ];
    });
  }
  if (g.kind === 'circle')
    return circlePolygon(
      g.start,
      Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y),
      curveTolerance,
    );
  const arcVertices = (segment: Pick<BoardLine, 'start' | 'mid' | 'end'>) => {
    const arc = pcbArc(segment);
    if (!arc) throw new Error('The board outline contains a degenerate arc.');
    const count =
      curveTolerance === undefined
        ? Math.min(512, Math.max(8, Math.ceil(Math.abs(arc.delta) * Math.sqrt(arc.radius / 0.01))))
        : boundedArcSegments(arc.delta, arc.radius, curveTolerance);
    return [
      segment.start,
      ...Array.from({ length: count - 1 }, (_, i) => ({
        x: arc.center.x + arc.radius * Math.cos(arc.start + (arc.delta * (i + 1)) / count),
        y: arc.center.y + arc.radius * Math.sin(arc.start + (arc.delta * (i + 1)) / count),
      })),
      segment.end,
    ];
  };
  if (g.kind === 'arc') return arcVertices(g);
  if (g.kind === 'curve') return pcbBezierVertices(g, curveTolerance);
  if (g.polygonArcs) {
    const vertices = [g.start, ...(g.points ?? []), g.end];
    const arcs = new Map(g.polygonArcs.map(({ vertex, mid }) => [vertex, mid]));
    const points: Point[] = [];
    for (let vertex = 0; vertex < vertices.length; vertex++) {
      const start = vertices[vertex];
      const mid = arcs.get(vertex);
      points.push(
        ...(mid ? arcVertices({ start, mid, end: vertices[vertex + 1] }).slice(0, -1) : [start]),
      );
      if (curveTolerance !== undefined && points.length > maxContourVertices)
        throw new Error('Arc subdivision exceeds the contour vertex limit.');
    }
    return points;
  }
  return [g.start, ...(g.points ?? []), g.end];
}
/** Native physical artwork includes both filled interiors and their stroke.
 * Text/dimensions have separate presentation paths; zero-width open artwork
 * contributes no physical area. Returned points never alias native records.
 */
export function graphicPolygons(g: BoardLine): Polygon[] {
  return boundedGraphicPolygons(g);
}

function boundedGraphicPolygons(g: BoardLine, curveTolerance?: number): Polygon[] {
  if (g.text || g.dimension || g.kind === 'point') return [];
  if (curveTolerance !== undefined && g.kind === 'circle') {
    const radius = Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y);
    const outer = circlePolygon(g.start, radius + g.width / 2, curveTolerance);
    const holeRadius = radius - g.width / 2;
    return [
      {
        outer,
        holes:
          !g.fill && holeRadius > 0 ? [circlePolygon(g.start, holeRadius, curveTolerance)] : [],
      },
    ];
  }
  const points = graphicVertices(g, curveTolerance);
  const closed = g.kind === 'circle' || g.kind === 'polygon';
  if (!closed || !g.fill) return strokedPath(points, g.width, closed, curveTolerance);
  const interior = [{ outer: points.map((point) => ({ ...point })), holes: [] }];
  return g.width > 0 ? offset(interior, g.width / 2, curveTolerance) : interior;
}
/** An empty Model canvas has no board surface; actual artwork still requires a valid outline. */
export function modelBoardPolygons(board: PCB): Polygon[] {
  if (
    !board.footprints.length &&
    !board.tracks.length &&
    !board.arcTracks?.length &&
    !board.vias.length &&
    !board.graphics.length &&
    !board.zones.length
  )
    return [];
  return boardPolygons(board);
}

/** Closed Edge.Cuts loops, including footprint cutouts. Never invent a board rectangle. */
export function boardPolygons(board: PCB): Polygon[] {
  return prepareBoardOutline(board).polygons;
}

export function pcbOutlineGraphics(board: PCB): BoardLine[] {
  return [
    ...board.graphics.filter((graphic) => graphic.layer === 'Edge.Cuts'),
    ...board.footprints.flatMap((footprint) =>
      footprint.graphics
        .filter((graphic) => graphic.layer === 'Edge.Cuts')
        .map((graphic) =>
          transformPCBGraphic(graphic, (point) => footprintPoint(footprint, point)),
        ),
    ),
  ];
}

/** Keep exact world-space primitives beside the validated polygon approximation. */
export function prepareBoardOutline(
  board: PCB,
  curveTolerance?: number,
): {
  edges: readonly Readonly<BoardLine>[];
  polygons: Polygon[];
  contours: Point[][];
} {
  const edges = pcbOutlineGraphics(board);
  if (!edges.length) throw new Error('Draw a closed board outline before previewing copper or 3D.');
  const contours = closedGraphicContours(edges, 'board outline', curveTolerance);
  const polygons = polygonsFromContours(contours);
  if (!polygons.length) throw new Error('The board outline does not enclose a positive area.');
  return { edges, polygons, contours };
}

/** CAM centre lines must form closed loops at the exported coordinates. */
export function prepareFabricationOutline(board: PCB, format: 'DXF' | 'Gerber') {
  const tolerance = 0.0005;
  const outline = prepareBoardOutline(board, tolerance);
  const edges = outline.edges.filter(
    (edge) => edge.kind !== 'curve' || !pcbBezierIsStationary(edge),
  );
  const endpointCounts = new Map<string, number>();
  for (const edge of edges) {
    if (edge.kind && edge.kind !== 'arc' && edge.kind !== 'curve') continue;
    const { start, end } = edge;
    if (!edge.kind && start.x === end.x && start.y === end.y)
      throw new Error('The board outline contains a zero-length line.');
    for (const { x, y } of [start, end]) {
      const key = `${x},${y}`;
      endpointCounts.set(key, (endpointCounts.get(key) ?? 0) + 1);
    }
  }
  if ([...endpointCounts.values()].some((count) => count !== 2))
    throw new Error(`${format} export requires exact joins between board outline endpoints.`);
  let operations = 0;
  prepareBoardOutlineBoundary(outline, tolerance, () => {
    if (++operations > 2_000_000)
      throw new Error('The board outline exceeds the topology check limit.');
  });
  return edges;
}

/** Check original contours independently of polygon repair and return their boundary for DRC. */
export function prepareBoardOutlineBoundary(
  outline: ReturnType<typeof prepareBoardOutline>,
  tolerance: number,
  spend: () => void,
) {
  const epsilon = 0.00001;
  const curved = outline.edges.some(
    (edge) =>
      edge.kind === 'curve' ||
      edge.kind === 'arc' ||
      edge.kind === 'circle' ||
      edge.roundedRectRadius !== undefined ||
      Boolean(edge.polygonArcs),
  );
  const precision = curved ? tolerance + polygonResolution : 0;
  const margin = Math.max(epsilon, 2 * precision);
  let order = 0;
  const edges = outline.contours.flatMap((contour, ring) => {
    const points = contour.filter((point, i) => !i || squaredDistance(point, contour[i - 1]) > 0);
    if (points.length > 1 && squaredDistance(points[0], points.at(-1)!) === 0) points.pop();
    if (points.length < 3) throw new Error('The board outline contains a degenerate contour.');
    return polygonEdges({ outer: points, holes: [] }).map((line, position) => ({
      line,
      ring,
      position,
      order: order++,
      size: points.length,
      ...edgeBounds(line),
    }));
  });
  const index = makeBoundsIndex([...edges]);
  const intersects = () =>
    new Error('The board outline intersects itself or another Edge.Cuts contour.');
  for (const edge of edges) {
    queryBoundsIndex(
      index,
      edge,
      margin,
      (other) => {
        if (other.order <= edge.order) return;
        if (edge.ring === other.ring) {
          const steps = other.position - edge.position;
          if (steps === 1 || steps === edge.size - 1) {
            const [previous, following] =
              steps === 1 ? [edge.line, other.line] : [other.line, edge.line];
            if (
              pointSegmentDistance(previous[0], ...following) === 0 ||
              pointSegmentDistance(following[1], ...previous) === 0
            )
              throw intersects();
            return;
          }
        }
        const distance = segmentDistance(...edge.line, ...other.line);
        if (distance < epsilon ** 2) throw intersects();
        if (precision && distance < margin ** 2)
          throw new Error(
            'The separation of nearby board edges cannot be resolved at the curved outline precision.',
          );
      },
      spend,
    );
  }
  return { index, precision };
}

/** Join open stroke endpoints; native circles and polygons are already closed. */
export function closedGraphicContours(
  edges: BoardLine[],
  context: string,
  curveTolerance?: number,
): Point[][] {
  if (edges.length > 5000) throw new Error(`The ${context} exceeds the graphic limit.`);
  const loops: Point[][] = [],
    segments: Point[][] = [];
  let vertexCount = 0;
  for (const g of edges) {
    if (g.kind === 'text' || g.kind === 'dimension')
      throw new Error(`Unsupported ${context} geometry.`);
    const pts = graphicVertices(g, curveTolerance);
    // KiCad retains point-sized curves in native records but adds no material edge.
    if (g.kind === 'curve' && pts.length === 2 && squaredDistance(pts[0], pts[1]) === 0) continue;
    vertexCount += pts.length;
    if (vertexCount > maxContourVertices)
      throw new Error(`The ${context} exceeds the geometry limit.`);
    if (g.kind === 'circle' || g.kind === 'polygon') loops.push(pts);
    else segments.push(pts);
  }
  const same = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) < 0.00011;
  while (segments.length) {
    const loop = segments.shift()!;
    while (!same(loop[0], loop[loop.length - 1])) {
      const end = loop[loop.length - 1];
      const matching = segments
        .map((s, i) => (same(s[0], end) || same(s[s.length - 1], end) ? i : -1))
        .filter((i) => i >= 0);
      if (matching.length !== 1)
        throw new Error(`The ${context} is open or ambiguous. Join its endpoints.`);
      const next = segments.splice(matching[0], 1)[0];
      loop.push(...(same(next[0], end) ? next : next.reverse()).slice(1));
    }
    loops.push(loop.slice(0, -1));
  }
  return loops;
}

/** Even-odd nesting preserves cutouts and independent solid contours. */
export function polygonsFromContours(loops: Point[][]): Polygon[] {
  const engine = new Clipper.Clipper(),
    tree = new Clipper.PolyTree();
  engine.AddPaths(loops.map(integer), Clipper.PolyType.ptSubject, true);
  engine.Execute(
    Clipper.ClipType.ctUnion,
    tree,
    Clipper.PolyFillType.pftEvenOdd,
    Clipper.PolyFillType.pftEvenOdd,
  );
  return Clipper.JS.PolyTreeToExPolygons(tree).map((p) => ({
    outer: decimal(p.outer),
    holes: p.holes.map(decimal),
  }));
}
const padCornerSegments = 8;
const padCornerStep = Math.PI / 2 / padCornerSegments;

function padCornerRadius(p: Pad): number {
  const side = Math.min(p.size.x, p.size.y);
  if (p.shape === 'oval') return side / 2;
  if (p.shape === 'roundrect') return side * (p.roundrectRatio ?? 0);
  return 0;
}

export function padPolygon(f: Footprint, p: Pad): Polygon {
  const w = p.size.x,
    h = p.size.y;
  let local: Point[];
  if (p.outline) local = p.outline;
  else if (p.shape === 'trapezoid') local = pcbPadTrapezoid(p);
  else if (p.shape === 'circle') local = circlePolygon({ x: 0, y: 0 }, w / 2);
  else {
    const radius = padCornerRadius(p);
    local = pcbPadCorners.flatMap((c, i) => {
      const cut = p.chamfer?.includes(c.name) ? Math.min(w, h) * (p.chamferRatio ?? 0) : 0;
      const start = Math.PI + (i * Math.PI) / 2;
      if (p.chamfer?.includes(c.name))
        return cut
          ? pcbPadChamferEndpoints(c, p.size, cut)
          : [{ x: (c.x * w) / 2, y: (c.y * h) / 2 }];
      if (!radius) return [{ x: (c.x * w) / 2, y: (c.y * h) / 2 }];
      return Array.from({ length: padCornerSegments + 1 }, (_, j) => ({
        x: c.x * (w / 2 - radius) + radius * Math.cos(start + j * padCornerStep),
        y: c.y * (h / 2 - radius) + radius * Math.sin(start + j * padCornerStep),
      }));
    });
    if (p.chamfer?.length)
      local = local.filter((point, i) => {
        const previous = local[(i + local.length - 1) % local.length];
        return point.x !== previous.x || point.y !== previous.y;
      });
  }
  const at = padPosition(f, p),
    radians = (-padRotation(f, p) * Math.PI) / 180;
  return {
    outer: local.map((v) => ({
      x: at.x + v.x * Math.cos(radians) - v.y * Math.sin(radians),
      y: at.y + v.x * Math.sin(radians) + v.y * Math.cos(radians),
    })),
    holes: [],
  };
}

/** Model/picking polygons for native primitives. Native records remain the
 * Save authority, and copper rules never consume these tessellated contours. */
export function displayPadPolygons(footprint: Footprint, pad: Pad): Polygon[] {
  if (!pad.nativeCustomPad) return [padPolygon(footprint, pad)];
  return nativePadPolygons(footprint, pad);
}

function nativePadPolygons(footprint: Footprint, pad: Pad, curveTolerance?: number): Polygon[] {
  const anchor = nativeCustomPadAnchor(pad);
  const placement = { ...padPosition(footprint, pad), rotation: padRotation(footprint, pad) };
  const geometry: Polygon[] = [];
  let vertices = 0;
  for (const shape of nativeCustomPadGraphics(pad)) {
    const polygons = boundedGraphicPolygons(
      transformPCBGraphic(shape, (point) => footprintPoint(placement, point)),
      curveTolerance,
    );
    if (curveTolerance !== undefined && !polygons.length)
      throw new Error('A native custom pad primitive is below the DRC clipping resolution.');
    for (const polygon of polygons) {
      vertices += polygon.outer.length + polygon.holes.reduce((n, hole) => n + hole.length, 0);
      if (curveTolerance !== undefined && vertices > maxContourVertices)
        throw new Error('Native custom pad exceeds the contour vertex limit.');
      geometry.push(polygon);
    }
  }
  if (anchor && anchor.shape === 'circle' && curveTolerance !== undefined) {
    geometry.push({
      outer: circlePolygon(placement, anchor.size.x / 2, curveTolerance),
      holes: [],
    });
  } else if (anchor) geometry.push(padPolygon(footprint, anchor));
  if (
    curveTolerance !== undefined &&
    geometry.some(({ outer }) => !Clipper.Clipper.Area(integer(outer)))
  )
    throw new Error('A native custom pad contour is below the DRC clipping resolution.');
  return operation(geometry, [], Clipper.ClipType.ctUnion);
}

const nativePadChordTolerance = 0.0005;
export const nativeCustomPadCopperTolerance = 2 * (nativePadChordTolerance + polygonResolution);
/** The physical union in world space. Drill geometry is handled by the caller. */
export function nativeCustomPadCopperPolygons(footprint: Footprint, pad: Pad): Polygon[] {
  const copper = nativePadPolygons(footprint, pad, nativePadChordTolerance);
  if (!copper.length) throw new Error('Native custom pad has no measurable copper contour.');
  return copper;
}

/** Uniform mask/paste apertures for straight chamfers follow KiCad's plot geometry. */
export function offsetPadPolygons(f: Footprint, pad: Pad, margin: number): Polygon[] {
  if (pad.nativeCustomPad) return offsetPolygons(displayPadPolygons(f, pad), margin);
  if (pad.outline) {
    const polygon = padPolygon(f, pad);
    return margin ? offsetPolygons([polygon], margin, 0.0005) : [polygon];
  }
  const straightChamfers = pad.chamfer?.length && !pad.roundrectRatio;
  if (straightChamfers && margin < 0) {
    const size = { x: pad.size.x + 2 * margin, y: pad.size.y + 2 * margin };
    return size.x > 0 && size.y > 0 ? [padPolygon(f, { ...pad, size })] : [];
  }
  return offsetPolygons([padPolygon(f, pad)], margin, straightChamfers ? 0.0005 : undefined);
}
export function worldZones(board: PCB): BoardZone[] {
  return [
    ...board.zones.filter((zone) => zone.outline.length),
    ...board.footprints.flatMap((f) =>
      (f.zones ?? [])
        .filter((zone) => zone.outline.length && pcbZoneLayerActive(board, zone.layer))
        .map((z) => transformPCBZone(z, (p) => footprintPoint(f, p))),
    ),
  ];
}
const zonePolygon = (z: BoardZone): Polygon => ({ outer: z.outline, holes: z.holes ?? [] });
/** The native boundary represented with bounded chords for read-only rule checks. */
export function ruleAreaPolygon(zone: BoardZone, curveTolerance: number): Polygon {
  const polygon = zonePolygon(zone);
  const circle = pcbZoneCircle(zone);
  if (circle)
    return { ...polygon, outer: circlePolygon(circle.center, circle.radius, curveTolerance) };
  if (!zone.nativeOutlineArcs) return polygon;
  const [start, ...vertices] = zone.outline;
  const outer = graphicVertices(
    {
      id: zone.id,
      layer: zone.layer,
      kind: 'polygon',
      width: 0,
      start,
      points: vertices.slice(0, -1),
      end: vertices.at(-1)!,
      polygonArcs: zone.nativeOutlineArcs,
    },
    curveTolerance,
  );
  return { ...polygon, outer };
}
export const pourKeepoutPolygons = (zone: BoardZone): Polygon[] =>
  offset([zonePolygon(zone)], zone.clearance);
export const polygonPath = (polygons: Polygon[]) =>
  polygons
    .flatMap((p) => [p.outer, ...p.holes])
    .map((pts) => `M ${pts.map((p) => `${p.x} ${p.y}`).join(' L ')} Z`)
    .join(' ');

export function pcbZoneOutlineDisplayPath(zone: BoardZone, polygon = polygonPath): string {
  const circle = pcbZoneCircle(zone);
  if (circle) {
    const [{ x, y }, opposite] = zone.outline;
    const { radius } = circle;
    return `M ${x} ${y} A ${radius} ${radius} 0 1 0 ${opposite.x} ${opposite.y} A ${radius} ${radius} 0 1 0 ${x} ${y} Z`;
  }
  if (zone.nativeOutlineArcs) return pcbCurvedPolygonPath(zone.outline, zone.nativeOutlineArcs);
  return zone.outline.length ? polygon([{ outer: zone.outline, holes: zone.holes ?? [] }]) : '';
}

/** A native fill contains its own zero-width bridges around cutouts. SVG
 * even-odd painting preserves them without Boolean analysis or refilling. */
export function pcbSavedZoneDisplayPath(zone: BoardZone): string {
  return polygonPath(
    (zone.filledPolygons ?? []).map(({ points }) => ({ outer: points, holes: [] })),
  );
}

export const defaultCopperFillClearance = 0.25;

/** The same native net classes, conditional precedence and board floors as DRC.
 * Only bounded rule texts cross a worker boundary; this preparation stays local. */
export function preparePCBFillRules(board: PCB, context?: PCBFillRuleContext) {
  const sources = readPCBDesignRuleSourceTexts(board, context?.projectSource, context?.rulesSource);
  if (sources.notes.length)
    throw new Error(`Cannot refill unsupported KiCad clearance rules: ${sources.notes.join(' ')}`);
  const limits = context
    ? loadKiCadPCBDesignRuleLimits(context.projectSource, workbenchPCBDesignRules)
    : { clearance: 0, copperToEdge: 0, copperToHole: 0 };
  const rules = sources.rules.toReversed();
  let work = 0;
  const spend = (amount = 1) => {
    work += amount;
    if (work > 2000000)
      throw new Error('Copper fill clearance rules exceed the geometry work limit.');
  };
  const courtyards = new Map<string, Polygon[]>();
  const operand = (
    type: string,
    netId: string | null,
    geometry?: () => Polygon[],
  ): PCBRuleOperand => {
    const hits = new Map<string, boolean>();
    return {
      type,
      netClass: pcbRuleNetClass(sources, netId),
      intersectsCourtyard(reference) {
        if (!geometry)
          throw new Error('Copper fill does not support courtyard conditions on Zone operands.');
        if (hits.has(reference)) return hits.get(reference)!;
        let target = courtyards.get(reference);
        if (!target) {
          spend(board.footprints.length);
          const footprint = board.footprints.find((item) => item.reference === reference);
          target = footprint
            ? ['F.CrtYd', 'B.CrtYd'].flatMap((layer) => {
                const graphics = footprint.graphics.filter(
                  (graphic) =>
                    graphic.layer === layer &&
                    graphic.kind !== 'text' &&
                    graphic.kind !== 'dimension',
                );
                spend(graphics.length ** 2);
                return graphics.length
                  ? polygonsFromContours(
                      closedGraphicContours(
                        graphics.map((graphic) =>
                          transformPCBGraphic(graphic, (point) => footprintPoint(footprint, point)),
                        ),
                        'courtyard',
                      ),
                    )
                  : [];
              })
            : [];
          courtyards.set(reference, target);
        }
        const hit = geometry().some((shape) =>
          target!.some((boundary) => {
            spend();
            if (
              shape.outer.some((point) => insidePolygon(point, boundary, spend)) ||
              boundary.outer.some((point) => insidePolygon(point, shape, spend))
            )
              return true;
            return polygonEdges(shape).some(([a, b]) =>
              polygonEdges(boundary).some(([c, d]) => {
                spend();
                return segmentDistance(a, b, c, d) <= 1e-10;
              }),
            );
          }),
        );
        hits.set(reference, hit);
        return hit;
      },
    };
  };
  const gap = (a: PCBRuleOperand, b: PCBRuleOperand, minimum: number) => {
    const local = Math.max(a.localClearance ?? 0, b.localClearance ?? 0);
    if (local > 0) return Math.max(minimum, limits.clearance, local);
    const custom = matchingPCBClearanceRule(rules, a, b, spend);
    return Math.max(
      minimum,
      limits.clearance,
      custom
        ? custom.clearance
        : Math.max(
            sources.classes.get(a.netClass)?.clearance ?? 0,
            sources.classes.get(b.netClass)?.clearance ?? 0,
          ),
    );
  };
  return {
    edge: limits.copperToEdge,
    hole: limits.copperToHole,
    zone: (zone: BoardZone) => operand('Zone', zone.netId),
    track: (track: PCB['tracks'][number]) =>
      operand('Track', track.netId, () =>
        strokedPath([track.start, track.end], track.width, false),
      ),
    via: (via: PCB['vias'][number]) =>
      operand('Via', via.netId, () => [{ outer: circlePolygon(via, via.diameter / 2), holes: [] }]),
    pad: (footprint: Footprint, pad: Pad) => ({
      ...operand('Pad', pad.netId, () => [padPolygon(footprint, pad)]),
      localClearance: pcbPadCopperClearance(footprint, pad),
    }),
    gap,
  };
}

/** Enable/fill one board zone and its affected accepted neighbours in one edit.
 * Unfilled peers stay unfilled; changed participation refreshes existing pours.
 */
export function fillCopperZone(
  board: PCB,
  zoneId: string,
  clearance = defaultCopperFillClearance,
  rules?: PCBFillRuleContext,
): PCB {
  const zone = board.zones.find((item) => item.id === zoneId);
  if (!zone || zone.keepout || !zone.layer.endsWith('.Cu'))
    throw new Error('Select an existing board copper zone to fill.');
  if (!zone.outline.length) throw new Error('A zone needs an outline before it can be filled.');
  const enabled = invalidatePCBFill(board, {
    ...board,
    zones: board.zones.map((item) =>
      item.id === zoneId
        ? { ...item, fillEnabled: true, clearance: Math.max(item.clearance, clearance) }
        : item,
    ),
  });
  requireFillNets(enabled);
  const changed = pcbFillInputsChanged(board, enabled);
  // A newly solved zone can expand into a neighbour's previously accepted gap.
  // Re-solve the existing same-layer pours together, never enabling unfilled peers.
  const targets = new Set([
    zoneId,
    ...worldZones(board)
      .filter(
        (item) =>
          !item.keepout &&
          item.fillEnabled !== false &&
          item.filledPolygons !== undefined &&
          (changed || item.layer === zone.layer),
      )
      .map((item) => item.id),
  ]);
  const calculated = calculateCopperPolygons(
    enabled,
    clearance,
    changed ? undefined : new Set([zone.layer as CopperLayer]),
    targets,
    false,
    rules,
  ).polygons;
  return withCopperFills(enabled, calculated, clearance, targets);
}

/** Bounded manual fill calculation. Persist only after the entire operation succeeds. */
export function copperPolygons(
  board: PCB,
  minimumClearance = defaultCopperFillClearance,
  rules?: PCBFillRuleContext,
): Map<string, Polygon[]> {
  return calculateCopperPolygons(board, minimumClearance, undefined, undefined, false, rules)
    .polygons;
}

const strokedTrackObstacles = new WeakMap<object, Map<string, Polygon[]>>();

function foreignTrackObstacle(track: PCB['tracks'][number], clearance: number): Polygon[] {
  const key = String(clearance);
  if (isOwnedProjectNode(track)) {
    const saved = strokedTrackObstacles.get(track)?.get(key);
    if (saved) return saved;
  }
  const polygons = strokedPath(
    [track.start, track.end],
    track.width + 2 * (clearance + clearanceArcGuard),
    false,
    clearanceArcTolerance,
  );
  if (isOwnedProjectNode(track)) {
    const bucket = strokedTrackObstacles.get(track) ?? new Map<string, Polygon[]>();
    if (bucket.size >= 64) bucket.delete(bucket.keys().next().value!);
    bucket.set(key, polygons);
    strokedTrackObstacles.set(track, bucket);
  }
  return polygons;
}

type ZoneFillRecord = {
  polygons: CopperFillPolygon[];
  contours?: NonNullable<BoardZone['filledPolygons']>;
};
type FillMemory = { fingerprint: string; zones: Map<string, ZoneFillRecord> };
// Anchored on the owned input arrays. A matching fingerprint is the exact record
// below, so a later refresh may reuse these polygons only for that same record.
const zoneFillMemory = new WeakMap<object, FillMemory>();

function fillNumber(value: number): number {
  if (!Number.isFinite(value)) throw new Error('Copper fill input is not finite.');
  return Object.is(value, -0) ? 0 : value;
}
const fillPoint = (point: Point) => [fillNumber(point.x), fillNumber(point.y)];

function fillEdge(graphic: BoardLine) {
  if (graphic.layer !== 'Edge.Cuts') return [];
  return [
    {
      kind: graphic.kind ?? 'line',
      start: fillPoint(graphic.start),
      end: fillPoint(graphic.end),
      mid: graphic.mid ? fillPoint(graphic.mid) : null,
      points: graphic.points ? graphic.points.map(fillPoint) : null,
      roundedRectRadius: graphic.roundedRectRadius ?? null,
      polygonArcs: graphic.polygonArcs?.map(({ vertex, mid }) => [vertex, fillPoint(mid)]),
    },
  ];
}

function fillZone(zone: BoardZone) {
  return {
    id: zone.id,
    netId: zone.netId,
    layer: zone.layer,
    outline: zone.outline.map(fillPoint),
    holes: (zone.holes ?? []).map((hole) => hole.map(fillPoint)),
    clearance: fillNumber(zone.clearance),
    minThickness: fillNumber(zone.minThickness),
    thermalGap: fillNumber(zone.thermalGap),
    thermalBridge: fillNumber(zone.thermalBridge),
    priority: zone.priority ?? 0,
    padConnection: zone.padConnection ?? null,
    islandRemovalMode: zone.islandRemovalMode ?? 0,
    islandAreaMin: zone.islandAreaMin ?? defaultPCBIslandAreaMin,
    fillEnabled: zone.fillEnabled !== false,
    keepout: zone.keepout ? { copperpour: zone.keepout.copperpour } : null,
  };
}

function fillPad(pad: Pad) {
  const offset = pad.drillOffset ?? { x: 0, y: 0 };
  return {
    x: fillNumber(pad.x),
    y: fillNumber(pad.y),
    rotation: fillNumber(pad.rotation),
    type: pad.type,
    shape: pad.shape,
    size: fillPoint(pad.size),
    outline: pad.outline?.map(fillPoint),
    trapezoidDelta: pad.trapezoidDelta && fillPoint(pad.trapezoidDelta),
    drill: pad.drill === undefined ? null : fillNumber(pad.drill),
    drillSlot: pad.drillSlot ? [pad.drillSlot.axis, fillNumber(pad.drillSlot.length)] : null,
    netId: pad.netId,
    layers: pad.layers ?? null,
    drillOffset: [fillNumber(offset.x), fillNumber(offset.y)],
    roundrectRatio: pad.shape === 'roundrect' ? (pad.roundrectRatio ?? 0) : null,
    chamferRatio: pad.chamferRatio === undefined ? null : fillNumber(pad.chamferRatio),
    chamfer: pad.chamfer ?? null,
    thermalBridgeAngle: pad.thermalBridgeAngle ?? 90,
    zoneConnect: pad.zoneConnect === undefined ? null : pad.zoneConnect,
    copperClearance: pad.copperClearance,
    thermalGap: pad.thermalGap,
    thermalBridge: pad.thermalBridge,
  };
}

/** Exact inputs of the pour and its island classification. Numbers keep their
 * full values; matching records are identical, not a hash of those values. */
function copperFillFingerprint(
  board: PCB,
  minimumClearance: number,
  rules?: PCBFillRuleContext,
): string {
  return JSON.stringify({
    clearance: fillNumber(minimumClearance),
    rules,
    nets: board.nets,
    layers: board.layers,
    edges: board.graphics.flatMap(fillEdge),
    zones: board.zones.map(fillZone),
    footprints: board.footprints.map((footprint) => ({
      reference: footprint.reference,
      x: fillNumber(footprint.x),
      y: fillNumber(footprint.y),
      rotation: fillNumber(footprint.rotation),
      side: footprint.side,
      zoneConnect: footprint.zoneConnect,
      copperClearance: footprint.copperClearance,
      edges: footprint.graphics.flatMap(fillEdge),
      pads: footprint.pads.map(fillPad),
      zones: (footprint.zones ?? []).map(fillZone),
    })),
    tracks: board.tracks.map((track) => ({
      netId: track.netId,
      layer: track.layer,
      width: fillNumber(track.width),
      start: fillPoint(track.start),
      end: fillPoint(track.end),
    })),
    vias: board.vias.map((via) => ({
      netId: via.netId,
      x: fillNumber(via.x),
      y: fillNumber(via.y),
      diameter: fillNumber(via.diameter),
      drill: fillNumber(via.drill),
    })),
  });
}

function fillAnchors(board: PCB): object[] {
  return [board.tracks, board.vias, board.graphics, board.zones, board.footprints, board.layers];
}

function recallFill(board: PCB, fingerprint: string): FillMemory | undefined {
  for (const anchor of fillAnchors(board)) {
    const memory = zoneFillMemory.get(anchor);
    if (memory?.fingerprint === fingerprint) return memory;
  }
  return undefined;
}

function retainFill(board: PCB, memory: FillMemory) {
  for (const anchor of fillAnchors(board)) zoneFillMemory.set(anchor, memory);
}

const clearanceArcTolerance = 0.001;
// Clipper rounds the arc step count, so the final chord can span 1.5 steps.
// Reserve its sagitta and coordinate rounding before subtracting copper obstacles.
const clearanceArcGuard = 3 * clearanceArcTolerance + 4 * polygonResolution;

function clearanceOffset(polygons: Polygon[], gap: number): Polygon[] {
  return offset(polygons, gap + clearanceArcGuard, clearanceArcTolerance);
}

function circularClearance(at: Point, radius: number): Polygon {
  const enclosingRadius = radius / Math.cos(Math.PI / circleSideCount(radius));
  return { outer: circlePolygon(at, enclosingRadius + 4 * polygonResolution), holes: [] };
}

function polygonArea(polygon: Polygon) {
  const area = (ring: Point[]) => Math.abs(Clipper.Clipper.Area(integer(ring))) / scale ** 2;
  return area(polygon.outer) - polygon.holes.reduce((total, hole) => total + area(hole), 0);
}

function applyCopperIslandPolicy(
  board: PCB,
  zones: readonly BoardZone[],
  fills: Map<string, CopperFillPolygon[]>,
  selected?: ReadonlySet<string>,
) {
  const targets = zones.filter(
    (zone) => (!selected || selected.has(zone.id)) && fills.get(zone.id)?.length,
  );
  if (!targets.length) return;
  const nets = new Set(targets.map((zone) => zone.netId));
  const pads = board.footprints.flatMap((footprint) =>
    footprint.pads.flatMap((pad) => {
      if (!pad.netId || !nets.has(pad.netId)) return [];
      const layers = padCopperLayers(board, footprint, pad);
      return layers.length
        ? [
            {
              id: pad.id,
              netId: pad.netId,
              layers,
              polygon: borrowPCBPadCopperContour(footprint, pad),
            },
          ]
        : [];
    }),
  );
  if (!pads.length) return;
  const vias = board.vias.flatMap((via) =>
    via.netId && nets.has(via.netId)
      ? [
          {
            id: via.id,
            netId: via.netId,
            layers: board.layers,
            polygon: {
              outer: circlePolygon(via, via.diameter / 2),
              holes: [circlePolygon(via, via.drill / 2)],
            },
          },
        ]
      : [],
  );
  const saved = selected ? filledCopperPolygons(board) : undefined;
  const piecesByZone = new Map(
    zones.flatMap((zone) => {
      const netId = zone.netId;
      if (!netId || !nets.has(netId)) return [];
      const polygons =
        !selected || selected.has(zone.id)
          ? (fills.get(zone.id) ?? saved?.get(zone.id))
          : saved?.get(zone.id);
      return [
        [
          zone.id,
          (polygons ?? []).map((polygon, index) => ({
            id: `fill:${zone.id}:${index}`,
            netId,
            layers: [zone.layer],
            polygon,
          })),
        ] as const,
      ];
    }),
  );
  let work = 0;
  const partition = partitionPCBRoutingCopper(
    board.tracks.filter((track) => nets.has(track.netId)),
    [...pads, ...vias, ...[...piecesByZone.values()].flat()],
    (units = 1) => {
      work += units;
      if (work > 2_000_000) throw new Error('Copper island detection exceeds the geometry limit.');
    },
  );
  const connected = new Set(pads.map((pad) => partition.get(pad.id)));
  for (const zone of targets) {
    const pieces = piecesByZone.get(zone.id)!;
    if (!pieces.some((piece) => connected.has(partition.get(piece.id)))) continue;
    fills.set(
      zone.id,
      pieces.flatMap((piece) => {
        if (connected.has(partition.get(piece.id))) return [piece.polygon];
        const retain =
          zone.islandRemovalMode === 1 ||
          (zone.islandRemovalMode === 2 &&
            polygonArea(piece.polygon) >= (zone.islandAreaMin ?? defaultPCBIslandAreaMin));
        return retain ? [{ ...piece.polygon, island: true }] : [];
      }),
    );
  }
}

function calculateCopperPolygons(
  board: PCB,
  minimumClearance: number,
  affectedLayers?: ReadonlySet<CopperLayer>,
  targets?: ReadonlySet<string>,
  reuse = false,
  rules?: PCBFillRuleContext,
): {
  polygons: Map<string, CopperFillPolygon[]>;
  reusedContours: Map<string, NonNullable<BoardZone['filledPolygons']>>;
  stored?: Map<string, ZoneFillRecord>;
} {
  if (hasNativePCBTeardrops(board))
    throw new Error('Copper refill on boards with native teardrops requires KiCad.');
  requireSupportedPCBCopper(board, 'Copper refill');
  const nativeHatch = (zone: BoardZone) =>
    zone.outline.length && zone.fillEnabled !== false && (zone.hatchPosition || zone.hatchFill);
  if (
    board.zones.some(nativeHatch) ||
    board.footprints.some((footprint) => footprint.zones?.some(nativeHatch))
  )
    throw new Error('Copper refill for native hatch settings requires KiCad.');
  if (board.tuningPatterns?.length)
    throw new Error('Copper refill on boards with native tuning patterns requires KiCad.');
  const empty = {
    polygons: new Map<string, CopperFillPolygon[]>(),
    reusedContours: new Map<string, NonNullable<BoardZone['filledPolygons']>>(),
  };
  if (!Number.isFinite(minimumClearance) || minimumClearance < 0.0001 || minimumClearance > 1000)
    throw new Error('Copper fill clearance must be from 0.0001 to 1000 mm.');
  const zones = worldZones(board).filter((z) => z.layer.endsWith('.Cu'));
  const fills = zones.filter((z) => !z.keepout && z.fillEnabled !== false);
  const result = new Map<string, CopperFillPolygon[]>();
  const reusedContours = new Map<string, NonNullable<BoardZone['filledPolygons']>>();
  const known = new Map<string, CopperFillPolygon[]>();
  const fresh = new Set<string>();
  if (!fills.length) return empty;
  const complexity =
    zones.reduce((n, z) => n + z.outline.length + (z.holes ?? []).flat().length, 0) +
    board.tracks.length * 8 +
    board.vias.length * 24 +
    board.footprints.reduce((n, f) => n + f.pads.length * 36, 0);
  if (fills.length > 64 || complexity * fills.length > 1500000)
    throw new Error(
      'Copper fill exceeds the geometry limit. Reduce zone complexity or refill the exported board in KiCad.',
    );
  if (affectedLayers && !affectedLayers.size) return empty;
  const ordered = [...fills].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const active = (zone: BoardZone) =>
    !affectedLayers || affectedLayers.has(zone.layer as CopperLayer);
  const fingerprint = reuse ? copperFillFingerprint(board, minimumClearance, rules) : undefined;
  const remembered = fingerprint ? recallFill(board, fingerprint) : undefined;
  const reusable =
    remembered &&
    ordered.every((zone) => {
      if (!active(zone)) return true;
      const record = remembered.zones.get(zone.id);
      const restores = !targets || targets.has(zone.id);
      return !!record && (!restores || !!record.contours);
    })
      ? remembered
      : undefined;
  if (reusable) {
    for (const zone of ordered) {
      if (!active(zone) || (targets && !targets.has(zone.id))) continue;
      const record = reusable.zones.get(zone.id);
      if (!record?.contours) throw new Error('Copper fill reuse is missing its saved contours.');
      reusedContours.set(zone.id, record.contours);
    }
    return { polygons: result, reusedContours };
  }
  const boundary = boardPolygons(board);
  const ruleLimits = preparePCBFillRules(board, rules);
  const tracks = board.tracks.map((track) => ({ track, operand: ruleLimits.track(track) }));
  const vias = board.vias.map((via) => ({ via, operand: ruleLimits.via(via) }));
  const pads = board.footprints.flatMap((f) =>
    f.pads.map((p) => ({ f, p, shape: padPolygon(f, p), operand: ruleLimits.pad(f, p) })),
  );
  const drills = [
    ...board.vias.map((v) => ({
      netId: v.netId,
      polygon: { outer: circlePolygon(v, v.drill / 2), holes: [] },
    })),
    ...pads
      .filter(({ p }) => p.drill)
      .map(({ f, p }) => ({
        netId: p.type === 'thru_hole' ? p.netId : null,
        polygon: { outer: padDrillPolygon(f, p), holes: [] },
      })),
  ];
  const stored = fingerprint
    ? { fingerprint, zones: new Map<string, ZoneFillRecord>() }
    : undefined;
  for (const z of ordered) {
    if (!active(z)) continue;
    if (fingerprint && (!targets || targets.has(z.id))) fresh.add(z.id);
    // Explicit zone minima remain floors; native rules apply to each foreign pair.
    const clearance = Math.max(z.clearance, minimumClearance);
    const zoneOperand = ruleLimits.zone(z);
    let region = intersectPolygons(
      [zonePolygon(z)],
      offset(boundary, -Math.max(clearance, ruleLimits.edge)),
    );
    const blocked: Polygon[] = [];
    for (const other of zones) {
      if (other.id === z.id || other.layer !== z.layer) continue;
      if (other.keepout?.copperpour) blocked.push(...pourKeepoutPolygons(other));
      else if (
        !other.keepout &&
        other.fillEnabled !== false &&
        other.netId !== z.netId &&
        ordered.indexOf(other) < ordered.indexOf(z)
      )
        blocked.push(
          ...clearanceOffset(
            result.get(other.id) ?? known.get(other.id) ?? [],
            ruleLimits.gap(
              zoneOperand,
              ruleLimits.zone(other),
              Math.max(clearance, other.clearance),
            ),
          ),
        );
    }
    for (const { track, operand } of tracks)
      if (track.layer === z.layer && track.netId !== z.netId)
        blocked.push(
          ...foreignTrackObstacle(track, ruleLimits.gap(zoneOperand, operand, clearance)),
        );
    for (const { via, operand } of vias)
      if (via.netId !== z.netId)
        blocked.push(
          circularClearance(
            via,
            via.diameter / 2 + ruleLimits.gap(zoneOperand, operand, clearance),
          ),
        );
    const thermal: Polygon[] = [];
    for (const { f, p, shape, operand } of pads) {
      const present =
        p.type !== 'smd' ||
        (p.layers
          ? p.layers.includes('*.Cu') || p.layers.includes(z.layer)
          : z.layer === (f.side === 'front' ? 'F.Cu' : 'B.Cu'));
      if (!present) continue;
      const connection = pcbPadZoneConnection(f, p, z);
      if (!p.netId || p.netId !== z.netId || connection === 'none' || p.type === 'np_thru_hole') {
        const padClearance =
          p.netId === z.netId && p.type !== 'np_thru_hole'
            ? Math.max(clearance, pcbPadCopperClearance(f, p) ?? 0)
            : ruleLimits.gap(zoneOperand, operand, clearance);
        if (p.shape === 'circle')
          blocked.push(circularClearance(padPosition(f, p), p.size.x / 2 + padClearance));
        else {
          const chordLoss = padCornerRadius(p) * (1 - Math.cos(padCornerStep / 2));
          blocked.push(...clearanceOffset([shape], padClearance + chordLoss));
        }
      } else if (connection === 'thermal') {
        const thermalGap = p.thermalGap || z.thermalGap;
        const thermalBridge = Math.max(p.thermalBridge || z.thermalBridge, z.minThickness);
        const gap = offset([shape], thermalGap);
        const at = padPosition(f, p),
          r = padReach(p) + thermalGap + thermalBridge;
        const spokes = Array.from({ length: 2 }, (_, i) => {
          const a = (((p.thermalBridgeAngle ?? 90) - padRotation(f, p) + i * 90) * Math.PI) / 180;
          return strokePolygon(
            [
              { x: at.x - r * Math.cos(a), y: at.y - r * Math.sin(a) },
              { x: at.x + r * Math.cos(a), y: at.y + r * Math.sin(a) },
            ],
            thermalBridge,
          );
        }).flat();
        thermal.push(...subtractPolygons(gap, spokes));
      }
    }
    // KiCad stores connected plated drills separately from zone contours.
    const holes = drills
      .filter(({ netId }) => !netId || netId !== z.netId)
      .flatMap(({ polygon }) =>
        ruleLimits.hole > 0 ? clearanceOffset([polygon], ruleLimits.hole) : [polygon],
      );
    region = subtractPolygons(region, [...blocked, ...thermal, ...holes]);
    // Remove narrow webs and undersized remnants before expanding the surviving cores.
    const radius = z.minThickness / 2;
    const cores = offset(region, -radius).filter(({ outer }) => {
      let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
      for (const { x, y } of outer) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      return Math.max(maxX - minX, maxY - minY) + polygonResolution >= z.minThickness;
    });
    const opened = offset(cores, radius);
    // Rounded offset approximations must not add copper outside any original constraint.
    region = intersectPolygons(opened, region);
    result.set(z.id, region);
    known.set(z.id, region);
    stored?.zones.set(z.id, { polygons: region });
  }
  const islandFills = new Map(result);
  for (const [id, polygons] of known) if (!islandFills.has(id)) islandFills.set(id, polygons);
  applyCopperIslandPolicy(board, fills, islandFills, reuse ? fresh : targets);
  const polygons = reuse
    ? new Map([...fresh].map((id) => [id, islandFills.get(id)!] as const))
    : islandFills;
  if (stored) retainFill(board, stored);
  return { polygons, reusedContours, stored: stored?.zones };
}

type SavedContours = NonNullable<BoardZone['filledPolygons']>;

function decodeSavedCopper(contours: SavedContours): Polygon[] {
  const subject = contours.map((p) => ({ outer: p.points, holes: [] }));
  return operation(subject, [], Clipper.ClipType.ctUnion);
}

function readSavedCopper(
  board: PCB,
  decode: (contours: SavedContours) => Polygon[],
): Map<string, Polygon[]> {
  const result = new Map<string, Polygon[]>();
  let vertices = 0;
  for (const z of worldZones(board)) {
    const contours = z.filledPolygons;
    if (!z.layer.endsWith('.Cu') || z.keepout || z.fillEnabled === false || contours === undefined)
      continue;
    vertices += contours.reduce((n, p) => n + p.points.length, 0);
    if (vertices > 60000)
      throw new Error('Saved copper fills exceed the 60000-vertex board limit.');
    result.set(z.id, decode(contours));
  }
  return result;
}

/** Read saved contours, including KiCad's zero-width bridges around holes.
 * Public geometry remains independently mutable. */
export function filledCopperPolygons(board: PCB): Map<string, Polygon[]> {
  return readSavedCopper(board, decodeSavedCopper);
}

const ownedSavedCopper = new WeakMap<SavedContours, Polygon[]>();

/** Internal read-only geometry shared by DRC and connectivity. */
export function borrowFilledCopperPolygons(board: PCB): Map<string, Polygon[]> {
  if (!isOwnedPCB(board)) return filledCopperPolygons(board);
  const pending = new Map<SavedContours, Polygon[]>();
  const result = readSavedCopper(board, (contours) => {
    // Footprint-local contours are transformed for this call, which gives them
    // new arrays and keeps them out of the board-level cache.
    if (!isOwnedProjectNode(contours)) return decodeSavedCopper(contours);
    const saved = ownedSavedCopper.get(contours) ?? pending.get(contours);
    if (saved) return saved;
    const polygons = ownProjectData(decodeSavedCopper(contours));
    pending.set(contours, polygons);
    return polygons;
  });
  for (const [contours, polygons] of pending) ownedSavedCopper.set(contours, polygons);
  return result;
}

/** Fracture holes into a native-style weakly simple contour using doubled bridges.
 * A horizontal ray reaches the nearest already integrated boundary, never copper
 * across a hole. Clipper-normalized disjoint holes are joined left to right. */
export function copperFillContour(polygon: Polygon): Point[] {
  const positive = (points: Point[]) => Clipper.Clipper.Orientation(integer(points));
  let contour = positive(polygon.outer) ? [...polygon.outer] : [...polygon.outer].reverse();
  const holes = polygon.holes
    .map((ring) => {
      const points = positive(ring) ? [...ring].reverse() : [...ring];
      let first = 0;
      for (let i = 1; i < points.length; i++)
        if (
          points[i].x < points[first].x ||
          (points[i].x === points[first].x && points[i].y < points[first].y)
        )
          first = i;
      return [...points.slice(first), ...points.slice(0, first)];
    })
    .sort((a, b) => a[0].x - b[0].x || a[0].y - b[0].y);
  let work = 0;
  for (const hole of holes) {
    const h = hole[0];
    let bridge = -1,
      x = -Infinity;
    for (let i = 0; i < contour.length; i++) {
      if (++work > 3000000) throw new Error('Copper holes exceed the fill complexity limit.');
      const a = contour[i],
        b = contour[(i + 1) % contour.length];
      if (a.y > h.y === b.y > h.y) continue;
      const hit = a.x + ((h.y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (hit <= h.x && hit > x) {
        x = hit;
        bridge = i;
      }
    }
    if (bridge < 0) throw new Error('Copper hole could not be joined to its boundary.');
    const at = { x: Number(x.toFixed(6)), y: h.y };
    const same = (p: Point) => p.x === at.x && p.y === at.y;
    if (same(contour[bridge])) {
      /* Reuse this vertex. */
    } else if (same(contour[(bridge + 1) % contour.length])) bridge = (bridge + 1) % contour.length;
    else {
      contour.splice(bridge + 1, 0, at);
      bridge++;
    }
    contour = [
      ...contour.slice(0, bridge + 1),
      ...hole,
      h,
      contour[bridge],
      ...contour.slice(bridge + 1),
    ];
  }
  return contour;
}

function requireFillNets(board: PCB): void {
  const zones = worldZones(board).filter(
    (z) => z.layer.endsWith('.Cu') && !z.keepout && z.fillEnabled !== false,
  );
  if (zones.some(isUnassignedSavedCopperZone))
    throw new Error('Copper refill on boards with unassigned native copper fills requires KiCad.');
  if (zones.some((z) => !z.netId))
    throw new Error('Assign a net to each copper zone before filling.');
}

/** One atomic board replacement: native-style saved fills, in each owner's coordinates. */
export function fillCopperZones(
  board: PCB,
  minimumClearance = defaultCopperFillClearance,
  rules?: PCBFillRuleContext,
): PCB {
  requireFillNets(board);
  const calculated = calculateCopperPolygons(
    board,
    minimumClearance,
    undefined,
    undefined,
    false,
    rules,
  ).polygons;
  return withCopperFills(board, calculated, minimumClearance);
}

function withCopperFills(
  board: PCB,
  calculated: ReadonlyMap<string, CopperFillPolygon[]>,
  minimumClearance: number,
  targets?: ReadonlySet<string>,
): PCB {
  let vertices = 0;
  const fill = (z: BoardZone, local = (p: Point) => p): BoardZone => {
    const polygons = !targets || targets.has(z.id) ? calculated.get(z.id) : undefined;
    const result = polygons
      ? {
          ...z,
          clearance: Math.max(z.clearance, minimumClearance),
          filledPolygons: polygons.map((p) => ({
            points: copperFillContour(p).map(local),
            ...(p.island ? { island: true as const } : {}),
          })),
        }
      : z;
    vertices += (result.filledPolygons ?? []).reduce((n, p) => n + p.points.length, 0);
    if (vertices > 60000) throw new Error('Copper fill exceeds the 60000-vertex board limit.');
    return result;
  };
  return {
    ...board,
    zones: board.zones.map((z) => fill(z)),
    footprints: board.footprints.map((f) => {
      if (!f.zones) return f;
      const zones = f.zones.map((z) =>
        fill(z, (p) =>
          footprintPoint(
            { ...f, x: 0, y: 0, rotation: -f.rotation },
            { x: p.x - f.x, y: p.y - f.y },
          ),
        ),
      );
      return zones.every((zone, index) => zone === f.zones![index]) ? f : { ...f, zones };
    }),
  };
}

// A refreshed immutable preview can pass through Core without calculating the
// same contours twice. Neither abandoned poses nor older undo bases are retained.
const refreshedFillBases = new WeakMap<PCB, { basis: WeakRef<PCB>; rules?: PCBFillRuleContext }>();
const localZones = (board: PCB) => [
  ...board.zones,
  ...board.footprints.flatMap((footprint) => footprint.zones ?? []),
];

/** Other-layer pours are independent of a track-only edit. This shortcut is
 * private to internally owned boards; external candidates use the full fill. */
function changedTrackLayers(previous: PCB, next: PCB): ReadonlySet<CopperLayer> | undefined {
  if (
    !isOwnedPCB(previous) ||
    !isOwnedPCB(next) ||
    pcbFillInputsChanged({ ...previous, tracks: next.tracks }, next)
  )
    return undefined;
  const remaining = new Map(previous.tracks.map((track) => [track.id, track]));
  const changed = new Set<CopperLayer>();
  for (const track of next.tracks) {
    const prior = remaining.get(track.id);
    remaining.delete(track.id);
    if (prior && samePCBTrackCopper(prior, track)) continue;
    changed.add(track.layer);
    if (prior) changed.add(prior.layer);
  }
  for (const track of remaining.values()) changed.add(track.layer);
  return changed;
}

/** Refresh active saved pours for a copper edit, without enabling other zones.
 * Geometry, effective rules and contours form one complete board candidate.
 * Explicit native contour edits with unchanged copper inputs stay authoritative. */
export function refreshPCBFill(
  previous: PCB,
  next: PCB,
  reuseOwned = true,
  rules?: PCBFillRuleContext,
  previousRules = rules,
): PCB {
  const rulesChanged =
    !samePCBFillRules(previousRules, rules) ||
    (!!rules?.projectSource && JSON.stringify(previous.nets) !== JSON.stringify(next.nets)) ||
    (!!rules?.rulesSource &&
      JSON.stringify(previous.footprints.map((f) => f.reference)) !==
        JSON.stringify(next.footprints.map((f) => f.reference)));
  const prepared = refreshedFillBases.get(next);
  if (
    (!rulesChanged && previous === next) ||
    previous.id !== next.id ||
    (!rulesChanged &&
      prepared?.basis.deref() === previous &&
      samePCBFillRules(prepared.rules, rules))
  )
    return next;
  const previousZones = localZones(previous);
  const nextZones = localZones(next);
  if (
    (!previousZones.some((zone) => zone.filledPolygons !== undefined) &&
      !nextZones.some((zone) => zone.filledPolygons !== undefined)) ||
    (!rulesChanged && !pcbFillInputsChanged(previous, next))
  )
    return next;
  const previouslyFilled = new Set(
    previousZones.filter((zone) => zone.filledPolygons !== undefined).map((zone) => zone.id),
  );
  const targets = nextZones.filter(
    (zone) =>
      zone.layer.endsWith('.Cu') &&
      !zone.keepout &&
      zone.fillEnabled !== false &&
      (previouslyFilled.has(zone.id) || zone.filledPolygons !== undefined),
  );
  if (targets.some((zone) => !zone.netId))
    throw new Error('Assign a net to each active copper zone before updating its fill.');
  const invalidated = invalidatePCBFill(previous, next);
  if (!targets.length) return invalidated;
  const targetIds = new Set(targets.map((zone) => zone.id));
  const affectedLayers = rulesChanged ? undefined : changedTrackLayers(previous, next);
  const previousById = new Map(previousZones.map((zone) => [zone.id, zone]));
  const nextById = new Map(nextZones.map((zone) => [zone.id, zone]));
  // Retain the default for native zero and positive fine-clearance zone values.
  // Project and pair-specific native minima are applied separately by the solver.
  const effectiveZone = (zone: BoardZone) => {
    if (!targetIds.has(zone.id)) return zone;
    if (affectedLayers && !affectedLayers.has(zone.layer as CopperLayer)) {
      // Pre-cleared previews retain their exact accepted contours on layers
      // whose copper inputs did not change. Current explicit contours win.
      const saved =
        nextById.get(zone.id)?.filledPolygons ?? previousById.get(zone.id)?.filledPolygons;
      return saved === undefined ? zone : { ...zone, filledPolygons: saved };
    }
    return zone.clearance === 0 ? { ...zone, clearance: defaultCopperFillClearance } : zone;
  };
  const effective = {
    ...invalidated,
    zones: invalidated.zones.map(effectiveZone),
    footprints: invalidated.footprints.map((footprint) => {
      if (!footprint.zones) return footprint;
      const zones = footprint.zones.map(effectiveZone);
      return zones.every((zone, index) => zone === footprint.zones![index])
        ? footprint
        : { ...footprint, zones };
    }),
  };
  const minimumClearance = 0.0001;
  const reuse = reuseOwned && !affectedLayers && isOwnedPCB(previous) && isOwnedPCB(next);
  const calculated = calculateCopperPolygons(
    effective,
    minimumClearance,
    affectedLayers,
    targetIds,
    reuse,
    rules,
  );
  if (reuse && calculated.reusedContours.size) {
    const restore = (zone: BoardZone) => {
      const contours = calculated.reusedContours.get(zone.id);
      return contours ? { ...zone, filledPolygons: contours } : zone;
    };
    effective.zones = effective.zones.map(restore);
    effective.footprints = effective.footprints.map((footprint) => {
      if (!footprint.zones) return footprint;
      const zones = footprint.zones.map(restore);
      return zones.every((zone, index) => zone === footprint.zones![index])
        ? footprint
        : { ...footprint, zones };
    });
  }
  const writeTargets = reuse
    ? new Set([...targetIds].filter((id) => !calculated.reusedContours.has(id)))
    : targetIds;
  const refreshed = withCopperFills(effective, calculated.polygons, minimumClearance, writeTargets);
  if (!isOwnedPCB(previous)) return refreshed;
  const owned = ownProjectData(refreshed, previous);
  if (reuse && calculated.stored)
    for (const zone of localZones(owned)) {
      const record = calculated.stored.get(zone.id);
      if (!record || !calculated.polygons.has(zone.id) || !zone.filledPolygons) continue;
      record.contours = zone.filledPolygons;
    }
  refreshedFillBases.set(owned, {
    basis: new WeakRef(previous),
    rules: rules ? { ...rules } : undefined,
  });
  return owned;
}
