import type { Point } from './circuit';
import type { CopperLayer, Pad, PCB } from './pcb';
import {
  insidePolygon,
  makeBoundsIndex,
  polygonEdges,
  queryBoundsIndex,
  segmentDistance,
  type BoundsIndex,
  type GeometryBounds,
} from './pcb-collision';
import { padCopperLayers } from './pcb-connectivity';
import { padDrillLine, padPosition } from './pcb-layout';
import { pcbViaBackdrillDiameterOnLayer, pcbViaCopperLayers } from './pcb-native-via';
import { borrowPCBPadOutline } from './pcb-pad-contour';
import { pcbPadOnLayer, pcbViaDiameter } from './pcb-padstack';
import {
  graphicVertices,
  nativeCustomPadCopperPolygons,
  nativeCustomPadCopperTolerance,
  type Polygon,
} from './pcb-polygons';

type Via = PCB['vias'][number];
type Line = readonly [Point, Point];
type Shape = { lines: readonly Line[]; radius: number; precision: number; polygon?: Polygon };
type Contact = GeometryBounds & { owner: Pad | Via | string; shape: Shape; footprintId?: string };
type Layer = { layer: CopperLayer; fixed: boolean };
type Spend = (units?: number) => void;
type Pending = {
  item: Pad | Via;
  layers: Layer[];
  net: string;
  footprintId?: string;
  bore: Shape;
};

const tolerance = 0.000001;
const arcTolerance = 0.0005;
const keptPadEnd = (pad: Pad, layer: CopperLayer) =>
  pad.keepEndLayers && (layer === 'F.Cu' || layer === 'B.Cu');
const keptViaEnd = (via: Via, layer: CopperLayer) =>
  via.keepEndLayers &&
  (layer === (via.span?.start ?? 'F.Cu') || layer === (via.span?.end ?? 'B.Cu'));
const stroke = (line: Line, radius: number): Shape => ({ lines: [line], radius, precision: 0 });

function shapeBounds(shape: Shape): GeometryBounds {
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const [a, b] of shape.lines) {
    bounds.minX = Math.min(bounds.minX, a.x, b.x);
    bounds.minY = Math.min(bounds.minY, a.y, b.y);
    bounds.maxX = Math.max(bounds.maxX, a.x, b.x);
    bounds.maxY = Math.max(bounds.maxY, a.y, b.y);
  }
  const extent = shape.radius + shape.precision;
  return {
    minX: bounds.minX - extent,
    minY: bounds.minY - extent,
    maxX: bounds.maxX + extent,
    maxY: bounds.maxY + extent,
  };
}

function boreContact(bore: Shape, candidate: Shape, spend: Spend) {
  const [line] = bore.lines;
  if (candidate.polygon && line.some((at) => insidePolygon(at, candidate.polygon!, spend)))
    return true;
  let near = false;
  const reach = bore.radius + candidate.radius + tolerance;
  for (const other of candidate.lines) {
    spend();
    const squared = segmentDistance(...line, ...other);
    if (reach >= candidate.precision && squared <= (reach - candidate.precision) ** 2) return true;
    near ||= squared <= (reach + candidate.precision) ** 2;
  }
  return near ? 'uncertain' : false;
}

/** Prepare DRC-only flashing for remove_unused_layers. KiCad probes the drilled
 * section of a conditional ring against same-net copper before flashing it. */
export function resolvePCBPrunedCopper(board: PCB, spend: Spend) {
  const pads = new Map<Pad, CopperLayer[]>();
  const vias = new Map<Via, ReadonlySet<CopperLayer>>();
  const unresolved: string[] = [];
  const pending: Pending[] = [];
  const requested = new Set<string>();
  const key = (layer: CopperLayer, net: string) => `${layer}\0${net}`;
  const queue = (target: Pending) => {
    for (const section of target.layers) {
      spend();
      if (!section.fixed) requested.add(key(section.layer, target.net));
    }
    pending.push(target);
  };

  for (const footprint of board.footprints)
    for (const pad of footprint.pads) {
      if (!pad.removeUnusedLayers) continue;
      queue({
        item: pad,
        layers: padCopperLayers(board, footprint, pad).map((layer) => ({
          layer,
          fixed: Boolean(keptPadEnd(pad, layer) || pad.zoneLayerConnections?.includes(layer)),
        })),
        net: pad.netId ?? '',
        footprintId: footprint.id,
        bore: stroke(padDrillLine(footprint, pad), (pad.drill ?? 0) / 2),
      });
    }
  for (const via of board.vias) {
    if (!via.removeUnusedLayers) continue;
    queue({
      item: via,
      layers: pcbViaCopperLayers(board.layers, via)
        .filter((layer) => pcbViaBackdrillDiameterOnLayer(via, layer) <= via.drill)
        .map((layer) => ({
          layer,
          fixed: Boolean(keptViaEnd(via, layer) || via.zoneLayerConnections?.includes(layer)),
        })),
      net: via.netId,
      bore: stroke([via, via], via.drill / 2),
    });
  }

  const contacts = new Map<string, Contact[]>();
  const add = (group: string, owner: Contact['owner'], shape: Shape, footprintId?: string) => {
    spend(shape.lines.length);
    const list = contacts.get(group) ?? [];
    list.push({ owner, shape, footprintId, ...shapeBounds(shape) });
    contacts.set(group, list);
  };
  if (requested.size) {
    for (const track of board.tracks) {
      const group = key(track.layer, track.netId);
      if (requested.has(group))
        add(group, track.id, stroke([track.start, track.end], track.width / 2));
    }
    for (const track of board.arcTracks ?? []) {
      const group = key(track.layer, track.netId);
      if (!requested.has(group)) continue;
      const points = graphicVertices({ ...track, kind: 'arc' }, arcTolerance);
      const lines = points.slice(1).map((point, i): Line => [points[i], point]);
      add(group, track.id, { lines, radius: track.width / 2, precision: arcTolerance });
    }
    for (const via of board.vias)
      for (const layer of pcbViaCopperLayers(board.layers, via)) {
        const group = key(layer, via.netId);
        if (!requested.has(group) || pcbViaBackdrillDiameterOnLayer(via, layer) > via.drill)
          continue;
        const diameter =
          via.removeUnusedLayers && !keptViaEnd(via, layer)
            ? via.drill
            : pcbViaDiameter(via, layer) || via.drill;
        add(group, via, stroke([via, via], diameter / 2));
      }
    for (const footprint of board.footprints)
      for (const pad of footprint.pads)
        for (const layer of padCopperLayers(board, footprint, pad)) {
          const group = key(layer, pad.netId ?? '');
          if (!requested.has(group)) continue;
          if (pad.removeUnusedLayers && !keptPadEnd(pad, layer)) {
            add(
              group,
              pad,
              stroke(padDrillLine(footprint, pad), (pad.drill ?? 0) / 2),
              footprint.id,
            );
            continue;
          }
          const land = pcbPadOnLayer(pad, layer);
          if (land.shape === 'circle') {
            const at = padPosition(footprint, land);
            add(group, pad, stroke([at, at], land.size.x / 2), footprint.id);
            continue;
          }
          const outlines = land.nativeCustomPad
            ? nativeCustomPadCopperPolygons(footprint, land)
            : [borrowPCBPadOutline(footprint, land)];
          const cornerRadius =
            land.shape === 'oval'
              ? Math.min(land.size.x, land.size.y) / 2
              : (land.roundrectRatio ?? 0) * Math.min(land.size.x, land.size.y);
          const precision = land.nativeCustomPad
            ? nativeCustomPadCopperTolerance
            : cornerRadius * (1 - Math.cos(Math.PI / 32));
          for (const polygon of outlines)
            add(
              group,
              pad,
              { lines: polygonEdges(polygon), polygon, radius: 0, precision },
              footprint.id,
            );
        }
  }

  const indexes = new Map<string, BoundsIndex<Contact>>();
  for (const target of pending) {
    let uncertain = false;
    const kept = target.layers
      .filter(({ layer, fixed }) => {
        if (fixed) return true;
        const group = key(layer, target.net);
        const candidates = contacts.get(group);
        if (!candidates) return false;
        let index = indexes.get(group);
        if (!index) {
          index = makeBoundsIndex(candidates);
          indexes.set(group, index);
        }
        let connected = false;
        let nearby = false;
        queryBoundsIndex(
          index,
          shapeBounds(target.bore),
          tolerance,
          (candidate) => {
            if (connected || candidate.owner === target.item) return;
            if (target.footprintId && candidate.footprintId === target.footprintId) return;
            if (
              target.footprintId &&
              candidate.footprintId &&
              typeof candidate.owner !== 'string' &&
              candidate.owner.removeUnusedLayers
            )
              return;
            const contact = boreContact(target.bore, candidate.shape, spend);
            connected = contact === true;
            nearby ||= contact === 'uncertain';
          },
          spend,
        );
        uncertain ||= !connected && nearby;
        return connected;
      })
      .map(({ layer }) => layer);
    if (uncertain) unresolved.push(target.item.id);
    if ('number' in target.item) pads.set(target.item, kept);
    else vias.set(target.item, new Set(kept));
  }

  return { pads, vias, unresolved };
}
