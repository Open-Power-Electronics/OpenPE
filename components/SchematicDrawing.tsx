import { createContext, memo, useContext, useMemo } from 'react';
import type { Circuit, Label, Part, Point, Wire } from '@/lib/circuit';
import type { SExpr } from '@/lib/sexpr';
import type { SchematicLayers } from '@/lib/schematic-layers';
import { fieldId, partTransform } from '@/lib/schematic-edit';
import { globalLabelPath } from '@/lib/schematic-view';
import { symbolBodyBounds } from '@/lib/symbol-bounds';
import { visibleSchematicPins } from '@/lib/schematic-wire-target';
import SymbolGraphic from './SymbolGraphic';
import SchematicSelectionPaint from './SchematicSelectionPaint';
import SchematicPartAnnotations from './SchematicPartAnnotations';
import SchematicText from './SchematicText';
import useRetainedElements from './useRetainedElements';

type ObjectPoint = Point & { id: string };
type PointerDown = (event: React.PointerEvent, id: string) => void;
type PinPointerDown = (event: React.PointerEvent, id: string, point: Point) => void;
type Offsets = { dx: number; dy: number };
type ObjectProps<T> = Offsets & { object: T; selected: boolean; onPointerDown: PointerDown };

const SchematicSymbol = memo(SymbolGraphic);
const HitPadding = createContext(0.5);

const DrawingPartHitTarget = memo(function DrawingPartHitTarget({
  part,
  library,
}: {
  part: Part;
  library: SExpr;
}) {
  const hitPadding = useContext(HitPadding);
  const bounds = useMemo(() => symbolBodyBounds(library, part.unit), [library, part.unit]);
  return (
    bounds && (
      <rect
        data-export-exclude
        data-testid={`symbol-hit-${part.ref}`}
        transform={partTransform(part)}
        x={bounds.x - hitPadding}
        y={bounds.y - hitPadding}
        width={bounds.width + hitPadding * 2}
        height={bounds.height + hitPadding * 2}
        fill="transparent"
      />
    )
  );
});

const DrawingWire = memo(function DrawingWire({
  object: wire,
  selected,
  dx,
  dy,
  onPointerDown,
}: ObjectProps<Wire>) {
  const x1 = wire.a.x + dx,
    y1 = wire.a.y + dy,
    x2 = wire.b.x + dx,
    y2 = wire.b.y + dy;
  return (
    <g data-selection-id={wire.id} onPointerDown={(event) => onPointerDown(event, wire.id)}>
      <line
        data-export-exclude
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke="transparent"
        strokeWidth="2.5"
      />
      <SchematicSelectionPaint selected={selected}>
        <line
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke="var(--wire)"
          strokeWidth="0.28"
          strokeLinecap="square"
          pointerEvents="none"
        />
      </SchematicSelectionPaint>
    </g>
  );
});

const DrawingJunction = memo(function DrawingJunction({
  id,
  x,
  y,
  selected,
  dx,
  dy,
  onPointerDown,
}: Offsets & ObjectPoint & { selected: boolean; onPointerDown: PointerDown }) {
  return (
    <SchematicSelectionPaint selected={selected}>
      <circle
        data-selection-id={id}
        cx={x + dx}
        cy={y + dy}
        r="0.6"
        fill="var(--wire)"
        onPointerDown={(event) => onPointerDown(event, id)}
      />
    </SchematicSelectionPaint>
  );
});

const DrawingLabel = memo(function DrawingLabel({
  object: label,
  selected,
  dx,
  dy,
  onPointerDown,
}: ObjectProps<Label>) {
  return (
    <g
      data-testid={`label-${label.text}`}
      data-selection-id={label.id}
      className={`net-annotation${selected ? ' is-selected' : ''}`}
      transform={`translate(${label.x + dx} ${label.y + dy}) rotate(${-(label.rotation || 0)})`}
      onPointerDown={(event) => onPointerDown(event, label.id)}
    >
      <SchematicSelectionPaint selected={selected}>
        {label.scope === 'global' && (
          <path
            d={globalLabelPath(label)}
            fill="var(--canvas)"
            stroke="var(--wire)"
            strokeWidth="0.25"
          />
        )}
        <text
          x={label.scope === 'global' ? 2.5 : 0}
          y={label.scope === 'global' ? 0.8 : -1.5}
          className={label.scope === 'global' ? 'net-label global-net-label' : 'net-label'}
        >
          {label.text}
        </text>
        <circle cx={0} cy={0} r="0.5" fill="var(--wire)" />
      </SchematicSelectionPaint>
    </g>
  );
});

const DrawingNoConnect = memo(function DrawingNoConnect({
  object,
  selected,
  dx,
  dy,
  onPointerDown,
}: ObjectProps<ObjectPoint>) {
  const x = object.x + dx,
    y = object.y + dy;
  return (
    <SchematicSelectionPaint selected={selected}>
      <path
        data-testid={`no-connect-${object.id}`}
        data-selection-id={object.id}
        d={`M ${x - 0.65} ${y - 0.65} l 1.3 1.3 M ${x - 0.65} ${y + 0.65} l 1.3 -1.3`}
        stroke="var(--symbol)"
        strokeWidth="0.3"
        onPointerDown={(event) => onPointerDown(event, object.id)}
      />
    </SchematicSelectionPaint>
  );
});

const DrawingPartPins = memo(function DrawingPartPins({
  object: original,
  library,
  dx,
  dy,
  onPinPointerDown,
}: Offsets & {
  object: Part;
  library: SExpr;
  onPinPointerDown: PinPointerDown;
}) {
  const pins = useMemo(() => visibleSchematicPins(original, library), [original, library]);
  const pinTargets = useMemo(
    () =>
      pins.map(({ point, index }) => {
        const pin = dx || dy ? { x: point.x + dx, y: point.y + dy } : point;
        return (
          <circle
            key={index}
            data-export-exclude
            data-probe-part={original.id}
            data-probe-pin={index}
            cx={pin.x}
            cy={pin.y}
            r="0.65"
            fill="transparent"
            stroke="none"
            strokeWidth="0.2"
            pointerEvents="all"
            onPointerDown={(event) => onPinPointerDown(event, original.id, pin)}
          />
        );
      }),
    [pins, original.id, dx, dy, onPinPointerDown],
  );
  return pinTargets;
});

const DrawingPart = memo(function DrawingPart({
  object: original,
  library,
  selected,
  dx,
  dy,
  pinNames,
  pinNumbers,
  onPointerDown,
  onPinPointerDown,
}: ObjectProps<Part> & {
  library: SExpr;
  pinNames: boolean;
  pinNumbers: boolean;
  onPinPointerDown: PinPointerDown;
}) {
  const part = useMemo(
    () => (dx || dy ? { ...original, x: original.x + dx, y: original.y + dy } : original),
    [original, dx, dy],
  );
  return (
    <g
      data-selection-id={part.id}
      data-testid={`part-${part.ref}`}
      className={`part${selected ? ' is-selected' : ''}`}
      onPointerDown={(event) => onPointerDown(event, part.id)}
    >
      <DrawingPartHitTarget part={part} library={library} />
      <g transform={partTransform(part)} color="var(--symbol)">
        <SchematicSymbol
          library={library}
          part={part}
          unit={part.unit}
          orientation={part}
          selected={selected}
          showPinNames={pinNames}
          showPinNumbers={pinNumbers}
        />
      </g>
      <DrawingPartPins
        object={original}
        library={library}
        dx={dx}
        dy={dy}
        onPinPointerDown={onPinPointerDown}
      />
    </g>
  );
});

type DrawingProps = {
  drawing: Circuit;
  libraries: Circuit['libraries'];
  junctions: Circuit['junctions'];
  selection: string[];
  layers: SchematicLayers;
  hitPadding: number;
  offset: (id: string) => Point;
  onPointerDown: PointerDown;
  onPinPointerDown: PinPointerDown;
};

/** Retain document SVG trees independently of camera, overlays and unrelated objects. */
export default memo(function SchematicDrawing({
  drawing,
  libraries,
  junctions,
  selection,
  layers,
  hitPadding,
  offset,
  onPointerDown,
  onPinPointerDown,
}: DrawingProps) {
  const presentationInputs = [
    drawing,
    junctions,
    libraries,
    selection,
    layers,
    offset,
    onPointerDown,
    onPinPointerDown,
  ];
  const retainWire = useRetainedElements(drawing.wires, presentationInputs);
  const retainPart = useRetainedElements(drawing.parts, presentationInputs);
  const retainAnnotation = useRetainedElements(drawing.parts, presentationInputs);
  const retainJunction = useRetainedElements(junctions, presentationInputs);
  const retainLabel = useRetainedElements(drawing.labels, presentationInputs);
  const retainNoConnect = useRetainedElements(drawing.noConnects || [], presentationInputs);
  const wires = useMemo(
    () =>
      layers.wires &&
      drawing.wires.map((wire) => {
        const delta = offset(wire.id);
        return retainWire(
          {
            key: wire.id,
            object: wire,
            selected: selection.includes(wire.id),
            dx: delta.x,
            dy: delta.y,
            onPointerDown,
          },
          ({ key, ...props }) => <DrawingWire key={key} {...props} />,
        );
      }),
    [drawing.wires, layers.wires, selection, offset, onPointerDown],
  );
  const dots = useMemo(
    () =>
      layers.wires &&
      junctions.map((junction) => {
        const delta = offset(junction.id);
        return retainJunction(
          {
            key: junction.id,
            id: junction.id,
            x: junction.x,
            y: junction.y,
            selected: selection.includes(junction.id),
            dx: delta.x,
            dy: delta.y,
            onPointerDown,
          },
          ({ key, ...props }) => <DrawingJunction key={key} {...props} />,
        );
      }),
    [junctions, layers.wires, selection, offset, onPointerDown],
  );
  const parts = useMemo(
    () =>
      layers.symbols &&
      drawing.parts.map((part) => {
        const delta = offset(part.id);
        return retainPart(
          {
            key: part.id,
            object: part,
            library: libraries[part.libId],
            selected: selection.includes(part.id),
            dx: delta.x,
            dy: delta.y,
            pinNames: layers.pinNames,
            pinNumbers: layers.pinNumbers,
            onPointerDown,
            onPinPointerDown,
          },
          ({ key, ...props }) => <DrawingPart key={key} {...props} />,
        );
      }),
    [
      drawing.parts,
      libraries,
      layers.symbols,
      layers.pinNames,
      layers.pinNumbers,
      selection,
      offset,
      onPointerDown,
      onPinPointerDown,
    ],
  );
  const annotations = useMemo(
    () =>
      drawing.parts.map((original) => {
        const delta = offset(original.id);
        const part =
          delta.x || delta.y
            ? { ...original, x: original.x + delta.x, y: original.y + delta.y }
            : original;
        return retainAnnotation(
          {
            key: part.id,
            part,
            library: libraries[part.libId],
            selected: selection.includes(part.id),
            referenceSelected: selection.includes(fieldId(part.id, 'Reference')),
            valueSelected: selection.includes(fieldId(part.id, 'Value')),
            parameterSelected: selection.includes(fieldId(part.id, 'Sim.Params')),
            references: layers.references,
            values: layers.values,
            fields: layers.fields,
            offset,
            onPointerDown,
          },
          ({ key, ...props }) => <SchematicPartAnnotations key={key} {...props} />,
        );
      }),
    [
      drawing.parts,
      libraries,
      selection,
      layers.references,
      layers.values,
      layers.fields,
      offset,
      onPointerDown,
    ],
  );
  const labels = useMemo(
    () =>
      layers.labels &&
      drawing.labels.map((label) => {
        const delta = offset(label.id);
        return retainLabel(
          {
            key: label.id,
            object: label,
            selected: selection.includes(label.id),
            dx: delta.x,
            dy: delta.y,
            onPointerDown,
          },
          ({ key, ...props }) => <DrawingLabel key={key} {...props} />,
        );
      }),
    [drawing.labels, layers.labels, selection, offset, onPointerDown],
  );
  const noConnects = useMemo(
    () =>
      layers.noConnects &&
      drawing.noConnects?.map((point) => {
        const delta = offset(point.id);
        return retainNoConnect(
          {
            key: point.id,
            object: point,
            selected: selection.includes(point.id),
            dx: delta.x,
            dy: delta.y,
            onPointerDown,
          },
          ({ key, ...props }) => <DrawingNoConnect key={key} {...props} />,
        );
      }),
    [drawing.noConnects, layers.noConnects, selection, offset, onPointerDown],
  );
  return (
    <HitPadding.Provider value={hitPadding}>
      {wires}
      {dots}
      {parts}
      {annotations}
      {layers.notes && (
        <SchematicText
          original={drawing.original}
          selection={selection}
          offset={offset}
          onPointerDown={onPointerDown}
        />
      )}
      {labels}
      {noConnects}
    </HitPadding.Provider>
  );
});
