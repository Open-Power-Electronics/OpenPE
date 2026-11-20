type LayoutGridMetrics = { spacing: number; radius: number };

/** Thin only the displayed dots; the selected spacing remains the snap interval. */
export function layoutGridMetrics(spacing: number, unitsPerPixel: number): LayoutGridMetrics {
  if (!(spacing > 0) || !Number.isFinite(spacing))
    throw new RangeError('Layout grid spacing must be finite and positive.');
  if (!(unitsPerPixel > 0) || !Number.isFinite(unitsPerPixel))
    throw new RangeError('Layout grid scale must be finite and positive.');
  let displaySpacing = spacing;
  while (displaySpacing / unitsPerPixel < 6) {
    displaySpacing *= 2;
    if (!Number.isFinite(displaySpacing))
      throw new RangeError('Layout grid spacing exceeds the supported display range.');
  }
  const radius = Math.min(0.14, spacing * 0.08);
  return {
    spacing: displaySpacing,
    radius: displaySpacing === spacing ? radius : Math.max(radius, unitsPerPixel * 0.5),
  };
}

/** Bind committed pattern nodes once, without querying the board during navigation. */
export function createLayoutGridApplicator(svg: SVGSVGElement): (unitsPerPixel: number) => void {
  const pattern = svg.querySelector<SVGPatternElement>('[data-layout-grid-pattern]');
  const circle = pattern?.querySelector<SVGCircleElement>('circle');
  const spacing = Number(pattern?.getAttribute('data-layout-grid-spacing'));
  if (!pattern || !circle || !(spacing > 0) || !Number.isFinite(spacing)) return () => {};
  const set = (node: SVGElement, name: string, value: number) => {
    const next = String(value);
    if (node.getAttribute(name) !== next) node.setAttribute(name, next);
  };
  return (unitsPerPixel) => {
    const metrics = layoutGridMetrics(spacing, unitsPerPixel);
    // Compare retained nodes even at the same scale: a React commit may have
    // replayed the selected spacing over the camera's display-only attributes.
    set(pattern, 'x', -metrics.spacing / 2);
    set(pattern, 'y', -metrics.spacing / 2);
    set(pattern, 'width', metrics.spacing);
    set(pattern, 'height', metrics.spacing);
    set(circle, 'cx', metrics.spacing / 2);
    set(circle, 'cy', metrics.spacing / 2);
    set(circle, 'r', metrics.radius);
  };
}
