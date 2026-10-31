import type { Point } from './circuit';
import type { ThermalModel, ThermalResult } from './thermal';

export type ThermalPadReadout = {
  footprintId: string;
  reference: string;
  powerW: number;
  padMeanC: number | null;
  padMaxC: number | null;
};

function inside(point: Point, ring: Point[]) {
  let contained = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (
      a.y > point.y !== b.y > point.y &&
      point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x
    )
      contained = !contained;
  }
  return contained;
}

/** Read-only integration on the completed conforming source-pad triangles.
 * Missing or unresolved pad areas stay unavailable, never nearest-node estimates. */
export function thermalPadReadouts(
  model: ThermalModel,
  result: ThermalResult,
  references?: ReadonlyMap<string, string>,
): ThermalPadReadout[] {
  if (model.basis !== result.basis)
    throw new Error('The temperature field does not match its heat-source model.');
  const sources = model.sources.map((source) => {
    const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
    for (const polygon of source.polygons)
      for (const point of polygon.outer) {
        bounds.minX = Math.min(bounds.minX, point.x);
        bounds.maxX = Math.max(bounds.maxX, point.x);
        bounds.minY = Math.min(bounds.minY, point.y);
        bounds.maxY = Math.max(bounds.maxY, point.y);
      }
    return {
      source,
      z: source.side === 'front' ? model.layers[0].zMax : model.layers.at(-1)!.zMin,
      ...bounds,
      area: 0,
      integral: 0,
      maximum: -Infinity,
    };
  });
  for (const ids of result.triangles) {
    const [a, b, c] = ids.map((id) => result.points[id]);
    if (Math.abs(a.z - b.z) > 1e-6 || Math.abs(a.z - c.z) > 1e-6) continue;
    const at = { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 };
    const area = Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
    if (!(area > 0)) continue;
    for (const entry of sources) {
      if (
        Math.abs(a.z - entry.z) > 1e-6 ||
        at.x < entry.minX ||
        at.x > entry.maxX ||
        at.y < entry.minY ||
        at.y > entry.maxY
      )
        continue;
      if (
        !entry.source.polygons.some(
          (p) => inside(at, p.outer) && !p.holes.some((hole) => inside(at, hole)),
        )
      )
        continue;
      entry.area += area;
      entry.integral += (area * (a.temperatureC + b.temperatureC + c.temperatureC)) / 3;
      entry.maximum = Math.max(entry.maximum, a.temperatureC, b.temperatureC, c.temperatureC);
    }
  }
  const order = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  return sources
    .map(({ source, area, integral, maximum }) => {
      const resolved = area > 0 && Math.abs(area - source.areaMm2) / source.areaMm2 <= 0.02;
      return {
        footprintId: source.footprintId,
        reference: references?.get(source.footprintId) || source.reference || source.footprintId,
        powerW: source.powerW,
        padMeanC: resolved ? integral / area : null,
        padMaxC: resolved ? maximum : null,
      };
    })
    .sort((a, b) => b.powerW - a.powerW || order.compare(a.reference, b.reference));
}
