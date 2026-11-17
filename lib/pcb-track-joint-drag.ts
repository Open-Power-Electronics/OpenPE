import { uid, type Point } from './circuit';
import type { PCB } from './pcb';
import {
  insidePolygon,
  polygonEdges,
  segmentDistance,
  squaredDistance,
  trackTouchesPolygon,
} from './pcb-collision';
import { closestTrackPoints, projectPointToTrack } from './pcb-layout';
import { preparePCBTrackAnchors, type CenteredPCBTrackAnchor as Anchor } from './pcb-track-anchors';
import { createPCBRouter } from './pcb-routing';
import { preparePCBArtworkObstacles } from './pcb-routing-artwork';
import type { PCBTrackDragPreview } from './pcb-track-drag';

type Track = PCB['tracks'][number];
type Breakpoint = { point: Point; parameter: number; moving: boolean };
type Link = { key: string; track: Track; anchor: Point };
export type PCBTrackJointDrag = {
  anchor: Point;
  affectedIds: string[];
  kind: 'joint' | 'bend';
  preview: (delta: Point) => PCBTrackDragPreview;
};
const epsilon = 0.000001;
const same = (a: Point, b: Point) => squaredDistance(a, b) <= epsilon ** 2;
const round = (p: Point): Point => ({ x: Number(p.x.toFixed(6)), y: Number(p.y.toFixed(6)) });
const limitMessage =
  'Track corner drag exceeds the geometry limit. Choose a smaller joint or simplify the board.';
function polygonContact(track: Track, item: Anchor, spend: () => void): Point {
  const projected = projectPointToTrack(track, item.center);
  if (insidePolygon(projected, item.polygon, spend)) return projected;
  const contacts: Point[] = [];
  for (const point of [track.start, track.end])
    if (insidePolygon(point, item.polygon, spend)) contacts.push(point);
  for (const [start, end] of polygonEdges(item.polygon)) {
    spend();
    const [point, edge] = closestTrackPoints(track, { ...track, start, end });
    if (squaredDistance(point, edge) <= (track.width / 2 + epsilon) ** 2) contacts.push(point);
  }
  return (
    contacts.sort((a, b) => squaredDistance(a, projected) - squaredDistance(b, projected))[0] ??
    projected
  );
}
const parameter = (track: Track, point: Point) => {
  const dx = track.end.x - track.start.x,
    dy = track.end.y - track.start.y;
  return ((point.x - track.start.x) * dx + (point.y - track.start.y) * dy) / (dx * dx + dy * dy);
};

/** Free-angle corner editing changes straight arms directly, with collision checks.
 * Existing shared endpoints move together; interior pickup introduces one bend.
 * Other physical contacts remain fixed breakpoints or direct reconnect terminals.
 * No detours, shove, fill regeneration or mutation occurs during preparation/preview.
 */
export function createPCBTrackJointDrag(
  board: PCB,
  trackId: string,
  pickup: Point,
  options: { clearance: number; endpointTolerance?: number },
): PCBTrackJointDrag {
  const failed = (error: string): PCBTrackDragPreview => ({ board, error, changedIds: [] });
  const fallback = [pickup.x, pickup.y].every(Number.isFinite) ? pickup : { x: 0, y: 0 };
  try {
    const seed = board.tracks.find((track) => track.id === trackId),
      tolerance = options.endpointTolerance ?? epsilon;
    if (!seed) throw new Error('Choose an existing track before dragging a corner.');
    if (seed.locked) throw new Error('Unlock selected tracks before dragging a corner.');
    if (![pickup.x, pickup.y].every((value) => Number.isFinite(value) && Math.abs(value) <= 100000))
      throw new Error('Track corner pickup coordinates are outside the supported range.');
    if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 200000)
      throw new Error('Choose a finite nonnegative endpoint pickup tolerance.');
    if (!Number.isFinite(options.clearance) || options.clearance < 0.05 || options.clearance > 20)
      throw new Error('Choose a drag clearance from 0.05 to 20 mm.');
    if (same(seed.start, seed.end)) throw new Error('A zero-length track cannot define a corner.');
    const nearest = [seed.start, seed.end].sort(
      (a, b) => squaredDistance(a, pickup) - squaredDistance(b, pickup),
    )[0];
    const anchor =
      squaredDistance(nearest, pickup) <= tolerance ** 2
        ? nearest
        : projectPointToTrack(seed, pickup);
    const kind = same(anchor, seed.start) || same(anchor, seed.end) ? 'joint' : 'bend';
    const edited =
      kind === 'bend'
        ? [seed]
        : board.tracks.filter(
            (track) =>
              track.netId === seed.netId &&
              track.layer === seed.layer &&
              !track.locked &&
              (same(track.start, anchor) || same(track.end, anchor)),
          );
    const editedIds = new Set(edited.map((track) => track.id));
    if (
      edited.length > 256 ||
      board.tracks.length +
        board.vias.length +
        board.footprints.reduce((n, f) => n + f.pads.length, 0) >
        15000
    )
      throw new Error(limitMessage);
    if (edited.some((track) => same(track.start, track.end)))
      throw new Error('A zero-length track cannot define a corner.');
    let work = 0,
      sites = 0;
    const spend = () => {
      if (++work > 2_000_000) throw new Error(limitMessage);
    };
    const spendSite = () => {
      if (++sites > 512) throw new Error(limitMessage);
    };
    const anchors = preparePCBTrackAnchors(board, {
      limitMessage,
      netId: seed.netId,
      layer: seed.layer,
      centers: true,
    });
    const breakpoints = new Map<string, Breakpoint[]>();
    const links = new Map<string, Link>();
    const addLink = (track: Track, at: Point) => {
      const key = `${track.width}:${at.x},${at.y}`;
      if (!links.has(key)) {
        spendSite();
        links.set(key, { key, track, anchor: at });
      }
    };
    for (const track of edited) {
      const points: Breakpoint[] = [
        { point: track.start, parameter: 0, moving: same(track.start, anchor) },
        { point: track.end, parameter: 1, moving: same(track.end, anchor) },
      ];
      if (kind === 'bend')
        points.push({ point: anchor, parameter: parameter(track, anchor), moving: true });
      const fixed = (point: Point, other: Point) => {
        if (same(point, anchor)) {
          addLink(track, other);
          return;
        }
        if (points.some((item) => same(item.point, point))) return;
        spendSite();
        points.push({ point, parameter: parameter(track, point), moving: false });
      };
      for (const other of board.tracks) {
        spend();
        if (
          editedIds.has(other.id) ||
          other.netId !== seed.netId ||
          other.layer !== seed.layer ||
          segmentDistance(track.start, track.end, other.start, other.end) >
            (track.width / 2 + other.width / 2 + epsilon) ** 2
        )
          continue;
        const [point, originalAnchor] = closestTrackPoints(track, other);
        fixed(point, originalAnchor);
      }
      for (const item of anchors) {
        spend();
        if (!trackTouchesPolygon(track, item.polygon, spend)) continue;
        fixed(polygonContact(track, item, spend), item.center);
      }
      points.sort((a, b) => a.parameter - b.parameter);
      breakpoints.set(track.id, points);
    }
    const obstacleBoard = preparePCBArtworkObstacles({
      ...board,
      tracks: board.tracks.filter((track) => !editedIds.has(track.id)),
    });
    const engines = new Map<number, ReturnType<typeof createPCBRouter>>();
    for (const track of edited)
      if (!engines.has(track.width))
        engines.set(
          track.width,
          createPCBRouter(obstacleBoard, {
            layer: seed.layer,
            netId: seed.netId,
            width: track.width,
            clearance: options.clearance,
            allowInheritedWidth: true,
          }),
        );
    const ids = new Map<string, string>();
    const idFor = (key: string) => {
      if (!ids.has(key)) ids.set(key, uid());
      return ids.get(key)!;
    };
    return {
      anchor,
      affectedIds: edited.map((track) => track.id),
      kind,
      preview(delta) {
        try {
          if (
            ![delta.x, delta.y].every(
              (value) => Number.isFinite(value) && Math.abs(value) <= 200000,
            )
          )
            return failed('Track corner coordinates are outside the supported range.');
          const moved = round({ x: anchor.x + delta.x, y: anchor.y + delta.y });
          if (same(moved, anchor)) return { board, error: '', changedIds: [] };
          work = 0;
          const retained = new Map<string, Track>(),
            added: Track[] = [],
            changed: Track[] = [];
          const checked = (original: Track, start: Point, end: Point, id: string): Track => {
            if (same(start, end))
              throw new Error(
                'Track corner drag would collapse a segment. Move away from the adjoining endpoint.',
              );
            const issue = engines.get(original.width)!.validate([start, end], spend);
            if (issue) throw new Error(issue);
            return {
              ...original,
              id,
              start: { x: start.x, y: start.y },
              end: { x: end.x, y: end.y },
            };
          };
          for (const track of edited) {
            const points = breakpoints
              .get(track.id)!
              .map((point) => (point.moving ? moved : point.point));
            for (let i = 1; i < points.length; i++) {
              const next = checked(
                track,
                points[i - 1],
                points[i],
                i === 1 ? track.id : idFor(`split:${track.id}:${i}`),
              );
              if (i === 1) retained.set(track.id, next);
              else added.push(next);
              changed.push(next);
            }
          }
          for (const link of links.values()) {
            if (same(link.anchor, moved)) continue;
            const next = checked(link.track, link.anchor, moved, idFor(`link:${link.key}`));
            added.push(next);
            changed.push(next);
          }
          const tracks = board.tracks.map((track) => retained.get(track.id) ?? track).concat(added);
          if (tracks.length > 15000) throw new Error(limitMessage);
          return {
            board: { ...board, tracks },
            error: '',
            changedIds: changed.map((track) => track.id),
          };
        } catch (error) {
          return failed((error as Error).message);
        }
      },
    };
  } catch (error) {
    return {
      anchor: fallback,
      affectedIds: [],
      kind: 'bend',
      preview: () => failed((error as Error).message),
    };
  }
}
