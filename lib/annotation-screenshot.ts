import {
  validateAnnotationImage,
  type AnnotationImage,
  type AnnotationBounds,
  type AnnotationMarkup,
} from './agent-annotations';
import { createLayoutGridApplicator } from './drawing-grid';
import { flushLayoutCamera } from './layout-camera-presentation';

export function annotationSelectionBounds(svg: SVGSVGElement, ids: string[]): AnnotationBounds {
  flushLayoutCamera(svg);
  const selected = new Set(ids);
  const inverse = svg.getScreenCTM()?.inverse();
  if (!inverse) throw new Error('The drawing is not visible.');
  const points = [...svg.querySelectorAll<SVGGraphicsElement>('[data-selection-id]')]
    .filter(
      (node) =>
        selected.has(node.dataset.selectionId!) && getComputedStyle(node).display !== 'none',
    )
    .flatMap((node) => {
      const b = node.getBoundingClientRect();
      return [new DOMPoint(b.left, b.top), new DOMPoint(b.right, b.bottom)].map((p) =>
        p.matrixTransform(inverse),
      );
    });
  if (!points.length) throw new Error('The selected elements are not visible. Select them again.');
  const x = Math.min(...points.map((p) => p.x)),
    y = Math.min(...points.map((p) => p.y));
  return {
    x,
    y,
    width: Math.max(1, Math.max(...points.map((p) => p.x)) - x),
    height: Math.max(1, Math.max(...points.map((p) => p.y)) - y),
  };
}

export function markupBounds(markup: AnnotationMarkup): AnnotationBounds {
  if (markup.kind === 'rectangle') return markup.bounds;
  const x = Math.min(...markup.points.map((p) => p.x)),
    y = Math.min(...markup.points.map((p) => p.y));
  return {
    x,
    y,
    width: Math.max(1, Math.max(...markup.points.map((p) => p.x)) - x),
    height: Math.max(1, Math.max(...markup.points.map((p) => p.y)) - y),
  };
}

/** Capture the freshly rendered Object canvas. Coordinates use a 1000-unit viewport width. */
export function captureObjectAnnotationImage(
  source: HTMLCanvasElement,
  bounds: AnnotationBounds,
  markup?: AnnotationMarkup,
): AnnotationImage {
  const ratio = source.height / source.width;
  const x = Math.max(0, bounds.x - 20),
    y = Math.max(0, bounds.y - 20);
  const width = Math.min(1000 - x, Math.max(60, bounds.width + 40));
  const height = Math.min(1000 * ratio - y, Math.max(45, bounds.height + 40));
  if (width <= 0 || height <= 0) throw new Error('The selected area is outside the 3D view.');
  const scale = Math.min(2, 1600 / width, 1200 / height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(1600, Math.max(1, Math.ceil(width * scale)));
  canvas.height = Math.min(1200, Math.max(1, Math.ceil(height * scale)));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Screenshot capture is unavailable.');
  context.fillStyle = getComputedStyle(source).getPropertyValue('--canvas').trim() || '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const pixels = source.width / 1000;
  context.drawImage(
    source,
    x * pixels,
    y * pixels,
    width * pixels,
    height * pixels,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  context.scale(canvas.width / width, canvas.height / height);
  context.translate(-x, -y);
  context.strokeStyle =
    getComputedStyle(source).getPropertyValue('--annotation-mark').trim() || '#528bff';
  context.lineWidth = 2 / scale;
  context.lineCap = context.lineJoin = 'round';
  if (markup?.kind === 'rectangle') {
    const b = markup.bounds;
    context.strokeRect(b.x, b.y, b.width, b.height);
  } else if (markup) {
    context.beginPath();
    markup.points.forEach((p, i) => (i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y)));
    context.stroke();
  }
  const image = {
    dataUrl: canvas.toDataURL('image/png'),
    width: canvas.width,
    height: canvas.height,
  };
  validateAnnotationImage(image);
  return image;
}

/** Rasterize only the design canvas, with selected elements and their nearby context. */
export async function captureAnnotationImage(
  svg: SVGSVGElement,
  ids: string[],
  bounds = annotationSelectionBounds(svg, ids),
  markup?: AnnotationMarkup,
): Promise<AnnotationImage> {
  flushLayoutCamera(svg);
  const minX = bounds.x - 8;
  const minY = bounds.y - 8;
  const width = Math.max(24, bounds.width + 16);
  const height = Math.max(18, bounds.height + 16);
  const scale = Math.min(12, 1600 / width, 1200 / height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.min(1600, Math.max(1, Math.ceil(width * scale)));
  canvas.height = Math.min(1200, Math.max(1, Math.ceil(height * scale)));
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const originals = [svg, ...svg.querySelectorAll<SVGElement>('*')];
  const copies = [copy, ...copy.querySelectorAll<SVGElement>('*')];
  const properties = [
    'fill',
    'fill-opacity',
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
    'opacity',
    'display',
    'visibility',
    'paint-order',
    'flood-color',
    'flood-opacity',
  ];
  originals.forEach((node, index) => {
    const style = getComputedStyle(node);
    for (const property of properties)
      copies[index].style.setProperty(property, style.getPropertyValue(property));
    copies[index].removeAttribute('tabindex');
    // Computed filters contain document URLs; keep the original fragment reference.
  });
  copy.querySelectorAll('[data-annotation-overlay]').forEach((node) => node.remove());
  const layoutFrames = copy.querySelectorAll('[data-layout-background], [data-layout-grid]');
  if (layoutFrames.length) {
    const viewport = svg
      .getAttribute('viewBox')
      ?.trim()
      .split(/[\s,]+/)
      .map(Number);
    if (
      !viewport ||
      viewport.length !== 4 ||
      !viewport.every(Number.isFinite) ||
      viewport[2] <= 0 ||
      viewport[3] <= 0
    )
      throw new Error('The Layout viewport is unavailable. Try capturing again.');
    // The live camera may retain larger frames. Restore the old native viewport
    // only in this clone so the annotation crop cannot expose extra grid pixels.
    for (const frame of layoutFrames)
      ['x', 'y', 'width', 'height'].forEach((name, index) =>
        frame.setAttribute(name, String(viewport[index])),
      );
  }
  if (markup) {
    const node = document.createElementNS(
      'http://www.w3.org/2000/svg',
      markup.kind === 'rectangle' ? 'rect' : 'polyline',
    );
    if (markup.kind === 'rectangle') {
      for (const [key, value] of Object.entries(markup.bounds))
        node.setAttribute(key, String(value));
    } else node.setAttribute('points', markup.points.map((p) => `${p.x},${p.y}`).join(' '));
    node.setAttribute('fill', 'none');
    node.setAttribute(
      'stroke',
      getComputedStyle(svg).getPropertyValue('--annotation-mark').trim() || '#528bff',
    );
    node.setAttribute('stroke-width', String(Math.max(0.25, width / 600)));
    node.setAttribute('stroke-linecap', 'round');
    node.setAttribute('stroke-linejoin', 'round');
    copy.append(node);
  }
  copy.setAttribute('viewBox', `${minX} ${minY} ${width} ${height}`);
  copy.setAttribute('width', String(canvas.width));
  copy.setAttribute('height', String(canvas.height));
  copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  createLayoutGridApplicator(copy)(Math.max(width / canvas.width, height / canvas.height));
  const url = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(copy)], { type: 'image/svg+xml' }),
  );
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Screenshot capture timed out. Try selecting fewer elements.')),
        5000,
      );
      image.onload = () => {
        clearTimeout(timer);
        resolve();
      };
      image.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Could not capture the drawing.'));
      };
      image.src = url;
    });
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Screenshot capture is unavailable.');
    context.fillStyle = getComputedStyle(svg).getPropertyValue('--canvas').trim() || '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const result = {
      dataUrl: canvas.toDataURL('image/png'),
      width: canvas.width,
      height: canvas.height,
    };
    validateAnnotationImage(result);
    return result;
  } finally {
    URL.revokeObjectURL(url);
  }
}
