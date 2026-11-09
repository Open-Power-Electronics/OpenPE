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
  canAdjust?: boolean;
  adjusting?: boolean;
  selectedContour?: number;
  selectedCorners?: readonly number[];
};
type SketchEdit = 'adjust' | 'fillet' | 'chamfer' | 'boolean';
export type ModelCadSketchInput = {
  down: (point: Point | null, tolerance?: number) => void;
  move: (point: Point | null) => void;
  up: (point: Point | null) => void;
  cancelPointer: () => void;
  closeProfile: () => void;
  keyDown: (key: string) => boolean;
  finish: () => void;
  retainContour: () => boolean;
  modify: (kind: SketchEdit) => void;
};
const snapPoint = (point: Point): Point => ({
  x: Math.round(point.x * 2) / 2,
  y: Math.round(point.y * 2) / 2,
});
const contourFields = (contour: ModelCadSketchContour) => ({
  x: String(contour.position.x),
  y: String(contour.position.y),
  width: String(contour.size.x),
  height: String(contour.size.y),
});
type ContourFields = ReturnType<typeof contourFields>;

function adjustContour(
  target: ModelCadSketchContour,
  fields: ContourFields,
): ModelCadSketchContour {
  const position = {
    x: parseNumericInput(fields.x, 'Center position'),
    y: parseNumericInput(fields.y, 'Center position'),
  };
  const circle = target.profile.kind === 'circle';
  const width = parseNumericInput(fields.width, circle ? 'Diameter' : 'Width');
  const size = { x: width, y: circle ? width : parseNumericInput(fields.height, 'Height') };
  const profile =
    target.profile.kind === 'polygon' && (size.x !== target.size.x || size.y !== target.size.y)
      ? {
          kind: 'polygon' as const,
          points: target.profile.points.map((point) => ({
            x: size.x === target.size.x ? point.x : (point.x / target.size.x) * size.x,
            y: size.y === target.size.y ? point.y : (point.y / target.size.y) * size.y,
          })),
        }
      : target.profile;
  if (Math.abs(position.x) > 100000 || Math.abs(position.y) > 100000)
    throw new Error('Sketch center must be within ±100000 mm.');
  return prepareModelCadSketchCorners(
    { ...target, position, size, profile },
    target.cornerTreatment ?? null,
  );
}

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
  const [editing, setEditing] = useState<SketchEdit | null>(null);
  const [selectedContour, setSelectedContour] = useState(0);
  const [adjustment, setAdjustment] = useState<ContourFields | null>(null);
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
  const adjustDrag = useRef<{ start: Point; fields: ContourFields; center: Point } | null>(null);
  const composition = useRef(false);
  const focusDepth = useRef(depth);
  const focusOffset = useRef(offsets[plane]);
  const focusCornerDistance = useRef(cornerDistance);
  const focusAdjustment = useRef<ContourFields | null>(null);
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
  const selected = contours[selectedContour];
  const adjusting = editing === 'adjust';
  const original = adjusting && selected ? contourFields(selected) : null;
  const adjustmentChanged =
    adjustment &&
    original &&
    (adjustment.x !== original.x ||
      adjustment.y !== original.y ||
      adjustment.width !== original.width ||
      adjustment.height !== original.height);
  const editingResult = useMemo(() => {
    if (!editing) return { contours: acceptedContours, error: '' };
    try {
      const target = contours[selectedContour];
      if (!target) throw new Error('Draw a closed contour before modifying the sketch.');
      if (editing === 'boolean' && selectedContour === 0 && contourOperation !== 'union')
        throw new Error('The first sketch contour must use Union.');
      const next =
        editing === 'adjust'
          ? adjustContour(target, adjustment ?? contourFields(target))
          : editing === 'boolean'
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
    adjustment,
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
  const canAdjust =
    !editing && !pendingContour && (!points.length || closed) && acceptedContours.length > 0;
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
            canAdjust,
            ...(editing
              ? {
                  adjusting,
                  selectedContour,
                  ...(editing === 'fillet' || editing === 'chamfer'
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
      canAdjust,
      editing,
      adjusting,
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
    if (blocked || composition.current || adjusting || drag.current) return false;
    if (currentContour.contour && (closed || shape === 'polygon'))
      replaceContours([...contours, currentContour.contour]);
    setEditing(null);
    clearCurrent();
    return true;
  }
  function beginModify(kind: SketchEdit) {
    if (blocked || composition.current || editing || drag.current) return;
    if (kind === 'adjust' && !canAdjust) return;
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
    if (kind === 'adjust') setAdjustment(contourFields(target));
    setCornerSelection(target.cornerTreatment?.corners.join(',') ?? 'all');
    setCornerDistance(String(target.cornerTreatment?.distanceMm ?? 1));
    setContourOperation(target.operation);
    setEditing(kind);
  }
  function applySketchEdit() {
    if (
      blocked ||
      composition.current ||
      adjustDrag.current ||
      !editing ||
      !editingResult.contours ||
      !profileResult.object
    )
      return;
    const next = editingResult.contours[selectedContour];
    if (
      !adjusting ||
      next.position.x !== selected.position.x ||
      next.position.y !== selected.position.y ||
      next.size.x !== selected.size.x ||
      next.size.y !== selected.size.y
    )
      replaceContours(editingResult.contours);
    cancelSketchEdit();
  }
  function cancelSketchEdit() {
    if (composition.current) return;
    adjustDrag.current = null;
    setEditing(null);
    setError('');
    onReturnCanvasFocus?.();
  }
  function selectContour(index: number, corner?: number): boolean {
    if (blocked || composition.current || adjustDrag.current) return false;
    const target = contours[index];
    if (!target) return false;
    if (adjusting) {
      if (index === selectedContour) return true;
      if (adjustmentChanged) {
        setError('Apply or cancel the adjustment before selecting another contour.');
        return false;
      }
      setAdjustment(contourFields(target));
    }
    if (index !== selectedContour)
      setCornerDistance(String(target.cornerTreatment?.distanceMm ?? 1));
    setSelectedContour(index);
    setCornerSelection(
      corner === undefined ? (target.cornerTreatment?.corners.join(',') ?? 'all') : String(corner),
    );
    setContourOperation(target.operation);
    setError('');
    return true;
  }
  function moveAdjustment(raw: Point) {
    const gesture = adjustDrag.current;
    if (!gesture) return;
    const delta = snapPoint({ x: raw.x - gesture.start.x, y: raw.y - gesture.start.y });
    const x = delta.x ? String(gesture.center.x + delta.x) : gesture.fields.x;
    const y = delta.y ? String(gesture.center.y + delta.y) : gesture.fields.y;
    setAdjustment((previous) =>
      previous?.x === x && previous.y === y ? previous : { ...gesture.fields, x, y },
    );
    setError('');
  }
  function cancelAdjustmentDrag() {
    if (!adjustDrag.current) return;
    setAdjustment(adjustDrag.current.fields);
    adjustDrag.current = null;
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
              if (blocked || composition.current) return;
              if (editing) {
                if (raw) {
                  const hit = pickModelCadSketchContour(
                    adjusting ? combined : contours,
                    raw,
                    tolerance,
                  );
                  if (
                    !hit ||
                    !selectContour(hit.contour, editing === 'boolean' ? undefined : hit.corner)
                  )
                    return;
                  if (adjusting && adjustment && editingResult.contours) {
                    const target = editingResult.contours[hit.contour];
                    adjustDrag.current = {
                      start: raw,
                      fields: hit.contour === selectedContour ? adjustment : contourFields(target),
                      center: target.position,
                    };
                  }
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
              if (blocked || composition.current || !raw) return;
              if (adjusting) {
                moveAdjustment(raw);
                return;
              }
              if (editing) return;
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
              if (adjustDrag.current) {
                if (blocked || composition.current || !raw) cancelAdjustmentDrag();
                else moveAdjustment(raw);
                adjustDrag.current = null;
                return;
              }
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
              cancelAdjustmentDrag();
              if (drag.current) clearCurrent();
            },
            closeProfile: () => {
              if (
                !blocked &&
                !editing &&
                !composition.current &&
                shape === 'polygon' &&
                points.length >= 3
              )
                setClosed(true);
            },
            keyDown: (key) => {
              if (composition.current) return true;
              if (blocked) return false;
              if (key === 'Escape') {
                if (editing) {
                  if (adjustDrag.current) cancelAdjustmentDrag();
                  else cancelSketchEdit();
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
  const close = () => {
    if (busy || composition.current) return;
    if (phase === 'extrude') cancelExtrusion();
    else onClose();
  };
  const normalAxis = plane === 'XY' ? 'Z' : plane === 'XZ' ? 'Y' : 'X';
  const positionAxes = plane === 'XY' ? ['X', 'Y'] : plane === 'XZ' ? ['X', 'Z'] : ['Y', 'Z'];
  const circle = selected?.profile.kind === 'circle';
  const adjustmentFields: { key: keyof ContourFields; label: string }[] = [
    { key: 'x', label: `Center ${positionAxes[0]}` },
    { key: 'y', label: `Center ${positionAxes[1]}` },
    { key: 'width', label: circle ? 'Diameter' : 'Width' },
  ];
  if (!circle) adjustmentFields.push({ key: 'height', label: 'Height' });
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
            if (adjusting) {
              setAdjustment(focusAdjustment.current);
              setError('');
            } else if (editing) setCornerDistance(focusCornerDistance.current);
            else if (phase === 'plane')
              setOffsets((previous) => ({ ...previous, [plane]: focusOffset.current }));
            else setDepth(focusDepth.current);
            return;
          }
          if (editing) cancelSketchEdit();
          else if (phase !== 'sketch') close();
        }
      }}
    >
      <header className={styles.header}>
        <h2>
          {adjusting
            ? 'Contour'
            : phase === 'extrude'
              ? 'Distance'
              : phase === 'profile'
                ? 'Size'
                : 'Plane'}
        </h2>
      </header>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (phase === 'plane') enterSketch();
          else if (phase === 'sketch' && editing) applySketchEdit();
          else if (phase === 'extrude') void apply();
        }}
      >
        <div
          className={
            adjusting ? `${styles.parameters} ${styles.adjustmentParameters}` : styles.parameters
          }
        >
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
            <div
              className={adjusting ? `${styles.fields} ${styles.adjustmentFields}` : styles.fields}
            >
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
              {adjusting && adjustment ? (
                adjustmentFields.map(({ key, label }) => (
                  <label key={key}>
                    <span>{label}</span>
                    <QuantityInput
                      unit="mm"
                      aria-label={`Sketch ${label.toLowerCase()} (mm)`}
                      value={adjustment[key]}
                      disabled={blocked}
                      onFocus={() => {
                        focusAdjustment.current = adjustment;
                      }}
                      onValueChange={(value) => {
                        if (adjustDrag.current) return;
                        setAdjustment((previous) => previous && { ...previous, [key]: value });
                        setError('');
                      }}
                    />
                  </label>
                ))
              ) : editing === 'boolean' ? (
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
                onClick={cancelSketchEdit}
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
          {profile && phase !== 'plane' && !adjusting && (
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
