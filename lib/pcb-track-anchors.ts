import type { Point } from './circuit';
import type { CopperLayer, PCB } from './pcb';
import { padCopperLayers } from './pcb-connectivity';
import { padPosition } from './pcb-layout';
import { circlePolygon, type Polygon } from './pcb-polygons';
import { borrowPCBPadCopperContour, copyPCBPadCopperContour } from './pcb-pad-contour';
import { isOwnedPCB, isOwnedProjectNode } from './immutable-project';

export type PCBTrackAnchor = { id: string; netId: string; layers: string[]; polygon: Polygon };
export type CenteredPCBTrackAnchor = PCBTrackAnchor & { center: Point };
type Options = { limitMessage: string; netId?: string; layer?: CopperLayer };

export function preparePCBTrackAnchors(
  board: PCB,
  options: Options & { centers: true },
): CenteredPCBTrackAnchor[];
export function preparePCBTrackAnchors(
  board: PCB,
  options: Options & { centers?: false },
): PCBTrackAnchor[];
/** Fixed physical contacts, filtered before geometry and the shared vertex bound. */
export function preparePCBTrackAnchors(
  board: PCB,
  options: Options & { centers?: boolean },
): (PCBTrackAnchor & { center?: Point })[] {
  return fixedTrackAnchors(board, options, false);
}

/** Internal read-only contacts for Shove. Public anchors remain independent;
 * only owned pads on an owned basis can lend their frozen private contours. */
export function borrowPCBTrackAnchors(board: PCB, options: Options): PCBTrackAnchor[] {
  return fixedTrackAnchors(board, options, true);
}

function fixedTrackAnchors(
  board: PCB,
  options: Options & { centers?: boolean },
  borrowOwned: boolean,
): (PCBTrackAnchor & { center?: Point })[] {
  const canBorrow = borrowOwned && isOwnedPCB(board);
  const anchors: (PCBTrackAnchor & { center?: Point })[] = [];
  let vertices = 0;
  const add = (anchor: PCBTrackAnchor & { center?: Point }) => {
    vertices +=
      anchor.polygon.outer.length + anchor.polygon.holes.reduce((n, ring) => n + ring.length, 0);
    if (vertices > 120000) throw new Error(options.limitMessage);
    anchors.push(anchor);
  };
  for (const footprint of board.footprints)
    for (const pad of footprint.pads) {
      if (!pad.netId || (options.netId !== undefined && pad.netId !== options.netId)) continue;
      const layers = padCopperLayers(board, footprint, pad);
      if (!layers.length || (options.layer !== undefined && !layers.includes(options.layer)))
        continue;
      const polygon =
        canBorrow && isOwnedProjectNode(footprint) && isOwnedProjectNode(pad)
          ? borrowPCBPadCopperContour(footprint, pad)
          : copyPCBPadCopperContour(footprint, pad);
      add({
        id: pad.id,
        netId: pad.netId,
        layers,
        polygon,
        ...(options.centers && { center: padPosition(footprint, pad) }),
      });
    }
  for (const via of board.vias)
    if (options.netId === undefined || via.netId === options.netId)
      add({
        id: via.id,
        netId: via.netId,
        layers: [...board.layers],
        polygon: {
          outer: circlePolygon(via, via.diameter / 2),
          holes: [circlePolygon(via, via.drill / 2)],
        },
        ...(options.centers && { center: { x: via.x, y: via.y } }),
      });
  return anchors;
}
