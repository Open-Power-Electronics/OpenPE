import type { ThermalResult } from './thermal';

export type ThermalSurface = 'front' | 'back';
export type ThermalProbe = ThermalResult['points'][number] & { node: number };
export type ThermalBounds = { minX: number; minY: number; maxX: number; maxY: number };

/** Surface triangles retain the native solver mesh; no field is invented between nodes. */
export function thermalSurface(result: ThermalResult, surface: ThermalSurface) {
  const z = result.points.reduce(
    (value, point) => (surface === 'front' ? Math.max(value, point.z) : Math.min(value, point.z)),
    surface === 'front' ? -Infinity : Infinity,
  );
  const triangles = result.triangles.filter((triangle) =>
    triangle.every((index) => Math.abs(result.points[index].z - z) <= 1e-6),
  );
  const indices = [...new Set(triangles.flat())];
  return { z, triangles, indices };
}

/** Extrema markers belong to the visible surface, rather than a projected internal node. */
export function hottestThermalNode(
  result: ThermalResult,
  surface: ThermalSurface,
): ThermalProbe | null {
  let hottest: ThermalProbe | null = null;
  for (const node of thermalSurface(result, surface).indices) {
    const point = result.points[node];
    if (!hottest || point.temperatureC > hottest.temperatureC) hottest = { ...point, node };
  }
  return hottest;
}

/** A probe can start only on an actual displayed boundary triangle, including its edges. */
export function pointOnThermalSurface(
  result: ThermalResult,
  point: { x: number; y: number },
  surface: ThermalSurface,
) {
  for (const triangle of thermalSurface(result, surface).triangles) {
    const [a, b, c] = triangle.map((node) => result.points[node]);
    const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(area) <= 1e-18) continue;
    const first = ((b.x - point.x) * (c.y - point.y) - (b.y - point.y) * (c.x - point.x)) / area;
    const second = ((c.x - point.x) * (a.y - point.y) - (c.y - point.y) * (a.x - point.x)) / area;
    const third = 1 - first - second;
    if (first >= -1e-10 && second >= -1e-10 && third >= -1e-10) return true;
  }
  return false;
}

/** Paint the actual boundary triangles into a bounded, transparent image.
 * Pixel-centre sampling avoids antialias seams or strokes extending into board voids.
 * Each triangle retains the same mean-node colour used by the SVG map. */
export function rasterizeThermalSurface(
  result: ThermalResult,
  surface: ThermalSurface,
  maximumSize = 1600,
) {
  const mesh = thermalSurface(result, surface);
  if (!mesh.indices.length) return null;
  const bounds = mesh.indices.reduce<ThermalBounds>(
    (current, index) => {
      const point = result.points[index];
      current.minX = Math.min(current.minX, point.x);
      current.minY = Math.min(current.minY, point.y);
      current.maxX = Math.max(current.maxX, point.x);
      current.maxY = Math.max(current.maxY, point.y);
      return current;
    },
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  if (!(spanX > 0 && spanY > 0)) return null;
  const size = Number.isFinite(maximumSize)
    ? Math.max(1, Math.min(1600, Math.floor(maximumSize)))
    : 1600;
  const scale = size / Math.max(spanX, spanY);
  const width = Math.max(1, Math.round(spanX * scale));
  const height = Math.max(1, Math.round(spanY * scale));
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (const triangle of mesh.triangles) {
    const a = result.points[triangle[0]];
    const b = result.points[triangle[1]];
    const c = result.points[triangle[2]];
    const x0 = ((a.x - bounds.minX) * width) / spanX;
    const x1 = ((b.x - bounds.minX) * width) / spanX;
    const x2 = ((c.x - bounds.minX) * width) / spanX;
    const y0 = ((a.y - bounds.minY) * height) / spanY;
    const y1 = ((b.y - bounds.minY) * height) / spanY;
    const y2 = ((c.y - bounds.minY) * height) / spanY;
    const mean = (a.temperatureC + b.temperatureC + c.temperatureC) / 3;
    const color = thermalRGB(mean, result.statistics.minC, result.statistics.maxC);
    const firstRow = Math.max(0, Math.ceil(Math.min(y0, y1, y2) - 0.5));
    const lastRow = Math.min(height - 1, Math.floor(Math.max(y0, y1, y2) - 0.5));
    for (let row = firstRow; row <= lastRow; row++) {
      const y = row + 0.5;
      let left = Infinity;
      let right = -Infinity;
      let intersections = 0;
      for (let edge = 0; edge < 3; edge++) {
        const ax = edge === 0 ? x0 : edge === 1 ? x1 : x2;
        const ay = edge === 0 ? y0 : edge === 1 ? y1 : y2;
        const bx = edge === 0 ? x1 : edge === 1 ? x2 : x0;
        const by = edge === 0 ? y1 : edge === 1 ? y2 : y0;
        if ((ay <= y && y < by) || (by <= y && y < ay)) {
          const x = ax + ((y - ay) * (bx - ax)) / (by - ay);
          left = Math.min(left, x);
          right = Math.max(right, x);
          intersections++;
        }
      }
      if (intersections !== 2) continue;
      const firstColumn = Math.max(0, Math.ceil(left - 0.5));
      const lastColumn = Math.min(width - 1, Math.ceil(right - 0.5) - 1);
      const lastOffset = (row * width + lastColumn) * 4;
      for (let offset = (row * width + firstColumn) * 4; offset <= lastOffset; offset += 4) {
        pixels[offset] = color[0];
        pixels[offset + 1] = color[1];
        pixels[offset + 2] = color[2];
        pixels[offset + 3] = 255;
      }
    }
  }
  return { bounds, width, height, pixels };
}

export function closestThermalNode(
  result: ThermalResult,
  point: { x: number; y: number; z?: number },
  surface: ThermalSurface,
): ThermalProbe | null {
  const candidates =
    point.z === undefined
      ? thermalSurface(result, surface).indices
      : result.points.map((_, i) => i);
  let nearest = -1;
  let distance = Infinity;
  for (const index of candidates) {
    const candidate = result.points[index];
    const d =
      (candidate.x - point.x) ** 2 +
      (candidate.y - point.y) ** 2 +
      (point.z === undefined ? 0 : (candidate.z - point.z) ** 2);
    if (d < distance) {
      nearest = index;
      distance = d;
    }
  }
  return nearest < 0 ? null : { ...result.points[nearest], node: nearest };
}

const stops = [
  [49, 54, 149],
  [69, 117, 180],
  [255, 255, 191],
  [244, 109, 67],
  [165, 0, 38],
];

function thermalRGB(temperatureC: number, minC: number, maxC: number) {
  const normalized =
    maxC > minC ? Math.max(0, Math.min(1, (temperatureC - minC) / (maxC - minC))) : 0.5;
  const position = normalized * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(position));
  const fraction = position - index;
  return stops[index].map((value, channel) =>
    Math.round(value + fraction * (stops[index + 1][channel] - value)),
  );
}

export function thermalColor(temperatureC: number, minC: number, maxC: number) {
  return `rgb(${thermalRGB(temperatureC, minC, maxC).join(',')})`;
}
