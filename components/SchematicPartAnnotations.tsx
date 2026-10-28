import { memo, useMemo } from 'react';
import type { Part, Point } from '@/lib/circuit';
import type { SExpr } from '@/lib/sexpr';
import { fieldId } from '@/lib/schematic-edit';
import {
  displayPartValue,
  extraSymbolAnnotations,
  symbolAnnotation,
  symbolUnits,
} from '@/lib/library';
import SchematicSelectionPaint from './SchematicSelectionPaint';

/** Camera and unrelated selection changes retain native annotation presentation. */
export default memo(function SchematicPartAnnotations({
  part: p,
  library,
  selected,
  referenceSelected,
  valueSelected,
  parameterSelected,
  references,
  values,
  fields,
  offset,
  onPointerDown,
}: {
  part: Part;
  library: SExpr;
  selected: boolean;
  referenceSelected: boolean;
  valueSelected: boolean;
  parameterSelected: boolean;
  references: boolean;
  values: boolean;
  fields: boolean;
  offset: (id: string) => Point;
  onPointerDown: (e: React.PointerEvent, id: string) => void;
}) {
  const presentation = useMemo(
    () => ({
      reference: symbolAnnotation(p, library, 'Reference'),
      value: symbolAnnotation(p, library, 'Value'),
      unit: symbolUnits(library) > 1 ? String.fromCharCode(64 + (p.unit || 1)) : '',
      text: displayPartValue(p),
      fields: extraSymbolAnnotations(p),
    }),
    [p, library],
  );
  const ground = p.ref.startsWith('#');
  const refId = fieldId(p.id, 'Reference'),
    valueId = fieldId(p.id, 'Value');
  const refBase = presentation.reference,
    valueBase = presentation.value;
  const refAt = refBase
    ? { ...refBase, x: refBase.x + offset(refId).x, y: refBase.y + offset(refId).y }
    : null;
  const valueAt = valueBase
    ? { ...valueBase, x: valueBase.x + offset(valueId).x, y: valueBase.y + offset(valueId).y }
    : null;
  return (
    <g data-selection-id={p.id} className={`part-annotations${selected ? ' is-selected' : ''}`}>
      {references && !ground && (
        <SchematicSelectionPaint selected={selected || referenceSelected}>
          <text
            x={refAt?.x ?? (p.rotation === 90 ? p.x : p.x + 4)}
            y={refAt?.y ?? (p.rotation === 90 ? p.y - 8 : p.y - 1.8)}
            textAnchor={refAt?.anchor ?? (p.rotation === 90 ? 'middle' : 'start')}
            className="schematic-ref"
            data-testid={`annotation-ref-${p.ref}`}
            data-selection-id={refId}
            onPointerDown={(e) => onPointerDown(e, refId)}
          >
            {p.ref}
            {presentation.unit}
          </text>
        </SchematicSelectionPaint>
      )}
      <SchematicSelectionPaint selected={selected || valueSelected}>
        <text
          x={valueAt?.x ?? (ground ? p.x : p.rotation === 90 ? p.x : p.x + 4)}
          y={valueAt?.y ?? (ground ? p.y + 7 : p.rotation === 90 ? p.y - 4.5 : p.y + 2)}
          textAnchor={valueAt?.anchor ?? (ground || p.rotation === 90 ? 'middle' : 'start')}
          display={values ? undefined : 'none'}
          className="schematic-value"
          data-testid={`annotation-value-${p.ref}`}
          data-selection-id={valueId}
          onPointerDown={(e) => onPointerDown(e, valueId)}
        >
          {presentation.text}
        </text>
      </SchematicSelectionPaint>
      {presentation.fields
        .filter((field) => (field.name === 'Sim.Params' ? values : fields))
        .map((field) => {
          const id = field.name === 'Sim.Params' ? fieldId(p.id, 'Sim.Params') : null;
          const delta = id ? offset(id) : { x: 0, y: 0 };
          const x = field.x + delta.x,
            y = field.y + delta.y;
          return (
            <SchematicSelectionPaint
              key={field.name}
              selected={selected || Boolean(id && parameterSelected)}
            >
              <text
                x={x}
                y={y}
                textAnchor={field.anchor}
                transform={`rotate(${-field.rotation} ${x} ${y})`}
                className={id ? 'schematic-value' : 'schematic-value schematic-field'}
                data-testid={`annotation-field-${p.ref}-${field.name}`}
                data-selection-id={id || undefined}
                pointerEvents={id ? 'bounding-box' : 'none'}
                onPointerDown={id ? (e) => onPointerDown(e, id) : undefined}
              >
                {field.text}
              </text>
            </SchematicSelectionPaint>
          );
        })}
    </g>
  );
});
