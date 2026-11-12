'use client';
import CanvasContextMenu, { type CanvasMenuAction } from './CanvasContextMenu';
import { createPortal } from 'react-dom';
import ComponentProperties, { type ComponentPropertiesProps } from './ComponentProperties';
import { previewAssignedModel } from '@/lib/pcb-preview-cache';
import PropertiesEmptyState from './PropertiesEmptyState';
import PropertyDeleteButton from './PropertyDeleteButton';
import { PropertyActionRow } from './PropertyTabs';
import { NumberField } from './LayoutPropertyFields';
import { modelReferenceKey } from '@/lib/example-model-paths';
import {
  memo,
  cloneElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
  type ReactElement,
  type ReactNode,
} from 'react';
import {
  Maximize,
  ImageDown,
  MousePointer2,
  MessageSquareText,
  Box,
  Minus,
  Plus,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { PCB } from '@/lib/pcb';
import type { Circuit } from '@/lib/circuit';
import type { CapabilityHost } from '@/api/capabilities';
import InspectorResize, { type InspectorSize } from './InspectorResize';
import {
  modelCadColor,
  modelCadMaterialColors,
  modelCadSelectableEdges,
  type ModelCAD,
} from '@/lib/model-cad';
import {
  applyModelBoardDisplay,
  componentModelEstimateColor,
  createModelBoardDisplayGroups,
  createModelSolderMaskSurface,
  defaultModelBoardDisplay,
  modelBoardDisplayColors,
  type ModelBoardDisplay,
} from '@/lib/model-board-display';
import { createModelCadScene } from './model-cad-scene';
import { createModelCadOperandGhosts } from './model-cad-operand-ghosts';
import {
  createModelCadFaceHighlight,
  disposeModelCadFaceHighlight,
  modelCadFaceAtPoint,
} from './model-cad-faces';
import {
  DEFAULT_MODEL_CAD_SELECTION_FILTERS,
  modelCadSelectionModeAvailable,
  type ModelCadSelection,
  type ModelCadSelectionFilters,
} from '@/lib/model-cad-selection';
import {
  createModelCadEdgeHighlight,
  disposeModelCadEdgeHighlight,
  pickModelCadEdge,
} from './model-cad-edges';
import { createModelCadSketchScene, modelCadSketchFrame } from './model-cad-sketch-scene';
import { createModelGroundScene } from './model-ground-scene';
import ModelSpatialScale, { modelScaleAxes } from './ModelSpatialScale';
import type { ModelCadSketch, ModelCadSketchPlane } from './ModelCadSketchPanel';
import { useModelCadTools, type CadHit } from './useModelCadTools';
import { pcbSilkscreen } from '@/lib/pcb-silkscreen';
import { pcbStrokeText } from '@/lib/pcb-stroke-text';
import { solderMaskOpenings } from '@/lib/pcb-solder-mask';
import { saveDrawingPNG } from '@/lib/drawing-export';
import { previewFootprint, previewModel, type PreviewFootprint } from '@/lib/pcb-preview-cache';
import { modelPlacement, resolveFootprintModels } from '@/lib/pcb-models';
import { pcbBounds, footprintPoint, padDrillPosition, createEmptyPCB } from '@/lib/pcb-layout';
import { padCopperLayers } from '@/lib/pcb-connectivity';
import { copperFillOpacity } from '@/lib/pcb-display';
import {
  modelBoardPolygons,
  circlePolygon,
  filledCopperPolygons,
  graphicPolygons,
  padPolygon,
  strokePolygon,
  subtractPolygons,
  intersectPolygons,
  type Polygon,
} from '@/lib/pcb-polygons';
import { cloneModelInstance, disposeModelGroup, modelMeshGroupAsync } from '@/lib/model-mesh';
import { createModelSelection } from '@/lib/model-selection';
import { modelPickResult, type ModelPickOptions, type ModelPickResult } from '@/lib/model-picking';
import { modelVisibleBounds } from '@/lib/model-visible-bounds';
import {
  createModelExplodedView,
  defaultModelExplodedView,
  type ModelExplodedView,
} from '@/lib/model-exploded-view';
import { modelCameraClipping } from '@/lib/model-camera-clipping';
import { prepareModelShaders } from '@/lib/model-shader-warmup';
import { applySelection, selectionMode } from '@/lib/schematic-selection';
import useCanvasBrightness from './useCanvasBrightness';
import { hasOpenOverlay } from './Dialog';
import { pcbObjectViewFingerprint } from '@/lib/pcb-annotations';
import {
  captureObjectAnnotationImage,
  type captureAnnotationImage,
} from '@/lib/annotation-screenshot';
import PCB3DAnnotations, {
  type ObjectAnnotationProps,
  type ObjectAnnotationView,
} from './PCB3DAnnotations';
import { createModelAnnotationOutline } from './model-annotation-outline';
import { createModelStudioRenderer, MODEL_RENDER_SAMPLES } from './model-studio-renderer';
import EditorDisplayDrawer from './EditorDisplayDrawer';
import ModelDisplayPanel, { type ModelView } from './ModelDisplayPanel';
import { ModelMeasurementDrawing } from './CanvasMeasurement';
import {
  createCanvasMeasurement,
  type CanvasMeasurement,
  type MeasurementPoint,
} from '@/lib/canvas-measurement';
import { modelMeasurementPoint } from '@/lib/model-measurement';
import type { ModelSketchPointer } from './ModelSketchCoordinates';
import type { ModelCheckIssue, ModelCheckReport, ModelCheckFocus } from './model-checks';
import { isCommandModifier } from '@/lib/command-modifier';

const modelSilkscreenGeometryLimit = 8192;

function shape(p: Polygon) {
  const outline = new THREE.Shape(p.outer.map((v) => new THREE.Vector2(v.x, -v.y)));
  outline.holes = p.holes.map(
    (hole) => new THREE.Path(hole.map((v) => new THREE.Vector2(v.x, -v.y))),
  );
  return outline;
}
const modelKey = modelReferenceKey;
const pixelsPerMM = 96 / 25.4;
const componentLoadingStatus = 'Loading component models…';
type ModelLoadingProgress = { completed: number; total: number; reference: string };

function ModelLoadingStatus({
  progress,
  update,
  waitingForRender = false,
}: {
  progress: RefObject<ModelLoadingProgress>;
  update: RefObject<(value: ModelLoadingProgress) => void>;
  waitingForRender?: boolean;
}) {
  const [value, setValue] = useState(progress.current);
  useLayoutEffect(() => {
    update.current = setValue;
    return () => {
      update.current = () => {};
    };
  }, [update]);
  return (
    <span
      role="status"
      className="pcb-model-status"
      data-model-render-status={waitingForRender || undefined}
    >
      {waitingForRender ? 'Waiting for model import · components' : 'Loading components'} ·{' '}
      {value.completed}/{value.total}
      {value.reference && ` · ${value.reference}`}
    </span>
  );
}
/** Board lacquer/text must composite before transparent assembly surfaces.
 * Nested Groups reset Three's inherited group order, so retain one shared
 * assembly layer throughout each loaded instance and let depth sort within it.
 */
function orderAssembly(root: THREE.Object3D) {
  root.traverse((object) => {
    if (object instanceof THREE.Group) object.renderOrder = 3;
  });
}
export type PCB3DViewState = {
  boardId: string;
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  zoom: number;
  extent: number;
  orthographic?: boolean;
  modelsVisible: boolean;
  boardDisplay: ModelBoardDisplay;
  referencePlaneVisible?: boolean;
  cadVisible?: boolean;
};

// Memoized views can retain effects across a hot update. Rebind native callbacks
// to this implementation without adding hooks or retaining closed view refs.
const modelViewImplementations = new WeakMap<RefObject<PCB3DViewState | null>, object>();
const defaultModelViewImplementation = {};
function modelViewImplementation(viewState?: RefObject<PCB3DViewState | null>) {
  if (!viewState) return defaultModelViewImplementation;
  let implementation = modelViewImplementations.get(viewState);
  if (!implementation) {
    implementation = {};
    modelViewImplementations.set(viewState, implementation);
  }
  return implementation;
}

function PCBModelPreview({
  board: latestBoard,
  viewState,
  schematic: latestSchematic,
  active = true,
  readOnly = false,
  grid = true,
  gridSpacing = 5,
  annotationProps,
  errorTarget,
  statusBar,
  rulePanel,
  fileId,
  projectSource,
  getRevision,
  spiceAvailable,
  onSavePartProperties,
  onFootprintChange,
  onRequestSave,
  onBoardThicknessChange,
  onModeChange,
  onSketchPointerChange,
  onEditingDraftChange,
  distanceMeasurement,
  capabilityHost,
  revision = '',
  sourcePending = false,
  modelCad: latestModelCad = null,
  undoDepth = 0,
  redoDepth = 0,
  sidebarVisible = true,
  onShowSidebar,
  onToggleSidebar,
  onModelChecksChange,
  modelCheckFocus,
}: {
  board: PCB;
  fileId?: string;
  projectSource?: string;
  getRevision?: () => number;
  spiceAvailable?: boolean;
  onSavePartProperties?: ComponentPropertiesProps['onSavePartProperties'];
  onFootprintChange?: (board: PCB, footprint: PCB['footprints'][number]) => boolean;
  onRequestSave?: (saveAs: boolean) => void;
  onBoardThicknessChange?: (board: PCB, thickness: number) => boolean;
  onModeChange?: (mode: string) => void;
  onSketchPointerChange?: (pointer: ModelSketchPointer | null) => void;
  onEditingDraftChange?: (blocked: boolean) => void;
  distanceMeasurement?: CanvasMeasurement;
  schematic?: Circuit;
  viewState?: RefObject<PCB3DViewState | null>;
  active?: boolean;
  /** Render navigation and scene feedback without design-edit affordances. */
  readOnly?: boolean;
  grid?: boolean;
  gridSpacing?: number;
  /** Visibility is independent of temporary modal/interaction suspension. */
  visible?: boolean;
  annotationProps?: ObjectAnnotationProps;
  errorTarget: HTMLElement | null;
  statusBar?: ReactElement<{ center?: ReactNode }> | null;
  rulePanel?: ReactNode;
  capabilityHost?: CapabilityHost;
  revision?: string;
  sourcePending?: boolean;
  modelCad?: ModelCAD | null;
  undoDepth?: number;
  redoDepth?: number;
  sidebarVisible?: boolean;
  onShowSidebar?: () => void;
  onToggleSidebar?: () => void;
  onModelChecksChange?: (report: ModelCheckReport) => void;
  modelCheckFocus?: ModelCheckFocus | null;
}) {
  const sceneImplementation = modelViewImplementation(viewState);
  const gridOptions = useRef({ visible: grid, spacing: gridSpacing });
  gridOptions.current = { visible: grid, spacing: gridSpacing };
  // Layout may emit many edits while Model is hidden. Build only the latest
  // snapshot on return, retaining the previous scene in the meantime.
  const [snapshot, setSnapshot] = useState({
    board: latestBoard,
    schematic: latestSchematic,
    modelCad: latestModelCad,
  });
  if (
    active &&
    (snapshot.board !== latestBoard ||
      snapshot.schematic !== latestSchematic ||
      snapshot.modelCad !== latestModelCad)
  )
    setSnapshot({
      board: latestBoard,
      schematic: latestSchematic,
      modelCad: latestModelCad,
    });
  const { board, schematic, modelCad } = snapshot;
  const schematicRef = useRef(schematic);
  schematicRef.current = schematic;
  // Board captions use linked reference/value text, not schematic poses or wires.
  const linkedCaptionBasis = useMemo(() => {
    const parts = new Map(schematic?.parts.map((part) => [part.id, part]));
    return JSON.stringify(
      board.footprints.map((footprint) => {
        const part = footprint.symbolId ? parts.get(footprint.symbolId) : undefined;
        return [part?.ref ?? footprint.reference ?? '', part?.value ?? footprint.value ?? ''];
      }),
    );
  }, [board.footprints, schematic?.parts]);
  const [selectionFilters, setSelectionFilters] = useState<ModelCadSelectionFilters>(() => ({
    ...DEFAULT_MODEL_CAD_SELECTION_FILTERS,
  }));
  const propertiesDock = useRef<HTMLElement>(null);
  const [inspectorSize, setInspectorSize] = useState<InspectorSize>({});
  const [propertiesExpanded, setPropertiesExpanded] = useState(true);
  const [componentDeleteBusy, setComponentDeleteBusy] = useState(false);
  const [componentDeleteError, setComponentDeleteError] = useState('');
  const componentComposition = useRef(false);
  function showProperties() {
    setPropertiesExpanded(true);
    onShowSidebar?.();
  }
  const activeRef = useRef(active);
  activeRef.current = active;
  const updateActivity = useRef(() => {});
  const resumeLoading = useRef(() => {});
  const host = useRef<HTMLDivElement>(null),
    fit = useRef(() => {});
  const locateFootprint = useRef<(_: string) => void>(() => {});
  const issueComposition = useRef(false);
  function previewNavigationBlocked() {
    const element = host.current;
    return (
      !element ||
      Array.from(
        element.ownerDocument.querySelectorAll('dialog[open], [role="listbox"], [role="menu"]'),
      ).some((overlay) => !overlay.contains(element))
    );
  }
  const surface = useRef<HTMLElement>(null);
  const darkCanvas = useCanvasBrightness(surface);
  const [selection, setSelection] = useState<string[]>([]);
  useEffect(() => setComponentDeleteError(''), [selection]);
  const [boardSelected, setBoardSelected] = useState(false);
  useEffect(() => setBoardSelected(false), [board.id]);
  const selectionRef = useRef({ ids: selection, dark: darkCanvas });
  selectionRef.current = { ids: selection, dark: darkCanvas };
  const highlightModels = useRef(() => {});
  const selectionPointer = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(
    null,
  );
  const pressedPointers = useRef(new Set<number>());
  const placementPointer = useRef<{ clientX: number; clientY: number } | null>(null);
  useEffect(() => {
    if (readOnly) return;
    const release = (event: PointerEvent) => pressedPointers.current.delete(event.pointerId);
    const clear = () => pressedPointers.current.clear();
    // A disabled orbit control does not capture placement clicks. Releasing
    // outside the canvas must still unblock the next keyboard operation.
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      window.removeEventListener('blur', clear);
    };
  }, [readOnly]);
  const [status, setStatus] = useState('Loading 3D board…');
  const loadingProgress = useRef<ModelLoadingProgress>({ completed: 0, total: 0, reference: '' });
  const updateLoadingProgress = useRef<(value: ModelLoadingProgress) => void>(() => {});
  const [cadGeometryErrors, setCadGeometryErrors] = useState({ document: '', preview: '' });
  const [failed, setFailed] = useState(false);
  const [warnings, setWarnings] = useState<ModelCheckIssue[]>([]);
  const completedCheckBasis = useRef<{ board: PCB; schematic?: Circuit } | null>(null);
  const [retry, setRetry] = useState(0);
  const modelCheckIssues = useMemo(() => {
    const issues = [...warnings];
    if (failed) issues.push({ message: status, severity: 'error' });
    for (const message of [cadGeometryErrors.document, cadGeometryErrors.preview])
      if (message) issues.push({ message, severity: 'error' });
    return issues;
  }, [warnings, failed, status, cadGeometryErrors.document, cadGeometryErrors.preview]);
  const modelErrorCount = modelCheckIssues.filter((issue) => issue.severity === 'error').length;
  const modelWarningCount = modelCheckIssues.filter((issue) => issue.severity === 'warning').length;
  const [modelsVisible, setModelsVisible] = useState(viewState?.current?.modelsVisible ?? true);
  const [exploded, setExploded] = useState<ModelExplodedView>(() => ({
    ...defaultModelExplodedView,
  }));
  const explosionActive = exploded.distance > 0;
  const explodedRef = useRef(exploded);
  explodedRef.current = exploded;
  const applyExploded = useRef(() => {});
  const modelsSelectable = !readOnly && selectionFilters.bodies;
  const modelsSelectableRef = useRef(modelsSelectable);
  modelsSelectableRef.current = modelsSelectable;
  const [boardDisplay, setBoardDisplay] = useState<ModelBoardDisplay>(() =>
    viewState?.current ? { ...viewState.current.boardDisplay } : defaultModelBoardDisplay(),
  );
  const [referencePlaneVisible, setReferencePlaneVisible] = useState(
    viewState?.current?.referencePlaneVisible ?? true,
  );
  const referencePlaneVisibleRef = useRef(referencePlaneVisible);
  referencePlaneVisibleRef.current = referencePlaneVisible;
  const cadColors = useMemo(
    () =>
      modelCad?.objects.length
        ? [...new Set(modelCad.objects.map(modelCadColor))].slice(0, 8)
        : Object.values(modelCadMaterialColors),
    [modelCad],
  );
  const [exporting, setExporting] = useState(false);
  const [ready, setReady] = useState(false);
  const zoom = useRef((_: number | null) => {});
  const [orthographic, setOrthographic] = useState(viewState?.current?.orthographic ?? true);
  const orthographicRef = useRef(orthographic);
  orthographicRef.current = orthographic;
  const applyProjection = useRef(() => {});
  const [renderEnabled, setRenderEnabled] = useState(false);
  const [renderLoading, setRenderLoading] = useState(false);
  const [renderImportStatus, setRenderImportStatus] = useState<
    '' | 'components' | 'cad' | 'component-error' | 'cad-error'
  >('');
  const [renderError, setRenderError] = useState('');
  const [renderProgress, setRenderProgress] = useState({ samples: 0, target: 0 });
  const renderEnabledRef = useRef(renderEnabled);
  renderEnabledRef.current = renderEnabled;
  const applyRenderMode = useRef(() => {});
  const [annotating, setAnnotating] = useState(false);
  const [annotationsOpened, setAnnotationsOpened] = useState(false);
  const annotatingRef = useRef(false);
  annotatingRef.current = annotating;
  const [annotationView, setAnnotationView] = useState<ObjectAnnotationView>({
    basis: '0:0:0',
    ratio: 1,
    elements: [],
  });
  const updateAnnotationView = useRef(() => {});
  const pickAnnotation = useRef<(point: { x: number; y: number }) => string | null>(() => null);
  const captureAnnotation = useRef<typeof captureAnnotationImage>(async () => {
    throw new Error('The 3D preview is not ready.');
  });
  const [exportStatus, setExportStatus] = useState('');
  const displayRef = useRef(boardDisplay);
  displayRef.current = boardDisplay;
  const redraw = useRef(() => {});
  const applyDisplay = useRef(() => {});
  const exportPNG = useRef<() => Promise<void>>(async () => {});
  const modelsVisibleRef = useRef(modelsVisible);
  modelsVisibleRef.current = modelsVisible;
  const models = useRef(new THREE.Group());
  const orient = useRef((_: ModelView) => {});
  const alignSketchView = useRef(
    (_plane: ModelCadSketchPlane, _origin: ModelCadSketch['origin']) => {},
  );
  const leaveSketchView = useRef(() => {});
  const onAlignSketchView = useCallback(
    (plane: ModelCadSketchPlane, origin: ModelCadSketch['origin']) =>
      alignSketchView.current(plane, origin),
    [],
  );
  const onLeaveSketchView = useCallback(() => leaveSketchView.current(), []);
  const [cadVisible, setCadVisible] = useState(viewState?.current?.cadVisible ?? true);
  const [ownMeasurement] = useState(createCanvasMeasurement);
  const measurement = readOnly ? ownMeasurement : (distanceMeasurement ?? ownMeasurement);
  const [measuring, setMeasuring] = useState(false);
  const measuringRef = useRef(measuring);
  measuringRef.current = measuring;
  const measurementPointer = useRef<{ x: number; y: number; snap: boolean } | null>(null);
  const measurePoint = useRef<
    (_: { x: number; y: number }, snap?: boolean) => MeasurementPoint | null
  >(() => null);
  const projectMeasurement = useRef<(_: MeasurementPoint) => { x: number; y: number } | null>(
    () => null,
  );
  const redrawMeasurement = useRef(() => {});
  const measurementScale = useRef<() => number>(() => 1);
  const updateScale = useRef(() => {});
  const readScale = useRef(() => ({
    spacing: 1,
    axes: [
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 0, y: -1 },
    ],
  }));
  const closeMeasurement = useCallback(() => {
    measurement.clear();
    measurementPointer.current = null;
    setMeasuring(false);
    if (activeRef.current) host.current?.focus({ preventScroll: true });
  }, [measurement]);
  useEffect(() => {
    measurement.clear();
    if (!active) setMeasuring(false);
  }, [
    active,
    board,
    modelCad,
    boardDisplay,
    referencePlaneVisible,
    modelsVisible,
    cadVisible,
    measurement,
  ]);
  const cadSelectable = !readOnly && modelCadSelectionModeAvailable('auto', selectionFilters);
  const cad = useModelCadTools({
    board: latestBoard,
    modelCad: latestModelCad,
    selectionFilters,
    host: readOnly ? undefined : capabilityHost,
    revision,
    active: active && !readOnly,
    disabled: sourcePending || !ready || failed,
    annotating,
    undoDepth,
    redoDepth,
    sidebarVisible,
    onShowSidebar: showProperties,
    onToggleSidebar,
    onReturnCanvasFocus: () => {
      if (activeRef.current && !hasOpenOverlay()) host.current?.focus({ preventScroll: true });
    },
    onInteraction: (selectedId) => {
      setAnnotating(false);
      setMeasuring(false);
      if (selectedId) {
        setSelection([]);
        setBoardSelected(false);
      }
    },
    onCameraInteraction: () => {
      setAnnotating(false);
      setMeasuring(false);
    },
    onAlignSketchView,
    onLeaveSketchView,
    measuring,
    onMeasure: toggleMeasurement,
    viewOnly: readOnly || explosionActive,
  });
  const editingDraftBlocked = Boolean(cad.tool) || cad.selectionBlocked;
  useLayoutEffect(() => {
    onEditingDraftChange?.(editingDraftBlocked);
  }, [editingDraftBlocked, onEditingDraftChange]);
  useLayoutEffect(() => () => onEditingDraftChange?.(false), [onEditingDraftChange]);
  function toggleMeasurement(): void {
    if (readOnly || !ready || failed || cad.selectionBlocked || cad.tool) return;
    if (measuring) closeMeasurement();
    else {
      cad.clear();
      setAnnotating(false);
      measurement.clear();
      setMeasuring(true);
      host.current?.focus({ preventScroll: true });
    }
  }
  const cadRef = useRef(cad);
  cadRef.current = cad;
  useEffect(() => {
    if (cad.tool || cad.preview || cad.selectionBlocked) setRenderEnabled(false);
  }, [cad.tool, cad.preview, cad.selectionBlocked]);
  useEffect(() => {
    if (!readOnly) return;
    setSelection([]);
    setBoardSelected(false);
    setAnnotating(false);
    setAnnotationsOpened(false);
    setMeasuring(false);
    selectionPointer.current = null;
    pressedPointers.current.clear();
    placementPointer.current = null;
  }, [readOnly]);
  useEffect(() => {
    if (cad.tool || cad.pan || annotating) setMeasuring(false);
    if (!measuring) measurement.clear();
    updateActivity.current();
  }, [measuring, cad.tool, cad.pan, annotating, measurement]);
  const sketchNormalAxis =
    cad.sketch?.plane === 'XY' ? 'z' : cad.sketch?.plane === 'XZ' ? 'y' : 'x';
  const sketchPlanePosition = cad.sketch
    ? `${cad.sketch.plane} plane · ${sketchNormalAxis.toUpperCase()} = ${cad.sketch.origin[sketchNormalAxis]} mm`
    : 'Set sketch plane position';
  const mode = measuring
    ? 'Measure distance'
    : annotating
      ? 'Annotation mode'
      : cad.pan
        ? 'Pan'
        : cad.tool
          ? {
              box: 'Place box',
              cylinder: 'Place cylinder',
              move: 'Move selection',
              sketch:
                cad.sketchPhase === 'plane'
                  ? sketchPlanePosition
                  : cad.sketchPhase === 'profile'
                    ? 'Sketch profile'
                    : cad.sketchPhase === 'extrude'
                      ? 'Extrude sketch'
                      : 'Draw sketch',
              chamfer: 'Chamfer edges',
              fillet: 'Fillet edges',
              boolean: 'Boolean operation',
            }[cad.tool]
          : 'Interaction mode';
  useLayoutEffect(() => {
    if (active && !readOnly) onModeChange?.(mode);
  }, [active, readOnly, mode, onModeChange]);
  useLayoutEffect(() => {
    if (readOnly) return;
    onSketchPointerChange?.(
      active && cad.sketchPhase === 'sketch' && cad.sketch
        ? { plane: cad.sketch.plane, cursor: cad.sketch.cursor }
        : null,
    );
  }, [
    active,
    readOnly,
    cad.sketchPhase,
    cad.sketch?.plane,
    cad.sketch?.cursor,
    onSketchPointerChange,
  ]);
  useEffect(
    () => () => {
      if (!readOnly) onSketchPointerChange?.(null);
    },
    [readOnly, onSketchPointerChange],
  );
  const cadState = useRef({
    modelCad,
    preview: cad.preview,
    sketch: cad.sketch,
    previewReplacedIds: cad.previewReplacedIds,
    edgeSelection: cad.edgeSelection,
    selected: cad.selected,
    selection: cad.selection,
    selectedBodyIds: cad.selectedBodyIds,
    selectionFilters,
    booleanActive: cad.tool === 'boolean',
    darkCanvas,
    cadVisible,
    cadSelectable,
  });
  cadState.current = {
    modelCad,
    preview: cad.preview,
    sketch: cad.sketch,
    previewReplacedIds: cad.previewReplacedIds,
    edgeSelection: cad.edgeSelection,
    selected: cad.selected,
    selection: cad.selection,
    selectedBodyIds: cad.selectedBodyIds,
    selectionFilters,
    booleanActive: cad.tool === 'boolean',
    darkCanvas,
    cadVisible,
    cadSelectable,
  };
  function changeModelFilters(next: ModelCadSelectionFilters) {
    if (cad.selectionBlocked) return;
    if (
      next.bodies === selectionFilters.bodies &&
      next.faces === selectionFilters.faces &&
      next.edges === selectionFilters.edges &&
      next.lines === selectionFilters.lines
    )
      return;
    selectionPointer.current = null;
    pressedPointers.current.clear();
    placementPointer.current = null;
    if (!cad.applySelectionFilters(next)) return;
    if (!next.bodies) {
      setBoardSelected(false);
      setSelection([]);
    }
    setSelectionFilters(next);
  }
  const updateCad = useRef(() => {}),
    updateCadPreview = useRef(() => {}),
    updateCadSketch = useRef(() => {}),
    updateCadEdges = useRef(() => {}),
    retryCadGeometry = useRef(() => {}),
    paintCad = useRef(() => {});
  const pickCad = useRef<(_: { x: number; y: number }) => CadHit | null>(() => null);
  const pickCadEdge = useRef<(_: { x: number; y: number }, objectId?: string) => string | null>(
    () => null,
  );
  const pickUnselectedCadEdge = useRef<
    (_: { x: number; y: number }) => { id: string; edgeId: string } | null
  >(() => null);
  const clippingBoundsDirty = useRef(true);
  useLayoutEffect(() => {
    measurement.clear();
    applyExploded.current();
  }, [exploded, measurement]);
  const pickInteraction = useRef<(_: { x: number; y: number }) => ModelPickResult>(() => ({
    cad: null,
    footprint: null,
    board: false,
  }));
  const cadPoint = useRef<(_: { x: number; y: number }) => { x: number; y: number } | null>(
    () => null,
  );
  useEffect(() => {
    if (!active) return;
    clippingBoundsDirty.current = true;
    updateCad.current();
  }, [modelCad, cadVisible, active]);
  useEffect(() => {
    clippingBoundsDirty.current = true;
    updateCadPreview.current();
  }, [cad.preview]);
  useEffect(() => {
    updateCadSketch.current();
  }, [cad.sketch, darkCanvas, grid, gridSpacing]);
  useEffect(() => {
    updateCadEdges.current();
  }, [cad.edgeSelection?.object, cad.edgeSelection?.ids, cad.selection, cadVisible, darkCanvas]);
  useLayoutEffect(() => {
    paintCad.current();
  }, [cad.selected, cad.selection, darkCanvas]);
  useEffect(() => {
    updateActivity.current();
    if (cad.tool && active) {
      setCadVisible(true);
      host.current?.focus({ preventScroll: true });
    }
  }, [cad.tool, cad.sketchPhase, cad.pan, active]);
  useLayoutEffect(() => {
    for (const pointer of pressedPointers.current)
      if (host.current?.hasPointerCapture(pointer)) host.current.releasePointerCapture(pointer);
    pressedPointers.current.clear();
    selectionPointer.current = null;
    placementPointer.current = null;
  }, [cad.sketchPhase]);
  useLayoutEffect(() => {
    highlightModels.current();
  }, [selection, darkCanvas]);
  useEffect(() => {
    selectionPointer.current = null;
    pressedPointers.current.clear();
    placementPointer.current = null;
    if (!modelsSelectable || !modelsVisible) setSelection([]);
  }, [active, annotating, modelsSelectable, modelsVisible, cadSelectable, cadVisible]);
  useEffect(() => {
    setSelection([]);
  }, [board]);
  useEffect(() => {
    updateActivity.current();
    if (active) resumeLoading.current();
  }, [active]);
  useEffect(() => {
    clippingBoundsDirty.current = true;
    models.current.visible = modelsVisible;
    redraw.current();
  }, [modelsVisible]);
  useEffect(() => {
    applyDisplay.current();
    if (!Object.values(boardDisplay).some(Boolean)) setBoardSelected(false);
  }, [boardDisplay, referencePlaneVisible]);
  useEffect(() => {
    applyProjection.current();
  }, [orthographic]);
  useEffect(() => {
    applyRenderMode.current();
  }, [renderEnabled, active]);
  useEffect(() => {
    updateActivity.current();
    if (annotating) updateAnnotationView.current();
  }, [annotating]);
  useEffect(() => {
    updateAnnotationView.current();
  }, [modelsSelectable]);
  useEffect(() => {
    const control = new AbortController(),
      group = new THREE.Group();
    let renderer: THREE.WebGLRenderer | undefined,
      orbit: OrbitControls | undefined,
      observer: ResizeObserver | undefined;
    let rendererDisposed = false;
    const annotationOutline = createModelAnnotationOutline();
    let studio: ReturnType<typeof createModelStudioRenderer> | undefined;
    let studioPreparing = false;
    let studioComplete = false;
    let renderEpoch = 0;
    let componentsSettled = false;
    let componentImportFailed = false;
    let cadImportError = '';
    let updatingCad = false;
    let modelImportUpdate = false;
    let syncRenderImports = () => {};
    // Publishing the meshes an export is already waiting for is not a camera
    // or document edit. Other redraws still cancel an in-flight export.
    const publishModelImport = (update: () => void) => {
      const previous = modelImportUpdate;
      modelImportUpdate = true;
      try {
        update();
      } finally {
        modelImportUpdate = previous;
      }
    };
    const disposeRenderer = () => {
      if (!renderer || rendererDisposed) return;
      rendererDisposed = true;
      studio?.dispose();
      studio = undefined;
      annotationOutline.dispose();
      renderer.dispose();
    };
    const cache = new Map<string, Promise<THREE.Group>>();
    const templates = new Set<THREE.Group>();
    let vertexCount = 0;
    let frame = 0;
    let saveView = () => {};
    let restoreSketchCamera = () => {};
    const textures: THREE.Texture[] = [];
    const boardGroups = createModelBoardDisplayGroups(group, displayRef.current);
    const components = new THREE.Group();
    orderAssembly(components);
    const selectionPaint = createModelSelection(components);
    models.current = components;
    components.visible = modelsVisibleRef.current;
    group.add(components);
    const cadGroup = new THREE.Group(),
      previewGroup = new THREE.Group(),
      sketchGroup = new THREE.Group(),
      edgeGroup = new THREE.Group(),
      faceGroup = new THREE.Group(),
      operandGhostGroup = new THREE.Group();
    group.add(cadGroup, previewGroup, sketchGroup, edgeGroup, faceGroup, operandGhostGroup);
    for (const transient of [previewGroup, sketchGroup, edgeGroup, faceGroup, operandGhostGroup])
      transient.userData.modelMeasurementExcluded = true;
    const operandGhosts = createModelCadOperandGhosts(operandGhostGroup);
    const groundGroup = new THREE.Group();
    const groundScene = createModelGroundScene(groundGroup);
    orderAssembly(cadGroup);
    orderAssembly(previewGroup);
    const bounds = pcbBounds(board);
    const explodedScene = createModelExplodedView(board, components, boardGroups);
    const sketchScene = createModelCadSketchScene(
      sketchGroup,
      Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY),
    );
    updateCadSketch.current = () => {
      sketchScene.update(cadState.current.sketch, cadState.current.darkCanvas, gridOptions.current);
      redraw.current();
    };
    updateCadEdges.current = () => {
      disposeModelCadEdgeHighlight(edgeGroup);
      disposeModelCadFaceHighlight(faceGroup);
      const selection = cadState.current.edgeSelection;
      edgeGroup.visible = cadState.current.cadVisible;
      faceGroup.visible = cadState.current.cadVisible;
      if (selection) {
        const selected = new Set(selection.ids);
        const available = modelCadSelectableEdges(selection.object)
          .filter((edge) => !selected.has(edge.id))
          .map((edge) => edge.id);
        const displayed = selection.object;
        const outline = createModelCadEdgeHighlight(displayed, available);
        outline.traverse((node) => {
          if (node instanceof THREE.Line) {
            const materials = Array.isArray(node.material) ? node.material : [node.material];
            for (const material of materials)
              if (material instanceof THREE.LineBasicMaterial)
                material.color.set(cadState.current.darkCanvas ? 0x989da3 : 0x646a70);
          }
        });
        edgeGroup.add(outline, createModelCadEdgeHighlight(displayed, selection.ids));
      }
      for (const body of cadState.current.modelCad?.objects ?? []) {
        const faces = cadState.current.selection.flatMap((item) =>
          item.kind === 'face' && item.objectId === body.id ? [item.faceId] : [],
        );
        if (faces.length) faceGroup.add(createModelCadFaceHighlight(body, faces));
        const edges = cadState.current.selection.flatMap((item) =>
          (item.kind === 'edge' || item.kind === 'line') && item.objectId === body.id
            ? [item.edgeId]
            : [],
        );
        if (edges.length && body.id !== selection?.object.id)
          edgeGroup.add(createModelCadEdgeHighlight(body, edges));
      }
      redraw.current();
    };
    const cadPaint = createModelSelection(cadGroup, 'modelCadId');
    const updatePreviewVisibility = () => {
      clippingBoundsDirty.current = true;
      const replacing =
        previewGroup.visible &&
        cadState.current.preview &&
        previewGroup.children.some((child) => !child.userData.modelCadPending)
          ? new Set(cadState.current.previewReplacedIds)
          : new Set<string>();
      for (const object of cadGroup.children)
        object.visible = !replacing.has(object.userData.modelCadId as string);
      operandGhosts.update(
        cadGroup,
        cadState.current.booleanActive ? [...replacing] : [],
        cadState.current.darkCanvas,
      );
    };
    setCadGeometryErrors({ document: '', preview: '' });
    const cadScene = createModelCadScene(cadGroup, () => cadPaint.dispose(), false, {
      active: () => activeRef.current,
      onChange: () =>
        publishModelImport(() => {
          measurement.clear();
          explodedScene.apply(explodedRef.current);
          orderAssembly(cadGroup);
          updatePreviewVisibility();
          syncRenderImports();
          paintCad.current();
          if (host.current) host.current.dataset.cadObjects = String(cadGroup.children.length);
          updateAnnotationView.current();
          redraw.current();
        }),
      onError: (message) => {
        cadImportError = message;
        setCadGeometryErrors((previous) => ({ ...previous, document: message }));
        syncRenderImports();
      },
    });
    const previewScene = createModelCadScene(previewGroup, () => {}, true, {
      active: () => activeRef.current,
      onChange: () => {
        orderAssembly(previewGroup);
        updatePreviewVisibility();
        redraw.current();
      },
      onError: (message) => setCadGeometryErrors((previous) => ({ ...previous, preview: message })),
    });
    retryCadGeometry.current = () => {
      setCadGeometryErrors({ document: '', preview: '' });
      cadScene.retry();
      previewScene.retry();
      syncRenderImports();
    };
    paintCad.current = () => {
      cadPaint.update(new Set(cadState.current.selectedBodyIds), cadState.current.darkCanvas);
      redraw.current();
    };
    updateCad.current = () => {
      updatingCad = true;
      try {
        cadScene.update(cadState.current.modelCad?.objects ?? []);
      } finally {
        updatingCad = false;
      }
      syncRenderImports();
      explodedScene.apply(explodedRef.current);
      orderAssembly(cadGroup);
      cadGroup.visible = cadState.current.cadVisible;
      if (host.current) host.current.dataset.cadObjects = String(cadGroup.children.length);
      paintCad.current();
      updatePreviewVisibility();
      updateAnnotationView.current();
    };
    updateCadPreview.current = () => {
      previewScene.update(
        activeRef.current && cadState.current.preview ? [cadState.current.preview] : [],
      );
      orderAssembly(previewGroup);
      updatePreviewVisibility();
      redraw.current();
    };
    updateCad.current();
    updateCadPreview.current();
    updateCadSketch.current();
    updateCadEdges.current();
    setStatus('Loading 3D board…');
    setWarnings([]);
    completedCheckBasis.current = null;
    setFailed(false);
    setReady(false);
    loadingProgress.current = { completed: 0, total: board.footprints.length, reference: '' };
    updateLoadingProgress.current(loadingProgress.current);
    setRenderProgress((previous) => ({ ...previous, samples: 0 }));
    setRenderLoading(renderEnabledRef.current);
    setRenderImportStatus(renderEnabledRef.current ? 'components' : '');
    const waitForActive = async () => {
      if (activeRef.current || control.signal.aborted) return;
      await new Promise<void>((resolve) => {
        const resume = () => {
          control.signal.removeEventListener('abort', resume);
          resumeLoading.current = () => {};
          resolve();
        };
        resumeLoading.current = resume;
        control.signal.addEventListener('abort', resume, { once: true });
      });
    };
    const yieldBuild = async () => {
      // A task boundary lets input and loading paint run between independent
      // clipping/triangulation stages, including cached model placements.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await waitForActive();
      if (control.signal.aborted) throw new Error('Preview cancelled.');
    };
    void (async () => {
      await yieldBuild();
      if (
        board.footprints.length > 256 ||
        board.footprints.reduce((n, f) => n + f.pads.length, 0) > 3000 ||
        board.tracks.length + board.vias.length > 12000
      )
        throw new Error('The board exceeds the 3D preview geometry limit.');
      const boundary = modelBoardPolygons(board);
      const boardFrame = new THREE.Box2();
      for (const polygon of boundary)
        for (const point of polygon.outer)
          boardFrame.expandByPoint(new THREE.Vector2(point.x, point.y));
      const boardCenter = boardFrame.isEmpty()
        ? new THREE.Vector2()
        : boardFrame.getCenter(new THREE.Vector2());
      const groundBounds = boardFrame.isEmpty()
        ? new THREE.Box3()
        : new THREE.Box3(
            new THREE.Vector3(boardFrame.min.x, -boardFrame.max.y, 0),
            new THREE.Vector3(boardFrame.max.x, -boardFrame.min.y, 0),
          );
      const holes: Polygon[] = board.footprints.flatMap((f) =>
        f.pads
          .filter((p) => p.drill)
          .map((p) => ({ outer: circlePolygon(padDrillPosition(f, p), p.drill! / 2), holes: [] })),
      );
      holes.push(...board.vias.map((v) => ({ outer: circlePolygon(v, v.drill / 2), holes: [] })));
      const body = subtractPolygons(boundary, holes);
      await yieldBuild();
      if (body.length) {
        const laminate = new THREE.Mesh(
          new THREE.ExtrudeGeometry(body.map(shape), {
            depth: board.thickness,
            bevelEnabled: false,
          }),
          new THREE.MeshStandardMaterial({
            color: modelBoardDisplayColors.substrate,
            roughness: 0.8,
          }),
        );
        laminate.position.z = -board.thickness / 2;
        laminate.userData.modelBoard = true;
        boardGroups.substrate.add(laminate);
      }
      await yieldBuild();
      const surface = async (
        target: THREE.Group,
        polygons: Polygon[],
        z: number,
        color: number,
        physicalLayer: string,
        pour = false,
      ) => {
        if (!polygons.length) return;
        await yieldBuild();
        const inside = intersectPolygons(polygons, boundary);
        await yieldBuild();
        const clipped = subtractPolygons(inside, holes);
        await yieldBuild();
        const mesh = new THREE.Mesh(
          new THREE.ShapeGeometry(clipped.map(shape)),
          new THREE.MeshStandardMaterial({
            color,
            side: THREE.DoubleSide,
            roughness: 0.45,
            metalness: 0.35,
            ...(pour ? { transparent: true, opacity: copperFillOpacity, depthWrite: false } : {}),
          }),
        );
        mesh.position.z = z;
        mesh.userData.modelBoard = true;
        mesh.userData.modelExplosionLayer = physicalLayer;
        target.add(mesh);
        await yieldBuild();
      };
      const issues: ModelCheckIssue[] = [];
      let fills = new Map<string, Polygon[]>();
      try {
        fills = filledCopperPolygons(board);
      } catch (e) {
        issues.push({ message: (e as Error).message, severity: 'error' });
      }
      await yieldBuild();
      const silkGraphics = pcbSilkscreen(board, schematicRef.current);
      for (const [layerIndex, layer] of board.layers.entries()) {
        if (!boundary.length) break;
        const side = layer === 'F.Cu' ? 'front' : layer === 'B.Cu' ? 'back' : null;
        const z = side
          ? (side === 'front' ? 1 : -1) * (board.thickness / 2 + 0.015)
          : board.thickness / 2 - (board.thickness * layerIndex) / (board.layers.length - 1);
        await surface(
          boardGroups.copper,
          board.tracks
            .filter((t) => t.layer === layer)
            .flatMap((t) => strokePolygon([t.start, t.end], t.width)),
          z,
          modelBoardDisplayColors.copper,
          layer,
        );
        await surface(
          boardGroups.copper,
          board.vias.map((v) => ({ outer: circlePolygon(v, v.diameter / 2), holes: [] })),
          z,
          modelBoardDisplayColors.copper,
          layer,
        );
        await surface(
          boardGroups.copper,
          board.footprints.flatMap((f) =>
            f.pads
              .filter((p) => padCopperLayers(board, f, p).includes(layer))
              .map((p) => padPolygon(f, p)),
          ),
          z,
          modelBoardDisplayColors.copper,
          layer,
        );
        const zones = [...board.zones, ...board.footprints.flatMap((f) => f.zones ?? [])]
          .filter((zone) => zone.layer === layer)
          .flatMap((zone) => fills.get(zone.id) ?? []);
        await surface(
          boardGroups.copper,
          zones,
          side ? (side === 'front' ? 1 : -1) * (board.thickness / 2 + 0.01) : z,
          modelBoardDisplayColors.copper,
          layer,
          true,
        );
        if (!side) continue;
        const mask = solderMaskOpenings(board, side);
        if (mask.omittedText)
          issues.push({
            message: `${side === 'front' ? 'Front' : 'Back'} solder mask text and dimensions are not shown in 3D. Check the native export in KiCad.`,
            severity: 'warning',
          });
        const maskShape = subtractPolygons(body, mask.openings);
        await yieldBuild();
        const coating = createModelSolderMaskSurface(new THREE.ShapeGeometry(maskShape.map(shape)));
        // Apply the green lacquer after translucent pours while leaving pad
        // apertures, drills and higher silkscreen/component surfaces untouched.
        coating.position.z = (side === 'front' ? 1 : -1) * (board.thickness / 2 + 0.02);
        coating.renderOrder = 1;
        coating.userData.modelBoard = true;
        coating.userData.modelExplosionLayer = side === 'front' ? 'F.Mask' : 'B.Mask';
        boardGroups.mask.add(coating);
        await yieldBuild();
        const silk = silkGraphics.filter(
          (g) => g.layer === (side === 'front' ? 'F.SilkS' : 'B.SilkS'),
        );
        await surface(
          boardGroups.silkscreen,
          silk.filter((g) => !g.text && !g.dimension).flatMap(graphicPolygons),
          (side === 'front' ? 1 : -1) * (board.thickness / 2 + 0.025),
          modelBoardDisplayColors.silkscreen,
          side === 'front' ? 'F.SilkS' : 'B.SilkS',
        );
        const inkPolygons: Polygon[] = [];
        const texts: typeof silk = [];
        let remainingCharacters = modelSilkscreenGeometryLimit;
        let remainingSegments = modelSilkscreenGeometryLimit;
        for (const graphic of silk) {
          const text = graphic.text;
          if (!text || text.hidden) continue;
          if (remainingSegments > 0 && text.value.length <= remainingCharacters) {
            remainingCharacters -= text.value.length;
            const ink = pcbStrokeText(text, graphic.start);
            if ('paths' in ink) {
              const segments = ink.paths.reduce((total, path) => total + path.length - 1, 0);
              if (segments <= remainingSegments) {
                remainingSegments -= segments;
                for (const path of ink.paths) inkPolygons.push(...strokePolygon(path, ink.width));
                continue;
              }
            }
          }
          texts.push(graphic);
        }
        await surface(
          boardGroups.silkscreen,
          inkPolygons,
          (side === 'front' ? 1 : -1) * (board.thickness / 2 + 0.03),
          modelBoardDisplayColors.silkscreen,
          side === 'front' ? 'F.SilkS' : 'B.SilkS',
        );
        if (texts.length) {
          const points = boundary.flatMap((p) => p.outer);
          const minX = Math.min(...points.map((p) => p.x)),
            maxX = Math.max(...points.map((p) => p.x));
          const minY = Math.min(...points.map((p) => p.y)),
            maxY = Math.max(...points.map((p) => p.y));
          const w = maxX - minX,
            h = maxY - minY,
            scale = Math.min(24, 4096 / Math.max(w, h));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.ceil(w * scale));
          canvas.height = Math.max(1, Math.ceil(h * scale));
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (ctx) {
            const fontFamily = host.current
              ? getComputedStyle(host.current).fontFamily
              : '"Segoe UI", "Helvetica Neue", Arial, sans-serif';
            ctx.setTransform(
              canvas.width / w,
              0,
              0,
              canvas.height / h,
              (-minX * canvas.width) / w,
              (-minY * canvas.height) / h,
            );
            ctx.beginPath();
            for (const polygon of body)
              for (const ring of [polygon.outer, ...polygon.holes]) {
                ctx.moveTo(ring[0].x, ring[0].y);
                for (const point of ring.slice(1)) ctx.lineTo(point.x, point.y);
                ctx.closePath();
              }
            ctx.clip('evenodd');
            ctx.fillStyle = `#${modelBoardDisplayColors.silkscreen.toString(16).padStart(6, '0')}`;
            for (const g of texts) {
              const text = g.text!;
              ctx.save();
              ctx.translate(g.start.x, g.start.y);
              ctx.rotate((-text.rotation * Math.PI) / 180);
              ctx.scale(
                ((text.justify?.includes('mirror') ? -1 : 1) * text.size.x) / text.size.y,
                1,
              );
              ctx.font = `${text.italic ? 'italic ' : ''}${text.bold ? 'bold ' : ''}${text.size.y}px ${fontFamily}`;
              ctx.textAlign = text.justify?.includes('left')
                ? 'left'
                : text.justify?.includes('right')
                  ? 'right'
                  : 'center';
              ctx.textBaseline = text.justify?.includes('top')
                ? 'top'
                : text.justify?.includes('bottom')
                  ? 'alphabetic'
                  : 'middle';
              text.value
                .split('\n')
                .forEach((line, i) => ctx.fillText(line, 0, i * text.size.y * 1.25));
              ctx.restore();
            }
            const texture = new THREE.CanvasTexture(canvas);
            texture.colorSpace = THREE.SRGBColorSpace;
            textures.push(texture);
            const mesh = new THREE.Mesh(
              new THREE.PlaneGeometry(w, h),
              new THREE.MeshBasicMaterial({
                map: texture,
                transparent: true,
                side: THREE.DoubleSide,
                depthWrite: false,
              }),
            );
            mesh.userData.modelMeasurementVisibleAtUV = (uv?: THREE.Vector2) => {
              if (!uv || !Number.isFinite(uv.x) || !Number.isFinite(uv.y)) return false;
              const x = Math.max(0, Math.min(canvas.width - 1, Math.floor(uv.x * canvas.width)));
              const y = Math.max(
                0,
                Math.min(canvas.height - 1, Math.floor((1 - uv.y) * canvas.height)),
              );
              return ctx.getImageData(x, y, 1, 1).data[3] > 0;
            };
            mesh.position.set(
              (minX + maxX) / 2,
              -(minY + maxY) / 2,
              (side === 'front' ? 1 : -1) * (board.thickness / 2 + 0.035),
            );
            boardGroups.silkscreen.add(mesh);
            mesh.userData.modelExplosionLayer = side === 'front' ? 'F.SilkS' : 'B.SilkS';
          }
        }
        await yieldBuild();
      }
      const estimates = new Map<string, THREE.Mesh>();
      clippingBoundsDirty.current = true;
      let estimateTask = performance.now();
      for (const footprint of board.footprints) {
        if (performance.now() - estimateTask >= 8) {
          await yieldBuild();
          estimateTask = performance.now();
        }
        if (!footprint.pads.some((p) => p.type !== 'np_thru_hole')) continue;
        const drawings = footprint.graphics.filter(
          (g) => !g.text && (g.layer.endsWith('.Fab') || g.layer.endsWith('.CrtYd')),
        );
        const bounds = pcbBounds({
          ...createEmptyPCB(),
          footprints: [{ ...footprint, x: 0, y: 0, rotation: 0, graphics: drawings }],
        });
        const w = Math.max(0.5, Math.min(100, bounds.maxX - bounds.minX)),
          h = Math.max(0.5, Math.min(100, bounds.maxY - bounds.minY));
        const height = /TerminalBlock|Connector|PinHeader/.test(footprint.libraryId)
          ? 6
          : /Inductor|Capacitor_THT/.test(footprint.libraryId)
            ? 4
            : 1.4;
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(w * 0.8, h * 0.8, height),
          new THREE.MeshStandardMaterial({
            color: componentModelEstimateColor,
            roughness: 0.8,
            transparent: true,
            opacity: 0.6,
          }),
        );
        const location = modelPlacement(footprint, board.thickness);
        const center = footprintPoint(footprint, {
          x: (bounds.minX + bounds.maxX) / 2,
          y: (bounds.minY + bounds.maxY) / 2,
        });
        mesh.position.set(
          center.x,
          -center.y,
          location.z + ((location.flipped ? -1 : 1) * height) / 2,
        );
        mesh.rotation.z = location.rotation;
        mesh.userData.estimated = true;
        mesh.userData.footprintId = footprint.id;
        mesh.visible = !footprint.models?.length || footprint.models.some((m) => !m.hidden);
        estimates.set(footprint.id, mesh);
        components.add(mesh);
      }
      await yieldBuild();
      if (!host.current || control.signal.aborted) return;
      explodedScene.apply(explodedRef.current);
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: false,
      });
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
      host.current.appendChild(renderer.domElement);
      await yieldBuild();
      const scene = new THREE.Scene();
      scene.add(group);
      scene.add(groundGroup);
      const hemisphere = new THREE.HemisphereLight(0xffffff, 0x444444, 3);
      scene.add(hemisphere);
      const light = new THREE.DirectionalLight(0xffffff, 3);
      light.position.set(50, -70, 100);
      scene.add(light);
      const orthographicCamera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.01, 100000);
      const perspectiveCamera = new THREE.PerspectiveCamera(40, 1, 0.01, 100000);
      orthographicCamera.up.set(0, 0, 1);
      perspectiveCamera.up.set(0, 0, 1);
      let camera: THREE.OrthographicCamera | THREE.PerspectiveCamera = orthographicRef.current
        ? orthographicCamera
        : perspectiveCamera;
      const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(perspectiveCamera.fov) / 2);
      orbit = new OrbitControls(camera, renderer.domElement);
      orbit.enableDamping = true;
      orbit.minZoom = 0.01;
      orbit.maxZoom = 100;
      let extent = 50;
      // Match the scale at the orbit target in both projections. Perspective
      // wheel gestures dolly the camera, while orthographic gestures change zoom.
      const visibleHeight = () =>
        camera instanceof THREE.OrthographicCamera
          ? extent / camera.zoom
          : (2 * camera.position.distanceTo(orbit!.target) * tanHalfFov) / camera.zoom;
      const limitDistance = () => {
        if (camera instanceof THREE.PerspectiveCamera) {
          const distance = (extent * camera.zoom) / (2 * tanHalfFov);
          orbit!.minDistance = distance / orbit!.maxZoom;
          orbit!.maxDistance = distance / orbit!.minZoom;
        } else {
          orbit!.minDistance = 0;
          orbit!.maxDistance = Infinity;
        }
      };
      let shadersReady = false;
      const clippingSphere = new THREE.Sphere();
      const clippingBounds = new THREE.Box3();
      const drawScene = (
        selected: THREE.Object3D[] = [],
        moving = false,
        capture = false,
        continuation = false,
      ) => {
        if (capture && renderEnabledRef.current && !studio)
          throw new Error(
            'Render is still preparing. Try exporting the image again when it is ready.',
          );
        if (studio && renderEnabledRef.current) {
          const progress = selectionPaint.withoutSelection(() =>
            cadPaint.withoutSelection(() =>
              studio!.render(camera, {
                dark: cadState.current.darkCanvas,
                bounds: clippingBounds,
                moving,
                selected,
                continuation: continuation && !capture,
              }),
            ),
          );
          studioComplete = progress.complete;
          const samples = Math.floor(progress.samples);
          setRenderProgress((previous) =>
            samples !== previous.samples &&
            (samples === 0 || progress.complete || samples >= previous.samples + 4)
              ? { ...previous, samples }
              : previous,
          );
          if (studioPreparing && progress.samples > 0) {
            studioPreparing = false;
            setRenderLoading(false);
          }
          if (host.current) {
            host.current.dataset.renderMode = 'studio';
            host.current.dataset.renderSamples = String(progress.samples);
          }
        } else {
          annotationOutline.render(renderer!, scene, camera, selected);
          if (host.current) host.current.dataset.renderMode = 'standard';
        }
      };
      const renderFailure = (error: unknown) => {
        studio?.dispose();
        studio = undefined;
        studioPreparing = false;
        studioComplete = false;
        renderEnabledRef.current = false;
        setRenderEnabled(false);
        setRenderLoading(false);
        setRenderImportStatus('');
        setRenderError(
          `Render failed: ${error instanceof Error ? error.message : String(error)}. Turn Render on to retry.`,
        );
      };
      const pendingRenderImport = () => {
        if (!componentsSettled) return 'components';
        if (componentImportFailed) return 'component-error';
        if (cadImportError) return 'cad-error';
        if (updatingCad || cadGroup.children.some((object) => object.userData.modelCadPending))
          return 'cad';
        return '';
      };
      applyRenderMode.current = () => {
        if (control.signal.aborted || rendererDisposed || !renderer) return;
        if (!renderEnabledRef.current) {
          studio?.dispose();
          studio = undefined;
          studioPreparing = false;
          studioComplete = false;
          setRenderLoading(false);
          setRenderImportStatus('');
          redraw.current();
          updateAnnotationView.current();
          return;
        }
        const pending = pendingRenderImport();
        setRenderImportStatus(pending);
        if (pending) {
          // Build the path-tracing scene only from a complete model. Imported
          // meshes can arrive after board shaders or after a later CAD edit.
          studio?.dispose();
          studio = undefined;
          studioPreparing = false;
          studioComplete = false;
          setRenderProgress({ samples: 0, target: MODEL_RENDER_SAMPLES });
          setRenderLoading(pending === 'components' || pending === 'cad');
          redraw.current();
          updateAnnotationView.current();
          return;
        }
        if (!activeRef.current || studio) return;
        studioPreparing = true;
        setRenderLoading(true);
        setRenderError('');
        try {
          studio = createModelStudioRenderer(renderer, scene, group, [groundGroup]);
          setRenderProgress({ samples: 0, target: MODEL_RENDER_SAMPLES });
          redraw.current();
          updateAnnotationView.current();
        } catch (error: unknown) {
          renderFailure(error);
          redraw.current();
        }
      };
      syncRenderImports = () => publishModelImport(() => applyRenderMode.current());
      const updateReferencePlane = () =>
        groundScene.update({
          bounds: groundBounds,
          boardThickness: board.thickness,
          boardCenter,
          spacing: gridOptions.current.spacing,
          unitsPerPixel: visibleHeight() / (host.current?.clientHeight || 1),
          dark: cadState.current.darkCanvas,
          gridVisible: gridOptions.current.visible,
          visible:
            referencePlaneVisibleRef.current &&
            !['plane', 'sketch'].includes(cadState.current.sketch?.phase ?? ''),
        });
      let viewDirty = true;
      const scheduleRender = () => {
        if (
          !renderer ||
          !shadersReady ||
          rendererDisposed ||
          control.signal.aborted ||
          !activeRef.current ||
          frame
        )
          return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          if (control.signal.aborted || !activeRef.current) return;
          const updateView = viewDirty;
          viewDirty = false;
          const changing = updateView && !annotatingRef.current && orbit?.update();
          if (updateView) {
            if (clippingBoundsDirty.current) {
              // Cache physical extents until geometry/visibility changes. The
              // transient sketch grid must not widen the depth range of the PCB.
              clippingBounds.makeEmpty();
              for (const child of group.children)
                if (
                  child !== sketchGroup &&
                  child !== edgeGroup &&
                  child !== faceGroup &&
                  child !== operandGhostGroup &&
                  child.visible
                )
                  clippingBounds.union(modelVisibleBounds(child));
              clippingBounds.getBoundingSphere(clippingSphere);
              clippingBoundsDirty.current = false;
            }
            const clipping = modelCameraClipping({
              position: camera.position,
              target: orbit!.target,
              bounds: clippingBounds.isEmpty() ? null : clippingSphere,
            });
            updateReferencePlane();
            const planeClipping = sketchScene.clippingRange(camera);
            const groundClipping = groundScene.clippingRange(camera, orbit!.target);
            camera.near = Math.min(
              clipping.near,
              planeClipping?.near ?? clipping.near,
              groundClipping?.near ?? clipping.near,
            );
            camera.far = Math.max(
              clipping.far,
              planeClipping?.far ?? clipping.far,
              groundClipping?.far ?? clipping.far,
            );
            camera.updateProjectionMatrix();
            if (
              measuringRef.current &&
              measurementPointer.current &&
              pressedPointers.current.size === 0 &&
              !hasOpenOverlay()
            )
              measurement.move(
                measurePoint.current(measurementPointer.current, measurementPointer.current.snap),
              );
            redrawMeasurement.current();
            updateScale.current();
            // Wheel zoom and camera gestures can change the placement plane below
            // a stationary pointer. Keep its snapped preview current before the
            // next click/Enter, without moving it during a held camera gesture.
            if (
              cadRef.current.tool &&
              (cadRef.current.tool !== 'sketch' || cadRef.current.sketchPhase === 'sketch') &&
              placementPointer.current &&
              !hasOpenOverlay() &&
              pressedPointers.current.size === 0
            ) {
              const rect = host.current!.getBoundingClientRect();
              cadRef.current.canvasMove(
                cadPoint.current({
                  x: ((placementPointer.current.clientX - rect.left) / rect.width) * 1000,
                  y: ((placementPointer.current.clientY - rect.top) / rect.width) * 1000,
                }),
              );
            }
            sketchScene.updateGrid({
              camera,
              width: host.current?.clientWidth || 1,
              height: host.current?.clientHeight || 1,
            });
          }
          try {
            drawScene(
              annotatingRef.current && components.visible
                ? components.children.filter(
                    (object) =>
                      object.visible &&
                      selectionRef.current.ids.includes(object.userData.footprintId),
                  )
                : [],
              Boolean(changing || pressedPointers.current.size),
              false,
              !updateView,
            );
          } catch (error) {
            if (!studio) throw error;
            renderFailure(error);
            drawScene();
          }
          if (annotatingRef.current) updateAnnotationView.current();
          if (host.current)
            host.current.dataset.renderCount = String(
              Number(host.current.dataset.renderCount ?? 0) + 1,
            );
          if (host.current) {
            host.current.dataset.modelsVisible = String(components.visible);
            host.current.dataset.boardDisplay = JSON.stringify(displayRef.current);
            host.current.dataset.modelInstances = String(
              components.children.filter((object) => object.visible).length,
            );
          }
          if (changing) render();
          else if (
            studio &&
            renderEnabledRef.current &&
            !studioComplete &&
            !pressedPointers.current.size
          )
            scheduleRender();
        });
      };
      const render = () => {
        viewDirty = true;
        if (!modelImportUpdate) renderEpoch++;
        if (renderEnabledRef.current) setExportStatus('');
        studio?.invalidate();
        studioComplete = false;
        scheduleRender();
      };
      const requireCaptureView = () => {
        if (control.signal.aborted || rendererDisposed || !activeRef.current)
          throw new Error(
            'The render changed or was stopped. Try exporting the current view again.',
          );
      };
      const waitForRender = async () => {
        requireCaptureView();
        if (!renderEnabledRef.current) return;
        const importEpoch = renderEpoch;
        while (pendingRenderImport()) {
          const pending = pendingRenderImport();
          if (pending === 'component-error' || pending === 'cad-error')
            throw new Error(
              'Model import failed. Retry the failed models before exporting Render.',
            );
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          requireCaptureView();
          if (!renderEnabledRef.current || importEpoch !== renderEpoch)
            throw new Error(
              'The render changed or was stopped. Try exporting the current view again.',
            );
        }
        if (!studio) {
          throw new Error(
            'The render changed or was stopped. Try exporting the current view again.',
          );
        }
        const requested = studio;
        const epoch = renderEpoch;
        scheduleRender();
        while (!studioComplete) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          if (
            control.signal.aborted ||
            !activeRef.current ||
            studio !== requested ||
            !renderEnabledRef.current ||
            epoch !== renderEpoch
          )
            throw new Error(
              'The render changed or was stopped. Try exporting the current view again.',
            );
        }
      };
      applyExploded.current = () => {
        explodedScene.apply(explodedRef.current);
        clippingBoundsDirty.current = true;
        updateCadEdges.current();
        updateAnnotationView.current();
        render();
      };
      redraw.current = render;
      applyRenderMode.current();
      highlightModels.current = () => {
        const selected = selectionRef.current;
        selectionPaint.update(new Set(selected.ids), selected.dark);
        render();
      };
      highlightModels.current();
      zoom.current = (factor) => {
        const requested =
          factor === null
            ? (extent * pixelsPerMM) / (host.current?.clientHeight || 1)
            : (extent / visibleHeight()) * factor;
        const scale = THREE.MathUtils.clamp(requested, orbit!.minZoom, orbit!.maxZoom);
        if (camera instanceof THREE.OrthographicCamera) camera.zoom = scale;
        else {
          const distance = (extent * camera.zoom) / (2 * tanHalfFov * scale);
          camera.position.sub(orbit!.target).setLength(distance).add(orbit!.target);
        }
        camera.updateProjectionMatrix();
        orbit!.update();
        render();
      };
      orbit.addEventListener('change', render);
      orbit.addEventListener('end', render);
      const resize = () => {
        if (!host.current || !renderer || !activeRef.current) return;
        const { clientWidth: w, clientHeight: h } = host.current;
        if (!w || !h) return;
        renderer.setSize(w, h);
        if (camera instanceof THREE.OrthographicCamera) {
          camera.left = (-extent * w) / h / 2;
          camera.right = -camera.left;
          camera.top = extent / 2;
          camera.bottom = -camera.top;
        } else camera.aspect = w / h;
        limitDistance();
        camera.updateProjectionMatrix();
        render();
      };
      applyProjection.current = () => {
        const next = orthographicRef.current ? orthographicCamera : perspectiveCamera;
        if (camera === next) return;
        const height = visibleHeight();
        next.position.copy(camera.position);
        next.quaternion.copy(camera.quaternion);
        next.up.copy(camera.up);
        next.zoom =
          next instanceof THREE.OrthographicCamera
            ? extent / height
            : (2 * camera.position.distanceTo(orbit!.target) * tanHalfFov) / height;
        camera = next;
        orbit!.object = camera;
        resize();
      };
      updateActivity.current = () => {
        orbit!.enabled = activeRef.current && !annotatingRef.current;
        // CAD tools own left-click placement, while the existing wheel and
        // middle/right camera gestures remain available on a crowded board.
        const drawingSketch = cadRef.current.sketchPhase === 'sketch';
        const pointerTool = Boolean(
          cadRef.current.tool && (cadRef.current.tool !== 'sketch' || drawingSketch),
        );
        orbit!.mouseButtons.LEFT = pointerTool
          ? null
          : cadRef.current.pan
            ? THREE.MOUSE.PAN
            : THREE.MOUSE.ROTATE;
        orbit!.touches.ONE = pointerTool ? null : THREE.TOUCH.ROTATE;
        orbit!.enableRotate = !drawingSketch;
        orbit!.enableDamping = !annotatingRef.current && !pointerTool;
        if (activeRef.current) resize();
        else {
          cancelAnimationFrame(frame);
          frame = 0;
          saveView();
        }
      };
      const directions = {
        top: [0, 0, 1],
        bottom: [0, 0, -1],
        front: [0, -1, 0],
        back: [0, 1, 0],
        left: [-1, 0, 0],
        right: [1, 0, 0],
        isometric: [1, -1, 1],
      } as const;
      const applyView = (direction: ModelView, target: THREE.Vector3, distance: number) => {
        // Discard navigation inertia before applying an exact preset around the current target.
        const damping = orbit!.enableDamping;
        orbit!.enableDamping = false;
        orbit!.update();
        orbit!.target.copy(target);
        camera.up.set(
          0,
          direction === 'top' || direction === 'bottom' ? 1 : 0,
          direction === 'top' || direction === 'bottom' ? 0 : 1,
        );
        camera.position
          .copy(target)
          .addScaledVector(new THREE.Vector3(...directions[direction]).normalize(), distance);
        orbit!.update();
        orbit!.enableDamping = damping;
        camera.updateMatrixWorld(true);
        render();
      };
      fit.current = () => {
        const b = new THREE.Box3();
        for (const child of group.children)
          if (
            child !== edgeGroup &&
            child !== faceGroup &&
            child !== sketchGroup &&
            child !== operandGhostGroup &&
            child.visible
          )
            b.union(modelVisibleBounds(child));
        const center = b.getCenter(new THREE.Vector3()),
          dims = b.getSize(new THREE.Vector3());
        const aspect = (host.current?.clientWidth || 1) / (host.current?.clientHeight || 1);
        extent = b.isEmpty()
          ? (host.current?.clientHeight || 1) / pixelsPerMM
          : Math.max(dims.y, dims.x / aspect, dims.z, 5) * 1.8;
        const distance = extent * 1.5;
        camera.zoom =
          camera instanceof THREE.PerspectiveCamera ? (2 * distance * tanHalfFov) / extent : 1;
        resize();
        applyView('isometric', center, distance);
      };
      locateFootprint.current = (id) => {
        const footprint = board.footprints.find((item) => item.id === id);
        if (!footprint || !activeRef.current) return;
        const bounds = new THREE.Box3();
        if (components.visible)
          for (const child of components.children)
            if (child.visible && child.userData.footprintId === id)
              bounds.union(modelVisibleBounds(child));
        // Mounting holes can have neither a STEP model nor a package estimate.
        if (bounds.isEmpty()) {
          const box = pcbBounds({ ...createEmptyPCB(), footprints: [footprint] });
          const { z } = modelPlacement(footprint, board.thickness);
          bounds.set(
            new THREE.Vector3(box.minX, -box.maxY, z),
            new THREE.Vector3(box.maxX, -box.minY, z),
          );
        }
        const center = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        const aspect = (host.current?.clientWidth || 1) / (host.current?.clientHeight || 1);
        const height = Math.max(20, Math.max(size.x / aspect, size.y, size.z) * 2.4);
        const damping = orbit!.enableDamping;
        orbit!.enableDamping = false;
        orbit!.update();
        camera.position.add(center.clone().sub(orbit!.target));
        orbit!.target.copy(center);
        zoom.current(visibleHeight() / height);
        orbit!.enableDamping = damping;
        clippingBoundsDirty.current = true;
        saveView();
        render();
      };
      orient.current = (direction) => {
        const target = orbit!.target.clone();
        applyView(direction, target, camera.position.distanceTo(target));
      };
      let sketchCamera: {
        position: THREE.Vector3;
        target: THREE.Vector3;
        up: THREE.Vector3;
        quaternion: THREE.Quaternion;
        zoom: number;
        extent: number;
        orthographic: boolean;
      } | null = null;
      alignSketchView.current = (plane, origin) => {
        if (!activeRef.current || !Object.values(origin).every(Number.isFinite)) return;
        sketchCamera ??= {
          position: camera.position.clone(),
          target: orbit!.target.clone(),
          up: camera.up.clone(),
          quaternion: camera.quaternion.clone(),
          zoom: camera.zoom,
          extent,
          orthographic: camera instanceof THREE.OrthographicCamera,
        };
        const height = visibleHeight();
        const distance = Math.max(5, camera.position.distanceTo(orbit!.target));
        const damping = orbit!.enableDamping;
        orbit!.enableDamping = false;
        orbit!.update();
        camera = orthographicCamera;
        camera.zoom = extent / height;
        orbit!.object = camera;
        orthographicRef.current = true;
        setOrthographic(true);
        const frame = modelCadSketchFrame(plane, origin);
        orbit!.target.copy(frame.center);
        camera.up.copy(plane === 'XY' ? new THREE.Vector3(0, 1, 0) : frame.v);
        camera.position.copy(frame.center).addScaledVector(frame.normal, distance);
        orbit!.update();
        orbit!.enableDamping = damping;
        camera.updateMatrixWorld(true);
        resize();
      };
      restoreSketchCamera = () => {
        const saved = sketchCamera;
        if (!saved) return;
        sketchCamera = null;
        const damping = orbit!.enableDamping;
        orbit!.enableDamping = false;
        orbit!.update();
        camera = saved.orthographic ? orthographicCamera : perspectiveCamera;
        orbit!.object = camera;
        extent = saved.extent;
        camera.position.copy(saved.position);
        camera.up.copy(saved.up);
        camera.zoom = saved.zoom;
        orbit!.target.copy(saved.target);
        orbit!.update();
        camera.quaternion.copy(saved.quaternion);
        orbit!.enableDamping = damping;
        orthographicRef.current = saved.orthographic;
        setOrthographic(saved.orthographic);
        camera.updateMatrixWorld(true);
        resize();
        saveView();
        render();
      };
      leaveSketchView.current = () => restoreSketchCamera();
      observer = new ResizeObserver(resize);
      observer.observe(host.current);
      fit.current();
      const saved = viewState?.current;
      if (saved?.boardId === board.id) {
        extent = saved.extent;
        camera.position.fromArray(saved.position);
        camera.up.fromArray(saved.up);
        camera.zoom = saved.zoom;
        orbit.target.fromArray(saved.target);
        resize();
        orbit.update();
      }
      saveView = () => {
        if (viewState)
          viewState.current = {
            boardId: board.id,
            position: camera.position.toArray(),
            target: orbit!.target.toArray(),
            up: camera.up.toArray(),
            zoom: camera.zoom,
            extent,
            orthographic: camera instanceof THREE.OrthographicCamera,
            modelsVisible: modelsVisibleRef.current,
            boardDisplay: { ...displayRef.current },
            referencePlaneVisible: referencePlaneVisibleRef.current,
            cadVisible: cadState.current.cadVisible,
          };
      };
      const raycaster = new THREE.Raycaster();
      const pointRay = (point: { x: number; y: number }) => {
        camera.updateMatrixWorld(true);
        raycaster.setFromCamera(
          new THREE.Vector2(
            point.x / 500 - 1,
            1 - point.y / ((500 * host.current!.clientHeight) / host.current!.clientWidth),
          ),
          camera,
        );
      };
      measurePoint.current = (point, snap = true) => {
        pointRay(point);
        const hits = raycaster.intersectObject(group, true);
        return modelMeasurementPoint(
          hits,
          snap
            ? {
                project: (at) => projectMeasurement.current(at),
                pointer: {
                  x: (point.x * host.current!.clientWidth) / 1000,
                  y: (point.y * host.current!.clientWidth) / 1000,
                },
                tolerance: 8,
                visible: (at, component) => {
                  const projected = projectMeasurement.current(at);
                  if (!projected) return false;
                  pointRay({
                    x: (projected.x / host.current!.clientWidth) * 1000,
                    y: (projected.y / host.current!.clientWidth) * 1000,
                  });
                  const hits = raycaster.intersectObject(group, true);
                  const hit = modelMeasurementPoint(hits);
                  if (hit && component) {
                    // A body center lies inside its mesh. Its projection must still hit this
                    // visible component first, rather than a covering part or the board.
                    const surface = hits.find(
                      (candidate) =>
                        Math.hypot(
                          candidate.point.x - hit.x,
                          candidate.point.y + hit.y,
                          candidate.point.z - hit.z,
                        ) < 0.0001,
                    );
                    for (
                      let node: THREE.Object3D | null = surface?.object ?? null;
                      node;
                      node = node.parent
                    )
                      if (node === component) return true;
                    return false;
                  }
                  return !!hit && Math.hypot(hit.x - at.x, hit.y - at.y, hit.z - at.z) < 0.0001;
                },
              }
            : undefined,
        );
      };
      projectMeasurement.current = (point) => {
        if (!host.current) return null;
        camera.updateMatrixWorld(true);
        const projected = new THREE.Vector3(point.x, -point.y, point.z).project(camera);
        if (
          ![projected.x, projected.y, projected.z].every(Number.isFinite) ||
          projected.z < -1 ||
          projected.z > 1
        )
          return null;
        return {
          x: ((projected.x + 1) * host.current.clientWidth) / 2,
          y: ((1 - projected.y) * host.current.clientHeight) / 2,
        };
      };
      measurementScale.current = () => visibleHeight() / (host.current?.clientHeight || 1);
      readScale.current = () => ({
        spacing: measurementScale.current(),
        axes: modelScaleAxes(camera),
      });
      const pickAt = (point: { x: number; y: number }, options: ModelPickOptions) => {
        if (!options.cad && !options.components && !options.board)
          return modelPickResult([], options);
        pointRay(point);
        return modelPickResult(raycaster.intersectObject(group, true), options);
      };
      const cadPickEnabled = () =>
        cadState.current.cadSelectable &&
        cadState.current.cadVisible &&
        cadGroup.children.length > 0;
      pickCad.current = (point) => pickAt(point, { cad: cadPickEnabled(), components: false }).cad;
      pickCadEdge.current = (point, objectId) => {
        const candidate = objectId
          ? cadState.current.modelCad?.objects.find(
              (object) => object.id === objectId && !object.edgeTreatment,
            )
          : cadState.current.edgeSelection?.object;
        if (
          !candidate ||
          !(cadState.current.selectionFilters.edges || cadState.current.selectionFilters.lines) ||
          !cadState.current.cadVisible ||
          !cadState.current.cadSelectable ||
          !host.current
        )
          return null;
        return pickModelCadEdge({
          object: candidate,
          camera,
          viewport: { width: host.current.clientWidth, height: host.current.clientHeight },
          point: {
            x: (point.x * host.current.clientWidth) / 1000,
            y: (point.y * host.current.clientWidth) / 1000,
          },
          scene: group,
          target: cadGroup.children.find((mesh) => mesh.userData.modelCadId === candidate.id),
          allowedKinds: cadState.current.selectionFilters.edges ? undefined : ['line'],
        });
      };
      pickUnselectedCadEdge.current = (point) => {
        for (const object of cadState.current.modelCad?.objects ?? []) {
          if (object.edgeTreatment || object.kind === 'boolean') continue;
          const edgeId = pickCadEdge.current(point, object.id);
          if (edgeId) return { id: object.id, edgeId };
        }
        return null;
      };
      pickInteraction.current = (point) =>
        pickAt(point, {
          cad: cadPickEnabled(),
          components: modelsSelectableRef.current,
          board: modelsSelectableRef.current,
        });
      cadPoint.current = (point) => {
        pointRay(point);
        const sketch = cadRef.current.sketch;
        if (cadRef.current.sketchPhase === 'sketch' && sketch) {
          const { center, u, v, normal } = modelCadSketchFrame(sketch.plane, sketch.origin);
          const projected = raycaster.ray.intersectPlane(
            new THREE.Plane().setFromNormalAndCoplanarPoint(normal, center),
            new THREE.Vector3(),
          );
          if (!projected) return null;
          projected.sub(center);
          return { x: projected.dot(u), y: projected.dot(v) };
        }
        const z = cadState.current.preview?.position.z ?? board.thickness / 2;
        const projected = raycaster.ray.intersectPlane(
          new THREE.Plane(new THREE.Vector3(0, 0, 1), -z),
          new THREE.Vector3(),
        );
        return projected && Number.isFinite(projected.x) && Number.isFinite(projected.y)
          ? { x: projected.x, y: -projected.y }
          : null;
      };
      const pick = (point: { x: number; y: number }) => {
        return pickAt(point, {
          cad: false,
          components: modelsSelectableRef.current,
        }).footprint;
      };
      pickAnnotation.current = pick;
      updateAnnotationView.current = () => {
        if (!host.current || !renderer || !annotatingRef.current) return;
        const ratio = host.current.clientHeight / host.current.clientWidth;
        const elements: ObjectAnnotationView['elements'] = [];
        if (components.visible && modelsSelectableRef.current)
          for (const object of components.children) {
            if (!object.visible || !object.userData.footprintId) continue;
            const box = new THREE.Box3().setFromObject(object);
            if (box.isEmpty()) continue;
            const points = [box.min.x, box.max.x].flatMap((x) =>
              [box.min.y, box.max.y].flatMap((y) =>
                [box.min.z, box.max.z].map((z) => new THREE.Vector3(x, y, z).project(camera)),
              ),
            );
            const x = Math.max(0, Math.min(...points.map((p) => (p.x + 1) * 500)));
            const y = Math.max(0, Math.min(...points.map((p) => (1 - p.y) * 500 * ratio)));
            const width = Math.min(1000, Math.max(...points.map((p) => (p.x + 1) * 500))) - x;
            const height =
              Math.min(1000 * ratio, Math.max(...points.map((p) => (1 - p.y) * 500 * ratio))) - y;
            const id = object.userData.footprintId as string;
            if (
              width > 0 &&
              height > 0 &&
              [
                [0.5, 0.5],
                [0.25, 0.25],
                [0.75, 0.25],
                [0.25, 0.75],
                [0.75, 0.75],
              ].some(([dx, dy]) => pick({ x: x + width * dx, y: y + height * dy }) === id)
            ) {
              const existing = elements.find((element) => element.id === id);
              if (existing) {
                const b = existing.bounds;
                existing.bounds = {
                  x: Math.min(x, b.x),
                  y: Math.min(y, b.y),
                  width: Math.max(x + width, b.x + b.width) - Math.min(x, b.x),
                  height: Math.max(y + height, b.y + b.height) - Math.min(y, b.y),
                };
              } else elements.push({ id, bounds: { x, y, width, height } });
            }
          }
        const basis = pcbObjectViewFingerprint({
          position: camera.position.toArray(),
          target: orbit!.target.toArray(),
          up: camera.up.toArray(),
          zoom: camera.zoom,
          extent,
          orthographic: camera instanceof THREE.OrthographicCamera,
          ratio,
          width: host.current.clientWidth,
          modelsVisible: components.visible,
          exploded: explodedRef.current,
          boardDisplay: displayRef.current,
          referencePlaneVisible: referencePlaneVisibleRef.current,
          renderEnabled: renderEnabledRef.current,
          darkCanvas: cadState.current.darkCanvas,
          grid: gridOptions.current,
          modelCad: cadState.current.modelCad,
          cadVisible: cadState.current.cadVisible,
          bodies: components.children
            .filter((object) => object.visible)
            .map((object) => object.uuid),
        });
        setAnnotationView((previous) =>
          previous.basis === basis && JSON.stringify(previous.elements) === JSON.stringify(elements)
            ? previous
            : { basis, ratio, elements },
        );
      };
      captureAnnotation.current = async (_svg, ids, bounds, markup) => {
        if (!renderer || !bounds) throw new Error('The 3D preview is not ready.');
        await waitForRender();
        requireCaptureView();
        const visible = previewGroup.visible;
        const sketchVisible = sketchGroup.visible;
        const edgeVisible = edgeGroup.visible;
        const faceVisible = faceGroup.visible;
        const ghostsVisible = operandGhostGroup.visible;
        previewGroup.visible = false;
        sketchGroup.visible = false;
        edgeGroup.visible = false;
        faceGroup.visible = false;
        operandGhostGroup.visible = false;
        updatePreviewVisibility();
        try {
          return selectionPaint.withoutSelection(() =>
            cadPaint.withoutSelection(() => {
              drawScene(
                components.visible
                  ? components.children.filter(
                      (object) => object.visible && ids.includes(object.userData.footprintId),
                    )
                  : [],
                false,
                true,
              );
              return captureObjectAnnotationImage(renderer!.domElement, bounds, markup);
            }),
          );
        } finally {
          previewGroup.visible = visible;
          sketchGroup.visible = sketchVisible;
          edgeGroup.visible = edgeVisible;
          faceGroup.visible = faceVisible;
          operandGhostGroup.visible = ghostsVisible;
          updatePreviewVisibility();
          render();
        }
      };
      updateActivity.current();
      applyDisplay.current = () => {
        applyModelBoardDisplay(boardGroups, displayRef.current);
        updateReferencePlane();
        clippingBoundsDirty.current = true;
        updateAnnotationView.current();
        saveView();
        render();
      };
      applyDisplay.current();
      exportPNG.current = async () => {
        if (!renderer) return;
        if (!annotatingRef.current && !renderEnabledRef.current) orbit?.update();
        await waitForRender();
        requireCaptureView();
        const previewVisible = previewGroup.visible;
        const sketchVisible = sketchGroup.visible;
        const edgeVisible = edgeGroup.visible;
        const faceVisible = faceGroup.visible;
        const ghostsVisible = operandGhostGroup.visible;
        previewGroup.visible = false;
        sketchGroup.visible = false;
        edgeGroup.visible = false;
        faceGroup.visible = false;
        operandGhostGroup.visible = false;
        updatePreviewVisibility();
        let image;
        try {
          image = selectionPaint.withoutSelection(() =>
            cadPaint.withoutSelection(() => {
              drawScene([], false, true);
              const canvas = renderer!.domElement;
              const max = Math.max(canvas.width, canvas.height);
              let output = canvas;
              if (max > 4096) {
                output = document.createElement('canvas');
                output.width = Math.max(1, Math.round((canvas.width * 4096) / max));
                output.height = Math.max(1, Math.round((canvas.height * 4096) / max));
                output.getContext('2d')!.drawImage(canvas, 0, 0, output.width, output.height);
              }
              return {
                dataUrl: output.toDataURL('image/png'),
                width: output.width,
                height: output.height,
              };
            }),
          );
        } finally {
          previewGroup.visible = previewVisible;
          sketchGroup.visible = sketchVisible;
          edgeGroup.visible = edgeVisible;
          faceGroup.visible = faceVisible;
          operandGhostGroup.visible = ghostsVisible;
          updatePreviewVisibility();
        }
        render();
        const name = await saveDrawingPNG(image, schematicRef.current?.title ?? 'board');
        if (name && !control.signal.aborted) setExportStatus(`Exported ${name}`);
      };
      await prepareModelShaders({
        compile: () => renderer!.compileAsync(scene, camera),
        dispose: disposeRenderer,
        signal: control.signal,
      });
      await yieldBuild();
      shadersReady = true;
      render();
      setReady(true);
      const footprints = board.footprints;
      const reportProgress = (completed: number, reference = '') => {
        if (control.signal.aborted) return;
        loadingProgress.current = { completed, total: footprints.length, reference };
        updateLoadingProgress.current(loadingProgress.current);
      };
      reportProgress(0);
      setStatus(componentLoadingStatus);
      let instanceCount = 0;
      const loadModel = (id: string, index: number) => {
        const key = `${id}:${index}`;
        if (!cache.has(key))
          cache.set(
            key,
            (async () => {
              const data = await previewModel(id, index, control.signal);
              if (control.signal.aborted) throw new Error('Preview cancelled.');
              vertexCount += data.reduce((n, m) => n + m.attributes.position.array.length, 0);
              if (vertexCount > 6000000)
                throw new Error('Component models exceed the board preview complexity limit.');
              // JSON decoding and mesh/material allocation must not occupy one
              // uninterrupted task, including when parsed CPU data is cached.
              await yieldBuild();
              const template = await modelMeshGroupAsync(data, yieldBuild);
              templates.add(template);
              return template;
            })(),
          );
        return cache.get(key)!;
      };
      const details = new Map<string, Promise<PreviewFootprint>>();
      let placementTask = performance.now();
      for (const [completed, f] of footprints.entries()) {
        if (performance.now() - placementTask > 8) {
          await yieldBuild();
          placementTask = performance.now();
        }
        await waitForActive();
        if (control.signal.aborted) return;
        const name = f.reference || f.libraryId;
        reportProgress(completed, name);
        try {
          if (!details.has(f.libraryId))
            details.set(f.libraryId, previewFootprint(f.libraryId, control.signal));
          let detail: PreviewFootprint | undefined;
          try {
            detail = await details.get(f.libraryId)!;
          } catch (error) {
            if (f.models === undefined) throw error;
          }
          const official = detail?.models ?? [];
          const assigned = f.models ?? resolveFootprintModels(f, detail!.footprint);
          if (assigned.length && assigned.every((model) => model.hidden)) {
            measurement.clear();
            clippingBoundsDirty.current = true;
            const estimate = estimates.get(f.id);
            if (estimate) estimate.visible = false;
            publishModelImport(() => {
              highlightModels.current();
              render();
            });
          }
          if (!assigned.length) {
            issues.push({
              message: `${name}: No 3D model`,
              footprintId: f.id,
              severity: 'warning',
            });
            continue;
          }
          for (const model of assigned) {
            if (model.hidden) continue;
            await waitForActive();
            if (control.signal.aborted) return;
            const index = official.findIndex((m) => modelKey(m.path) === modelKey(model.path));
            if (index < 0 && !projectSource) {
              componentImportFailed = true;
              issues.push({
                message: `${name}: 3D model unavailable`,
                footprintId: f.id,
                severity: 'warning',
              });
              continue;
            }
            if (++instanceCount > 512)
              throw new Error('The board exceeds the 512-model preview limit.');
            const template =
              index >= 0
                ? await loadModel(f.libraryId, index)
                : await modelMeshGroupAsync(
                    await previewAssignedModel(
                      projectSource!,
                      fileId,
                      f.id,
                      assigned.indexOf(model),
                      control.signal,
                    ),
                    yieldBuild,
                  );
            if (index < 0) {
              templates.add(template);
              vertexCount += template.children.reduce(
                (n, child) =>
                  n + ((child as THREE.Mesh).geometry?.attributes.position?.count ?? 0) * 3,
                0,
              );
              if (vertexCount > 6000000)
                throw new Error('Component models exceed the board preview complexity limit.');
            }
            if (control.signal.aborted) return;
            const placed = new THREE.Group(),
              transformed = cloneModelInstance(template, model.opacity),
              location = modelPlacement(f, board.thickness);
            transformed.scale.set(model.scale.x, model.scale.y, model.scale.z);
            transformed.rotation.set(
              -THREE.MathUtils.degToRad(model.rotation.x),
              -THREE.MathUtils.degToRad(model.rotation.y),
              -THREE.MathUtils.degToRad(model.rotation.z),
              'ZYX',
            );
            transformed.position.set(model.offset.x, model.offset.y, model.offset.z);
            placed.add(transformed);
            orderAssembly(placed);
            placed.userData.footprintId = f.id;
            placed.position.set(location.x, location.y, location.z);
            placed.rotation.set(location.flipped ? Math.PI : 0, 0, location.rotation, 'ZYX');
            components.add(placed);
            explodedScene.apply(explodedRef.current);
            measurement.clear();
            clippingBoundsDirty.current = true;
            const estimate = estimates.get(f.id);
            if (estimate) {
              estimate.visible = false;
            }
            publishModelImport(render);
          }
        } catch (e) {
          if (!control.signal.aborted) {
            componentImportFailed = true;
            issues.push({
              message: `${name}: ${(e as Error).message}`,
              footprintId: f.id,
              severity: 'error',
            });
          }
        } finally {
          reportProgress(completed + 1);
        }
      }
      if (!control.signal.aborted) {
        componentsSettled = true;
        completedCheckBasis.current = { board, schematic };
        setWarnings(issues);
        setStatus('');
        syncRenderImports();
        publishModelImport(render);
      }
    })().catch((e) => {
      if (!control.signal.aborted) {
        componentsSettled = true;
        componentImportFailed = true;
        setStatus((e as Error).message);
        setFailed(true);
        syncRenderImports();
      }
    });
    return () => {
      restoreSketchCamera();
      saveView();
      control.abort();
      observer?.disconnect();
      cancelAnimationFrame(frame);
      orbit?.dispose();
      renderer?.setAnimationLoop(null);
      selectionPaint.dispose();
      cadScene.dispose();
      previewScene.dispose();
      sketchScene.dispose();
      groundScene.dispose();
      disposeModelCadEdgeHighlight(edgeGroup);
      disposeModelCadFaceHighlight(faceGroup);
      operandGhosts.dispose();
      disposeModelGroup(group);
      templates.forEach(disposeModelGroup);
      textures.forEach((texture) => texture.dispose());
      disposeRenderer();
      renderer?.domElement.remove();
      fit.current = () => {};
      locateFootprint.current = () => {};
      zoom.current = () => {};
      orient.current = () => {};
      redraw.current = () => {};
      highlightModels.current = () => {};
      updateCad.current = () => {};
      updateCadPreview.current = () => {};
      updateCadSketch.current = () => {};
      updateCadEdges.current = () => {};
      retryCadGeometry.current = () => {};
      alignSketchView.current = () => {};
      leaveSketchView.current = () => {};
      paintCad.current = () => {};
      pickCad.current = () => null;
      pickCadEdge.current = () => null;
      pickUnselectedCadEdge.current = () => null;
      pickInteraction.current = () => ({ cad: null, footprint: null, board: false });
      measurePoint.current = () => null;
      projectMeasurement.current = () => null;
      measurementScale.current = () => 1;
      readScale.current = () => ({
        spacing: 1,
        axes: [
          { x: 1, y: 0 },
          { x: 0, y: 1 },
          { x: 0, y: -1 },
        ],
      });
      cadPoint.current = () => null;
      applyDisplay.current = () => {};
      applyExploded.current = () => {};
      applyProjection.current = () => {};
      applyRenderMode.current = () => {};
      updateActivity.current = () => {};
      exportPNG.current = async () => {};
      updateAnnotationView.current = () => {};
      pickAnnotation.current = () => null;
      captureAnnotation.current = async () => {
        throw new Error('The 3D preview is not ready.');
      };
    };
  }, [board, linkedCaptionBasis, retry, sceneImplementation]);
  const selectedFootprint = board.footprints.find((footprint) => selection.includes(footprint.id));
  const componentDeleteBlocked =
    explosionActive ||
    !active ||
    sourcePending ||
    !sidebarVisible ||
    !propertiesExpanded ||
    annotating ||
    cad.selectionBlocked ||
    Boolean(cad.tool) ||
    componentDeleteBusy ||
    !capabilityHost;
  async function removeComponent() {
    if (
      componentDeleteBlocked ||
      componentComposition.current ||
      !selectedFootprint ||
      !capabilityHost
    )
      return;
    const id = selectedFootprint.id;
    setComponentDeleteBusy(true);
    setComponentDeleteError('');
    try {
      await capabilityHost.execute(
        'layout.delete',
        {
          boardId: board.id,
          selection: [{ kind: 'footprint', id }],
        },
        { actor: 'human', expectedRevision: revision },
      );
      setSelection((previous) => previous.filter((selected) => selected !== id));
    } catch (cause) {
      setComponentDeleteError((cause as Error).message);
    } finally {
      setComponentDeleteBusy(false);
    }
  }
  const componentDeleteAction = selectedFootprint && (
    <PropertyDeleteButton
      disabled={componentDeleteBlocked}
      onClick={() => void removeComponent()}
    />
  );
  const interacting = !measuring && !annotating && !cad.tool && !cad.pan;
  const interactionDisabled = cad.selectionBlocked;
  const issueNavigationBlocked =
    sourcePending ||
    !ready ||
    failed ||
    cad.selectionBlocked ||
    Boolean(cad.tool) ||
    (!readOnly && !modelsSelectable);
  function locateModelCheckIssue(id: string) {
    if (!active || issueComposition.current || issueNavigationBlocked || hasOpenOverlay())
      return false;
    if (!board.footprints.some((footprint) => footprint.id === id)) return false;
    if (!readOnly) {
      cad.select(null);
      setBoardSelected(false);
      setAnnotating(false);
      closeMeasurement();
      setModelsVisible(true);
      setSelection([id]);
      showProperties();
    }
    locateFootprint.current(id);
    return true;
  }
  useEffect(() => {
    const complete =
      completedCheckBasis.current?.board === board &&
      completedCheckBasis.current?.schematic === schematic &&
      !status;
    onModelChecksChange?.({
      board,
      schematic,
      issues: modelCheckIssues,
      state: failed ? 'error' : complete ? 'ready' : 'loading',
      message: status,
      canLocate: !issueNavigationBlocked && complete,
    });
  }, [
    onModelChecksChange,
    board,
    schematic,
    modelCheckIssues,
    failed,
    status,
    issueNavigationBlocked,
    sourcePending,
    cad.selectionBlocked,
    cad.tool,
  ]);
  const lastCheckFocus = useRef<ModelCheckFocus | null>(null);
  useEffect(() => {
    if (!modelCheckFocus) {
      lastCheckFocus.current = null;
      return;
    }
    if (
      modelCheckFocus === lastCheckFocus.current ||
      modelCheckFocus.board !== board ||
      !active ||
      status
    )
      return;
    if (locateModelCheckIssue(modelCheckFocus.footprintId))
      lastCheckFocus.current = modelCheckFocus;
  }, [modelCheckFocus, board, active, status, issueNavigationBlocked]);
  const annotationDisabled =
    !ready || failed || !schematic || !annotationProps || annotationProps.disabled;
  function activateInteraction() {
    cad.clear();
    setAnnotating(false);
    closeMeasurement();
  }
  function activateAnnotation() {
    setAnnotationsOpened(true);
    setAnnotating(true);
    closeMeasurement();
  }
  const drawingSketch = cad.tool === 'sketch' && cad.sketchPhase === 'sketch';
  const pointerTool = Boolean(cad.tool && (cad.tool !== 'sketch' || drawingSketch));
  const errorFeedback = (
    <>
      {failed && (
        <span className="model-error-status" role="alert">
          <span>{status}</span>
          <button className="secondary" onClick={() => setRetry((n) => n + 1)}>
            Retry 3D preview
          </button>
        </span>
      )}
      {(cadGeometryErrors.document || cadGeometryErrors.preview) && (
        <span className="model-error-status" role="alert">
          <span>{cadGeometryErrors.preview || cadGeometryErrors.document}</span>
          <button type="button" className="secondary" onClick={() => retryCadGeometry.current()}>
            Retry CAD geometry
          </button>
        </span>
      )}
      {renderEnabled && renderImportStatus === 'component-error' && !failed && (
        <span className="model-error-status" role="alert">
          <span>Component model import failed. Render will continue after the models load.</span>
          <button className="secondary" onClick={() => setRetry((n) => n + 1)}>
            Retry component models
          </button>
        </span>
      )}
    </>
  );
  const renderWorking =
    renderEnabled &&
    (renderLoading ||
      renderProgress.target === 0 ||
      renderProgress.samples < renderProgress.target);
  const statusFeedback = renderError ? (
    <span className="pcb-model-status" data-model-render-status role="alert">
      {renderError}
    </span>
  ) : exportStatus ? (
    <span className="pcb-model-status" role="status">
      {exportStatus}
    </span>
  ) : renderEnabled && renderImportStatus === 'components' ? (
    <ModelLoadingStatus
      progress={loadingProgress}
      update={updateLoadingProgress}
      waitingForRender
    />
  ) : renderEnabled && renderImportStatus ? (
    <span
      className="pcb-model-status"
      data-model-render-status
      role={renderImportStatus === 'cad' ? 'status' : 'alert'}
    >
      {renderImportStatus === 'cad'
        ? 'Waiting for CAD model import…'
        : 'Render blocked by model import. Retry the failed models to continue.'}
    </span>
  ) : renderWorking ? (
    <span className="pcb-model-status" data-model-render-status role="status">
      {renderLoading || renderProgress.target === 0
        ? 'Preparing render…'
        : `${exporting ? 'Rendering image' : 'Rendering'} · ${renderProgress.samples} / ${renderProgress.target}`}
    </span>
  ) : exporting ? (
    <span className="pcb-model-status" role="status">
      Exporting image…
    </span>
  ) : status && !failed ? (
    status === componentLoadingStatus ? (
      <ModelLoadingStatus progress={loadingProgress} update={updateLoadingProgress} />
    ) : (
      <span role="status" className="pcb-model-status">
        {status}
      </span>
    )
  ) : null;
  const contextHasSelection = Boolean(selection.length || boardSelected || cad.selection.length);
  const contextToolActive = Boolean(cad.tool || cad.pan || measuring || annotating);
  const contextActions: CanvasMenuAction[] = measuring || annotating ? [] : [...cad.contextActions];
  if (interacting && (boardSelected || (selectedFootprint && selection.length === 1)))
    contextActions.push({
      id: 'properties',
      label: 'Properties',
      icon: SlidersHorizontal,
      disabled: sourcePending || !ready || failed || cad.selectionBlocked,
      run: showProperties,
    });
  if (interacting && selectedFootprint && selection.length === 1)
    contextActions.push({
      id: 'delete-component',
      label: 'Delete component',
      icon: Trash2,
      destructive: true,
      disabled: componentDeleteBlocked,
      run: removeComponent,
    });
  if (measuring || annotating)
    contextActions.push({
      id: 'cancel',
      label: 'Cancel tool',
      icon: X,
      run: () => {
        setAnnotating(false);
        closeMeasurement();
      },
    });
  return (
    <section
      ref={surface}
      className="pcb-model-preview"
      aria-label="3D board preview"
      data-model-theme={darkCanvas ? 'dark' : 'light'}
      data-read-only={readOnly || undefined}
    >
      <div
        className="model-editor-body"
        onFocusCapture={(event) => {
          if (cad.tool && !host.current?.contains(event.target as Node))
            placementPointer.current = null;
        }}
      >
        <div className="model-drawing-region editor-drawing-region">
          {!readOnly && (
            <div
              className="editor-toolbar pcb-object-toolbar"
              role="group"
              aria-label="Model tools"
            >
              <div className="editor-tool-group" role="group" aria-label="Canvas modes">
                <button
                  className={`tool-button${interacting ? ' active' : ''}`}
                  aria-label="Interaction mode"
                  title="Interaction mode"
                  aria-pressed={interacting}
                  disabled={interactionDisabled}
                  onClick={activateInteraction}
                >
                  <MousePointer2 size={17} />
                </button>
                <button
                  className={`tool-button${annotating ? ' active' : ''}`}
                  aria-label="Annotation mode"
                  title="Annotation mode"
                  aria-pressed={annotating}
                  disabled={annotationDisabled}
                  onClick={activateAnnotation}
                >
                  <MessageSquareText size={17} />
                </button>
              </div>
              {cad.toolbar}
            </div>
          )}
          <div className="pcb-object-stage">
            {!readOnly && cad.placementPanel}
            {!readOnly && cad.error}
            <div
              className="pcb-model-canvas"
              ref={host}
              aria-label="Interactive 3D board"
              tabIndex={0}
              data-models-selectable={modelsSelectable}
              data-cad-tool={cad.tool ?? 'select'}
              data-cad-selected-edges={cad.edgeSelection?.ids.length ?? 0}
              data-cad-selection-count={cad.selection.length}
              data-sketch-plane={cad.sketch?.plane}
              data-sketch-phase={cad.sketchPhase ?? undefined}
              style={{
                cursor: measuring || pointerTool ? 'crosshair' : cad.pan ? 'grab' : undefined,
              }}
              onPointerDownCapture={(e) => {
                if (readOnly) {
                  if (previewNavigationBlocked()) {
                    e.preventDefault();
                    e.stopPropagation();
                  } else e.currentTarget.focus({ preventScroll: true });
                  return;
                }
                if (active && !annotating && !hasOpenOverlay())
                  pressedPointers.current.add(e.pointerId);
                if (e.button !== 0 || !active || annotating || hasOpenOverlay()) return;
                e.currentTarget.focus({ preventScroll: true });
                selectionPointer.current = {
                  id: e.pointerId,
                  x: e.clientX,
                  y: e.clientY,
                  moved: false,
                };
                if (drawingSketch) {
                  const rect = e.currentTarget.getBoundingClientRect();
                  cad.sketchInput.current?.down(
                    cadPoint.current({
                      x: ((e.clientX - rect.left) / rect.width) * 1000,
                      y: ((e.clientY - rect.top) / rect.width) * 1000,
                    }),
                    measurementScale.current() * 8,
                  );
                  e.currentTarget.setPointerCapture(e.pointerId);
                  e.preventDefault();
                }
              }}
              onPointerMoveCapture={(e) => {
                if (readOnly) return;
                if (measuring && active && !hasOpenOverlay()) {
                  const rect = e.currentTarget.getBoundingClientRect();
                  measurementPointer.current = {
                    x: ((e.clientX - rect.left) / rect.width) * 1000,
                    y: ((e.clientY - rect.top) / rect.width) * 1000,
                    snap: !e.altKey,
                  };
                  if (e.buttons === 0) {
                    measurement.move(measurePoint.current(measurementPointer.current, !e.altKey));
                  }
                }
                if (pointerTool && active && !annotating) {
                  const rect = e.currentTarget.getBoundingClientRect();
                  if (e.buttons === 0 || placementPointer.current)
                    placementPointer.current = { clientX: e.clientX, clientY: e.clientY };
                  if (e.buttons === 0 || (drawingSketch && (e.buttons & 1) !== 0))
                    cad.canvasMove(
                      cadPoint.current({
                        x: ((e.clientX - rect.left) / rect.width) * 1000,
                        y: ((e.clientY - rect.top) / rect.width) * 1000,
                      }),
                    );
                }
                const pointer = selectionPointer.current;
                if (
                  pointer?.id === e.pointerId &&
                  Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) > 4
                )
                  pointer.moved = true;
              }}
              onPointerUpCapture={(e) => {
                if (readOnly) return;
                pressedPointers.current.delete(e.pointerId);
                if (cad.tool) redraw.current();
                const pointer = selectionPointer.current;
                selectionPointer.current = null;
                if (drawingSketch && e.button === 0 && pointer?.id === e.pointerId) {
                  const rect = e.currentTarget.getBoundingClientRect();
                  cad.sketchInput.current?.up(
                    cadPoint.current({
                      x: ((e.clientX - rect.left) / rect.width) * 1000,
                      y: ((e.clientY - rect.top) / rect.width) * 1000,
                    }),
                  );
                  if (e.currentTarget.hasPointerCapture(e.pointerId))
                    e.currentTarget.releasePointerCapture(e.pointerId);
                  return;
                }
                if (
                  e.button !== 0 ||
                  !pointer ||
                  pointer.id !== e.pointerId ||
                  pointer.moved ||
                  Math.hypot(e.clientX - pointer.x, e.clientY - pointer.y) > 4 ||
                  !active ||
                  annotating ||
                  hasOpenOverlay()
                )
                  return;
                const rect = e.currentTarget.getBoundingClientRect();
                const point = {
                  x: ((e.clientX - rect.left) / rect.width) * 1000,
                  y: ((e.clientY - rect.top) / rect.width) * 1000,
                };
                if (measuring) {
                  measurement.place(measurePoint.current(point, !e.altKey));
                  return;
                }
                if (!cad.tool && cad.pan) return;
                if (cad.tool === 'sketch') return;
                if (cad.tool === 'boolean') {
                  const hit = pickInteraction.current(point).cad;
                  if (hit)
                    cad.selectGeometry(
                      { kind: 'body', objectId: hit.id },
                      e.shiftKey || isCommandModifier(e),
                    );
                  return;
                }
                if (cad.tool) {
                  if (cad.edgeSelection) {
                    cad.toggleEdge(pickCadEdge.current(point));
                    return;
                  }
                  void cad.canvasClick(cadPoint.current(point));
                  return;
                }
                if (cad.pan) return;
                if (cad.edgeSelection) {
                  const edge = pickCadEdge.current(point);
                  if (edge) {
                    cad.toggleEdge(edge, e.shiftKey || isCommandModifier(e));
                    showProperties();
                    return;
                  }
                }
                if (cad.selectionBlocked) return;
                const picked = pickInteraction.current(point);
                setBoardSelected(false);
                const hit = picked.cad;
                if (hit) {
                  const edgeId = pickCadEdge.current(point, hit.id);
                  let geometry: ModelCadSelection | null = null;
                  if (edgeId)
                    geometry = {
                      kind: selectionFilters.edges ? 'edge' : 'line',
                      objectId: hit.id,
                      edgeId,
                    };
                  else if (selectionFilters.bodies) geometry = { kind: 'body', objectId: hit.id };
                  else if (selectionFilters.faces) {
                    const body = modelCad?.objects.find((body) => body.id === hit.id);
                    const face = body && modelCadFaceAtPoint(body, hit.local, hit.normal);
                    if (face) geometry = { kind: 'face', objectId: hit.id, faceId: face.id };
                  }
                  cad.selectGeometry(geometry, e.shiftKey || isCommandModifier(e));
                  return;
                }
                if (!picked.footprint) {
                  const edge = pickUnselectedCadEdge.current(point);
                  if (edge) {
                    cad.selectGeometry(
                      {
                        kind: selectionFilters.edges ? 'edge' : 'line',
                        objectId: edge.id,
                        edgeId: edge.edgeId,
                      },
                      e.shiftKey || isCommandModifier(e),
                    );
                    return;
                  }
                }
                cad.select(null);
                if (!modelsSelectable) return;
                if (picked.board && !picked.footprint) {
                  setSelection([]);
                  setBoardSelected(true);
                  showProperties();
                  return;
                }
                const id = picked.footprint;
                setSelection((previous) =>
                  applySelection(previous, id ? [id] : [], selectionMode(e)),
                );
                if (id) showProperties();
              }}
              onPointerCancel={(e) => {
                if (readOnly) return;
                if (drawingSketch) cad.sketchInput.current?.cancelPointer();
                pressedPointers.current.delete(e.pointerId);
                selectionPointer.current = null;
              }}
              onLostPointerCapture={(e) => {
                if (readOnly) return;
                if (drawingSketch) cad.sketchInput.current?.cancelPointer();
                pressedPointers.current.delete(e.pointerId);
                selectionPointer.current = null;
              }}
              onDoubleClick={(e) => {
                if (readOnly) return;
                if (!drawingSketch || !active || annotating || hasOpenOverlay()) return;
                e.preventDefault();
                cad.sketchInput.current?.closeProfile();
              }}
              onPointerLeave={() => {
                if (readOnly) return;
                placementPointer.current = null;
                measurementPointer.current = null;
                if (measuring) measurement.move(null);
              }}
              onWheelCapture={(e) => {
                if (readOnly) {
                  if (previewNavigationBlocked()) {
                    e.preventDefault();
                    e.stopPropagation();
                  }
                  return;
                }
                if (
                  !pointerTool ||
                  !active ||
                  annotating ||
                  hasOpenOverlay() ||
                  !placementPointer.current
                )
                  return;
                placementPointer.current = { clientX: e.clientX, clientY: e.clientY };
              }}
              onKeyDown={(e) => {
                if (
                  e.defaultPrevented ||
                  e.nativeEvent.isComposing ||
                  e.nativeEvent.keyCode === 229 ||
                  (e.target instanceof HTMLElement &&
                    (e.target.isContentEditable || e.target.closest('input, textarea, select'))) ||
                  (e.key !== 'Escape' && pressedPointers.current.size > 0)
                )
                  return;
                if (readOnly) {
                  if (
                    active &&
                    ready &&
                    !failed &&
                    !previewNavigationBlocked() &&
                    (e.code === 'Space' || e.key === ' ') &&
                    !e.altKey &&
                    !e.ctrlKey &&
                    !e.metaKey &&
                    !e.shiftKey
                  ) {
                    e.preventDefault();
                    if (!e.repeat) fit.current();
                  }
                  return;
                }
                if (measuring && e.key !== ' ' && e.code !== 'Space') {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    if (measurement.getSnapshot().start) measurement.clear();
                    else closeMeasurement();
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    e.stopPropagation();
                    measurement.confirm();
                  }
                  return;
                }
                if (
                  active &&
                  ready &&
                  !failed &&
                  !hasOpenOverlay() &&
                  (e.code === 'Space' || e.key === ' ') &&
                  !e.altKey &&
                  !e.ctrlKey &&
                  !e.metaKey &&
                  !e.shiftKey
                ) {
                  e.preventDefault();
                  if (!e.repeat) fit.current();
                  return;
                }
                if (active && !hasOpenOverlay() && cad.keyDown(e)) {
                  if (e.key === 'Escape') {
                    setSelection([]);
                    setBoardSelected(false);
                  }
                  e.preventDefault();
                  return;
                }
                if (e.key === 'Escape' && active && !hasOpenOverlay()) {
                  e.preventDefault();
                  setSelection([]);
                  setBoardSelected(false);
                }
              }}
            />
            {!readOnly && measuring && (
              <>
                <ModelMeasurementDrawing
                  measurement={measurement}
                  project={projectMeasurement}
                  redraw={redrawMeasurement}
                  unitsPerPixel={measurementScale}
                />
              </>
            )}
            {!readOnly && annotationsOpened && schematic && annotationProps && (
              <PCB3DAnnotations
                board={board}
                schematic={schematic}
                active={active && annotating && ready && !failed && !annotationProps.disabled}
                view={annotationView}
                {...annotationProps}
                pick={(point) => pickAnnotation.current(point)}
                captureImage={(...args) => captureAnnotation.current(...args)}
                onExit={() => setAnnotating(false)}
                onSelection={setSelection}
              />
            )}
            {!readOnly && (
              <CanvasContextMenu
                target={host}
                active={active}
                identity={revision || board}
                onError={setExportStatus}
                actions={[
                  ...contextActions,
                  ...(!contextToolActive && !contextHasSelection
                    ? [
                        {
                          id: 'fit',
                          label: 'Fit 3D board',
                          icon: Maximize,
                          disabled: !ready || failed,
                          run: () => fit.current(),
                        },
                        {
                          id: 'actual-size',
                          label: 'Actual size (100%)',
                          icon: Maximize,
                          disabled: !ready || failed,
                          run: () => zoom.current(null),
                        },
                        {
                          id: 'zoom-in',
                          label: 'Zoom in',
                          icon: Plus,
                          disabled: !ready || failed,
                          run: () => zoom.current(1.2),
                        },
                        {
                          id: 'zoom-out',
                          label: 'Zoom out',
                          icon: Minus,
                          disabled: !ready || failed,
                          run: () => zoom.current(1 / 1.2),
                        },
                        {
                          id: 'export',
                          label: 'Export image',
                          icon: ImageDown,
                          disabled: !ready || exporting || failed,
                          run: async () => {
                            setExporting(true);
                            setExportStatus('');
                            try {
                              await exportPNG.current();
                            } catch (error) {
                              setExportStatus((error as Error).message);
                            } finally {
                              setExporting(false);
                            }
                          },
                        },
                        {
                          id: 'isometric',
                          label: 'Isometric view',
                          icon: Box,
                          separated: true,
                          disabled: !ready || failed,
                          run: () => orient.current('isometric'),
                        },
                        {
                          id: 'top',
                          label: 'Top view',
                          icon: Box,
                          disabled: !ready || failed,
                          run: () => orient.current('top'),
                        },
                      ]
                    : []),
                ]}
              />
            )}
            {ready && !failed && <ModelSpatialScale update={updateScale} read={readScale} />}
            {readOnly && !!modelCheckIssues.length && (
              <div className="model-canvas-controls">
                <details
                  className="pcb-model-issues"
                  onCompositionStart={() => {
                    issueComposition.current = true;
                  }}
                  onCompositionEnd={() => {
                    issueComposition.current = false;
                  }}
                  onKeyDown={(event) => {
                    if (
                      issueComposition.current ||
                      event.nativeEvent.isComposing ||
                      event.nativeEvent.keyCode === 229
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                    }
                  }}
                  onKeyUp={(event) => {
                    if (
                      issueComposition.current ||
                      event.nativeEvent.isComposing ||
                      event.nativeEvent.keyCode === 229
                    ) {
                      event.preventDefault();
                      event.stopPropagation();
                    }
                  }}
                >
                  <summary>
                    {modelErrorCount} {modelErrorCount === 1 ? 'error' : 'errors'} ·{' '}
                    {modelWarningCount} {modelWarningCount === 1 ? 'warning' : 'warnings'}
                  </summary>
                  <ul>
                    {modelCheckIssues.map((w, i) => (
                      <li key={i} data-severity={w.severity}>
                        {w.footprintId ? (
                          <button
                            type="button"
                            className="model-issue-locate"
                            aria-label={`Locate ${w.message}`}
                            disabled={
                              !active ||
                              issueNavigationBlocked ||
                              !board.footprints.some((f) => f.id === w.footprintId)
                            }
                            onClick={() => locateModelCheckIssue(w.footprintId!)}
                          >
                            {w.message}
                          </button>
                        ) : (
                          w.message
                        )}
                      </li>
                    ))}
                  </ul>
                  {readOnly && (
                    <button className="secondary" onClick={() => setRetry((n) => n + 1)}>
                      Retry component models
                    </button>
                  )}
                </details>
              </div>
            )}
            {(readOnly || !statusBar) && statusFeedback}
            {errorTarget ? (
              createPortal(errorFeedback, errorTarget)
            ) : failed ||
              cadGeometryErrors.document ||
              cadGeometryErrors.preview ||
              (renderEnabled && renderImportStatus === 'component-error') ? (
              <div className="model-inline-errors">{errorFeedback}</div>
            ) : null}
          </div>
          {!readOnly && rulePanel}
          {!readOnly && statusBar && cloneElement(statusBar, { center: statusFeedback })}
        </div>
        {!readOnly && (
          <InspectorResize
            target={propertiesDock}
            size={inspectorSize}
            onResize={setInspectorSize}
            label="model properties"
            axes={['width']}
            gutter
            hidden={!sidebarVisible}
            minWidth={280}
            bounds={() => ({
              width: Math.min(
                480,
                Math.max(0, (propertiesDock.current?.parentElement?.clientWidth ?? 480) - 172),
              ),
              height: propertiesDock.current?.parentElement?.clientHeight ?? 0,
            })}
          />
        )}
        {!readOnly && (
          <aside
            ref={propertiesDock}
            className="model-properties-dock editor-sidebar-sections"
            aria-label="Model sidebar"
            hidden={!sidebarVisible}
            style={{ width: inspectorSize.width }}
          >
            <EditorDisplayDrawer
              label="Properties"
              className="editor-properties-drawer"
              open={propertiesExpanded}
              onOpenChange={setPropertiesExpanded}
            >
              {cad.panel}
              <section
                className="model-properties-content"
                aria-label="Board properties"
                hidden={!boardSelected || cad.inspecting}
              >
                <div className="model-properties-body">
                  <NumberField
                    label="Board thickness (mm)"
                    value={board.thickness}
                    min={0.1}
                    max={20}
                    active={
                      active &&
                      boardSelected &&
                      sidebarVisible &&
                      propertiesExpanded &&
                      !sourcePending &&
                      !annotating &&
                      !cad.tool &&
                      ready &&
                      !failed &&
                      !cad.selectionBlocked
                    }
                    disabled={!onBoardThicknessChange}
                    onCommit={(thickness) => onBoardThicknessChange?.(board, thickness) ?? false}
                  />
                </div>
              </section>
              {!cad.inspecting && !boardSelected && (
                <section
                  className="model-properties-content"
                  aria-label={selectedFootprint ? 'Component properties' : 'Model properties'}
                  onCompositionStart={() => {
                    componentComposition.current = true;
                  }}
                  onCompositionEnd={() => {
                    componentComposition.current = false;
                  }}
                >
                  <div className="model-properties-body">
                    {selectedFootprint ? (
                      schematic ? (
                        <ComponentProperties
                          tabAction={componentDeleteAction}
                          footprint={selectedFootprint}
                          schematic={schematic}
                          active={active && !sourcePending && sidebarVisible && !explosionActive}
                          resetKey={active}
                          snap={(value) => value}
                          onFootprint={(footprint) =>
                            onFootprintChange?.(board, footprint) ?? false
                          }
                          onSavePartProperties={onSavePartProperties}
                          capabilityHost={capabilityHost}
                          fileId={fileId}
                          projectSource={projectSource}
                          getRevision={getRevision}
                          spiceAvailable={spiceAvailable}
                          onRequestSave={onRequestSave}
                        />
                      ) : (
                        <>
                          <PropertyActionRow action={componentDeleteAction} />
                          <p>Component schematic is unavailable.</p>
                        </>
                      )
                    ) : (
                      <PropertiesEmptyState icon={Box}>
                        Select an element to view its properties.
                      </PropertiesEmptyState>
                    )}
                    {componentDeleteError && (
                      <p className="dialog-error" role="alert">
                        {componentDeleteError}
                      </p>
                    )}
                  </div>
                </section>
              )}
            </EditorDisplayDrawer>
            <ModelDisplayPanel
              exploded={exploded}
              onExplodedChange={setExploded}
              explodedDisabled={cad.selectionBlocked || Boolean(cad.tool)}
              ready={ready && !failed}
              orthographic={orthographic}
              onOrthographicChange={setOrthographic}
              renderEnabled={renderEnabled}
              renderLoading={renderLoading}
              renderDisabled={Boolean(cad.tool || cad.preview || cad.selectionBlocked)}
              onRenderChange={(enabled) => {
                setRenderError('');
                setExportStatus('');
                setRenderLoading(enabled);
                setRenderEnabled(enabled);
              }}
              cadVisible={cadVisible}
              cadColors={cadColors}
              onCadVisibleChange={(visible) => {
                setCadVisible(visible);
                if (!visible) cad.clear();
              }}
              modelsVisible={modelsVisible}
              onModelsVisibleChange={setModelsVisible}
              boardDisplay={boardDisplay}
              onBoardDisplayChange={setBoardDisplay}
              referencePlaneVisible={referencePlaneVisible}
              onReferencePlaneVisibleChange={setReferencePlaneVisible}
              filters={selectionFilters}
              selectionDisabled={cad.selectionBlocked}
              onFiltersChange={changeModelFilters}
              onView={(view) => orient.current(view)}
            />
          </aside>
        )}
      </div>
    </section>
  );
}

export default memo(PCBModelPreview, (previous, next) => {
  const previouslyHidden = (previous.visible ?? previous.active ?? true) === false;
  const remainsHidden = (next.visible ?? next.active ?? true) === false;
  // The first hide still cancels tools and pauses the scene. Hidden editors have
  // no document/capability ownership; the next visible render receives all latest
  // props before editing resumes, including Source and expected-revision guards.
  if (previouslyHidden && remainsHidden && previous.active === next.active) return true;
  const keys = Object.keys(previous) as (keyof typeof previous)[];
  return (
    keys.length === Object.keys(next).length &&
    keys.every((key) => Object.is(previous[key], next[key]))
  );
});
