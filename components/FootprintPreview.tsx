'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import { child, children, num, val, type SExpr } from '@/lib/sexpr';
import { readPadDrill } from '@/lib/pcb-drill';
import { pcbPadPath } from '@/lib/pcb-geometry';
import { padExtent, readCustomPad, validateCustomPad } from '@/lib/pcb-custom-pad';
import type { Pad } from '@/lib/pcb';
import { arcPath } from './SymbolGraphic';
import { PadDrillGraphic } from './PadDrillGraphic';
import LibraryPreviewViewport, { measurePreviewBounds } from './LibraryPreviewViewport';

const measurementBox = '-10 -10 20 20';

function rejectPad(message: string): never {
  throw new Error(message);
}

export function canPreviewFootprint(footprint: SExpr) {
  try {
    return children(footprint, 'pad').every((pad) => {
      const drill = readPadDrill(child(pad, 'drill'));
      const shape = val(pad, 3) as Pad['shape'];
      if (!['rect', 'roundrect', 'circle', 'oval', 'custom'].includes(shape)) return false;
      const size = child(pad, 'size');
      validateCustomPad(
        {
          shape,
          type: val(pad, 2) as Pad['type'],
          size: { x: num(size), y: num(size, 2) },
          ...readCustomPad(pad, rejectPad),
          drillOffset: drill.drillOffset,
        },
        rejectPad,
      );
      return true;
    });
  } catch {
    return false;
  }
}

export default function FootprintPreview({ footprint }: { footprint: SExpr }) {
  const ref = useRef<SVGGElement>(null);
  const [box, setBox] = useState(measurementBox);
  useLayoutEffect(() => {
    const drawing = ref.current;
    const svg = drawing?.ownerSVGElement;
    if (!drawing || !svg) return;
    const measure = () => {
      const b = measurePreviewBounds(drawing, measurementBox);
      if (!b || (!b.width && !b.height)) return;
      const size = Math.max(b.width, b.height, 2) * 1.25;
      setBox(`${b.x + b.width / 2 - size / 2} ${b.y + b.height / 2 - size / 2} ${size} ${size}`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(svg);
    return () => observer.disconnect();
  }, [footprint]);
  if (!canPreviewFootprint(footprint))
    return <p className="dialog-notice">This footprint has no supported 2D preview.</p>;
  return (
    <LibraryPreviewViewport kind="footprint" fitBox={box}>
      <g ref={ref} stroke="var(--symbol)" fill="none">
        {footprint
          .filter((n): n is SExpr => Array.isArray(n))
          .map((n, i) => {
            const layer = val(child(n, 'layer'));
            if (
              layer &&
              !['F.SilkS', 'F.Fab', 'F.CrtYd', 'F.Mask', 'B.Mask', 'Edge.Cuts'].includes(layer)
            )
              return null;
            const graphicFill = ['yes', 'solid'].includes(val(child(n, 'fill')))
              ? 'var(--symbol)'
              : undefined;
            if (n[0] === 'fp_line')
              return (
                <line
                  key={i}
                  x1={num(child(n, 'start'))}
                  y1={num(child(n, 'start'), 2)}
                  x2={num(child(n, 'end'))}
                  y2={num(child(n, 'end'), 2)}
                />
              );
            if (n[0] === 'fp_rect') {
              const a = child(n, 'start'),
                b = child(n, 'end');
              return (
                <rect
                  key={i}
                  fill={graphicFill}
                  x={Math.min(num(a), num(b))}
                  y={Math.min(num(a, 2), num(b, 2))}
                  width={Math.abs(num(a) - num(b))}
                  height={Math.abs(num(a, 2) - num(b, 2))}
                />
              );
            }
            if (n[0] === 'fp_circle') {
              const c = child(n, 'center'),
                e = child(n, 'end');
              return (
                <circle
                  key={i}
                  cx={num(c)}
                  fill={graphicFill}
                  cy={num(c, 2)}
                  r={Math.hypot(num(c) - num(e), num(c, 2) - num(e, 2))}
                />
              );
            }
            if (n[0] === 'fp_arc') return <path key={i} d={arcPath(n)} transform="scale(1 -1)" />;
            if (n[0] === 'fp_poly')
              return (
                <polygon
                  key={i}
                  fill={graphicFill}
                  fillOpacity={layer.endsWith('.Mask') ? 0.22 : undefined}
                  points={children(child(n, 'pts') || [], 'xy')
                    .map((p) => `${num(p)},${num(p, 2)}`)
                    .join(' ')}
                />
              );
            if (n[0] === 'pad') {
              const at = child(n, 'at'),
                drill = readPadDrill(child(n, 'drill')),
                copperX = -(drill.drillOffset?.x ?? 0),
                copperY = -(drill.drillOffset?.y ?? 0),
                size = child(n, 'size'),
                width = num(size),
                height = num(size, 2);
              const chamfer = child(n, 'chamfer')?.slice(1) as Pad['chamfer'];
              const { outline } = readCustomPad(n, rejectPad);
              const extent = padExtent({ size: { x: width, y: height }, outline });
              return (
                <g
                  key={i}
                  transform={`translate(${num(at)} ${num(at, 2)}) rotate(${-num(at, 3)})`}
                  fill="var(--wire)"
                >
                  {n[3] === 'circle' ? (
                    <circle cx={copperX} cy={copperY} r={width / 2} />
                  ) : n[3] === 'roundrect' || outline ? (
                    <path
                      transform={`translate(${copperX} ${copperY})`}
                      d={pcbPadPath({
                        size: { x: width, y: height },
                        roundrectRatio: num(child(n, 'roundrect_rratio')),
                        chamferRatio: num(child(n, 'chamfer_ratio')),
                        chamfer,
                        outline,
                      })}
                    />
                  ) : (
                    <rect
                      x={copperX - width / 2}
                      y={copperY - height / 2}
                      width={width}
                      height={height}
                      rx={n[3] === 'oval' ? Math.min(width, height) / 2 : 0}
                    />
                  )}
                  {drill.drill && (
                    <PadDrillGraphic pad={drill} offset={{ x: 0, y: 0 }} fill="var(--canvas)" />
                  )}
                  <text
                    x={copperX}
                    y={copperY}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill="var(--on-accent)"
                    stroke="none"
                    fontSize={Math.min(extent.x, extent.y) * 0.55}
                  >
                    {val(n)}
                  </text>
                </g>
              );
            }
            return null;
          })}
      </g>
    </LibraryPreviewViewport>
  );
}
