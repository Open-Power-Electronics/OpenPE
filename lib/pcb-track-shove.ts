import { uid, type Point } from './circuit';
import type { BoardLine, PCB } from './pcb';
import { insidePolygon, polygonEdges, segmentDistance, squaredDistance } from './pcb-collision';
import { closestTrackPoints, type PCBSelection } from './pcb-layout';
import type { Polygon } from './pcb-polygons';
import { borrowPCBTrackAnchors, type PCBTrackAnchor as Anchor } from './pcb-track-anchors';
import { createPCBRouter } from './pcb-routing';
import { preparePCBArtworkObstacles } from './pcb-routing-artwork';
import type { PCBTrackDragPreview } from './pcb-track-drag';
import { isOwnedPCB } from './immutable-project';
import { createPCBContactIntervals } from './pcb-contact-intervals';

type Track = PCB['tracks'][number];
type PreviewEngine = { preview: (delta: Point, posture?: boolean) => PCBTrackDragPreview };
type Sweep = { track: Track; points: Point[] };
type ChainPart = { track: Track; reversed: boolean };
type Chain = { parts: ChainPart[]; jointKeys: Set<string> };
type BodyEdge = {
  points: [Point, Point];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};
type Body = {
  id: string;
  netId: string;
  layers: string[];
  points: Point[];
  edges: BodyEdge[];
  radius: number;
  polygon?: Polygon;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};
const epsilon = 0.000001;
const safety = 0.006;
const limitMessage =
  'Track shove exceeds the geometry limit. Move fewer tracks or simplify the board.';
const blockedMessage =
  'Track shove is blocked by fixed copper or board geometry. Move less or choose another direction.';
const collapsedMessage =
  'Track shove would collapse a track. Move less or choose another direction.';
const connectionMessage = 'Track shove would remove a copper connection. Move less.';
const routingBlocked = (issue: string) => {
  if (
    issue &&
    issue !== 'Route blocked. Move around the obstacle or reduce the track width or clearance.'
  )
    throw new Error(issue);
  return Boolean(issue);
};
const same = (a: Point, b: Point) => squaredDistance(a, b) <= epsilon ** 2;
const round = (p: Point): Point => ({ x: Number(p.x.toFixed(6)), y: Number(p.y.toFixed(6)) });
const midpoint = (track: Track): Point => ({
  x: (track.start.x + track.end.x) / 2,
  y: (track.start.y + track.end.y) / 2,
});

function convexHull(points: Point[]): Point[] {
  const sorted = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (a: Point, b: Point, c: Point) =>
    (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const half = (items: Point[]) => {
    const result: Point[] = [];
    for (const point of items) {
      while (result.length > 1 && cross(result.at(-2)!, result.at(-1)!, point) <= 0) result.pop();
      result.push(point);
    }
    return result;
  };
  return half(sorted).slice(0, -1).concat(half(sorted.slice().reverse()).slice(0, -1));
}

function polygonContact(track: Track, polygon: Polygon, spend: () => void): Point | null {
  for (const point of [track.start, track.end])
    if (insidePolygon(point, polygon, spend)) return point;
  let contact: Point | null = null,
    distance = Infinity;
  for (const [start, end] of polygonEdges(polygon)) {
    spend();
    const [point, edge] = closestTrackPoints(track, { ...track, start, end });
    const candidate = squaredDistance(point, edge);
    if (candidate <= (track.width / 2 + epsilon) ** 2 && candidate < distance) {
      contact = point;
      distance = candidate;
    }
  }
  return contact;
}

/** Bounded track-only shove. Pad/via and shared branch contacts remain fixed;
 * free ends and simple same-width chain bends may move. The moved spine and
 * displaced spans share one immutable preview payload;
 * saved fills and private swept obstacles never enter the returned board.
 */
export function createPCBTrackShove(
  board: PCB,
  selections: readonly PCBSelection[],
  clearance: number,
  prepare: (basis: PCB) => PreviewEngine,
  walkAround?: () => PreviewEngine,
  cursorMovement = false,
): PreviewEngine {
  if (isOwnedPCB(board))
    return preparePCBTrackShove(board, selections, clearance, prepare, walkAround, cursorMovement);
  // A caller-owned board can change while a gesture is active, even when its
  // outer object was frozen. Rebuild all derived geometry before using a cached
  // router or contact partition after any such change.
  const picked = selections.map((selection) => ({ ...selection }));
  let fingerprint = JSON.stringify(board);
  let engine = preparePCBTrackShove(board, picked, clearance, prepare, walkAround, cursorMovement);
  return {
    preview(delta, posture) {
      const current = JSON.stringify(board);
      if (current !== fingerprint) {
        engine = preparePCBTrackShove(
          board,
          picked,
          clearance,
          prepare,
          walkAround,
          cursorMovement,
        );
        fingerprint = current;
      }
      return engine.preview(delta, posture);
    },
  };
}

function preparePCBTrackShove(
  board: PCB,
  selections: readonly PCBSelection[],
  clearance: number,
  prepare: (basis: PCB) => PreviewEngine,
  walkAround?: () => PreviewEngine,
  cursorMovement = false,
): PreviewEngine {
  const failed = (error: string): PCBTrackDragPreview => ({ board, error, changedIds: [] });
  try {
    const selectedIds = new Set(selections.map((item) => item.id));
    const selected = board.tracks.filter((track) => selectedIds.has(track.id));
    if (
      selected.length > 256 ||
      board.tracks.length +
        board.vias.length +
        board.footprints.reduce((count, footprint) => count + footprint.pads.length, 0) >
        15000
    )
      throw new Error(limitMessage);
    const movedLayers = new Set(selected.map((track) => track.layer));
    const movedNets = new Set(selected.map((track) => `${track.layer}:${track.netId}`));
    // Keep each moved net's original copper available to the connected-drag
    // planner; only other nets on those layers can become shove candidates.
    const canShove = (track: Track) =>
      !selectedIds.has(track.id) &&
      !track.locked &&
      movedLayers.has(track.layer) &&
      !movedNets.has(`${track.layer}:${track.netId}`);
    const candidates = board.tracks.filter(canShove);
    const loose = { ...board, tracks: board.tracks.filter((track) => !canShove(track)) };
    const engine = prepare(loose);
    const original = new Map(board.tracks.map((track) => [track.id, track]));
    const artworkBoard = preparePCBArtworkObstacles(board);
    const routers = new Map<
      string,
      { tracks: Track[]; router: ReturnType<typeof createPCBRouter> }
    >();
    const retainedRouter = (stage: string, tracks: Track[], track: Track) => {
      // Only foreign copper on this layer contributes track obstacles. Every
      // other router input is fixed for the lifetime of this prepared engine.
      const obstacles = tracks.filter(
        (item) => item.layer === track.layer && item.netId !== track.netId,
      );
      const key = `${stage}:${track.netId}:${track.layer}:${track.width}`;
      const previous = routers.get(key);
      if (
        previous &&
        previous.tracks.length === obstacles.length &&
        previous.tracks.every((item, index) => item === obstacles[index])
      )
        return previous.router;
      const router = createPCBRouter(
        { ...artworkBoard, tracks: obstacles },
        {
          layer: track.layer,
          netId: track.netId,
          width: track.width,
          clearance,
          allowInheritedWidth: true,
        },
      );
      routers.set(key, { tracks: obstacles, router });
      // Keep one obstacle pose per setting, with bounded settings across a long
      // gesture. Eviction changes preparation work only.
      if (routers.size > 128) routers.delete(routers.keys().next().value!);
      return router;
    };
    const ids = new Map<string, string>();
    const idFor = (key: string) => {
      if (!ids.has(key)) ids.set(key, uid());
      return ids.get(key)!;
    };
    let work = 0;
    const spend = () => {
      if (++work > 2_000_000) throw new Error(limitMessage);
    };
    const anchors = borrowPCBTrackAnchors(board, { limitMessage });
    if (board.tracks.length + anchors.length > 15000) throw new Error(limitMessage);
    const tracksByNetLayer = new Map<string, Track[]>();
    for (const track of board.tracks) {
      const key = `${track.netId}:${track.layer}`,
        items = tracksByNetLayer.get(key) ?? [];
      items.push(track);
      tracksByNetLayer.set(key, items);
    }
    const anchorsByNetLayer = new Map<string, Anchor[]>();
    for (const anchor of anchors)
      for (const layer of anchor.layers) {
        const key = `${anchor.netId}:${layer}`,
          items = anchorsByNetLayer.get(key) ?? [];
        items.push(anchor);
        anchorsByNetLayer.set(key, items);
      }
    const relatedTracks = (track: Track) =>
      tracksByNetLayer.get(`${track.netId}:${track.layer}`) ?? [];
    const relatedAnchors = (track: Track) =>
      anchorsByNetLayer.get(`${track.netId}:${track.layer}`) ?? [];

    const breakpoints = new Map<string, Point[]>();
    const contactsFor = (track: Track) => {
      const cached = breakpoints.get(track.id);
      if (cached) return cached;
      const points = [track.start, track.end];
      for (const other of relatedTracks(track)) {
        spend();
        if (other.id === track.id || other.netId !== track.netId || other.layer !== track.layer)
          continue;
        if (
          segmentDistance(track.start, track.end, other.start, other.end) <=
          (track.width / 2 + other.width / 2 + epsilon) ** 2
        )
          points.push(closestTrackPoints(track, other)[0]);
      }
      for (const anchor of relatedAnchors(track)) {
        spend();
        if (anchor.netId !== track.netId || !anchor.layers.includes(track.layer)) continue;
        const contact = polygonContact(track, anchor.polygon, spend);
        if (contact) points.push(contact);
      }
      const dx = track.end.x - track.start.x,
        dy = track.end.y - track.start.y;
      const result = points
        .sort((a, b) => (a.x - b.x) * dx + (a.y - b.y) * dy)
        .filter((point, index, all) => !index || !same(point, all[index - 1]));
      breakpoints.set(track.id, result);
      return result;
    };

    const endpointKey = (track: Track, point: Point) =>
      `${track.netId}:${track.layer}:${point.x},${point.y}`;
    const endpoints = new Map<string, Track[]>();
    for (const track of board.tracks)
      for (const point of [track.start, track.end]) {
        const key = endpointKey(track, point),
          items = endpoints.get(key) ?? [];
        items.push(track);
        endpoints.set(key, items);
      }
    const continuations = new Map<string, Track | null>();
    const freeEnds = new Map<string, boolean>();
    const freeEndpoint = (track: Track, point: Point) => {
      const key = `${track.id}:${point.x},${point.y}`;
      if (freeEnds.has(key)) return freeEnds.get(key)!;
      const cap = { ...track, start: point, end: point };
      let free = true;
      for (const anchor of relatedAnchors(track)) {
        spend();
        if (
          anchor.netId === track.netId &&
          anchor.layers.includes(track.layer) &&
          polygonContact(cap, anchor.polygon, spend)
        ) {
          free = false;
          break;
        }
      }
      for (const other of free ? relatedTracks(track) : []) {
        spend();
        if (
          other.id !== track.id &&
          other.netId === track.netId &&
          other.layer === track.layer &&
          segmentDistance(point, point, other.start, other.end) <=
            (track.width / 2 + other.width / 2 + epsilon) ** 2
        ) {
          free = false;
          break;
        }
      }
      freeEnds.set(key, free);
      return free;
    };
    const continuation = (track: Track, point: Point) => {
      const key = endpointKey(track, point);
      if (continuations.has(key)) {
        const other = continuations.get(key);
        if (!other) return null;
        return other.id !== track.id
          ? other
          : ((endpoints.get(key) ?? []).find((item) => item.id !== track.id) ?? null);
      }
      const incident = endpoints.get(key) ?? [];
      const other = incident.find((item) => item.id !== track.id);
      if (incident.length !== 2 || !other || other.width !== track.width || !canShove(other)) {
        continuations.set(key, null);
        return null;
      }
      const cap = { ...track, start: point, end: point };
      for (const anchor of relatedAnchors(track)) {
        spend();
        if (
          anchor.netId === track.netId &&
          anchor.layers.includes(track.layer) &&
          polygonContact(cap, anchor.polygon, spend)
        ) {
          continuations.set(key, null);
          return null;
        }
      }
      for (const candidate of relatedTracks(track)) {
        spend();
        if (
          candidate.id === track.id ||
          candidate.id === other.id ||
          candidate.netId !== track.netId ||
          candidate.layer !== track.layer
        )
          continue;
        if (
          segmentDistance(point, point, candidate.start, candidate.end) <=
          (track.width / 2 + candidate.width / 2 + epsilon) ** 2
        ) {
          continuations.set(key, null);
          return null;
        }
      }
      continuations.set(key, other);
      return other;
    };
    const chainCache = new Map<string, Chain>();
    const chainFor = (track: Track): Chain => {
      const cached = chainCache.get(track.id);
      if (cached) return cached;
      const parts: ChainPart[] = [{ track, reversed: false }],
        seen = new Set([track.id]),
        jointKeys = new Set<string>();
      const grow = (prepend: boolean) => {
        for (;;) {
          const part = prepend ? parts[0] : parts.at(-1)!;
          const point = prepend
            ? part.reversed
              ? part.track.end
              : part.track.start
            : part.reversed
              ? part.track.start
              : part.track.end;
          const other = continuation(part.track, point);
          if (!other || seen.has(other.id)) return;
          if (seen.size >= 256) throw new Error(limitMessage);
          jointKeys.add(endpointKey(part.track, point));
          seen.add(other.id);
          const next = {
            track: other,
            reversed: prepend ? same(other.start, point) : same(other.end, point),
          };
          if (prepend) parts.unshift(next);
          else parts.push(next);
        }
      };
      grow(true);
      grow(false);
      const first = parts[0],
        last = parts.at(-1)!;
      const start = first.reversed ? first.track.end : first.track.start;
      const end = last.reversed ? last.track.start : last.track.end;
      if (same(start, end))
        throw new Error(
          'Track shove cannot reroute a closed unanchored loop. Select another track or break the loop first.',
        );
      const chain = { parts, jointKeys };
      for (const part of parts) chainCache.set(part.track.id, chain);
      return chain;
    };

    const body = (
      id: string,
      netId: string,
      points: Point[],
      radius: number,
      layers: string[],
      polygon?: Polygon,
    ): Body => {
      const edges: BodyEdge[] = [];
      const addEdge = (a: Point, b: Point) => {
        edges.push({
          points: [a, b],
          minX: Math.min(a.x, b.x),
          maxX: Math.max(a.x, b.x),
          minY: Math.min(a.y, b.y),
          maxY: Math.max(a.y, b.y),
        });
      };
      if (polygon) {
        const addRing = (ring: Point[]) => {
          for (let index = 0; index < ring.length; index++)
            addEdge(ring[index], ring[(index + 1) % ring.length]);
        };
        addRing(polygon.outer);
        for (const hole of polygon.holes) addRing(hole);
      } else addEdge(points[0], points.at(-1)!);
      let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity;
      for (const point of points) {
        minX = Math.min(minX, point.x);
        maxX = Math.max(maxX, point.x);
        minY = Math.min(minY, point.y);
        maxY = Math.max(maxY, point.y);
      }
      return {
        id,
        netId,
        points,
        radius,
        layers,
        polygon,
        edges,
        minX: minX - radius,
        maxX: maxX + radius,
        minY: minY - radius,
        maxY: maxY + radius,
      };
    };
    const originalBodies = new Map(
      board.tracks.map((track) => [
        track,
        body(track.id, track.netId, [track.start, track.end], track.width / 2, [track.layer]),
      ]),
    );
    const anchorBodies = anchors.map((anchor) =>
      body(anchor.id, anchor.netId, anchor.polygon.outer, 0, anchor.layers, anchor.polygon),
    );
    let stationaryPartition:
      | {
          bodies: Body[];
          nets: Map<string, Body[]>;
          contacts?: Map<string, ReturnType<typeof createPCBContactIntervals<Body>>>;
          groups: number[];
        }
      | undefined;
    const partition = (tracks: Track[], movingIds?: Set<string>) => {
      const fixed: Body[] = [],
        moving: Body[] = [];
      const bodies = tracks.map((track) => {
        const stationary = originalBodies.get(track);
        if (stationary && !movingIds?.has(track.id)) {
          fixed.push(stationary);
          return stationary;
        }
        const item =
          stationary ??
          body(track.id, track.netId, [track.start, track.end], track.width / 2, [track.layer]);
        moving.push(item);
        return item;
      });
      bodies.push(...anchorBodies);
      fixed.push(...anchorBodies);
      const parents = bodies.map((_, index) => index);
      const indexes = new Map<Body, number>();
      for (let index = 0; index < bodies.length; index++) indexes.set(bodies[index], index);
      const find = (value: number): number => {
        while (parents[value] !== value) {
          parents[value] = parents[parents[value]];
          value = parents[value];
        }
        return value;
      };
      const connect = (a: Body, b: Body) => {
        spend();
        if (
          a.netId !== b.netId ||
          a.maxX + epsilon < b.minX ||
          b.maxX + epsilon < a.minX ||
          a.maxY + epsilon < b.minY ||
          b.maxY + epsilon < a.minY ||
          !a.layers.some((layer) => b.layers.includes(layer))
        )
          return;
        const ai = indexes.get(a)!,
          bi = indexes.get(b)!;
        if (find(ai) === find(bi)) return;
        // A segment or polygon outer ring is connected. If another vertex is
        // inside while its representative is outside, their boundaries cross;
        // the exact edge test also covers holes and finite copper radii.
        let touches =
          Boolean(a.polygon && insidePolygon(b.points[0], a.polygon, spend)) ||
          Boolean(b.polygon && insidePolygon(a.points[0], b.polygon, spend));
        const radius = a.radius + b.radius + epsilon;
        if (!touches)
          outer: for (const first of a.edges)
            for (const second of b.edges) {
              spend();
              if (
                first.maxX + radius < second.minX ||
                second.maxX + radius < first.minX ||
                first.maxY + radius < second.minY ||
                second.maxY + radius < first.minY
              )
                continue;
              if (segmentDistance(...first.points, ...second.points) <= radius ** 2) {
                touches = true;
                break outer;
              }
            }
        if (touches) parents[find(bi)] = find(ai);
      };
      if (
        stationaryPartition &&
        fixed.length === stationaryPartition.bodies.length &&
        fixed.every((item, index) => item === stationaryPartition!.bodies[index])
      ) {
        for (let index = 0; index < fixed.length; index++)
          parents[indexes.get(fixed[index])!] = indexes.get(
            fixed[stationaryPartition.groups[index]],
          )!;
      } else {
        // Foreign nets cannot share a connectivity group. Keep all copper
        // layers within each net so through-pad/via bridges still participate,
        // then apply the same X sweep and exact contact predicates.
        const nets = new Map<string, Body[]>();
        for (const item of fixed) {
          const items = nets.get(item.netId) ?? [];
          items.push(item);
          nets.set(item.netId, items);
        }
        for (const sorted of nets.values()) {
          sorted.sort((a, b) => a.minX - b.minX);
          for (let i = 0; i < sorted.length; i++)
            for (
              let j = i + 1;
              j < sorted.length && sorted[j].minX <= sorted[i].maxX + epsilon;
              j++
            )
              connect(sorted[i], sorted[j]);
        }
        const fixedIndexes = new Map<number, number>();
        for (let index = 0; index < fixed.length; index++)
          fixedIndexes.set(indexes.get(fixed[index])!, index);
        let contacts: Map<string, ReturnType<typeof createPCBContactIntervals<Body>>> | undefined;
        for (const [netId, sorted] of nets)
          if (sorted.length > 64)
            (contacts ??= new Map()).set(netId, createPCBContactIntervals(sorted));
        stationaryPartition = {
          bodies: fixed,
          nets,
          contacts,
          groups: fixed.map((item) => fixedIndexes.get(find(indexes.get(item)!))!),
        };
      }
      // All stationary contacts are represented above. Every possible contact
      // involving a new/moved body is still checked with the same exact shape
      // predicates, including connections between different moved bodies.
      const sortedMoving = moving.slice().sort((a, b) => a.minX - b.minX);
      for (let index = 0; index < sortedMoving.length; index++) {
        const item = sortedMoving[index];
        // Preserve the X broad phase before charging exact-check work. Sparse
        // multilayer boards must not exhaust the budget on disjoint bodies.
        const indexed = stationaryPartition!.contacts?.get(item.netId);
        if (indexed) indexed(item.minX, item.maxX, epsilon, (other) => connect(item, other));
        else
          for (const other of stationaryPartition!.nets.get(item.netId) ?? []) {
            if (other.minX > item.maxX + epsilon) break;
            if (other.maxX + epsilon >= item.minX) connect(item, other);
          }
        for (
          let other = index + 1;
          other < sortedMoving.length && sortedMoving[other].minX <= item.maxX + epsilon;
          other++
        )
          connect(item, sortedMoving[other]);
      }
      const groups = new Map<string, number>();
      for (let index = 0; index < bodies.length; index++) groups.set(bodies[index].id, find(index));
      return groups;
    };
    let originalPartition: Map<string, number> | undefined;
    let fixedCaps: Track[] | undefined;

    let detourEngine: PreviewEngine | undefined;
    function checked(
      tracks: Track[],
      finalChanged: Track[],
      removedIds: Set<string>,
    ): PCBTrackDragPreview {
      const source = selected[0];
      const moved = finalChanged.find((track) => track.id === source?.id);
      if (!source || !moved)
        throw new Error('Track shove could not retain the selected track. Choose another segment.');
      for (const id of removedIds) {
        const track = original.get(id)!;
        if (
          selected.length !== 1 ||
          track.id === source.id ||
          track.locked ||
          track.netId !== source.netId ||
          track.layer !== source.layer ||
          track.width !== source.width ||
          !(['start', 'end'] as const).some((endpoint) =>
            (['start', 'end'] as const).some(
              (attached) =>
                same(source[endpoint], track[attached]) &&
                same(moved[endpoint], track[attached === 'start' ? 'end' : 'start']),
            ),
          )
        )
          throw new Error(connectionMessage);
      }

      if (tracks.length > 15000) throw new Error(limitMessage);
      const result = { ...board, tracks };
      for (const track of finalChanged) {
        const validator = retainedRouter('final', tracks, track);
        const issue = validator.validate([track.start, track.end], spend);
        if (issue) throw new Error(issue);
      }
      // Original and moved partitions use the same stationary subgraph on
      // the first preview. Check affected original spans separately too,
      // avoiding two preparations of the remaining fixed geometry.
      originalPartition ??= partition(
        board.tracks,
        new Set(finalChanged.map((track) => track.id).concat([...removedIds])),
      );
      const nextPartition = partition(tracks);
      const forwardGroups = new Map<number, number>(),
        reverseGroups = new Map<number, number>();
      for (const [id, before] of originalPartition) {
        if (removedIds.has(id)) continue;
        const after = nextPartition.get(id);
        if (
          after === undefined ||
          (forwardGroups.has(before) && forwardGroups.get(before) !== after) ||
          (reverseGroups.has(after) && reverseGroups.get(after) !== before)
        )
          throw new Error(
            'Track shove would change copper connectivity. Move less or choose another direction.',
          );
        forwardGroups.set(before, after);
        reverseGroups.set(after, before);
      }
      if ([...removedIds].some((id) => !forwardGroups.has(originalPartition!.get(id)!)))
        throw new Error(connectionMessage);
      return {
        board: result,
        error: '',
        changedIds: finalChanged.map((track) => track.id).concat([...removedIds]),
      };
    }

    return {
      preview(delta, posture = false) {
        try {
          work = 0;
          const proposed = engine.preview(delta, posture);
          if (proposed.error) throw new Error(proposed.error);
          if (!proposed.changedIds.length) return { board, error: '', changedIds: [] };
          const changedIds = new Set(proposed.changedIds);
          const proposedIds = new Set(proposed.board.tracks.map((track) => track.id));
          const removedIds = new Set(
            loose.tracks.filter((track) => !proposedIds.has(track.id)).map((track) => track.id),
          );
          const roots = proposed.board.tracks.filter((track) => changedIds.has(track.id));
          const source = selected[0],
            moved = roots.find((track) => track.id === source?.id);
          if (!source || !moved)
            throw new Error(
              'Track shove could not retain the selected track. Choose another segment.',
            );
          let movement = cursorMovement
            ? delta
            : { x: moved.start.x - source.start.x, y: moved.start.y - source.start.y };
          if (selected.length === 1) {
            // Sliding joints also travel along the source line. Only its normal
            // displacement defines which way neighbouring copper is pushed.
            const dx = source.end.x - source.start.x,
              dy = source.end.y - source.start.y,
              t = (-dy * movement.x + dx * movement.y) / (dx * dx + dy * dy);
            movement = { x: -dy * t, y: dx * t };
          }
          const length = Math.hypot(movement.x, movement.y);
          if (!length) throw new Error('Track shove needs nonzero normal movement.');
          const direction = { x: movement.x / length, y: movement.y / length };
          const projection = (point: Point) => point.x * direction.x + point.y * direction.y;
          const sweeps: Sweep[] = selected.flatMap((track) => {
            const next = roots.find((item) => item.id === track.id);
            if (!next) return [];
            const points = convexHull([track.start, track.end, next.start, next.end]);
            return points.length >= 2 ? [{ track, points }] : [];
          });
          const fixedSweepTracks = loose.tracks.filter((track) => !changedIds.has(track.id));
          for (const sweep of sweeps) {
            const validator = retainedRouter('sweep', fixedSweepTracks, sweep.track);
            const issue = validator.validateRegion(sweep.points, spend);
            if (issue) throw new Error(issue);
          }
          const collision = (a: Track, b: Track) => {
            spend();
            return (
              a.layer === b.layer &&
              a.netId !== b.netId &&
              segmentDistance(a.start, a.end, b.start, b.end) <
                (a.width / 2 + b.width / 2 + clearance + 0.002) ** 2
            );
          };
          const sweptCollision = (track: Track, sweep: Sweep) => {
            spend();
            if (track.layer !== sweep.track.layer || track.netId === sweep.track.netId)
              return false;
            const polygon = { outer: sweep.points, holes: [] };
            return (
              insidePolygon(track.start, polygon, spend) ||
              insidePolygon(track.end, polygon, spend) ||
              polygonEdges(polygon).some(([a, b]) => {
                spend();
                return (
                  segmentDistance(track.start, track.end, a, b) <
                  (track.width / 2 + sweep.track.width / 2 + clearance + 0.002) ** 2
                );
              })
            );
          };
          const accepted: Track[] = roots.slice();
          const replacements = new Map<string, Track[]>();
          const queued = new Set<string>(),
            queue: Chain[] = [];
          const enqueue = (track: Track) => {
            if (queued.has(track.id)) return;
            const chain = chainFor(track);
            if (queued.size + chain.parts.length > 256) throw new Error(limitMessage);
            for (const part of chain.parts) queued.add(part.track.id);
            queue.push(chain);
          };
          for (const track of candidates)
            if (
              roots.some((root) => collision(track, root)) ||
              sweeps.some((sweep) => sweptCollision(track, sweep))
            )
              enqueue(track);
          // Actual terminals remain fixed from the start of a cascade. Simple
          // degree-two joints may move with their unbranched same-width chain.
          const caps = queue.length
            ? (fixedCaps ??= candidates.flatMap((track) =>
                [track.start, track.end]
                  .filter((point) => !continuation(track, point) && !freeEndpoint(track, point))
                  .map((point) => ({ ...track, start: point, end: point })),
              ))
            : [];
          let sites = 0;
          while (queue.length) {
            const score = (chain: Chain) =>
              Math.min(...chain.parts.map((part) => projection(midpoint(part.track))));
            queue.sort((a, b) => score(a) - score(b));
            const chain = queue.shift()!,
              track = chain.parts[0].track;
            const nodes: { point: Point; fixed: boolean }[] = [];
            for (const part of chain.parts) {
              const points = contactsFor(part.track).slice();
              if (part.reversed) points.reverse();
              for (const point of points) {
                const fixed = !chain.jointKeys.has(endpointKey(part.track, point));
                const previous = nodes.at(-1);
                if (previous && same(previous.point, point)) previous.fixed ||= fixed;
                else nodes.push({ point, fixed });
              }
            }
            nodes[0].fixed = nodes.at(-1)!.fixed = true;
            const fixedNodes = nodes.flatMap((node, index) => (node.fixed ? [index] : []));
            sites += fixedNodes.length;
            if (sites > 512) throw new Error(limitMessage);
            const privateSweeps: BoardLine[] = sweeps
              .filter((sweep) => sweep.track.netId !== track.netId)
              .map((sweep) => ({
                id: `shove-sweep:${sweep.track.id}`,
                kind: 'polygon',
                start: sweep.points[0],
                end: sweep.points.at(-1)!,
                points: sweep.points.slice(1, -1),
                layer: sweep.track.layer,
                width: sweep.track.width,
                fill: true,
              }));
            const fixed = {
              ...artworkBoard,
              tracks: accepted.concat(caps),
              graphics: artworkBoard.graphics.concat(privateSweeps),
            };
            const router = createPCBRouter(fixed, {
              layer: track.layer,
              netId: track.netId,
              width: track.width,
              clearance,
              allowInheritedWidth: true,
            });
            for (const [node, part] of [
              [nodes[0], chain.parts[0]],
              [nodes.at(-1)!, chain.parts.at(-1)!],
            ] as const) {
              if (!freeEndpoint(part.track, node.point)) continue;
              const cap = { ...track, start: node.point, end: node.point };
              const blockers = accepted.filter((item) => collision(cap, item));
              const swept = sweeps.filter((sweep) => sweptCollision(cap, sweep));
              if (!blockers.length && !swept.length) continue;
              const forward =
                Math.max(
                  ...blockers.flatMap((item) =>
                    [item.start, item.end].map((point) => projection(point) + item.width / 2),
                  ),
                  ...swept.flatMap((sweep) =>
                    sweep.points.map((point) => projection(point) + sweep.track.width / 2),
                  ),
                ) +
                track.width / 2 +
                clearance +
                safety;
              const shift = Math.max(safety, forward - projection(node.point));
              let moved: Point | undefined;
              for (let attempt = 0; attempt < 8; attempt++) {
                const distance = shift + attempt * Math.max(track.width + clearance, 0.5);
                const target = round({
                  x: node.point.x + direction.x * distance,
                  y: node.point.y + direction.y * distance,
                });
                if (!routingBlocked(router.validate([target], spend))) {
                  moved = target;
                  break;
                }
              }
              if (!moved) throw new Error(blockedMessage);
              node.point = moved;
            }
            const path: Point[] = [nodes[0].point];
            for (let index = 1; index < fixedNodes.length; index++) {
              const points = nodes
                .slice(fixedNodes[index - 1], fixedNodes[index] + 1)
                .map((node) => node.point);
              const spans = points
                .slice(1)
                .map((point, at) => ({ ...track, start: points[at], end: point }));
              const blockers = accepted.filter((item) =>
                spans.some((span) => collision(span, item)),
              );
              const swept = sweeps.filter((sweep) =>
                spans.some((span) => sweptCollision(span, sweep)),
              );
              if (!blockers.length && !swept.length) {
                path.push(...points.slice(1));
                continue;
              }
              const forward =
                Math.max(
                  ...blockers.flatMap((item) =>
                    [item.start, item.end].map((point) => projection(point) + item.width / 2),
                  ),
                  ...swept.flatMap((sweep) =>
                    sweep.points.map((point) => projection(point) + sweep.track.width / 2),
                  ),
                ) +
                track.width / 2 +
                clearance +
                safety;
              const colliding = spans.find(
                (span) =>
                  blockers.some((item) => collision(span, item)) ||
                  swept.some((sweep) => sweptCollision(span, sweep)),
              )!;
              const center = midpoint(colliding),
                shift = Math.max(safety, forward - projection(center));
              let routed: Point[] | undefined;
              for (let attempt = 0; attempt < 8; attempt++) {
                spend();
                const distance = shift + attempt * Math.max(track.width + clearance, 0.5);
                const target = round({
                  x: center.x + direction.x * distance,
                  y: center.y + direction.y * distance,
                });
                const first = router.route(points[0], target, '45', posture, spend);
                if (first.blocked) {
                  routingBlocked(first.message);
                  continue;
                }
                const second = router.route(target, points.at(-1)!, '45', posture, spend);
                if (second.blocked) {
                  routingBlocked(second.message);
                  continue;
                }
                routed = first.points.concat(second.points.slice(1));
                break;
              }
              if (!routed) throw new Error(blockedMessage);
              path.push(...routed.slice(1));
            }
            // Every original segment keeps its identity, even when a reroute
            // simplifies a bend. Subdivision supplies enough nonzero legs.
            while (path.length - 1 < chain.parts.length) {
              let longest = 0;
              for (let index = 1; index < path.length; index++)
                if (
                  squaredDistance(path[index - 1], path[index]) >
                  squaredDistance(path[longest], path[longest + 1])
                )
                  longest = index - 1;
              const point = round({
                x: (path[longest].x + path[longest + 1].x) / 2,
                y: (path[longest].y + path[longest + 1].y) / 2,
              });
              if (same(point, path[longest]) || same(point, path[longest + 1]))
                throw new Error(collapsedMessage);
              path.splice(longest + 1, 0, point);
            }
            const tracks = path.slice(1).map((point, index) => ({
              ...(chain.parts[index]?.track ?? track),
              id: chain.parts[index]?.track.id ?? idFor(`${chain.parts[0].track.id}:${index}`),
              start: round(path[index]),
              end: round(point),
            }));
            if (!tracks.length || tracks.some((item) => same(item.start, item.end)))
              throw new Error(collapsedMessage);
            for (let index = 0; index < chain.parts.length; index++)
              replacements.set(
                chain.parts[index].track.id,
                index ? [tracks[index]] : [tracks[0], ...tracks.slice(chain.parts.length)],
              );
            accepted.push(...tracks);
            for (const other of candidates)
              if (!queued.has(other.id) && tracks.some((item) => collision(item, other)))
                enqueue(other);
          }
          const rootById = new Map(roots.map((track) => [track.id, track]));
          const tracks = board.tracks
            .flatMap((track) =>
              removedIds.has(track.id)
                ? []
                : [replacements.get(track.id)?.[0] ?? rootById.get(track.id) ?? track],
            )
            .concat(
              roots.filter((track) => !original.has(track.id)),
              [...replacements.values()].flatMap((items) => items.slice(1)),
            );
          return checked(tracks, roots.concat([...replacements.values()].flat()), removedIds);
        } catch (error) {
          const message = (error as Error).message;
          if (
            walkAround &&
            selected.length === 1 &&
            (message === blockedMessage ||
              message ===
                'Route blocked. Move around the obstacle or reduce the track width or clearance.' ||
              message ===
                'Connected drag would collapse or reverse a track. Move less or choose another direction.' ||
              message ===
                'Connected drag would collapse an attached track. Move less or choose another direction.')
          ) {
            try {
              const result = (detourEngine ??= walkAround()).preview(delta, posture);
              if (result.error) return failed(result.error);
              if (!result.changedIds.length) return { board, error: '', changedIds: [] };
              const changed = new Set(result.changedIds);
              const retained = new Set(result.board.tracks.map((track) => track.id));
              return checked(
                result.board.tracks,
                result.board.tracks.filter((track) => changed.has(track.id)),
                new Set(
                  board.tracks.filter((track) => !retained.has(track.id)).map((track) => track.id),
                ),
              );
            } catch (detourError) {
              return failed((detourError as Error).message);
            }
          }
          return failed(message);
        }
      },
    };
  } catch (error) {
    return { preview: () => failed((error as Error).message) };
  }
}
