import { useMemo } from 'react';
import { child, children, num, val, type SExpr } from '@/lib/sexpr';
import { partFields, unitGraphics } from '@/lib/library';
import type { Part } from '@/lib/circuit';
import { symbolRole, symbolRoles } from '@/lib/symbol-role';
import SchematicSelectionPaint from './SchematicSelectionPaint';
export function arcPath(n: SExpr) {
  const start = child(n, 'start'),
    mid = child(n, 'mid'),
    end = child(n, 'end');
  const ax = num(start),
    ay = -num(start, 2),
    bx = num(mid),
    by = -num(mid, 2),
    cx = num(end),
    cy = -num(end, 2);
  const det = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
  if (Math.abs(det) < 1e-8) return `M ${ax} ${ay} L ${bx} ${by} L ${cx} ${cy}`;
  const aa = ax * ax + ay * ay,
    bb = bx * bx + by * by,
    cc = cx * cx + cy * cy;
  const ox = (aa * (by - cy) + bb * (cy - ay) + cc * (ay - by)) / det,
    oy = (aa * (cx - bx) + bb * (ax - cx) + cc * (bx - ax)) / det;
  const a = Math.atan2(ay - oy, ax - ox),
    b = Math.atan2(by - oy, bx - ox),
    c = Math.atan2(cy - oy, cx - ox);
  const positive = (v: number) => (v + Math.PI * 4) % (Math.PI * 2);
  const sweep = positive(b - a) < positive(c - a);
  const span = sweep ? positive(c - a) : positive(a - c);
  const radius = Math.hypot(ax - ox, ay - oy);
  return `M ${ax} ${ay} A ${radius} ${radius} 0 ${span > Math.PI ? 1 : 0} ${sweep ? 1 : 0} ${cx} ${cy}`;
}
type Props = {
  library: SExpr;
  part?: Part;
  showPinNames?: boolean;
  showPinNumbers?: boolean;
  unit?: number;
  orientation?: { rotation: number; mirror?: 'x' | 'y' };
};

export default function SymbolGraphic({ selected, ...props }: Props & { selected?: boolean }) {
  const { library, part, unit, orientation, showPinNames, showPinNumbers } = props;
  const role = symbolRole(library, part);
  const voltageSource = symbolVoltageSource(library, part);
  const graphic = useMemo(() => {
    return symbolGraphic({ ...props, role, voltageSource });
  }, [
    library,
    unit,
    role,
    voltageSource,
    orientation?.rotation,
    orientation?.mirror,
    showPinNames,
    showPinNumbers,
  ]);
  return selected === undefined ? (
    graphic
  ) : (
    <SchematicSelectionPaint selected={selected}>{graphic}</SchematicSelectionPaint>
  );
}

/** The source mark changes preview bounds; keep its projection shared with drawing. */
export function symbolVoltageSource(library: SExpr, part?: Part) {
  return (
    ((part && partFields(part)['Sim.Device']) ||
      val(
        children(library, 'property').find((p) => val(p) === 'Sim.Device'),
        2,
      )) === 'V'
  );
}

function symbolGraphic({
  library,
  unit = 1,
  orientation,
  showPinNames = true,
  showPinNumbers = true,
  role,
  voltageSource,
}: Props & { role: ReturnType<typeof symbolRole>; voltageSource: boolean }) {
  // Counter-transform glyphs around their anchors; geometry still follows the instance.
  const upright = (x: number, y: number) =>
    orientation
      ? `translate(${x} ${y}) rotate(${orientation.rotation}) scale(${orientation.mirror === 'y' ? -1 : 1} ${orientation.mirror === 'x' ? -1 : 1}) translate(${-x} ${-y})`
      : undefined;
  const graphics = unitGraphics(library, unit).flatMap((s) =>
    s.filter((n): n is SExpr => Array.isArray(n)),
  );
  const sourceCircle = voltageSource && graphics.find((n) => n[0] === 'circle');
  // KiCad's common-unit foreground may precede the filled body in the source file.
  // Draw background bodies first so source waveforms and polarity stay visible.
  const orderedGraphics = [...graphics].sort(
    (a, b) =>
      Number(val(child(child(b, 'fill') || [], 'type')) === 'background') -
      Number(val(child(child(a, 'fill') || [], 'type')) === 'background'),
  );
  return (
    <g
      className="symbol-graphic"
      data-symbol-role={role}
      aria-label={symbolRoles[role].label}
      color={`var(${symbolRoles[role].color})`}
      fill="none"
      stroke="currentColor"
      strokeWidth="0.26"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {orderedGraphics.map((n, i) => {
        const fill =
          val(child(child(n, 'fill') || [], 'type')) === 'background'
            ? 'var(--canvas)'
            : val(child(child(n, 'fill') || [], 'type')) === 'outline'
              ? 'currentColor'
              : 'none';
        if (n[0] === 'polyline')
          return (
            <polyline
              key={i}
              fill={fill}
              points={children(child(n, 'pts') || [], 'xy')
                .map((p) => `${num(p)},${-num(p, 2)}`)
                .join(' ')}
            />
          );
        if (n[0] === 'rectangle') {
          const a = child(n, 'start'),
            b = child(n, 'end');
          return (
            <rect
              key={i}
              x={Math.min(num(a), num(b))}
              y={Math.min(-num(a, 2), -num(b, 2))}
              width={Math.abs(num(a) - num(b))}
              height={Math.abs(num(a, 2) - num(b, 2))}
              fill={fill}
            />
          );
        }
        if (n[0] === 'circle')
          return (
            <circle
              key={i}
              cx={num(child(n, 'center'))}
              cy={-num(child(n, 'center'), 2)}
              r={num(child(n, 'radius'))}
              fill={fill}
            />
          );
        if (n[0] === 'arc') return <path key={i} d={arcPath(n)} />;
        if (n[0] === 'pin') {
          const hidden = (node: SExpr | undefined) =>
            !!node && (node.includes('hide') || val(child(node, 'hide')) === 'yes');
          if (hidden(n)) return null;
          const at = child(n, 'at'),
            angle = (num(at, 3) * Math.PI) / 180,
            length = num(child(n, 'length'));
          const x = num(at),
            y = -num(at, 2),
            shape = String(n[2]);
          const inverted = ['inverted', 'inverted_clock'].includes(shape);
          const labelAngle = num(at, 3);
          const name = val(child(n, 'name')),
            number = val(child(n, 'number'));
          const nameSize =
            num(
              child(child(child(child(n, 'name') || [], 'effects') || [], 'font') || [], 'size'),
            ) || 1.0;
          return (
            <g key={i}>
              <g transform={`translate(${x} ${y}) rotate(${-labelAngle})`}>
                <line x2={Math.max(0, length - (inverted ? 1.2 : 0))} />
                {inverted && <circle cx={length - 0.6} r={0.6} />}
                {['clock', 'inverted_clock', 'clock_low', 'edge_clock_high'].includes(shape) && (
                  <path d={`M ${length} -0.7 l 0.9 0.7 l -0.9 0.7`} />
                )}
                {['input_low', 'clock_low'].includes(shape) && (
                  <path d={`M ${length - 1.2} 0 v -0.8 l 1.2 0.8`} />
                )}
                {shape === 'output_low' && <path d={`M ${length - 1.2} 0 l 1.2 -0.8 v 0.8`} />}
                {shape === 'non_logic' && (
                  <path d={`M ${length - 0.6} -0.6 l 1.2 1.2 m 0 -1.2 l -1.2 1.2`} />
                )}
              </g>
              {showPinNumbers && !hidden(child(library, 'pin_numbers')) && number && (
                <text
                  x={x + (length * Math.cos(angle)) / 2}
                  y={y - (length * Math.sin(angle)) / 2 - 0.5}
                  transform={upright(
                    x + (length * Math.cos(angle)) / 2,
                    y - (length * Math.sin(angle)) / 2 - 0.5,
                  )}
                  textAnchor="middle"
                  fill="var(--schematic-pin-number)"
                  stroke="none"
                  fontSize="0.9"
                >
                  {number}
                </text>
              )}
              {showPinNames && !hidden(child(library, 'pin_names')) && name && name !== '~' && (
                <text
                  x={x + (length + 0.7) * Math.cos(angle)}
                  y={y - (length + 0.7) * Math.sin(angle)}
                  transform={upright(
                    x + (length + 0.7) * Math.cos(angle),
                    y - (length + 0.7) * Math.sin(angle),
                  )}
                  textAnchor={
                    Math.cos(angle) > 0.5 ? 'start' : Math.cos(angle) < -0.5 ? 'end' : 'middle'
                  }
                  dominantBaseline="central"
                  fill="var(--schematic-pin-name)"
                  stroke="none"
                  fontSize={nameSize}
                >
                  {name.replace(/^~\{(.*)\}$/, '$1')}
                </text>
              )}
            </g>
          );
        }
        if (n[0] === 'text')
          return (
            <text
              key={i}
              x={num(child(n, 'at'))}
              y={-num(child(n, 'at'), 2)}
              transform={upright(num(child(n, 'at')), -num(child(n, 'at'), 2))}
              fill="var(--schematic-note)"
              stroke="none"
              fontSize="1.27"
              textAnchor="middle"
              dominantBaseline="central"
            >
              {val(n)}
            </text>
          );
        return null;
      })}
      {sourceCircle &&
        (() => {
          const x = num(child(sourceCircle, 'center'));
          const y =
            -num(child(sourceCircle, 'center'), 2) + num(child(sourceCircle, 'radius')) * 0.61;
          return (
            <text
              data-source-mark="voltage"
              x={x}
              y={y}
              transform={upright(x, y)}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize="1.15"
              fill="currentColor"
              stroke="none"
            >
              V
            </text>
          );
        })()}
    </g>
  );
}
