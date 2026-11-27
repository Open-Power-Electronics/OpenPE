import type { Footprint, Pad } from './pcb';
import { isOwnedProjectNode } from './immutable-project';
import {
  padDrillPolygon,
  padPolygon,
  polygonResolution,
  subtractPolygons,
  type Polygon,
} from './pcb-polygons';
import { polygonEdges, segmentDistance } from './pcb-collision';

// Shared private geometry for connectivity and fixed track contacts. Each
// footprint owns its pad identities, bounding the inner map by its actual pads;
// the weak key releases contours with the immutable footprint.
type PadContours = { outline: Polygon; copper?: Polygon; retained: boolean };
const ownedContours = new WeakMap<Footprint, Map<Pad, PadContours>>();
const canRetain = (footprint: Footprint, pad: Pad) =>
  isOwnedProjectNode(footprint) && isOwnedProjectNode(pad) && footprint.pads.includes(pad);

function freezeContour(polygon: Polygon) {
  for (const ring of [polygon.outer, ...polygon.holes]) {
    for (const point of ring) Object.freeze(point);
    Object.freeze(ring);
  }
  Object.freeze(polygon.holes);
  Object.freeze(polygon);
}

function padContours(footprint: Footprint, pad: Pad): PadContours {
  const owned = canRetain(footprint, pad);
  const contours = owned ? ownedContours.get(footprint) : undefined;
  const saved = contours?.get(pad);
  if (saved) return saved;
  const result: PadContours = { outline: padPolygon(footprint, pad), retained: owned };
  if (owned) {
    freezeContour(result.outline);
    const next = contours ?? new Map<Pad, PadContours>();
    next.set(pad, result);
    if (!contours) ownedContours.set(footprint, next);
  }
  return result;
}

/** Internal read-only borrowing. Retained contours are deeply frozen and never
 * form public airwire points or mutable track-anchor polygons. Ownership
 * certifies immutable inputs only; callers still validate geometry/work bounds.
 */
export function borrowPCBPadOutline(footprint: Footprint, pad: Pad): Polygon {
  return padContours(footprint, pad).outline;
}

export function borrowPCBPadCopperContour(footprint: Footprint, pad: Pad): Polygon {
  const contours = padContours(footprint, pad);
  if (contours.copper) return contours.copper;
  const polygon: Polygon = pad.drill
    ? {
        outer: contours.outline.outer,
        holes: [...contours.outline.holes, padDrillPolygon(footprint, pad)],
      }
    : contours.outline;
  if (contours.retained && pad.drill) freezeContour(polygon);
  contours.copper = polygon;
  return polygon;
}

/** Physical copper sections can have different lands around one shared drill. */
export function inspectPCBPadLand(footprint: Footprint, pad: Pad, outline: Polygon): Polygon[] {
  if (!pad.drill) return [outline];
  const bore = { outer: padDrillPolygon(footprint, pad), holes: [] };
  return subtractPolygons([outline], [bore]);
}

export function pcbPadLandTouchesBarrel(
  footprint: Footprint,
  pad: Pad,
  polygon: Polygon,
  spend: () => void,
) {
  if (!pad.drill || pad.type !== 'thru_hole') return false;
  const rim = polygonEdges({ outer: padDrillPolygon(footprint, pad), holes: [] });
  return polygonEdges(polygon).some(([a, b]) =>
    rim.some(([c, d]) => {
      spend();
      return segmentDistance(a, b, c, d) <= 2 * polygonResolution ** 2;
    }),
  );
}

/** Public geometry remains independently mutable, including every hole/point. */
export function copyPCBPadCopperContour(footprint: Footprint, pad: Pad): Polygon {
  const polygon = borrowPCBPadCopperContour(footprint, pad);
  if (!canRetain(footprint, pad)) return polygon;
  const copyRing = (ring: Polygon['outer']) => ring.map((point) => ({ ...point }));
  return { outer: copyRing(polygon.outer), holes: polygon.holes.map(copyRing) };
}
