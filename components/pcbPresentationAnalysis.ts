import type { PCB, BoardZone } from '@/lib/pcb';
import { invalidatePCBFill } from '@/lib/pcb';
import { isOwnedPCB, isOwnedProjectNode, ownProjectData } from '@/lib/immutable-project';
import { analyzePCBConnectivity, type Airwire } from '@/lib/pcb-connectivity';
import { filledCopperPolygons, polygonPath, type Polygon } from '@/lib/pcb-polygons';
import type { PCBTrackDragPreview } from '@/lib/pcb-track-drag';
import type { Point } from '@/lib/circuit';

type Connectivity = ReturnType<typeof analyzePCBConnectivity>;
type SavedConnectivity = {
  edges: readonly Airwire[];
  padCount: number;
  warnings: readonly string[];
};

type ZoneOutlinePath = Pick<BoardZone, 'outline' | 'holes'> & { path: string };
type ZoneOutlineDrawing = { path: string; target?: string };
type OutlineEdge = { start: Point; end: Point; visible?: [Point, Point] | null };
type OutlineLine = { axis: 'x' | 'y'; slope: number; edges: OutlineEdge[] };

function edgeOnOutlineLine(edge: OutlineEdge, { axis, slope, edges }: OutlineLine) {
  const other = axis === 'x' ? 'y' : 'x';
  const start = edges[0].start;
  return [edge.start, edge.end].every((point) => {
    const delta = (point[axis] - start[axis]) * slope;
    const scale = Math.max(1, Math.abs(start[other]), Math.abs(point[other]), Math.abs(delta));
    return Math.abs(point[other] - start[other] - delta) <= 8 * Number.EPSILON * scale;
  });
}

/** Trim the coincident spans in SVG only. The original rings remain the hit targets. */
function trimCoincidentZoneEdges(
  zones: readonly BoardZone[],
  paths: Map<string, ZoneOutlineDrawing>,
) {
  const ringsByZone = new Map<string, OutlineEdge[][]>();
  const buckets = new Map<string, OutlineLine[]>();
  for (const zone of zones) {
    if (zone.keepout || !zone.layer.endsWith('.Cu')) continue;
    const rings = [zone.outline, ...(zone.holes ?? [])].map((ring) =>
      ring.map((start, index): OutlineEdge => ({ start, end: ring[(index + 1) % ring.length] })),
    );
    ringsByZone.set(zone.id, rings);
    for (const edge of rings.flat()) {
      const { start, end } = edge;
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      if (!dx && !dy) continue;
      const axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
      const other = axis === 'x' ? 'y' : 'x';
      const slope = axis === 'x' ? dy / dx : dx / dy;
      const offset = start[other] - slope * start[axis];
      const key = `${zone.layer}:${axis}:${Math.round(slope * 1e9)}:${Math.round(offset * 1e9)}`;
      let bucket = buckets.get(key);
      if (!bucket) buckets.set(key, (bucket = []));
      // The key only finds candidates. Separate nearby geometry stays visible.
      const line = bucket.find((candidate) => edgeOnOutlineLine(edge, candidate));
      if (line) line.edges.push(edge);
      else bucket.push({ axis, slope, edges: [edge] });
    }
  }
  for (const { axis, edges } of [...buckets.values()].flat()) {
    if (edges.length < 2) continue;
    const spans = edges.map((edge) =>
      edge.start[axis] < edge.end[axis]
        ? { edge, low: edge.start, high: edge.end }
        : { edge, low: edge.end, high: edge.start },
    );
    spans.sort((a, b) => a.low[axis] - b.low[axis] || b.high[axis] - a.high[axis]);
    let covered = spans[0].high;
    for (const { edge, low, high } of spans.slice(1)) {
      if (high[axis] <= covered[axis]) {
        edge.visible = null;
      } else if (low[axis] < covered[axis]) {
        edge.visible = edge.start === low ? [covered, high] : [high, covered];
      }
      if (high[axis] > covered[axis]) covered = high;
    }
  }
  const svgPoint = ({ x, y }: Point) => `${x} ${y}`;
  for (const [id, rings] of ringsByZone) {
    if (!rings.some((ring) => ring.some((edge) => edge.visible !== undefined))) continue;
    const target = paths.get(id)!.path;
    const commands: string[] = [];
    for (const ring of rings) {
      let previousEnd: Point | undefined;
      for (const { start, end, visible } of ring) {
        if (visible === null) {
          previousEnd = undefined;
          continue;
        }
        const [from, to] = visible ?? [start, end];
        if (from !== previousEnd) commands.push(`M ${svgPoint(from)}`);
        commands.push(`L ${svgPoint(to)}`);
        previousEnd = to;
      }
    }
    paths.set(id, { path: commands.join(' '), target });
  }
}
/** Prepare from the last committed map. The caller publishes the new cache in
 * a layout effect; abandoned renders never replace committed entries. */
export function preparePCBZoneOutlinePaths(
  zones: readonly BoardZone[],
  previous: ReadonlyMap<string, ZoneOutlinePath>,
  render = polygonPath,
) {
  const paths = new Map<string, ZoneOutlineDrawing>();
  const cache = new Map<string, ZoneOutlinePath>();
  for (const zone of zones) {
    const owned =
      isOwnedProjectNode(zone.outline) &&
      (zone.holes === undefined || isOwnedProjectNode(zone.holes));
    const saved = owned ? previous.get(zone.id) : undefined;
    const path =
      saved?.outline === zone.outline && saved.holes === zone.holes
        ? saved.path
        : render([{ outer: zone.outline, holes: zone.holes ?? [] }]);
    paths.set(zone.id, { path });
    if (owned) cache.set(zone.id, { outline: zone.outline, holes: zone.holes, path });
  }
  trimCoincidentZoneEdges(zones, paths);
  return { paths, cache };
}

/** Private renderer calculations, independent of Core validation and queries.
 * Successful exact owned boards qualify; mutable/caller-frozen inputs and
 * failures always run the complete calculation. Public containers are fresh. */
export function createPCBPresentationAnalysis(
  calculations = { connectivity: analyzePCBConnectivity, copper: filledCopperPolygons },
) {
  const connectivity = new WeakMap<PCB, SavedConnectivity>();
  const copper = new WeakMap<PCB, readonly (readonly [string, Polygon[]])[]>();
  return {
    connectivity(board: PCB): Connectivity {
      if (!isOwnedPCB(board)) return calculations.connectivity(board);
      let saved = connectivity.get(board);
      if (!saved) {
        const result = calculations.connectivity(board);
        saved = {
          edges: Object.freeze(
            result.edges.map((edge) =>
              Object.freeze({
                ...edge,
                start: Object.freeze({ ...edge.start }),
                end: Object.freeze({ ...edge.end }),
              }),
            ),
          ),
          padCount: result.padCount,
          warnings: Object.freeze([...result.warnings]),
        };
        connectivity.set(board, saved);
      }
      return { edges: [...saved.edges], padCount: saved.padCount, warnings: [...saved.warnings] };
    },
    copper(board: PCB): Map<string, Polygon[]> {
      if (!isOwnedPCB(board)) return calculations.copper(board);
      let saved = copper.get(board);
      if (!saved) {
        const result = calculations.copper(board);
        const ring = (points: Polygon['outer']) =>
          Object.freeze(points.map((point) => Object.freeze({ ...point })));
        saved = Object.freeze(
          [...result].map(
            ([id, polygons]) =>
              [
                id,
                Object.freeze(
                  polygons.map((polygon) =>
                    Object.freeze({
                      outer: ring(polygon.outer),
                      holes: Object.freeze(polygon.holes.map(ring)),
                    }),
                  ),
                ) as unknown as Polygon[],
              ] as const,
          ),
        );
        copper.set(board, saved);
      }
      return new Map(saved);
    },
  };
}

// One comparison board derives only from the immutable basis, retaining its
// original tracks. It never retains a preview pose or semantic acceptance.
const trackFillFreeComparisons = new WeakMap<PCB, PCB>();
function sameStationarySources(candidate: PCB, basis: PCB): boolean {
  // This is only an eligibility hint. Candidate contents always come from the
  // invalidator and are compared by ownProjectData, including Proxy reads.
  try {
    return (
      ['id', 'thickness', 'zones', 'footprints', 'layers', 'vias', 'graphics', 'nets'] as const
    ).every((key) => {
      const property = Object.getOwnPropertyDescriptor(candidate, key);
      return (
        property?.enumerable && Object.hasOwn(property, 'value') && property.value === basis[key]
      );
    });
  } catch {
    return false;
  }
}

function fillFreeComparison(basis: PCB): PCB {
  const clear = (zone: BoardZone): BoardZone => {
    if (zone.filledPolygons === undefined) return zone;
    const { filledPolygons: _filled, ...rest } = zone;
    return rest;
  };
  return ownProjectData(
    {
      ...basis,
      zones: basis.zones.map(clear),
      footprints: basis.footprints.map((footprint) =>
        footprint.zones?.some((zone) => zone.filledPolygons !== undefined)
          ? { ...footprint, zones: footprint.zones.map(clear) }
          : footprint,
      ),
    },
    basis,
  );
}

/** Detach a local successful track proposal once, with its final saved-fill
 * invalidation. Ownership certifies immutable input, never semantic acceptance:
 * Core still validates this complete board before any document publication. */
export function preparePCBTrackPresentation(basis: PCB, preview: PCBTrackDragPreview) {
  if (preview.error || preview.board === basis || !isOwnedPCB(basis)) return preview;
  const candidate = preview.board;
  const invalidated = invalidatePCBFill(basis, candidate);
  // The original invalidator decides whether anything is stale. In particular,
  // no-op, lock-only and already fill-free candidates never adopt cleared data.
  const stationary =
    invalidated !== candidate &&
    sameStationarySources(candidate, basis) &&
    !invalidated.zones.some((zone) => zone.filledPolygons !== undefined) &&
    !invalidated.footprints.some((footprint) =>
      footprint.zones?.some((zone) => zone.filledPolygons !== undefined),
    );
  let comparison = stationary ? trackFillFreeComparisons.get(basis) : undefined;
  if (stationary && !comparison) {
    try {
      comparison = fillFreeComparison(basis);
    } catch {
      // Deriving a comparison must not add an acceptance gate or alter the
      // original candidate's nesting/count errors. Retry the normal copy.
    }
  }
  const board = ownProjectData(invalidated, comparison ?? basis);
  // Failed candidate detachment cannot publish a comparison. Actual candidate
  // contents are never replaced by the comparison, even for untrusted drafts.
  if (comparison) trackFillFreeComparisons.set(basis, comparison);
  return {
    ...preview,
    board,
  };
}
