import type { PCBBounds } from './pcb-layout';
import { createLayoutGridApplicator } from './drawing-grid';
import { flushLayoutCamera } from './layout-camera-presentation';

type DrawingPNG = { dataUrl: string; width: number; height: number };
/** Fit board bounds independently of the interactive camera; keep visible layers. */
export async function captureLayoutPNG(svg: SVGSVGElement, bounds: PCBBounds): Promise<DrawingPNG> {
  flushLayoutCamera(svg);
  return captureSVGPNG(svg, bounds, 'layout');
}

/** Export visible design content independently of pan/zoom, including rendered text extents. */
export async function captureSchematicPNG(svg: SVGSVGElement): Promise<DrawingPNG> {
  const inverse = svg.getScreenCTM()?.inverse();
  if (!inverse) throw new Error('The schematic is not visible.');
  const bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const node of svg.querySelectorAll<SVGGraphicsElement>(
    'path, rect, circle, line, polyline, polygon, ellipse, text',
  )) {
    if (
      node.closest(
        'defs, [data-schematic-background], [data-annotation-overlay], [data-export-exclude], [data-selection-only], [data-probe-part]',
      )
    )
      continue;
    const style = getComputedStyle(node),
      box = node.getBoundingClientRect();
    if (style.display === 'none' || style.visibility === 'hidden' || (!box.width && !box.height))
      continue;
    for (const point of [new DOMPoint(box.left, box.top), new DOMPoint(box.right, box.bottom)]) {
      const p = point.matrixTransform(inverse);
      const x = Math.round(p.x * 1e6) / 1e6,
        y = Math.round(p.y * 1e6) / 1e6;
      bounds.minX = Math.min(bounds.minX, x);
      bounds.minY = Math.min(bounds.minY, y);
      bounds.maxX = Math.max(bounds.maxX, x);
      bounds.maxY = Math.max(bounds.maxY, y);
    }
  }
  if (!Number.isFinite(bounds.minX))
    throw new Error('Show schematic content before exporting an image.');
  return captureSVGPNG(
    svg,
    {
      minX: bounds.minX - 4,
      minY: bounds.minY - 4,
      maxX: bounds.maxX + 4,
      maxY: bounds.maxY + 4,
    },
    'schematic',
  );
}

async function captureSVGPNG(
  svg: SVGSVGElement,
  bounds: PCBBounds,
  surface: 'layout' | 'schematic',
): Promise<DrawingPNG> {
  const width = bounds.maxX - bounds.minX,
    height = bounds.maxY - bounds.minY;
  if (!(width > 0 && height > 0))
    throw new Error('A closed board outline is required to export an image.');
  const scale = Math.min(20, 4096 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(4096, Math.max(1, Math.ceil(width * scale)));
  canvas.height = Math.min(4096, Math.max(1, Math.ceil(height * scale)));
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const originals = [svg, ...svg.querySelectorAll<SVGElement>('*')];
  const copies = [copy, ...copy.querySelectorAll<SVGElement>('*')];
  const properties = [
    'fill',
    'fill-opacity',
    'fill-rule',
    'stroke',
    'stroke-width',
    'stroke-opacity',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-dasharray',
    'color',
    'font-family',
    'font-size',
    'font-weight',
    'font-style',
    'text-anchor',
    'dominant-baseline',
    'opacity',
    'display',
    'visibility',
    'paint-order',
  ];
  originals.forEach((node, i) => {
    const style = getComputedStyle(node);
    for (const property of properties)
      copies[i].style.setProperty(property, style.getPropertyValue(property));
    // Selected copper bypasses net dimming only in the interactive canvas.
    const opacity = node.getAttribute('data-export-opacity');
    if (opacity !== null) copies[i].style.setProperty('opacity', opacity);
    copies[i].removeAttribute('data-export-opacity');
    copies[i].removeAttribute('tabindex');
  });
  copy
    .querySelectorAll('[data-annotation-overlay], [data-export-exclude], [data-selection-only]')
    .forEach((node) => node.remove());
  if (surface === 'schematic') {
    copy.querySelectorAll('[filter]').forEach((node) => node.removeAttribute('filter'));
    copy.querySelectorAll('[data-probe-part]').forEach((node) => node.remove());
  }
  copy
    .querySelectorAll('[data-layout-background], [data-layout-grid], [data-schematic-background]')
    .forEach((node) => {
      node.setAttribute('x', String(bounds.minX));
      node.setAttribute('y', String(bounds.minY));
      node.setAttribute('width', String(width));
      node.setAttribute('height', String(height));
    });
  copy.setAttribute('viewBox', `${bounds.minX} ${bounds.minY} ${width} ${height}`);
  copy.setAttribute('width', String(canvas.width));
  copy.setAttribute('height', String(canvas.height));
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  if (surface === 'layout')
    createLayoutGridApplicator(copy)(Math.max(width / canvas.width, height / canvas.height));
  const url = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(copy)], { type: 'image/svg+xml' }),
  );
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Image export timed out. Try hiding detailed layers.')),
        10000,
      );
      image.onload = () => {
        clearTimeout(timer);
        resolve();
      };
      image.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`Could not render the ${surface} image.`));
      };
      image.src = url;
    });
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Image export is unavailable.');
    if (surface === 'schematic') {
      context.fillStyle = getComputedStyle(svg).getPropertyValue('--canvas').trim() || '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(image, 0, 0);
    return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}
export async function saveDrawingPNG(image: DrawingPNG, name: string): Promise<string | null> {
  if (!window.openpe) throw new Error('Use the desktop app to export a PNG.');
  const result = await window.openpe.exportImage({ ...image, name });
  return result?.name ?? null;
}
