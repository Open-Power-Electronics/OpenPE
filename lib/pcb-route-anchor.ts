import type { Point } from './circuit';
import type { CopperLayer, Footprint, Pad, PCB } from './pcb';
import { padCopperLayers } from './pcb-connectivity';
import {
  insidePolygon,
  pointSegmentDistance,
  polygonEdges,
  squaredDistance,
} from './pcb-collision';
import type { PCBDisplay } from './pcb-display';
import { padPosition, projectPointToTrack } from './pcb-layout';
import { padPolygon, type Polygon } from './pcb-polygons';

type Track = PCB['tracks'][number];
type Via = PCB['vias'][number];
type PCBRouteAnchorTarget =
  | {
      kind: 'pad';
      id: string;
      pad: Pad;
      footprint: Footprint;
      netId: string | null;
      layer: CopperLayer;
      layers: CopperLayer[];
    }
  | { kind: 'via'; id: string; via: Via; netId: string; layer: CopperLayer }
  | { kind: 'track'; id: string; track: Track; netId: string; layer: CopperLayer };
export type PCBRouteAnchorResult = { point: Point; target?: PCBRouteAnchorTarget; error: string };
export type PCBRouteAnchorOptions = {
  layer: CopperLayer;
  /** Present only while routing; absence allows the start object to choose its net/layer. */
  netId?: string;
  /** Board millimetres corresponding to the desired screen-pixel attraction distance. */
  tolerance: number;
  gridPoint: Point;
  objectSnap?: boolean;
};
type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
type Body = Bounds &
  (
    | {
        kind: 'pad';
        pad: Pad;
        footprint: Footprint;
        center: Point;
        polygon: Polygon;
        edges: [Point, Point][];
        layers: CopperLayer[];
        visibleLayers: CopperLayer[];
      }
    | { kind: 'via'; via: Via }
    | { kind: 'track'; track: Track }
  );
type Candidate = {
  point: Point;
  target: PCBRouteAnchorTarget;
  explicit: boolean;
  distance: number;
  priority: number;
  order: number;
};
const epsilon = 0.000001;
const limitMessage =
  'Routing snap exceeds the geometry limit. Zoom in, hide unneeded layers or simplify the board.';
const invalidMessage =
  'Routing anchor coordinates, copper layer or snap distance are outside the supported range.';
const finitePoint = (point: Point) =>
  Number.isFinite(point.x) &&
  Number.isFinite(point.y) &&
  Math.abs(point.x) <= 100000 &&
  Math.abs(point.y) <= 100000;
function bounds(points: Point[], radius = 0): Bounds {
  return points.reduce(
    (result, point) => ({
      minX: Math.min(result.minX, point.x - radius),
      minY: Math.min(result.minY, point.y - radius),
      maxX: Math.max(result.maxX, point.x + radius),
      maxY: Math.max(result.maxY, point.y + radius),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
}
function boxDistance(point: Point, body: Bounds) {
  return squaredDistance(point, {
    x: Math.max(body.minX, Math.min(body.maxX, point.x)),
    y: Math.max(body.minY, Math.min(body.maxY, point.y)),
  });
}

/** Prepare visible electrical geometry once; renderer stacking and selection filters
 * do not determine routing anchors. Plated holes retain their owning center target.
 */
export function createPCBRouteAnchorResolver(
  board: PCB,
  display: PCBDisplay,
): {
  resolve: (rawPoint: Point, options: PCBRouteAnchorOptions) => PCBRouteAnchorResult;
} {
  const bodies: Body[] = [];
  const nets = new Set(board.nets.map((net) => net.id));
  let preparationError = '',
    vertices = 0;
  try {
    if (
      board.tracks.length +
        board.vias.length +
        board.footprints.reduce((count, footprint) => count + footprint.pads.length, 0) >
      15000
    )
      throw new Error(limitMessage);
    if (display.footprints)
      for (const footprint of board.footprints)
        for (const pad of footprint.pads) {
          const layers = padCopperLayers(board, footprint, pad) as CopperLayer[];
          const visibleLayers = layers.filter((layer) => display[layer]);
          if (!visibleLayers.length) continue;
          const polygon = padPolygon(footprint, pad);
          // A plated drill is a normal center-snapping target, including its hole.
          // NPTH pads have no copper layers and are excluded above.
          vertices += polygon.outer.length;
          if (vertices > 120000) throw new Error(limitMessage);
          bodies.push({
            ...bounds(polygon.outer),
            kind: 'pad',
            pad,
            footprint,
            center: padPosition(footprint, pad),
            polygon,
            edges: polygonEdges(polygon),
            layers,
            visibleLayers,
          });
        }
    if (board.layers.some((layer) => display[layer]))
      for (const via of board.vias) {
        if (++vertices > 120000) throw new Error(limitMessage);
        bodies.push({ ...bounds([via], via.diameter / 2), kind: 'via', via });
      }
    for (const track of board.tracks)
      if (display[track.layer]) {
        vertices += 2;
        if (vertices > 120000) throw new Error(limitMessage);
        bodies.push({ ...bounds([track.start, track.end], track.width / 2), kind: 'track', track });
      }
  } catch (error) {
    preparationError = (error as Error).message;
  }

  return {
    resolve(rawPoint, options) {
      const fallback = { point: { ...options.gridPoint }, error: '' };
      if (
        !finitePoint(rawPoint) ||
        !finitePoint(options.gridPoint) ||
        !board.layers.some((layer) => layer === options.layer) ||
        !Number.isFinite(options.tolerance) ||
        options.tolerance < 0 ||
        options.tolerance > 100000
      )
        return { ...fallback, error: invalidMessage };
      if (options.objectSnap === false) return fallback;
      if (preparationError) return { ...fallback, error: preparationError };
      const activeRoute = options.netId !== undefined;
      if (activeRoute && !nets.has(options.netId!))
        return { ...fallback, error: 'Choose a valid routing net before routing.' };
      let work = 0;
      const spend = () => {
        if (++work > 2_000_000) throw new Error(limitMessage);
      };
      const candidates: Candidate[] = [];
      const toleranceSquared = (options.tolerance + epsilon) ** 2;
      try {
        for (let order = 0; order < bodies.length; order++) {
          spend();
          const body = bodies[order];
          if (boxDistance(rawPoint, body) > toleranceSquared) continue;
          let point: Point, target: PCBRouteAnchorTarget, explicit: boolean, priority: number;
          if (body.kind === 'pad') {
            const centerDistance = squaredDistance(rawPoint, body.center);
            const inside = insidePolygon(rawPoint, body.polygon, spend);
            let distance = inside ? 0 : Infinity;
            if (!inside)
              for (const [a, b] of body.edges) {
                spend();
                distance = Math.min(distance, pointSegmentDistance(rawPoint, a, b));
              }
            if (distance > toleranceSquared && centerDistance > toleranceSquared) continue;
            explicit = inside || distance <= epsilon ** 2;
            point = body.center;
            target = {
              kind: 'pad',
              id: body.pad.id,
              pad: body.pad,
              footprint: body.footprint,
              netId: body.pad.netId,
              layer: body.layers.includes(options.layer) ? options.layer : body.visibleLayers[0],
              layers: body.layers,
            };
            priority = 0;
          } else if (body.kind === 'via') {
            const distance = Math.sqrt(squaredDistance(rawPoint, body.via));
            if (distance > body.via.diameter / 2 + options.tolerance + epsilon) continue;
            explicit = distance <= body.via.diameter / 2 + epsilon;
            point = { x: body.via.x, y: body.via.y };
            target = {
              kind: 'via',
              id: body.via.id,
              via: body.via,
              netId: body.via.netId,
              layer: options.layer,
            };
            priority = 1;
          } else {
            const distance = pointSegmentDistance(rawPoint, body.track.start, body.track.end);
            if (distance > (body.track.width / 2 + options.tolerance + epsilon) ** 2) continue;
            explicit = distance <= (body.track.width / 2 + epsilon) ** 2;
            const startDistance = squaredDistance(rawPoint, body.track.start),
              endDistance = squaredDistance(rawPoint, body.track.end);
            const endpoint = startDistance <= endDistance ? body.track.start : body.track.end;
            const endpointDistance = Math.min(startDistance, endDistance);
            point =
              endpointDistance <= toleranceSquared
                ? endpoint
                : projectPointToTrack(body.track, rawPoint);
            target = {
              kind: 'track',
              id: body.track.id,
              track: body.track,
              netId: body.track.netId,
              layer: body.track.layer,
            };
            priority = endpointDistance <= toleranceSquared ? 2 : 3;
          }
          if (candidates.length >= 512) throw new Error(limitMessage);
          candidates.push({
            point: { ...point },
            target,
            explicit,
            distance: squaredDistance(rawPoint, point),
            priority,
            order,
          });
        }
        const onLayer = (candidate: Candidate) =>
          candidate.target.kind === 'pad'
            ? candidate.target.layers.includes(options.layer)
            : candidate.target.layer === options.layer;
        const compatible = (candidate: Candidate) =>
          onLayer(candidate) && candidate.target.netId === options.netId;
        const compare = (a: Candidate, b: Candidate) =>
          Number(b.explicit) - Number(a.explicit) ||
          (!activeRoute ? Number(onLayer(b)) - Number(onLayer(a)) : 0) ||
          a.distance - b.distance ||
          a.priority - b.priority ||
          a.order - b.order;
        const explicit = candidates.filter((candidate) => candidate.explicit);
        let chosen: Candidate | undefined;
        if (activeRoute) {
          const eligible = candidates.filter(compatible);
          const direct = explicit.filter(compatible);
          // A painted foreign/wrong-layer object must remain an actionable endpoint.
          chosen = direct.length
            ? direct.sort(compare)[0]
            : explicit.length
              ? explicit.sort(compare)[0]
              : eligible.sort(compare)[0];
        } else chosen = candidates.sort(compare)[0];
        if (!chosen) return fallback;
        const { target } = chosen;
        const result = { point: chosen.point, target, error: '' };
        if (target.netId === null)
          return {
            ...result,
            error: 'This pad has no net. Connect its symbol in Schematic before routing.',
          };
        if (activeRoute && target.netId !== options.netId)
          return { ...result, error: 'The destination belongs to another net.' };
        if (activeRoute && !onLayer(chosen))
          return {
            ...result,
            error:
              target.kind === 'pad'
                ? 'Route to this pad on its copper layer.'
                : 'Connect tracks on the same copper layer, or place a through via.',
          };
        return result;
      } catch (error) {
        return { ...fallback, error: (error as Error).message };
      }
    },
  };
}

/** Convenience for callers without a mounted, memoized resolver. */
export function resolvePCBRouteAnchor(
  board: PCB,
  rawPoint: Point,
  options: PCBRouteAnchorOptions & { display: PCBDisplay },
): PCBRouteAnchorResult {
  return createPCBRouteAnchorResolver(board, options.display).resolve(rawPoint, options);
}
