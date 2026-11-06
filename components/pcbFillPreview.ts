import type { BoardLayer, BoardZone, Footprint, Pad, PCB } from '../lib/pcb';
import { padDrillPosition } from '../lib/pcb-layout';
import {
  defaultCopperFillClearance,
  padPolygon,
  polygonPath,
  worldZones,
} from '../lib/pcb-polygons';
import type { Point } from '../lib/circuit';
import { isOwnedProjectNode } from '../lib/immutable-project';

export type PCBFillPreview = {
  changed: boolean;
  zones: {
    id: string;
    layer: BoardLayer;
    netId: string | null;
    outline: string;
    needsMask: boolean;
    blockers: { path: string; strokeWidth: number }[];
  }[];
};

const samePoint = (a: Point, b: Point) => a.x === b.x && a.y === b.y;
const sameTrack = (a: PCB['tracks'][number] | undefined, b: PCB['tracks'][number]) =>
  a !== undefined &&
  (a === b ||
    (a.netId === b.netId &&
      a.layer === b.layer &&
      a.width === b.width &&
      samePoint(a.start, b.start) &&
      samePoint(a.end, b.end)));
const sameVia = (a: PCB['vias'][number] | undefined, b: PCB['vias'][number]) =>
  a !== undefined &&
  (a === b ||
    (samePoint(a, b) && a.netId === b.netId && a.diameter === b.diameter && a.drill === b.drill));
const samePose = (a: Footprint, b: Footprint) =>
  samePoint(a, b) && a.rotation === b.rotation && a.side === b.side;
function padGeometry(pad: Pad) {
  return [
    pad.x,
    pad.y,
    pad.rotation,
    pad.type,
    pad.shape,
    pad.size,
    pad.drill,
    pad.drillOffset,
    pad.netId,
    pad.layers,
    pad.roundrectRatio,
    pad.chamferRatio,
    pad.chamfer,
    pad.zoneConnect,
  ];
}
const samePad = (a: Pad | undefined, b: Pad) =>
  a !== undefined && (a === b || JSON.stringify(padGeometry(a)) === JSON.stringify(padGeometry(b)));
const circlePath = (point: Point, radius: number) =>
  `M ${point.x - radius} ${point.y} A ${radius} ${radius} 0 1 0 ${point.x + radius} ${point.y} A ${radius} ${radius} 0 1 0 ${point.x - radius} ${point.y} Z`;
// These keys are private stripped/transformed outlines, never caller zones.
const outlinePaths = new WeakMap<BoardZone, string>();
const outlineBounds = new WeakMap<BoardZone, Bounds>();
function outlinePath(zone: BoardZone) {
  let path = outlinePaths.get(zone);
  if (path === undefined) {
    path = polygonPath([{ outer: zone.outline, holes: zone.holes ?? [] }]);
    outlinePaths.set(zone, path);
  }
  return path;
}
function zoneBounds(zone: BoardZone) {
  let bounds = outlineBounds.get(zone);
  if (!bounds) {
    bounds = boundsOf(zone.outline);
    outlineBounds.set(zone, bounds);
  }
  return bounds;
}
const localZones = (board: PCB) => [
  ...board.zones,
  ...board.footprints.flatMap((footprint) => footprint.zones ?? []),
];
type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
function boundsOf(points: Point[]): Bounds {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const point of points) {
    bounds.minX = Math.min(bounds.minX, point.x);
    bounds.minY = Math.min(bounds.minY, point.y);
    bounds.maxX = Math.max(bounds.maxX, point.x);
    bounds.maxY = Math.max(bounds.maxY, point.y);
  }
  return bounds;
}
const inflate = (bounds: Bounds, amount: number): Bounds => ({
  minX: bounds.minX - amount,
  minY: bounds.minY - amount,
  maxX: bounds.maxX + amount,
  maxY: bounds.maxY + amount,
});
const circleBounds = (point: Point, radius: number) => inflate(boundsOf([point]), radius);
const overlaps = (a: Bounds, b: Bounds) =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
const sameRing = (a: Point[], b: Point[]) =>
  a === b || (a.length === b.length && a.every((point, index) => samePoint(point, b[index])));
const sameOutline = (a: BoardZone | undefined, b: BoardZone) =>
  a !== undefined &&
  sameRing(a.outline, b.outline) &&
  (a.holes ?? []).length === (b.holes ?? []).length &&
  (a.holes ?? []).every((ring, index) => sameRing(ring, b.holes![index]));
function boundaryInputs(board: PCB) {
  const edges = (graphics: PCB['graphics']) =>
    graphics
      .filter((graphic) => graphic.layer === 'Edge.Cuts')
      .map(({ locked: _locked, ...graphic }) => graphic);
  return [
    edges(board.graphics),
    board.footprints.flatMap((footprint) => {
      const graphics = edges(footprint.graphics);
      return graphics.length
        ? [[footprint.x, footprint.y, footprint.rotation, footprint.side, graphics]]
        : [];
    }),
  ];
}

// Transform only outlines. Saved contours can contain 60,000 vertices and never
// participate in this conservative display-only mask preparation.
type ZoneOutlines = {
  zones: BoardZone[];
  byId: Map<string, BoardZone>;
  keys: Map<BoardZone, string>;
};
// One footprint variant per exact owned zone array; track poses retain these
// sources. Mutable and caller-frozen containers always rebuild private outlines.
const zoneOutlines = new WeakMap<
  PCB['zones'],
  { footprints: PCB['footprints']; value: ZoneOutlines }
>();
function outlineZones(board: PCB) {
  const reusable = isOwnedProjectNode(board.zones) && isOwnedProjectNode(board.footprints);
  const saved = reusable ? zoneOutlines.get(board.zones) : undefined;
  if (saved?.footprints === board.footprints) return saved.value;
  const stripFill = ({ filledPolygons: _filled, ...zone }: BoardZone) => zone;
  const zones = worldZones({
    ...board,
    zones: board.zones.map(stripFill),
    footprints: board.footprints.map((footprint) =>
      footprint.zones ? { ...footprint, zones: footprint.zones.map(stripFill) } : footprint,
    ),
  });
  const value: ZoneOutlines = {
    zones,
    byId: new Map(zones.map((zone) => [zone.id, zone])),
    keys: new Map(zones.map((zone) => [zone, JSON.stringify(zone)])),
  };
  if (reusable) zoneOutlines.set(board.zones, { footprints: board.footprints, value });
  return value;
}

/** Cheap conservative masks over saved fills during an unaccepted gesture.
 * These paths are presentation, never copper/connectivity or a commit result.
 * Vacated clearances remain empty until the exact accepted refill completes. */
export function preparePCBFillPreview(basis: PCB, candidate: PCB): PCBFillPreview {
  if (basis === candidate || basis.id !== candidate.id) return { changed: false, zones: [] };
  const saved = new Set(
    localZones(basis)
      .filter((zone) => zone.filledPolygons !== undefined)
      .map((zone) => zone.id),
  );
  if (!saved.size) return { changed: false, zones: [] };
  const oldTracks = new Map(basis.tracks.map((track) => [track.id, track]));
  const tracks = candidate.tracks.filter((track) => !sameTrack(oldTracks.get(track.id), track));
  const oldVias = new Map(basis.vias.map((via) => [via.id, via]));
  const vias = candidate.vias.filter((via) => !sameVia(oldVias.get(via.id), via));
  const oldFootprints = new Map(basis.footprints.map((footprint) => [footprint.id, footprint]));
  const pads: { footprint: Footprint; pad: Pad }[] = [];
  let packagesChanged = basis.footprints.length !== candidate.footprints.length;
  for (const footprint of candidate.footprints) {
    const old = oldFootprints.get(footprint.id);
    if (old === footprint) continue;
    const posed = old && samePose(old, footprint);
    const oldPads = new Map(old?.pads.map((pad) => [pad.id, pad]) ?? []);
    if (!posed || old?.pads.length !== footprint.pads.length) packagesChanged = true;
    for (const pad of footprint.pads)
      if (!posed || !samePad(oldPads.get(pad.id), pad)) {
        pads.push({ footprint, pad });
        packagesChanged = true;
      }
  }
  const previous = outlineZones(basis);
  const current = outlineZones(candidate);
  const previousZones = previous.zones,
    previousById = previous.byId,
    zones = current.zones;
  const changedZones = zones.filter((zone) => {
    const old = previousById.get(zone.id);
    return !old || previous.keys.get(old) !== current.keys.get(zone);
  });
  const keepouts = changedZones.filter((zone) => zone.keepout?.copperpour);
  const boundaryChanged =
    (basis.graphics !== candidate.graphics || basis.footprints !== candidate.footprints) &&
    JSON.stringify(boundaryInputs(basis)) !== JSON.stringify(boundaryInputs(candidate));
  const padShapes = pads.map(({ footprint, pad }) => {
    const shape = padPolygon(footprint, pad);
    return {
      footprint,
      pad,
      shape,
      bounds: boundsOf(shape.outer),
      drill: pad.drill ? padDrillPosition(footprint, pad) : undefined,
    };
  });
  const changed =
    tracks.length > 0 ||
    basis.tracks.length !== candidate.tracks.length ||
    vias.length > 0 ||
    basis.vias.length !== candidate.vias.length ||
    packagesChanged ||
    changedZones.length > 0 ||
    previousZones.length !== zones.length ||
    basis.graphics !== candidate.graphics ||
    basis.layers !== candidate.layers;
  return {
    changed,
    zones: zones
      .filter(
        (zone) =>
          saved.has(zone.id) &&
          zone.layer.endsWith('.Cu') &&
          !zone.keepout &&
          zone.fillEnabled !== false,
      )
      .map((zone) => {
        const clearance = zone.clearance > 0 ? zone.clearance : defaultCopperFillClearance;
        const bounds = zoneBounds(zone);
        const blockers: PCBFillPreview['zones'][number]['blockers'] = [];
        for (const track of tracks)
          if (
            track.layer === zone.layer &&
            track.netId !== zone.netId &&
            overlaps(
              bounds,
              inflate(boundsOf([track.start, track.end]), track.width / 2 + clearance),
            )
          )
            blockers.push({
              path: `M ${track.start.x} ${track.start.y} L ${track.end.x} ${track.end.y}`,
              strokeWidth: track.width + 2 * clearance,
            });
        for (const via of vias) {
          if (
            via.netId !== zone.netId &&
            overlaps(bounds, circleBounds(via, via.diameter / 2 + clearance))
          )
            blockers.push({ path: circlePath(via, via.diameter / 2 + clearance), strokeWidth: 0 });
          if (via.drill > 0 && overlaps(bounds, circleBounds(via, via.drill / 2)))
            blockers.push({ path: circlePath(via, via.drill / 2), strokeWidth: 0 });
        }
        for (const { footprint, pad, shape, bounds: padBounds, drill } of padShapes) {
          const present =
            pad.type !== 'smd' ||
            (pad.layers
              ? pad.layers.includes('*.Cu') || pad.layers.includes(zone.layer)
              : zone.layer === (footprint.side === 'front' ? 'F.Cu' : 'B.Cu'));
          if (
            present &&
            overlaps(bounds, inflate(padBounds, clearance)) &&
            (pad.type === 'np_thru_hole' ||
              !pad.netId ||
              pad.netId !== zone.netId ||
              pad.zoneConnect === 0 ||
              (pad.zoneConnect === undefined && zone.padConnection === 'no'))
          )
            blockers.push({
              path: polygonPath([shape]),
              strokeWidth: 2 * clearance,
            });
          if (
            drill &&
            pad.drill &&
            pad.drill > 0 &&
            overlaps(bounds, circleBounds(drill, pad.drill / 2))
          )
            blockers.push({
              path: circlePath(drill, pad.drill / 2),
              strokeWidth: 0,
            });
        }
        for (const keepout of keepouts)
          if (
            keepout.layer === zone.layer &&
            overlaps(bounds, inflate(zoneBounds(keepout), clearance))
          )
            blockers.push({ path: outlinePath(keepout), strokeWidth: 2 * clearance });
        return {
          id: zone.id,
          layer: zone.layer,
          netId: zone.netId,
          outline: outlinePath(zone),
          needsMask:
            boundaryChanged || !sameOutline(previousById.get(zone.id), zone) || blockers.length > 0,
          blockers,
        };
      }),
  };
}
