import type { Point } from './circuit';
import type { PCB } from './pcb';
import type { PCBDisplay } from './pcb-display';
import type { PCBSelectionFilters } from './pcb-selection';
import type { PCBSelection } from './pcb-layout';
import { padCopperLayers } from './pcb-connectivity';
import {
  circlePolygon,
  padDrillPolygon,
  filledCopperPolygons,
  padPolygon,
  worldZones,
  type Polygon,
} from './pcb-polygons';
import { insidePolygon, polygonEdges, segmentDistance } from './pcb-collision';

type Body = {
  kind: 'track' | 'via' | 'pad' | 'fill';
  selection?: PCBSelection;
  netId: string;
  points: Point[];
  polygon?: Polygon;
  edges: [Point, Point][];
  radius: number;
  layers: string[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};
const epsilon = 0.000001;
const limitMessage =
  'Connected track selection exceeds the geometry limit. Select a smaller area or simplify the board.';
function makeBody(
  kind: Body['kind'],
  netId: string,
  points: Point[],
  radius: number,
  layers: string[],
  polygon?: Polygon,
  selection?: PCBSelection,
): Body {
  return {
    kind,
    netId,
    points,
    radius,
    layers,
    polygon,
    selection,
    edges: polygon
      ? polygonEdges(polygon)
      : points.length === 1
        ? [[points[0], points[0]]]
        : points.slice(1).map((p, i) => [points[i], p]),
    minX: Math.min(...points.map((p) => p.x)) - radius,
    maxX: Math.max(...points.map((p) => p.x)) + radius,
    minY: Math.min(...points.map((p) => p.y)) - radius,
    maxY: Math.max(...points.map((p) => p.y)) + radius,
  };
}
function touches(a: Body, b: Body, spend: () => void): boolean {
  if (
    a.netId !== b.netId ||
    a.maxX + epsilon < b.minX ||
    b.maxX + epsilon < a.minX ||
    a.maxY + epsilon < b.minY ||
    b.maxY + epsilon < a.minY ||
    !a.layers.some((layer) => b.layers.includes(layer))
  )
    return false;
  if (a.polygon && b.points.some((point) => insidePolygon(point, a.polygon!, spend))) return true;
  if (b.polygon && a.points.some((point) => insidePolygon(point, b.polygon!, spend))) return true;
  for (const [p, q] of a.edges)
    for (const [r, s] of b.edges) {
      spend();
      if (segmentDistance(p, q, r, s) <= (a.radius + b.radius + epsilon) ** 2) return true;
    }
  return false;
}

/** Expand editable copper selection using visible physical contact, never net IDs alone.
 * Chain follows unbranched track endpoints and stops at pads/vias/interior joins.
 * Connected also traverses visible read-only pads and saved copper fill contours.
 * Hidden or filter-disabled editable objects are neither selected nor traversed.
 */
export function expandPCBTrackSelection(
  board: PCB,
  seeds: readonly PCBSelection[],
  layers: PCBDisplay,
  filters: PCBSelectionFilters,
  mode: 'chain' | 'connected',
): PCBSelection[] {
  const seedIds = new Set(
    seeds.filter((seed) => seed.kind === 'track' || seed.kind === 'via').map((seed) => seed.id),
  );
  const tracks = filters.track
    ? board.tracks.filter(
        (track) => layers[track.layer] && (!track.locked || filters.locked !== false),
      )
    : [];
  const visibleCopper = board.layers.filter((layer) => layers[layer]);
  const vias = filters.via && visibleCopper.length ? board.vias : [];
  const nets = new Set(
    [...tracks, ...vias].filter((item) => seedIds.has(item.id)).map((item) => item.netId),
  );
  if (!nets.size) return [];
  const bodies: Body[] = [];
  let vertices = 0,
    work = 0;
  const spend = () => {
    if (++work > 2_000_000) throw new Error(limitMessage);
  };
  const add = (body: Body) => {
    vertices +=
      body.points.length + (body.polygon?.holes.reduce((n, ring) => n + ring.length, 0) ?? 0);
    if (bodies.length >= 15000 || vertices > 120000) throw new Error(limitMessage);
    bodies.push(body);
  };
  for (const track of tracks)
    if (nets.has(track.netId))
      add(
        makeBody(
          'track',
          track.netId,
          [track.start, track.end],
          track.width / 2,
          [track.layer],
          undefined,
          { kind: 'track', id: track.id },
        ),
      );
  for (const via of vias)
    if (nets.has(via.netId)) {
      const polygon = {
        outer: circlePolygon(via, via.diameter / 2),
        holes: [circlePolygon(via, via.drill / 2)],
      };
      add(
        makeBody('via', via.netId, polygon.outer, 0, visibleCopper, polygon, {
          kind: 'via',
          id: via.id,
        }),
      );
    }
  if (layers.footprints)
    for (const footprint of board.footprints)
      for (const pad of footprint.pads) {
        if (!pad.netId || !nets.has(pad.netId)) continue;
        const copperLayers = padCopperLayers(board, footprint, pad).filter(
          (layer) => layers[layer as keyof PCBDisplay],
        );
        if (!copperLayers.length) continue;
        const polygon = padPolygon(footprint, pad);
        if (pad.drill) polygon.holes.push(padDrillPolygon(footprint, pad));
        add(makeBody('pad', pad.netId, polygon.outer, 0, copperLayers, polygon));
      }
  if (mode === 'connected' && layers.copper) {
    const fills = filledCopperPolygons(board);
    for (const zone of worldZones(board)) {
      if (!zone.netId || !nets.has(zone.netId) || !layers[zone.layer]) continue;
      for (const polygon of fills.get(zone.id) ?? [])
        add(makeBody('fill', zone.netId, polygon.outer, 0, [zone.layer], polygon));
    }
  }
  const graph = bodies.map(() => new Set<number>());
  const sorted = bodies
    .map((body, index) => ({ body, index }))
    .sort((a, b) => a.body.minX - b.body.minX);
  for (let i = 0; i < sorted.length; i++)
    for (
      let j = i + 1;
      j < sorted.length && sorted[j].body.minX <= sorted[i].body.maxX + epsilon;
      j++
    ) {
      spend();
      const a = sorted[i],
        b = sorted[j];
      if (touches(a.body, b.body, spend)) {
        graph[a.index].add(b.index);
        graph[b.index].add(a.index);
      }
    }
  const chosen = new Set(
    bodies.flatMap((body, index) =>
      body.selection && seedIds.has(body.selection.id) ? [index] : [],
    ),
  );
  if (mode === 'connected') {
    const queue = [...chosen];
    for (let at = 0; at < queue.length; at++)
      for (const next of graph[queue[at]]) {
        spend();
        if (!chosen.has(next)) {
          chosen.add(next);
          queue.push(next);
        }
      }
  } else {
    const endpoint = (index: number, end: number) => {
      const body = bodies[index];
      return makeBody('track', body.netId, [body.points[end]], body.radius, body.layers);
    };
    const stopsInside = (index: number) =>
      [...graph[index]].some(
        (neighbor) =>
          !touches(endpoint(index, 0), bodies[neighbor], spend) &&
          !touches(endpoint(index, 1), bodies[neighbor], spend),
      );
    const queue = [...chosen]
      .filter((index) => bodies[index].kind === 'track' && !stopsInside(index))
      .flatMap((index) => [
        { index, end: 0 },
        { index, end: 1 },
      ]);
    const visited = new Set<string>();
    for (let at = 0; at < queue.length; at++) {
      spend();
      const { index, end } = queue[at],
        key = `${index}:${end}`;
      if (visited.has(key)) continue;
      visited.add(key);
      const head = endpoint(index, end);
      const contacts = [...graph[index]].filter((neighbor) =>
        touches(head, bodies[neighbor], spend),
      );
      if (contacts.length !== 1 || bodies[contacts[0]].kind !== 'track') continue;
      const next = contacts[0];
      const joins = [0, 1].filter((side) => touches(head, endpoint(next, side), spend));
      if (joins.length !== 1) continue;
      const join = endpoint(next, joins[0]);
      const nextContacts = [...graph[next]].filter((neighbor) =>
        touches(join, bodies[neighbor], spend),
      );
      if (nextContacts.length !== 1 || nextContacts[0] !== index) continue;
      chosen.add(next);
      if (!stopsInside(next)) queue.push({ index: next, end: 1 - joins[0] });
    }
  }
  return bodies.flatMap((body, index) =>
    chosen.has(index) && body.selection ? [body.selection] : [],
  );
}
