import { memo, useMemo } from 'react';
import { schematicTexts, schematicPolylines } from '@/lib/schematic-text';
import type { SExpr } from '@/lib/sexpr';
import type { Point } from '@/lib/circuit';
import SchematicSelectionPaint from './SchematicSelectionPaint';
import useRetainedElements from './useRetainedElements';

const DrawingNativeText = memo(function DrawingNativeText({
  id,
  text,
  x,
  y: top,
  size,
  bold,
  italic,
  color,
  opacity,
  anchor,
  vertical,
  selected,
  dx,
  dy,
  translated,
  changeKind,
  onPointerDown,
}: Omit<ReturnType<typeof schematicTexts>[number], 'color' | 'href'> & {
  color?: string;
  opacity?: number;
  selected: boolean;
  dx: number;
  dy: number;
  translated: boolean;
  changeKind?: string;
  onPointerDown?: (e: React.PointerEvent<SVGTextElement>, id: string) => void;
}) {
  const lines = text.replace(/\n+$/, '').split('\n');
  const height = (lines.length - 1) * size * 1.5;
  const y =
    top + (vertical === 'top' ? size : vertical === 'bottom' ? -height : (size - height) / 2);
  return (
    <SchematicSelectionPaint selected={selected} color={color}>
      <text
        data-testid={`schematic-text-${id}`}
        data-selection-id={id}
        data-change={changeKind}
        x={x}
        y={y}
        fontSize={size * 1.3}
        fontWeight={bold ? 700 : undefined}
        fontStyle={italic ? 'italic' : undefined}
        fill={color ? 'var(--schematic-custom-color)' : undefined}
        fillOpacity={opacity}
        textAnchor={anchor}
        transform={translated ? `translate(${dx} ${dy})` : undefined}
        pointerEvents={onPointerDown ? 'bounding-box' : 'none'}
        onPointerDown={(e) => onPointerDown?.(e, id)}
      >
        {lines.map((line, i) => (
          <tspan key={i} x={x} dy={i ? size * 1.5 : 0}>
            {line}
          </tspan>
        ))}
      </text>
    </SchematicSelectionPaint>
  );
});

export default memo(function SchematicText({
  original,
  selection = [],
  offset,
  onPointerDown,
  changeKinds,
}: {
  original?: SExpr;
  selection?: string[];
  offset?: (id: string) => Point;
  onPointerDown?: (e: React.PointerEvent<SVGTextElement>, id: string) => void;
  changeKinds?: ReadonlyMap<string, string>;
}) {
  const polylines = useMemo(() => schematicPolylines(original), [original]);
  const texts = useMemo(() => schematicTexts(original), [original]);
  const retainText = useRetainedElements(texts, [
    texts,
    selection,
    offset,
    onPointerDown,
    changeKinds,
  ]);
  const lineElements = useMemo(
    () =>
      polylines.map((line) => (
        <polyline
          key={line.id}
          data-testid={`schematic-polyline-${line.id}`}
          points={line.points.map((p) => `${p.x},${p.y}`).join(' ')}
          fill="none"
          stroke="var(--schematic-note)"
          strokeWidth={line.width || 0.15}
          strokeDasharray={
            {
              dash: '1.5 1',
              dot: '0.2 0.8',
              dash_dot: '1.5 0.8 0.2 0.8',
              dash_dot_dot: '1.5 0.8 0.2 0.8 0.2 0.8',
            }[line.type]
          }
        />
      )),
    [polylines],
  );
  const textElements = useMemo(
    () =>
      texts.map((text) => {
        const delta = offset?.(text.id);
        return retainText(
          {
            key: text.id,
            id: text.id,
            text: text.text,
            x: text.x,
            y: text.y,
            size: text.size,
            bold: text.bold,
            italic: text.italic,
            color:
              text.color && text.color[3] > 0
                ? `rgb(${text.color.slice(0, 3).join(',')})`
                : undefined,
            opacity: text.color && text.color[3] > 0 ? text.color[3] : undefined,
            anchor: text.anchor,
            vertical: text.vertical,
            selected: selection.includes(text.id),
            dx: delta?.x || 0,
            dy: delta?.y || 0,
            translated: !!offset,
            changeKind: changeKinds?.get(text.id),
            onPointerDown,
          },
          ({ key, ...props }) => <DrawingNativeText key={key} {...props} />,
        );
      }),
    [texts, selection, offset, onPointerDown, changeKinds],
  );
  return (
    <g fill="var(--schematic-note)" fontFamily="var(--ui-font)" pointerEvents="none">
      {lineElements}
      {textElements}
    </g>
  );
});
