'use client';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { Maximize, Minus, Plus } from 'lucide-react';
import Dialog from './Dialog';
import Select from './Select';
import SymbolGraphic from './SymbolGraphic';
import SchematicText from './SchematicText';
import { parseProject, projectSchematics } from '@/lib/project';
import type { Circuit } from '@/lib/circuit';
import { partTransform } from '@/lib/schematic-edit';
import {
  displayPartValue,
  extraSymbolAnnotations,
  symbolAnnotation,
  symbolUnits,
} from '@/lib/library';
import { globalLabelPath, visibleJunctions } from '@/lib/schematic-view';
import { compareSchematicVersions, type SchematicChange } from '@/lib/schematic-version-diff';

type View = { x: number; y: number; width: number; height: number };

const Drawing = memo(function Drawing({
  circuit: d,
  changes,
  drawingRef,
}: {
  circuit: Circuit;
  changes: ReadonlyMap<string, SchematicChange>;
  drawingRef: RefObject<SVGGElement | null>;
}) {
  const [boxes, setBoxes] = useState<(View & { id: string; kind: SchematicChange })[]>([]);
  // Dialog.showModal runs after child layout effects. Measure after it is visible.
  useEffect(() => {
    const next: (View & { id: string; kind: SchematicChange })[] = [];
    drawingRef.current
      ?.querySelectorAll<SVGGraphicsElement>('[data-compare-box], text[data-selection-id]')
      .forEach((element) => {
        const id = (element.dataset.compareId ?? element.dataset.selectionId)!;
        const kind = changes.get(id);
        if (kind) {
          const bounds = element.getBBox();
          next.push({
            id,
            kind,
            x: bounds.x - 1.5,
            y: bounds.y - 1.5,
            width: bounds.width + 3,
            height: bounds.height + 3,
          });
        }
      });
    setBoxes(next);
  }, [d, changes, drawingRef]);
  return (
    <>
      <g aria-hidden="true">
        {boxes.map((box) => (
          <rect
            key={box.id}
            className="compare-object-highlight"
            data-change={box.kind}
            x={box.x}
            y={box.y}
            width={box.width}
            height={box.height}
            rx="1"
          />
        ))}
      </g>
      <g ref={drawingRef}>
        {d.wires.map((wire) => (
          <g
            key={wire.id}
            data-compare-id={wire.id}
            data-change={changes.get(wire.id)}
            aria-label={`${changes.get(wire.id) ?? 'Unchanged'} wire`}
          >
            {changes.has(wire.id) && (
              <line
                className="compare-wire-highlight"
                x1={wire.a.x}
                y1={wire.a.y}
                x2={wire.b.x}
                y2={wire.b.y}
              />
            )}
            <line
              stroke="var(--wire)"
              strokeWidth="0.5"
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
              data-compare-box
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
            data-compare-box
            data-change={changes.get(junction.id)}
            cx={junction.x}
            cy={junction.y}
            r={changes.has(junction.id) ? 1 : 0.65}
            fill="var(--wire)"
          />
        ))}
        {d.labels.map((label) => (
          <g
            key={label.id}
            data-compare-id={label.id}
            data-compare-box
            data-change={changes.get(label.id)}
          >
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
            data-compare-box
            data-change={changes.get(n.id)}
            d={`M${n.x - 0.65} ${n.y - 0.65}l1.3 1.3m0 -1.3l-1.3 1.3`}
            stroke="var(--symbol)"
            strokeWidth="0.3"
          />
        ))}
        <SchematicText original={d.original} changeKinds={changes} />
      </g>
    </>
  );
});

export default function SchematicCompareDialog({
  beforeSource,
  afterSource,
  beforeLabel,
  afterLabel,
  onClose,
}: {
  beforeSource: string;
  afterSource: string;
  beforeLabel: string;
  afterLabel: string;
  onClose: () => void;
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
  const leftRef = useRef<SVGGElement>(null),
    rightRef = useRef<SVGGElement>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, width: 100, height: 100 });
  const initialView = useRef(view);
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    view: View;
    scale: number;
    target: SVGSVGElement;
  } | null>(null);
  const cancelDrag = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    if (current?.target.hasPointerCapture(current.pointerId))
      current.target.releasePointerCapture(current.pointerId);
  }, []);
  useLayoutEffect(() => {
    cancelDrag();
    const boxes = [leftRef.current, rightRef.current]
      .filter((group) => group?.childElementCount)
      .map((group) => group!.getBBox());
    let next = { x: -10, y: -10, width: 100, height: 100 };
    if (boxes.length) {
      const x = Math.min(...boxes.map((box) => box.x)) - 8;
      const y = Math.min(...boxes.map((box) => box.y)) - 8;
      next = {
        x,
        y,
        width: Math.max(20, Math.max(...boxes.map((box) => box.x + box.width)) - x + 8),
        height: Math.max(20, Math.max(...boxes.map((box) => box.y + box.height)) - y + 8),
      };
    }
    initialView.current = next;
    setView(next);
    return cancelDrag;
  }, [left, right, cancelDrag]);
  const zoom = useCallback(
    (factor: number) => {
      cancelDrag();
      setView((current) => {
        const ratio = (current.width / initialView.current.width) * factor;
        if (ratio < 0.02 || ratio > 20) return current;
        return {
          x: current.x + (current.width * (1 - factor)) / 2,
          y: current.y + (current.height * (1 - factor)) / 2,
          width: current.width * factor,
          height: current.height * factor,
        };
      });
    },
    [cancelDrag],
  );
  useEffect(() => {
    const surfaces = [leftRef.current, rightRef.current]
      .map((group) => group?.ownerSVGElement)
      .filter((svg): svg is SVGSVGElement => Boolean(svg));
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.deltaY) zoom(event.deltaY < 0 ? 0.8 : 1.25);
    };
    const observer = new ResizeObserver(cancelDrag);
    for (const svg of surfaces) {
      svg.addEventListener('wheel', wheel, { passive: false });
      observer.observe(svg);
    }
    return () => {
      observer.disconnect();
      for (const svg of surfaces) svg.removeEventListener('wheel', wheel);
    };
  }, [left, right, zoom, cancelDrag]);
  return (
    <Dialog title="Compare schematics" className="schematic-compare-dialog" onClose={onClose}>
      <div className="schematic-compare-toolbar">
        <Select
          label="Compare schematic file"
          value={activeId}
          options={sheets.map((sheet) => ({ value: sheet.id, label: sheet.title }))}
          onChange={setSheetId}
        />
        <div className="compare-legend" aria-label="Schematic differences">
          {(['added', 'removed', 'changed'] as const).map((kind) => (
            <span key={kind} data-change={kind}>
              {kind[0].toUpperCase() + kind.slice(1)}{' '}
              {Array.from(changes.values()).filter((value) => value === kind).length}
            </span>
          ))}
        </div>
        <div className="compare-view-actions">
          <button
            className="tool-button"
            aria-label="Zoom out comparison"
            title="Zoom out"
            onClick={() => zoom(1.25)}
          >
            <Minus size={17} />
          </button>
          <button
            className="tool-button"
            aria-label="Zoom in comparison"
            title="Zoom in"
            onClick={() => zoom(0.8)}
          >
            <Plus size={17} />
          </button>
          <button
            className="tool-button"
            aria-label="Fit comparison"
            title="Fit view"
            onClick={() => {
              cancelDrag();
              setView(initialView.current);
            }}
          >
            <Maximize size={17} />
          </button>
        </div>
      </div>
      <div className="schematic-compare-panes">
        {(
          [
            { circuit: left, label: beforeLabel, side: 'Before', ref: leftRef },
            { circuit: right, label: afterLabel, side: 'After', ref: rightRef },
          ] as const
        ).map(({ circuit, label, side, ref }) => (
          <section key={side} className="schematic-compare-pane" aria-label={`${side} schematic`}>
            <header>
              <span>{side}</span>
              <strong aria-description={label}>{label}</strong>
            </header>
            {circuit ? (
              <svg
                role="img"
                tabIndex={0}
                aria-label={`${side}: ${label}`}
                viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
                onKeyDown={(event) => {
                  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key))
                    return;
                  event.preventDefault();
                  cancelDrag();
                  setView((current) => ({
                    ...current,
                    x:
                      current.x +
                      ((event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0) *
                        current.width) /
                        10,
                    y:
                      current.y +
                      ((event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0) *
                        current.height) /
                        10,
                  }));
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  const matrix = event.currentTarget.getScreenCTM();
                  if (!matrix) return;
                  event.currentTarget.setPointerCapture(event.pointerId);
                  drag.current = {
                    pointerId: event.pointerId,
                    x: event.clientX,
                    y: event.clientY,
                    view,
                    scale: matrix.a,
                    target: event.currentTarget,
                  };
                }}
                onPointerMove={(event) => {
                  const current = drag.current;
                  if (current && current.pointerId === event.pointerId)
                    setView({
                      ...current.view,
                      x: current.view.x - (event.clientX - current.x) / current.scale,
                      y: current.view.y - (event.clientY - current.y) / current.scale,
                    });
                }}
                onPointerUp={cancelDrag}
                onPointerCancel={cancelDrag}
                onLostPointerCapture={cancelDrag}
              >
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
    </Dialog>
  );
}
