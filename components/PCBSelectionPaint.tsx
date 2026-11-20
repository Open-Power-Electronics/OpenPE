import type { ReactNode } from 'react';

/** Keep native layer paint for exports; lock and selection paint stay on the canvas. */
export default function PCBSelectionPaint({
  color,
  selected,
  locked = false,
  children,
}: {
  color: string;
  selected: boolean;
  locked?: boolean;
  children: (color: string, selection: boolean) => ReactNode;
}) {
  return (
    <>
      {children(color, false)}
      {locked && (
        <g data-layout-locked-paint data-export-exclude pointerEvents="none" aria-hidden="true">
          {children('var(--pcb-locked)', true)}
        </g>
      )}
      {selected && (
        <g data-selection-only pointerEvents="none" aria-hidden="true">
          {children(
            `color-mix(in srgb, ${locked ? 'var(--pcb-locked)' : color}, var(--pcb-selection-tone) 55%)`,
            true,
          )}
        </g>
      )}
    </>
  );
}
