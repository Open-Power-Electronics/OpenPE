import type { Point } from './circuit';
import type { Footprint, Pad, PCB } from './pcb';
import { padPosition } from './pcb-layout';
import { isOwnedPCB, isOwnedProjectNode } from './immutable-project';
import { borrowPCBPadCopperContour } from './pcb-pad-contour';
import { filledCopperPolygons, worldZones, type Polygon } from './pcb-polygons';
import { squaredDistance as distance, segmentDistance, polygonEdges } from './pcb-collision';

export type Airwire = {
  id: string;
  netId: string;
  start: Point;
  end: Point;
  startPadId: string;
  endPadId: string;
};
type Anchor = Point & { id: string };
type Bounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};
type Edge = { points: readonly [Point, Point]; ring: number } & Bounds;
type Spend = (units?: number) => void;
type EdgeTree = Bounds & { edges?: Edge[]; children?: [EdgeTree, EdgeTree] };
type PadGeometry = Bounds & {
  points: Point[];
  edges: [Point, Point][];
  polygon: Polygon;
  tree?: { value: EdgeTree; workUnits: number };
};
type Body = Bounds & {
  points: readonly Point[];
  edges: readonly (readonly [Point, Point])[];
  edgeTree?: EdgeTree;
  polygon?: Polygon;
  radius: number;
  layers: readonly string[];
  anchor?: Anchor;
  sharedPad?: PadGeometry;
};
type CopperKind = 'pad' | 'track' | 'via' | 'fill';
type NetInput = { sources: (object | CopperKind)[]; filled: boolean };
type SavedNet = NetInput & { edges: Airwire[]; workUnits: number };
type SavedPartition = {
  layers: PCB['layers'];
  fillSources: object[];
  nets: Map<string, SavedNet>;
};
// Each exact owned package array retains only its latest successful partition,
// never boards or a revision history. Changed copper nets remain independent
// full calculations; the containing analysis always checks aggregate bounds.
const ownedNetPartitions = new WeakMap<PCB['footprints'], SavedPartition>();
const sameSources = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((source, index) => source === b[index]);
const copyAirwires = (edges: Airwire[]) =>
  edges.map((edge) => ({ ...edge, start: { ...edge.start }, end: { ...edge.end } }));
const epsilon = 0.000001;
const ownedPadGeometry = new WeakMap<Footprint, Map<Pad, PadGeometry>>();
type CopperGeometry = Readonly<
  Bounds & {
    points: readonly Point[];
    edges: readonly (readonly [Point, Point])[];
    radius: number;
    layers: readonly string[];
  }
>;
type SavedCopperGeometry = { layers: PCB['layers']; geometry: CopperGeometry };
// Geometry has no per-analysis work ledger. Each source retains only its latest
// successful layer context; separate maps preserve track/via role semantics.
const ownedTrackGeometry = new WeakMap<PCB['tracks'][number], SavedCopperGeometry>();
const ownedViaGeometry = new WeakMap<PCB['vias'][number], SavedCopperGeometry>();
function freezeCopperGeometry(body: Body): CopperGeometry {
  for (const edge of body.edges) Object.freeze(edge);
  return Object.freeze({
    points: Object.freeze(body.points),
    edges: Object.freeze(body.edges),
    radius: body.radius,
    layers: Object.freeze(body.layers),
    minX: body.minX,
    minY: body.minY,
    maxX: body.maxX,
    maxY: body.maxY,
  });
}
function bodyEdges(points: readonly Point[], polygon?: Polygon): [Point, Point][] {
  if (polygon) return polygonEdges(polygon);
  return points.length === 1
    ? [[points[0], points[0]]]
    : points.slice(1).map((point, index) => [points[index], point]);
}
function retainedPadGeometry(
  footprint: Footprint,
  pad: Pad,
  polygon: Polygon,
): PadGeometry | undefined {
  if (!isOwnedProjectNode(footprint) || !isOwnedProjectNode(pad)) return;
  const shapes = ownedPadGeometry.get(footprint);
  const saved = shapes?.get(pad);
  if (saved) return saved;
  const points = polygon.outer;
  const geometry: PadGeometry = {
    points,
    edges: bodyEdges(points, polygon),
    polygon,
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
  const next = shapes ?? new Map<Pad, PadGeometry>();
  next.set(pad, geometry);
  if (!shapes) ownedPadGeometry.set(footprint, next);
  return geometry;
}
export function padCopperLayers(
  board: Pick<PCB, 'layers'>,
  footprint: Footprint,
  pad: Pad,
): string[] {
  if (pad.type === 'np_thru_hole') return [];
  return pad.layers
    ? board.layers.filter((layer) => pad.layers!.includes('*.Cu') || pad.layers!.includes(layer))
    : pad.type === 'thru_hole'
      ? [...board.layers]
      : [footprint.side === 'front' ? 'F.Cu' : 'B.Cu'];
}
function edgeTree(body: Body, spend: Spend): EdgeTree {
  if (body.edgeTree) return body.edgeTree;
  const shared = body.sharedPad;
  if (shared?.tree) {
    // Retention removes construction/sort CPU, never its logical work charge.
    // Replay once for this analysis body, matching an uncached construction.
    spend(shared.tree.workUnits);
    return (body.edgeTree = shared.tree.value);
  }
  let workUnits = 0;
  const charge = shared
    ? () => {
        spend();
        workUnits++;
      }
    : spend;
  const build = (edges: Edge[]): EdgeTree => {
    const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    for (const edge of edges) {
      charge();
      bounds.minX = Math.min(bounds.minX, edge.minX);
      bounds.minY = Math.min(bounds.minY, edge.minY);
      bounds.maxX = Math.max(bounds.maxX, edge.maxX);
      bounds.maxY = Math.max(bounds.maxY, edge.maxY);
    }
    if (edges.length <= 8) return { ...bounds, edges };
    const axis = bounds.maxX - bounds.minX >= bounds.maxY - bounds.minY ? 'X' : 'Y';
    edges.sort((a, b) => {
      charge();
      return a[`min${axis}`] + a[`max${axis}`] - b[`min${axis}`] - b[`max${axis}`];
    });
    const middle = Math.floor(edges.length / 2);
    return {
      ...bounds,
      children: [build(edges.slice(0, middle)), build(edges.slice(middle))],
    };
  };
  const lengths = body.polygon
    ? [body.polygon.outer, ...body.polygon.holes].map((ring) => ring.length)
    : [body.edges.length];
  let ring = 0;
  let ringEnd = lengths[0];
  const tree = build(
    body.edges.map((points, index) => {
      charge();
      while (index >= ringEnd && ring < lengths.length - 1) ringEnd += lengths[++ring];
      return {
        points,
        ring,
        minX: Math.min(points[0].x, points[1].x),
        minY: Math.min(points[0].y, points[1].y),
        maxX: Math.max(points[0].x, points[1].x),
        maxY: Math.max(points[0].y, points[1].y),
      };
    }),
  );
  // Failed builds/replays publish neither the per-body tree nor cached cost.
  if (shared) shared.tree = { value: tree, workUnits };
  return (body.edgeTree = tree);
}
function boundaryTouches(a: Body, b: Body, spend: Spend): boolean {
  const [query, indexed] = a.edges.length <= b.edges.length ? [a, b] : [b, a];
  const tree = edgeTree(indexed, spend);
  const radius = a.radius + b.radius + epsilon;
  for (const [p, q] of query.edges) {
    spend();
    const minX = Math.min(p.x, q.x) - radius,
      minY = Math.min(p.y, q.y) - radius,
      maxX = Math.max(p.x, q.x) + radius,
      maxY = Math.max(p.y, q.y) + radius;
    const visit = (node: EdgeTree): boolean => {
      spend();
      if (maxX < node.minX || node.maxX < minX || maxY < node.minY || node.maxY < minY)
        return false;
      if (node.children) return node.children.some(visit);
      for (const edge of node.edges!) {
        spend();
        if (maxX < edge.minX || edge.maxX < minX || maxY < edge.minY || edge.maxY < minY) continue;
        spend();
        if (segmentDistance(p, q, ...edge.points) <= radius ** 2) return true;
      }
      return false;
    };
    if (visit(tree)) return true;
  }
  return false;
}
function containsRepresentative(body: Body, point: Point, spend: Spend): boolean {
  const { x, y } = point;
  if (x < body.minX || x > body.maxX || y < body.minY || y > body.maxY) return false;
  // Only visit edges that could cross the ray. Keep each ring's parity
  // separate so drill holes and saved pour voids still subtract copper.
  const crossings = new Set<number>();
  const visit = (node: EdgeTree) => {
    spend();
    if (x > node.maxX || y < node.minY || y > node.maxY) return;
    if (node.children) {
      node.children.forEach(visit);
      return;
    }
    for (const {
      points: [a, b],
      ring,
      maxX,
    } of node.edges!) {
      spend();
      if (x > maxX || a.y > y === b.y > y) continue;
      // Match the ray cast's original edge direction for boundary rounding.
      if (x < ((a.x - b.x) * (y - b.y)) / (a.y - b.y) + b.x)
        if (!crossings.delete(ring)) crossings.add(ring);
    }
  };
  visit(edgeTree(body, spend));
  return crossings.size === 1 && crossings.has(0);
}
function touches(a: Body, b: Body, spend: Spend): boolean {
  if (
    a.maxY + epsilon < b.minY ||
    b.maxY + epsilon < a.minY ||
    !a.layers.some((layer) => b.layers.includes(layer))
  )
    return false;
  // Each body is one connected point/segment or polygon outer boundary. If its
  // representative is outside but another point is inside, a boundary crosses;
  // the exact boundary test below also covers holes and finite copper radii.
  if (a.polygon && containsRepresentative(a, b.points[0], spend)) return true;
  if (b.polygon && containsRepresentative(b, a.points[0], spend)) return true;
  return boundaryTouches(a, b, spend);
}

function copperGroups(items: Body[], spend: Spend) {
  const parents = items.map((_, i) => i);
  const find = (i: number): number => {
    while (parents[i] !== i) {
      parents[i] = parents[parents[i]];
      i = parents[i];
    }
    return i;
  };
  const sorted = items.map((body, i) => ({ body, i })).sort((a, b) => a.body.minX - b.body.minX);
  for (let i = 0; i < sorted.length; i++)
    for (
      let j = i + 1;
      j < sorted.length && sorted[j].body.minX <= sorted[i].body.maxX + epsilon;
      j++
    ) {
      spend();
      const a = sorted[i],
        b = sorted[j];
      if (find(a.i) !== find(b.i) && touches(a.body, b.body, spend)) parents[find(b.i)] = find(a.i);
    }
  return find;
}

type RoutingAnchor = { id: string; netId: string; layers: readonly string[]; polygon: Polygon };
type IdentifiedBody = Body & { id: string };

function routingNetBodies(tracks: PCB['tracks'], anchors: readonly RoutingAnchor[], spend: Spend) {
  const nets = new Map<string, IdentifiedBody[]>();
  const add = (
    id: string,
    netId: string,
    points: Point[],
    radius: number,
    layers: readonly string[],
    polygon?: Polygon,
  ) => {
    spend(points.length);
    const items = nets.get(netId) ?? [];
    items.push({
      id,
      points,
      radius,
      layers,
      polygon,
      edges: bodyEdges(points, polygon),
      minX: Math.min(...points.map((point) => point.x)) - radius,
      maxX: Math.max(...points.map((point) => point.x)) + radius,
      minY: Math.min(...points.map((point) => point.y)) - radius,
      maxY: Math.max(...points.map((point) => point.y)) + radius,
    });
    nets.set(netId, items);
  };
  for (const track of tracks)
    add(track.id, track.netId, [track.start, track.end], track.width / 2, [track.layer]);
  for (const anchor of anchors)
    add(anchor.id, anchor.netId, anchor.polygon.outer, 0, anchor.layers, anchor.polygon);
  return nets;
}

function publishGroups(items: IdentifiedBody[], group: (index: number) => number, partition: Map<string, string>) {
  items.forEach((item, index) => partition.set(item.id, items[group(index)].id));
}

/** Physical routing groups keyed by native IDs. Anchors describe pad/via copper,
 * including drill voids. Saved fills do not certify a reconnect. */
export function partitionPCBRoutingCopper(
  tracks: PCB['tracks'],
  anchors: readonly RoutingAnchor[],
  spend: Spend,
) {
  const partition = new Map<string, string>();
  for (const items of routingNetBodies(tracks, anchors, spend).values())
    publishGroups(items, copperGroups(items, spend), partition);
  return partition;
}

/** Stationary copper groups for one gesture. Later calls recheck only pairs that
 * touch the supplied moved tracks or anchors and charge the retained stationary
 * work again. Equivalence classes match a full partitionPCBRoutingCopper of the
 * combined records. */
export function createIncrementalPCBRoutingPartition(
  tracks: PCB['tracks'],
  anchors: readonly RoutingAnchor[],
  spend: Spend,
) {
  let charged = 0;
  const count = (units = 1) => {
    charged += units;
    spend(units);
  };
  const nets = routingNetBodies(tracks, anchors, count);
  const stationary = new Map<
    string,
    { items: IdentifiedBody[]; parents: number[]; sorted: { body: IdentifiedBody; index: number }[] }
  >();
  for (const [netId, items] of nets) {
    const group = copperGroups(items, count);
    stationary.set(netId, {
      items,
      parents: items.map((_, index) => group(index)),
      sorted: items
        .map((body, index) => ({ body, index }))
        .sort((a, b) => a.body.minX - b.body.minX),
    });
  }
  const stationaryWork = charged;
  return {
    apply(nextTracks: PCB['tracks'], nextAnchors: readonly RoutingAnchor[], budget: Spend) {
      budget(stationaryWork);
      const moved = routingNetBodies(nextTracks, nextAnchors, budget);
      const partition = new Map<string, string>();
      const netIds = new Set([...stationary.keys(), ...moved.keys()]);
      for (const netId of netIds) {
        const base = stationary.get(netId);
        const extra = moved.get(netId) ?? [];
        if (!base) {
          publishGroups(extra, copperGroups(extra, budget), partition);
          continue;
        }
        const items = base.items.concat(extra);
        const parents = base.parents.slice();
        for (let index = 0; index < extra.length; index++) parents.push(base.items.length + index);
        const find = (index: number): number => {
          while (parents[index] !== index) {
            parents[index] = parents[parents[index]];
            index = parents[index];
          }
          return index;
        };
        const unite = (left: number, right: number) => {
          const a = find(left);
          const b = find(right);
          if (a !== b) parents[b] = a;
        };
        for (let index = 0; index < extra.length; index++) {
          const body = extra[index];
          const at = base.items.length + index;
          for (const entry of base.sorted) {
            if (entry.body.minX > body.maxX + epsilon) break;
            if (entry.body.maxX + epsilon < body.minX) continue;
            budget();
            if (find(entry.index) !== find(at) && touches(entry.body, body, budget))
              unite(entry.index, at);
          }
          for (let other = 0; other < index; other++) {
            budget();
            const there = base.items.length + other;
            if (find(there) !== find(at) && touches(extra[other], body, budget)) unite(there, at);
          }
        }
        items.forEach((item, index) => partition.set(item.id, items[find(index)].id));
      }
      return partition;
    },
  };
}

/** Link disconnected copper groups with a minimum spanning tree, independent
 * of visibility. Only saved fill contours establish zone connections.
 */
export function analyzePCBConnectivity(board: PCB): {
  edges: Airwire[];
  padCount: number;
  warnings: string[];
} {
  const owned = isOwnedPCB(board);
  const previousPartition = owned ? ownedNetPartitions.get(board.footprints) : undefined;
  const previous =
    owned && previousPartition?.layers === board.layers ? previousPartition : undefined;
  const inputs = new Map<string, NetInput>();
  const nextNets = owned ? new Map<string, SavedNet>() : undefined;
  const nets = new Map<string, Body[]>();
  const retainCopper = owned && isOwnedProjectNode(board.layers);
  const pendingTracks = new Map<PCB['tracks'][number], CopperGeometry>();
  const pendingVias = new Map<PCB['vias'][number], CopperGeometry>();
  let bodies = 0,
    operations = 0,
    padCount = 0;
  const spend: Spend = (units = 1) => {
    operations += units;
    if (operations > 2_000_000)
      throw new Error(
        'Airwire preview exceeds the geometry limit. Reduce board complexity and check connectivity in KiCad.',
      );
  };
  const add = (
    netId: string | null,
    points: readonly Point[],
    radius: number,
    layers: readonly string[],
    anchor?: Anchor,
    polygon?: Polygon,
    sharedPad?: PadGeometry,
    source?: object,
    filled = false,
    kind: CopperKind = 'pad',
    geometry?: CopperGeometry,
  ) => {
    if (!netId || !layers.length) return;
    if (owned) {
      const input = inputs.get(netId) ?? { sources: [], filled: false };
      input.sources.push(kind, source!);
      input.filled ||= filled;
      inputs.set(netId, input);
    }
    if (++bodies > 15000)
      throw new Error(
        'Airwire preview supports at most 15000 copper objects. Check this board in KiCad.',
      );
    const body: Body = {
      points: geometry?.points ?? points,
      edges: geometry?.edges ?? sharedPad?.edges ?? bodyEdges(points, polygon),
      radius,
      layers,
      anchor,
      polygon,
      minX: geometry?.minX ?? sharedPad?.minX ?? Math.min(...points.map((p) => p.x)) - radius,
      maxX: geometry?.maxX ?? sharedPad?.maxX ?? Math.max(...points.map((p) => p.x)) + radius,
      minY: geometry?.minY ?? sharedPad?.minY ?? Math.min(...points.map((p) => p.y)) - radius,
      maxY: geometry?.maxY ?? sharedPad?.maxY ?? Math.max(...points.map((p) => p.y)) + radius,
      sharedPad,
    };
    const list = nets.get(netId) ?? [];
    list.push(body);
    nets.set(netId, list);
    return body;
  };
  for (const footprint of board.footprints)
    for (const pad of footprint.pads) {
      const layers = padCopperLayers(board, footprint, pad);
      if (!pad.netId || !layers.length) continue;
      if (++padCount > 3000)
        throw new Error(
          'Airwire preview supports at most 3000 assigned pads. Check this board in KiCad.',
        );
      const polygon = borrowPCBPadCopperContour(footprint, pad);
      add(
        pad.netId,
        polygon.outer,
        0,
        layers,
        { ...padPosition(footprint, pad), id: pad.id },
        polygon,
        retainedPadGeometry(footprint, pad, polygon),
        pad,
      );
    }
  for (const track of board.tracks) {
    const reusable = retainCopper && isOwnedProjectNode(track);
    const saved = reusable ? ownedTrackGeometry.get(track) : undefined;
    const geometry =
      saved?.layers === board.layers
        ? saved.geometry
        : reusable
          ? pendingTracks.get(track)
          : undefined;
    const body = add(
      track.netId,
      geometry?.points ?? [track.start, track.end],
      geometry?.radius ?? track.width / 2,
      geometry?.layers ?? [track.layer],
      undefined,
      undefined,
      undefined,
      track,
      false,
      'track',
      geometry,
    );
    if (reusable && !geometry && body) pendingTracks.set(track, freezeCopperGeometry(body));
  }
  for (const via of board.vias) {
    const reusable = retainCopper && isOwnedProjectNode(via);
    const saved = reusable ? ownedViaGeometry.get(via) : undefined;
    const geometry =
      saved?.layers === board.layers ? saved.geometry : reusable ? pendingVias.get(via) : undefined;
    const body = add(
      via.netId,
      geometry?.points ?? [via],
      geometry?.radius ?? via.diameter / 2,
      geometry?.layers ?? [...board.layers],
      undefined,
      undefined,
      undefined,
      via,
      false,
      'via',
      geometry,
    );
    if (reusable && !geometry && body) pendingVias.set(via, freezeCopperGeometry(body));
  }
  const fills = filledCopperPolygons(board);
  const zones = worldZones(board);
  const zoneSources = owned
    ? [...board.zones, ...board.footprints.flatMap((footprint) => footprint.zones ?? [])]
    : [];
  // Transformed footprint zones are fresh wrappers. Their original packets and
  // this partition's exact package identity certify the transform. Include all
  // active fills in the key: repeated zone IDs retain the fill map's last match.
  const fillSources = owned
    ? zones.flatMap((zone, index) =>
        zone.layer.endsWith('.Cu') &&
        !zone.keepout &&
        zone.fillEnabled !== false &&
        zone.filledPolygons !== undefined
          ? [zoneSources[index]]
          : [],
      )
    : [];
  for (const [zoneIndex, zone] of zones.entries())
    for (const polygon of fills.get(zone.id) ?? [])
      add(
        zone.netId,
        polygon.outer,
        0,
        [zone.layer],
        undefined,
        polygon,
        undefined,
        zoneSources[zoneIndex],
        true,
        'fill',
      );
  const edges: Airwire[] = [];
  for (const [netId, items] of nets) {
    const input = inputs.get(netId);
    const saved = previous?.nets.get(netId);
    if (
      input &&
      saved &&
      input.filled === saved.filled &&
      sameSources(input.sources, saved.sources) &&
      (!input.filled || sameSources(fillSources, previous!.fillSources))
    ) {
      // Charge the same contacts, tree preparation and MST comparisons that a
      // fresh calculation would perform, including unchanged nets after edits.
      spend(saved.workUnits);
      edges.push(...copyAirwires(saved.edges));
      nextNets!.set(netId, saved);
      continue;
    }
    const firstEdge = edges.length;
    const firstOperation = operations;
    const groupOf = copperGroups(items, spend);
    const groups = new Map<number, Anchor[]>();
    items.forEach((body, i) => {
      if (!body.anchor) return;
      const key = groupOf(i),
        group = groups.get(key) ?? [];
      group.push(body.anchor);
      groups.set(key, group);
    });
    const components = [...groups.values()];
    const used = new Set<number>();
    const nearest: { distance: number; start?: Anchor; end?: Anchor }[] = components.map(() => ({
      distance: Infinity,
    }));
    if (nearest.length) nearest[0].distance = 0;
    for (let step = 0; step < components.length; step++) {
      let next = -1;
      for (let i = 0; i < components.length; i++)
        if (!used.has(i) && (next < 0 || nearest[i].distance < nearest[next].distance)) next = i;
      used.add(next);
      const { start, end } = nearest[next];
      if (start && end)
        edges.push({
          id: `${netId}:${start.id}:${end.id}`,
          netId,
          start,
          end,
          startPadId: start.id,
          endPadId: end.id,
        });
      for (let i = 0; i < components.length; i++)
        if (!used.has(i))
          for (const start of components[next])
            for (const end of components[i]) {
              spend();
              const d = distance(start, end);
              if (d < nearest[i].distance) nearest[i] = { distance: d, start, end };
            }
    }
    if (input)
      nextNets!.set(netId, {
        ...input,
        edges: copyAirwires(edges.slice(firstEdge)),
        workUnits: operations - firstOperation,
      });
  }
  const result = {
    edges,
    padCount,
    warnings: zones.some(
      (z) => z.netId && !z.keepout && z.fillEnabled !== false && z.filledPolygons === undefined,
    )
      ? [
          'Unfilled zones are excluded from airwire connectivity. Fill copper zones to update connections.',
        ]
      : [],
  };
  // Failed aggregate calculations publish no partial partition or acceptance.
  if (nextNets)
    ownedNetPartitions.set(board.footprints, { layers: board.layers, fillSources, nets: nextNets });
  for (const [source, geometry] of pendingTracks)
    ownedTrackGeometry.set(source, { layers: board.layers, geometry });
  for (const [source, geometry] of pendingVias)
    ownedViaGeometry.set(source, { layers: board.layers, geometry });
  return result;
}
