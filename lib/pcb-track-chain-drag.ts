import { uid, type Point } from './circuit';
import type { PCB } from './pcb';
import { routePoints, type PCBSelection } from './pcb-layout';
import {
  pointSegmentDistance,
  segmentDistance,
  squaredDistance,
  trackTouchesPolygon,
} from './pcb-collision';
import { preparePCBTrackAnchors } from './pcb-track-anchors';
import { preparePCBArtworkObstacles } from './pcb-routing-artwork';
import { createPCBRouter } from './pcb-routing';
import type { PCBTrackDragPreview } from './pcb-track-drag';

type Track = PCB['tracks'][number];
type Part = { track: Track; forward: boolean };
const epsilon = 0.000001;
const same = (a: Point, b: Point) => squaredDistance(a, b) <= epsilon ** 2;
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const subtract = (a: Point, b: Point) => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const round = (p: Point) => ({ x: Number(p.x.toFixed(6)), y: Number(p.y.toFixed(6)) });
const limitMessage =
  'Connected drag exceeds the geometry limit. Select fewer tracks or simplify the board.';
const blockedMessage =
  'Route blocked. Move around the obstacle or reduce the track width or clearance.';

/** Reconfigure one unbranched, same-width line, retaining its remote terminals.
 * Eligibility is deliberately narrower than ordinary connected drag. Final Shove
 * validation still checks the complete copper partition before publication. */
export function createPCBTrackChainDrag(
  board: PCB,
  selections: readonly PCBSelection[],
  clearance: number,
  pickup?: Point,
  preservePickup = false,
):
  { leaderId?: string; preview(delta: Point, posture?: boolean): PCBTrackDragPreview } | undefined {
  const fail = (error: string): PCBTrackDragPreview => ({ board, changedIds: [], error });
  try {
    const selected = selections.map((s) =>
      board.tracks.find((t) => s.kind === 'track' && t.id === s.id),
    );
    if (!selected.length || selected.some((t) => !t || t.locked)) return;
    const tracks = selected as Track[];
    const leader = pickup
      ? tracks
          .slice()
          .sort(
            (a, b) =>
              pointSegmentDistance(pickup, a.start, a.end) -
              pointSegmentDistance(pickup, b.start, b.end),
          )[0]
      : tracks[0];
    if (
      tracks.some(
        (t) => t.netId !== leader.netId || t.layer !== leader.layer || t.width !== leader.width,
      )
    )
      return;
    const direction = subtract(leader.end, leader.start);
    if (Math.hypot(direction.x, direction.y) <= epsilon) return;
    if (
      Math.abs(direction.x) > epsilon &&
      Math.abs(direction.y) > epsilon &&
      Math.abs(Math.abs(direction.x) - Math.abs(direction.y)) > 0.00005
    )
      return;
    let work = 0;
    const spend = () => {
      if (++work > 2_000_000) throw new Error(limitMessage);
    };
    const anchors = preparePCBTrackAnchors(board, {
      netId: leader.netId,
      layer: leader.layer,
      centers: true,
      limitMessage,
    });
    const copper = board.tracks.filter((t) => t.netId === leader.netId && t.layer === leader.layer);
    const points = [leader.start, leader.end];
    const parts: Part[] = [{ track: leader, forward: true }];
    const included = new Set([leader.id]);
    let leaderIndex = 0;
    for (const before of [true, false]) {
      for (;;) {
        const endpoint = before ? points[0] : points.at(-1)!;
        const current = before ? parts[0].track : parts.at(-1)!.track;
        const cap = { ...current, start: endpoint, end: endpoint };
        if (
          anchors.some(
            (a) => same(a.center, endpoint) || trackTouchesPolygon(cap, a.polygon, spend),
          )
        )
          break;
        const incident = copper.filter((t) => {
          spend();
          return t.id !== current.id && (same(t.start, endpoint) || same(t.end, endpoint));
        });
        if (incident.length !== 1 || incident[0].locked || incident[0].width !== leader.width)
          break;
        const next = incident[0];
        if (included.has(next.id)) return;
        if (included.size >= 512) throw new Error(limitMessage);
        included.add(next.id);
        const other = same(next.start, endpoint) ? next.end : next.start;
        if (same(other, endpoint)) return;
        if (before) {
          parts.unshift({ track: next, forward: same(next.end, endpoint) });
          points.unshift(other);
          leaderIndex++;
        } else {
          parts.push({ track: next, forward: same(next.start, endpoint) });
          points.push(other);
        }
      }
    }
    if (tracks.some((t) => !included.has(t.id))) return;
    if (
      parts.some(({ track }) => {
        const dx = Math.abs(track.end.x - track.start.x);
        const dy = Math.abs(track.end.y - track.start.y);
        return dx > epsilon && dy > epsilon && Math.abs(dx - dy) > 0.00005;
      })
    )
      return;
    const first = points[0],
      last = points.at(-1)!;
    for (const part of parts) {
      const track = part.track;
      for (const anchor of anchors) {
        spend();
        if (!trackTouchesPolygon(track, anchor.polygon, spend)) continue;
        if (
          !same(anchor.center, first) &&
          !same(anchor.center, last) &&
          !trackTouchesPolygon({ ...track, start: first, end: first }, anchor.polygon, spend) &&
          !trackTouchesPolygon({ ...track, start: last, end: last }, anchor.polygon, spend)
        )
          return;
      }
      for (const other of copper) {
        spend();
        if (included.has(other.id)) continue;
        const radius = (track.width / 2 + other.width / 2 + epsilon) ** 2;
        if (segmentDistance(track.start, track.end, other.start, other.end) > radius) continue;
        if (
          pointSegmentDistance(first, other.start, other.end) > radius &&
          pointSegmentDistance(last, other.start, other.end) > radius
        )
          return;
      }
    }
    const router = createPCBRouter(
      preparePCBArtworkObstacles({
        ...board,
        tracks: board.tracks.filter((t) => !included.has(t.id)),
      }),
      {
        layer: leader.layer,
        netId: leader.netId,
        width: leader.width,
        clearance,
        allowInheritedWidth: true,
      },
    );
    const along = subtract(points[leaderIndex + 1], points[leaderIndex]);
    const unit = { x: Math.sign(along.x), y: Math.sign(along.y) };
    const rotated = [
      { x: unit.x - unit.y, y: unit.y + unit.x },
      { x: unit.x + unit.y, y: unit.y - unit.x },
    ];
    const aIndex = Math.max(0, leaderIndex - 1),
      bIndex = Math.min(points.length - 1, leaderIndex + 2);
    const a = points[aIndex],
      b = points[bIndex];
    const incoming = leaderIndex > 0 ? subtract(points[leaderIndex], a) : null;
    const outgoing = leaderIndex + 2 < points.length ? subtract(b, points[leaderIndex + 1]) : null;
    const startGuides =
      incoming && Math.abs(cross(incoming, along)) > epsilon && dot(incoming, along) >= -epsilon
        ? [incoming]
        : rotated;
    const endGuides =
      outgoing && Math.abs(cross(outgoing, along)) > epsilon && dot(outgoing, along) >= -epsilon
        ? [{ x: -outgoing.x, y: -outgoing.y }]
        : rotated.map((d) => ({ x: -d.x, y: -d.y }));
    const ids = new Map<number, string>();
    const compact = (path: Point[]) => path.filter((p, i) => i === 0 || !same(p, path[i - 1]));
    return {
      leaderId: leader.id,
      preview(delta, posture = false) {
        try {
          work = 0;
          if (![delta.x, delta.y].every((n) => Number.isFinite(n) && Math.abs(n) <= 200000))
            return fail('Connected drag coordinates are outside the supported range.');
          const amount = cross(along, delta) / dot(along, along);
          const movement = { x: -along.y * amount, y: along.x * amount };
          if (Math.hypot(movement.x, movement.y) < epsilon)
            return { board, error: '', changedIds: [] };
          const line = { x: leader.start.x + movement.x, y: leader.start.y + movement.y };
          const aim = pickup ?? {
            x: (leader.start.x + leader.end.x) / 2,
            y: (leader.start.y + leader.end.y) / 2,
          };
          const target = { x: aim.x + delta.x, y: aim.y + delta.y };
          const parameter = dot(subtract(target, line), along) / dot(along, along);
          const cursor = round({
            x: line.x + along.x * parameter,
            y: line.y + along.y * parameter,
          });
          const intersect = (origin: Point, guide: Point) => {
            const denominator = cross(guide, along);
            if (Math.abs(denominator) < 1e-12) return;
            const t = cross(subtract(line, origin), along) / denominator;
            if (t < -epsilon) return;
            return round({ x: origin.x + guide.x * t, y: origin.y + guide.y * t });
          };
          const length = (path: Point[]) =>
            path.slice(1).reduce((n, p, i) => n + Math.sqrt(squaredDistance(p, path[i])), 0);
          let path: Point[] | undefined;
          const groups = [
            [startGuides, endGuides],
            [
              [...startGuides, ...rotated],
              [...endGuides, ...rotated.map((d) => ({ x: -d.x, y: -d.y }))],
            ],
          ];
          for (const [starts, ends] of groups) {
            const candidates: Point[][] = [];
            for (const ga of posture ? starts.slice().reverse() : starts)
              for (const gb of posture ? ends.slice().reverse() : ends) {
                const p = intersect(a, ga),
                  q = intersect(b, gb);
                if (!p || !q || dot(subtract(q, p), along) <= epsilon) continue;
                let local = [a, p, q, b];
                if (
                  preservePickup &&
                  dot(subtract(cursor, p), along) > epsilon &&
                  dot(subtract(q, cursor), along) > epsilon
                ) {
                  if (!outgoing) local = [a, p, cursor, ...routePoints(cursor, b, '45').slice(1)];
                  else if (!incoming) local = [...routePoints(cursor, a, '45').reverse(), q, b];
                }
                candidates.push(
                  compact([...points.slice(0, aIndex), ...local, ...points.slice(bIndex + 1)]),
                );
              }
            candidates.sort((a, b) => length(a) - length(b));
            for (const candidate of candidates) {
              const result = router.walk(candidate, posture, spend);
              if (!result.blocked) {
                path = result.points.slice();
                break;
              }
              if (result.message !== blockedMessage) return fail(result.message);
            }
            if (path) break;
          }
          if (!path) return fail(blockedMessage);
          // Preserve every original UUID even when a bend disappears. Split a
          // surviving straight span rather than inventing zero-length copper.
          while (path.length - 1 < parts.length) {
            let longest = 0;
            for (let i = 1; i < path.length - 1; i++)
              if (
                squaredDistance(path[i], path[i + 1]) >
                squaredDistance(path[longest], path[longest + 1])
              )
                longest = i;
            const start = path[longest],
              end = path[longest + 1],
              middle = round({ x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 });
            if (same(start, middle) || same(middle, end)) return fail(blockedMessage);
            path.splice(longest + 1, 0, middle);
          }
          const replacements = new Map<string, Track>();
          const added: Track[] = [];
          for (let index = 0; index < path.length - 1; index++) {
            const part = parts[index];
            if (!part && !ids.has(index)) ids.set(index, uid());
            const source = part?.track ?? leader;
            const forward = part?.forward ?? true;
            const start = forward ? path[index] : path[index + 1];
            const end = forward ? path[index + 1] : path[index];
            const next = {
              ...source,
              id: part ? source.id : ids.get(index)!,
              start: { x: start.x, y: start.y },
              end: { x: end.x, y: end.y },
            };
            if (part) {
              if (
                start.x !== source.start.x ||
                start.y !== source.start.y ||
                end.x !== source.end.x ||
                end.y !== source.end.y
              )
                replacements.set(source.id, next);
            } else added.push(next);
          }
          const result = board.tracks.map((t) => replacements.get(t.id) ?? t).concat(added);
          if (result.length > 15000) return fail(limitMessage);
          if (!replacements.size && !added.length) return { board, error: '', changedIds: [] };
          return {
            board: { ...board, tracks: result },
            error: '',
            changedIds: [...replacements.keys(), ...added.map((t) => t.id)],
          };
        } catch (error) {
          return fail((error as Error).message);
        }
      },
    };
  } catch (error) {
    return { preview: () => fail((error as Error).message) };
  }
}
