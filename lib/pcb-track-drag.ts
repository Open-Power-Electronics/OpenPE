import { uid, type Point } from './circuit';
import type { PCB } from './pcb';
import {
  insidePolygon,
  pointSegmentDistance,
  polygonEdges,
  segmentDistance,
  squaredDistance,
  trackTouchesPolygon,
} from './pcb-collision';
import {
  closestTrackPoints,
  projectPointToTrack,
  routePoints,
  type PCBSelection,
} from './pcb-layout';
import { preparePCBTrackAnchors, type CenteredPCBTrackAnchor as Anchor } from './pcb-track-anchors';
import { createPCBRouter } from './pcb-routing';
import { preparePCBArtworkObstacles } from './pcb-routing-artwork';
import { createPCBTrackShove } from './pcb-track-shove';
import { isOwnedProjectNode } from './immutable-project';

type Track = PCB['tracks'][number];
type Link = {
  key: string;
  track: Track;
  point: Point;
  anchor: Point;
  terminal?: Anchor;
  contact?: Track;
};
type Stretch = { track: Track; start: boolean; end: boolean };
type Endpoint = 'start' | 'end';
type Slide = { stretch: Stretch; endpoint: Endpoint; attachedEndpoint: Endpoint };
export type PCBTrackDragPreview = {
  board: PCB;
  error: string;
  changedIds: string[];
  /** A freshly validated, bounded position for this exact cursor request. */
  constraint?: {
    basis: PCB;
    requestedDelta: Point;
    appliedDelta: Point;
    posture: boolean;
    reason: string;
  };
};
const collisionMessages = new Set([
  'Route blocked. Move around the obstacle or reduce the track width or clearance.',
  'Connected drag is blocked at a fixed terminal. Move less or choose another direction.',
  'Connected drag is blocked by another moved copper net. Move less or choose another direction.',
  'Track shove is blocked by fixed copper or board geometry. Move less or choose another direction.',
]);
const constraintMessages = new Set([
  ...collisionMessages,
  'Connected drag would collapse or reverse a track. Move less or choose another direction.',
  'Connected drag would collapse an attached track. Move less or choose another direction.',
  'Connected drag would lose a fixed terminal contact. Move less or choose another direction.',
  'Track shove would collapse a track. Move less or choose another direction.',
  'Track shove would remove a copper connection. Move less.',
  'Track shove would change copper connectivity. Move less or choose another direction.',
  'Track corner drag would collapse a segment. Move away from the adjoining endpoint.',
]);
const epsilon = 0.000001;
const limitMessage =
  'Connected drag exceeds the geometry limit. Select fewer tracks or simplify the board.';
const same = (a: Point, b: Point) => squaredDistance(a, b) <= epsilon ** 2;
const round = (p: Point): Point => ({ x: Number(p.x.toFixed(6)), y: Number(p.y.toFixed(6)) });
const translated = (p: Point, delta: Point) => round({ x: p.x + delta.x, y: p.y + delta.y });

/** Interactive boundary feedback. Ordinary preview/commands retain exact-pose
 * rejection. Revalidate the last displayed valid displacement, then probe toward
 * this request. No cached board can authorize a commit. The bounded search does
 * not promise a globally nearest point for nonmonotone rerouting geometry.
 */
export function previewConstrainedPCBTrackDrag(
  engine: { preview: (delta: Point, posture?: boolean) => PCBTrackDragPreview },
  basis: PCB,
  requestedDelta: Point,
  posture = false,
  previousDelta?: Point,
): PCBTrackDragPreview {
  const requested = engine.preview(requestedDelta, posture);
  if (
    !constraintMessages.has(requested.error) ||
    ![requestedDelta.x, requestedDelta.y].every(
      (value) => Number.isFinite(value) && Math.abs(value) <= 200000,
    )
  )
    return requested;
  let start: Point = { x: 0, y: 0 };
  let best: { preview: PCBTrackDragPreview; delta: Point } | undefined;
  if (
    previousDelta &&
    [previousDelta.x, previousDelta.y].every(
      (value) => Number.isFinite(value) && Math.abs(value) <= 200000,
    )
  ) {
    const previous = engine.preview(previousDelta, posture);
    if (!previous.error) {
      start = { ...previousDelta };
      if (previous.board !== basis && previous.changedIds.length)
        best = { preview: previous, delta: start };
    } else if (!constraintMessages.has(previous.error)) return requested;
  }
  if (!best) {
    const origin = engine.preview({ x: 0, y: 0 }, posture);
    if (origin.error || origin.board !== basis || origin.changedIds.length) return requested;
  }
  let lower = 0,
    upper = 1;
  for (let attempt = 0; attempt < 8; attempt++) {
    const fraction = (lower + upper) / 2;
    const delta = round({
      x: start.x + (requestedDelta.x - start.x) * fraction,
      y: start.y + (requestedDelta.y - start.y) * fraction,
    });
    const candidate = engine.preview(delta, posture);
    if (candidate.error) {
      // Setup, range and budget failures cannot authorize a held placement.
      if (!constraintMessages.has(candidate.error)) return requested;
      upper = fraction;
    } else {
      lower = fraction;
      if (candidate.board !== basis && candidate.changedIds.length)
        best = { preview: candidate, delta };
    }
  }
  if (!best) return requested;
  return {
    ...best.preview,
    constraint: {
      basis,
      requestedDelta: { x: requestedDelta.x, y: requestedDelta.y },
      appliedDelta: best.delta,
      posture,
      reason: requested.error,
    },
  };
}

function lineIntersection(a: Track, b: Track): Point | null {
  const ax = a.end.x - a.start.x,
    ay = a.end.y - a.start.y,
    bx = b.end.x - b.start.x,
    by = b.end.y - b.start.y,
    denominator = ax * by - ay * bx;
  if (Math.abs(denominator) <= 1e-10 * Math.hypot(ax, ay) * Math.hypot(bx, by)) return null;
  const t = ((b.start.x - a.start.x) * by - (b.start.y - a.start.y) * bx) / denominator;
  return round({ x: a.start.x + t * ax, y: a.start.y + t * ay });
}

function terminalJoint(track: Track, moved: Track, endpoint: Endpoint, anchor: Point) {
  const other = endpoint === 'start' ? 'end' : 'start',
    dx = track[other].x - track[endpoint].x,
    dy = track[other].y - track[endpoint].y;
  let joint: Point | null = null,
    alignment = -Infinity;
  // A perpendicular reconnect to the translated endpoint makes a right-angle
  // dogleg. Let the endpoint travel along the moved line instead, meeting the
  // closest forward H/V/45 ray from its fixed terminal.
  for (const [x, y] of [
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
    [0, -1],
    [1, -1],
  ]) {
    const dot = (dx * x + dy * y) / Math.hypot(x, y);
    if (dot <= epsilon || dot <= alignment) continue;
    const point = lineIntersection(moved, {
      ...track,
      start: anchor,
      end: { x: anchor.x + x, y: anchor.y + y },
    });
    if (!point || (point.x - anchor.x) * x + (point.y - anchor.y) * y <= epsilon) continue;
    joint = point;
    alignment = dot;
  }
  return joint;
}

function checkDirection(original: Track, next: Track) {
  if (
    same(next.start, next.end) ||
    (next.end.x - next.start.x) * (original.end.x - original.start.x) +
      (next.end.y - next.start.y) * (original.end.y - original.start.y) <=
      0
  )
    throw new Error(
      'Connected drag would collapse or reverse a track. Move less or choose another direction.',
    );
}
const cap = (track: Track, point: Point): Track => ({ ...track, start: point, end: point });
// A retained track's normalized copper identity is presentation-independent.
// Caller freezing does not establish ownership; changed preview tracks stay fresh.
const ownedCopperKeys = new WeakMap<Track, string>();
const copperKey = (track: Track) => {
  const reusable = isOwnedProjectNode(track);
  const cached = reusable ? ownedCopperKeys.get(track) : undefined;
  if (cached !== undefined) return cached;
  const ordered =
    track.start.x < track.end.x || (track.start.x === track.end.x && track.start.y <= track.end.y);
  const first = ordered ? track.start : track.end;
  const last = ordered ? track.end : track.start;
  const key = JSON.stringify([
    track.netId,
    track.layer,
    track.width,
    track.locked ?? null,
    first.x,
    first.y,
    last.x,
    last.y,
  ]);
  if (reusable) ownedCopperKeys.set(track, key);
  return key;
};

/** Connected copper drag owns a stable set of reconnect IDs and never mutates its basis.
 * Single-track joints slide along unbranched attached tracks; groups move rigidly.
 * A same-width simple neighbour may disappear when its fixed endpoint cap is
 * completely replaced by the moved span; locked tracks remain fixed.
 * Simple pad/via leads may reroute after contracting instead of reversing.
 * Other unbranched attached ends stretch, while all other
 * copper/pad/via anchors remain fixed and gain checked HV/45-degree reconnects.
 * Preview and commit consume the same returned board. Saved pours are not rebuilt.
 */
export function createPCBTrackDrag(
  board: PCB,
  selections: readonly PCBSelection[],
  options: { clearance: number; obstacleMode?: 'shove' | 'walk-around' },
): { preview: (delta: Point, posture?: boolean) => PCBTrackDragPreview } {
  if (options.obstacleMode === 'shove')
    return createPCBTrackShove(board, selections, options.clearance, (basis) =>
      createPCBTrackDrag(basis, selections, { clearance: options.clearance }),
    );
  const failed = (error: string): PCBTrackDragPreview => ({ board, error, changedIds: [] });
  try {
    if (!Number.isFinite(options.clearance) || options.clearance < 0.05 || options.clearance > 20)
      throw new Error('Choose a drag clearance from 0.05 to 20 mm.');
    const selectedIds = new Set(selections.map((selection) => selection.id));
    const selected = board.tracks.filter((track) => selectedIds.has(track.id));
    if (
      !selected.length ||
      selections.some((selection) => selection.kind !== 'track') ||
      selected.length !== selectedIds.size
    )
      throw new Error('Select existing tracks before starting connected drag.');
    if (selected.some((track) => track.locked))
      throw new Error('Unlock selected tracks before starting connected drag.');
    if (
      selected.length > 256 ||
      board.tracks.length +
        board.vias.length +
        board.footprints.reduce((n, f) => n + f.pads.length, 0) >
        15000
    )
      throw new Error(limitMessage);
    if (selected.some((track) => track.start.x === track.end.x && track.start.y === track.end.y))
      throw new Error('A zero-length track cannot define a drag direction.');
    let work = 0;
    const spend = () => {
      if (++work > 2_000_000) throw new Error(limitMessage);
    };
    // Only the selected tracks' nets/layers can supply attached terminals.
    // Filter before constructing pad/via polygons on the common single-net
    // gesture; foreign geometry remains in every collision router below.
    const anchors = preparePCBTrackAnchors(board, {
      limitMessage,
      centers: true,
      netId: selected.every((track) => track.netId === selected[0].netId)
        ? selected[0].netId
        : undefined,
      layer: selected.every((track) => track.layer === selected[0].layer)
        ? selected[0].layer
        : undefined,
    });
    const attachedAnchors = (track: Track) =>
      anchors.filter(
        (anchor) =>
          anchor.netId === track.netId &&
          anchor.layers.includes(track.layer) &&
          trackTouchesPolygon(track, anchor.polygon, spend),
      );
    const unselected = board.tracks.filter((track) => !selectedIds.has(track.id));
    const stretchable = new Map<string, boolean>();
    const stretchAnchors = new Map<string, Anchor[]>();
    const terminalStubs = new Set<string>();
    const canStretch = (track: Track, end: 'start' | 'end') => {
      const key = `${track.id}:${end}`;
      if (stretchable.has(key)) return stretchable.get(key)!;
      if (track.locked) {
        stretchable.set(key, false);
        return false;
      }
      const fixed = cap(track, end === 'start' ? track.end : track.start);
      let allowed = true;
      for (const other of selected) {
        spend();
        if (
          other.netId !== track.netId ||
          other.layer !== track.layer ||
          segmentDistance(track.start, track.end, other.start, other.end) >
            (track.width / 2 + other.width / 2 + epsilon) ** 2
        )
          continue;
        const [contact, counterpart] = closestTrackPoints(track, other);
        if (
          !same(contact, counterpart) ||
          (!same(contact, track.start) && !same(contact, track.end))
        ) {
          allowed = false;
          break;
        }
      }
      for (const other of allowed ? unselected : []) {
        spend();
        if (other.id === track.id || other.netId !== track.netId || other.layer !== track.layer)
          continue;
        const distance = (track.width / 2 + other.width / 2 + epsilon) ** 2;
        if (
          segmentDistance(track.start, track.end, other.start, other.end) <= distance &&
          pointSegmentDistance(fixed.start, other.start, other.end) > distance
        ) {
          allowed = false;
          break;
        }
      }
      if (allowed) {
        const terminals: Anchor[] = [];
        for (const anchor of attachedAnchors(track)) {
          terminals.push(anchor);
          if (trackTouchesPolygon(fixed, anchor.polygon, spend)) continue;
          if (!same(fixed.start, anchor.center)) {
            allowed = false;
            break;
          }
        }
        // A pad/via centre can lie inside its drill, so the endpoint cap
        // alone need not touch copper. Its straight lead may still slide;
        // every resulting lead must retain the actual annular contact below.
        if (allowed && terminals.length) {
          stretchAnchors.set(track.id, terminals);
          // Supported pad/via envelopes are convex. Classify the whole copper
          // capsule, ignoring its drill only here; actual annular contact is
          // still checked after routing. Hidden starter stubs do not dictate
          // the angle of a lead that becomes exposed during a drag.
          if (
            terminals.some((anchor) => {
              const envelope = { outer: anchor.polygon.outer, holes: [] };
              return (
                insidePolygon(track.start, envelope, spend) &&
                insidePolygon(track.end, envelope, spend) &&
                polygonEdges(envelope).every(([a, b]) => {
                  spend();
                  return (
                    segmentDistance(track.start, track.end, a, b) >=
                    Math.max(0, track.width / 2 - epsilon) ** 2
                  );
                })
              );
            })
          )
            terminalStubs.add(track.id);
        }
      }
      stretchable.set(key, allowed);
      return allowed;
    };
    const links = new Map<string, Link>();
    const stretches = new Map<string, Stretch>();
    const addLink = (
      track: Track,
      point: Point,
      anchor: Point,
      terminal?: Anchor,
      contact?: Track,
    ) => {
      const key = `${track.id}:${point.x},${point.y}:${anchor.x},${anchor.y}`;
      links.set(key, { key, track, point, anchor, terminal, contact });
      if (links.size + stretches.size > 512) throw new Error(limitMessage);
    };
    for (const track of selected) {
      for (const other of unselected) {
        spend();
        if (
          other.netId !== track.netId ||
          other.layer !== track.layer ||
          segmentDistance(track.start, track.end, other.start, other.end) >
            (track.width / 2 + other.width / 2 + epsilon) ** 2
        )
          continue;
        const [point, anchor] = closestTrackPoints(track, other);
        const end = same(anchor, other.start) ? 'start' : same(anchor, other.end) ? 'end' : null;
        if (
          end &&
          same(point, anchor) &&
          (same(point, track.start) || same(point, track.end)) &&
          canStretch(other, end)
        ) {
          const stretch = stretches.get(other.id) ?? { track: other, start: false, end: false };
          stretch[end] = true;
          stretches.set(other.id, stretch);
        } else addLink(track, point, anchor, undefined, other);
      }
      for (const anchor of attachedAnchors(track))
        addLink(track, projectPointToTrack(track, anchor.center), anchor.center, anchor);
    }
    if (selected.length === 1)
      for (const [key, link] of links) {
        if (
          (!link.terminal && !link.contact) ||
          (link.contact && stretches.has(link.contact.id)) ||
          (!same(link.point, link.track.start) && !same(link.point, link.track.end))
        )
          continue;
        for (const stretch of stretches.values()) {
          spend();
          if (
            stretch.start === stretch.end ||
            !same(link.point, stretch.track[stretch.start ? 'start' : 'end'])
          )
            continue;
          const fixed = stretch.track[stretch.start ? 'end' : 'start'];
          if (link.terminal) {
            // The neighbour already owns this terminal lead. Keeping a second
            // link pins the selected joint and grows a dangling reconnect when
            // the terminal trims the moved span. Drilled-centre leads are
            // checked against their actual annular copper after sliding below.
            if (
              trackTouchesPolygon(cap(stretch.track, fixed), link.terminal.polygon, spend) ||
              stretchAnchors
                .get(stretch.track.id)
                ?.some((anchor) => anchor.id === link.terminal!.id)
            ) {
              links.delete(key);
              break;
            }
            continue;
          }
          if (!link.contact) continue;
          const radius = stretch.track.width / 2 + link.contact.width / 2 + epsilon;
          // The simple neighbour already preserves this same-net contact at its
          // unmoving cap. Reconnecting it again from the selected endpoint would
          // pin that joint and introduce unnecessary doglegs or loops. The fixed
          // target and neighbour cap remain in every accepted preview, including
          // a checked collapse that replaces the cap with the selected span.
          if (pointSegmentDistance(fixed, link.contact.start, link.contact.end) <= radius ** 2) {
            links.delete(key);
            break;
          }
        }
      }
    const slides: Slide[] = [];
    if (selected.length === 1) {
      const track = selected[0];
      for (const endpoint of ['start', 'end'] as const) {
        // Only a simple bend can slide. Direct pads, shared/width contacts and
        // parallel continuations retain checked reconnects at the translated point.
        const attached = [...stretches.values()].filter(
          (stretch) =>
            stretch.start !== stretch.end &&
            same(track[endpoint], stretch.track[stretch.start ? 'start' : 'end']),
        );
        if (
          attached.length === 1 &&
          ![...links.values()].some((link) => same(link.point, track[endpoint])) &&
          lineIntersection(track, attached[0].track)
        )
          slides.push({
            stretch: attached[0],
            endpoint,
            attachedEndpoint: attached[0].start ? 'start' : 'end',
          });
      }
    }
    const affectedIds = new Set([...selectedIds, ...stretches.keys()]);
    const obstacleBoard = preparePCBArtworkObstacles({
      ...board,
      tracks: board.tracks.filter((track) => !affectedIds.has(track.id)),
    });
    const engines = new Map<string, ReturnType<typeof createPCBRouter>>();
    const engineFor = (track: Track) => {
      const key = `${track.netId}:${track.layer}:${track.width}`;
      let engine = engines.get(key);
      if (!engine) {
        engine = createPCBRouter(obstacleBoard, {
          layer: track.layer,
          netId: track.netId,
          width: track.width,
          clearance: options.clearance,
          allowInheritedWidth: true,
        });
        engines.set(key, engine);
      }
      return engine;
    };
    for (const track of [...selected, ...[...stretches.values()].map((item) => item.track)])
      engineFor(track);
    const ids = new Map<string, string>();
    const idFor = (key: string) => {
      if (!ids.has(key)) ids.set(key, uid());
      return ids.get(key)!;
    };
    return {
      preview(delta, posture = false) {
        try {
          if (
            ![delta.x, delta.y].every(
              (value) => Number.isFinite(value) && Math.abs(value) <= 200000,
            )
          )
            return failed('Connected drag coordinates are outside the supported range.');
          let movement = delta;
          if (selected.length === 1) {
            const track = selected[0],
              dx = track.end.x - track.start.x,
              dy = track.end.y - track.start.y,
              t = (-dy * delta.x + dx * delta.y) / (dx * dx + dy * dy);
            movement = { x: -dy * t, y: dx * t };
          }
          movement = round(movement);
          if (!movement.x && !movement.y) return { board, error: '', changedIds: [] };
          work = 0;
          const replacements = new Map<string, Track[]>(),
            rerouted = new Set<string>(),
            added: Track[] = [],
            addedBySelected = new Map<string, Track[]>();
          const route = (
            track: Track,
            start: Point,
            end: Point,
            key: string,
            preserveId: boolean,
            preferStraight = false,
            terminalArrival?: Point,
            reverse = false,
          ) => {
            if (same(start, end)) {
              if (preserveId)
                throw new Error(
                  'Connected drag would collapse an attached track. Move less or choose another direction.',
                );
              return [];
            }
            const engine = engineFor(track);
            let result =
              preferStraight && !engine.validate([start, end], spend)
                ? { points: [start, end], blocked: false, message: '' }
                : engine.route(start, end, '45', posture, spend, 'omit');
            // This call terminates the preview on failure; no clipped head is
            // displayed or used by a later retry. Retried detours keep clipping.
            if (result.blocked) throw new Error(result.message);
            if (terminalArrival) {
              const dx = terminalArrival.x,
                dy = terminalArrival.y,
                directionLength = Math.hypot(dx, dy),
                length = Math.hypot(end.x - start.x, end.y - start.y);
              const arrives = (points: Point[]) => {
                const previous = points.at(-2);
                return (
                  previous &&
                  Math.abs((end.x - previous.x) * dy - (end.y - previous.y) * dx) <=
                    epsilon * directionLength &&
                  (end.x - previous.x) * dx + (end.y - previous.y) * dy > 0
                );
              };
              if (!arrives(result.points)) {
                // Both direct postures are equally short. Prefer the one that
                // reaches the moved span along its forward terminal ray before
                // adding any obstacle detour or shortened arrival tail.
                for (const flipped of [posture, !posture]) {
                  const points = flipped
                    ? routePoints(end, start, '45').reverse()
                    : routePoints(start, end, '45');
                  if (arrives(points) && !engine.validate(points, spend)) {
                    result = { points, blocked: false, message: '' };
                    break;
                  }
                }
                // Detours must retain the chosen forward terminal ray at the
                // moved span instead of reintroducing a perpendicular last leg.
                let tail = Math.min(length / 2, Math.max(track.width, options.clearance)),
                  connected = arrives(result.points);
                for (let attempt = 0; !connected && attempt < 8; attempt++, tail /= 2) {
                  const approach = round({
                    x: end.x - (dx * tail) / directionLength,
                    y: end.y - (dy * tail) / directionLength,
                  });
                  if (same(approach, end)) break;
                  const issue = engine.validate([approach, end], spend);
                  if (issue) {
                    if (!collisionMessages.has(issue)) throw new Error(issue);
                    continue;
                  }
                  const detour = engine.route(start, approach, '45', posture, spend);
                  if (detour.blocked) {
                    if (!collisionMessages.has(detour.message)) throw new Error(detour.message);
                    continue;
                  }
                  result = { ...detour, points: [...detour.points, end] };
                  connected = true;
                  break;
                }
                if (!connected)
                  throw new Error(
                    'Connected drag is blocked at a fixed terminal. Move less or choose another direction.',
                  );
              }
            }
            const points = reverse ? result.points.slice().reverse() : result.points;
            return points.slice(1).map((point, i) => ({
              ...track,
              id: preserveId && i === 0 ? track.id : idFor(`${key}:${i}`),
              start: { x: points[i].x, y: points[i].y },
              end: { x: point.x, y: point.y },
            }));
          };
          for (const track of selected) {
            const next = {
              ...track,
              start: translated(track.start, movement),
              end: translated(track.end, movement),
            };
            const translatedTrack = { ...next };
            const terminalSlides: { slide: Slide; joint: Point | null }[] = [];
            for (const slide of slides) {
              const point = lineIntersection(translatedTrack, slide.stretch.track)!;
              const attached = { ...slide.stretch.track, [slide.attachedEndpoint]: point };
              const direction =
                (attached.end.x - attached.start.x) *
                  (slide.stretch.track.end.x - slide.stretch.track.start.x) +
                (attached.end.y - attached.start.y) *
                  (slide.stretch.track.end.y - slide.stretch.track.start.y);
              if (
                (direction < 0 || terminalStubs.has(attached.id)) &&
                !(same(attached.start, attached.end) && attached.width === track.width) &&
                stretchAnchors.has(attached.id)
              ) {
                // A simple terminal lead can take a new posture after contraction
                // or when its hidden starter geometry becomes exposed.
                // Its fixed cap still owns every stationary contact;
                // reroute it to the final moved endpoint instead of reversing
                // the old lead or pinning the drag at a tiny pad-contained span.
                const fixed = attached[slide.attachedEndpoint === 'start' ? 'end' : 'start'];
                const joint = terminalJoint(track, translatedTrack, slide.endpoint, fixed);
                if (joint) next[slide.endpoint] = joint;
                terminalSlides.push({ slide, joint });
                continue;
              }
              next[slide.endpoint] = point;
              if (same(attached.start, attached.end) && attached.width === track.width) {
                // canStretch has proved that every retained contact of this
                // simple neighbour touches its fixed endpoint cap. The moved
                // same-width span now supplies that exact cap itself.
                replacements.set(attached.id, []);
              } else {
                checkDirection(slide.stretch.track, attached);
                replacements.set(attached.id, [attached]);
              }
            }
            if (selected.length === 1)
              for (const endpoint of ['start', 'end'] as const) {
                const interior = endpoint === 'start' ? 'end' : 'start',
                  dx = track[interior].x - track[endpoint].x,
                  dy = track[interior].y - track[endpoint].y;
                for (const link of links.values()) {
                  spend();
                  if (
                    !link.terminal ||
                    !same(link.point, track[endpoint]) ||
                    trackTouchesPolygon(next, link.terminal.polygon, spend)
                  )
                    continue;
                  const joint = terminalJoint(track, translatedTrack, endpoint, link.anchor);
                  if (
                    joint &&
                    (joint.x - next[endpoint].x) * dx + (joint.y - next[endpoint].y) * dy > 0
                  )
                    next[endpoint] = joint;
                }
              }
            if (terminalSlides.length === 2) {
              const dx = track.end.x - track.start.x,
                dy = track.end.y - track.start.y,
                length = Math.hypot(dx, dy),
                minimum = Math.min(length, track.width),
                span =
                  ((next.end.x - next.start.x) * dx + (next.end.y - next.start.y) * dy) / length;
              if (span < minimum) {
                // Opposing terminal rays share the available run. Retain a
                // width-long spine and let the leads add perpendicular departure
                // arms plus 45-degree arrivals, rather than crossing the joints
                // or leaving an arbitrarily small sliver between them.
                const center = {
                  x: (next.start.x + next.end.x) / 2,
                  y: (next.start.y + next.end.y) / 2,
                };
                next.start = round({
                  x: center.x - (dx * minimum) / (2 * length),
                  y: center.y - (dy * minimum) / (2 * length),
                });
                next.end = round({
                  x: center.x + (dx * minimum) / (2 * length),
                  y: center.y + (dy * minimum) / (2 * length),
                });
              }
            }
            checkDirection(track, next);
            const issue = engineFor(track).validate([next.start, next.end], spend);
            if (issue) throw new Error(issue);
            replacements.set(track.id, [next]);
            for (const { slide, joint: preferred } of terminalSlides) {
              const lead = slide.stretch.track,
                fixed = lead[slide.attachedEndpoint === 'start' ? 'end' : 'start'],
                joint = next[slide.endpoint];
              replacements.set(
                lead.id,
                route(
                  lead,
                  fixed,
                  joint,
                  `stretch:${lead.id}`,
                  true,
                  Boolean(preferred && same(preferred, joint)),
                  preferred ? { x: preferred.x - fixed.x, y: preferred.y - fixed.y } : undefined,
                  slide.attachedEndpoint === 'start',
                ),
              );
              rerouted.add(lead.id);
            }
          }
          for (const stretch of stretches.values()) {
            if (rerouted.has(stretch.track.id)) continue;
            if (replacements.get(stretch.track.id)?.length === 0) continue;
            const sliding = replacements.get(stretch.track.id)?.[0];
            if (sliding) {
              replacements.set(
                stretch.track.id,
                route(sliding, sliding.start, sliding.end, `stretch:${sliding.id}`, true, true),
              );
              continue;
            }
            if (stretch.start && stretch.end) {
              const next = {
                ...stretch.track,
                start: translated(stretch.track.start, movement),
                end: translated(stretch.track.end, movement),
              };
              const issue = engineFor(stretch.track).validate([next.start, next.end], spend);
              if (issue) throw new Error(issue);
              replacements.set(stretch.track.id, [next]);
              continue;
            }
            replacements.set(
              stretch.track.id,
              route(
                stretch.track,
                stretch.start ? translated(stretch.track.start, movement) : stretch.track.start,
                stretch.end ? translated(stretch.track.end, movement) : stretch.track.end,
                `stretch:${stretch.track.id}`,
                true,
              ),
            );
          }
          for (const link of links.values()) {
            const moved = replacements.get(link.track.id)![0];
            if (link.terminal && trackTouchesPolygon(moved, link.terminal.polygon, spend)) continue;
            const endpoint = same(link.point, link.track.start)
                ? 'start'
                : same(link.point, link.track.end)
                  ? 'end'
                  : null,
              joint =
                link.terminal && selected.length === 1 && endpoint
                  ? terminalJoint(link.track, moved, endpoint, link.anchor)
                  : null;
            const reconnects = route(
              link.track,
              link.anchor,
              projectPointToTrack(moved, translated(link.point, movement)),
              `link:${link.key}`,
              false,
              false,
              joint ? { x: joint.x - link.anchor.x, y: joint.y - link.anchor.y } : undefined,
            );
            added.push(...reconnects);
            const connected = addedBySelected.get(link.track.id) ?? [];
            connected.push(...reconnects);
            addedBySelected.set(link.track.id, connected);
          }
          for (const [id, terminals] of stretchAnchors) {
            const stretch = stretches.get(id)!;
            // A shortened or removed neighbour can share its terminal
            // contact with the selected span. Check their actual copper,
            // including the part outside a pad/via's drill.
            const retained = replacements
              .get(id)!
              .concat(
                selected.flatMap((track) =>
                  track.netId === stretch.track.netId &&
                  track.layer === stretch.track.layer &&
                  ((stretch.start &&
                    (same(track.start, stretch.track.start) ||
                      same(track.end, stretch.track.start))) ||
                    (stretch.end &&
                      (same(track.start, stretch.track.end) || same(track.end, stretch.track.end))))
                    ? replacements.get(track.id)!.concat(addedBySelected.get(track.id) ?? [])
                    : [],
                ),
              );
            for (const terminal of terminals)
              if (!retained.some((track) => trackTouchesPolygon(track, terminal.polygon, spend)))
                throw new Error(
                  'Connected drag would lose a fixed terminal contact. Move less or choose another direction.',
                );
          }
          const retained = board.tracks.flatMap((track) =>
            replacements.has(track.id) ? replacements.get(track.id)! : [track],
          );
          const copper = new Set(retained.map(copperKey));
          const reconnects = added.filter((track) => {
            const key = copperKey(track);
            if (copper.has(key)) return false;
            copper.add(key);
            return true;
          });
          const changed = [...replacements.values()].flat().concat(reconnects);
          for (let i = 0; i < changed.length; i++)
            for (let j = i + 1; j < changed.length; j++) {
              spend();
              const a = changed[i],
                b = changed[j];
              if (a.netId === b.netId || a.layer !== b.layer) continue;
              if (
                segmentDistance(a.start, a.end, b.start, b.end) <
                (a.width / 2 + b.width / 2 + options.clearance + 0.002) ** 2
              )
                throw new Error(
                  'Connected drag is blocked by another moved copper net. Move less or choose another direction.',
                );
            }
          const tracks = board.tracks
            .flatMap((track) =>
              replacements.has(track.id) ? replacements.get(track.id)!.slice(0, 1) : [track],
            )
            .concat(
              [...replacements.values()].flatMap((items) => items.slice(1)),
              reconnects,
            );
          if (tracks.length > 15000) throw new Error(limitMessage);
          return {
            board: { ...board, tracks },
            error: '',
            changedIds: changed
              .map((track) => track.id)
              .concat([...replacements].filter(([, items]) => !items.length).map(([id]) => id)),
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
