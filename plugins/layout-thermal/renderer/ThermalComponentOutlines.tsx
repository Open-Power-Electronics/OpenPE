import { memo } from 'react';
import type { Footprint } from '@/lib/pcb';
import type { PCBDisplay } from '@/lib/pcb-display';
import type { ThermalSurface } from '@/plugins/layout-thermal/domain/thermal-view';
import PCBGraphic from '../../../components/PCBGraphic';

/** Presentation above the temperature raster; native placement and artwork stay exact. */
export default memo(function ThermalComponentOutlines({
  footprints,
  surface,
  layers,
}: {
  footprints: Footprint[];
  surface: ThermalSurface;
  layers: PCBDisplay;
}) {
  if (!layers.footprints) return null;
  const prefix = surface === 'front' ? 'F.' : 'B.';
  return (
    <g
      data-thermal-component-outlines=""
      data-thermal-outline-surface={surface}
      pointerEvents="none"
    >
      {footprints
        .filter((footprint) => footprint.side === surface)
        .map((footprint) => {
          const graphics = footprint.graphics.filter(
            (graphic) =>
              graphic.kind !== 'text' &&
              graphic.kind !== 'dimension' &&
              (graphic.layer === `${prefix}Fab` || graphic.layer === `${prefix}SilkS`) &&
              layers[graphic.layer],
          );
          if (!graphics.length) return null;
          return (
            <g
              key={footprint.id}
              data-thermal-outline-footprint={footprint.id}
              transform={`translate(${footprint.x} ${footprint.y}) rotate(${-footprint.rotation})`}
            >
              {['halo', 'ink'].map((pass) => (
                <g key={pass} className={`thermal-outline-${pass}`}>
                  {graphics.map((graphic) => (
                    <PCBGraphic
                      key={graphic.id}
                      graphic={{ ...graphic, fill: false }}
                      color={pass === 'halo' ? '#fff' : '#202020'}
                    />
                  ))}
                </g>
              ))}
            </g>
          );
        })}
    </g>
  );
});
