import { memo, useMemo } from 'react';
import { schematicTexts, schematicTextBoxes, schematicPolylines } from '@/lib/schematic-text';
import { schematicImages } from '@/lib/schematic-image';
import type { SExpr } from '@/lib/sexpr';
import type { Point } from '@/lib/circuit';
import SchematicSelectionPaint from './SchematicSelectionPaint';
import { schematicStrokeDasharray } from './schematic-stroke';
import useRetainedElements from './useRetainedElements';

const DrawingNativeText = memo(function DrawingNativeText({
  id,
  text,
  x,
  y: top,
  size,
  thickness,
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
        stroke={
          thickness ? `var(--${color ? 'schematic-custom-color' : 'schematic-note'})` : undefined
        }
        strokeWidth={thickness || undefined}
        strokeOpacity={thickness ? opacity : undefined}
        strokeLinejoin={thickness ? 'round' : undefined}
        paintOrder={thickness ? 'stroke fill' : undefined}
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
  const boxes = useMemo(() => schematicTextBoxes(original), [original]);
  const images = useMemo(() => schematicImages(original), [original]);
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
          strokeDasharray={schematicStrokeDasharray(line.type)}
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
            thickness: text.thickness,
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
      {images.map(({ id, href, x, y, width, height }) => (
        <image key={id} data-testid={`schematic-image-${id}`} {...{ href, x, y, width, height }} />
      ))}
      {lineElements}
      {boxes.map((box) => (
        <g key={box.id} data-testid={`schematic-text-box-${box.id}`}>
          <rect
            x={box.x}
            y={box.y}
            width={box.width}
            height={box.height}
            fill="none"
            stroke="var(--schematic-note)"
            strokeWidth={box.lineWidth || 0.15}
            strokeDasharray={schematicStrokeDasharray(box.lineType)}
          />
          <foreignObject x={box.x} y={box.y} width={box.width} height={box.height}>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent:
                  box.vertical === 'top'
                    ? 'flex-start'
                    : box.vertical === 'bottom'
                      ? 'flex-end'
                      : 'center',
                height: '100%',
                boxSizing: 'border-box',
                padding: `${box.top}px ${box.right}px ${box.bottom}px ${box.left}px`,
                textAlign:
                  box.anchor === 'middle' ? 'center' : box.anchor === 'start' ? 'left' : 'right',
                fontSize: box.size * 1.3,
                fontWeight: box.bold ? 700 : undefined,
                fontStyle: box.italic ? 'italic' : undefined,
                color: box.color?.[3] ? `rgba(${box.color.join(',')})` : 'var(--schematic-note)',
                WebkitTextStrokeWidth: box.thickness,
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                lineHeight: 1.15,
              }}
            >
              {box.text}
            </div>
          </foreignObject>
        </g>
      ))}
      {textElements}
    </g>
  );
});
