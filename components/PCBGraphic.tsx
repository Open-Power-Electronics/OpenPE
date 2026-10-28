import type { BoardLine, BoardText } from '@/lib/pcb';
import { pcbGraphicPath } from '@/lib/pcb-geometry';
import { pcbReadableTextAngle } from '@/lib/pcb-display';

/** Shared, typed artwork rendering for editable board geometry. */
export default function PCBGraphic({
  graphic: g,
  color,
  width,
  footprintRotation,
}: {
  graphic: BoardLine;
  color: string;
  width?: number;
  footprintRotation?: number;
}) {
  const strokeWidth = width ?? g.width;
  const caption = (t: BoardText, x: number, y: number) =>
    t.hidden ? null : (
      <text
        data-pcb-layer={g.layer}
        role="presentation"
        x={0}
        y={0}
        transform={`translate(${x} ${y}) rotate(${-(footprintRotation === undefined ? t.rotation : pcbReadableTextAngle(t.rotation + footprintRotation) - footprintRotation)}) scale(${((t.justify?.includes('mirror') ? -1 : 1) * t.size.x) / t.size.y} 1)`}
        fill={color}
        stroke="none"
        fontSize={t.size.y}
        fontStyle={t.italic ? 'italic' : undefined}
        fontWeight={t.bold ? 'bold' : undefined}
        textAnchor={
          t.justify?.includes('left') ? 'start' : t.justify?.includes('right') ? 'end' : 'middle'
        }
        dominantBaseline={
          t.justify?.includes('top')
            ? 'hanging'
            : t.justify?.includes('bottom')
              ? 'auto'
              : 'central'
        }
      >
        {t.value.split('\n').map((line, i) => (
          <tspan key={i} x={0} dy={i ? t.size.y * 1.25 : 0} role="presentation">
            {line}
          </tspan>
        ))}
      </text>
    );
  if (g.kind === 'text') return caption(g.text!, g.start.x, g.start.y);
  if (g.kind === 'dimension') {
    const d = g.dimension!,
      dx = g.end.x - g.start.x,
      dy = g.end.y - g.start.y,
      len = Math.hypot(dx, dy) || 1,
      h = d.height ?? 0,
      offset = { x: (-dy / len) * h, y: (dx / len) * h };
    const a = { x: g.start.x + offset.x, y: g.start.y + offset.y },
      b = { x: g.end.x + offset.x, y: g.end.y + offset.y };
    return (
      <g stroke={color} strokeWidth={strokeWidth} fill="none">
        <path
          d={`M ${g.start.x} ${g.start.y} L ${a.x} ${a.y} L ${b.x} ${b.y} L ${g.end.x} ${g.end.y}`}
        />
        {caption(d.caption, d.caption.x, d.caption.y)}
      </g>
    );
  }
  const dash =
    g.stroke === 'dash'
      ? '0.8 0.5'
      : g.stroke === 'dot'
        ? '0.1 0.4'
        : g.stroke?.startsWith('dash_dot')
          ? '0.8 0.4 0.1 0.4'
          : undefined;
  if (g.kind === 'circle')
    return (
      <circle
        cx={g.start.x}
        cy={g.start.y}
        r={Math.hypot(g.end.x - g.start.x, g.end.y - g.start.y)}
        stroke={color}
        strokeWidth={strokeWidth}
        strokeDasharray={dash}
        fill={g.fill ? color : 'none'}
      />
    );
  return (
    <path
      d={pcbGraphicPath(g)}
      stroke={color}
      strokeWidth={strokeWidth}
      strokeDasharray={dash}
      fill={g.fill ? color : 'none'}
      strokeLinejoin="round"
      strokeLinecap="round"
    />
  );
}
