import type { ReactNode } from 'react';

/** Redraw selected geometry in its layer hue; exports retain the original paint. */
export default function PCBSelectionPaint({
  color,
  selected,
  children,
}: {
  color: string;
  selected: boolean;
  children: (color: string, selection: boolean) => ReactNode;
}) {
  return (
    <>
      {children(color, false)}
      {selected && (
        <g data-selection-only pointerEvents="none" aria-hidden="true">
          {children(`color-mix(in srgb, ${color}, var(--pcb-selection-tone) 55%)`, true)}
        </g>
      )}
    </>
  );
}
