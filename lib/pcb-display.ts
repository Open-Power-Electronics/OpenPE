import type { PCB, BoardLayer, Footprint, Pad } from './pcb';
import { padCopperLayers } from './pcb-connectivity';
import { footprintPoint, pcbBounds, type PCBBounds } from './pcb-layout';
import { pcbGraphicPoints } from './pcb-geometry';
import { boardPolygons } from './pcb-polygons';

const pcbDisplayOptions = [
  'footprints',
  'padNumbers',
  'padNets',
  'zoneOutlines',
  'copper',
  'airwires',
] as const;
export type PCBDisplay = Record<BoardLayer | (typeof pcbDisplayOptions)[number], boolean>;
export const copperFillOpacity = 0.8;
export const boardOutlineMinWidth = 0.05;
export function defaultPCBDisplay(): PCBDisplay {
  return Object.fromEntries([
    ...[
      'F.Cu',
      'B.Cu',
      'In1.Cu',
      'In2.Cu',
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
  'B.Cu',
  'In2.Cu',
  'In1.Cu',
  'F.Cu',
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
export function pcbDisplayLayerPaintOrder(display: PCBDisplay): BoardLayer[] {
  return pcbLayerPaintOrder(
    Object.entries(display).flatMap(([name, visible]) =>
      visible && !pcbDisplayOptions.some((option) => option === name) ? [name as BoardLayer] : [],
    ),
  );
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

export const pcbPadTypeLabel = (type: Pad['type']): string =>
  type === 'smd'
    ? 'Surface-mount pad'
    : type === 'thru_hole'
      ? 'Plated through-hole pad'
      : 'Non-plated hole';

export const pcbPadShapeLabel = (shape: Pad['shape']): string =>
  shape === 'rect'
    ? 'Rectangle'
    : shape === 'roundrect'
      ? 'Rounded rectangle'
      : shape === 'circle'
        ? 'Circle'
        : 'Oval';

/** Pad-local annotation geometry; full net names remain available in inspection/accessibility. */
export function pcbPadLabels(
  pad: Pad,
  rotation: number,
  netName: string | undefined,
  visible: Pick<PCBDisplay, 'padNumbers' | 'padNets'>,
) {
  const lines: { kind: 'number' | 'net'; text: string; y: number; size: number }[] = [];
  if (pad.type === 'np_thru_hole') return { rotation: 0, lines };
  if (visible.padNumbers && pad.number)
    lines.push({ kind: 'number', text: pad.number, y: 0, size: 0 });
  const name = netName?.split('/').at(-1) || netName;
  if (visible.padNets && name) lines.push({ kind: 'net', text: name, y: 0, size: 0 });
  const tall = pad.size.y > pad.size.x * 1.05;
  const length = Math.max(pad.size.x, pad.size.y);
  const breadth = Math.min(pad.size.x, pad.size.y);
  // Round and square pads have no long axis: keep their labels horizontal on the board.
  const axis = length <= breadth * 1.05 ? 0 : pcbReadableTextAngle(rotation + (tall ? 90 : 0));
  const width = length * (pad.shape === 'circle' ? 0.62 : 0.82);
  const height = breadth * (lines.length > 1 ? 0.34 : 0.64);
  lines.forEach((line, i) => {
    line.size = Math.min(height, width / (Math.max(1, Array.from(line.text).length) * 0.62));
    line.y = lines.length > 1 ? (i === 0 ? -1 : 1) * breadth * 0.21 : 0;
  });
  return { rotation: rotation - axis, lines };
}
export function pcbDisplayLayers(board: PCB): BoardLayer[] {
  return [
    ...new Set<BoardLayer>([
      ...board.layers,
      'F.SilkS',
      'B.SilkS',
      'Edge.Cuts',
      ...board.graphics.map((g) => g.layer),
      ...board.zones.map((z) => z.layer),
      ...board.footprints.flatMap((f) => [
        ...f.graphics.map((g) => g.layer),
        ...(f.zones ?? []).map((z) => z.layer),
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
    if (
      pad.type === 'np_thru_hole'
        ? !visible['Edge.Cuts']
        : !padCopperLayers(board, footprint, pad).some((layer) => visible[layer as BoardLayer])
    )
      continue;
    const localPad = { ...footprint, x: pad.x, y: pad.y, rotation: pad.rotation };
    for (const x of [-pad.size.x / 2, pad.size.x / 2])
      for (const y of [-pad.size.y / 2, pad.size.y / 2])
        points.push(footprintPoint(localPad, { x, y }));
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
  return pcbBounds({
    ...board,
    tracks: board.tracks.filter((t) => visible[t.layer]),
    vias: board.layers.some((l) => visible[l]) ? board.vias : [],
    graphics: board.graphics.filter((g) => visible[g.layer]),
    zones:
      visible.zoneOutlines || visible.copper ? board.zones.filter((z) => visible[z.layer]) : [],
    footprints: visible.footprints
      ? board.footprints
          .map((f) => ({
            ...f,
            pads: f.pads.filter(
              (p) =>
                padCopperLayers(board, f, p).some((l) => visible[l as BoardLayer]) ||
                (p.type === 'np_thru_hole' && visible['Edge.Cuts']),
            ),
            graphics: f.graphics.filter((g) => visible[g.layer]),
            zones: f.zones?.filter(
              (z) => visible[z.layer] && (visible.zoneOutlines || visible.copper),
            ),
          }))
          .filter(
            (f) => f.pads.length || f.graphics.some((g) => !g.text?.hidden) || f.zones?.length,
          )
      : [],
  });
}
export const pcbLayerColor = (layer: string, pour = false): string =>
  layer === 'F.Cu'
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
