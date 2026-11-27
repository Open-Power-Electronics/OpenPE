import type { Circuit } from './circuit';
import type { PCB } from './pcb';
import type { ModelCAD } from './model-cad';
import { isOwnedPCB } from './immutable-project';
import { footprintPoint, padPosition, padRotation } from './pcb-layout';
import { pcbViaCopperLayers } from './pcb-native-via';
import {
  maxAnnotationElements,
  validateAnnotationMarkup,
  type AgentAnnotation,
  type AnnotationElement,
  type AnnotationMarkup,
  type LayoutAnnotationContext,
} from './agent-annotations';

/** The board and the schematic labels actually drawn on it define the captured view. */
const ownedAnnotationFingerprints = new WeakMap<PCB, { labels: string; basis: string }>();
export function pcbAnnotationFingerprint(board: PCB, schematic: Circuit): string {
  const parts = new Map(schematic.parts.map((part) => [part.id, part]));
  const source = {
    board,
    schematicId: schematic.id,
    labels: board.footprints.map((footprint) => {
      const part = footprint.symbolId ? parts.get(footprint.symbolId) : undefined;
      return [footprint.symbolId, part?.ref, part?.value];
    }),
  };
  // A schematic pose, wire or simulation edit leaves these drawn board labels
  // unchanged. Rehash copper only when the owned board or its visible labels change.
  const owned = isOwnedPCB(board);
  const labels = owned ? JSON.stringify([source.schematicId, source.labels]) : '';
  const cached = owned ? ownedAnnotationFingerprints.get(board) : undefined;
  if (cached?.labels === labels) return cached.basis;
  const basis = pcbObjectViewFingerprint(source);
  if (owned) ownedAnnotationFingerprints.set(board, { labels, basis });
  return basis;
}

/** Camera/display identity for screen-space Object overlays, separate from design changes. */
export function pcbObjectViewFingerprint(value: unknown): string {
  const source = JSON.stringify(value);
  let a = 2166136261,
    b = 5381;
  for (let i = 0; i < source.length; i++) {
    a = Math.imul(a ^ source.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ source.charCodeAt(i);
  }
  return `${source.length}:${a >>> 0}:${b >>> 0}`;
}

/** Bounded context for comparing attachment snapshots; it is not a connectivity or DRC result. */
export function layoutAnnotationContext(board: PCB, schematic: Circuit): LayoutAnnotationContext {
  return {
    version: 1,
    id: board.id,
    circuitId: schematic.id,
    basis: pcbAnnotationFingerprint(board, schematic),
    thickness: board.thickness,
    layers: [...board.layers],
    counts: {
      nets: board.nets.length,
      footprints: board.footprints.length,
      pads: board.footprints.reduce((count, footprint) => count + footprint.pads.length, 0),
      tracks: board.tracks.length,
      vias: board.vias.length,
      graphics:
        board.graphics.length +
        board.footprints.reduce((count, footprint) => count + footprint.graphics.length, 0),
      zones:
        board.zones.length +
        board.footprints.reduce((count, footprint) => count + (footprint.zones?.length ?? 0), 0),
    },
  };
}

export function capturePCBAnnotationSelection(
  board: PCB,
  schematic: Circuit,
  ids: string[],
  markup?: AnnotationMarkup,
  model?: { viewBasis: string; cad?: ModelCAD | null },
): Omit<AgentAnnotation, 'image' | 'comment'> {
  if (markup) validateAnnotationMarkup(markup);
  if (
    (!ids.length && !markup) ||
    new Set(ids).size !== ids.length ||
    ids.length > maxAnnotationElements
  )
    throw new Error(`Select between 1 and ${maxAnnotationElements} elements to annotate.`);
  const parts = new Map(schematic.parts.map((part) => [part.id, part]));
  const nets = new Map(board.nets.map((net) => [net.id, net.name]));
  const elements = ids.map((id): AnnotationElement => {
    const solid = model?.cad?.objects.find((object) => object.id === id);
    if (solid)
      return {
        id,
        kind: 'solid',
        label: solid.name,
        properties: {
          Shape: solid.kind,
          Material: solid.material,
          Opacity: String(solid.opacity),
          'Position (mm)': JSON.stringify(solid.position),
          'Rotation (deg)': JSON.stringify(solid.rotation),
          'Size (mm)': JSON.stringify(solid.size),
          ...(solid.color ? { Color: solid.color } : {}),
        },
      };
    for (const footprint of board.footprints) {
      const part = footprint.symbolId ? parts.get(footprint.symbolId) : undefined;
      const label = part?.ref || footprint.reference || footprint.libraryId;
      if (id === footprint.id)
        return {
          id,
          kind: 'footprint',
          label,
          properties: {
            Reference: part?.ref || footprint.reference || '',
            Value: part?.value || footprint.value || '',
            Footprint: footprint.libraryId,
            'Component ID': footprint.symbolId || '',
            'X (mm)': String(footprint.x),
            'Y (mm)': String(footprint.y),
            'Rotation (deg)': String(footprint.rotation),
            Side: footprint.side,
            'Pad count': String(footprint.pads.length),
          },
        };
      const pad = footprint.pads.find((item) => item.id === id);
      if (pad)
        return {
          id,
          kind: 'pad',
          label: `${label} · Pad ${pad.number}`,
          properties: {
            'Footprint ID': footprint.id,
            'Component ID': footprint.symbolId || '',
            Number: pad.number,
            Type: pad.type,
            Shape: pad.shape,
            'Local position (mm)': JSON.stringify({ x: pad.x, y: pad.y }),
            'Local rotation (deg)': String(pad.rotation),
            'Board position (mm)': JSON.stringify(padPosition(footprint, pad)),
            'Board rotation (deg)': String(padRotation(footprint, pad)),
            [pad.outline ? 'Anchor size (mm)' : 'Size (mm)']: JSON.stringify(pad.size),
            'Drill (mm)': pad.drill === undefined ? '' : String(pad.drill),
            'Net ID': pad.netId || '',
            Net: pad.netId ? nets.get(pad.netId) || '' : '',
            Side: footprint.side,
          },
        };
      const graphic = footprint.graphics.find((item) => item.id === id);
      if (graphic)
        return {
          id,
          kind: 'graphic',
          label: `${label} · ${graphic.layer}`,
          properties: {
            'Footprint ID': footprint.id,
            Layer: graphic.layer,
            'Local start (mm)': JSON.stringify(graphic.start),
            'Local end (mm)': JSON.stringify(graphic.end),
            'Board start (mm)': JSON.stringify(footprintPoint(footprint, graphic.start)),
            'Board end (mm)': JSON.stringify(footprintPoint(footprint, graphic.end)),
            'Width (mm)': String(graphic.width),
          },
        };
    }
    const track = board.tracks.find((item) => item.id === id);
    if (track)
      return {
        id,
        kind: 'track',
        label: `${nets.get(track.netId) || 'Track'} · ${track.layer}`,
        properties: {
          Layer: track.layer,
          'Net ID': track.netId,
          Net: nets.get(track.netId) || '',
          'Start (mm)': JSON.stringify(track.start),
          'End (mm)': JSON.stringify(track.end),
          'Width (mm)': String(track.width),
        },
      };
    const via = board.vias.find((item) => item.id === id);
    if (via)
      return {
        id,
        kind: 'via',
        label: `${nets.get(via.netId) || 'Unassigned'} · Via`,
        properties: {
          'Net ID': via.netId,
          Net: nets.get(via.netId) || '',
          'X (mm)': String(via.x),
          'Y (mm)': String(via.y),
          'Diameter (mm)': String(via.diameter),
          'Drill (mm)': String(via.drill),
          Type: via.span?.kind ?? 'through',
          Layers: pcbViaCopperLayers(board.layers, via).join(', '),
        },
      };
    const graphic = board.graphics.find((item) => item.id === id);
    if (graphic)
      return {
        id,
        kind: 'graphic',
        label: graphic.layer,
        properties: {
          Layer: graphic.layer,
          'Start (mm)': JSON.stringify(graphic.start),
          'End (mm)': JSON.stringify(graphic.end),
          'Width (mm)': String(graphic.width),
        },
      };
    const zone = board.zones.find((item) => item.id === id);
    if (zone)
      return {
        id,
        kind: 'zone',
        label: `${(zone.netId && nets.get(zone.netId)) || (zone.keepout ? 'Keepout' : 'Zone')} · ${zone.layer}`,
        properties: {
          Layer: zone.layer,
          'Net ID': zone.netId || '',
          Net: (zone.netId && nets.get(zone.netId)) || '',
          'Outline vertex count': String(zone.outline.length),
          'Outline bounds (mm)': JSON.stringify({
            minX: Math.min(...zone.outline.map((point) => point.x)),
            minY: Math.min(...zone.outline.map((point) => point.y)),
            maxX: Math.max(...zone.outline.map((point) => point.x)),
            maxY: Math.max(...zone.outline.map((point) => point.y)),
          }),
          'Clearance (mm)': String(zone.clearance),
          'Minimum thickness (mm)': String(zone.minThickness),
          'Thermal gap (mm)': String(zone.thermalGap),
          'Thermal bridge (mm)': String(zone.thermalBridge),
          Fill: 'Unfilled',
        },
      };
    throw new Error('A selected element no longer exists. Select the elements again.');
  });
  return {
    id: crypto.randomUUID(),
    target: model ? 'object' : 'layout',
    version: 1,
    boardId: board.id,
    circuitId: schematic.id,
    title: `${schematic.title.slice(0, 4087)} · ${model ? 'Model' : 'Layout'}`,
    basis: pcbAnnotationFingerprint(board, schematic),
    elements,
    ...(model ? { viewBasis: model.viewBasis } : {}),
    ...(markup ? { markup: structuredClone(markup) } : {}),
  };
}
