import type { PCB, BoardZone } from '@/lib/pcb';
import { invalidatePCBFill } from '@/lib/pcb';
import { isOwnedPCB, isOwnedProjectNode, ownProjectData } from '@/lib/immutable-project';
import { analyzePCBConnectivity, type Airwire } from '@/lib/pcb-connectivity';
import { filledCopperPolygons, polygonPath, type Polygon } from '@/lib/pcb-polygons';
import type { PCBTrackDragPreview } from '@/lib/pcb-track-drag';

type Connectivity = ReturnType<typeof analyzePCBConnectivity>;
type SavedConnectivity = {
  edges: readonly Airwire[];
  padCount: number;
  warnings: readonly string[];
};

type ZoneOutlinePath = Pick<BoardZone, 'outline' | 'holes'> & { path: string };
/** Prepare from the last committed map. The caller publishes the new cache in
 * a layout effect; abandoned renders never replace committed entries. */
export function preparePCBZoneOutlinePaths(
  zones: readonly BoardZone[],
  previous: ReadonlyMap<string, ZoneOutlinePath>,
  render = polygonPath,
) {
  const paths = new Map<string, string>();
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
    paths.set(zone.id, path);
    if (owned) cache.set(zone.id, { outline: zone.outline, holes: zone.holes, path });
  }
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
