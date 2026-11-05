'use client';
import QuantityInput from './QuantityInput';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, Focus, RotateCcw, Undo2, X } from 'lucide-react';
import type { Point } from '@/lib/circuit';
import type { ModelCadObject, ModelCadBooleanOperation } from '@/lib/model-cad';
import {
  extrudeModelCadSketch,
  prepareModelCadSketchContour,
  prepareModelCadSketchCorners,
  modelCadSketchVertices,
  pickModelCadSketchContour,
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
  selectedContour?: number;
  selectedCorners?: readonly number[];
};
export type ModelCadSketchInput = {
  down: (point: Point | null, tolerance?: number) => void;
  move: (point: Point | null) => void;
  up: (point: Point | null) => void;
  cancelPointer: () => void;
  closeProfile: () => void;
  keyDown: (key: string) => boolean;
  finish: () => void;
  retainContour: () => void;
  modify: (kind: 'fillet' | 'chamfer' | 'boolean') => void;
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
  const [contourHistory, setContourHistory] = useState<ModelCadSketchContour[][]>([]);
  const [editing, setEditing] = useState<'fillet' | 'chamfer' | 'boolean' | null>(null);
  const [selectedContour, setSelectedContour] = useState(0);
  const [cornerSelection, setCornerSelection] = useState('all');
  const [cornerDistance, setCornerDistance] = useState('1');
  const [contourOperation, setContourOperation] = useState<ModelCadBooleanOperation>('union');
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
  const focusCornerDistance = useRef(cornerDistance);
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
  const acceptedContours = useMemo(
    () => [...contours, ...(currentContour.contour ? [currentContour.contour] : [])],
    [contours, currentContour.contour],
  );
  const editingResult = useMemo(() => {
    if (!editing) return { contours: acceptedContours, error: '' };
    try {
      const target = contours[selectedContour];
      if (!target) throw new Error('Draw a closed contour before modifying the sketch.');
      if (editing === 'boolean' && selectedContour === 0 && contourOperation !== 'union')
        throw new Error('The first sketch contour must use Union.');
      const next =
        editing === 'boolean'
          ? { ...target, operation: contourOperation }
          : prepareModelCadSketchCorners(target, {
              kind: editing,
              distanceMm: parseNumericInput(
                cornerDistance,
                editing === 'fillet' ? 'Fillet radius' : 'Chamfer distance',
              ),
              corners:
                cornerSelection === 'all'
                  ? modelCadSketchVertices(target).map((_, index) => index)
                  : cornerSelection.split(',').map(Number),
            });
      return {
        contours: contours.map((contour, index) => (index === selectedContour ? next : contour)),
        error: '',
      };
    } catch (cause) {
      return { contours: null, error: (cause as Error).message };
    }
  }, [
    editing,
    acceptedContours,
    contours,
    selectedContour,
    cornerSelection,
    cornerDistance,
    contourOperation,
  ]);
  const combined = editingResult.contours ?? acceptedContours;
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
      if (editingResult.error) throw new Error(editingResult.error);
      if (!parameters) throw new Error(workplane.error || 'Draw a closed sketch contour.');
      if (pendingContour)
        throw new Error(currentContour.error || 'Close the current sketch contour.');
      return { object: extrudeModelCadSketch(parameters), error: '' };
    } catch (cause) {
      return { object: null, error: (cause as Error).message };
    }
  }, [parameters, workplane.error, pendingContour, currentContour.error, editingResult.error]);
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
  useLayoutEffect(
    () => onReadyChange(ready && !blocked && !editing),
    [ready, blocked, editing, onReadyChange],
  );
  const sketch = useMemo<ModelCadSketch | null>(
    () =>
      !stale && origin
        ? {
            phase,
            plane,
            origin,
            shape,
            points,
            cursor,
            closed,
            contours: combined,
            ...(editing
              ? {
                  selectedContour,
                  ...(editing !== 'boolean'
                    ? {
                        selectedCorners:
                          cornerSelection === 'all'
                            ? modelCadSketchVertices(contours[selectedContour]).map(
                                (_, index) => index,
                              )
                            : cornerSelection.split(',').map(Number),
                      }
                    : {}),
                }
              : {}),
          }
        : null,
    [
      phase,
      stale,
      plane,
      origin,
      shape,
      points,
      cursor,
      closed,
      combined,
      editing,
      selectedContour,
      cornerSelection,
      contours,
    ],
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
    replaceContours([]);
    setEditing(null);
    setOperation('union');
    clearCurrent();
  }
  function replaceContours(next: ModelCadSketchContour[]) {
    setContourHistory((previous) => [...previous.slice(-31), contours]);
    setContours(next);
  }
  function retainCurrent() {
    if (currentContour.contour && (closed || shape === 'polygon'))
      replaceContours([...contours, currentContour.contour]);
    setEditing(null);
    clearCurrent();
  }
  function beginModify(kind: 'fillet' | 'chamfer' | 'boolean') {
    if (blocked || composition.current || drag.current) return;
    if (pendingContour) {
      setError('Close the current sketch contour before modifying it.');
      return;
    }
    const targetIndex = currentContour.contour ? contours.length : Math.max(0, contours.length - 1);
    const target = acceptedContours[targetIndex];
    if (!target) {
      setError('Draw a closed contour before modifying the sketch.');
      return;
    }
    retainCurrent();
    setSelectedContour(targetIndex);
    setCornerSelection(target.cornerTreatment?.corners.join(',') ?? 'all');
    setCornerDistance(String(target.cornerTreatment?.distanceMm ?? 1));
    setContourOperation(target.operation);
    setEditing(kind);
  }
  function applySketchEdit() {
    if (
      blocked ||
      composition.current ||
      !editing ||
      !editingResult.contours ||
      !profileResult.object
    )
      return;
    replaceContours(editingResult.contours);
    setEditing(null);
    setError('');
    onReturnCanvasFocus?.();
  }
  function selectContour(index: number, corner?: number) {
    if (blocked || composition.current) return;
    const target = contours[index];
    if (!target) return;
    if (index !== selectedContour)
      setCornerDistance(String(target.cornerTreatment?.distanceMm ?? 1));
    setSelectedContour(index);
    setCornerSelection(
      corner === undefined ? (target.cornerTreatment?.corners.join(',') ?? 'all') : String(corner),
    );
    setContourOperation(target.operation);
    setError('');
  }
  function undoSketchEdit() {
    if (blocked || composition.current) return;
    setEditing(null);
    if (points.length) clearCurrent();
    else if (contourHistory.length) {
      setContours(contourHistory.at(-1)!);
      setContourHistory((previous) => previous.slice(0, -1));
      setError('');
    }
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
  function finishSketch() {
    if (blocked || !ready || editing || composition.current || drag.current) return;
    setClosed(true);
    setCursor(null);
    setError('');
    onLeaveView();
    onPhaseChange('profile');
    onReturnCanvasFocus?.();
  }
  useLayoutEffect(() => {
    onInput(
      phase !== 'sketch'
        ? null
        : {
            down: (raw, tolerance = 0.75) => {
              if (blocked) return;
              if (editing) {
                if (raw) {
                  const hit = pickModelCadSketchContour(contours, raw, tolerance);
                  if (hit)
                    selectContour(hit.contour, editing === 'boolean' ? undefined : hit.corner);
                }
                return;
              }
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
                replaceContours([...contours, currentContour.contour]);
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
              if (blocked || editing || !raw) return;
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
                if (editing) {
                  setEditing(null);
                  setError('');
                  return true;
                }
                if (drag.current || (!closed && points.length)) clearCurrent();
                setCursor(null);
                return true;
              }
              if (key === 'Enter') {
                if (editing) {
                  applySketchEdit();
                  return true;
                }
                finishSketch();
                return true;
              }
              if (key === 'Backspace' && shape === 'polygon' && !editing) {
                setPoints((previous) => previous.slice(0, -1));
                setClosed(false);
                return true;
              }
              return false;
            },
            finish: finishSketch,
            retainContour: retainCurrent,
            modify: beginModify,
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
      editingResult.error ||
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
            if (editing) setCornerDistance(focusCornerDistance.current);
            else if (phase === 'plane')
              setOffsets((previous) => ({ ...previous, [plane]: focusOffset.current }));
            else setDepth(focusDepth.current);
            return;
          }
          if (editing) {
            setEditing(null);
            setError('');
          } else if (phase !== 'sketch') close();
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
          else if (phase === 'sketch' && editing) applySketchEdit();
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
          ) : phase === 'sketch' && editing ? (
            <div className={styles.fields}>
              <label>
                <span>Contour</span>
                <Select
                  label="Sketch contour"
                  value={String(selectedContour)}
                  disabled={blocked}
                  options={contours.map((contour, index) => ({
                    value: String(index),
                    label: `Contour ${index + 1} · ${contour.profile.kind}`,
                  }))}
                  onChange={(value) => {
                    if (composition.current) return;
                    selectContour(Number(value));
                  }}
                />
              </label>
              {editing === 'boolean' ? (
                <Select
                  label="Contour Boolean operation"
                  value={contourOperation}
                  disabled={blocked || selectedContour === 0}
                  options={[
                    { value: 'union', label: 'Union' },
                    { value: 'difference', label: 'Difference' },
                    { value: 'intersection', label: 'Intersection' },
                  ]}
                  onChange={(value) => {
                    if (!composition.current) {
                      setContourOperation(value as ModelCadBooleanOperation);
                      setError('');
                    }
                  }}
                />
              ) : (
                <>
                  <Select
                    label="Sketch corners"
                    value={cornerSelection}
                    disabled={blocked}
                    options={[
                      { value: 'all', label: 'All corners' },
                      ...(cornerSelection.includes(',')
                        ? [{ value: cornerSelection, label: 'Selected corners' }]
                        : []),
                      ...modelCadSketchVertices(contours[selectedContour]).map((_, index) => ({
                        value: String(index),
                        label: `Corner ${index + 1}`,
                      })),
                    ]}
                    onChange={(value) => {
                      if (!composition.current) {
                        setCornerSelection(value);
                        setError('');
                      }
                    }}
                  />
                  <label>
                    <span>{editing === 'fillet' ? 'Radius' : 'Distance'}</span>
                    <QuantityInput
                      unit="mm"
                      aria-label={
                        editing === 'fillet'
                          ? 'Sketch fillet radius (mm)'
                          : 'Sketch chamfer distance (mm)'
                      }
                      inputMode="decimal"
                      value={cornerDistance}
                      disabled={blocked}
                      onFocus={() => {
                        focusCornerDistance.current = cornerDistance;
                      }}
                      onValueChange={(value) => {
                        setCornerDistance(value);
                        setError('');
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="tool-button"
                    aria-label="Remove sketch corner treatment"
                    title="Remove corner treatment"
                    disabled={blocked || !contours[selectedContour]?.cornerTreatment}
                    onClick={() => {
                      if (composition.current) return;
                      const next = prepareModelCadSketchCorners(contours[selectedContour], null);
                      replaceContours(
                        contours.map((contour, index) =>
                          index === selectedContour ? next : contour,
                        ),
                      );
                      setEditing(null);
                      setError('');
                      onReturnCanvasFocus?.();
                    }}
                  >
                    <RotateCcw size={17} aria-hidden />
                  </button>
                </>
              )}
              <button
                type="submit"
                className="icon-button property-apply-action"
                aria-label="Apply sketch operation"
                title="Apply sketch operation"
                disabled={blocked || !editingResult.contours || !profileResult.object}
              >
                <Check size={17} aria-hidden />
              </button>
              <button
                type="button"
                className="tool-button"
                aria-label="Cancel sketch operation"
                title="Cancel sketch operation"
                disabled={busy}
                onClick={() => {
                  if (!composition.current) {
                    setEditing(null);
                    setError('');
                    onReturnCanvasFocus?.();
                  }
                }}
              >
                <X size={17} aria-hidden />
              </button>
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
                aria-label="Undo sketch edit"
                title="Undo sketch edit"
                disabled={blocked || (!points.length && !contourHistory.length)}
                onClick={undoSketchEdit}
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
            <button
              type="submit"
              className="icon-button property-apply-action"
              aria-label="Start sketch"
              title="Start sketch"
              disabled={blocked || !origin}
            >
              <Check size={17} aria-hidden="true" />
            </button>
          ) : phase !== 'sketch' ? (
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
          ) : null}
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
