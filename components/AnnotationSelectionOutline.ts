import { useId, useLayoutEffect, type RefObject } from 'react';
import { flushLayoutCamera } from '@/lib/layout-camera-presentation';

const ns = 'http://www.w3.org/2000/svg';
const paintProperties = [
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'opacity',
  'display',
  'visibility',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'text-anchor',
  'dominant-baseline',
  'paint-order',
  'vector-effect',
];

/** Disposable copies of visible SVG paint; hit targets and editor identities never enter the outline. */
export function useAnnotationSelectionOutline(
  svg: RefObject<SVGSVGElement | null>,
  ids: readonly string[],
  active: boolean,
  view: { x: number; y: number; width: number },
) {
  const id = `annotation-outline-${useId().replace(/:/g, '')}`;
  useLayoutEffect(() => {
    const source = svg.current;
    if (!active || !source || !ids.length) return;
    flushLayoutCamera(source);
    const matrix = source.getScreenCTM();
    if (!matrix) return;
    const inverse = matrix.inverse();
    const radius = 2 / Math.hypot(matrix.a, matrix.b);
    const overlay = document.createElementNS(ns, 'g');
    overlay.setAttribute('data-annotation-selection-outline', '');
    overlay.setAttribute('data-export-exclude', '');
    overlay.setAttribute('pointer-events', 'none');
    overlay.setAttribute('aria-hidden', 'true');
    const selected = new Set(ids);
    const nodes = [...source.querySelectorAll<SVGGraphicsElement>('[data-selection-id]')].filter(
      (node) => selected.has(node.dataset.selectionId!) && !node.closest('defs'),
    );
    for (const node of nodes) {
      if (nodes.some((parent) => parent !== node && parent.contains(node))) continue;
      const transform = node.getScreenCTM();
      const box = node.getBoundingClientRect();
      if (
        !transform ||
        (!box.width && !box.height) ||
        node.closest('[data-export-exclude], [data-selection-only]') ||
        getComputedStyle(node).visibility === 'hidden'
      )
        continue;
      const copy = node.cloneNode(true) as SVGGraphicsElement;
      const originals = [node, ...node.querySelectorAll<SVGElement>('*')];
      const copies = [copy, ...copy.querySelectorAll<SVGElement>('*')];
      originals.forEach((original, index) => {
        const clone = copies[index];
        const style = getComputedStyle(original);
        for (const property of paintProperties)
          clone.style.setProperty(property, style.getPropertyValue(property));
        clone.style.pointerEvents = 'none';
        for (const name of [...clone.attributes].map((attribute) => attribute.name))
          if (name === 'id' || name.startsWith('data-') || name.startsWith('on'))
            clone.removeAttribute(name);
        if (original.closest('[data-export-exclude], [data-selection-only]')) clone.remove();
      });
      copy.removeAttribute('transform');
      const wrapper = document.createElementNS(ns, 'g');
      const local = inverse.multiply(transform);
      wrapper.setAttribute(
        'transform',
        `matrix(${local.a} ${local.b} ${local.c} ${local.d} ${local.e} ${local.f})`,
      );
      wrapper.append(copy);
      overlay.append(wrapper);
    }
    source.append(overlay);
    const bounds = overlay.getBBox();
    // Keep the filter in drawing coordinates, including horizontal/vertical wires.
    const padding = Math.max(radius * 4, view.width / 50);
    const filter = document.createElementNS(ns, 'filter');
    filter.id = id;
    filter.setAttribute('filterUnits', 'userSpaceOnUse');
    for (const [key, value] of Object.entries({
      x: bounds.x - padding,
      y: bounds.y - padding,
      width: bounds.width + padding * 2,
      height: bounds.height + padding * 2,
    }))
      filter.setAttribute(key, String(value));
    const dilate = document.createElementNS(ns, 'feMorphology');
    dilate.setAttribute('in', 'SourceAlpha');
    dilate.setAttribute('operator', 'dilate');
    dilate.setAttribute('radius', String(radius));
    dilate.setAttribute('result', 'expanded');
    const ring = document.createElementNS(ns, 'feComposite');
    ring.setAttribute('in', 'expanded');
    ring.setAttribute('in2', 'SourceAlpha');
    ring.setAttribute('operator', 'out');
    ring.setAttribute('result', 'ring');
    const color = document.createElementNS(ns, 'feFlood');
    color.setAttribute(
      'flood-color',
      getComputedStyle(source).getPropertyValue('--annotation-mark').trim() || '#528bff',
    );
    const paint = document.createElementNS(ns, 'feComposite');
    paint.setAttribute('in2', 'ring');
    paint.setAttribute('operator', 'in');
    filter.append(dilate, ring, color, paint);
    const defs = document.createElementNS(ns, 'defs');
    defs.append(filter);
    overlay.prepend(defs);
    overlay.setAttribute('filter', `url(#${id})`);
    return () => overlay.remove();
  }, [svg, ids, active, view.x, view.y, view.width, id]);
}
