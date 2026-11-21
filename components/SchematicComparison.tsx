'use client';
import { memo, useMemo, useState, type RefObject } from 'react';
import Select from './Select';
import SymbolGraphic from './SymbolGraphic';
import SchematicText from './SchematicText';
import { ComparisonViewActions, useComparisonView } from './ComparisonView';
import { parseProject, projectSchematics } from '@/lib/project';
import type { Circuit } from '@/lib/circuit';
import { partTransform } from '@/lib/schematic-edit';
import {
  displayPartValue,
  extraSymbolAnnotations,
  symbolAnnotation,
  symbolUnits,
} from '@/lib/library';
import {
  globalLabelPath,
  schematicJunctionRadius,
  schematicWireWidth,
  visibleJunctions,
} from '@/lib/schematic-view';
import { compareSchematicVersions, type SchematicChange } from '@/lib/schematic-version-diff';

type View = { x: number; y: number; width: number; height: number };
const initialView: View = { x: 0, y: 0, width: 100, height: 100 };
const emptyView: View = { x: -10, y: -10, width: 100, height: 100 };

const Drawing = memo(function Drawing({
  circuit: d,
  changes,
  drawingRef,
}: {
  circuit: Circuit;
  changes: ReadonlyMap<string, SchematicChange>;
  drawingRef: RefObject<SVGGElement | null>;
}) {
  return (
    <g ref={drawingRef}>
      {d.wires.map((wire) => (
        <g
          key={wire.id}
          data-compare-id={wire.id}
          data-change={changes.get(wire.id)}
          aria-label={`${changes.get(wire.id) ?? 'Unchanged'} wire`}
        >
          <line
            stroke="var(--wire)"
            strokeWidth={schematicWireWidth}
            strokeLinecap="square"
            x1={wire.a.x}
            y1={wire.a.y}
            x2={wire.b.x}
            y2={wire.b.y}
          />
        </g>
      ))}
      {d.parts.map((part) => {
        const library = d.libraries[part.libId];
        const reference = symbolAnnotation(part, library, 'Reference');
        const value = symbolAnnotation(part, library, 'Value');
        const ground = part.ref.startsWith('#');
        return (
          <g
            key={part.id}
            data-compare-id={part.id}
            data-compare-part={part.id}
            data-change={changes.get(part.id)}
            aria-label={`${part.ref} · ${displayPartValue(part)}${changes.has(part.id) ? ` · ${changes.get(part.id)}` : ''}`}
          >
            <g transform={partTransform(part)}>
              <SymbolGraphic library={library} part={part} unit={part.unit} orientation={part} />
            </g>
            {!ground && (
              <text
                className="schematic-ref"
                x={reference?.x ?? part.x + 4}
                y={reference?.y ?? part.y - 1.8}
                textAnchor={reference?.anchor ?? 'start'}
              >
                {part.ref}
                {symbolUnits(library) > 1 ? String.fromCharCode(64 + (part.unit || 1)) : ''}
              </text>
            )}
            <text
              className="schematic-value"
              x={value?.x ?? part.x + 4}
              y={value?.y ?? part.y + 2}
              textAnchor={value?.anchor ?? 'start'}
            >
              {displayPartValue(part)}
            </text>
            {extraSymbolAnnotations(part).map((field) => (
              <text
                key={field.name}
                className="schematic-value schematic-field"
                x={field.x}
                y={field.y}
                textAnchor={field.anchor}
                transform={`rotate(${-field.rotation} ${field.x} ${field.y})`}
              >
                {field.text}
              </text>
            ))}
          </g>
        );
      })}
      {visibleJunctions(d).map((junction) => (
        <circle
          key={junction.id}
          data-compare-id={junction.id}
          data-change={changes.get(junction.id)}
          cx={junction.x}
          cy={junction.y}
          r={schematicJunctionRadius}
          fill="var(--wire)"
        />
      ))}
      {d.labels.map((label) => (
        <g key={label.id} data-compare-id={label.id} data-change={changes.get(label.id)}>
          <g transform={`translate(${label.x} ${label.y}) rotate(${-(label.rotation || 0)})`}>
            {label.scope === 'global' && (
              <path
                d={globalLabelPath(label)}
                fill="var(--canvas)"
                stroke="var(--wire)"
                strokeWidth="0.25"
              />
            )}
            <text
              className={label.scope === 'global' ? 'net-label global-net-label' : 'net-label'}
              x={label.scope === 'global' ? 2.5 : 0}
              y={label.scope === 'global' ? 0.8 : -1.5}
            >
              {label.text}
            </text>
            <circle r="0.5" fill="var(--wire)" />
          </g>
        </g>
      ))}
      {(d.noConnects ?? []).map((n) => (
        <path
          key={n.id}
          data-compare-id={n.id}
          data-change={changes.get(n.id)}
          d={`M${n.x - 0.65} ${n.y - 0.65}l1.3 1.3m0 -1.3l-1.3 1.3`}
          stroke="var(--symbol)"
          strokeWidth="0.3"
        />
      ))}
      <SchematicText original={d.original} changeKinds={changes} />
    </g>
  );
});

export default function SchematicComparison({
  active,
  beforeSource,
  afterSource,
  beforeLabel,
  afterLabel,
}: {
  active: boolean;
  beforeSource: string;
  afterSource: string;
  beforeLabel: string;
  afterLabel: string;
}) {
  const before = useMemo(() => projectSchematics(parseProject(beforeSource)), [beforeSource]);
  const after = useMemo(() => projectSchematics(parseProject(afterSource)), [afterSource]);
  const sheets = useMemo(
    () => [...before, ...after.filter((sheet) => !before.some((old) => old.id === sheet.id))],
    [before, after],
  );
  const [sheetId, setSheetId] = useState(sheets[0].id);
  const activeId = sheets.some((sheet) => sheet.id === sheetId) ? sheetId : sheets[0].id;
  const left = before.find((sheet) => sheet.id === activeId);
  const right = after.find((sheet) => sheet.id === activeId);
  const changes = useMemo(() => compareSchematicVersions(left, right), [left, right]);
  const counts = { added: 0, removed: 0, changed: 0 };
  for (const change of changes.values()) counts[change]++;
  const { leftRef, rightRef, svgProps, zoom, fit } = useComparisonView({
    active,
    before: left,
    after: right,
    initialView,
    emptyView,
    padding: 8,
  });
  return (
    <section className="schematic-comparison" aria-label="Schematic comparison">
      <div className="schematic-compare-header">
        {sheets.length > 1 && (
          <div className="schematic-compare-sheet">
            <Select
              active={active}
              label="Compare schematic file"
              value={activeId}
              options={sheets.map((sheet) => ({ value: sheet.id, label: sheet.title }))}
              onChange={setSheetId}
            />
          </div>
        )}
        <div className="compare-legend" aria-label="Schematic differences">
          {changes.size === 0 && <span>No schematic changes</span>}
          {Object.entries(counts).map(([kind, count]) =>
            count > 0 ? (
              <span key={kind} data-change={kind}>
                {kind[0].toUpperCase() + kind.slice(1)} {count}
              </span>
            ) : null,
          )}
        </div>
      </div>
      <div className="schematic-compare-footer">
        <ComparisonViewActions zoom={zoom} fit={fit} />
      </div>
      <div className="schematic-compare-panes">
        {(
          [
            { circuit: left, label: beforeLabel, side: 'Before', ref: leftRef },
            { circuit: right, label: afterLabel, side: 'After', ref: rightRef },
          ] as const
        ).map(({ circuit, label, side, ref }) => (
          <section
            key={side}
            className="schematic-compare-pane"
            aria-label={`${side} schematic`}
            aria-description={label}
          >
            {circuit ? (
              <svg role="img" tabIndex={0} aria-label={`${side}: ${label}`} {...svgProps}>
                <Drawing circuit={circuit} changes={changes} drawingRef={ref} />
              </svg>
            ) : (
              <div className="compare-sheet-missing">
                Schematic file not present in this version.
              </div>
            )}
          </section>
        ))}
      </div>
    </section>
  );
}
