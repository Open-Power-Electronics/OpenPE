import { useId } from 'react';
import type { BoardLine, BoardText } from '@/lib/pcb';
import { pcbCenterMarkStrokes, pcbGraphicPath } from '@/lib/pcb-geometry';
import { pcbFootprintTextRotation } from '@/lib/pcb-display';
import {
  matchingPCBTextRenderCache,
  pcbTextDisplayValue,
  pcbTextLineAdvance,
} from '@/lib/pcb-text';

/** Shared, typed artwork rendering for editable board geometry. */
export default function PCBGraphic({
  graphic: g,
  color,
  width,
  footprintRotation,
  nativeRenderCache = false,
}: {
  graphic: BoardLine;
  color: string;
  width?: number;
  footprintRotation?: number;
  nativeRenderCache?: boolean;
}) {
  const clipId = `pcb-text-box-${useId().replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const strokeWidth = g.nativeNoStroke ? 0 : (width ?? g.width);
  if (g.kind === 'point') {
    const { x, y } = g.start;
    const r = g.width / 2;
    return (
      <path
        data-pcb-reference-point=""
        d={`M ${x - r} ${y} H ${x + r} M ${x} ${y - r} V ${y + r}`}
        fill="none"
        stroke={color}
        strokeWidth={Math.min(0.12, r / 3)}
      />
    );
  }
  const caption = (t: BoardText, x: number, y: number) => {
    if (t.hidden) return null;
    const cache =
      nativeRenderCache && !t.knockout ? matchingPCBTextRenderCache(t, t.rotation) : undefined;
    if (cache?.length)
      return (
        <g
          data-pcb-layer={g.layer}
          data-pcb-native-text-cache=""
          role="presentation"
          fill={color}
          stroke="none"
        >
          {cache.map((points, index) => (
            <polygon key={index} points={points} fillRule="evenodd" />
          ))}
        </g>
      );
    return (
      <text
        data-pcb-layer={g.layer}
        role="presentation"
        x={0}
        y={0}
        transform={`translate(${x} ${y}) rotate(${-(footprintRotation === undefined || g.textBox ? t.rotation : pcbFootprintTextRotation(t.rotation, footprintRotation, g.keepUpright))}) scale(${((t.justify?.includes('mirror') ? -1 : 1) * t.size.x) / t.size.y} 1)`}
        fill={color}
        stroke="none"
        fontSize={t.size.y}
        fontFamily={t.fontFace ? JSON.stringify(t.fontFace) : undefined}
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
        {pcbTextDisplayValue(t)
          .split('\n')
          .map((line, i) => (
            <tspan key={i} x={0} dy={i ? pcbTextLineAdvance(t) : 0} role="presentation">
              {line}
            </tspan>
          ))}
      </text>
    );
  };
  if (g.textBox) {
    const { outline, margins, border } = g.textBox;
    const t = g.text!;
    const points = outline ?? [
      g.start,
      { x: g.end.x, y: g.start.y },
      g.end,
      { x: g.start.x, y: g.end.y },
    ];
    const polygon = points.map(({ x, y }) => `${x},${y}`).join(' ');
    const minX = Math.min(...points.map(({ x }) => x)),
      maxX = Math.max(...points.map(({ x }) => x));
    const minY = Math.min(...points.map(({ y }) => y)),
      maxY = Math.max(...points.map(({ y }) => y));
    const x = t.justify?.includes('left')
      ? minX + margins[0]
      : t.justify?.includes('right')
        ? maxX - margins[2]
        : (minX + maxX) / 2;
    const y = t.justify?.includes('top')
      ? minY + margins[1]
      : t.justify?.includes('bottom')
        ? maxY - margins[3]
        : (minY + maxY) / 2;
    const exact =
      nativeRenderCache && !t.knockout && matchingPCBTextRenderCache(t, t.rotation)?.length;
    return (
      <g data-pcb-native-text-box="" data-pcb-layer={g.layer}>
        {!exact && (
          <defs>
            <clipPath id={clipId}>
              <polygon points={polygon} />
            </clipPath>
          </defs>
        )}
        {(border || t.knockout) && (
          <polygon
            points={polygon}
            fill="none"
            stroke={color}
            strokeWidth={border ? strokeWidth : 0.08}
            strokeDasharray={t.knockout ? '0.45 0.3' : undefined}
          />
        )}
        <g clipPath={exact ? undefined : `url(#${clipId})`}>{caption(t, x, y)}</g>
      </g>
    );
  }
  if (g.kind === 'text') return caption(g.text!, g.start.x, g.start.y);
  if (g.kind === 'dimension') {
    if (g.dimension?.type === 'center')
      return (
        <g stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" fill="none">
          {pcbCenterMarkStrokes(g).map(([a, b], index) => (
            <line key={index} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
          ))}
        </g>
      );
    const d = g.dimension!,
      dx = g.end.x - g.start.x,
      dy = g.end.y - g.start.y,
      len = Math.hypot(dx, dy) || 1,
      h = d.height ?? 0,
      offset = { x: (-dy / len) * h, y: (dx / len) * h };
    const a = { x: g.start.x + offset.x, y: g.start.y + offset.y },
      b = { x: g.end.x + offset.x, y: g.end.y + offset.y };
    if (d.orientation === 0) {
      a.x = g.start.x;
      b.x = g.end.x;
      a.y = b.y = g.start.y + h;
    }
    if (d.orientation === 1) {
      a.y = g.start.y;
      b.y = g.end.y;
      a.x = b.x = g.start.x + h;
    }
    return (
      <g stroke={color} strokeWidth={strokeWidth} fill="none">
        <path
          d={`M ${g.start.x} ${g.start.y} L ${a.x} ${a.y} L ${b.x} ${b.y} L ${g.end.x} ${g.end.y}`}
        />
        {d.caption && caption(d.caption, d.caption.x, d.caption.y)}
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
