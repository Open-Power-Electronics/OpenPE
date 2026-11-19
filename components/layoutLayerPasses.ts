import type { BoardLayer, Footprint, PCB } from '../lib/pcb';
import { pcbPadDisplayLayers, pcbPadPaintLayer, type PCBDisplay } from '../lib/pcb-display';

export type LayoutFootprintLayerPass = {
  id: string;
  footprint: Footprint;
  layer: BoardLayer;
};

/** Sparse presentation records retain native objects while giving every layer pass its own key. */
export function layoutFootprintLayerPasses(
  board: Pick<PCB, 'layers' | 'footprints'>,
  display: PCBDisplay,
  paintOrder: readonly BoardLayer[],
): { graphics: LayoutFootprintLayerPass[]; captions: LayoutFootprintLayerPass[] } {
  const graphics: LayoutFootprintLayerPass[] = [];
  const captions: LayoutFootprintLayerPass[] = [];
  if (!display.footprints) return { graphics, captions };
  const visibleOrder = [...new Set(paintOrder)].filter((layer) => display[layer]);
  const visible = new Set(visibleOrder);
  for (const footprint of board.footprints) {
    const graphicLayers = new Set<BoardLayer>();
    const captionLayers = new Set<BoardLayer>();
    for (const graphic of footprint.graphics) {
      if (!visible.has(graphic.layer)) continue;
      if (graphic.kind === 'text') {
        if (!graphic.text?.hidden) captionLayers.add(graphic.layer);
      } else graphicLayers.add(graphic.layer);
    }
    if (display.zoneOutlines)
      for (const zone of footprint.zones ?? [])
        if (visible.has(zone.layer)) graphicLayers.add(zone.layer);
    for (const pad of footprint.pads) {
      const padLayers = pcbPadDisplayLayers(board, footprint, pad);
      const owner = pcbPadPaintLayer(padLayers, display, paintOrder);
      if (owner) graphicLayers.add(owner);
    }
    const referenceLayer = footprint.side === 'front' ? 'F.SilkS' : 'B.SilkS';
    if (
      visible.has(referenceLayer) &&
      !footprint.graphics.some((graphic) => graphic.text?.property === 'Reference')
    )
      captionLayers.add(referenceLayer);
    for (const layer of visibleOrder) {
      const pass = { id: `${footprint.id}:${layer}`, footprint, layer };
      if (graphicLayers.has(layer)) graphics.push(pass);
      if (captionLayers.has(layer)) captions.push(pass);
    }
  }
  return { graphics, captions };
}
