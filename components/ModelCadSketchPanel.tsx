'use client';
import QuantityInput from './QuantityInput';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Focus, RotateCcw, X } from 'lucide-react';
import type { Point } from '@/lib/circuit';
import { validateModelCadObject, type ModelCadObject } from '@/lib/model-cad';
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
};
export type ModelCadSketchInput = {
  down: (point: Point | null) => void;
  move: (point: Point | null) => void;
  up: (point: Point | null) => void;
  cancelPointer: () => void;
  closeProfile: () => void;
  keyDown: (key: string) => boolean;
  finish: () => void;
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
    XY: String(board.thickness / 2),
    XZ: String(seed.position.y),
    YZ: String(seed.position.x),
  });
  const [points, setPoints] = useState<Point[]>([]);
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
  const profile = useMemo(() => {
    if (shape === 'polygon' && points.length < 3) return null;
    if (shape !== 'polygon' && points.length < 2) return null;
    if (shape === 'circle') {
      const radius = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
      return { center: points[0], width: radius * 2, height: radius * 2 };
    }
    const minX = Math.min(...points.map((point) => point.x)),
      maxX = Math.max(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y)),
      maxY = Math.max(...points.map((point) => point.y));
    return {
      center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
      width: maxX - minX,
      height: maxY - minY,
    };
  }, [points, shape]);
  const profileResult = useMemo(() => {
    try {
      if (!origin) throw new Error(workplane.error);
      if (!profile) throw new Error('Draw a closed profile.');
      const { x, y } = profile.center;
      const position =
        plane === 'XY'
          ? { x: origin.x + x, y: origin.y + y, z: origin.z }
          : plane === 'XZ'
            ? { x: origin.x + x, y: origin.y, z: origin.z + y }
            : { x: origin.x, y: origin.y + x, z: origin.z + y };
      const rotation =
        plane === 'XY'
          ? { x: 0, y: 0, z: 0 }
          : plane === 'XZ'
            ? { x: 90, y: 0, z: 0 }
            : { x: 90, y: 90, z: 0 };
      return {
        object: validateModelCadObject({
          ...seed,
          kind: 'extrusion',
          name: 'Extrusion',
          profile:
            shape === 'polygon'
              ? {
                  kind: 'polygon',
                  points: points.map((point) => ({ x: point.x - x, y: point.y - y })),
                }
              : { kind: shape },
          position,
          rotation,
          size: { x: profile.width, y: profile.height, z: 1 },
          holes: [],
        }),
        error: '',
      };
    } catch (cause) {
      return { object: null, error: (cause as Error).message };
    }
  }, [seed, origin, workplane.error, profile, points, shape, plane]);
  const parsed = useMemo(() => {
    try {
      if (!profileResult.object) throw new Error(profileResult.error);
      const distance = parseNumericInput(depth, 'Extrusion distance');
      const offset =
        direction === 'symmetric' ? 0 : distance * (direction === 'positive' ? 0.5 : -0.5);
      const base = profileResult.object;
      return {
        object: validateModelCadObject({
          ...base,
          position: {
            x: base.position.x + (plane === 'YZ' ? offset : 0),
            y: base.position.y - (plane === 'XZ' ? offset : 0),
            z: base.position.z + (plane === 'XY' ? offset : 0),
          },
          size: { ...base.size, z: distance },
        }),
        error: '',
      };
    } catch (cause) {
      return { object: null, error: (cause as Error).message };
    }
  }, [profileResult, plane, depth, direction]);
  const ready = Boolean(profileResult.object && (closed || shape === 'polygon'));
  useLayoutEffect(() => onReadyChange(ready && !blocked), [ready, blocked, onReadyChange]);
  const sketch = useMemo<ModelCadSketch | null>(
    () => (!stale && origin ? { phase, plane, origin, shape, points, cursor, closed } : null),
    [phase, stale, plane, origin, shape, points, cursor, closed],
  );
  useEffect(() => {
    onSketchChange(sketch);
  }, [sketch, onSketchChange]);
  useEffect(() => () => onSketchChange(null), [onSketchChange]);
  useEffect(() => {
    onPreview(phase === 'extrude' && !stale ? parsed.object : null);
  }, [phase, stale, parsed.object, onPreview]);
  useEffect(() => () => onPreview(null), [onPreview]);
  function clearSketch() {
    drag.current = null;
    setPoints([]);
    setClosed(false);
    setCursor(null);
    setError('');
  }
  const previousShape = useRef(shape);
  useLayoutEffect(() => {
    if (previousShape.current === shape) return;
    previousShape.current = shape;
    clearSketch();
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
              if (!raw) {
                setError('The sketch plane is edge-on. Align the view to draw.');
                return;
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
                drag.current = point;
                setPoints([point, point]);
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
              if (drag.current) setPoints([drag.current, point]);
            },
            up: (raw) => {
              if (!drag.current) return;
              if (!blocked && raw) {
                setPoints([drag.current, snapPoint(raw)]);
                setClosed(true);
              }
              drag.current = null;
            },
            cancelPointer: () => {
              if (drag.current) clearSketch();
            },
            closeProfile: () => {
              if (!blocked && shape === 'polygon' && points.length >= 3) setClosed(true);
            },
            keyDown: (key) => {
              if (blocked) return false;
              if (key === 'Escape') {
                if (drag.current) clearSketch();
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
          },
    );
    return () => onInput(null);
  });
  async function apply() {
    if (blocked || !parsed.object || composition.current || phase !== 'extrude') return;
    setBusy(true);
    setError('');
    try {
      await onApply({ kind: 'solid', object: parsed.object });
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
          : profile
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
                <span>{normalAxis} position</span>
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
            <button type="submit" className="primary" disabled={blocked || !origin}>
              Start sketch
            </button>
          ) : phase === 'sketch' ? (
            <button type="button" disabled={blocked} onClick={() => leaveSketch('plane')}>
              Change plane
            </button>
          ) : (
            <>
              <button type="button" disabled={blocked} onClick={enterSketch}>
                Edit sketch
              </button>
              {phase === 'extrude' && (
                <button type="submit" className="primary" disabled={blocked || !parsed.object}>
                  {busy ? 'Applying…' : 'Apply'}
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
