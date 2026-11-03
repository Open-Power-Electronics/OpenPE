import { useState } from 'react';
import type { Point } from '@/lib/circuit';
import type { BoardLayer, BoardLine, BoardText } from '@/lib/pcb';
import {
  pcbDimensionOverrideValue,
  pcbDimensionUnitSuffix,
  setPCBDimensionOverrideValue,
} from '@/lib/pcb-dimension-text';
import {
  PropertySelect as Select,
  NumberField,
  TextField,
  PropertyRow,
  PropertySection,
  PropertyGrid,
  PropertyToggle,
  PropertyDetails,
} from './LayoutPropertyFields';

type Props = {
  graphic: BoardLine;
  active: boolean;
  resetKey: boolean;
  snap: (value: number) => number;
  layers: BoardLayer[];
  onCommit: (graphic: BoardLine) => boolean;
  geometry?: boolean;
};

/** Fields edit native graphic records without replacing their IDs or unrelated metadata. */
export default function LayoutGraphicProperties({
  graphic,
  active,
  resetKey,
  snap,
  layers,
  onCommit,
  geometry = true,
}: Props) {
  const [verticesOpen, setVerticesOpen] = useState(false);
  const [vertexLimit, setVertexLimit] = useState(128);
  const field = { active, resetKey };
  const update = (changes: Partial<BoardLine>) => active && onCommit({ ...graphic, ...changes });
  const number = (
    label: string,
    value: number,
    onChange: (value: number) => boolean,
    options: {
      min?: number;
      max?: number;
      step?: string;
      normalize?: (value: number) => number;
    } = {},
  ) => (
    <NumberField
      key={label}
      {...field}
      label={label}
      value={value}
      onCommit={onChange}
      {...options}
    />
  );
  const point = (label: string, value: Point, onChange: (value: Point) => boolean) => (
    <PropertyGrid>
      {number(`${label} X (mm)`, value.x, (x) => onChange({ ...value, x }), { normalize: snap })}
      {number(`${label} Y (mm)`, value.y, (y) => onChange({ ...value, y }), { normalize: snap })}
    </PropertyGrid>
  );
  const select = (
    label: string,
    value: string,
    options: { value: string; label: string }[],
    onChange: (value: string) => void,
  ) => <Select active={active} label={label} value={value} options={options} onChange={onChange} />;
  const textFields = (
    text: BoardText,
    onChange: (text: BoardText) => boolean,
    hideable: boolean,
    editableContent = true,
  ) => {
    const change = (changes: Partial<BoardText>) => onChange({ ...text, ...changes });
    const align = (axis: 'horizontal' | 'vertical', value: string) => {
      const remove = axis === 'horizontal' ? ['left', 'right'] : ['top', 'bottom'];
      const justify = (text.justify ?? []).filter((item) => !remove.includes(item));
      if (value !== 'center') justify.push(value as 'left' | 'right' | 'top' | 'bottom');
      return change({ justify });
    };
    const controls = (
      <>
        {editableContent ? (
          <TextField
            {...field}
            label="Text content"
            value={text.value}
            onCommit={(value) => change({ value })}
            multiline
          />
        ) : (
          <PropertyRow label="Text content" value={text.value} />
        )}
        <PropertyGrid>
          {number('Text rotation (°)', text.rotation, (rotation) => change({ rotation }), {
            min: -360,
            max: 360,
          })}
          {number('Text thickness (mm)', text.thickness, (thickness) => change({ thickness }), {
            min: 0,
          })}
        </PropertyGrid>
        <PropertyGrid>
          {number('Text width (mm)', text.size.x, (x) => change({ size: { ...text.size, x } }), {
            min: 0.0001,
          })}
          {number('Text height (mm)', text.size.y, (y) => change({ size: { ...text.size, y } }), {
            min: 0.0001,
          })}
        </PropertyGrid>
        <PropertyDetails title="Text style">
          {select(
            'Horizontal alignment',
            text.justify?.find((item) => item === 'left' || item === 'right') ?? 'center',
            ['left', 'center', 'right'].map((value) => ({
              value,
              label: value[0].toUpperCase() + value.slice(1),
            })),
            (value) => align('horizontal', value),
          )}
          {select(
            'Vertical alignment',
            text.justify?.find((item) => item === 'top' || item === 'bottom') ?? 'center',
            ['top', 'center', 'bottom'].map((value) => ({
              value,
              label: value[0].toUpperCase() + value.slice(1),
            })),
            (value) => align('vertical', value),
          )}
          <PropertyGrid>
            <PropertyToggle
              active={active}
              label="Bold"
              checked={Boolean(text.bold)}
              onChange={(bold) => change({ bold })}
            />
            <PropertyToggle
              active={active}
              label="Italic"
              checked={Boolean(text.italic)}
              onChange={(italic) => change({ italic })}
            />
            <PropertyToggle
              active={active}
              label="Mirrored text"
              checked={Boolean(text.justify?.includes('mirror'))}
              onChange={(mirrored) =>
                change({
                  justify: [
                    ...(text.justify ?? []).filter((item) => item !== 'mirror'),
                    ...(mirrored ? ['mirror' as const] : []),
                  ],
                })
              }
            />
            {hideable && (
              <PropertyToggle
                active={active}
                label="Hidden text"
                checked={Boolean(text.hidden)}
                onChange={(hidden) => change({ hidden })}
              />
            )}
          </PropertyGrid>
        </PropertyDetails>
      </>
    );
    return editableContent ? (
      <PropertySection title="Text" showTitle={false}>
        {controls}
      </PropertySection>
    ) : (
      <PropertyDetails title="Text">{controls}</PropertyDetails>
    );
  };
  const dimension = graphic.dimension;
  const updateDimension = (changes: Partial<NonNullable<BoardLine['dimension']>>) =>
    dimension ? update({ dimension: { ...dimension, ...changes } }) : false;

  return (
    <>
      <PropertySection title="Appearance" showTitle={false}>
        <PropertyGrid>
          {select(
            'Graphic layer',
            graphic.layer,
            [...new Set([graphic.layer, ...layers])].map((value) => ({ value, label: value })),
            (layer) => update({ layer: layer as BoardLayer }),
          )}
          {graphic.kind !== 'text' &&
            number('Line width (mm)', graphic.width, (width) => update({ width }), {
              min: 0,
              max: 100,
            })}
        </PropertyGrid>
        <PropertyGrid>
          {graphic.kind !== 'text' &&
            graphic.kind !== 'dimension' &&
            select(
              'Line style',
              graphic.stroke ?? 'default',
              [
                { value: 'default', label: 'Default' },
                { value: 'solid', label: 'Solid' },
                { value: 'dash', label: 'Dashed' },
                { value: 'dot', label: 'Dotted' },
                { value: 'dash_dot', label: 'Dash dot' },
                { value: 'dash_dot_dot', label: 'Dash dot dot' },
              ],
              (stroke) => update({ stroke: stroke as BoardLine['stroke'] }),
            )}
          {(graphic.kind === 'circle' || graphic.kind === 'polygon') && (
            <PropertyToggle
              active={active}
              label="Filled"
              checked={Boolean(graphic.fill)}
              onChange={(fill) => update({ fill })}
            />
          )}
        </PropertyGrid>
      </PropertySection>
      {geometry && (
        <PropertySection title="Geometry" showTitle={false}>
          {point(
            graphic.kind === 'text' ? 'Position' : graphic.kind === 'circle' ? 'Center' : 'Start',
            graphic.start,
            (start) => update(graphic.kind === 'text' ? { start, end: { ...start } } : { start }),
          )}
          {graphic.kind !== 'text' &&
            point(graphic.kind === 'circle' ? 'Radius point' : 'End', graphic.end, (end) =>
              update({ end }),
            )}
          {graphic.mid && point('Middle', graphic.mid, (mid) => update({ mid }))}
          {dimension &&
            point('Text position', dimension.caption, (position) =>
              updateDimension({ caption: { ...dimension.caption, ...position } }),
            )}
        </PropertySection>
      )}
      {graphic.text && textFields(graphic.text, (text) => update({ text }), true)}
      {dimension && (
        <>
          <PropertySection title="Dimension" showTitle={false}>
            <PropertyRow
              label="Dimension type"
              value={
                dimension.type === 'aligned'
                  ? 'Aligned'
                  : dimension.type === 'radial'
                    ? 'Radial'
                    : 'Leader'
              }
            />
            <TextField
              {...field}
              label="Override value"
              value={pcbDimensionOverrideValue(dimension)}
              disabled={pcbDimensionUnitSuffix(dimension) === null}
              onCommit={(value) => {
                try {
                  return updateDimension(setPCBDimensionOverrideValue(dimension, value));
                } catch {
                  return false;
                }
              }}
              multiline
            />
            {dimension.type === 'aligned' &&
              number('Dimension height (mm)', dimension.height ?? 0, (height) =>
                updateDimension({ height }),
              )}
            {dimension.type === 'leader' &&
              number('Leader length (mm)', dimension.leaderLength ?? 0, (leaderLength) =>
                updateDimension({ leaderLength }),
              )}
          </PropertySection>
          {textFields(
            dimension.caption,
            (caption) => updateDimension({ caption: { ...dimension.caption, ...caption } }),
            false,
            false,
          )}
          <PropertyDetails title="Dimension format">
            <PropertyRow label="Prefix" value={dimension.format.prefix || 'None'} />
            <PropertyRow label="Suffix" value={dimension.format.suffix || 'None'} />
            <PropertyRow
              label="Units"
              value={['Inches', 'Mils', 'Millimeters', 'Automatic'][dimension.format.units]}
            />
            <PropertyRow
              label="Precision"
              value={dimension.format.precision === 6 ? 'By unit' : dimension.format.precision}
            />
          </PropertyDetails>
          <PropertyDetails title="Dimension style">
            {number(
              'Arrow length (mm)',
              dimension.style.arrowLength,
              (arrowLength) => updateDimension({ style: { ...dimension.style, arrowLength } }),
              { min: 0.0001 },
            )}
            {dimension.type === 'aligned'
              ? select(
                  'Arrow direction',
                  dimension.style.arrowDirection ?? 'outward',
                  [
                    { value: 'inward', label: 'Inward' },
                    { value: 'outward', label: 'Outward' },
                  ],
                  (arrowDirection) =>
                    updateDimension({
                      style: {
                        ...dimension.style,
                        arrowDirection: arrowDirection as 'inward' | 'outward',
                      },
                    }),
                )
              : dimension.style.arrowDirection !== undefined && (
                  <PropertyRow
                    label="Arrow direction"
                    value={dimension.style.arrowDirection === 'inward' ? 'Inward' : 'Outward'}
                  />
                )}
            {number('Extension offset (mm)', dimension.style.extensionOffset, (extensionOffset) =>
              updateDimension({ style: { ...dimension.style, extensionOffset } }),
            )}
            {dimension.type === 'aligned'
              ? number(
                  'Extension height (mm)',
                  dimension.style.extensionHeight ?? 0,
                  (extensionHeight) =>
                    updateDimension({ style: { ...dimension.style, extensionHeight } }),
                )
              : dimension.style.extensionHeight !== undefined && (
                  <PropertyRow
                    label="Extension height (mm)"
                    value={dimension.style.extensionHeight}
                  />
                )}
            {select(
              'Text position mode',
              String(dimension.style.textPositionMode),
              [
                { value: '0', label: 'Outside' },
                { value: '1', label: 'Inline' },
                { value: '2', label: 'Manual' },
              ],
              (value) =>
                updateDimension({
                  style: { ...dimension.style, textPositionMode: Number(value) },
                }),
            )}
            {dimension.type === 'leader'
              ? select(
                  'Text frame',
                  String(dimension.style.textFrame ?? 0),
                  [
                    { value: '0', label: 'None' },
                    { value: '1', label: 'Rectangle' },
                    { value: '2', label: 'Circle' },
                    { value: '3', label: 'Rounded rectangle' },
                  ],
                  (value) =>
                    updateDimension({ style: { ...dimension.style, textFrame: Number(value) } }),
                )
              : dimension.style.textFrame !== undefined && (
                  <PropertyRow
                    label="Text frame"
                    value={
                      ['None', 'Rectangle', 'Circle', 'Rounded rectangle'][
                        dimension.style.textFrame
                      ]
                    }
                  />
                )}
            <PropertyToggle
              active={active}
              label="Keep text aligned"
              checked={dimension.style.keepTextAligned ?? dimension.type !== 'leader'}
              onChange={(keepTextAligned) =>
                updateDimension({ style: { ...dimension.style, keepTextAligned } })
              }
            />
          </PropertyDetails>
        </>
      )}
      {geometry && graphic.points && (
        <details
          className="layout-property-details"
          open={verticesOpen}
          onToggle={(event) => setVerticesOpen(event.currentTarget.open)}
        >
          <summary>Polygon vertices</summary>
          {verticesOpen &&
            graphic.points.slice(0, vertexLimit).map((vertex, index) => (
              <div key={index}>
                {point(`Vertex ${index + 2}`, vertex, (value) =>
                  update({
                    points: graphic.points!.map((existing, i) => (i === index ? value : existing)),
                  }),
                )}
              </div>
            ))}
          {verticesOpen && vertexLimit < graphic.points.length && (
            <button
              className="secondary"
              disabled={!active}
              onClick={() => setVertexLimit((limit) => limit + 128)}
            >
              Show more vertices
            </button>
          )}
        </details>
      )}
    </>
  );
}
