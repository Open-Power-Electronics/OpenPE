import Clipper from 'clipper-lib';
import type { Point } from './circuit';
import type { BoardLine, BoardZone, CopperLayer, Footprint, Pad, PCB } from './pcb';
import { pcbArc, transformPCBGraphic, transformPCBZone } from './pcb-geometry';
import { invalidatePCBFill, pcbFillInputsChanged, samePCBTrackCopper } from './pcb';
import { footprintPoint, padDrillPosition, padPosition, padRotation } from './pcb-layout';
import { isOwnedPCB, ownProjectData } from './immutable-project';
import { padCopperLayers, partitionPCBRoutingCopper } from './pcb-connectivity';
import { borrowPCBPadCopperContour } from './pcb-pad-contour';

export type Polygon = { outer: Point[]; holes: Point[][] };
type CopperFillPolygon = Polygon & { island?: true };
export const polygonResolution = 0.0001; // Millimetres per integer clipping coordinate.
const scale = 1 / polygonResolution;
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
export function circlePolygon(at: Point, radius: number): Point[] {
  const count = circleSideCount(radius);
  return Array.from({ length: count }, (_, i) => ({
    x: at.x + radius * Math.cos((i * Math.PI * 2) / count),
    y: at.y + radius * Math.sin((i * Math.PI * 2) / count),
  }));
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
export function graphicVertices(g: BoardLine): Point[] {
  if (g.kind === 'circle')
    return circlePolygon(g.start, Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y));
  if (g.kind === 'arc') {
    const arc = pcbArc(g);
    if (!arc) throw new Error('The board outline contains a degenerate arc.');
    const count = Math.min(
      512,
      Math.max(8, Math.ceil(Math.abs(arc.delta) * Math.sqrt(arc.radius / 0.01))),
    );
    return Array.from({ length: count + 1 }, (_, i) => ({
      x: arc.center.x + arc.radius * Math.cos(arc.start + (arc.delta * i) / count),
      y: arc.center.y + arc.radius * Math.sin(arc.start + (arc.delta * i) / count),
    }));
  }
  return [g.start, ...(g.points ?? []), g.end];
}
/** Native physical artwork includes both filled interiors and their stroke.
 * Text/dimensions have separate presentation paths; zero-width open artwork
 * contributes no physical area. Returned points never alias native records.
 */
export function graphicPolygons(g: BoardLine): Polygon[] {
  if (g.text || g.dimension) return [];
  const points = graphicVertices(g);
  const closed = g.kind === 'circle' || g.kind === 'polygon';
  if (!closed || !g.fill) return strokedPath(points, g.width, closed);
  const interior = [{ outer: points.map((point) => ({ ...point })), holes: [] }];
  return g.width > 0 ? offset(interior, g.width / 2) : interior;
}
/** An empty Model canvas has no board surface; actual artwork still requires a valid outline. */
export function modelBoardPolygons(board: PCB): Polygon[] {
  if (
    !board.footprints.length &&
    !board.tracks.length &&
    !board.vias.length &&
    !board.graphics.length &&
    !board.zones.length
  )
    return [];
  return boardPolygons(board);
}

/** Closed Edge.Cuts loops, including footprint cutouts. Never invent a board rectangle. */
export function boardPolygons(board: PCB): Polygon[] {
  const edges = [
    ...board.graphics.filter((g) => g.layer === 'Edge.Cuts'),
    ...board.footprints.flatMap((f) =>
      f.graphics
        .filter((g) => g.layer === 'Edge.Cuts')
        .map((g) => transformPCBGraphic(g, (p) => footprintPoint(f, p))),
    ),
  ];
  if (!edges.length) throw new Error('Draw a closed board outline before previewing copper or 3D.');
  const result = polygonsFromContours(closedGraphicContours(edges, 'board outline'));
  if (!result.length) throw new Error('The board outline does not enclose a positive area.');
  return result;
}

/** Join line and arc endpoints; native circles and polygons are already closed. */
export function closedGraphicContours(edges: BoardLine[], context: string): Point[][] {
  if (edges.length > 5000) throw new Error(`The ${context} exceeds the graphic limit.`);
  const loops: Point[][] = [],
    segments: Point[][] = [];
  let vertexCount = 0;
  for (const g of edges) {
    if (g.kind === 'text' || g.kind === 'dimension')
      throw new Error(`Unsupported ${context} geometry.`);
    const pts = graphicVertices(g);
    vertexCount += pts.length;
    if (vertexCount > 20000) throw new Error(`The ${context} exceeds the geometry limit.`);
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
  if (p.shape === 'circle') local = circlePolygon({ x: 0, y: 0 }, w / 2);
  else {
    const radius = padCornerRadius(p);
    const corners = [
      { x: -1, y: -1, name: 'top_left' },
      { x: 1, y: -1, name: 'top_right' },
      { x: 1, y: 1, name: 'bottom_right' },
      { x: -1, y: 1, name: 'bottom_left' },
    ] as const;
    local = corners.flatMap((c, i) => {
      const cut = p.chamfer?.includes(c.name) ? Math.min(w, h) * (p.chamferRatio ?? 0) : 0;
      const start = Math.PI + (i * Math.PI) / 2;
      if (cut)
        return [
          { x: c.x * (w / 2 - (i % 2 ? 0 : cut)), y: c.y * (h / 2 - (i % 2 ? cut : 0)) },
          { x: c.x * (w / 2 - (i % 2 ? cut : 0)), y: c.y * (h / 2 - (i % 2 ? 0 : cut)) },
        ];
      if (!radius) return [{ x: (c.x * w) / 2, y: (c.y * h) / 2 }];
      return Array.from({ length: padCornerSegments + 1 }, (_, j) => ({
        x: c.x * (w / 2 - radius) + radius * Math.cos(start + j * padCornerStep),
        y: c.y * (h / 2 - radius) + radius * Math.sin(start + j * padCornerStep),
      }));
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
export function worldZones(board: PCB): BoardZone[] {
  return [
    ...board.zones,
    ...board.footprints.flatMap((f) =>
      (f.zones ?? []).map((z) => transformPCBZone(z, (p) => footprintPoint(f, p))),
    ),
  ];
}
const zonePolygon = (z: BoardZone): Polygon => ({ outer: z.outline, holes: z.holes ?? [] });
export const pourKeepoutPolygons = (zone: BoardZone): Polygon[] =>
  offset([zonePolygon(zone)], zone.clearance);
export const polygonPath = (polygons: Polygon[]) =>
  polygons
    .flatMap((p) => [p.outer, ...p.holes])
    .map((pts) => `M ${pts.map((p) => `${p.x} ${p.y}`).join(' L ')} Z`)
    .join(' ');

export const defaultCopperFillClearance = 0.25;

/** Enable and fill one board zone as one edit, retaining other zones' saved state.
 * Changed zone participation invalidates affected fills before calculation.
 */
export function fillCopperZone(
  board: PCB,
  zoneId: string,
  clearance = defaultCopperFillClearance,
): PCB {
  const zone = board.zones.find((item) => item.id === zoneId);
  if (!zone || zone.keepout || !zone.layer.endsWith('.Cu'))
    throw new Error('Select an existing board copper zone to fill.');
  const enabled = invalidatePCBFill(board, {
    ...board,
    zones: board.zones.map((item) =>
      item.id === zoneId
        ? { ...item, fillEnabled: true, clearance: Math.max(item.clearance, clearance) }
        : item,
    ),
  });
  requireFillNets(enabled);
  const targets = new Set([zoneId]);
  const calculated = calculateCopperPolygons(enabled, clearance, undefined, targets);
  return withCopperFills(enabled, calculated, clearance, targets);
}

/** Bounded manual fill calculation. Persist only after the entire operation succeeds. */
export function copperPolygons(
  board: PCB,
  minimumClearance = defaultCopperFillClearance,
): Map<string, Polygon[]> {
  return calculateCopperPolygons(board, minimumClearance);
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

const hasIslandPolicy = (zone: BoardZone) =>
  (zone.islandRemovalMode ?? 0) === 0 || zone.islandRemovalMode === 1;

function applyCopperIslandPolicy(
  board: PCB,
  zones: readonly BoardZone[],
  fills: Map<string, CopperFillPolygon[]>,
  selected?: ReadonlySet<string>,
) {
  const targets = zones.filter(
    (zone) =>
      (!selected || selected.has(zone.id)) && hasIslandPolicy(zone) && fills.get(zone.id)?.length,
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
        return zone.islandRemovalMode === 1 ? [{ ...piece.polygon, island: true }] : [];
      }),
    );
  }
}

function calculateCopperPolygons(
  board: PCB,
  minimumClearance: number,
  affectedLayers?: ReadonlySet<CopperLayer>,
  targets?: ReadonlySet<string>,
): Map<string, CopperFillPolygon[]> {
  if (!Number.isFinite(minimumClearance) || minimumClearance < 0.0001 || minimumClearance > 1000)
    throw new Error('Copper fill clearance must be from 0.0001 to 1000 mm.');
  const zones = worldZones(board).filter((z) => z.layer.endsWith('.Cu'));
  const fills = zones.filter((z) => !z.keepout && z.fillEnabled !== false);
  const result = new Map<string, CopperFillPolygon[]>();
  if (!fills.length) return result;
  const complexity =
    zones.reduce((n, z) => n + z.outline.length + (z.holes ?? []).flat().length, 0) +
    board.tracks.length * 8 +
    board.vias.length * 24 +
    board.footprints.reduce((n, f) => n + f.pads.length * 36, 0);
  if (fills.length > 64 || complexity * fills.length > 1500000)
    throw new Error(
      'Copper fill exceeds the geometry limit. Reduce zone complexity or refill the exported board in KiCad.',
    );
  if (affectedLayers && !affectedLayers.size) return result;
  const boundary = boardPolygons(board);
  const pads = board.footprints.flatMap((f) =>
    f.pads.map((p) => ({ f, p, shape: padPolygon(f, p) })),
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
        polygon: { outer: circlePolygon(padDrillPosition(f, p), p.drill! / 2), holes: [] },
      })),
  ];
  const ordered = [...fills].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  for (const z of ordered) {
    if (affectedLayers && !affectedLayers.has(z.layer as CopperLayer)) continue;
    // Native zero clearance can inherit KiCad rules we do not import. Always
    // apply the explicit fill minimum, measured from the copper's outer edge.
    const clearance = Math.max(z.clearance, minimumClearance);
    let region = intersectPolygons([zonePolygon(z)], offset(boundary, -clearance));
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
          ...clearanceOffset(result.get(other.id) ?? [], Math.max(clearance, other.clearance)),
        );
    }
    for (const track of board.tracks)
      if (track.layer === z.layer && track.netId !== z.netId)
        blocked.push(
          ...strokedPath(
            [track.start, track.end],
            track.width + 2 * (clearance + clearanceArcGuard),
            false,
            clearanceArcTolerance,
          ),
        );
    for (const via of board.vias)
      if (via.netId !== z.netId) blocked.push(circularClearance(via, via.diameter / 2 + clearance));
    const thermal: Polygon[] = [];
    for (const { f, p, shape } of pads) {
      const present =
        p.type !== 'smd' ||
        (p.layers
          ? p.layers.includes('*.Cu') || p.layers.includes(z.layer)
          : z.layer === (f.side === 'front' ? 'F.Cu' : 'B.Cu'));
      if (!present) continue;
      const connection =
        p.zoneConnect === 0
          ? 'none'
          : p.zoneConnect === 2
            ? 'solid'
            : p.zoneConnect === 1
              ? 'thermal'
              : p.zoneConnect === 3 || z.padConnection === 'thru_hole_only'
                ? p.type === 'thru_hole'
                  ? 'thermal'
                  : 'solid'
                : z.padConnection === 'no'
                  ? 'none'
                  : z.padConnection === 'yes'
                    ? 'solid'
                    : 'thermal';
      if (!p.netId || p.netId !== z.netId || connection === 'none' || p.type === 'np_thru_hole') {
        if (p.shape === 'circle')
          blocked.push(circularClearance(padPosition(f, p), p.size.x / 2 + clearance));
        else {
          const chordLoss = padCornerRadius(p) * (1 - Math.cos(padCornerStep / 2));
          blocked.push(...clearanceOffset([shape], clearance + chordLoss));
        }
      } else if (connection === 'thermal') {
        const gap = offset([shape], z.thermalGap);
        const at = padPosition(f, p),
          r = Math.hypot(p.size.x, p.size.y) / 2 + z.thermalGap + z.thermalBridge;
        const spokes = Array.from({ length: 2 }, (_, i) => {
          const a = (((p.thermalBridgeAngle ?? 90) - padRotation(f, p) + i * 90) * Math.PI) / 180;
          return strokePolygon(
            [
              { x: at.x - r * Math.cos(a), y: at.y - r * Math.sin(a) },
              { x: at.x + r * Math.cos(a), y: at.y + r * Math.sin(a) },
            ],
            Math.max(0.0001, z.thermalBridge),
          );
        }).flat();
        thermal.push(...subtractPolygons(gap, spokes));
      }
    }
    // KiCad stores connected plated drills separately from zone contours.
    const holes = drills
      .filter(({ netId }) => !netId || netId !== z.netId)
      .map(({ polygon }) => polygon);
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
  }
  applyCopperIslandPolicy(board, fills, result, targets);
  return result;
}

/** Read saved contours, including KiCad's zero-width bridges around holes.
 * Never substitute a zone outline or recalculate copper merely to display it. */
export function filledCopperPolygons(board: PCB): Map<string, Polygon[]> {
  const result = new Map<string, Polygon[]>();
  let vertices = 0;
  for (const z of worldZones(board)) {
    if (
      !z.layer.endsWith('.Cu') ||
      z.keepout ||
      z.fillEnabled === false ||
      z.filledPolygons === undefined
    )
      continue;
    vertices += z.filledPolygons.reduce((n, p) => n + p.points.length, 0);
    if (vertices > 60000)
      throw new Error('Saved copper fills exceed the 60000-vertex board limit.');
    const polygons = z.filledPolygons.map((p) => ({ outer: p.points, holes: [] }));
    result.set(z.id, operation(polygons, [], Clipper.ClipType.ctUnion));
  }
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
  if (zones.some((z) => !z.netId))
    throw new Error('Assign a net to each copper zone before filling.');
}

/** One atomic board replacement: native-style saved fills, in each owner's coordinates. */
export function fillCopperZones(board: PCB, minimumClearance = defaultCopperFillClearance): PCB {
  requireFillNets(board);
  const calculated = calculateCopperPolygons(board, minimumClearance);
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
const refreshedFillBases = new WeakMap<PCB, WeakRef<PCB>>();
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
export function refreshPCBFill(previous: PCB, next: PCB): PCB {
  if (
    previous === next ||
    previous.id !== next.id ||
    refreshedFillBases.get(next)?.deref() === previous
  )
    return next;
  const previousZones = localZones(previous);
  const nextZones = localZones(next);
  if (
    (!previousZones.some((zone) => zone.filledPolygons !== undefined) &&
      !nextZones.some((zone) => zone.filledPolygons !== undefined)) ||
    !pcbFillInputsChanged(previous, next)
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
  const affectedLayers = changedTrackLayers(previous, next);
  const previousById = new Map(previousZones.map((zone) => [zone.id, zone]));
  const nextById = new Map(nextZones.map((zone) => [zone.id, zone]));
  // Native zero inherits board/net-class rules that this bounded format does
  // not import. Use the same explicit default as manual Fill for those targets;
  // positive fine-clearance rules retain their existing value.
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
  const calculated = calculateCopperPolygons(
    effective,
    minimumClearance,
    affectedLayers,
    targetIds,
  );
  const refreshed = withCopperFills(effective, calculated, minimumClearance, targetIds);
  if (!isOwnedPCB(previous)) return refreshed;
  const owned = ownProjectData(refreshed, previous);
  refreshedFillBases.set(owned, new WeakRef(previous));
  return owned;
}
