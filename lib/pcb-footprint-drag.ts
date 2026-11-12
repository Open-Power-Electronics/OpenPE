import { uid, type Point } from './circuit';
import type { PCB } from './pcb';
import { ownProjectData } from './immutable-project';
import { insidePolygon, squaredDistance, trackTouchesPolygon } from './pcb-collision';
import {
  createIncrementalPCBRoutingPartition,
  padCopperLayers,
  partitionPCBRoutingCopper,
} from './pcb-connectivity';
import { movePCBSelection, padDrillPosition, type PCBSelection } from './pcb-layout';
import { borrowPCBPadOutline } from './pcb-pad-contour';
import {
  createDynamicPCBRouter,
  createPCBRouter,
  createPCBRouterSession,
  type RoutingOptions,
} from './pcb-routing';
import { preparePCBArtworkObstacles } from './pcb-routing-artwork';
import { preparePCBTrackAnchors, type PCBTrackAnchor } from './pcb-track-anchors';
import type { PCBTrackDragPreview } from './pcb-track-drag';

type Track = PCB['tracks'][number];
const limitMessage =
  'Footprint drag exceeds the geometry limit. Select fewer footprints or simplify the board.';
export const footprintDragContactError =
  'Footprint drag would change copper connectivity. Move less or choose another direction.';
const epsilon = 0.000001;

function padAtTrackEnd(
  track: Track,
  point: Point,
  pads: readonly PCBTrackAnchor[],
  spend: () => void,
) {
  return pads.find(({ layers, polygon }) => {
    spend();
    return (
      layers.includes(track.layer) &&
      (trackTouchesPolygon({ start: point, end: point, width: track.width }, polygon, spend) ||
        // A plated drill can contain the endpoint without containing copper.
        (polygon.holes.length > 0 &&
          insidePolygon(point, { outer: polygon.outer, holes: [] }, spend) &&
          trackTouchesPolygon(track, polygon, spend)))
    );
  });
}

/** Translate selected packages, reconnecting their native track ends while
 * preserving the routing partition of tracks, pads and fixed through vias. */
export function createPCBFootprintDrag(
  source: PCB,
  selection: readonly PCBSelection[],
  clearance: number,
): {
  preview: (delta: Point, posture?: boolean) => PCBTrackDragPreview;
  leadIds?: readonly string[];
} {
  const failed = (error: string): PCBTrackDragPreview => ({ board: source, error, changedIds: [] });
  try {
    if (!Number.isFinite(clearance) || clearance < 0.05 || clearance > 20)
      throw new Error('Choose a drag clearance from 0.05 to 20 mm.');
    const footprintIds = new Set(selection.map(({ id }) => id));
    const targets = [...footprintIds].map((id) => ({ kind: 'footprint' as const, id }));
    const board = ownProjectData(source);
    const selected = board.footprints.filter(({ id }) => footprintIds.has(id));
    if (!selected.length || selected.length !== footprintIds.size)
      throw new Error('Select existing footprints before starting connected drag.');
    if (selected.some(({ locked }) => locked))
      throw new Error('Unlock selected footprints before starting connected drag.');
    if (
      selected.some(
        ({ graphics, zones }) =>
          graphics.some(({ layer }) => layer.endsWith('.Cu') || layer === 'Edge.Cuts') ||
          zones?.some(({ keepout }) => keepout),
      )
    )
      throw new Error('Use Move for footprints with copper artwork, board edges or rule areas.');

    const objectCount =
      board.tracks.length +
      board.vias.length +
      board.footprints.reduce((count, footprint) => count + footprint.pads.length, 0);
    if (selection.length > 256 || objectCount > 15000) throw new Error(limitMessage);
    let work = 0;
    const spend = (units = 1) => {
      if ((work += units) > 2_000_000) throw new Error(limitMessage);
    };
    const padOwners = new Map(
      selected.flatMap((footprint) => footprint.pads.map(({ id }) => [id, footprint] as const)),
    );
    const originalAnchors = preparePCBTrackAnchors(board, { limitMessage });
    const movedPads = new Map<string, PCBTrackAnchor[]>();
    for (const anchor of originalAnchors) {
      if (!padOwners.has(anchor.id)) continue;
      const pads = movedPads.get(anchor.netId) ?? [];
      pads.push(anchor);
      movedPads.set(anchor.netId, pads);
    }
    const leads = board.tracks.flatMap((track) => {
      const pads = movedPads.get(track.netId);
      if (!pads || track.locked) return [];
      const start = padAtTrackEnd(track, track.start, pads, spend);
      const end = padAtTrackEnd(track, track.end, pads, spend);
      return start || end ? [{ track, start, end, extraIds: [] as string[] }] : [];
    });
    if (leads.length > 256) throw new Error(limitMessage);
    const leadIds = new Set(leads.map(({ track }) => track.id));
    const stationaryTracks = board.tracks.filter(({ id }) => !leadIds.has(id));
    const stationaryAnchors = originalAnchors.filter(
      ({ id, netId }) => !padOwners.has(id) && movedPads.has(netId),
    );
    const originalPartition = partitionPCBRoutingCopper(
      board.tracks.filter(({ netId }) => movedPads.has(netId)),
      originalAnchors.filter(({ netId }) => movedPads.has(netId)),
      spend,
    );
    const routerSession = createPCBRouterSession();
    const stationaryArtwork = preparePCBArtworkObstacles({
      ...board,
      footprints: board.footprints.filter(({ id }) => !footprintIds.has(id)),
      tracks: stationaryTracks,
    });
    const baseRouters = new Map<string, ReturnType<typeof createPCBRouter>>();
    const partitionIndex = createIncrementalPCBRoutingPartition(
      stationaryTracks.filter(({ netId }) => movedPads.has(netId)),
      stationaryAnchors,
      spend,
    );
    const routerKey = (options: Omit<RoutingOptions, 'clearance'>) =>
      JSON.stringify([
        options.layer,
        options.netId,
        options.width,
        options.obstacleType ?? 'track',
        options.allowInheritedWidth ?? false,
      ]);
    const routerFor = (
      options: Omit<RoutingOptions, 'clearance'>,
      footprints: PCB['footprints'],
      tracks: readonly Track[],
      trackCount: number,
    ) => {
      const key = routerKey(options);
      const full = { ...options, clearance };
      if (!baseRouters.has(key))
        baseRouters.set(key, createPCBRouter(stationaryArtwork, full, routerSession));
      spend(objectCount + trackCount - board.tracks.length);
      if (!footprints.length && !tracks.length) return baseRouters.get(key)!;
      const dynamicFootprints = footprints.length
        ? preparePCBArtworkObstacles({
            ...stationaryArtwork,
            footprints,
            tracks: [],
            vias: [],
            graphics: [],
            zones: [],
          }).footprints
        : footprints;
      return createDynamicPCBRouter(
        {
          ...stationaryArtwork,
          footprints: dynamicFootprints,
          tracks: [...tracks],
          vias: [],
          graphics: [],
          zones: [],
        },
        full,
        routerSession,
      );
    };

    return {
      leadIds: leads.map(({ track }) => track.id),
      preview(delta, posture) {
        try {
          work = 0;
          const moved = movePCBSelection(board, targets, delta);
          const poses = moved.footprints.filter(({ id }) => footprintIds.has(id));
          if (poses.every(({ x, y }, index) => x === selected[index].x && y === selected[index].y))
            return { board: source, error: '', changedIds: [] };
          const byId = new Map(poses.map((pose) => [pose.id, pose]));
          const translate = (point: Point, anchor?: PCBTrackAnchor): Point => {
            if (!anchor) return point;
            const origin = padOwners.get(anchor.id)!;
            const pose = byId.get(origin.id)!;
            return {
              x: Number((point.x + (pose.x - origin.x)).toFixed(6)),
              y: Number((point.y + (pose.y - origin.y)).toFixed(6)),
            };
          };

          const routersFor = (
            footprints: PCB['footprints'],
            tracks: readonly Track[],
            trackCount: number,
          ) => {
            const routers = new Map<string, ReturnType<typeof createPCBRouter>>();
            return (options: Omit<RoutingOptions, 'clearance'>) => {
              const key = routerKey(options);
              const saved = routers.get(key);
              if (saved) return saved;
              const router = routerFor(options, footprints, tracks, trackCount);
              routers.set(key, router);
              return router;
            };
          };
          const planWith = routersFor(poses, [], stationaryTracks.length);
          const replacements = new Map<string, Track>();
          const added: Track[] = [];
          for (const lead of leads) {
            const { track, extraIds } = lead;
            const start = translate(track.start, lead.start);
            const end = translate(track.end, lead.end);
            if (squaredDistance(start, end) <= epsilon ** 2)
              throw new Error('Footprint drag would collapse an attached track. Move less.');
            let path = [start, end];
            if (!lead.start || !lead.end) {
              const planner = planWith({
                layer: track.layer,
                netId: track.netId,
                width: track.width,
                allowInheritedWidth: true,
              });
              const route = planner.route(start, end, '45', posture, spend, 'omit');
              if (route.blocked) throw new Error(route.message);
              path = route.points;
              path[0] = start;
              path[path.length - 1] = end;
            }
            if (path.length < 2) throw new Error(footprintDragContactError);
            for (let index = 1; index < path.length; index++) {
              const next = {
                ...track,
                id: index === 1 ? track.id : (extraIds[index - 2] ??= uid()),
                start: { ...path[index - 1] },
                end: { ...path[index] },
              };
              if (squaredDistance(next.start, next.end) <= epsilon ** 2)
                throw new Error('Footprint drag would collapse an attached track. Move less.');
              if (index === 1) replacements.set(track.id, next);
              else added.push(next);
            }
            if (objectCount + added.length > 15000) throw new Error(limitMessage);
          }
          const tracks = board.tracks
            .map((track) => replacements.get(track.id) ?? track)
            .concat(added);
          const next = { ...moved, tracks };
          const changed = [...replacements.values(), ...added];
          const validateTrackWith = routersFor(poses, changed, tracks.length);
          for (const track of changed) {
            const { layer, netId, width } = track;
            const validator = validateTrackWith({ layer, netId, width, allowInheritedWidth: true });
            const issue = validator.validate([track.start, track.end], spend);
            if (issue) throw new Error(issue);
          }

          // The pad group translates rigidly, so its original internal clearance
          // is unchanged. Recheck all moved pad and drill envelopes against the
          // full stationary board and every rerouted track.
          const validatePadWith = routersFor([], changed, tracks.length);
          for (const footprint of poses)
            for (const pad of footprint.pads) {
              const layers = padCopperLayers(board, footprint, pad);
              for (const layer of board.layers) {
                if (layers.includes(layer)) {
                  const issue = validatePadWith({
                    layer,
                    netId: pad.netId,
                    width: 0,
                    obstacleType: 'pad',
                  }).validateRegion(borrowPCBPadOutline(footprint, pad).outer, spend);
                  if (issue) throw new Error(issue);
                }
                if (pad.drill) {
                  const issue = validatePadWith({
                    layer,
                    netId: pad.type === 'np_thru_hole' ? null : pad.netId,
                    width: pad.drill,
                    obstacleType: 'pad',
                  }).validate([padDrillPosition(footprint, pad)], spend);
                  if (issue) throw new Error(issue);
                }
              }
            }

          const anchors = preparePCBTrackAnchors(
            { ...next, footprints: poses, vias: [] },
            { limitMessage },
          );
          const partition = partitionIndex.apply(
            changed.filter(({ netId }) => movedPads.has(netId)),
            anchors,
            spend,
          );
          const forward = new Map<string, string>();
          const reverse = new Map<string, string>();
          for (const [id, before] of originalPartition) {
            const after = partition.get(id);
            if (
              after === undefined ||
              (forward.has(before) && forward.get(before) !== after) ||
              (reverse.has(after) && reverse.get(after) !== before)
            )
              throw new Error(footprintDragContactError);
            forward.set(before, after);
            reverse.set(after, before);
          }
          return {
            board: next,
            error: '',
            changedIds: [...footprintIds, ...changed.map(({ id }) => id)],
          };
        } catch (error) {
          return failed((error as Error).message);
        }
      },
    };
  } catch (error) {
    return { preview: () => failed((error as Error).message) };
  }
}
