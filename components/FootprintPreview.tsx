'use client';
import { useLayoutEffect, useRef, useState } from 'react';
import { child, children, num, val, type SExpr } from '@/lib/sexpr';
import { arcPath } from './SymbolGraphic';

export default function FootprintPreview({ footprint }: { footprint: SExpr }) {
  const ref = useRef<SVGGElement>(null);
  const [box, setBox] = useState('-10 -10 20 20');
  useLayoutEffect(() => {
    const measure = () => {
      const b = ref.current?.getBBox();
      if (!b || (!b.width && !b.height)) return;
      const size = Math.max(b.width, b.height, 2) * 1.25;
      setBox(`${b.x + b.width / 2 - size / 2} ${b.y + b.height / 2 - size / 2} ${size} ${size}`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (ref.current?.ownerSVGElement) observer.observe(ref.current.ownerSVGElement);
    return () => observer.disconnect();
  }, [footprint]);
  if (
    children(footprint, 'pad').some(
      (p) =>
        !['rect', 'roundrect', 'circle', 'oval'].includes(String(p[3])) ||
        val(child(p, 'drill')) === 'oval',
    )
  )
    return (
      <p className="dialog-notice">
        This footprint uses custom pads. Its complete library file is preserved; a 2D preview is
        unavailable.
      </p>
    );
  return (
    <svg className="footprint-preview" viewBox={box} aria-label="Footprint preview">
      <g ref={ref} stroke="var(--symbol)" strokeWidth="0.12" fill="none">
        {footprint
          .filter((n): n is SExpr => Array.isArray(n))
          .map((n, i) => {
            const layer = val(child(n, 'layer'));
            if (layer && !['F.SilkS', 'F.Fab', 'F.CrtYd'].includes(layer)) return null;
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
                  points={children(child(n, 'pts') || [], 'xy')
                    .map((p) => `${num(p)},${num(p, 2)}`)
                    .join(' ')}
                />
              );
            if (n[0] === 'pad') {
              const at = child(n, 'at'),
                size = child(n, 'size'),
                width = num(size),
                height = num(size, 2);
              const radius =
                n[3] === 'roundrect'
                  ? Math.min(width, height) * num(child(n, 'roundrect_rratio'))
                  : n[3] === 'oval'
                    ? Math.min(width, height) / 2
                    : 0;
              return (
                <g
                  key={i}
                  transform={`translate(${num(at)} ${num(at, 2)}) rotate(${-num(at, 3)})`}
                  fill="var(--wire)"
                >
                  {n[3] === 'circle' ? (
                    <circle r={width / 2} />
                  ) : (
                    <rect
                      x={-width / 2}
                      y={-height / 2}
                      width={width}
                      height={height}
                      rx={radius}
                    />
                  )}
                  {child(n, 'drill') && (
                    <circle r={num(child(n, 'drill')) / 2} fill="var(--canvas)" />
                  )}
                  <text
                    textAnchor="middle"
                    dominantBaseline="central"
                    fill="var(--on-accent)"
                    stroke="none"
                    fontSize={Math.min(width, height) * 0.55}
                  >
                    {val(n)}
                  </text>
                </g>
              );
            }
            return null;
          })}
      </g>
    </svg>
  );
}
