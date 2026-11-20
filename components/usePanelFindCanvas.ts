import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { panelFindCanvasRevealEvent } from './panel-find';

/** Presentation-only navigation, scoped to the canvas containing the rendered match. */
export default function usePanelFindCanvas(
  canvas: RefObject<SVGSVGElement | null>,
  locate: (id: string, range: Range) => boolean,
) {
  const current = useRef(locate);
  useLayoutEffect(() => {
    current.current = locate;
  });
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const reveal = (event: Event) => {
      if (!(event instanceof CustomEvent) || !(event.detail instanceof Range)) return;
      const range = event.detail;
      if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return;
      const target = range.startContainer.parentElement?.closest<SVGElement>(
        '[data-selection-id], [data-footprint-captions]',
      );
      const id = target?.dataset.selectionId ?? target?.dataset.footprintCaptions;
      if (id && current.current(id, range)) event.preventDefault();
    };
    element.addEventListener(panelFindCanvasRevealEvent, reveal);
    return () => element.removeEventListener(panelFindCanvasRevealEvent, reveal);
  }, [canvas]);
}

/** Fit the actual rendered object and its matched caption, using the native SVG transform. */
export function panelFindCanvasView(canvas: SVGSVGElement, id: string, range: Range) {
  const inverse = canvas.getScreenCTM()?.inverse();
  const ratio = canvas.viewBox.baseVal.height / canvas.viewBox.baseVal.width;
  if (!inverse || !Number.isFinite(ratio) || ratio <= 0) return null;
  const rectangles = [
    range.getBoundingClientRect(),
    ...[
      ...canvas.querySelectorAll<SVGGraphicsElement>(
        '[data-selection-id], [data-footprint-captions]',
      ),
    ]
      .filter((node) => (node.dataset.selectionId ?? node.dataset.footprintCaptions) === id)
      .map((node) => node.getBoundingClientRect()),
  ].filter((box) => box.width > 0 || box.height > 0);
  if (!rectangles.length) return null;
  const points = rectangles.flatMap((box) => [
    new DOMPoint(box.left, box.top).matrixTransform(inverse),
    new DOMPoint(box.right, box.bottom).matrixTransform(inverse),
  ]);
  const minX = Math.min(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxX = Math.max(...points.map((point) => point.x));
  const maxY = Math.max(...points.map((point) => point.y));
  const width = Math.max(8, (maxX - minX) * 2.5, ((maxY - minY) * 2.5) / ratio);
  const view = { x: (minX + maxX - width) / 2, y: (minY + maxY - width * ratio) / 2, width };
  return Object.values(view).every(Number.isFinite) ? view : null;
}
