import type { Circuit, Point } from './circuit';
import type { BoardLine, PCB } from './pcb';
import { requireSupportedPCBCopper } from './pcb';
import { pcbPadCopperClearance } from './pcb-zone-settings';
import { pcbBarcodes } from './pcb-barcode';
import { child, val } from './sexpr';
import {
  defaultPCBRuleSeverity,
  pcbDesignRuleScopes,
  resolvePCBDesignRules,
  type PCBDesignRuleConfig,
  type PCBDesignRuleId,
  type RuleCheckIssue,
  type RuleCheckResult,
} from './design-rule-checks';
import { analyzePCBConnectivity, padCopperLayers } from './pcb-connectivity';
import {
  matchingPCBClearanceRule,
  pcbRuleNetClass,
  type PCBDesignRuleSources,
} from './pcb-clearance-sources';
import { footprintPoint, padDrillLine, padDrillPosition, padPosition } from './pcb-layout';
import {
  borrowPCBPadCopperContour,
  borrowPCBPadOutline,
  inspectPCBPadLand,
} from './pcb-pad-contour';
import { pcbZoneCircle, transformPCBGraphic } from './pcb-geometry';
import { pcbSilkscreen } from './pcb-silkscreen';
import { padSilkscreenLayers } from './pcb-pad-role';
import { pcbStrokeText } from './pcb-stroke-text';
import { pcbPadCopperSections, pcbViaLayerSections } from './pcb-padstack';
import { resolvePCBPrunedCopper } from './pcb-pruned-copper';
import { preparePCBNetTies } from './pcb-net-ties';
import {
  borrowFilledCopperPolygons,
  circlePolygon,
  closedGraphicContours,
  graphicVertices,
  intersectPolygons,
  nativeCustomPadCopperPolygons,
  nativeCustomPadCopperTolerance,
  pcbOutlineGraphics,
  offsetPolygons,
  polygonResolution,
  polygonsFromContours,
  pourKeepoutPolygons,
  prepareBoardOutline,
  prepareBoardOutlineBoundary,
  ruleAreaPolygon,
  worldZones,
  type Polygon,
} from './pcb-polygons';
import {
  edgeBounds,
  insidePolygon,
  makeBoundsIndex as makeIndex,
  overlapsBounds,
  pointSegmentDistance,
  polygonEdges,
  queryBoundsIndex,
  segmentDistance,
  squaredDistance,
  type BoundsIndex,
  type GeometryBounds as Bounds,
} from './pcb-collision';

export { defaultPCBDesignRules, type PCBDesignRuleConfig } from './design-rule-checks';

type BodyKind = 'pad' | 'track' | 'via' | 'zone' | 'graphic';
type Body = {
  id: string;
  kind: BodyKind;
  label: string;
  netId: string | null;
  layers: string[];
  points: Point[];
  edges: [Point, Point][];
  polygon?: Polygon;
  radius: number;
  precision?: number;
  clearance?: number;
  localClearance?: number;
  clearanceLabel?: string;
  at: Point;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  disk?: { at: Point; outer: number; inner: number };
};
type Hole = Bounds & {
  id: string;
  at: Point;
  line: [Point, Point];
  radius: number;
  netId: string | null;
  plated: boolean;
  primaryRoundDrill?: 'mechanical' | 'laser';
  layers: readonly PCB['layers'][number][];
};
type IndexedEdge = Bounds & { line: [Point, Point]; ring: number };
type OutlineStroke = Bounds & { line: [Point, Point] };
type OutlineIndex = ReturnType<typeof prepareBoardOutlineBoundary>['index'];
const epsilon = 0.00001;
const curvedContourTolerance = 0.0005;
const drillCoLocationTolerance = 0.0005;
const maxIssues = 1000;
const courtyardLayers = ['F.CrtYd', 'B.CrtYd'] as const;
const independentPCBChecks = new Set<PCBDesignRuleId>([
  'pcb.track-width',
  'pcb.outline',
  ...pcbDesignRuleScopes.courtyards,
  ...pcbDesignRuleScopes.silkscreen,
]);
const curvedArtwork = (graphic: BoardLine) =>
  graphic.kind === 'arc' ||
  graphic.kind === 'circle' ||
  graphic.kind === 'curve' ||
  graphic.roundedRectRadius !== undefined ||
  Boolean(graphic.polygonArcs);

function silkOutlineStrokes(board: PCB, spend: (count: number) => void) {
  const strokes: OutlineStroke[] = [];
  let vertexCount = 0;
  let precision = 0;
  for (const graphic of pcbOutlineGraphics(board)) {
    if (graphic.kind === 'text' || graphic.kind === 'dimension' || graphic.kind === 'point')
      continue;
    const points = graphicVertices(graphic, curvedContourTolerance);
    vertexCount += points.length;
    if (vertexCount > 20000)
      throw new Error('Silkscreen edge strokes exceed the contour vertex limit.');
    spend(points.length);
    if (curvedArtwork(graphic)) precision = curvedContourTolerance;
    if (graphic.kind === 'circle' || graphic.kind === 'polygon') points.push(points[0]);
    for (let i = 1; i < points.length; i++) {
      const line: [Point, Point] = [points[i - 1], points[i]];
      if (squaredDistance(...line) > 0) strokes.push({ line, ...edgeBounds(line) });
    }
  }
  return strokes.length ? { index: makeIndex(strokes), precision } : undefined;
}
function pointBounds(points: Point[], radius = 0): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x - radius);
    minY = Math.min(minY, point.y - radius);
    maxX = Math.max(maxX, point.x + radius);
    maxY = Math.max(maxY, point.y + radius);
  }
  return { minX, minY, maxX, maxY };
}

function courtyardContoursIntersect(contours: Point[][], spend: () => void): boolean {
  const edges = contours.flatMap((outer, ring) =>
    polygonEdges({ outer, holes: [] }).map((line, index) => ({ line, ring, index })),
  );
  for (let i = 0; i < edges.length; i++) {
    const {
      line: [a, b],
      ring,
      index,
    } = edges[i];
    if (squaredDistance(a, b) < 1e-14) return true;
    for (let j = i + 1; j < edges.length; j++) {
      spend();
      const other = edges[j];
      if (ring === other.ring) {
        const delta = other.index - index;
        if (delta === 1 || delta === contours[ring].length - 1) continue;
      }
      if (segmentDistance(a, b, ...other.line) < 1e-14) return true;
    }
  }
  return false;
}
const mm = (value: number) => `${Number(value.toFixed(4))} mm`;
const nanometres = (value: number) => Math.round(value * 1e6);

/** Read-only checks of the supported board geometry. Saved fills are inspected,
 * never recalculated; errors or bounded work leave an explicitly partial report.
 */
export function runPCBDesignRules(
  board: PCB,
  config: Partial<PCBDesignRuleConfig> = {},
  schematic?: Circuit,
  sources?: PCBDesignRuleSources,
): RuleCheckResult {
  const settings = resolvePCBDesignRules(config);
  const scopedRules = settings.scopes.flatMap((scope) => pcbDesignRuleScopes[scope]);
  const requestedRules = scopedRules.filter((id) => settings.severities[id] !== 'ignore');
  const unsupported = new Map<PCBDesignRuleId, string>();
  const copperRules = requestedRules.filter((id) => !independentPCBChecks.has(id));
  if (copperRules.length) {
    try {
      requireSupportedPCBCopper(board, 'Copper inspection', 'inspection');
    } catch (error) {
      for (const rule of copperRules) unsupported.set(rule, (error as Error).message);
    }
  }
  const barcodes = pcbBarcodes(board.barcodes);
  const unmeasuredEdges =
    barcodes.some(({ layer }) => layer === 'Edge.Cuts') ||
    board.nativeTables?.some((table) => val(child(table, 'layer')) === 'Edge.Cuts');
  if (unmeasuredEdges) {
    const reason = 'Board-edge checks cannot measure native barcodes or tables on Edge.Cuts.';
    for (const rule of [...pcbDesignRuleScopes.edge, 'pcb.silk-edge'] as const)
      if (requestedRules.includes(rule)) unsupported.set(rule, reason);
  }
  if (board.nativeTables?.some((table) => val(child(table, 'layer')).endsWith('.SilkS'))) {
    for (const rule of pcbDesignRuleScopes.silkscreen)
      if (requestedRules.includes(rule))
        unsupported.set(rule, 'Silkscreen checks cannot measure native tables.');
  }
  const checkedRules = requestedRules.filter((rule) => !unsupported.has(rule));
  const enabled = new Set(checkedRules);
  const hasIgnoredRules = requestedRules.length !== scopedRules.length;
  const dimensions = pcbDesignRuleScopes.dimensions.some((id) => enabled.has(id));
  const annular = enabled.has('pcb.annular-ring');
  const castellatedEdge =
    enabled.has('pcb.copper-edge') &&
    board.footprints.some((footprint) =>
      footprint.pads.some((pad) => pad.fabricationProperty === 'pad_prop_castellated'),
    );
  const edge = enabled.has('pcb.copper-edge') && !castellatedEdge;
  const silkEdge = enabled.has('pcb.silk-edge');
  const outline = edge || silkEdge || enabled.has('pcb.outline');
  const copperHoles = enabled.has('pcb.copper-hole');
  const holeSpacing = enabled.has('pcb.hole-spacing') && settings.holeToHole > 0;
  const coLocatedHoles = enabled.has('pcb.holes-co-located');
  const holesEnabled = copperHoles || holeSpacing || coLocatedHoles;
  const clearance = enabled.has('pcb.short') || enabled.has('pcb.clearance');
  const courtyardsEnabled =
    enabled.has('pcb.courtyard-malformed') || enabled.has('pcb.courtyard-overlap');
  const keepouts = enabled.has('pcb.keepout');
  const connectivityEnabled = enabled.has('pcb.unrouted');
  const netTieChecks =
    (clearance || copperHoles) &&
    board.footprints.some((footprint) => footprint.netTiePadGroups?.length);
  const needsCopper = edge || copperHoles || clearance || keepouts;
  const completeScope = settings.scopes.length === Object.keys(pcbDesignRuleScopes).length;
  const references = new Map(schematic?.parts.map((part) => [part.id, part.ref]));
  const result: RuleCheckResult = {
    kind: 'drc',
    complete: completeScope && !hasIgnoredRules,
    truncated: false,
    checkedRules: castellatedEdge
      ? checkedRules.filter((id) => id !== 'pcb.copper-edge')
      : checkedRules,
    issues: [],
    notes: [
      'Checks use the supported pad shapes, straight and arc tracks, native via spans, copper graphics, saved fills and closed Edge.Cuts. Curved contours use bounded approximations.',
      'Footprint courtyards are checked at zero minimum spacing on each courtyard layer. Missing courtyards and custom courtyard constraints are not checked.',
      'Unrouted checks use assigned-pad copper connectivity. Solder mask, creepage, impedance and differential pairs are outside the checker.',
      ...(completeScope ? [] : ['The report covers the selected rule groups.']),
      ...(hasIgnoredRules ? ['Rules set to Ignore are omitted from the report.'] : []),
    ],
  };
  if (castellatedEdge) {
    result.complete = false;
    result.notes.push(
      'Copper-to-edge clearance on castellated boards requires the native KiCad check.',
    );
  }
  let operations = 0;
  let phase = 'the board outline';
  const spend = (count = 1) => {
    if ((operations += count) > 2_000_000)
      throw new Error(`PCB DRC exceeded the geometry work limit while checking ${phase}.`);
  };
  const issue = (
    ruleId: string,
    message: string,
    objectIds: string[],
    location?: Point,
    severity: RuleCheckIssue['severity'] = defaultPCBRuleSeverity,
  ) => {
    const configured = settings.severities[ruleId as PCBDesignRuleId];
    if (configured === 'ignore') return;
    if (result.issues.length >= maxIssues) {
      result.truncated = true;
      result.complete = false;
      return;
    }
    result.issues.push({
      id: `${ruleId}:${objectIds.join(':')}:${result.issues.length}`,
      ruleId,
      severity: configured ?? severity,
      message: message.slice(0, 2048),
      objectIds: [...new Set(objectIds)],
      ...(location ? { location: { x: location.x, y: location.y } } : {}),
    });
  };
  const coverage = (rule: string, message: string, ids: string[], at?: Point) => {
    result.complete = false;
    issue(rule, message, ids, at, 'warning');
  };
  for (const reason of new Set(unsupported.values())) coverage('pcb.coverage', reason, [board.id]);
  const overrides = new Map(
    settings.clearanceOverrides.map((override) => [override.key, override]),
  );
  const customRules =
    settings.useKiCadClearance && enabled.has('pcb.clearance')
      ? (sources?.rules.toReversed().filter(({ key }) => overrides.get(key)?.enabled !== false) ??
        [])
      : [];
  const zoneSources = new Map(sources?.zones.map((zone) => [zone.key, zone]));
  if (enabled.has('pcb.clearance') && settings.useKiCadClearance && sources?.notes.length) {
    coverage(
      'pcb.unsupported-clearance-rule',
      'Some KiCad clearance settings are outside the supported checker. See Net classes and Custom rules for details.',
      [board.id],
    );
    result.notes.push(...sources.notes);
  }
  const indexes = new WeakMap<Body, BoundsIndex<IndexedEdge>>();
  const index = (value: Body) => {
    let prepared = indexes.get(value);
    if (!prepared) {
      const lengths = value.polygon
        ? [value.polygon.outer, ...value.polygon.holes].map((ring) => ring.length)
        : [value.edges.length];
      let ring = 0,
        count = 0;
      const edges = value.edges.map((line): IndexedEdge => {
        while (count >= lengths[ring] && ring < lengths.length - 1) {
          count = 0;
          ring++;
        }
        count++;
        return { line, ring, ...edgeBounds(line) };
      });
      prepared = makeIndex(edges);
      indexes.set(value, prepared);
    }
    return prepared;
  };
  const query = <T extends Bounds>(
    node: BoundsIndex<T>,
    bounds: Bounds,
    margin: number,
    visit: (item: T) => void,
  ) => queryBoundsIndex(node, bounds, margin, visit, spend);
  // The same ray-cast as insidePolygon, visiting only possible ray crossings.
  // Ring tags preserve outer-minus-holes semantics, including offset drill holes.
  const insideBody = (p: Point, value: Body) => {
    if (!value.polygon || p.x > value.maxX || p.y < value.minY || p.y > value.maxY) return false;
    const rings: boolean[] = [];
    query(
      index(value),
      { minX: p.x, maxX: value.maxX, minY: p.y, maxY: p.y },
      0,
      ({ line: [a, b], ring }) => {
        if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
          rings[ring] = !rings[ring];
      },
    );
    return Boolean(rings[0]) && !rings.slice(1).some(Boolean);
  };
  const distance = (a: Body, b: Body, threshold = settings.clearance): number => {
    // Circular pads/vias and their centered drills stay exact. Polygon vertices
    // still describe them for the other bounded outline/keepout operations.
    if (a.disk || b.disk) {
      const disk = (a.disk ? a : b).disk!;
      const other = a.disk ? b : a;
      if (other.disk) {
        const between = Math.sqrt(squaredDistance(disk.at, other.disk.at));
        return Math.max(
          0,
          between - disk.outer - other.disk.outer,
          disk.inner - between - other.disk.outer,
          other.disk.inner - between - disk.outer,
        );
      }
      if (disk.inner) {
        let farthest = 0;
        for (const point of other.points) {
          spend();
          farthest = Math.max(farthest, Math.sqrt(squaredDistance(disk.at, point)) + other.radius);
          if (farthest >= disk.inner) break;
        }
        if (farthest < disk.inner) return disk.inner - farthest;
      }
      if (insideBody(disk.at, other)) return 0;
      let nearest = Infinity;
      const margin = disk.outer + other.radius + threshold + epsilon;
      query(
        index(other),
        { minX: disk.at.x, maxX: disk.at.x, minY: disk.at.y, maxY: disk.at.y },
        margin,
        ({ line: [p, q] }) => {
          nearest = Math.min(nearest, Math.sqrt(pointSegmentDistance(disk.at, p, q)));
        },
      );
      return Math.max(0, nearest - other.radius - disk.outer);
    }
    // Without a boundary crossing, containment is constant along each connected
    // outer contour. Partial overlaps are found by the exact edge queries below.
    if (insideBody(b.points[0], a) || insideBody(a.points[0], b)) return 0;
    let squared = Infinity;
    const outer = a.edges.length <= b.edges.length ? a : b;
    const target = outer === a ? b : a;
    const margin = a.radius + b.radius + threshold + epsilon;
    for (const line of outer.edges) {
      query(index(target), edgeBounds(line), margin, ({ line: [r, s] }) => {
        squared = Math.min(squared, segmentDistance(line[0], line[1], r, s));
      });
      if (squared === 0) return 0;
    }
    return Math.max(0, Math.sqrt(squared) - a.radius - b.radius);
  };
  const bodies: Body[] = [];
  const holes: Hole[] = [];
  let vertices = 0;
  const body = (
    id: string,
    kind: BodyKind,
    label: string,
    netId: string | null,
    layers: string[],
    points: Point[],
    radius = 0,
    polygon?: Polygon,
  ): Body => {
    vertices += points.length + (polygon?.holes.reduce((n, h) => n + h.length, 0) ?? 0);
    if (bodies.length >= 15000 || vertices > 120000)
      throw new Error('PCB DRC supports at most 15000 copper objects and 120000 vertices.');
    if (
      !points.length ||
      !Number.isFinite(radius) ||
      radius < 0 ||
      points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))
    )
      throw new Error('PCB DRC encountered invalid copper geometry.');
    return {
      id,
      kind,
      label,
      netId,
      layers,
      points,
      radius,
      polygon,
      edges: polygon
        ? polygonEdges(polygon)
        : points.length === 1
          ? [[points[0], points[0]]]
          : points.slice(1).map((p, i) => [points[i], p]),
      at: points[0],
      ...pointBounds(points, radius),
    };
  };
  try {
    const copperGraphic = (graphic: BoardLine) =>
      board.layers.some((layer) => layer === graphic.layer);
    const graphics = needsCopper
      ? [
          ...board.graphics.filter(copperGraphic),
          ...board.footprints.flatMap((f) =>
            f.graphics
              .filter(copperGraphic)
              .map((g) => transformPCBGraphic(g, (p) => footprintPoint(f, p))),
          ),
        ]
      : [];
    let boundary: Polygon[] = [];
    let boundaryIndex: OutlineIndex | undefined;
    let boundaryPrecision = 0;
    try {
      if (outline) {
        const prepared = prepareBoardOutline(board, curvedContourTolerance);
        boundary = prepared.polygons;
        const preparedBoundary = prepareBoardOutlineBoundary(
          prepared,
          curvedContourTolerance,
          spend,
        );
        boundaryIndex = preparedBoundary.index;
        boundaryPrecision = preparedBoundary.precision;
      }
    } catch (error) {
      boundary = [];
      boundaryIndex = undefined;
      result.complete = false;
      if (enabled.has('pcb.outline')) issue('pcb.outline', (error as Error).message, [board.id]);
      else coverage('pcb.coverage', (error as Error).message, [board.id]);
      result.checkedRules = result.checkedRules.filter((rule) => rule !== 'pcb.copper-edge');
      if (edge)
        result.notes.push(
          'Copper-to-edge clearance could not be checked without a valid closed outline.',
        );
    }
    phase = 'footprint courtyards';
    for (const layer of courtyardsEnabled ? courtyardLayers : []) {
      const courtyards: (Bounds & {
        id: string;
        label: string;
        polygons: Polygon[];
        vertices: number;
      })[] = [];
      for (const footprint of board.footprints) {
        spend(footprint.graphics.length + 1);
        // Native courtyard layers already identify their board side, even for
        // a back-side or through-hole footprint with graphics on both layers.
        const artwork = footprint.graphics.filter(
          (g) => g.layer === layer && g.kind !== 'text' && g.kind !== 'dimension',
        );
        if (!artwork.length) continue;
        const label =
          references.get(footprint.symbolId ?? '') || footprint.reference || footprint.libraryId;
        const open = artwork.filter((g) => g.kind !== 'circle' && g.kind !== 'polygon').length;
        spend((open * (open - 1)) / 2);
        const malformed = () => {
          result.complete = false;
          issue(
            'pcb.courtyard-malformed',
            `${label} has a malformed ${layer} courtyard. Draw closed contours without intersections.`,
            [footprint.id],
            footprint,
          );
        };
        let contours: Point[][];
        try {
          contours = closedGraphicContours(
            artwork.map((g) => transformPCBGraphic(g, (p) => footprintPoint(footprint, p))),
            'courtyard',
          );
        } catch {
          malformed();
          continue;
        }
        const points = contours.flat();
        spend(points.length);
        if (
          contours.some((ring) => ring.length < 3) ||
          courtyardContoursIntersect(contours, spend)
        ) {
          malformed();
          continue;
        }
        const polygons = polygonsFromContours(contours);
        if (!polygons.length) {
          malformed();
          continue;
        }
        courtyards.push({
          id: footprint.id,
          label,
          polygons,
          vertices: points.length,
          ...pointBounds(points),
        });
      }
      if (!enabled.has('pcb.courtyard-overlap')) continue;
      courtyards.sort((a, b) => a.minX - b.minX);
      for (let i = 0; i < courtyards.length; i++) {
        const a = courtyards[i];
        for (let j = i + 1; j < courtyards.length && courtyards[j].minX <= a.maxX; j++) {
          spend();
          const b = courtyards[j];
          if (!overlapsBounds(a, b, 0)) continue;
          spend(a.vertices * b.vertices);
          const overlap = intersectPolygons(a.polygons, b.polygons)[0];
          if (overlap)
            issue(
              'pcb.courtyard-overlap',
              `${a.label} and ${b.label} courtyards overlap on ${layer}.`,
              [a.id, b.id],
              overlap.outer[0],
            );
        }
      }
    }
    phase = 'connection-dependent copper layers';
    const pruning =
      needsCopper || annular || connectivityEnabled || enabled.has('pcb.via-diameter')
        ? resolvePCBPrunedCopper(board, spend)
        : undefined;
    if (pruning?.unresolved.length)
      coverage(
        'pcb.geometry-limit',
        'Some connection-dependent copper layers are too close to resolve at the native curve precision.',
        pruning.unresolved.slice(0, 64),
      );
    phase = 'copper shapes and minimum dimensions';
    for (const f of dimensions || needsCopper || holesEnabled ? board.footprints : [])
      for (const p of f.pads) {
        const at = padPosition(f, p),
          drill = padDrillPosition(f, p);
        const line: [Point, Point] = p.drillSlot ? padDrillLine(f, p) : [drill, drill];
        if (
          enabled.has('pcb.pad-drill') &&
          p.drill &&
          nanometres(p.drill) < nanometres(settings.minThroughHole)
        )
          issue(
            'pcb.pad-drill',
            `${f.reference ?? 'Footprint'} pad ${p.number} drill ${mm(p.drill)} is below ${mm(settings.minThroughHole)}.`,
            [f.id, p.id],
            drill,
          );
        if (holesEnabled && p.drill)
          holes.push({
            id: p.id,
            at: drill,
            line,
            radius: p.drill / 2,
            ...pointBounds(line, p.drill / 2),
            netId: p.netId,
            plated: p.type === 'thru_hole',
            primaryRoundDrill: p.drillSlot ? undefined : 'mechanical',
            layers: board.layers,
          });
        const layers = pruning?.pads.get(p) ?? padCopperLayers(board, f, p);
        if (!layers.length) continue;
        if (!needsCopper && !(annular && p.type === 'thru_hole' && p.drill)) continue;
        const plated = p.type === 'thru_hole' && p.drill;
        let ring = Infinity;
        for (const { pad: land, layers: landLayers } of pcbPadCopperSections(p, layers)) {
          const center = land === p ? at : padPosition(f, land);
          const outlines = land.nativeCustomPad
            ? nativeCustomPadCopperPolygons(f, land)
            : [borrowPCBPadOutline(f, land)];
          let hasDrillOutline = false;
          for (const outline of outlines) {
            if (
              annular &&
              plated &&
              (!land.nativeCustomPad || line.every((point) => insidePolygon(point, outline, spend)))
            ) {
              hasDrillOutline = true;
              if (land.shape === 'circle') {
                ring = Math.min(
                  ring,
                  land.size.x / 2 -
                    Math.sqrt(Math.max(...line.map((end) => squaredDistance(center, end)))) -
                    plated / 2,
                );
              } else {
                for (const [a, b] of polygonEdges(outline)) {
                  spend();
                  ring = Math.min(ring, Math.sqrt(segmentDistance(...line, a, b)) - plated / 2);
                }
                if (
                  !land.nativeCustomPad &&
                  line.some((end) => !insidePolygon(end, outline, spend))
                )
                  ring = Math.min(ring, -plated / 2);
              }
            }
            if (!needsCopper) continue;
            const polygons =
              p.padstack || land.nativeCustomPad
                ? inspectPCBPadLand(f, land, outline)
                : [plated ? borrowPCBPadCopperContour(f, land) : outline];
            for (const polygon of polygons) {
              const copper = body(
                p.id,
                'pad',
                `${f.reference ?? 'Footprint'} pad ${p.number}`,
                p.netId,
                landLayers,
                polygon.outer,
                0,
                polygon,
              );
              if (land.nativeCustomPad) copper.precision = nativeCustomPadCopperTolerance;
              if (settings.useKiCadClearance && enabled.has('pcb.clearance'))
                copper.localClearance = pcbPadCopperClearance(f, p);
              if (
                land.shape === 'circle' &&
                !p.drillSlot &&
                (!p.drill || squaredDistance(center, drill) < epsilon ** 2)
              )
                copper.disk = { at: center, outer: land.size.x / 2, inner: (p.drill ?? 0) / 2 };
              bodies.push(copper);
            }
          }
          if (annular && plated && land.nativeCustomPad && !hasDrillOutline)
            ring = Math.min(ring, -plated / 2);
        }
        const precision = p.nativeCustomPad ? nativeCustomPadCopperTolerance : 0;
        if (ring + epsilon + precision < settings.minAnnularRing)
          issue(
            'pcb.annular-ring',
            `${f.reference ?? 'Footprint'} pad ${p.number} has ${mm(ring)} minimum annular ring; requires ${mm(settings.minAnnularRing)}.`,
            [f.id, p.id],
            at,
          );
        else if (ring + epsilon - precision < settings.minAnnularRing)
          coverage(
            'pcb.geometry-limit',
            'The native custom pad annular ring is too close to the limit to resolve.',
            [f.id, p.id],
            at,
          );
      }
    const checkedTracks: (PCB['tracks'][number] & { mid?: Point })[] =
      dimensions || needsCopper ? [...board.tracks, ...(board.arcTracks ?? [])] : [];
    for (const track of checkedTracks) {
      if (
        enabled.has('pcb.track-width') &&
        nanometres(track.width) < nanometres(settings.minTrackWidth)
      )
        issue(
          'pcb.track-width',
          `Track width ${mm(track.width)} is below ${mm(settings.minTrackWidth)}.`,
          [track.id],
          track.start,
        );
      if (needsCopper)
        bodies.push(
          body(
            track.id,
            'track',
            'Track',
            track.netId || null,
            [track.layer],
            track.mid ? graphicVertices({ ...track, kind: 'arc' }) : [track.start, track.end],
            track.width / 2,
          ),
        );
    }
    for (const via of dimensions || needsCopper || holesEnabled ? board.vias : []) {
      const sections = pcbViaLayerSections(board.layers, via, pruning?.vias.get(via));
      const cuts = Object.values(via.backdrills ?? {});
      if (enabled.has('pcb.via-drill') && cuts.length) {
        if (cuts.some((cut) => cut.diameter <= via.drill))
          issue(
            'pcb.via-drill',
            'Via backdrill cutter must be larger than the plated primary drill.',
            [via.id],
            via,
          );
        else if (sections.every((section) => !section.plated))
          issue('pcb.via-drill', 'Via backdrills remove the entire plated barrel.', [via.id], via);
      }
      if (
        enabled.has('pcb.via-drill') &&
        nanometres(via.drill) < nanometres(settings.minThroughHole)
      )
        issue(
          'pcb.via-drill',
          `Via drill ${mm(via.drill)} is below ${mm(settings.minThroughHole)}.`,
          [via.id],
          via,
        );
      const flashedSections = sections.filter((section) => section.diameter > 0);
      const smallestFlash = Math.min(...flashedSections.map((section) => section.diameter));
      if (
        enabled.has('pcb.via-diameter') &&
        nanometres(smallestFlash) < nanometres(settings.minViaDiameter)
      )
        issue(
          'pcb.via-diameter',
          `Via diameter ${mm(smallestFlash)} is below ${mm(settings.minViaDiameter)}.`,
          [via.id],
          via,
        );
      const ring = Math.min(
        ...flashedSections
          .filter((section) => section.plated)
          .map((section) =>
            Math.floor((nanometres(section.diameter) - nanometres(section.drill)) / 2),
          ),
      );
      if (annular && ring < nanometres(settings.minAnnularRing))
        issue(
          'pcb.annular-ring',
          `Via annular ring ${mm(ring / 1e6)} is below ${mm(settings.minAnnularRing)}.`,
          [via.id],
          via,
        );
      for (const group of Object.values(
        Object.groupBy(
          sections,
          (section) => `${section.diameter}:${section.drill}:${section.plated}`,
        ),
      )) {
        if (!group?.length) continue;
        const [{ diameter, drill, plated }] = group;
        const layers = group.map(({ layer }) => layer);
        if (holesEnabled)
          holes.push({
            id: via.id,
            at: via,
            line: [via, via],
            radius: drill / 2,
            netId: via.netId || null,
            plated,
            primaryRoundDrill: via.span?.kind === 'micro' ? 'laser' : 'mechanical',
            layers,
            ...pointBounds([via], drill / 2),
          });
        if (!needsCopper || diameter <= drill) continue;
        const polygon = {
          outer: circlePolygon(via, diameter / 2),
          holes: [circlePolygon(via, drill / 2)],
        };
        const copper = body(
          via.id,
          'via',
          'Via',
          via.netId || null,
          layers,
          polygon.outer,
          0,
          polygon,
        );
        copper.disk = { at: via, outer: diameter / 2, inner: drill / 2 };
        bodies.push(copper);
      }
    }
    for (const g of graphics) {
      if (g.kind === 'text' || g.kind === 'dimension') {
        if (g.text?.hidden || g.dimension?.caption?.hidden) continue;
        coverage(
          'pcb.unsupported-copper',
          'Copper text/dimension strokes are not included in clearance checks.',
          [g.id],
          g.start,
        );
        continue;
      }
      const points = graphicVertices(g);
      const polygon =
        g.fill && (g.kind === 'polygon' || g.kind === 'circle')
          ? { outer: points, holes: [] }
          : undefined;
      if (!polygon && g.width === 0) continue;
      bodies.push(
        body(
          g.id,
          'graphic',
          g.netId ? 'Copper graphic' : 'Unassigned copper graphic',
          g.netId || null,
          [g.layer],
          polygon
            ? points
            : g.kind === 'polygon' || g.kind === 'circle'
              ? [...points, points[0]]
              : points,
          g.width / 2,
          polygon,
        ),
      );
    }
    const zones = needsCopper || connectivityEnabled ? worldZones(board) : [];
    const fills = needsCopper ? borrowFilledCopperPolygons(board) : null;
    for (const zone of zones) {
      if (
        !board.layers.some((layer) => layer === zone.layer) ||
        zone.keepout ||
        zone.fillEnabled === false
      )
        continue;
      if (zone.filledPolygons === undefined)
        coverage(
          'pcb.unfilled-zone',
          'Zone is unfilled or its fill was invalidated; its outline is not copper. Refill before checking connections and clearance.',
          [zone.id],
          zone.outline[0],
        );
      else {
        for (const polygon of fills?.get(zone.id) ?? []) {
          const copper = body(
            zone.id,
            'zone',
            'Saved zone fill',
            zone.netId,
            [zone.layer],
            polygon.outer,
            0,
            polygon,
          );
          const key = `zone:${zone.id}`;
          const override = overrides.get(key);
          if (
            settings.useZoneClearance &&
            enabled.has('pcb.clearance') &&
            override?.enabled !== false
          ) {
            copper.clearance = override?.clearance ?? zone.clearance;
            copper.clearanceLabel = `zone ${zoneSources.get(key)?.label ?? zone.id}`;
          }
          bodies.push(copper);
        }
      }
    }
    const netTies = netTieChecks
      ? preparePCBNetTies(
          board,
          bodies,
          (a, b) => overlapsBounds(a, b, epsilon) && distance(a, b, 0) <= epsilon,
          spend,
          (footprint, first, second, bridge) => {
            if (enabled.has('pcb.short'))
              issue(
                'pcb.short',
                `${footprint.reference ?? footprint.libraryId} pads ${first.number} and ${second.number} touch outside their declared net-tie group.`,
                bridge ? [first.id, second.id, bridge.id] : [first.id, second.id],
                bridge?.at ?? padPosition(footprint, second),
              );
          },
        )
      : undefined;
    const sorted = clearance ? [...bodies].sort((a, b) => a.minX - b.minX) : [];
    const netClasses = new Map(sorted.map(({ netId }) => [netId, pcbRuleNetClass(sources, netId)]));
    if (settings.useKiCadClearance && enabled.has('pcb.clearance')) {
      for (const copper of sorted) {
        if (!copper.netId) continue;
        const netClass = sources?.classes.get(netClasses.get(copper.netId) ?? 'Default');
        if (!netClass) continue;
        const override = overrides.get(netClass.key);
        if (override?.enabled === false) continue;
        const limit = override?.clearance ?? netClass.clearance;
        if (limit > (copper.clearance ?? 0)) {
          copper.clearance = limit;
          copper.clearanceLabel = `net class ${netClass.label}`;
        }
      }
    }
    const searchClearance = sorted.reduce(
      (maximum, copper) => Math.max(maximum, copper.clearance ?? 0, copper.localClearance ?? 0),
      customRules.reduce(
        (maximum, rule) => Math.max(maximum, overrides.get(rule.key)?.clearance ?? rule.clearance),
        enabled.has('pcb.clearance') ? settings.clearance : 0,
      ),
    );
    const courtyardTargets = new Map<string, Body[]>();
    const courtyardHits = new WeakMap<Body, Map<string, boolean>>();
    const intersectsCourtyard = (copper: Body, reference: string) => {
      const hits = courtyardHits.get(copper) ?? new Map<string, boolean>();
      const hit = hits.get(reference);
      if (hit !== undefined) return hit;
      let targets = courtyardTargets.get(reference);
      if (!targets) {
        targets = [];
        spend(board.footprints.length);
        const footprint = board.footprints.find(
          (f) => f.reference === reference || references.get(f.symbolId ?? '') === reference,
        );
        if (footprint) {
          for (const layer of courtyardLayers) {
            const artwork = footprint.graphics.filter(
              (g) => g.layer === layer && g.kind !== 'text' && g.kind !== 'dimension',
            );
            if (!artwork.length) continue;
            spend(artwork.length ** 2);
            const contours = closedGraphicContours(
              artwork.map((g) => transformPCBGraphic(g, (p) => footprintPoint(footprint, p))),
              'courtyard',
            );
            for (const polygon of polygonsFromContours(contours)) {
              targets.push(
                body(footprint.id, 'graphic', reference, null, [], polygon.outer, 0, polygon),
              );
            }
          }
        }
        courtyardTargets.set(reference, targets);
      }
      const intersects = targets.some(
        (target) =>
          overlapsBounds(copper, target, epsilon) && distance(copper, target, 0) <= epsilon,
      );
      hits.set(reference, intersects);
      courtyardHits.set(copper, hits);
      return intersects;
    };
    const ruleTypes = { track: 'Track', via: 'Via', pad: 'Pad', zone: 'Zone', graphic: 'Graphic' };
    const ruleOperand = (copper: Body) => ({
      netClass: netClasses.get(copper.netId) ?? 'Default',
      type: ruleTypes[copper.kind],
      intersectsCourtyard: (reference: string) => intersectsCourtyard(copper, reference),
    });
    const reported = new Set<string>();
    const contactPrecision = bodies.some((copper) => copper.precision)
      ? 2 * nativeCustomPadCopperTolerance
      : 0;
    phase = 'copper contact and clearance';
    for (let i = 0; i < sorted.length; i++)
      for (
        let j = i + 1;
        j < sorted.length &&
        sorted[j].minX <= sorted[i].maxX + searchClearance + epsilon + contactPrecision;
        j++
      ) {
        spend();
        const a = sorted[i],
          b = sorted[j];
        if (
          a.id === b.id ||
          (a.netId !== null && a.netId === b.netId) ||
          !a.layers.some((layer) => b.layers.includes(layer)) ||
          !overlapsBounds(a, b, searchClearance + epsilon + contactPrecision) ||
          netTies?.allows(a, b)
        )
          continue;
        let required = enabled.has('pcb.clearance') ? settings.clearance : 0;
        let clearanceLabel = '';
        const local = Math.max(a.localClearance ?? 0, b.localClearance ?? 0);
        if (local > 0) {
          required = Math.max(
            required,
            local,
            a.kind === 'zone' ? (a.clearance ?? 0) : 0,
            b.kind === 'zone' ? (b.clearance ?? 0) : 0,
          );
          clearanceLabel = 'pad or footprint override';
        } else if (customRules.length) {
          const left = ruleOperand(a),
            right = ruleOperand(b);
          const rule = matchingPCBClearanceRule(customRules, left, right, spend);
          if (rule) {
            required = overrides.get(rule.key)?.clearance ?? rule.clearance;
            clearanceLabel = `rule ${rule.label}`;
          }
        }
        if (!clearanceLabel) {
          for (const copper of [a, b]) {
            if (copper.clearance !== undefined && copper.clearance > required) {
              required = copper.clearance;
              clearanceLabel = copper.clearanceLabel ?? '';
            }
          }
        }
        if (enabled.has('pcb.clearance') && required < settings.clearance) {
          required = settings.clearance;
          clearanceLabel = '';
        }
        const precision = (a.precision ?? 0) + (b.precision ?? 0);
        if (!overlapsBounds(a, b, required + epsilon + precision)) continue;
        const gap = distance(a, b, required + precision);
        if (gap > epsilon && gap + epsilon >= required + precision) continue;
        if (precision && (gap <= epsilon || gap + epsilon + precision >= required)) {
          const key = `uncertain:${[a.id, b.id].sort().join(':')}`;
          if (!reported.has(key)) {
            reported.add(key);
            coverage(
              'pcb.geometry-limit',
              'Native custom pad geometry is too close to resolve contact or the clearance limit.',
              [a.id, b.id],
              a.at,
            );
          }
          if (gap + epsilon + precision >= required) continue;
        }
        const knownNets = netTies
          ? netTies.hasKnownNet(a, b) && netTies.hasKnownNet(b, a)
          : a.netId !== null && b.netId !== null;
        const rule = !knownNets
          ? 'pcb.unassigned-copper'
          : gap <= epsilon && !precision
            ? 'pcb.short'
            : 'pcb.clearance';
        const key = `${rule}:${[a.id, b.id].sort().join(':')}`;
        if (reported.has(key)) continue;
        reported.add(key);
        if (!knownNets) result.complete = false;
        issue(
          rule,
          !knownNets
            ? `${a.label} is within ${mm(gap)} of ${b.label}, but at least one copper object has no assigned net. Assign nets and check this contact/clearance.`
            : rule === 'pcb.short'
              ? `${a.label} touches ${b.label} on a shared copper layer with different or unassigned nets.`
              : `${a.label} to ${b.label} clearance is ${mm(gap)}; requires ${mm(required)}${clearanceLabel ? ` (${clearanceLabel})` : ''}.`,
          [a.id, b.id],
          { x: (a.at.x + b.at.x) / 2, y: (a.at.y + b.at.y) / 2 },
          knownNets ? defaultPCBRuleSeverity : 'warning',
        );
      }
    const boundaryHoles = boundary.flatMap((polygon) => polygon.holes);
    phase = 'copper-to-edge and copper-to-hole clearance';
    const boardPoint = (p: Point, edges: OutlineIndex, precision: number) => {
      let inside = false;
      let separation = Infinity;
      const margin = Math.max(epsilon, precision);
      query(
        edges,
        { minX: p.x, maxX: Math.max(p.x, edges.maxX), minY: p.y, maxY: p.y },
        margin,
        ({ line: [a, b], minX }) => {
          if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x)
            inside = !inside;
          if (minX <= p.x + margin)
            separation = Math.min(separation, pointSegmentDistance(p, a, b));
        },
      );
      return {
        inside: inside || separation <= epsilon ** 2,
        uncertain: precision > 0 && separation <= precision ** 2,
      };
    };
    const holeIndex =
      copperHoles && holes.length
        ? makeIndex(holes.map((hole, order) => ({ ...hole, order })))
        : null;
    const nearbyHoles: (Hole & { order: number })[] = [];
    for (const copper of bodies) {
      const copperPrecision = copper.precision ?? 0;
      if (edge && boundaryIndex) {
        const edges = boundaryIndex;
        const precision = boundaryPrecision + copperPrecision;
        const boundaryMargin = Math.max(settings.copperToEdge, epsilon) + precision;
        let gap = Infinity;
        let outside = false;
        let uncertain = false;
        const checkPoint = (point: Point) => {
          const status = boardPoint(point, edges, precision);
          uncertain ||= status.uncertain;
          outside ||= !status.inside && !status.uncertain;
        };
        checkPoint(copper.points[0]);
        if (copper.polygon)
          for (const hole of boundaryHoles) {
            if (!insideBody(hole[0], copper)) continue;
            let near = false;
            if (precision)
              query(index(copper), pointBounds([hole[0]]), precision, ({ line: [a, b] }) => {
                near ||= pointSegmentDistance(hole[0], a, b) <= precision ** 2;
              });
            uncertain ||= near;
            outside ||= !near;
            if (outside) break;
          }
        if (copper.disk) {
          // A circular annulus has one exact radial interval. Repeating this
          // calculation for every display polygon edge only spends the budget.
          const { at, outer, inner } = copper.disk;
          query(edges, pointBounds([at], outer), boundaryMargin, ({ line: [c, d] }) => {
            const nearest = Math.sqrt(pointSegmentDistance(at, c, d));
            const farthest = Math.sqrt(Math.max(squaredDistance(at, c), squaredDistance(at, d)));
            gap = Math.min(gap, Math.max(0, nearest - outer, inner - farthest));
            if (
              nearest + boundaryPrecision < outer - epsilon &&
              farthest - boundaryPrecision > inner + epsilon
            )
              outside = true;
            else if (
              boundaryPrecision &&
              nearest - boundaryPrecision < outer - epsilon &&
              farthest + boundaryPrecision > inner + epsilon
            )
              uncertain = true;
          });
        } else
          for (const [a, b] of copper.edges) {
            const cuts = [0, 1];
            let touchesBoundary = false;
            const dx = b.x - a.x,
              dy = b.y - a.y;
            query(edges, edgeBounds([a, b]), boundaryMargin + copper.radius, ({ line: [c, d] }) => {
              const separation = segmentDistance(a, b, c, d);
              touchesBoundary ||= separation <= epsilon ** 2;
              gap = Math.min(gap, Math.sqrt(separation) - copper.radius);
              const ex = d.x - c.x,
                ey = d.y - c.y;
              const cross = dx * ey - dy * ex;
              if (Math.abs(cross) < 1e-12) return;
              const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / cross;
              const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / cross;
              if (t > 0 && t < 1 && u >= -epsilon && u <= 1 + epsilon) cuts.push(t);
            });
            cuts.sort((x, y) => x - y);
            for (let i = 1; touchesBoundary && i < cuts.length && !outside; i++) {
              const t = (cuts[i - 1] + cuts[i]) / 2;
              checkPoint({ x: a.x + dx * t, y: a.y + dy * t });
            }
          }
        if (outside || gap + epsilon + precision < settings.copperToEdge)
          issue(
            'pcb.copper-edge',
            outside
              ? `${copper.label} extends outside the board or into a cutout.`
              : `${copper.label} to board edge/cutout clearance is ${mm(Math.max(0, gap))}; requires ${mm(settings.copperToEdge)}.`,
            [copper.id],
            copper.at,
          );
        else if (precision && (uncertain || gap + epsilon - precision < settings.copperToEdge))
          coverage(
            'pcb.geometry-limit',
            `${copper.label} is too close to the board edge to resolve the clearance at the contour precision.`,
            [copper.id],
            copper.at,
          );
      }
      if (!holeIndex) continue;
      nearbyHoles.length = 0;
      query(holeIndex, copper, settings.copperToHole + copperPrecision, (hole) => {
        if (
          hole.id !== copper.id &&
          copper.layers.some((layer) => hole.layers.some((key) => key === layer)) &&
          !(
            hole.plated &&
            ((hole.netId && hole.netId === copper.netId) ||
              netTies?.allowsPlatedHole(copper, hole.id, hole.layers))
          )
        )
          nearbyHoles.push(hole);
      });
      // Keep report ordering independent of the spatial tree split order.
      nearbyHoles.sort((a, b) => a.order - b.order);
      for (const hole of nearbyHoles) {
        let gap = Infinity;
        if (copper.disk) {
          const { at, outer, inner } = copper.disk;
          const near = Math.sqrt(pointSegmentDistance(at, ...hole.line));
          const far = Math.sqrt(Math.max(...hole.line.map((end) => squaredDistance(at, end))));
          gap = Math.max(0, near - outer, inner - far) - hole.radius;
        } else if (hole.line.some((end) => insideBody(end, copper))) gap = -hole.radius;
        else {
          query(
            index(copper),
            pointBounds(hole.line),
            copper.radius + hole.radius + settings.copperToHole + epsilon + copperPrecision,
            ({ line: [a, b] }) => {
              gap = Math.min(
                gap,
                Math.sqrt(segmentDistance(...hole.line, a, b)) - copper.radius - hole.radius,
              );
            },
          );
        }
        if (gap + epsilon + copperPrecision < settings.copperToHole)
          issue(
            'pcb.copper-hole',
            `${copper.label} to ${hole.plated ? 'foreign-net plated' : 'non-plated'} hole clearance is ${mm(Math.max(0, gap))}; requires ${mm(settings.copperToHole)}.`,
            [copper.id, hole.id],
            hole.at,
          );
        else if (copperPrecision && gap + epsilon - copperPrecision < settings.copperToHole)
          coverage(
            'pcb.geometry-limit',
            'Native custom pad geometry is too close to resolve the copper-to-hole clearance.',
            [copper.id, hole.id],
            hole.at,
          );
      }
    }
    if (holeSpacing || coLocatedHoles) {
      phase = 'drill-to-drill clearance';
      const ordered = holes.toSorted((a, b) => a.minX - b.minX);
      const reportedHoles = new Set<string>();
      const search = Math.max(holeSpacing ? settings.holeToHole : 0, drillCoLocationTolerance);
      for (let i = 0; i < ordered.length; i++) {
        const a = ordered[i];
        for (let j = i + 1; j < ordered.length; j++) {
          const b = ordered[j];
          if (b.minX > a.maxX + search) break;
          spend();
          if (a.id === b.id || !a.layers.some((layer) => b.layers.includes(layer))) continue;
          const coLocated =
            a.primaryRoundDrill &&
            b.primaryRoundDrill &&
            (a.primaryRoundDrill === 'mechanical' || b.primaryRoundDrill === 'mechanical') &&
            (nanometres(a.at.x) - nanometres(b.at.x)) ** 2 +
              (nanometres(a.at.y) - nanometres(b.at.y)) ** 2 <
              nanometres(drillCoLocationTolerance) ** 2;
          if (coLocated ? !coLocatedHoles : !holeSpacing) continue;
          const gap = coLocated
            ? 0
            : Math.sqrt(segmentDistance(...a.line, ...b.line)) - a.radius - b.radius;
          if (!coLocated && gap + epsilon >= settings.holeToHole) continue;
          const ids = [a.id, b.id].sort();
          const key = ids.join(':');
          if (reportedHoles.has(key)) continue;
          reportedHoles.add(key);
          if (coLocated)
            issue(
              'pcb.holes-co-located',
              'Primary round drills share the same centre.',
              ids,
              a.at,
              'warning',
            );
          else
            issue(
              'pcb.hole-spacing',
              `Drill-to-drill clearance is ${mm(Math.max(0, gap))}; requires ${mm(settings.holeToHole)}.`,
              [a.id, b.id],
              a.at,
            );
        }
      }
    }
    const silkClearance = enabled.has('pcb.silk-clearance') && settings.minSilkClearance > 0;
    phase = 'silkscreen';
    let outlineStrokes: ReturnType<typeof silkOutlineStrokes>;
    if (silkEdge && !boundaryIndex) {
      try {
        outlineStrokes = silkOutlineStrokes(board, spend);
      } catch (error) {
        coverage('pcb.coverage', (error as Error).message, [board.id]);
      }
    }
    const silkEdgeIndex: BoundsIndex<OutlineStroke> | undefined = silkEdge
      ? (boundaryIndex ?? outlineStrokes?.index)
      : undefined;
    if (silkEdge && !silkEdgeIndex)
      result.checkedRules = result.checkedRules.filter((rule) => rule !== 'pcb.silk-edge');
    const inspectSilkStrokes = silkClearance || Boolean(silkEdgeIndex);
    const silkHeight = enabled.has('pcb.silk-text-height') && settings.minTextHeight > 0;
    const silkThickness = enabled.has('pcb.silk-text-thickness') && settings.minTextThickness > 0;
    if (inspectSilkStrokes || silkHeight || silkThickness) {
      if (
        inspectSilkStrokes &&
        board.footprints.some((footprint) =>
          footprint.pads.some((pad) => padSilkscreenLayers(pad).length),
        )
      )
        coverage(
          'pcb.unsupported-silkscreen',
          'Silkscreen clearance cannot measure native pad artwork.',
          [board.id],
        );
      for (const barcode of barcodes.filter(({ layer }) => layer.endsWith('.SilkS')))
        coverage(
          'pcb.unsupported-silkscreen',
          'Silkscreen checks cannot measure native barcodes.',
          [barcode.id],
          { x: barcode.x, y: barcode.y },
        );
      const silkBodies: Body[] = [];
      const owners = new Map<string, string>();
      if (silkClearance)
        for (const footprint of board.footprints)
          for (const graphic of footprint.graphics) owners.set(graphic.id, footprint.id);
      const plainSilk = new Set<string>();
      for (const graphic of pcbSilkscreen(board, schematic, false)) {
        spend();
        if (silkBodies.length >= 15000)
          throw new Error('PCB DRC supports at most 15000 silkscreen objects.');
        const { id, kind, layer, start, text } = graphic;
        if (
          kind === 'dimension' ||
          graphic.textBox ||
          (inspectSilkStrokes && graphic.stroke && !['solid', 'default'].includes(graphic.stroke))
        ) {
          coverage(
            'pcb.unsupported-silkscreen',
            'This silkscreen object is outside supported stroke or text checks.',
            [id],
            start,
          );
          continue;
        }
        if (text) {
          if (!text.value.trim()) continue;
          if (text.fontFace || text.knockout) {
            coverage(
              'pcb.unsupported-silkscreen',
              'Silkscreen checks cannot measure native font faces or knockout text.',
              [id],
              start,
            );
            continue;
          }
          const width = text.thickness || Math.min(text.size.x, text.size.y) / (text.bold ? 5 : 8);
          for (const [check, actual, minimum, rule, label] of [
            [silkHeight, text.size.y, settings.minTextHeight, 'pcb.silk-text-height', 'height'],
            [
              silkThickness,
              width,
              settings.minTextThickness,
              'pcb.silk-text-thickness',
              'stroke thickness',
            ],
          ] as const) {
            if (check && nanometres(actual) < nanometres(minimum))
              issue(
                rule,
                `Silkscreen text ${label} is ${mm(actual)}; requires ${mm(minimum)}.`,
                [id],
                start,
              );
          }
          if (!inspectSilkStrokes) continue;
          spend(text.value.length);
          const stroke = pcbStrokeText(text, start);
          if ('unsupported' in stroke) {
            coverage(
              'pcb.unsupported-silkscreen',
              `Silkscreen clearance cannot check ${stroke.unsupported}.`,
              [id],
              start,
            );
            continue;
          }
          const points = stroke.paths.flat();
          if (!points.length) continue;
          const shape = body(
            id,
            'graphic',
            'Silkscreen text',
            null,
            [layer],
            points,
            stroke.width / 2,
          );
          shape.edges = stroke.paths.flatMap((path) =>
            path.slice(1).map((p, i) => [path[i], p] as [Point, Point]),
          );
          silkBodies.push(shape);
        } else if (inspectSilkStrokes) {
          const points = graphicVertices(
            graphic,
            silkEdgeIndex ? curvedContourTolerance : undefined,
          );
          const closed = kind === 'polygon' || kind === 'circle';
          const polygon = graphic.fill && closed ? { outer: points, holes: [] } : undefined;
          if (!polygon && graphic.width === 0) continue;
          plainSilk.add(id);
          const shape = body(
            id,
            'graphic',
            'Silkscreen graphic',
            null,
            [layer],
            closed && !polygon ? [...points, points[0]] : points,
            graphic.width / 2,
            polygon,
          );
          if (silkEdgeIndex && curvedArtwork(graphic)) shape.precision = curvedContourTolerance;
          silkBodies.push(shape);
        }
      }
      if (silkEdgeIndex)
        for (const silk of silkBodies) {
          const precision =
            (outlineStrokes?.precision ?? boundaryPrecision) + (silk.precision ?? 0);
          const limit = silk.radius + settings.minSilkClearance;
          const margin = limit + precision + epsilon;
          if (!overlapsBounds(silk, silkEdgeIndex, margin)) continue;
          let gap = Infinity;
          let near = silk.at;
          let boundaryInArtwork = false;
          for (const [a, b] of silk.edges)
            query(silkEdgeIndex, edgeBounds([a, b]), margin, ({ line: [c, d] }) => {
              const distance = Math.sqrt(segmentDistance(a, b, c, d));
              if (distance < gap) {
                gap = distance;
                near = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
              }
            });
          if (silk.polygon)
            query(silkEdgeIndex, silk, 0, ({ line: [a] }) => {
              boundaryInArtwork ||= insideBody(a, silk);
            });
          if (!boundaryInArtwork && gap > margin) continue;
          const crosses = gap <= epsilon;
          const strokeMayReachBoard = gap - precision < silk.radius;
          if (
            boundaryIndex &&
            !boundaryInArtwork &&
            !crosses &&
            !strokeMayReachBoard &&
            !silk.points.some((point) => boardPoint(point, boundaryIndex!, precision).inside)
          )
            continue;
          if (boundaryInArtwork || gap + precision + epsilon < limit || (crosses && !precision))
            issue(
              'pcb.silk-edge',
              'Silkscreen is clipped by or too close to the board edge.',
              [silk.id],
              near,
              'warning',
            );
          else if (precision && gap - precision <= limit)
            coverage(
              'pcb.geometry-limit',
              'Silkscreen is too close to a curved contour to resolve board-edge clearance.',
              [silk.id],
              near,
            );
        }
      silkBodies.sort((a, b) => a.minX - b.minX);
      for (let i = 0; silkClearance && i < silkBodies.length; i++) {
        const a = silkBodies[i];
        for (let j = i + 1; j < silkBodies.length; j++) {
          const b = silkBodies[j];
          if (b.minX > a.maxX + settings.minSilkClearance) break;
          spend();
          if (a.layers[0] !== b.layers[0] || !overlapsBounds(a, b, settings.minSilkClearance))
            continue;
          if (plainSilk.has(a.id) && plainSilk.has(b.id) && owners.get(a.id) === owners.get(b.id))
            continue;
          const gap = distance(a, b, settings.minSilkClearance);
          if (gap + epsilon < settings.minSilkClearance)
            issue(
              'pcb.silk-clearance',
              `Silkscreen clearance is ${mm(gap)}; requires ${mm(settings.minSilkClearance)}.`,
              [a.id, b.id],
              a.at,
            );
        }
      }
    }
    phase = 'copper keepouts';
    const holeBounds = new WeakMap<Point[], Bounds>();
    type KeepoutInterior = { polygons: Polygon[]; bounds: Bounds; edgeCount: number };
    const prepareInterior = (polygons: Polygon[]): KeepoutInterior => {
      const edgeCount = polygons.reduce(
        (n, p) => n + p.outer.length + p.holes.reduce((m, h) => m + h.length, 0),
        0,
      );
      spend(edgeCount);
      return { polygons, bounds: pointBounds(polygons.flatMap((p) => p.outer)), edgeCount };
    };
    const pourEnters = (copper: Body, pour: Polygon, interior: KeepoutInterior) => {
      const { bounds, polygons } = interior;
      if (!polygons.length || !overlapsBounds(copper, bounds, polygonResolution)) return false;
      // Holes outside the clipping bounds cannot affect the intersection.
      let edgeCount = pour.outer.length;
      const holes = pour.holes.filter((hole) => {
        spend();
        let bounds = holeBounds.get(hole);
        if (!bounds) {
          spend(hole.length);
          bounds = pointBounds(hole);
          holeBounds.set(hole, bounds);
        }
        if (!overlapsBounds(bounds, interior.bounds, polygonResolution)) return false;
        edgeCount += hole.length;
        return true;
      });
      spend(edgeCount * interior.edgeCount);
      return intersectPolygons([{ outer: pour.outer, holes }], polygons).length > 0;
    };
    for (const zone of keepouts ? zones.filter((z) => z.keepout) : []) {
      if (zone.keepout!.footprints)
        coverage(
          'pcb.keepout-footprint',
          'Footprint occupancy of rule areas is not checked; copper keepout flags are checked separately.',
          [zone.id],
          zone.outline[0],
        );
      const circle = pcbZoneCircle(zone);
      const curved = Boolean(circle || zone.nativeOutlineArcs);
      const polygon = ruleAreaPolygon(zone, curvedContourTolerance);
      const keepoutBody = (outline: Polygon) =>
        body(zone.id, 'zone', 'Keepout', null, [zone.layer], outline.outer, 0, outline);
      const area = keepoutBody(polygon);
      spend(area.edges.length);
      if (circle && !polygon.holes.length)
        area.disk = { at: circle.center, outer: circle.radius, inner: 0 };
      // Include the contour chord error, clipping-grid rounding and offset chord error.
      const precision = curved ? 2 * (curvedContourTolerance + polygonResolution) : 0;
      const curvedOffset = (amount: number) =>
        offsetPolygons([polygon], amount, curvedContourTolerance);
      let pourInterior: KeepoutInterior | undefined;
      let possiblePourInterior: KeepoutInterior | undefined;
      let certainBodies: Body[] | undefined;
      for (const copper of bodies) {
        spend();
        const blocked =
          copper.kind === 'track'
            ? zone.keepout!.tracks
            : copper.kind === 'via'
              ? zone.keepout!.vias
              : copper.kind === 'pad'
                ? zone.keepout!.pads
                : zone.keepout!.copperpour;
        const pour = copper.kind === 'zone' ? copper.polygon : undefined;
        if (
          !blocked ||
          !copper.layers.includes(zone.layer) ||
          !overlapsBounds(copper, area, (pour ? zone.clearance : epsilon) + precision)
        )
          continue;
        // Rounding a shared sloped edge and its split vertices onto the clipping
        // grid can create slivers. Allow one grid cell at the keepout boundary,
        // while retaining even tiny copper areas farther inside it.
        let enters: boolean;
        let uncertain = false;
        if (pour) {
          pourInterior ??= prepareInterior(
            curved
              ? curvedOffset(zone.clearance - polygonResolution - precision)
              : offsetPolygons(pourKeepoutPolygons(zone), -polygonResolution),
          );
          enters = pourEnters(copper, pour, pourInterior);
          if (!enters && curved) {
            possiblePourInterior ??= prepareInterior(
              curvedOffset(zone.clearance - polygonResolution + precision),
            );
            uncertain = pourEnters(copper, pour, possiblePourInterior);
          }
        } else if (!curved || area.disk) {
          enters = distance(copper, area) <= epsilon;
        } else {
          if (distance(copper, area, precision) > precision + epsilon) continue;
          certainBodies ??= curvedOffset(-precision).map(keepoutBody);
          enters = certainBodies.some((interior) => distance(copper, interior) <= epsilon);
          uncertain = !enters;
        }
        if (enters)
          issue(
            'pcb.keepout',
            `${copper.label} enters a ${copper.kind === 'graphic' ? 'copper' : copper.kind} keepout.`,
            [copper.id, zone.id],
            copper.at,
          );
        else if (uncertain)
          coverage(
            'pcb.geometry-limit',
            `${copper.label} is too close to the curved rule-area boundary to resolve the keepout check.`,
            [copper.id, zone.id],
            copper.at,
          );
      }
    }
    if (connectivityEnabled) {
      const connectivity = analyzePCBConnectivity(board, 'inspection', {
        pruning,
      });
      const names = new Map(board.nets.map((net) => [net.id, net.name]));
      for (const connection of connectivity.edges)
        issue(
          'pcb.unrouted',
          `Net ${names.get(connection.netId) ?? connection.netId} has disconnected pad groups.`,
          [connection.startPadId, connection.endPadId],
          {
            x: (connection.start.x + connection.end.x) / 2,
            y: (connection.start.y + connection.end.y) / 2,
          },
        );
      for (const warning of connectivity.warnings)
        if (!result.notes.includes(warning)) result.notes.push(warning);
    }
  } catch (error) {
    result.complete = false;
    result.notes.push((error as Error).message);
    if (result.issues.length < maxIssues)
      issue(
        'pcb.geometry-limit',
        'PCB DRC could not complete all geometry checks. Review the report notes and check the remaining geometry separately.',
        [board.id],
        undefined,
        'warning',
      );
  }
  return result;
}
