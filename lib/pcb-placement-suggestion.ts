import type { Point } from './circuit';
import { insidePolygon, polygonEdges, segmentDistance } from './pcb-collision';
import { analyzePCBConnectivity, type Airwire } from './pcb-connectivity';
import { defaultPCBDisplay, pcbFootprintBodyBounds } from './pcb-display';
import { createPCBFootprintDrag } from './pcb-footprint-drag';
import { footprintPoint, padPosition, type PCBBounds, type PCBSelection } from './pcb-layout';
import { boardPolygons, worldZones, type Polygon } from './pcb-polygons';
import type { Footprint, Pad, PCB } from './pcb';

const quarterTurns = [0, 90, -90, 180];
const geometryDisplay = defaultPCBDisplay();
const edgeTolerance = 0.000001;

function boundsOf(points: readonly Point[]): PCBBounds {
  return points.reduce(
    (box, { x, y }) => ({
      minX: Math.min(box.minX, x),
      maxX: Math.max(box.maxX, x),
      minY: Math.min(box.minY, y),
      maxY: Math.max(box.maxY, y),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
}
const cornersOf = ({ minX, maxX, minY, maxY }: PCBBounds) => [
  { x: minX, y: minY },
  { x: maxX, y: minY },
  { x: maxX, y: maxY },
  { x: minX, y: maxY },
];
const overlaps = (a: PCBBounds, b: PCBBounds, gap = 0) =>
  a.minX < b.maxX + gap && a.maxX + gap > b.minX && a.minY < b.maxY + gap && a.maxY + gap > b.minY;
const includes = (box: PCBBounds, { x, y }: Point, tolerance = 0) =>
  x >= box.minX - tolerance &&
  x <= box.maxX + tolerance &&
  y >= box.minY - tolerance &&
  y <= box.maxY + tolerance;
const dimensions = (box: PCBBounds) => ({ x: box.maxX - box.minX, y: box.maxY - box.minY });
const centerOf = (box: PCBBounds) => ({
  x: (box.minX + box.maxX) / 2,
  y: (box.minY + box.maxY) / 2,
});
const areaOf = (box: PCBBounds) => (box.maxX - box.minX) * (box.maxY - box.minY);
const centroid = (points: readonly Point[]) => ({
  x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
  y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
});
const translate = (box: PCBBounds, { x, y }: Point): PCBBounds => ({
  minX: x + box.minX,
  maxX: x + box.maxX,
  minY: y + box.minY,
  maxY: y + box.maxY,
});

function footprintBounds(board: PCB, part: Footprint) {
  const local = pcbFootprintBodyBounds(board, part, geometryDisplay);
  return local && boundsOf(cornersOf(local).map((point) => footprintPoint(part, point)));
}

function region(polygon: Polygon) {
  const bounds = boundsOf(polygon.outer);
  const edges = polygonEdges(polygon).map(([start, end]) => ({
    start,
    end,
    bounds: boundsOf([start, end]),
  }));
  return {
    bounds,
    edgeCount: edges.length,
    containsPoint: (point: Point) => includes(bounds, point) && insidePolygon(point, polygon),
    touchesBoundary(box: PCBBounds, corners: Point[]) {
      return edges.some(
        ({ start, end, bounds }) =>
          overlaps(bounds, box, edgeTolerance) &&
          (includes(box, start, edgeTolerance) ||
            corners.some(
              (point, i) =>
                segmentDistance(start, end, point, corners[(i + 1) % corners.length]) <=
                edgeTolerance ** 2,
            )),
      );
    },
  };
}

type Region = ReturnType<typeof region>;

function intersectsRegion(polygon: Region, box: PCBBounds, corners: Point[]) {
  return (
    overlaps(polygon.bounds, box, edgeTolerance) &&
    (corners.some(polygon.containsPoint) || polygon.touchesBoundary(box, corners))
  );
}

function placementGeometry(board: PCB, spacing: number) {
  let polygons: Polygon[];
  try {
    polygons = boardPolygons(board);
  } catch {
    return null;
  }
  const islands = polygons.map(region);
  const footprintKeepouts = worldZones(board).filter(({ keepout }) => keepout?.footprints);
  if (footprintKeepouts.some((zone) => zone.nativeCircularOutline || zone.nativeOutlineArcs))
    return null;
  const keepouts = footprintKeepouts.map(({ outline, holes }) =>
    region({ outer: outline, holes: holes ?? [] }),
  );
  if (
    islands.length > 8 ||
    [...islands, ...keepouts].reduce((count, item) => count + item.edgeCount, 0) > 1024
  )
    return null;

  const pitch = Math.max(
    spacing,
    ...islands.map(({ bounds }) => {
      const { x, y } = dimensions(bounds);
      return Math.max(x, y) / 16;
    }),
  );
  const points = islands.flatMap(({ bounds }) => {
    const { x, y } = dimensions(bounds);
    const step = Math.max(spacing, Math.max(x, y) / 16);
    const columns = Math.max(2, Math.ceil(x / step));
    const rows = Math.max(2, Math.ceil(y / step));
    return Array.from({ length: columns * rows }, (_, i) => ({
      x: bounds.minX + (((i % columns) + 0.5) * x) / columns,
      y: bounds.minY + ((Math.floor(i / columns) + 0.5) * y) / rows,
    }));
  });
  const largest = islands.reduce((a, b) => (areaOf(a.bounds) >= areaOf(b.bounds) ? a : b));
  return {
    points,
    pitch,
    center: centerOf(largest.bounds),
    outside(box: PCBBounds) {
      const corners = cornersOf(box);
      return !islands.some((island) => intersectsRegion(island, box, corners));
    },
    fits(box: PCBBounds) {
      const corners = cornersOf(box);
      return (
        islands.some(
          (island) => corners.every(island.containsPoint) && !island.touchesBoundary(box, corners),
        ) && !keepouts.some((keepout) => intersectsRegion(keepout, box, corners))
      );
    },
  };
}

type Geometry = NonNullable<ReturnType<typeof placementGeometry>>;
type PadOwner = { part: Footprint; pad: Pad };
type Link = { pad: Pad; peer: PadOwner };

function placementLinks(board: PCB, ids: ReadonlySet<string>, edges: readonly Airwire[]) {
  const owners = new Map(
    board.footprints.flatMap((part) => part.pads.map((pad) => [pad.id, { part, pad }] as const)),
  );
  const links = new Map<string, Link[]>();
  function add(from: PadOwner, to: PadOwner) {
    if (!ids.has(from.part.id)) return;
    const list = links.get(from.part.id) ?? [];
    list.push({ pad: from.pad, peer: to });
    links.set(from.part.id, list);
  }
  for (const { startPadId, endPadId } of edges) {
    const from = owners.get(startPadId);
    const to = owners.get(endPadId);
    if (!from || !to || from.part.id === to.part.id) continue;
    add(from, to);
    add(to, from);
  }
  return links;
}

type Connection = { pad: Pad; point: Point };
type Target = { part: Footprint; body: PCBBounds; links: Link[]; fixedCount: number };

function groupAirwireLength(board: PCB, targets: Target[], ids: ReadonlySet<string>) {
  const poses = new Map(board.footprints.map((part) => [part.id, part]));
  return targets.reduce((total, { part, links }) => {
    const current = poses.get(part.id)!;
    return links.reduce((sum, { pad, peer }) => {
      const a = padPosition(current, pad);
      const b = padPosition(poses.get(peer.part.id)!, peer.pad);
      return sum + Math.hypot(a.x - b.x, a.y - b.y) * (ids.has(peer.part.id) ? 0.5 : 1);
    }, total);
  }, 0);
}

function rankPoses(
  board: PCB,
  part: Footprint,
  connections: Connection[],
  occupied: PCBBounds[],
  focus: Point,
  geometry: Geometry,
  spacing: number,
  clearance: number,
) {
  const snap = (value: number) => Number((Math.round(value / spacing) * spacing).toFixed(6));
  const probes = quarterTurns.flatMap((turn) => {
    const rotated = { ...part, x: 0, y: 0, rotation: part.rotation + turn };
    const body = footprintBounds(board, rotated);
    if (!body) return [];
    const anchors = connections.map(({ pad, point }) => ({
      local: padPosition(rotated, pad),
      point,
    }));
    const ideal = anchors.length
      ? centroid(
          anchors.map(({ local, point }) => ({ x: point.x - local.x, y: point.y - local.y })),
        )
      : focus;
    const seen = new Set<string>();
    const poses: { x: number; y: number; turn: number; cost: number }[] = [];
    const add = (px: number, py: number) => {
      const x = snap(px);
      const y = snap(py);
      const key = x + ',' + y;
      if (seen.has(key)) return;
      seen.add(key);
      const box = translate(body, { x, y });
      if (occupied.some((other) => overlaps(box, other, clearance)) || !geometry.fits(box)) return;
      const length = anchors.reduce(
        (sum, { local, point }) => sum + Math.hypot(x + local.x - point.x, y + local.y - point.y),
        0,
      );
      const cost =
        length / Math.max(1, anchors.length) +
        Math.hypot(x - ideal.x, y - ideal.y) * (anchors.length ? 0.04 : 1);
      poses.push({ x, y, turn, cost });
    };
    for (const { x, y } of geometry.points) add(x, y);
    const patch = (at: Point, step: number) => {
      for (let i = -2; i <= 2; i++)
        for (let j = -2; j <= 2; j++) add(at.x + i * step, at.y + j * step);
    };
    patch(ideal, Math.max(spacing, geometry.pitch / 2));
    // Try the free sides of nearby packages, where a uniform grid can miss a narrow pocket.
    const nearest = occupied
      .map((box) => ({ box, center: centerOf(box) }))
      .sort(
        (a, b) =>
          Math.hypot(a.center.x - ideal.x, a.center.y - ideal.y) -
          Math.hypot(b.center.x - ideal.x, b.center.y - ideal.y),
      )
      .slice(0, 12);
    for (const { box, center } of nearest) {
      const gap = clearance + spacing / 2;
      for (const y of [center.y - (body.minY + body.maxY) / 2, ideal.y, box.minY - body.minY]) {
        add(box.minX - body.maxX - gap, y);
        add(box.maxX - body.minX + gap, y);
      }
      for (const x of [center.x - (body.minX + body.maxX) / 2, ideal.x, box.minX - body.minX]) {
        add(x, box.minY - body.maxY - gap);
        add(x, box.maxY - body.minY + gap);
      }
    }
    const best = poses.sort((a, b) => a.cost - b.cost).slice(0, 5);
    for (const pose of best) patch(pose, Math.max(spacing, geometry.pitch / 4));
    return poses;
  });
  return probes.sort((a, b) => a.cost - b.cost);
}

function placementShortlist(
  ranked: ReturnType<typeof rankPoses>,
  spacing: number,
  boardPitch: number,
) {
  const limit = 24;
  const pitch = spacing * 2;
  const regionPitch = Math.max(pitch, boardPitch);
  const cell = ({ x, y }: Point, size: number) => Math.floor(x / size) + ',' + Math.floor(y / size);
  const nearbyCells = new Map<string, number>();
  const regions = new Set<string>();
  const shortlist = new Set<(typeof ranked)[number]>();
  for (const pose of ranked) {
    const tile = cell(pose, pitch);
    const visits = nearbyCells.get(tile) ?? 0;
    if (visits >= 2) continue;
    nearbyCells.set(tile, visits + 1);
    regions.add(cell(pose, regionPitch));
    shortlist.add(pose);
    if (shortlist.size === limit / 3) break;
  }
  // Keep some exact checks for different parts of the board when many of the
  // nearest poses share the same hidden copper obstacles.
  for (const pose of ranked) {
    const region = cell(pose, regionPitch);
    if (regions.has(region)) continue;
    regions.add(region);
    shortlist.add(pose);
    if (shortlist.size === limit) return shortlist;
  }
  for (const pose of ranked) {
    shortlist.add(pose);
    if (shortlist.size === limit) break;
  }
  return shortlist;
}

function placeGroup(
  board: PCB,
  targets: Target[],
  ids: ReadonlySet<string>,
  bodies: ReadonlyMap<string, PCBBounds>,
  focus: Point,
  geometry: Geometry,
  spacing: number,
  clearance: number,
) {
  const placed = new Map<string, Footprint>();
  const boxes = new Map(bodies);
  const offsets = new Map<string, Point>();
  let next = board;
  for (const { part, links } of targets) {
    const drag = createPCBFootprintDrag(next, [{ kind: 'footprint', id: part.id }], clearance);
    if (!drag.leadIds || drag.leadIds.length) return null;
    const connections = links.flatMap(({ pad, peer }) => {
      const pose = ids.has(peer.part.id) ? placed.get(peer.part.id) : peer.part;
      return pose ? [{ pad, point: padPosition(pose, peer.pad) }] : [];
    });
    const occupied = board.footprints.flatMap((other) => {
      const body = boxes.get(other.id);
      return body && other.side === part.side && (!ids.has(other.id) || placed.has(other.id))
        ? [body]
        : [];
    });
    const probes = rankPoses(
      board,
      part,
      connections,
      occupied,
      focus,
      geometry,
      spacing,
      clearance,
    );
    for (const { x, y, turn } of placementShortlist(probes, spacing, geometry.pitch)) {
      const preview = drag.preview({ x: x - part.x, y: y - part.y }, undefined, turn);
      if (!preview.error && preview.changedIds.length) {
        const pose = preview.board.footprints.find(({ id }) => id === part.id)!;
        const body = footprintBounds(board, pose);
        if (
          body &&
          geometry.fits(body) &&
          !occupied.some((item) => overlaps(body, item, clearance))
        ) {
          boxes.set(part.id, body);
          placed.set(part.id, pose);
          offsets.set(part.id, { x: pose.x - part.x, y: pose.y - part.y });
          next = { ...next, footprints: next.footprints.map((f) => (f.id === part.id ? pose : f)) };
          break;
        }
      }
    }
    if (!placed.has(part.id)) return null;
  }
  return { board: next, offsets };
}

/** Prepare a complete on-board placement for an unrouted group outside the board. */
export function suggestPCBPlacement(
  board: PCB,
  selection: readonly PCBSelection[],
  airwires: readonly Airwire[] | undefined,
  spacing: number,
  clearance = 0.25,
) {
  const ids = new Set(selection.filter(({ kind }) => kind === 'footprint').map(({ id }) => id));
  if (ids.size < 2 || ids.size > 8 || !Number.isFinite(spacing) || spacing <= 0) return null;
  const objectCount =
    board.graphics.length +
    board.zones.length +
    board.tracks.length +
    board.vias.length +
    board.footprints.reduce(
      (count, f) => count + 1 + f.pads.length + f.graphics.length + (f.zones?.length ?? 0),
      0,
    );
  if (objectCount > 6000) return null;
  const geometry = placementGeometry(board, spacing);
  if (!geometry) return null;

  const bodies = new Map(
    board.footprints.flatMap((part) => {
      const body = footprintBounds(board, part);
      return body ? [[part.id, body] as const] : [];
    }),
  );
  const links = placementLinks(board, ids, airwires ?? analyzePCBConnectivity(board).edges);
  const selected: Target[] = [];
  for (const part of board.footprints) {
    if (!ids.has(part.id)) continue;
    const body = bodies.get(part.id);
    if (
      !body ||
      !geometry.outside(body) ||
      part.locked ||
      part.zones?.length ||
      part.graphics.some(({ layer }) => layer === 'Edge.Cuts' || layer.endsWith('.Cu'))
    )
      return null;
    const connections = links.get(part.id) ?? [];
    const fixedCount = connections.filter(({ peer }) => !ids.has(peer.part.id)).length;
    selected.push({ part, body, links: connections, fixedCount });
  }
  if (selected.length !== ids.size) return null;
  const anchors = selected.flatMap(({ links }) =>
    links.flatMap(({ peer }) => (ids.has(peer.part.id) ? [] : [padPosition(peer.part, peer.pad)])),
  );
  const focus = anchors.length ? centroid(anchors) : geometry.center;
  const largestFirst = [...selected].sort(
    (a, b) => areaOf(b.body) - areaOf(a.body) || b.fixedCount - a.fixedCount,
  );
  const place = (order: Target[]) =>
    placeGroup(board, order, ids, bodies, focus, geometry, spacing, clearance);
  const primary = place(largestFirst);
  const anchoredFirst = [...selected].sort(
    (a, b) => b.fixedCount - a.fixedCount || areaOf(b.body) - areaOf(a.body),
  );
  if (anchoredFirst.every((target, i) => target === largestFirst[i])) return primary;
  const alternative = place(anchoredFirst);
  if (!primary || !alternative) return primary ?? alternative;
  return groupAirwireLength(alternative.board, selected, ids) <
    groupAirwireLength(primary.board, selected, ids)
    ? alternative
    : primary;
}
