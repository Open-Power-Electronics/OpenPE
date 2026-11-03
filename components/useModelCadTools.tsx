'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  ArrowUpFromLine,
  Check,
  Circle,
  Combine,
  Copy,
  Cylinder,
  Hand,
  Move3d,
  PencilRuler,
  Pentagon,
  Square,
  Radius,
  CornerDownRight,
  Redo2,
  RotateCw,
  Trash2,
  Undo2,
} from 'lucide-react';
import type { CapabilityHost } from '@/api/capabilities';
import {
  modelCadSelectableEdges,
  newModelCadObject,
  validateModelCadObject,
  type ModelCAD,
  type ModelCadObject,
} from '@/lib/model-cad';
import type { PCB } from '@/lib/pcb';
import {
  modelCadSelectedBodyIds,
  DEFAULT_MODEL_CAD_SELECTION_FILTERS,
  filterModelCadSelection,
  modelCadSelectionEligible,
  modelCadSelectionKey,
  pruneModelCadSelection,
  updateModelCadSelection,
  type ModelCadSelection,
  type ModelCadSelectionFilters,
} from '@/lib/model-cad-selection';
import { modelCadSelectableFaces } from './model-cad-faces';
import Select from './Select';
import ModelCadPanel from './ModelCadPanel';
import ModelCadFeaturePanel, {
  type ModelCadFeatureAction,
  type ModelCadFeatureMode,
} from './ModelCadFeaturePanel';
import ModelCadSketchPanel, {
  type ModelCadSketch,
  type ModelCadSketchInput,
  type ModelCadSketchPlane,
  type ModelCadSketchPhase,
} from './ModelCadSketchPanel';
import styles from './ModelCadTools.module.css';

export type CadHit = { id: string; local: { x: number; y: number; z: number } };
type Tool = 'box' | 'cylinder' | 'move' | ModelCadFeatureMode | null;
const featureTool = (tool: Tool): tool is ModelCadFeatureMode =>
  tool === 'sketch' || tool === 'chamfer' || tool === 'fillet' || tool === 'boolean';
const snap = (n: number) => Math.round(n * 2) / 2;

export function useModelCadTools({
  board,
  modelCad,
  selectionFilters = DEFAULT_MODEL_CAD_SELECTION_FILTERS,
  host,
  revision,
  active,
  disabled,
  annotating,
  undoDepth,
  redoDepth,
  onInteraction,
  onCameraInteraction,
  sidebarVisible = true,
  onShowSidebar,
  onToggleSidebar,
  onReturnCanvasFocus,
  onAlignSketchView,
  onLeaveSketchView,
}: {
  board: PCB;
  modelCad: ModelCAD | null;
  selectionFilters?: Readonly<ModelCadSelectionFilters>;
  host?: CapabilityHost;
  revision: string;
  active: boolean;
  disabled: boolean;
  annotating: boolean;
  undoDepth: number;
  redoDepth: number;
  onInteraction: (selectedId?: string) => void;
  onCameraInteraction: () => void;
  sidebarVisible?: boolean;
  onShowSidebar?: () => void;
  onToggleSidebar?: () => void;
  onReturnCanvasFocus?: () => void;
  onAlignSketchView: (plane: ModelCadSketchPlane, origin: ModelCadSketch['origin']) => void;
  onLeaveSketchView: () => void;
}) {
  const [sketch, setSketch] = useState<ModelCadSketch | null>(null);
  const [sketchPhase, setSketchPhase] = useState<ModelCadSketchPhase>('plane');
  const [sketchShape, setSketchShape] = useState<ModelCadSketch['shape']>('rectangle');
  const [sketchReady, setSketchReady] = useState(false);
  const sketchInput = useRef<ModelCadSketchInput | null>(null);
  const registerSketchInput = useCallback((input: ModelCadSketchInput | null) => {
    sketchInput.current = input;
  }, []);
  const [selection, setSelection] = useState<ModelCadSelection[]>([]);
  const selectionFiltersRef = useRef(selectionFilters);
  selectionFiltersRef.current = selectionFilters;
  const selected = selection.at(-1)?.objectId ?? null;
  const currentSelection = useRef(selected);
  currentSelection.current = selected;
  const [tool, setTool] = useState<Tool>(null);
  const [seed, setSeed] = useState<ModelCadObject | null>(null);
  const [draft, setDraft] = useState<ModelCadObject | null>(null);
  const [featureReplacedIds, setFeatureReplacedIds] = useState<readonly string[]>([]);
  const edgeBase = useRef<ModelCadObject | null>(null);
  const selectedEdges = useMemo(
    () =>
      selection.flatMap((item) =>
        item.objectId === selected && (item.kind === 'edge' || item.kind === 'line')
          ? [item.edgeId]
          : [],
      ),
    [selection, selected],
  );
  const selectedBodyIds = useMemo(() => modelCadSelectedBodyIds(selection), [selection]);
  const solidOperandsOnly = selection.every((item) => item.kind === 'body');
  const booleanOperands = useMemo(
    () => (solidOperandsOnly ? selectedBodyIds : []),
    [solidOperandsOnly, selectedBodyIds],
  );
  const booleanSelectionOwners = useMemo(
    () => [...new Set(selection.map((item) => item.objectId))],
    [selection],
  );
  const singleBody = selection.length === 1 && selection[0].kind === 'body';
  const singleEdgeObject =
    selection.length > 0 &&
    selection.every(
      (item) => (item.kind === 'edge' || item.kind === 'line') && item.objectId === selected,
    );
  function setSelected(id: string | null) {
    setSelection(id && selectionFiltersRef.current.bodies ? [{ kind: 'body', objectId: id }] : []);
  }
  const setSelectedEdges = useCallback(
    (action: string[] | ((previous: string[]) => string[])) => {
      setSelection((previous) => {
        const objectId = edgeBase.current?.id ?? previous.at(-1)?.objectId;
        if (!objectId) return [];
        const previousIds = previous.flatMap((item) =>
          item.objectId === objectId && (item.kind === 'edge' || item.kind === 'line')
            ? [item.edgeId]
            : [],
        );
        const ids = typeof action === 'function' ? action(previousIds) : action;
        const lineIds =
          !selectionFilters.edges && edgeBase.current
            ? new Set(
                modelCadSelectableEdges(edgeBase.current)
                  .filter((edge) => edge.kind === 'line')
                  .map((edge) => edge.id),
              )
            : null;
        const eligibleIds = selectionFilters.edges ? ids : ids.filter((id) => lineIds?.has(id));
        return filterModelCadSelection(
          eligibleIds.length
            ? eligibleIds.map((edgeId) => ({
                kind: selectionFilters.edges ? ('edge' as const) : ('line' as const),
                objectId,
                edgeId,
              }))
            : [{ kind: 'body', objectId }],
          selectionFilters,
        );
      });
    },
    [selectionFilters],
  );
  const currentDraft = useRef<ModelCadObject | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const currentCursor = useRef(cursor);
  const updateCursor = useCallback((next: { x: number; y: number } | null) => {
    if (currentCursor.current?.x === next?.x && currentCursor.current?.y === next?.y) return;
    currentCursor.current = next;
    setCursor(next);
  }, []);
  const updateDraft = useCallback((next: ModelCadObject | null, positionEdited = false) => {
    currentDraft.current = next;
    if (positionEdited) updateCursor(null);
    setDraft(next);
  }, []);
  const updateFeatureDraft = useCallback(
    (next: ModelCadObject | null, replacedIds: readonly string[] = []) => {
      const preview = next ?? edgeBase.current;
      updateDraft(preview);
      setFeatureReplacedIds(preview && edgeBase.current ? [preview.id] : replacedIds);
    },
    [],
  );
  const [rotationRequest, setRotationRequest] = useState<{
    sequence: number;
    degrees: number;
  } | null>(null);
  const [opened, setOpened] = useState(false);
  const [inspectorDirty, setInspectorDirty] = useState(false);
  const inspectorDirtyRef = useRef(inspectorDirty);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [pan, setPan] = useState(false);
  const baseRevision = useRef(revision);
  const object = modelCad?.objects.find((body) => body.id === selected) ?? null;
  const eligibleTreatmentEdges = useMemo(
    () =>
      object
        ? modelCadSelectableEdges(object).filter(
            (edge) => selectionFilters.edges || (selectionFilters.lines && edge.kind === 'line'),
          )
        : [],
    [object, selectionFilters.edges, selectionFilters.lines],
  );
  const staged = Boolean(!tool && object && inspectorDirty);
  const blocked = !host || !active || disabled || busy || annotating;
  const cancel = useCallback(() => {
    sketchInput.current = null;
    setSketch(null);
    setSketchReady(false);
    setFeatureReplacedIds([]);
    if (edgeBase.current) setSelected(edgeBase.current.id);
    edgeBase.current = null;
    setTool(null);
    setSeed(null);
    updateDraft(null);
    updateCursor(null);
    setRotationRequest(null);
    setError('');
    setOpened(Boolean(currentSelection.current));
  }, []);
  useEffect(() => {
    if ((!active || disabled || annotating) && tool) cancel();
    if (annotating) {
      setPan(false);
      setOpened(false);
      setSelected(null);
    }
  }, [active, disabled, annotating, tool, cancel]);
  useEffect(() => {
    if (tool && baseRevision.current !== revision) cancel();
    if (selected && !modelCad?.objects.some((body) => body.id === selected)) {
      setSelected(null);
      setOpened(false);
    }
  }, [revision, modelCad, selected, tool, cancel]);
  useEffect(() => {
    setSelection((previous) =>
      filterModelCadSelection(
        pruneModelCadSelection(
          previous.filter((item) => item.kind === 'body'),
          modelCad?.objects ?? [],
        ),
        selectionFilters,
      ),
    );
  }, [revision]);
  async function execute(id: string, input: unknown, expectedRevision = revision) {
    if (!host) return;
    setBusy(true);
    setError('');
    try {
      return await host.execute(id, input, { actor: 'human', expectedRevision });
    } catch (cause) {
      setError((cause as Error).message);
      throw cause;
    } finally {
      setBusy(false);
    }
  }
  function start(kind: 'box' | 'cylinder') {
    if (blocked || tool === 'sketch') return;
    try {
      const body = newModelCadObject(board, kind);
      onInteraction();
      setPan(false);
      setSelected(null);
      setSelectedEdges([]);
      edgeBase.current = null;
      setSeed(body);
      updateDraft(body);
      setTool(kind);
      setOpened(true);
      updateCursor(null);
      setError('');
      baseRevision.current = revision;
    } catch (cause) {
      setError((cause as Error).message);
    }
  }
  function select(id: string | null, edgeId?: string) {
    const next = filterModelCadSelection(
      id
        ? [
            edgeId
              ? { kind: 'edge' as const, objectId: id, edgeId }
              : { kind: 'body' as const, objectId: id },
          ]
        : [],
      selectionFilters,
    );
    currentSelection.current = next.at(-1)?.objectId ?? null;
    setSelection(next);
    setOpened(next.length > 0);
    setError('');
    if (id && next.length) {
      onInteraction(id);
      onShowSidebar?.();
      setPan(false);
    }
  }
  function selectGeometry(next: ModelCadSelection | null, additive = false) {
    if (!active || annotating || inspectorDirtyRef.current || busy || (tool && tool !== 'boolean'))
      return;
    if (next && !modelCadSelectionEligible(next, selectionFilters)) return;
    try {
      let nextSelection: ModelCadSelection[] | undefined;
      {
        const previous =
          tool === 'boolean' && next?.kind === 'body'
            ? selection.filter((item) => item.kind === 'body')
            : selection;
        if (tool === 'boolean' && next?.kind === 'body') {
          const bodies = modelCadSelectedBodyIds(previous);
          if (!bodies.includes(next.objectId) && bodies.length >= 2)
            nextSelection = [{ kind: 'body' as const, objectId: bodies[0] }, { ...next }];
        }
        nextSelection ??= updateModelCadSelection(previous, next, {
          additive: additive || Boolean(tool === 'boolean' && next),
          toggle: true,
        });
      }
      setSelection(nextSelection);
      setOpened(Boolean(next));
      setError('');
      if (next) {
        onInteraction(next.objectId);
        onShowSidebar?.();
      }
    } catch (cause) {
      setError((cause as Error).message);
    }
  }
  function applySelectionFilters(next: ModelCadSelectionFilters) {
    if (busy || inspectorDirtyRef.current) return false;
    const retained = filterModelCadSelection(selection, next);
    if (tool) cancel();
    setPan(false);
    setSelection(retained);
    setOpened(retained.length > 0);
    return true;
  }
  function startFeature(kind: ModelCadFeatureMode) {
    if (blocked || tool || inspectorDirtyRef.current) return;
    if (
      (kind === 'chamfer' || kind === 'fillet') &&
      (!(selectionFilters.edges || selectionFilters.lines) ||
        !object ||
        (!singleBody && !singleEdgeObject) ||
        !eligibleTreatmentEdges.length)
    )
      return;
    if (kind === 'boolean' && (!selectionFilters.bodies || (modelCad?.objects.length ?? 0) < 2))
      return;
    try {
      const body = kind === 'sketch' ? newModelCadObject(board, 'extrusion') : object;
      onInteraction();
      setPan(false);
      if (kind === 'sketch') {
        setSketchPhase('plane');
        setSketchShape('rectangle');
        setSketchReady(false);
        currentSelection.current = null;
        setSelected(null);
      }
      if ((kind === 'fillet' || kind === 'chamfer') && body) {
        const { edgeTreatment, ...base } = body;
        edgeBase.current = base;
        setSelectedEdges(edgeTreatment ? [...edgeTreatment.edges] : selectedEdges);
      } else {
        edgeBase.current = null;
        if (kind !== 'boolean') setSelection([]);
      }
      setSeed(body);
      updateDraft(edgeBase.current);
      updateCursor(null);
      setTool(kind);
      setOpened(true);
      setError('');
      baseRevision.current = revision;
    } catch (cause) {
      setError((cause as Error).message);
    }
  }
  function move() {
    if (blocked || !object || !singleBody || tool || inspectorDirtyRef.current) return;
    onInteraction();
    setPan(false);
    setSeed(object);
    updateDraft(object);
    setTool('move');
    setOpened(true);
    updateCursor(null);
    setError('');
    baseRevision.current = revision;
  }
  function dismissTool() {
    cancel();
    onReturnCanvasFocus?.();
  }
  const preview = useMemo(
    () =>
      draft &&
      (tool ||
        (!tool &&
          opened &&
          object &&
          draft.id === object.id &&
          JSON.stringify(draft) !== JSON.stringify(object)))
        ? { ...draft, position: cursor ? { ...draft.position, ...cursor } : draft.position }
        : null,
    [draft, tool, opened, object, cursor],
  );
  async function canvasClick(point: { x: number; y: number } | null, snapToGrid = true) {
    if (blocked || !tool || featureTool(tool) || baseRevision.current !== revision) return;
    try {
      if (point && currentDraft.current) {
        const next = validateModelCadObject({
          ...currentDraft.current,
          position: {
            ...currentDraft.current.position,
            x: snapToGrid ? snap(point.x) : point.x,
            y: snapToGrid ? snap(point.y) : point.y,
          },
        });
        await execute(
          tool === 'move' ? 'modelCad.update' : 'modelCad.add',
          { boardId: board.id, object: next },
          baseRevision.current,
        );
        cancel();
        select(next.id);
      }
    } catch (cause) {
      setError((cause as Error).message);
    }
  }
  function canvasMove(point: { x: number; y: number } | null) {
    if (tool === 'sketch' && !blocked) {
      sketchInput.current?.move(point);
      return;
    }
    if (!tool || featureTool(tool) || blocked) return;
    const next = point ? { x: snap(point.x), y: snap(point.y) } : null;
    updateCursor(next);
  }
  async function apply(next: ModelCadObject, expectedRevision: string) {
    await execute('modelCad.update', { boardId: board.id, object: next }, expectedRevision);
    updateDraft(null);
  }
  async function applyFeature(action: ModelCadFeatureAction) {
    if (blocked || !tool || !featureTool(tool) || baseRevision.current !== revision)
      throw new Error('The project changed. Start the operation again.');
    const id =
      action.kind === 'boolean'
        ? action.resultId
        : action.kind === 'sketch'
          ? action.sketch.id
          : action.object.id;
    if (action.kind === 'sketch') {
      await execute(
        'modelCad.sketch.extrude',
        { boardId: board.id, sketch: action.sketch },
        baseRevision.current,
      );
    } else if (action.kind === 'boolean') {
      await execute(
        'modelCad.boolean',
        {
          boardId: board.id,
          operation: action.operation,
          targetId: action.targetId,
          toolId: action.toolId,
          resultId: action.resultId,
        },
        baseRevision.current,
      );
    } else {
      await execute(
        tool === 'sketch' ? 'modelCad.add' : 'modelCad.update',
        { boardId: board.id, object: action.object },
        baseRevision.current,
      );
    }
    cancel();
    select(id);
  }
  async function duplicate() {
    if (!object || !singleBody || blocked || tool || inspectorDirtyRef.current) return;
    const result = (await execute('modelCad.duplicate', {
      boardId: board.id,
      ids: [object.id],
      offset: { x: 5, y: 5, z: 0 },
    })) as { objects: ModelCadObject[] } | undefined;
    if (result?.objects[0]) select(result.objects[0].id);
  }
  async function rotate(degrees = 90) {
    if (!object || !singleBody || blocked || tool || inspectorDirtyRef.current) return;
    await execute('modelCad.update', {
      boardId: board.id,
      object: {
        ...object,
        rotation: {
          ...object.rotation,
          z: ((((object.rotation.z + degrees + 180) % 360) + 360) % 360) - 180,
        },
      },
    });
  }
  async function remove() {
    if (!object || !singleBody || blocked || tool || inspectorDirtyRef.current) return;
    await execute('modelCad.remove', { boardId: board.id, ids: [object.id] });
    cancel();
    select(null);
  }
  const button = (
    label: string,
    Icon: typeof Box,
    action: () => void | Promise<unknown>,
    unavailable = blocked,
    pressed?: boolean,
  ) => (
    <button
      type="button"
      className={`tool-button${pressed ? ' active' : ''}`}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={unavailable}
      onClick={() => {
        void Promise.resolve()
          .then(action)
          .catch(() => {});
      }}
    >
      <Icon size={17} />
    </button>
  );
  const canTreat =
    !blocked &&
    !tool &&
    !staged &&
    (selectionFilters.edges || selectionFilters.lines) &&
    object &&
    (singleBody || singleEdgeObject) &&
    eligibleTreatmentEdges.length > 0;
  const canCombine =
    !blocked && !tool && !staged && selectionFilters.bodies && (modelCad?.objects.length ?? 0) >= 2;
  const featureOptions = [
    ...(canTreat
      ? [
          { value: 'chamfer', label: 'Chamfer edges', icon: <CornerDownRight size={16} /> },
          { value: 'fillet', label: 'Fillet edges', icon: <Radius size={16} /> },
        ]
      : []),
    ...(canCombine
      ? [{ value: 'boolean', label: 'Boolean solids', icon: <Combine size={16} /> }]
      : []),
  ];
  const modifying = tool === 'chamfer' || tool === 'fillet' || tool === 'boolean';
  const canEdit = !blocked && object && singleBody && !tool && !staged;
  const editActions = [
    ...(canEdit
      ? [
          { value: 'move', label: 'Move solid', icon: <Move3d size={16} />, run: move },
          {
            value: 'rotate',
            label: 'Rotate solid 90°',
            icon: <RotateCw size={16} />,
            run: () => rotate(),
          },
          {
            value: 'duplicate',
            label: 'Duplicate solid',
            icon: <Copy size={16} />,
            run: duplicate,
          },
          { value: 'delete', label: 'Delete solid', icon: <Trash2 size={16} />, run: remove },
        ]
      : []),
    {
      value: 'pan',
      label: 'Pan 3D view',
      icon: <Hand size={16} />,
      separatorBefore: Boolean(canEdit),
      run: () => {
        if (!active) return;
        if (tool) cancel();
        onCameraInteraction();
        setPan((value) => !value);
      },
    },
  ];
  const drawingSketch = tool === 'sketch' && sketchPhase === 'sketch';
  const toolbar = (
    <>
      <div className="editor-tool-group" role="group" aria-label="2D drawing" title="2D drawing">
        {drawingSketch ? (
          <>
            {button(
              'Draw rectangle',
              Square,
              () => {
                sketchInput.current?.retainContour();
                setSketchShape('rectangle');
              },
              blocked,
              sketchShape === 'rectangle',
            )}
            {button(
              'Draw circle',
              Circle,
              () => {
                sketchInput.current?.retainContour();
                setSketchShape('circle');
              },
              blocked,
              sketchShape === 'circle',
            )}
            {button(
              'Draw polyline',
              Pentagon,
              () => {
                sketchInput.current?.retainContour();
                setSketchShape('polygon');
              },
              blocked,
              sketchShape === 'polygon',
            )}
            <button
              type="button"
              className={`dialog-button primary ${styles.finishSketch}`}
              disabled={blocked || !sketchReady}
              onClick={() => sketchInput.current?.finish()}
            >
              <Check size={17} aria-hidden />
              Finish sketch
            </button>
          </>
        ) : (
          button(
            'Create sketch',
            PencilRuler,
            () => startFeature('sketch'),
            blocked || Boolean(tool) || staged,
            tool === 'sketch' && sketchPhase === 'plane',
          )
        )}
      </div>
      {!drawingSketch && (
        <div
          className="editor-tool-group"
          role="group"
          aria-label="3D primitives"
          title="3D primitives"
        >
          {button(
            'Place box',
            Box,
            () => start('box'),
            blocked || tool === 'sketch',
            tool === 'box',
          )}
          {button(
            'Place cylinder',
            Cylinder,
            () => start('cylinder'),
            blocked || tool === 'sketch',
            tool === 'cylinder',
          )}
        </div>
      )}
      <div className="editor-tool-group" role="group" aria-label="2D to 3D" title="2D to 3D">
        {button(
          'Extrude sketch',
          ArrowUpFromLine,
          () => {
            if (!blocked && tool === 'sketch' && sketchReady && sketchPhase === 'profile')
              setSketchPhase('extrude');
          },
          blocked || tool !== 'sketch' || !sketchReady || sketchPhase !== 'profile',
          tool === 'sketch' && sketchPhase === 'extrude',
        )}
      </div>
      {!drawingSketch && (
        <div
          className="editor-tool-group"
          role="group"
          aria-label="Solid modifications"
          title="Solid modifications"
        >
          <div className={`tool-menu${modifying ? ' active' : ''}`}>
            <Select
              label="Modify solids"
              value={modifying ? tool : ''}
              icon={<Combine size={17} />}
              compact
              iconOnly
              showChevron={false}
              active={active}
              disabled={!featureOptions.length}
              placeholder={
                tool === 'chamfer'
                  ? 'Chamfer edges'
                  : tool === 'fillet'
                    ? 'Fillet edges'
                    : tool === 'boolean'
                      ? 'Boolean solids'
                      : 'Select geometry to modify'
              }
              options={featureOptions}
              onChange={(value) => {
                if (value === 'chamfer' || value === 'fillet' || value === 'boolean')
                  startFeature(value);
              }}
            />
          </div>
        </div>
      )}
      {tool !== 'sketch' && (
        <div className="editor-tool-group" role="group" aria-label="Edit and history">
          <div className={`tool-menu${pan || tool === 'move' ? ' active' : ''}`}>
            <Select
              label="Edit model"
              value={pan ? 'pan' : tool === 'move' ? 'move' : ''}
              icon={<RotateCw size={17} />}
              compact
              iconOnly
              showChevron={false}
              active={active}
              placeholder={tool === 'move' ? 'Move solid' : 'Edit model'}
              options={editActions}
              onChange={(value) => {
                const action = editActions.find((item) => item.value === value);
                if (action)
                  void Promise.resolve()
                    .then(action.run)
                    .catch(() => {});
              }}
            />
          </div>
          {button(
            'Undo',
            Undo2,
            async () => {
              cancel();
              await execute('history.undo', {});
            },
            blocked || undoDepth === 0,
          )}
          {button(
            'Redo',
            Redo2,
            async () => {
              cancel();
              await execute('history.redo', {});
            },
            blocked || redoDepth === 0,
          )}
        </div>
      )}
    </>
  );
  const panel = (
    <>
      <ModelCadPanel
        object={object}
        mode="edit"
        docked
        visible={active && opened && !tool && singleBody && sidebarVisible}
        disabled={blocked}
        revision={revision}
        onToggleSidebar={onToggleSidebar}
        onClose={() => {
          cancel();
          select(null);
        }}
        onDraftChange={(next, positionEdited) => {
          if (!tool) updateDraft(next, positionEdited);
        }}
        onDirtyChange={(dirty) => {
          inspectorDirtyRef.current = dirty;
          setInspectorDirty(dirty);
        }}
        onApply={apply}
        onRemove={remove}
      />
      {!tool && !singleBody && selection.length > 0 && object && (
        <section
          className="model-properties-content"
          aria-label={
            selection.every((item) => item.kind === 'face')
              ? 'Face properties'
              : selection.every((item) => item.kind === 'line')
                ? 'Line properties'
                : selection.every((item) => item.kind === 'edge')
                  ? 'Edge properties'
                  : 'Selection properties'
          }
          hidden={!sidebarVisible}
        >
          <div className="model-properties-body">
            <h3 className="model-properties-title">Selection</h3>
            <dl className="model-property-list">
              <dt>Solid</dt>
              <dd>{object.name}</dd>
              <dt>Selected entities</dt>
              <dd>{selection.length}</dd>
            </dl>
            <div className="model-properties-model">
              {selection.map((item) => {
                const body = modelCad?.objects.find((body) => body.id === item.objectId);
                if (!body) return null;
                const label =
                  item.kind === 'body'
                    ? body.name
                    : item.kind === 'face'
                      ? modelCadSelectableFaces(body).find((face) => face.id === item.faceId)?.label
                      : modelCadSelectableEdges(body).find((edge) => edge.id === item.edgeId)
                          ?.label;
                return <p key={modelCadSelectionKey(item)}>{label}</p>;
              })}
            </div>
          </div>
        </section>
      )}
    </>
  );
  const placementPanel =
    tool === 'sketch' && seed ? (
      <ModelCadSketchPanel
        board={board}
        seed={seed}
        disabled={blocked}
        revision={revision}
        baseRevision={baseRevision.current}
        onClose={dismissTool}
        onPreview={updateDraft}
        onApply={applyFeature}
        onSketchChange={setSketch}
        onInput={registerSketchInput}
        onAlignView={onAlignSketchView}
        onLeaveView={onLeaveSketchView}
        onReturnCanvasFocus={onReturnCanvasFocus}
        phase={sketchPhase}
        onPhaseChange={setSketchPhase}
        shape={sketchShape}
        onReadyChange={setSketchReady}
      />
    ) : tool && featureTool(tool) && tool !== 'sketch' ? (
      <ModelCadFeaturePanel
        mode={tool}
        object={seed}
        objects={modelCad?.objects ?? []}
        disabled={blocked}
        revision={revision}
        baseRevision={baseRevision.current}
        selectedEdges={selectedEdges}
        onSelectedEdgesChange={setSelectedEdges}
        booleanOperands={booleanOperands}
        booleanSelectionOwners={booleanSelectionOwners}
        onBooleanOperandsChange={(ids) =>
          setSelection(
            filterModelCadSelection(
              ids.map((objectId) => ({ kind: 'body', objectId })),
              selectionFilters,
            ),
          )
        }
        booleanSelectionError={
          !solidOperandsOnly
            ? 'Solid Boolean operations require two solids. Faces, edges and lines are not solid operands.'
            : ''
        }
        onClose={dismissTool}
        onPreview={updateFeatureDraft}
        onApply={applyFeature}
      />
    ) : tool && !featureTool(tool) ? (
      <ModelCadPanel
        object={seed}
        mode={tool}
        visible={active}
        disabled={blocked}
        revision={revision}
        onClose={dismissTool}
        onDraftChange={updateDraft}
        rotationRequest={rotationRequest}
        onApply={apply}
      />
    ) : null;
  return {
    toolbar,
    panel,
    placementPanel,
    inspecting: opened && !tool && Boolean(object),
    preview,
    previewReplacedIds: featureReplacedIds.length
      ? featureReplacedIds
      : preview && object?.id === preview.id
        ? [preview.id]
        : [],
    sketch,
    sketchPhase: tool === 'sketch' ? sketchPhase : null,
    sketchInput,
    selection,
    selectGeometry,
    selectedBodyIds,
    applySelectionFilters,
    selectionBlocked: busy || inspectorDirty,
    edgeSelection:
      (tool === 'fillet' || tool === 'chamfer') && edgeBase.current
        ? { object: edgeBase.current, ids: selectedEdges }
        : !tool &&
            (selectionFilters.edges || selectionFilters.lines) &&
            !inspectorDirty &&
            object &&
            !object.edgeTreatment &&
            modelCadSelectableEdges(object).length
          ? { object, ids: selectedEdges }
          : null,
    toggleEdge: (id: string | null, additive = true) => {
      const base = edgeBase.current ?? (!tool && !object?.edgeTreatment ? object : null);
      if (
        !id ||
        blocked ||
        inspectorDirtyRef.current ||
        (tool &&
          (baseRevision.current !== revision || (tool !== 'fillet' && tool !== 'chamfer'))) ||
        !base ||
        !modelCadSelectableEdges(base).some((edge) => edge.id === id)
      )
        return;
      if (!tool) {
        selectGeometry(
          {
            kind: selectionFilters.edges ? 'edge' : 'line',
            objectId: base.id,
            edgeId: id,
          },
          additive,
        );
        return;
      }
      setSelectedEdges((previous) =>
        !additive
          ? [id]
          : previous.includes(id)
            ? previous.filter((edge) => edge !== id)
            : [...previous, id],
      );
    },
    selected,
    select,
    tool,
    pan,
    cancel,
    canvasMove,
    canvasClick,
    error: error && (
      <div className={styles.notice} role="alert">
        {error}
      </div>
    ),
    clear: () => {
      cancel();
      select(null);
      setPan(false);
    },
    keyDown: (event: React.KeyboardEvent) => {
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return false;
      if (event.key === 'Escape') {
        if (busy) return true;
        if (tool === 'sketch') {
          if (sketchInput.current?.keyDown(event.key)) return true;
          if (sketchPhase === 'extrude') {
            setSketchPhase('profile');
            return true;
          }
        }
        const moving = Boolean(tool);
        cancel();
        if (!moving) select(null);
        else setOpened(Boolean(object));
        setPan(false);
        return true;
      }
      if (event.altKey || event.ctrlKey || event.metaKey || event.repeat || blocked) return false;
      const key = event.key.toLowerCase();
      const stagedInspector = inspectorDirtyRef.current;
      if (
        !tool &&
        !singleBody &&
        selection.length > 0 &&
        (key === 'm' || key === 'r' || event.key === 'Delete' || event.key === 'Backspace')
      )
        return true;
      if (tool === 'sketch' && sketchInput.current?.keyDown(event.key)) return true;
      if (key === 'r' && tool && !featureTool(tool)) {
        if (currentDraft.current && baseRevision.current === revision)
          setRotationRequest((previous) => ({
            sequence: (previous?.sequence ?? 0) + 1,
            degrees: (previous?.degrees ?? 0) + (event.shiftKey ? -90 : 90),
          }));
        return true;
      }
      if (key === 'm' && !event.shiftKey && object && !tool && !stagedInspector) {
        move();
        return true;
      }
      if (key === 'r' && object && !tool && !stagedInspector) {
        void rotate(event.shiftKey ? -90 : 90).catch(() => {});
        return true;
      }
      if (event.key === 'Enter' && tool && !featureTool(tool)) {
        if (currentDraft.current)
          void canvasClick(currentCursor.current ?? currentDraft.current.position, false);
        return true;
      }
      if (
        (event.key === 'Delete' || event.key === 'Backspace') &&
        object &&
        !tool &&
        !blocked &&
        !stagedInspector
      ) {
        void remove().catch(() => {});
        return true;
      }
      return false;
    },
  };
}
