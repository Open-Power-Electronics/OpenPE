'use client';
import QuantityInput from './QuantityInput';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, Focus, RotateCcw, Undo2, X } from 'lucide-react';
import type { Point } from '@/lib/circuit';
import type { ModelCadObject, ModelCadBooleanOperation } from '@/lib/model-cad';
import {
  extrudeModelCadSketch,
  prepareModelCadSketchContour,
  type ModelCadSketchContour,
  type ModelCadSketchExtrusion,
} from '@/lib/model-cad-sketch';
import type { PCB } from '@/lib/pcb';
import Select from './Select';
import { parseNumericInput } from './numeric-input';
import type { ModelCadFeatureAction } from './ModelCadFeaturePanel';
import styles from './ModelCadFeaturePanel.module.css';

export type ModelCadSketchPlane = 'XY' | 'XZ' | 'YZ';
export type ModelCadSketchPhase = 'plane' | 'sketch' | 'profile' | 'extrude';
export type ModelCadSketch = {
  phase: ModelCadSketchPhase;
  plane: ModelCadSketchPlane;
  origin: { x: number; y: number; z: number };
  shape: 'rectangle' | 'circle' | 'polygon';
  points: readonly Point[];
  cursor: Point | null;
  closed: boolean;
  contours: readonly ModelCadSketchContour[];
};
export type ModelCadSketchInput = {
  down: (point: Point | null) => void;
  move: (point: Point | null) => void;
  up: (point: Point | null) => void;
  cancelPointer: () => void;
  closeProfile: () => void;
  keyDown: (key: string) => boolean;
  finish: () => void;
  retainContour: () => void;
};
const snapPoint = (point: Point): Point => ({
  x: Math.round(point.x * 2) / 2,
  y: Math.round(point.y * 2) / 2,
});

export default function ModelCadSketchPanel({
  board,
  seed,
  disabled,
  revision,
  baseRevision,
  onClose,
  onPreview,
  onApply,
  onSketchChange,
  onInput,
  onAlignView,
  onLeaveView,
  onReturnCanvasFocus,
  phase,
  onPhaseChange,
  shape,
  onReadyChange,
}: {
  board: PCB;
  seed: ModelCadObject;
  disabled: boolean;
  revision: string;
  baseRevision: string;
  onClose: () => void;
  onPreview: (object: ModelCadObject | null) => void;
  onApply: (action: ModelCadFeatureAction) => Promise<void>;
  onSketchChange: (sketch: ModelCadSketch | null) => void;
  onInput: (input: ModelCadSketchInput | null) => void;
  onAlignView: (plane: ModelCadSketchPlane, origin: ModelCadSketch['origin']) => void;
  onLeaveView: () => void;
  onReturnCanvasFocus?: () => void;
  phase: ModelCadSketchPhase;
  onPhaseChange: (phase: ModelCadSketchPhase) => void;
  shape: ModelCadSketch['shape'];
  onReadyChange: (ready: boolean) => void;
}) {
  const [plane, setPlane] = useState<ModelCadSketchPlane>('XY');
  const [offsets, setOffsets] = useState({
    XY: '0',
    XZ: '0',
    YZ: '0',
  });
  const [points, setPoints] = useState<Point[]>([]);
  const [contours, setContours] = useState<ModelCadSketchContour[]>([]);
  const [operation, setOperation] = useState<ModelCadBooleanOperation>('union');
  const [cursor, setCursor] = useState<Point | null>(null);
  const [closed, setClosed] = useState(false);
  const [depth, setDepth] = useState('10');
  const [direction, setDirection] = useState<'positive' | 'negative' | 'symmetric'>('positive');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const drag = useRef<Point | null>(null);
  const composition = useRef(false);
  const focusDepth = useRef(depth);
  const focusOffset = useRef(offsets[plane]);
  const leaveView = useRef(onLeaveView);
  leaveView.current = onLeaveView;
  useEffect(() => () => leaveView.current(), []);
  const stale = revision !== baseRevision;
  const blocked = disabled || busy || stale;
  const workplane = useMemo(() => {
    try {
      const offset = parseNumericInput(offsets[plane], 'Plane offset');
      if (Math.abs(offset) > 100000) throw new Error('Plane offset must be within ±100000 mm.');
      return {
        origin: {
          x: plane === 'YZ' ? offset : seed.position.x,
          y: plane === 'XZ' ? offset : seed.position.y,
          z: plane === 'XY' ? offset : board.thickness / 2,
        },
        error: '',
      };
    } catch (cause) {
      return { origin: null, error: (cause as Error).message };
    }
  }, [plane, offsets, seed.position.x, seed.position.y, board.thickness]);
  const origin = workplane.origin;
  const currentContour = useMemo(() => {
    try {
      return {
        contour: prepareModelCadSketchContour(shape, points, contours.length ? operation : 'union'),
        error: '',
      };
    } catch (cause) {
      return { contour: null, error: points.length ? (cause as Error).message : '' };
    }
  }, [shape, points, contours.length, operation]);
  const combined = useMemo(
    () => [...contours, ...(currentContour.contour ? [currentContour.contour] : [])],
    [contours, currentContour.contour],
  );
  const pendingContour =
    points.length > 0 && (!currentContour.contour || (!closed && shape !== 'polygon'));
  const parameters = useMemo<ModelCadSketchExtrusion | null>(
    () =>
      origin && combined.length
        ? {
            id: seed.id,
            name: 'Extrusion',
            plane,
            origin,
            contours: combined,
            distance: 1,
            direction: 'symmetric',
            material: seed.material,
            opacity: seed.opacity,
            ...(seed.color === undefined ? {} : { color: seed.color }),
          }
        : null,
    [origin, combined, plane, seed],
  );
  const profileResult = useMemo(() => {
    try {
      if (!parameters) throw new Error(workplane.error || 'Draw a closed sketch contour.');
      if (pendingContour)
        throw new Error(currentContour.error || 'Close the current sketch contour.');
      return { object: extrudeModelCadSketch(parameters), error: '' };
    } catch (cause) {
      return { object: null, error: (cause as Error).message };
    }
  }, [parameters, workplane.error, pendingContour, currentContour.error]);
  const profile = profileResult.object
    ? { width: profileResult.object.size.x, height: profileResult.object.size.y }
    : null;
  const parsed = useMemo(() => {
    try {
      if (!parameters || !profileResult.object) throw new Error(profileResult.error);
      const input: ModelCadSketchExtrusion = {
        ...parameters,
        distance: parseNumericInput(depth, 'Extrusion distance'),
        direction,
      };
      return { object: extrudeModelCadSketch(input), input, error: '' };
    } catch (cause) {
      return { object: null, input: null, error: (cause as Error).message };
    }
  }, [parameters, profileResult, depth, direction]);
  const ready = Boolean(profileResult.object && !pendingContour);
  useLayoutEffect(() => onReadyChange(ready && !blocked), [ready, blocked, onReadyChange]);
  const sketch = useMemo<ModelCadSketch | null>(
    () =>
      !stale && origin
        ? { phase, plane, origin, shape, points, cursor, closed, contours: combined }
        : null,
    [phase, stale, plane, origin, shape, points, cursor, closed, combined],
  );
  useEffect(() => {
    onSketchChange(sketch);
  }, [sketch, onSketchChange]);
  useEffect(() => () => onSketchChange(null), [onSketchChange]);
  useEffect(() => {
    onPreview(phase === 'extrude' && !stale ? parsed.object : null);
  }, [phase, stale, parsed.object, onPreview]);
  useEffect(() => () => onPreview(null), [onPreview]);
  function clearCurrent() {
    drag.current = null;
    setPoints([]);
    setClosed(false);
    setCursor(null);
    setError('');
  }
  function clearSketch() {
    setContours([]);
    setOperation('union');
    clearCurrent();
  }
  function retainCurrent() {
    if (currentContour.contour && (closed || shape === 'polygon'))
      setContours((previous) => [...previous, currentContour.contour!]);
    clearCurrent();
  }
  const previousShape = useRef(shape);
  useLayoutEffect(() => {
    if (previousShape.current === shape) return;
    previousShape.current = shape;
    clearCurrent();
  }, [shape]);
  function enterSketch() {
    if (blocked || !origin || composition.current) return;
    setError('');
    onPhaseChange('sketch');
    onAlignView(plane, origin);
    onReturnCanvasFocus?.();
  }
  function leaveSketch(next: 'plane' | 'profile') {
    drag.current = null;
    setCursor(null);
    setError('');
    onLeaveView();
    onPhaseChange(next);
    onReturnCanvasFocus?.();
  }
  function finishSketch() {
    if (blocked || !ready || composition.current || drag.current) return;
    setClosed(true);
    leaveSketch('profile');
  }
  useLayoutEffect(() => {
    onInput(
      phase !== 'sketch'
        ? null
        : {
            down: (raw) => {
              if (blocked) return;
              if (contours.length >= 6) {
                setError('A sketch supports up to six contours. Undo a contour to continue.');
                return;
              }
              if (!raw) {
                setError('The sketch plane is edge-on. Align the view to draw.');
                return;
              }
              if (closed && currentContour.contour) {
                if (contours.length >= 5) {
                  setError('A sketch supports up to six contours. Undo a contour to continue.');
                  return;
                }
                setContours((previous) => [...previous, currentContour.contour!]);
              }
              const point = snapPoint(raw);
              setCursor(point);
              if (shape === 'polygon') {
                if (
                  !closed &&
                  points.length >= 3 &&
                  Math.hypot(point.x - points[0].x, point.y - points[0].y) <= 0.5
                )
                  setClosed(true);
                else if (!closed && points.length >= 128) {
                  setError('A polyline supports up to 128 vertices. Close the profile to finish.');
                  return;
                } else {
                  setPoints((previous) =>
                    closed
                      ? [point]
                      : previous.length &&
                          previous.at(-1)!.x === point.x &&
                          previous.at(-1)!.y === point.y
                        ? previous
                        : [...previous, point],
                  );
                  setClosed(false);
                }
              } else {
                const anchor = !closed && points.length === 2 ? points[0] : point;
                drag.current = anchor;
                setPoints([anchor, point]);
                setClosed(false);
              }
              setError('');
            },
            move: (raw) => {
              if (blocked || !raw) return;
              const point = snapPoint(raw);
              setCursor((previous) =>
                previous?.x === point.x && previous?.y === point.y ? previous : point,
              );
              const anchor =
                drag.current ??
                (shape !== 'polygon' && !closed && points.length === 2 ? points[0] : null);
              if (anchor) setPoints([anchor, point]);
            },
            up: (raw) => {
              if (!drag.current) return;
              if (!blocked && raw) {
                const point = snapPoint(raw);
                const dx = Math.abs(point.x - drag.current.x);
                const dy = Math.abs(point.y - drag.current.y);
                setPoints([drag.current, point]);
                setClosed(shape === 'circle' ? dx > 0 || dy > 0 : dx > 0 && dy > 0);
              }
              drag.current = null;
            },
            cancelPointer: () => {
              if (drag.current) clearCurrent();
            },
            closeProfile: () => {
              if (!blocked && shape === 'polygon' && points.length >= 3) setClosed(true);
            },
            keyDown: (key) => {
              if (blocked) return false;
              if (key === 'Escape') {
                if (drag.current || (!closed && points.length)) clearCurrent();
                setCursor(null);
                return true;
              }
              if (key === 'Enter') {
                finishSketch();
                return true;
              }
              if (key === 'Backspace' && shape === 'polygon') {
                setPoints((previous) => previous.slice(0, -1));
                setClosed(false);
                return true;
              }
              return false;
            },
            finish: finishSketch,
            retainContour: retainCurrent,
          },
    );
    return () => onInput(null);
  });
  async function apply() {
    if (blocked || !parsed.object || composition.current || phase !== 'extrude') return;
    setBusy(true);
    setError('');
    try {
      if (!parsed.input) return;
      await onApply({ kind: 'sketch', sketch: parsed.input });
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const errorText = stale
    ? 'The project changed. Start the sketch again.'
    : error ||
      (phase === 'plane'
        ? workplane.error
        : phase === 'extrude'
          ? parsed.error
          : closed ||
              (shape === 'polygon' && points.length >= 3) ||
              (!points.length && contours.length)
            ? profileResult.error
            : '');
  const title =
    phase === 'plane'
      ? 'Sketch plane'
      : phase === 'sketch'
        ? 'Sketch'
        : phase === 'profile'
          ? 'Sketch profile'
          : 'Extrude';
  const cancelExtrusion = () => {
    if (busy || composition.current) return;
    setError('');
    onPhaseChange('profile');
    onReturnCanvasFocus?.();
  };
  const close = phase === 'extrude' ? cancelExtrusion : onClose;
  const normalAxis = plane === 'XY' ? 'Z' : plane === 'XZ' ? 'Y' : 'X';
  return (
    <aside
      className={`${styles.panel} editor-tool-sheet`}
      aria-label={phase === 'profile' ? title : `${title} settings`}
      onCompositionStart={() => {
        composition.current = true;
      }}
      onCompositionEnd={() => {
        composition.current = false;
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.defaultPrevented) return;
        if (
          event.nativeEvent.isComposing ||
          event.nativeEvent.keyCode === 229 ||
          composition.current
        ) {
          if (event.key === 'Enter') event.preventDefault();
          return;
        }
        if (event.key === 'Escape' && !busy) {
          event.preventDefault();
          if (event.target instanceof HTMLInputElement) {
            if (phase === 'plane')
              setOffsets((previous) => ({ ...previous, [plane]: focusOffset.current }));
            else setDepth(focusDepth.current);
            return;
          }
          if (phase !== 'sketch') close();
        }
      }}
    >
      <header className={styles.header}>
        <h2>{phase === 'extrude' ? 'Distance' : phase === 'profile' ? 'Size' : 'Plane'}</h2>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (phase === 'plane') enterSketch();
          else if (phase === 'extrude') void apply();
        }}
      >
        <div className={styles.parameters}>
          {phase === 'plane' ? (
            <div className={styles.fields}>
              <label>
                <span>Plane</span>
                <Select
                  label="Sketch plane"
                  value={plane}
                  options={['XY', 'XZ', 'YZ'].map((value) => ({ value, label: value }))}
                  disabled={blocked}
                  onChange={(value) => {
                    setPlane(value as ModelCadSketchPlane);
                    setError('');
                  }}
                />
              </label>
              <label>
                <span>Offset</span>
                <QuantityInput
                  unit={'mm'}
                  aria-label="Sketch plane offset (mm)"
                  inputMode="decimal"
                  value={offsets[plane]}
                  disabled={blocked}
                  onFocus={() => {
                    focusOffset.current = offsets[plane];
                  }}
                  onValueChange={(inputValue) => {
                    setOffsets((previous) => ({ ...previous, [plane]: inputValue }));
                    setError('');
                  }}
                />
              </label>
            </div>
          ) : phase === 'sketch' ? (
            <div className={styles.fields}>
              <span>
                {plane} · {normalAxis} = {Number(offsets[plane]).toFixed(2)} mm
              </span>
              <label>
                <span>Operation</span>
                <Select
                  label="Sketch Boolean operation"
                  value={operation}
                  options={[
                    { value: 'union', label: 'Union' },
                    { value: 'difference', label: 'Difference' },
                    { value: 'intersection', label: 'Intersection' },
                  ]}
                  disabled={blocked || !combined.length}
                  onChange={(value) => {
                    if (composition.current) return;
                    retainCurrent();
                    setOperation(value as ModelCadBooleanOperation);
                  }}
                />
              </label>
              <button
                type="button"
                className="tool-button"
                aria-label="Undo sketch contour"
                title="Undo contour"
                disabled={blocked || (!points.length && !contours.length)}
                onClick={() => {
                  if (composition.current) return;
                  if (points.length) clearCurrent();
                  else setContours((previous) => previous.slice(0, -1));
                }}
              >
                <Undo2 size={17} aria-hidden />
              </button>
              <button
                type="button"
                className="tool-button"
                aria-label="Align view to sketch"
                title="Align view"
                disabled={blocked}
                onClick={() => {
                  if (origin) onAlignView(plane, origin);
                }}
              >
                <Focus size={17} aria-hidden />
              </button>
              <button
                type="button"
                className="tool-button"
                aria-label="Clear sketch"
                title="Clear sketch"
                disabled={blocked}
                onClick={clearSketch}
              >
                <RotateCcw size={17} aria-hidden />
              </button>
            </div>
          ) : phase === 'extrude' ? (
            <div className={styles.fields}>
              <label>
                <span>Distance</span>
                <QuantityInput
                  unit={'mm'}
                  aria-label="Extrusion distance (mm)"
                  inputMode="decimal"
                  value={depth}
                  disabled={blocked}
                  onFocus={() => {
                    focusDepth.current = depth;
                  }}
                  onValueChange={(inputValue) => {
                    setDepth(inputValue);
                    setError('');
                  }}
                />
              </label>
              <label>
                <span>Direction</span>
                <Select
                  label="Extrusion direction"
                  value={direction}
                  options={[
                    { value: 'positive', label: 'Positive' },
                    { value: 'negative', label: 'Negative' },
                    { value: 'symmetric', label: 'Symmetric' },
                  ]}
                  disabled={blocked}
                  onChange={(value) => {
                    setDirection(value as typeof direction);
                    setError('');
                  }}
                />
              </label>
            </div>
          ) : null}
          {profile && phase !== 'plane' && (
            <div className={styles.readout}>
              <span>
                {profile.width.toFixed(2)} × {profile.height.toFixed(2)} mm
              </span>
              {shape === 'polygon' && <span>{points.length} vertices</span>}
            </div>
          )}
          {errorText && (
            <p className={styles.error} role="alert">
              {errorText}
            </p>
          )}
        </div>
        <footer className={styles.footer}>
          {phase === 'plane' ? (
            <button type="submit" className="dialog-button primary" disabled={blocked || !origin}>
              Start sketch
            </button>
          ) : phase === 'sketch' ? (
            <button
              type="button"
              disabled={blocked}
              onClick={(event) => {
                event.preventDefault();
                if (!composition.current) leaveSketch('plane');
              }}
            >
              Change plane
            </button>
          ) : (
            <>
              <button type="button" disabled={blocked} onClick={enterSketch}>
                Edit sketch
              </button>
              {phase === 'extrude' && (
                <button
                  type="submit"
                  className="icon-button property-apply-action"
                  aria-label="Apply"
                  title={busy ? 'Applying…' : 'Apply'}
                  aria-busy={busy}
                  disabled={blocked || !parsed.object}
                >
                  <Check size={17} aria-hidden="true" />
                </button>
              )}
            </>
          )}
          <button
            type="button"
            className={styles.close}
            aria-label={phase === 'profile' ? 'Discard sketch' : 'Cancel'}
            title="Close"
            disabled={busy}
            onClick={close}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </footer>
      </form>
    </aside>
  );
}
