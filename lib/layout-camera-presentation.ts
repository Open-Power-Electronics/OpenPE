type CameraPresentation = { flush: () => void; retire?: () => void };
const presentations = new WeakMap<SVGSVGElement, CameraPresentation>();

/** Connect one committed editor binding to programmatic presentation captures. */
export function registerLayoutCameraFlush(
  svg: SVGSVGElement,
  flush: () => void,
  retire?: () => void,
): (() => void) & { isCurrent: () => boolean } {
  presentations.get(svg)?.retire?.();
  const presentation = { flush, retire };
  presentations.set(svg, presentation);
  const isCurrent = () => presentations.get(svg) === presentation;
  return Object.assign(
    () => {
      if (isCurrent()) presentations.delete(svg);
    },
    { isCurrent },
  );
}

/** Captures and DOM bounds must observe the exact native camera before reading. */
export function flushLayoutCamera(svg: SVGSVGElement | null): void {
  if (svg) presentations.get(svg)?.flush();
}
