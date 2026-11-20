'use client';

import { memo } from 'react';
import type { Footprint } from '@/lib/pcb';
import type { PCBDisplay } from '@/lib/pcb-display';
import { pcbFootprintBodyBounds } from '@/lib/pcb-display';
import type { ThermalLayoutPresentation } from './ThermalLayoutResults';

/** Selection above the temperature field, independent of native artwork. */
export default memo(function ThermalComponentHighlight({
  presentation,
  footprint,
  layers,
  scale,
}: {
  presentation: ThermalLayoutPresentation;
  footprint: Footprint;
  layers: PCBDisplay;
  scale: number;
}) {
  const { project } = presentation;
  const bounds = project.pcb && pcbFootprintBodyBounds(project.pcb, footprint, layers);
  if (!bounds) return null;
  const reference =
    footprint.reference ||
    project.schematic.parts.find((part) => part.id === footprint.symbolId)?.ref ||
    footprint.id.slice(0, 8);
  return (
    <g
      data-thermal-component-highlight={footprint.id}
      pointerEvents="none"
      role="img"
      aria-label={`Selected component ${reference}`}
    >
      <g transform={`translate(${footprint.x} ${footprint.y}) rotate(${-footprint.rotation})`}>
        <rect
          x={bounds.minX - 2 * scale}
          y={bounds.minY - 2 * scale}
          width={bounds.maxX - bounds.minX + 4 * scale}
          height={bounds.maxY - bounds.minY + 4 * scale}
          rx={2 * scale}
          fill="rgb(102 179 255 / 18%)"
          stroke="#fff"
          strokeWidth={4}
          vectorEffect="non-scaling-stroke"
        />
        <rect
          x={bounds.minX - 2 * scale}
          y={bounds.minY - 2 * scale}
          width={bounds.maxX - bounds.minX + 4 * scale}
          height={bounds.maxY - bounds.minY + 4 * scale}
          rx={2 * scale}
          fill="none"
          stroke="#202020"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      </g>
    </g>
  );
});
