'use client';

import { memo, useMemo } from 'react';
import type { ThermalResult } from '@/plugins/layout-thermal/domain/thermal';
import {
  hottestThermalNode,
  rasterizeThermalSurface,
  type ThermalProbe,
  type ThermalSurface,
} from '@/plugins/layout-thermal/domain/thermal-view';

type Props = {
  result: ThermalResult;
  surface: ThermalSurface;
  probe: ThermalProbe | null;
  markersShown?: boolean;
};

/** The field uses PCB millimetres so Layout and exported maps share the same geometry. */
function ThermalField({ result, surface, probe, markersShown = true }: Props) {
  const field = useMemo(() => {
    const raster = rasterizeThermalSurface(result, surface);
    if (!raster || typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = raster.width;
    canvas.height = raster.height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    const image = context.createImageData(raster.width, raster.height);
    image.data.set(raster.pixels);
    context.putImageData(image, 0, 0);
    return {
      href: canvas.toDataURL('image/png'),
      bounds: raster.bounds,
    };
  }, [result, surface]);
  if (!field) return null;
  const { bounds } = field;
  return (
    <g data-thermal-field="" data-thermal-surface={surface}>
      <image
        data-thermal-raster=""
        x={bounds.minX}
        y={bounds.minY}
        width={bounds.maxX - bounds.minX}
        height={bounds.maxY - bounds.minY}
        href={field.href}
        preserveAspectRatio="none"
        pointerEvents="none"
      />
      {markersShown && (
        <ThermalFieldMarkers
          result={result}
          surface={surface}
          probe={probe}
          scale={Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / 700}
        />
      )}
    </g>
  );
}

export const ThermalFieldMarkers = memo(function ThermalFieldMarkers({
  result,
  surface,
  probe,
  scale,
}: Omit<Props, 'markersShown'> & { scale: number }) {
  const hottest = useMemo(() => hottestThermalNode(result, surface), [result, surface]);
  const visibleProbe = probe && hottest && Math.abs(probe.z - hottest.z) <= 1e-6 ? probe : null;
  return (
    <g pointerEvents="none">
      {hottest && (
        <g
          data-thermal-hottest={hottest.node}
          pointerEvents="none"
          transform={`translate(${hottest.x} ${hottest.y}) scale(${scale})`}
          aria-label={`Hottest ${surface} surface node: ${hottest.temperatureC.toFixed(2)} °C`}
        >
          <path d="M0 -4L4 0 0 4 -4 0Z" fill="#202020" stroke="#fff" strokeWidth="1.5" />
        </g>
      )}
      {visibleProbe && (
        <g
          data-thermal-probe={visibleProbe.node}
          transform={`translate(${visibleProbe.x} ${visibleProbe.y}) scale(${scale})`}
          pointerEvents="none"
          aria-label={`Probe ${visibleProbe.temperatureC.toFixed(2)} °C`}
          aria-description={`Node ${visibleProbe.node}; ${visibleProbe.x}, ${visibleProbe.y}, ${visibleProbe.z} mm`}
        >
          <path d="M-8 0H-4M4 0H8M0 -8V-4M0 4V8" stroke="#fff" strokeWidth="3" />
          <path d="M-8 0H-4M4 0H8M0 -8V-4M0 4V8" stroke="#202020" strokeWidth="1" />
          <circle r="2" fill="#202020" stroke="#fff" strokeWidth="1" />
        </g>
      )}
    </g>
  );
});

export default memo(ThermalField);
