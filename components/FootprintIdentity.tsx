'use client';

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Footprint } from '@/lib/pcb';
import { pcbPadPath } from '@/lib/pcb-geometry';
import PCBGraphic from './PCBGraphic';

/** Board-only packages have no schematic symbol; preview their actual local geometry. */
export default function FootprintIdentity({
  footprint,
  actions,
}: {
  footprint: Footprint;
  actions?: ReactNode;
}) {
  const drawing = useRef<SVGGElement>(null);
  const [viewBox, setViewBox] = useState('-2 -2 4 4');
  useLayoutEffect(() => {
    const measure = () => {
      const bounds = drawing.current?.getBBox();
      if (!bounds || (!bounds.width && !bounds.height)) return;
      const size = Math.max(bounds.width, bounds.height, 1) * 1.25;
      setViewBox(
        `${bounds.x + bounds.width / 2 - size / 2} ${bounds.y + bounds.height / 2 - size / 2} ${size} ${size}`,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (drawing.current?.ownerSVGElement) observer.observe(drawing.current.ownerSVGElement);
    return () => observer.disconnect();
  }, [footprint]);
  return (
    <div className="inspector-symbol">
      <div className="component-preview" aria-description="Board-only footprint">
        <svg
          className="footprint-identity-preview"
          viewBox={viewBox}
          role="img"
          aria-label="Footprint preview"
        >
          <g ref={drawing}>
            {footprint.graphics
              .filter((graphic) => graphic.kind !== 'text' && graphic.kind !== 'dimension')
              .map((graphic) => (
                <PCBGraphic
                  key={graphic.id}
                  graphic={graphic}
                  color="var(--symbol)"
                  width={graphic.width || 0.12}
                />
              ))}
            {footprint.pads.map((pad) => (
              <g
                key={pad.id}
                data-preview-pad={pad.number}
                transform={`translate(${pad.x} ${pad.y}) rotate(${-pad.rotation})`}
                fill="var(--symbol)"
              >
                {pad.shape === 'circle' ? (
                  <circle r={pad.size.x / 2} />
                ) : pad.shape === 'oval' ? (
                  <rect
                    x={-pad.size.x / 2}
                    y={-pad.size.y / 2}
                    width={pad.size.x}
                    height={pad.size.y}
                    rx={Math.min(pad.size.x, pad.size.y) / 2}
                  />
                ) : (
                  <path d={pcbPadPath(pad)} />
                )}
                {pad.drill && (
                  <circle
                    cx={pad.drillOffset?.x ?? 0}
                    cy={pad.drillOffset?.y ?? 0}
                    r={pad.drill / 2}
                    fill="var(--panel)"
                  />
                )}
              </g>
            ))}
          </g>
        </svg>
      </div>
      <div>
        <strong title={footprint.libraryId}>{footprint.libraryId}</strong>
      </div>
      {actions}
    </div>
  );
}
