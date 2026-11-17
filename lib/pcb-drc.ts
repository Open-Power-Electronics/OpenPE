import type { Circuit, Point } from './circuit';
import type { PCB } from './pcb';
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
import { footprintPoint, padDrillPosition, padPosition } from './pcb-layout';
import { transformPCBGraphic } from './pcb-geometry';
import { pcbSilkscreen } from './pcb-silkscreen';
import { pcbStrokeText } from './pcb-stroke-text';
import {
  boardPolygons,
  circlePolygon,
  closedGraphicContours,
  filledCopperPolygons,
  graphicVertices,
  intersectPolygons,
  offsetPolygons,
  padPolygon,
  polygonResolution,
  polygonsFromContours,
  pourKeepoutPolygons,
  worldZones,
  type Polygon,
} from './pcb-polygons';
import {
  insidePolygon,
  pointSegmentDistance,
  polygonEdges,
  segmentDistance,
  squaredDistance,
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
  clearance?: number;
  clearanceLabel?: string;
  at: Point;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  disk?: { at: Point; outer: number; inner: number };
};
type Hole = { id: string; at: Point; radius: number; netId: string | null; plated: boolean };
type Bounds = Pick<Body, 'minX' | 'minY' | 'maxX' | 'maxY'>;
type IndexedEdge = Bounds & { line: [Point, Point]; ring: number };
type EdgeIndex = Bounds & { edges?: IndexedEdge[]; left?: EdgeIndex; right?: EdgeIndex };
const epsilon = 0.00001;
const maxIssues = 1000;
const courtyardLayers = ['F.CrtYd', 'B.CrtYd'] as const;
const pointBounds = (points: Point[], radius = 0): Bounds =>
  points.reduce(
    (bounds, p) => ({
      minX: Math.min(bounds.minX, p.x - radius),
      minY: Math.min(bounds.minY, p.y - radius),
      maxX: Math.max(bounds.maxX, p.x + radius),
      maxY: Math.max(bounds.maxY, p.y + radius),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );

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
  const checkedRules = scopedRules.filter((id) => settings.severities[id] !== 'ignore');
  const enabled = new Set(checkedRules);
  const hasIgnoredRules = checkedRules.length !== scopedRules.length;
  const dimensions = pcbDesignRuleScopes.dimensions.some((id) => enabled.has(id));
  const annular = enabled.has('pcb.annular-ring');
  const edge = enabled.has('pcb.copper-edge');
  const outline = edge || enabled.has('pcb.outline');
  const copperHoles = enabled.has('pcb.copper-hole');
  const holeSpacing = enabled.has('pcb.hole-spacing') && settings.holeToHole > 0;
  const holesEnabled = copperHoles || holeSpacing;
  const clearance = enabled.has('pcb.short') || enabled.has('pcb.clearance');
  const courtyardsEnabled =
    enabled.has('pcb.courtyard-malformed') || enabled.has('pcb.courtyard-overlap');
  const keepouts = enabled.has('pcb.keepout');
  const connectivityEnabled = enabled.has('pcb.unrouted');
  const needsCopper = edge || copperHoles || clearance || keepouts;
  const completeScope = settings.scopes.length === Object.keys(pcbDesignRuleScopes).length;
  const references = new Map(schematic?.parts.map((part) => [part.id, part.ref]));
  const result: RuleCheckResult = {
    kind: 'drc',
    complete: completeScope && !hasIgnoredRules,
    truncated: false,
    checkedRules,
    issues: [],
    notes: [
      'Checks use the supported pads, tracks, through vias, copper graphics, saved fills and closed Edge.Cuts. Curves use the editor’s bounded polygon approximation.',
      'Footprint courtyards are checked at zero minimum spacing on each courtyard layer. Missing courtyards and custom courtyard constraints are not checked.',
      'Unrouted checks use assigned-pad copper connectivity. Solder mask, creepage, impedance and differential pairs are outside the checker.',
      ...(completeScope ? [] : ['The report covers the selected rule groups.']),
      ...(hasIgnoredRules ? ['Rules set to Ignore are omitted from the report.'] : []),
    ],
  };
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
      throw new Error('PCB DRC reached the 1000-issue report limit.');
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
  const overlapsBounds = (a: Bounds, b: Bounds, margin: number) =>
    a.minX <= b.maxX + margin &&
    b.minX <= a.maxX + margin &&
    a.minY <= b.maxY + margin &&
    b.minY <= a.maxY + margin;
  const edgeBounds = ([a, b]: [Point, Point]): Bounds => ({
    minX: Math.min(a.x, b.x),
    maxX: Math.max(a.x, b.x),
    minY: Math.min(a.y, b.y),
    maxY: Math.max(a.y, b.y),
  });
  const indexes = new WeakMap<Body, EdgeIndex>();
  const makeIndex = (edges: IndexedEdge[]): EdgeIndex => {
    const bounds = edges.reduce(
      (value, edge) => ({
        minX: Math.min(value.minX, edge.minX),
        maxX: Math.max(value.maxX, edge.maxX),
        minY: Math.min(value.minY, edge.minY),
        maxY: Math.max(value.maxY, edge.maxY),
      }),
      { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
    );
    if (edges.length <= 8) return { ...bounds, edges };
    const x = bounds.maxX - bounds.minX >= bounds.maxY - bounds.minY;
    edges.sort((a, b) =>
      x ? a.minX + a.maxX - b.minX - b.maxX : a.minY + a.maxY - b.minY - b.maxY,
    );
    const middle = Math.floor(edges.length / 2);
    return {
      ...bounds,
      left: makeIndex(edges.slice(0, middle)),
      right: makeIndex(edges.slice(middle)),
    };
  };
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
  const query = (
    node: EdgeIndex,
    bounds: Bounds,
    margin: number,
    visit: (edge: IndexedEdge) => void,
  ) => {
    spend();
    if (!overlapsBounds(node, bounds, margin)) return;
    if (node.edges)
      for (const edge of node.edges) {
        spend();
        if (overlapsBounds(edge, bounds, margin)) visit(edge);
      }
    else {
      query(node.left!, bounds, margin, visit);
      query(node.right!, bounds, margin, visit);
    }
  };
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
    const graphics =
      !needsCopper && !outline
        ? []
        : [
            ...board.graphics,
            ...board.footprints.flatMap((f) =>
              f.graphics.map((g) => transformPCBGraphic(g, (p) => footprintPoint(f, p))),
            ),
          ];
    let boundary: Polygon[] = [];
    try {
      if (outline) boundary = boardPolygons(board);
      const outlineEdges = graphics
        .filter((g) => outline && g.layer === 'Edge.Cuts')
        .flatMap((g) => {
          const points = graphicVertices(g);
          return (g.kind === 'circle' || g.kind === 'polygon' ? [...points, points[0]] : points)
            .slice(1)
            .map((p, i): [Point, Point] => [points[i], p]);
        });
      for (let i = 0; i < outlineEdges.length; i++)
        for (let j = i + 1; j < outlineEdges.length; j++) {
          spend();
          const [a, b] = outlineEdges[i],
            [c, d] = outlineEdges[j];
          if ([a, b].some((p) => [c, d].some((q) => squaredDistance(p, q) < 1e-8))) continue;
          if (segmentDistance(a, b, c, d) < epsilon ** 2)
            throw new Error('The board outline intersects itself or another Edge.Cuts contour.');
        }
    } catch (error) {
      boundary = [];
      result.complete = false;
      issue('pcb.outline', (error as Error).message, [board.id]);
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
    phase = 'copper shapes and minimum dimensions';
    for (const f of dimensions || needsCopper || holesEnabled ? board.footprints : [])
      for (const p of f.pads) {
        const at = padPosition(f, p),
          drill = padDrillPosition(f, p);
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
            radius: p.drill / 2,
            netId: p.netId,
            plated: p.type === 'thru_hole',
          });
        const layers = padCopperLayers(board, f, p);
        if (!layers.length) continue;
        if (!needsCopper && !(annular && p.type === 'thru_hole' && p.drill)) continue;
        const polygon = padPolygon(f, p);
        if (p.type === 'thru_hole' && p.drill) {
          if (annular) {
            let ring = Infinity;
            for (const [a, b] of polygonEdges(polygon)) {
              spend();
              ring = Math.min(ring, Math.sqrt(pointSegmentDistance(drill, a, b)) - p.drill / 2);
            }
            if (!insidePolygon(drill, polygon, spend)) ring = -p.drill / 2;
            if (p.shape === 'circle')
              ring = p.size.x / 2 - Math.sqrt(squaredDistance(at, drill)) - p.drill / 2;
            if (ring + epsilon < settings.minAnnularRing)
              issue(
                'pcb.annular-ring',
                `${f.reference ?? 'Footprint'} pad ${p.number} has ${mm(ring)} minimum annular ring; requires ${mm(settings.minAnnularRing)}.`,
                [f.id, p.id],
                at,
              );
          }
          if (needsCopper) polygon.holes.push(circlePolygon(drill, p.drill / 2));
        }
        if (!needsCopper) continue;
        const copper = body(
          p.id,
          'pad',
          `${f.reference ?? 'Footprint'} pad ${p.number}`,
          p.netId,
          layers,
          polygon.outer,
          0,
          polygon,
        );
        if (p.shape === 'circle' && (!p.drill || squaredDistance(at, drill) < epsilon ** 2))
          copper.disk = { at, outer: p.size.x / 2, inner: p.drill ? p.drill / 2 : 0 };
        bodies.push(copper);
      }
    for (const track of dimensions || needsCopper ? board.tracks : []) {
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
            track.netId,
            [track.layer],
            [track.start, track.end],
            track.width / 2,
          ),
        );
    }
    for (const via of dimensions || needsCopper || holesEnabled ? board.vias : []) {
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
      if (
        enabled.has('pcb.via-diameter') &&
        nanometres(via.diameter) < nanometres(settings.minViaDiameter)
      )
        issue(
          'pcb.via-diameter',
          `Via diameter ${mm(via.diameter)} is below ${mm(settings.minViaDiameter)}.`,
          [via.id],
          via,
        );
      const ring = Math.floor((nanometres(via.diameter) - nanometres(via.drill)) / 2);
      if (annular && ring < nanometres(settings.minAnnularRing))
        issue(
          'pcb.annular-ring',
          `Via annular ring ${mm(ring / 1e6)} is below ${mm(settings.minAnnularRing)}.`,
          [via.id],
          via,
        );
      if (holesEnabled)
        holes.push({ id: via.id, at: via, radius: via.drill / 2, netId: via.netId, plated: true });
      if (!needsCopper) continue;
      const polygon = {
        outer: circlePolygon(via, via.diameter / 2),
        holes: [circlePolygon(via, via.drill / 2)],
      };
      const copper = body(
        via.id,
        'via',
        'Via',
        via.netId,
        [...board.layers],
        polygon.outer,
        0,
        polygon,
      );
      copper.disk = { at: via, outer: via.diameter / 2, inner: via.drill / 2 };
      bodies.push(copper);
    }
    for (const g of needsCopper
      ? graphics.filter((g) => board.layers.some((layer) => layer === g.layer))
      : []) {
      if (g.kind === 'text' || g.kind === 'dimension') {
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
          'Unassigned copper graphic',
          null,
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
    const fills = needsCopper ? filledCopperPolygons(board) : null;
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
      (maximum, copper) => Math.max(maximum, copper.clearance ?? 0),
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
    phase = 'copper contact and clearance';
    for (let i = 0; i < sorted.length; i++)
      for (
        let j = i + 1;
        j < sorted.length && sorted[j].minX <= sorted[i].maxX + searchClearance + epsilon;
        j++
      ) {
        spend();
        const a = sorted[i],
          b = sorted[j];
        if (
          a.id === b.id ||
          (a.netId !== null && a.netId === b.netId) ||
          !a.layers.some((layer) => b.layers.includes(layer)) ||
          !overlapsBounds(a, b, searchClearance + epsilon)
        )
          continue;
        let required = enabled.has('pcb.clearance') ? settings.clearance : 0;
        let clearanceLabel = '';
        if (customRules.length) {
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
        if (!overlapsBounds(a, b, required + epsilon)) continue;
        const gap = distance(a, b, required);
        if (gap > epsilon && gap + epsilon >= required) continue;
        const knownNets = a.netId !== null && b.netId !== null;
        const rule = !knownNets
          ? 'pcb.unassigned-copper'
          : gap <= epsilon
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
    const boundaryEdges = boundary.flatMap(polygonEdges);
    const boundaryEdgeBounds = boundaryEdges.map(edgeBounds);
    const boundaryMargin = Math.max(settings.copperToEdge, epsilon);
    const reachesBoundary = (bounds: Bounds) =>
      boundaryEdgeBounds.some((edge) => overlapsBounds(bounds, edge, boundaryMargin));
    phase = 'copper-to-edge and copper-to-hole clearance';
    const onBoard = (p: Point) =>
      boundary.some((polygon) => insidePolygon(p, polygon, spend)) ||
      boundaryEdges.some(([a, b]) => {
        spend();
        return pointSegmentDistance(p, a, b) <= epsilon ** 2;
      });
    for (const copper of bodies) {
      if (edge && boundary.length) {
        let gap = Infinity;
        let outside =
          !onBoard(copper.points[0]) ||
          Boolean(
            copper.polygon &&
            boundary.some((polygon) => polygon.holes.some((hole) => insideBody(hole[0], copper))),
          );
        // A non-centered drill can reach beyond its pad's outer bounds.
        const nearBoundary = copper.disk
          ? reachesBoundary(pointBounds([copper.disk.at], copper.disk.outer))
          : reachesBoundary(copper) ||
            copper.polygon?.holes.some((hole) => reachesBoundary(pointBounds(hole, copper.radius)));
        if (!nearBoundary) {
          // No boundary can touch this body or violate its clearance. Retain
          // the same work-limit accounting without visiting every edge pair.
          spend(boundaryEdges.length * (copper.disk ? 1 : copper.edges.length));
        } else if (copper.disk) {
          // A circular annulus has one exact radial interval. Repeating this
          // calculation for every display polygon edge only spends the budget.
          for (const [c, d] of boundaryEdges) {
            spend();
            const nearest = Math.sqrt(pointSegmentDistance(copper.disk.at, c, d));
            const farthest = Math.sqrt(
              Math.max(squaredDistance(copper.disk.at, c), squaredDistance(copper.disk.at, d)),
            );
            gap = Math.min(
              gap,
              Math.max(0, nearest - copper.disk.outer, copper.disk.inner - farthest),
            );
            if (nearest < copper.disk.outer - epsilon && farthest > copper.disk.inner + epsilon)
              outside = true;
          }
        } else
          for (const [a, b] of copper.edges) {
            const cuts = [0, 1];
            let touchesBoundary = false;
            const dx = b.x - a.x,
              dy = b.y - a.y;
            for (const [c, d] of boundaryEdges) {
              spend();
              const separation = segmentDistance(a, b, c, d);
              touchesBoundary ||= separation <= epsilon ** 2;
              gap = Math.min(gap, Math.sqrt(separation) - copper.radius);
              const ex = d.x - c.x,
                ey = d.y - c.y;
              const cross = dx * ey - dy * ex;
              if (Math.abs(cross) < 1e-12) continue;
              const t = ((c.x - a.x) * ey - (c.y - a.y) * ex) / cross;
              const u = ((c.x - a.x) * dy - (c.y - a.y) * dx) / cross;
              if (t > 0 && t < 1 && u >= -epsilon && u <= 1 + epsilon) cuts.push(t);
            }
            cuts.sort((x, y) => x - y);
            for (let i = 1; touchesBoundary && i < cuts.length && !outside; i++) {
              const t = (cuts[i - 1] + cuts[i]) / 2;
              outside = !onBoard({ x: a.x + dx * t, y: a.y + dy * t });
            }
          }
        if (outside || gap + epsilon < settings.copperToEdge)
          issue(
            'pcb.copper-edge',
            outside
              ? `${copper.label} extends outside the board or into a cutout.`
              : `${copper.label} to board edge/cutout clearance is ${mm(Math.max(0, gap))}; requires ${mm(settings.copperToEdge)}.`,
            [copper.id],
            copper.at,
          );
      }
      for (const hole of copperHoles ? holes : []) {
        spend();
        if (hole.id === copper.id || (hole.plated && hole.netId && hole.netId === copper.netId))
          continue;
        if (
          hole.at.x + hole.radius + settings.copperToHole < copper.minX ||
          hole.at.x - hole.radius - settings.copperToHole > copper.maxX ||
          hole.at.y + hole.radius + settings.copperToHole < copper.minY ||
          hole.at.y - hole.radius - settings.copperToHole > copper.maxY
        )
          continue;
        let gap = Infinity;
        if (copper.disk) {
          const between = Math.sqrt(squaredDistance(hole.at, copper.disk.at));
          gap = Math.max(0, between - copper.disk.outer, copper.disk.inner - between) - hole.radius;
        } else if (insideBody(hole.at, copper)) gap = -hole.radius;
        else {
          const { x, y } = hole.at;
          query(
            index(copper),
            { minX: x, maxX: x, minY: y, maxY: y },
            copper.radius + hole.radius + settings.copperToHole + epsilon,
            ({ line: [a, b] }) => {
              gap = Math.min(
                gap,
                Math.sqrt(pointSegmentDistance(hole.at, a, b)) - copper.radius - hole.radius,
              );
            },
          );
        }
        if (gap + epsilon < settings.copperToHole)
          issue(
            'pcb.copper-hole',
            `${copper.label} to ${hole.plated ? 'foreign-net plated' : 'non-plated'} hole clearance is ${mm(Math.max(0, gap))}; requires ${mm(settings.copperToHole)}.`,
            [copper.id, hole.id],
            hole.at,
          );
      }
    }
    if (holeSpacing) {
      phase = 'drill-to-drill clearance';
      const ordered = holes.toSorted((a, b) => a.at.x - a.radius - (b.at.x - b.radius));
      for (let i = 0; i < ordered.length; i++) {
        const a = ordered[i];
        for (let j = i + 1; j < ordered.length; j++) {
          const b = ordered[j];
          if (b.at.x - b.radius > a.at.x + a.radius + settings.holeToHole) break;
          spend();
          const gap = Math.hypot(a.at.x - b.at.x, a.at.y - b.at.y) - a.radius - b.radius;
          if (gap + epsilon < settings.holeToHole)
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
    const silkHeight = enabled.has('pcb.silk-text-height') && settings.minTextHeight > 0;
    const silkThickness = enabled.has('pcb.silk-text-thickness') && settings.minTextThickness > 0;
    if (silkClearance || silkHeight || silkThickness) {
      phase = 'silkscreen';
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
          (silkClearance && graphic.stroke && !['solid', 'default'].includes(graphic.stroke))
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
          if (!silkClearance) continue;
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
        } else if (silkClearance) {
          const points = graphicVertices(graphic);
          const closed = kind === 'polygon' || kind === 'circle';
          const polygon = graphic.fill && closed ? { outer: points, holes: [] } : undefined;
          if (!polygon && graphic.width === 0) continue;
          plainSilk.add(id);
          silkBodies.push(
            body(
              id,
              'graphic',
              'Silkscreen graphic',
              null,
              [layer],
              closed && !polygon ? [...points, points[0]] : points,
              graphic.width / 2,
              polygon,
            ),
          );
        }
      }
      silkBodies.sort((a, b) => a.minX - b.minX);
      for (let i = 0; i < silkBodies.length; i++) {
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
    for (const zone of keepouts ? zones.filter((z) => z.keepout) : []) {
      if (zone.keepout!.footprints)
        coverage(
          'pcb.keepout-footprint',
          'Footprint occupancy of rule areas is not checked; copper keepout flags are checked separately.',
          [zone.id],
          zone.outline[0],
        );
      const polygon = { outer: zone.outline, holes: zone.holes ?? [] };
      const area = body(zone.id, 'zone', 'Keepout', null, [zone.layer], zone.outline, 0, polygon);
      let pourInterior: { polygons: Polygon[]; bounds: Bounds; edgeCount: number } | undefined;
      for (const copper of bodies) {
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
          !overlapsBounds(copper, area, pour ? zone.clearance : 0)
        )
          continue;
        // Rounding a shared sloped edge and its split vertices onto the clipping
        // grid can create slivers. Allow one grid cell at the keepout boundary,
        // while retaining even tiny copper areas farther inside it.
        let enters: boolean;
        if (pour) {
          if (!pourInterior) {
            spend(area.edges.length);
            const polygons = offsetPolygons(pourKeepoutPolygons(zone), -polygonResolution);
            const edgeCount = polygons.reduce(
              (n, p) => n + p.outer.length + p.holes.reduce((m, h) => m + h.length, 0),
              0,
            );
            spend(edgeCount);
            pourInterior = {
              polygons,
              bounds: pointBounds(polygons.flatMap((p) => p.outer)),
              edgeCount,
            };
          }
          const { bounds: interiorBounds, polygons } = pourInterior;
          if (!polygons.length || !overlapsBounds(copper, interiorBounds, polygonResolution))
            continue;
          // Holes outside the clipping bounds cannot affect the intersection.
          // Include one grid cell in the bounds test for coordinate rounding.
          let edgeCount = pour.outer.length;
          const holes = pour.holes.filter((hole) => {
            spend();
            let bounds = holeBounds.get(hole);
            if (!bounds) {
              spend(hole.length);
              bounds = pointBounds(hole);
              holeBounds.set(hole, bounds);
            }
            if (!overlapsBounds(bounds, interiorBounds, polygonResolution)) return false;
            edgeCount += hole.length;
            return true;
          });
          spend(edgeCount * pourInterior.edgeCount);
          enters = intersectPolygons([{ outer: pour.outer, holes }], polygons).length > 0;
        } else enters = distance(copper, area) <= epsilon;
        if (enters)
          issue(
            'pcb.keepout',
            `${copper.label} enters a ${copper.kind === 'graphic' ? 'copper' : copper.kind} keepout.`,
            [copper.id, zone.id],
            copper.at,
          );
      }
    }
    if (connectivityEnabled) {
      const connectivity = analyzePCBConnectivity(board);
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
