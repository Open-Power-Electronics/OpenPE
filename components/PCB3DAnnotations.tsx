'use client';
import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { PCB } from '@/lib/pcb';
import type { Circuit, Point } from '@/lib/circuit';
import type { AgentAnnotation, AnnotationBounds } from '@/lib/agent-annotations';
import type { ModelCAD } from '@/lib/model-cad';
import { markupBounds, type captureAnnotationImage } from '@/lib/annotation-screenshot';
import CanvasAnnotations, {
  type AnnotationMode,
  type CanvasAnnotationsHandle,
} from './CanvasAnnotations';

export type ObjectAnnotationProps = {
  sessionId: string;
  annotations: AgentAnnotation[];
  onChange: (annotations: AgentAnnotation[]) => void;
  onAdd?: () => void;
  disabled?: boolean;
};
export type ObjectAnnotationView = {
  basis: string;
  ratio: number;
  elements: { id: string; bounds: AnnotationBounds; pointOnly?: true }[];
};

export default function PCB3DAnnotations({
  board,
  schematic,
  modelCad,
  active,
  view,
  captureImage,
  pick,
  onExit,
  onSelection,
  disabled: _disabled,
  ...props
}: ObjectAnnotationProps & {
  board: PCB;
  schematic: Circuit;
  modelCad: ModelCAD | null;
  active: boolean;
  view: ObjectAnnotationView;
  captureImage: typeof captureAnnotationImage;
  pick: (point: Point) => string | null;
  onExit: () => void;
  onSelection: (ids: string[]) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const controller = useRef<CanvasAnnotationsHandle>(null);
  const selectableIdsKey = JSON.stringify([...new Set(view.elements.map(({ id }) => id))].sort());
  const selectableIds = useMemo(
    () => new Set(JSON.parse(selectableIdsKey) as string[]),
    [selectableIdsKey],
  );
  const [mode, setMode] = useState<AnnotationMode>('element');
  const [gesture, setGesture] = useState<{
    pointer: number;
    start: Point;
    end: Point;
    points: Point[];
  } | null>(null);
  useEffect(() => {
    setGesture(null);
    onSelection([]);
  }, [active, props.sessionId, view.basis, view.elements, board, onSelection]);
  function point(e: PointerEvent<SVGSVGElement>): Point {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1000, ((e.clientX - rect.left) / rect.width) * 1000)),
      y: Math.max(0, Math.min(view.ratio * 1000, ((e.clientY - rect.top) / rect.width) * 1000)),
    };
  }
  return (
    <div className="pcb-object-annotations" hidden={!active}>
      <svg
        ref={svg}
        className="pcb-object-annotation-canvas"
        tabIndex={0}
        aria-label="3D annotation canvas"
        viewBox={`0 0 1000 ${1000 * view.ratio}`}
        onPointerDown={(e) => {
          if (e.button !== 0 || !active) return;
          e.preventDefault();
          e.currentTarget.focus();
          e.currentTarget.setPointerCapture(e.pointerId);
          const p = point(e);
          setGesture({ pointer: e.pointerId, start: p, end: p, points: [p] });
        }}
        onPointerMove={(e) => {
          if (!gesture || gesture.pointer !== e.pointerId) return;
          const p = point(e);
          setGesture({
            ...gesture,
            end: p,
            points: [
              ...(gesture.points.length >= 512
                ? gesture.points.filter((_, i) => i % 2 === 0)
                : gesture.points),
              p,
            ],
          });
        }}
        onPointerCancel={() => setGesture(null)}
        onLostPointerCapture={() => setGesture(null)}
        onPointerUp={(e) => {
          if (!gesture || gesture.pointer !== e.pointerId) return;
          const end = point(e);
          const moved =
            Math.hypot(end.x - gesture.start.x, end.y - gesture.start.y) >
            (4 * 1000) / e.currentTarget.clientWidth;
          setGesture(null);
          e.currentTarget.releasePointerCapture(e.pointerId);
          if (!moved && mode === 'element') {
            const id = pick(end);
            if (id) controller.current?.select([id]);
            return;
          }
          if (!moved) return;
          const points =
            mode === 'freehand' ? [...gesture.points, end].slice(-512) : [gesture.start, end];
          const bounds = markupBounds({ kind: 'freehand', points });
          const ids = view.elements
            .filter(
              ({ bounds: b, pointOnly }) =>
                !pointOnly &&
                b.x <= bounds.x + bounds.width &&
                b.x + b.width >= bounds.x &&
                b.y <= bounds.y + bounds.height &&
                b.y + b.height >= bounds.y,
            )
            .map((e) => e.id);
          controller.current?.select(
            ids,
            mode === 'element'
              ? undefined
              : mode === 'freehand'
                ? { kind: 'freehand', points }
                : { kind: 'rectangle', bounds },
          );
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
            e.preventDefault();
            if (gesture) setGesture(null);
            else onExit();
          }
        }}
      >
        {view.elements.map(({ id, bounds }) => (
          <rect
            key={id}
            {...bounds}
            data-selection-id={id}
            fill="transparent"
            stroke="none"
            pointerEvents="none"
          />
        ))}
        <g className="annotation-gesture" pointerEvents="none">
          {gesture &&
            (mode === 'freehand' ? (
              <polyline points={gesture.points.map((p) => `${p.x},${p.y}`).join(' ')} />
            ) : (
              <rect {...markupBounds({ kind: 'freehand', points: [gesture.start, gesture.end] })} />
            ))}
        </g>
      </svg>
      <CanvasAnnotations
        ref={controller}
        svg={svg}
        doc={schematic}
        board={board}
        modelCad={modelCad}
        active={active}
        {...props}
        selectableIds={selectableIds}
        onSelection={onSelection}
        view={{ x: 0, y: 0, width: 1000 }}
        ratio={view.ratio}
        mode={mode}
        onMode={setMode}
        onExit={onExit}
        objectView={view.basis}
        captureImage={captureImage}
      />
    </div>
  );
}
