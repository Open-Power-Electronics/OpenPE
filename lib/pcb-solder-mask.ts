import type { Footprint, Pad, PCB } from './pcb';
import { footprintPoint } from './pcb-layout';
import { transformPCBGraphic } from './pcb-geometry';
import {
  circlePolygon,
  graphicPolygons,
  offsetPolygons,
  padPolygon,
  type Polygon,
} from './pcb-polygons';

/** Mask layers describe apertures, rather than the green coating itself. */
export function padHasMaskOpening(footprint: Footprint, pad: Pad, side: 'front' | 'back') {
  return pad.layers
    ? pad.layers.includes('*.Mask') || pad.layers.includes(side === 'front' ? 'F.Mask' : 'B.Mask')
    : pad.type !== 'smd' || footprint.side === side;
}

/** Read-only presentation geometry from the existing pad and mask artwork data.
 * PCB v1 has no via-tenting settings, so retain visible via holes and annuli.
 */
export function solderMaskOpenings(board: PCB, side: 'front' | 'back') {
  const layer = side === 'front' ? 'F.Mask' : 'B.Mask';
  const openings: Polygon[] = board.footprints.flatMap((footprint) =>
    footprint.pads
      .filter((pad) => padHasMaskOpening(footprint, pad, side))
      .flatMap((pad) => offsetPolygons([padPolygon(footprint, pad)], pad.solderMaskMargin ?? 0)),
  );
  openings.push(
    ...board.vias.map((via) => ({ outer: circlePolygon(via, via.diameter / 2), holes: [] })),
  );
  const graphics = [
    ...board.graphics.filter((graphic) => graphic.layer === layer),
    ...board.footprints.flatMap((footprint) =>
      footprint.graphics
        .filter((graphic) => graphic.layer === layer)
        .map((graphic) =>
          transformPCBGraphic(graphic, (point) => footprintPoint(footprint, point)),
        ),
    ),
  ];
  let omittedText = false;
  let vertexCount = openings.reduce(
    (count, polygon) => count + polygon.outer.length + polygon.holes.flat().length,
    0,
  );
  const checkComplexity = () => {
    if (vertexCount > 200000)
      throw new Error('The solder mask exceeds the 3D preview geometry limit.');
  };
  checkComplexity();
  for (const graphic of graphics) {
    if (graphic.text?.hidden) continue;
    if (graphic.text || graphic.dimension) {
      omittedText = true;
      continue;
    }
    const aperture = graphicPolygons(graphic);
    vertexCount += aperture.reduce(
      (count, polygon) => count + polygon.outer.length + polygon.holes.flat().length,
      0,
    );
    checkComplexity();
    openings.push(...aperture);
  }
  return { openings, omittedText };
}
