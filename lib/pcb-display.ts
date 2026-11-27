import type { PCB, BoardLayer, CopperLayer, Footprint, Pad } from './pcb';
import { pcbCopperLayers, pcbCopperStacks } from './pcb-layer-stack';
import { pcbViaCopperLayers } from './pcb-native-via';
import { pcbPadOnLayer, pcbViaDiameter } from './pcb-padstack';
import { nativeCustomPadLabelBox } from './pcb-native-custom-pad';
import { padCopperLayers } from './pcb-connectivity';
import { footprintPoint, pcbBounds, type PCBBounds } from './pcb-layout';
import { pcbGraphicPoints } from './pcb-geometry';
import { boardPolygons } from './pcb-polygons';
import { padBoundPoints, padExtent } from './pcb-custom-pad';
import { padApertureLayers, padHasElectricalPin, padSilkscreenLayers } from './pcb-pad-role';
import { pcbReferenceImages } from './pcb-reference-image';
import { pcbBarcodes } from './pcb-barcode';
import { pcbTableDrawings } from './kicad-pcb';
import { pcbZoneLayerActive } from './pcb-zone-settings';

const pcbDisplayOptions = [
  'footprints',
  'padNumbers',
  'padNets',
  'zoneOutlines',
  'copper',
  'airwires',
] as const;
export type PCBDisplay = Record<BoardLayer | (typeof pcbDisplayOptions)[number], boolean>;
export const pcbInactiveLayerModes = ['Normal', 'Dim', 'Hide'] as const;
export type PCBInactiveLayerMode = (typeof pcbInactiveLayerModes)[number];
export const copperFillOpacity = 0.8;
export const boardOutlineMinWidth = 0.05;
export function defaultPCBDisplay(): PCBDisplay {
  return Object.fromEntries([
    ...[
      ...pcbCopperLayers,
      'F.SilkS',
      'B.SilkS',
      'F.CrtYd',
      'B.CrtYd',
      'F.Fab',
      'B.Fab',
      'Edge.Cuts',
      ...pcbDisplayOptions,
    ].map((key) => [key, true]),
  ]) as PCBDisplay;
}

const physicalLayerPaintOrder: readonly BoardLayer[] = [
  'B.SilkS',
  'B.Paste',
  'B.Mask',
  ...pcbCopperLayers.toReversed(),
  'F.Mask',
  'F.Paste',
  'F.SilkS',
];
const physicalLayerRanks = new Map(
  physicalLayerPaintOrder.map((layer, index) => [layer, index] as const),
);

/** Paint the physical stack from the back toward the front, then drawing overlays. */
export function pcbLayerPaintOrder(layers: readonly BoardLayer[]): BoardLayer[] {
  const rank = (layer: BoardLayer) =>
    layer === 'Edge.Cuts'
      ? physicalLayerPaintOrder.length + 1
      : (physicalLayerRanks.get(layer) ?? physicalLayerPaintOrder.length);
  return [...new Set(layers)].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** Include enabled latent layers so a new footprint's preview shares its committed paint order. */
export function pcbDisplayLayerPaintOrder(
  display: PCBDisplay,
  copperLayers: readonly CopperLayer[] = pcbCopperStacks[1],
): BoardLayer[] {
  const actualCopper = new Set<string>(copperLayers);
  return pcbLayerPaintOrder(
    Object.entries(display).flatMap(([name, visible]) =>
      visible &&
      !pcbDisplayOptions.some((option) => option === name) &&
      (!name.endsWith('.Cu') || actualCopper.has(name))
        ? [name as BoardLayer]
        : [],
    ),
  );
}

/** Promote the active side's passes as a group, with the active layer on top. */
export function pcbActiveLayerPaintOrder(order: BoardLayer[], active: BoardLayer): BoardLayer[] {
  const side = active.startsWith('F.') || active.startsWith('B.') ? active.slice(0, 2) : '';
  const related = (name: BoardLayer) => name === active || (side && name.startsWith(side));
  return [
    ...order.filter((name) => !related(name)),
    ...order.filter((name) => name !== active && related(name)),
    ...order.filter((name) => name === active),
  ];
}

export function pcbPadBodyLayers(
  board: Pick<PCB, 'layers'>,
  footprint: Footprint,
  pad: Pad,
): readonly BoardLayer[] {
  if (pad.type === 'np_thru_hole') return ['Edge.Cuts'];
  const aperture = padApertureLayers(pad);
  if (aperture) return aperture;
  const copper = padCopperLayers(board, footprint, pad);
  if (!pad.removeUnusedLayers) return copper;
  return copper.filter(
    (layer) =>
      (pad.keepEndLayers && (layer === 'F.Cu' || layer === 'B.Cu')) ||
      pad.zoneLayerConnections?.includes(layer),
  );
}

export function pcbPadSilkscreenDisplayLayers(pad: Pad) {
  const artwork = padSilkscreenLayers(pad);
  if (!pad.removeUnusedLayers || pad.keepEndLayers) return artwork;
  return artwork.filter((layer) =>
    pad.zoneLayerConnections?.includes(layer === 'F.SilkS' ? 'F.Cu' : 'B.Cu'),
  );
}

export function pcbPadDisplayLayers(
  board: Pick<PCB, 'layers'>,
  footprint: Footprint,
  pad: Pad,
): readonly BoardLayer[] {
  const body = pcbPadBodyLayers(board, footprint, pad);
  const artwork = pcbPadSilkscreenDisplayLayers(pad);
  return artwork.length ? [...body, ...artwork] : body;
}

/** A spanning pad has one owner: its uppermost visible pass in the current paint order. */
export function pcbPadPaintLayer(
  padLayers: readonly string[],
  display: PCBDisplay,
  paintOrder: readonly BoardLayer[],
): BoardLayer | undefined {
  for (let index = paintOrder.length - 1; index >= 0; index--) {
    const layer = paintOrder[index];
    if (display[layer] && padLayers.includes(layer)) return layer;
  }
}

/** Restrict observed geometry to one layer without changing its visibility or object toggles. */
export function pcbDisplayForLayer(display: PCBDisplay, layer: BoardLayer): PCBDisplay {
  return Object.fromEntries(
    Object.entries(display).map(([name, visible]) => [
      name,
      pcbDisplayOptions.some((option) => option === name) ? visible : visible && name === layer,
    ]),
  ) as PCBDisplay;
}

/** Keep board text readable without changing native angles or embedded artwork. */
export function pcbReadableTextAngle(rotation: number): number {
  const angle = ((rotation % 180) + 180) % 180;
  return angle > 90 ? angle - 180 : angle;
}

export function pcbFootprintTextRotation(
  rotation: number,
  footprintRotation: number,
  keepUpright?: false,
): number {
  return keepUpright === false
    ? rotation
    : pcbReadableTextAngle(rotation + footprintRotation) - footprintRotation;
}

export function pcbPadTypeLabel(pad: Pad): string {
  const apertureLayers = padApertureLayers(pad);
  if (apertureLayers?.length === 2) return 'Solder mask and paste aperture';
  if (apertureLayers)
    return apertureLayers[0].endsWith('.Paste') ? 'Solder paste aperture' : 'Solder mask aperture';
  if (pad.type === 'smd') return 'Surface-mount pad';
  return pad.type === 'thru_hole' ? 'Plated through-hole pad' : 'Non-plated hole';
}

const padShapeLabels: Record<Pad['shape'], string> = {
  rect: 'Rectangle',
  roundrect: 'Rounded rectangle',
  circle: 'Circle',
  oval: 'Oval',
  trapezoid: 'Trapezoid',
  custom: 'Custom polygon',
};
export const pcbPadShapeLabel = (shape: Pad['shape']) => padShapeLabels[shape];

/** Pad-local annotation geometry; full net names remain available in inspection/accessibility. */
export function pcbPadLabels(
  pad: Pad,
  rotation: number,
  netName: string | undefined,
  visible: Pick<PCBDisplay, 'padNumbers' | 'padNets'>,
) {
  const lines: { kind: 'number' | 'net'; text: string; y: number; size: number }[] = [];
  const zero = { x: 0, y: 0 };
  if (!padHasElectricalPin(pad)) return { rotation: 0, origin: zero, lines };
  if (visible.padNumbers && pad.number)
    lines.push({ kind: 'number', text: pad.number, y: 0, size: 0 });
  const name = netName?.split('/').at(-1) || netName;
  if (visible.padNets && name) lines.push({ kind: 'net', text: name, y: 0, size: 0 });
  const box = nativeCustomPadLabelBox(pad);
  const size = box ? { x: box.size.x * 0.9, y: box.size.y * 0.9 } : padExtent(pad);
  const tall = size.y > size.x * 1.05;
  const length = Math.max(size.x, size.y);
  const breadth = Math.min(size.x, size.y);
  // Round and square pads have no long axis: keep their labels horizontal on the board.
  const axis = length <= breadth * 1.05 ? 0 : pcbReadableTextAngle(rotation + (tall ? 90 : 0));
  const width = length * (pad.shape === 'circle' ? 0.62 : 0.82);
  const height = breadth * (lines.length > 1 ? 0.34 : 0.64);
  lines.forEach((line, i) => {
    line.size = Math.min(height, width / (Math.max(1, Array.from(line.text).length) * 0.62));
    line.y = lines.length > 1 ? (i === 0 ? -1 : 1) * breadth * 0.21 : 0;
  });
  return { rotation: rotation - axis, origin: box?.center ?? zero, lines };
}
export function pcbDisplayLayers(board: PCB): BoardLayer[] {
  return [
    ...new Set<BoardLayer>([
      ...board.layers,
      'F.SilkS',
      'B.SilkS',
      'Edge.Cuts',
      ...[...board.tracks, ...(board.arcTracks ?? [])].flatMap((track) =>
        track.maskLayer ? [track.maskLayer] : [],
      ),
      ...board.graphics.map((g) => g.layer),
      ...pcbReferenceImages(board.referenceImages).map((image) => image.layer),
      ...pcbBarcodes(board.barcodes).map((barcode) => barcode.layer),
      ...pcbTableDrawings(board.nativeTables).map((table) => table.layer),
      ...board.zones.map((z) => z.layer),
      ...board.footprints.flatMap((f) => [
        ...f.graphics.map((g) => g.layer),
        ...(f.referencePoints ?? []).map((point) => point.layer),
        ...(f.zones ?? []).flatMap(({ layer }) =>
          pcbZoneLayerActive(board, layer) ? [layer] : [],
        ),
        ...f.pads.flatMap((p) =>
          (p.layers ?? []).filter((l): l is BoardLayer => !l.startsWith('*')),
        ),
      ]),
    ]),
  ];
}
/** Local body bounds for selection, excluding captions, hidden geometry and the origin. */
export function pcbFootprintBodyBounds(
  board: Pick<PCB, 'layers'>,
  footprint: Footprint,
  visible: PCBDisplay,
): PCBBounds | null {
  if (!visible.footprints) return null;
  const points = [];
  for (const pad of footprint.pads) {
    const layers = pcbPadDisplayLayers(board, footprint, pad).filter((layer) => visible[layer]);
    if (!layers.length) continue;
    const geometry = pad.padstack ? layers.map((layer) => pcbPadOnLayer(pad, layer)) : [pad];
    for (const shape of geometry)
      for (const point of padBoundPoints(shape)) points.push(footprintPoint(shape, point));
  }
  for (const graphic of footprint.graphics) {
    if (!visible[graphic.layer] || graphic.kind === 'text' || graphic.kind === 'dimension')
      continue;
    for (const p of pcbGraphicPoints(graphic)) {
      const margin = graphic.width / 2;
      points.push({ x: p.x - margin, y: p.y - margin }, { x: p.x + margin, y: p.y + margin });
    }
  }
  if (!points.length) return null;
  return points.reduce(
    (bounds, p) => ({
      minX: Math.min(bounds.minX, p.x),
      minY: Math.min(bounds.minY, p.y),
      maxX: Math.max(bounds.maxX, p.x),
      maxY: Math.max(bounds.maxY, p.y),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
}
export function pcbDisplayBounds(
  board: PCB,
  mode: 'board' | 'all',
  visible: PCBDisplay,
): PCBBounds {
  if (mode === 'board') {
    const points = boardPolygons(board).flatMap((p) => p.outer);
    return {
      minX: Math.min(...points.map((p) => p.x)),
      minY: Math.min(...points.map((p) => p.y)),
      maxX: Math.max(...points.map((p) => p.x)),
      maxY: Math.max(...points.map((p) => p.y)),
    };
  }
  const bounds = pcbBounds({
    ...board,
    tracks: board.tracks.filter((t) => visible[t.layer]),
    arcTracks: board.arcTracks?.filter((t) => visible[t.layer]),
    vias: board.vias.flatMap((via) => {
      const layers = pcbViaCopperLayers(board.layers, via).filter((layer) => visible[layer]);
      if (!layers.length) return [];
      return [
        via.padstack || via.removeUnusedLayers || via.startEndOnly
          ? {
              ...via,
              diameter: Math.max(via.drill, ...layers.map((layer) => pcbViaDiameter(via, layer))),
            }
          : via,
      ];
    }),
    graphics: board.graphics.filter((g) => visible[g.layer]),
    zones:
      visible.zoneOutlines || visible.copper ? board.zones.filter((z) => visible[z.layer]) : [],
    footprints: visible.footprints
      ? board.footprints
          .map((f) => ({
            ...f,
            pads: f.pads.flatMap((pad) => {
              const layers = pcbPadDisplayLayers(board, f, pad).filter((layer) => visible[layer]);
              if (!layers.length) return [];
              return pad.padstack
                ? [...new Set(layers.map((layer) => pcbPadOnLayer(pad, layer)))].map((shape) => ({
                    ...shape,
                    padstack: undefined,
                  }))
                : [pad];
            }),
            graphics: f.graphics.filter((g) => visible[g.layer]),
            referencePoints: f.referencePoints?.filter((point) => visible[point.layer]),
            zones: f.zones?.filter(
              (z) =>
                visible[z.layer] &&
                pcbZoneLayerActive(board, z.layer) &&
                (visible.zoneOutlines || visible.copper),
            ),
          }))
          .filter(
            (f) =>
              f.pads.length ||
              f.graphics.some((g) => !g.text?.hidden) ||
              f.referencePoints?.length ||
              f.zones?.length,
          )
      : [],
  });
  for (const image of pcbReferenceImages(board.referenceImages)) {
    if (!visible[image.layer]) continue;
    bounds.minX = Math.min(bounds.minX, image.x);
    bounds.minY = Math.min(bounds.minY, image.y);
    bounds.maxX = Math.max(bounds.maxX, image.x + image.width);
    bounds.maxY = Math.max(bounds.maxY, image.y + image.height);
  }
  for (const barcode of pcbBarcodes(board.barcodes)) {
    if (!visible[barcode.layer]) continue;
    const radius = Math.hypot(
      barcode.width / 2,
      barcode.height / 2 + (barcode.showText ? barcode.textHeight * 2 : 0),
    );
    bounds.minX = Math.min(bounds.minX, barcode.x - radius);
    bounds.minY = Math.min(bounds.minY, barcode.y - radius);
    bounds.maxX = Math.max(bounds.maxX, barcode.x + radius);
    bounds.maxY = Math.max(bounds.maxY, barcode.y + radius);
  }
  for (const table of pcbTableDrawings(board.nativeTables)) {
    if (!visible[table.layer]) continue;
    for (const graphic of table.graphics) {
      for (const point of pcbGraphicPoints(graphic)) {
        const margin = graphic.width / 2;
        bounds.minX = Math.min(bounds.minX, point.x - margin);
        bounds.minY = Math.min(bounds.minY, point.y - margin);
        bounds.maxX = Math.max(bounds.maxX, point.x + margin);
        bounds.maxY = Math.max(bounds.maxY, point.y + margin);
      }
    }
  }
  return bounds;
}
export const pcbLayerColor = (layer: string, pour = false): string => {
  const copperIndex = pcbCopperLayers.indexOf(layer as CopperLayer);
  if (copperIndex >= 3 && copperIndex < pcbCopperLayers.length - 1)
    return `hsl(${Math.round((copperIndex * 137.508) % 360)} 65% 48%)`;
  return layer === 'F.Cu'
    ? pour
      ? 'var(--pcb-front-fill)'
      : 'var(--pcb-front)'
    : layer === 'B.Cu'
      ? pour
        ? 'var(--pcb-back-fill)'
        : 'var(--pcb-back)'
      : layer === 'In1.Cu'
        ? 'var(--pcb-inner1)'
        : layer === 'In2.Cu'
          ? 'var(--pcb-inner2)'
          : layer === 'Edge.Cuts'
            ? 'var(--pcb-outline)'
            : layer === 'F.SilkS'
              ? 'var(--pcb-silk-front)'
              : layer === 'B.SilkS'
                ? 'var(--pcb-silk-back)'
                : layer.endsWith('CrtYd')
                  ? 'var(--pcb-courtyard)'
                  : layer.endsWith('Mask')
                    ? 'var(--pcb-mask)'
                    : layer.endsWith('Paste')
                      ? 'var(--pcb-paste)'
                      : 'var(--pcb-fab)';
};
