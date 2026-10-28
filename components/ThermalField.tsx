'use client';

import { memo, useMemo } from 'react';
import type { ThermalResult } from '@/lib/thermal';
import {
  hottestThermalNode,
  rasterizeThermalSurface,
  type ThermalProbe,
  type ThermalSurface,
} from '@/lib/thermal-view';

type Props = {
  result: ThermalResult;
  surface: ThermalSurface;
  probe: ThermalProbe | null;
};

/** The field uses PCB millimetres so Layout and exported maps share the same geometry. */
function ThermalField({ result, surface, probe }: Props) {
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
      hottest: hottestThermalNode(result, surface),
    };
  }, [result, surface]);
  if (!field) return null;
  const { bounds, hottest } = field;
  const radius = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) / 100;
  const visibleProbe = probe && hottest && Math.abs(probe.z - hottest.z) <= 1e-6 ? probe : null;
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
      {hottest && (
        <g
          data-thermal-hottest={hottest.node}
          pointerEvents="none"
          transform={`translate(${hottest.x} ${hottest.y})`}
          aria-label={`Hottest ${surface} surface node: ${hottest.temperatureC.toFixed(2)} °C`}
        >
          <circle
            r={radius}
            fill="none"
            stroke="#fff"
            strokeWidth="4"
            vectorEffect="non-scaling-stroke"
          />
          <circle
            r={radius}
            fill="none"
            stroke="#202020"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={`M${-radius * 1.6} 0H${radius * 1.6}M0 ${-radius * 1.6}V${radius * 1.6}`}
            stroke="#202020"
            strokeWidth="1"
            vectorEffect="non-scaling-stroke"
          />
        </g>
      )}
      {visibleProbe && (
        <g
          data-thermal-probe={visibleProbe.node}
          transform={`translate(${visibleProbe.x} ${visibleProbe.y})`}
          pointerEvents="none"
        >
          <circle
            r={radius * 1.25}
            fill="#fff"
            stroke="#202020"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
          <circle r={radius * 0.35} fill="#202020" />
        </g>
      )}
    </g>
  );
}

export default memo(ThermalField);
