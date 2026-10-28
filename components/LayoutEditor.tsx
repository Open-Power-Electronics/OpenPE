'use client';

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SetStateAction,
  type Ref,
  type RefObject,
  type ComponentProps,
} from 'react';
import {
  CircleDot,
  CircuitBoard,
  Cpu,
  ImageDown,
  Maximize,
  MessageSquareText,
  Minus,
  MousePointer2,
  Plus,
  RotateCw,
  Route,
  Square,
  Trash2,
  Pentagon,
  PaintBucket,
  Scan,
  SquareDashed,
  X,
} from 'lucide-react';
import CanvasContextMenu from './CanvasContextMenu';
import PropertiesEmptyState from './PropertiesEmptyState';
import { type Circuit, type Point, uid } from '@/lib/circuit';
import { defaultLayoutGridSpacing } from '@/lib/layout-grid';
import {
  defaultLeftButtonDrag,
  pointerDragsObject,
  type LeftButtonDrag,
} from '@/lib/selection-drag';
import { layoutGridMetrics } from '@/lib/drawing-grid';
import { flushLayoutCamera } from '@/lib/layout-camera-presentation';
import {
  createLayoutCameraTrackBindings,
  type LayoutCameraTrackBinding,
} from './layoutCameraTargets';
import {
  choosePCBPointCandidate,
  defaultPCBSelectionFilters,
  mergePCBSelection,
  pcbGraphicSelectionEligible,
  pcbSelectionEligible,
  pcbZoneSelectionEligible,
  selectPCBPoint,
  selectPCBTrackPoint,
  selectPCBRectangle,
  type PCBSelectionFilters,
} from '@/lib/pcb-selection';
import { expandPCBTrackSelection } from '@/lib/pcb-track-selection';
import {
  createPCBTrackDrag,
  previewConstrainedPCBTrackDrag,
  type PCBTrackDragPreview,
} from '@/lib/pcb-track-drag';
import { createPCBTrackJointDrag } from '@/lib/pcb-track-joint-drag';
import {
  findPCBRectangle,
  pcbRectangleDragBounds,
  resizePCBRectangle,
  type PCBRectangle,
  type PCBRectangleHandle,
} from '@/lib/pcb-outline-resize';
import {
  invalidatePCBFill,
  type PCB,
  type Footprint,
  type CopperLayer,
  type BoardLayer,
} from '@/lib/pcb';
import { padCopperLayers, type Airwire } from '@/lib/pcb-connectivity';
import { createPCBRouter } from '@/lib/pcb-routing';
import { createPCBViaValidator } from '@/lib/pcb-via-routing';
import { createPCBRouteAnchorResolver, type PCBRouteAnchorResult } from '@/lib/pcb-route-anchor';
import {
  defaultPCBDisplay,
  boardOutlineMinWidth,
  pcbDisplayBounds,
  pcbDisplayLayers,
  pcbFootprintBodyBounds,
  pcbLayerColor,
  pcbDisplayLayerPaintOrder,
  type PCBDisplay,
} from '@/lib/pcb-display';
import { captureLayoutPNG, saveDrawingPNG } from '@/lib/drawing-export';
import {
  boardPolygons,
  defaultCopperFillClearance,
  fillCopperZones,
  polygonPath,
  worldZones,
  type Polygon,
} from '@/lib/pcb-polygons';
import {
  LayoutTrackDrawing,
  LayoutViaDrawing,
  LayoutViaDrillDrawing,
  LayoutZoneFillDrawing,
  LayoutZoneOutlineDrawing,
  LayoutGraphicDrawing,
} from './LayoutBoardDrawing';
import {
  LayoutFootprintGraphic,
  LayoutFootprintCaptions,
  LayoutFootprintDrills,
} from './LayoutFootprint';
import type { RuleCheckFocus } from '@/lib/design-rule-checks';
import RuleCheckMarker from './RuleCheckMarker';
import {
  createEmptyPCB,
  createPCBFootprint,
  assertPCBSelectionUnlocked,
  deletePCBSelection,
  flipPCBFootprint,
  movePCBSelection,
  padPosition,
  pcbBounds,
  projectPointToTrack,
  rotatePCBSelection,
  setPCBTrackProperties,
} from '@/lib/pcb-layout';
import type { AgentAnnotation } from '@/lib/agent-annotations';
import { annotationSelectionBounds } from '@/lib/annotation-screenshot';
import CanvasAnnotations, {
  type AnnotationMode,
  type CanvasAnnotationsHandle,
} from './CanvasAnnotations';
import LibraryChooser, { type FootprintDetail } from './LibraryChooser';
import Select from './Select';
import { NumberField } from './LayoutPropertyFields';
import LayoutProperties from './LayoutProperties';
import EditorStatusBar from './EditorStatusBar';
import CanvasCoordinates, { createCanvasCoordinates } from './CanvasCoordinates';
import {
  createLayoutCamera,
  createLayoutCameraApplicator,
  layoutZoomWidth,
  zoomLayoutView,
  LayoutCameraRender,
  LayoutCameraScaleRender,
  rebaseLayoutCameraPoint,
  type LayoutCameraPanLease,
} from './LayoutCamera';
import { createLayoutSelection } from './LayoutSelection';
import { createLayoutNetEdges, type LayoutNetEdges } from './layoutNetEdges';
import useRetainedElements from './useRetainedElements';
import { layoutFootprintLayerPasses } from './layoutLayerPasses';
import useRetainedElementBatches from './useRetainedElementBatches';
import {
  createPCBPresentationAnalysis,
  preparePCBTrackPresentation,
  preparePCBZoneOutlinePaths,
} from './pcbPresentationAnalysis';
import { isOwnedProjectNode, ownProjectData } from '@/lib/immutable-project';
import LayoutAppearancePanel, { type LayoutAppearanceTab } from './LayoutAppearancePanel';
import EditorDisplayDrawer from './EditorDisplayDrawer';
import InspectorResize, { type InspectorSize } from './InspectorResize';
import CopperFillSettings from './CopperFillSettings';
import { hasOpenOverlay } from './Dialog';
import type { CapabilityHost } from '@/api/capabilities';
const pixelsPerMM = 96 / 25.4;
const zoneOutlineWidth = 0.08;

const RetainedLayoutProperties = memo(
  function RetainedLayoutProperties({
    children,
  }: {
    visible: boolean;
    shown: boolean;
    children: () => ReactNode;
  }) {
    return children();
  },
  // The first hidden render deactivates fields and portals. Later hidden
  // previews retain that tree; revealing always renders the latest document.
  (previous, next) => !previous.visible && !next.visible && previous.shown === next.shown,
);

type Selection = { kind: 'footprint' | 'track' | 'via' | 'graphic' | 'zone'; id: string };
type SelectionCandidate = { id: string; directFootprintCaption?: boolean } & (
  { selection: Selection; padId?: never } | { padId: string; selection?: never }
);
type Tool = 'select' | 'hand' | 'place' | 'route' | 'via' | 'outline' | 'zone' | 'annotate';
type View = { x: number; y: number; width: number };
type RouteLeg = {
  points: Point[];
  layer: CopperLayer;
  via: PCB['vias'][number];
  previous: { points: Point[]; waypoints: number[] };
};
type Props = {
  ruleFocus?: RuleCheckFocus | null;
  capabilityHost?: CapabilityHost;
  board?: PCB;
  schematic: Circuit;
  active?: boolean;
  visible?: boolean;
  sidebarVisible?: boolean;
  onShowSidebar?: () => void;
  onToggleSidebar?: () => void;
  onCommit: (board: PCB) => boolean;
  onSavePartProperties?: ComponentProps<typeof LayoutProperties>['onSavePartProperties'];
  onRequestSave?: (saveAs: boolean) => void;
  syncStatus?: { pending: boolean; error: string; warnings: string[] };
  annotations: AgentAnnotation[];
  annotationSessionId: string;
  onAnnotationsChange: (annotations: AgentAnnotation[]) => void;
  onAnnotationAdd?: () => void;
  annotationDisabled?: boolean;
  historyAction?: ReactNode;
  sidebarAction?: ReactNode;
  ruleAction?: ReactNode;
  analysisAction?: ReactNode;
  analysisDrawing?: ReactNode;
  analysisReadout?: ReactNode;
  analysisPanel?: ReactNode;
  onAnalysisProbe?: (point: Point | null) => void;
  listAction?: ReactNode;
  undoAction?: ReactNode;
  toolbarRef?: Ref<HTMLDivElement>;
  grid?: boolean;
  gridSpacing?: number;
  leftButtonDrag?: LeftButtonDrag;
  gridControl?: ReactNode;
  draftStatus?: string;
  agentContextRef?: RefObject<Record<string, unknown> | null>;
};

const same = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) < 0.0001;
const layerColor = pcbLayerColor;
const pointString = (points: Point[]) => points.map((p) => `${p.x},${p.y}`).join(' ');
function fittedView(
  board: PCB,
  width: number,
  height: number,
  mode: 'board' | 'all',
  layers: PCBDisplay,
): View {
  const b = pcbDisplayBounds(board, mode, layers);
  const worldWidth = Math.max(8, b.maxX - b.minX + 8, ((b.maxY - b.minY + 8) * width) / height);
  return {
    x: (b.minX + b.maxX - worldWidth) / 2,
    y: (b.minY + b.maxY - (worldWidth * height) / width) / 2,
    width: worldWidth,
  };
}

/** Two-layer PCB drawing. All content changes pass through the project transaction owner. */
function LayoutEditor({
  ruleFocus,
  board,
  schematic,
  active = true,
  visible = true,
  sidebarVisible = true,
  onShowSidebar,
  onCommit,
  onSavePartProperties,
  onRequestSave,
  syncStatus,
  annotations,
  annotationSessionId,
  onAnnotationsChange,
  onAnnotationAdd,
  annotationDisabled = false,
  historyAction,
  sidebarAction,
  ruleAction,
  analysisAction,
  analysisDrawing,
  analysisReadout,
  analysisPanel,
  onAnalysisProbe,
  listAction,
  undoAction,
  toolbarRef,
  grid = true,
  gridSpacing = defaultLayoutGridSpacing,
  leftButtonDrag = defaultLeftButtonDrag,
  gridControl,
  draftStatus,
  agentContextRef,
  capabilityHost,
}: Props) {
  const empty = useMemo(() => createEmptyPCB(), [schematic.id]);
  const pcb = board ?? empty;
  const copperLayers: readonly CopperLayer[] = pcb.layers;
  const svg = useRef<SVGSVGElement>(null);
  const focusCanvas = useCallback(() => svg.current?.focus({ preventScroll: true }), []);
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<CanvasAnnotationsHandle>(null);
  const pattern = useId().replaceAll(':', '');
  const toolSettingsId = useId();
  const [tool, setTool] = useState<Tool>('select');
  const [trackDrag, setTrackDrag] = useState<{
    mode: 'connected' | 'corner';
    pointer?: boolean;
    fillsHidden: boolean;
    start: Point;
    current: Point;
    pickup: Point;
    endpointTolerance: number;
    ids: Selection[];
    basis: PCB;
  } | null>(null);
  const toolSettings = tool === 'route' || tool === 'via' || tool === 'outline';
  const [selection, writeSelection] = useState<Selection[]>([]);
  const [selectionPaint] = useState(createLayoutSelection);
  const setSelection = useCallback((input: SetStateAction<Selection[]>) => {
    writeSelection((previous) => {
      const next = typeof input === 'function' ? input(previous) : input;
      return previous.length === next.length &&
        previous.every(
          (item, index) => item.kind === next[index].kind && item.id === next[index].id,
        )
        ? previous
        : next;
    });
  }, []);
  const [canvasFocusRequest, setCanvasFocusRequest] = useState(0);
  const [annotationIds, setAnnotationIds] = useState<string[]>([]);
  const [annotationMode, setAnnotationMode] = useState<AnnotationMode>('element');
  const [camera] = useState(() => createLayoutCamera({ x: -15, y: -15, width: 130 }));
  const committedCameraApply = useRef<(() => void) | null>(null);
  const committedCameraBinding = useRef<ReturnType<typeof createLayoutCameraApplicator> | null>(
    null,
  );
  const committedCameraTrackTargets = useRef<LayoutCameraTrackBinding | null>(null);
  const { view, setView } = camera;
  const [size, setSize] = useState({ width: 800, height: 550 });
  const ratio = size.width / Math.max(1, size.height);
  const renderedGrid = layoutGridMetrics(gridSpacing, view.width / size.width);
  const [darkBoard, setDarkBoard] = useState(false);
  const [layers, setLayers] = useState(defaultPCBDisplay);
  const [appearanceTab, setAppearanceTab] = useState<LayoutAppearanceTab>('layers');
  const [visualizationExpanded, setVisualizationExpanded] = useState(true);
  const [selectionFiltersOpen, setSelectionFiltersOpen] = useState(true);
  const [sidebarSize, setSidebarSize] = useState<InspectorSize>({});
  const sidebarDock = useRef<HTMLElement>(null);
  const appearancePanel = useRef<HTMLElement>(null);
  const [hiddenNets, setHiddenNets] = useState<Set<string>>(new Set());
  const [highlightNets, writeHighlightNets] = useState<Set<string>>(new Set());
  const setHighlightNets = useCallback((input: SetStateAction<Set<string>>) => {
    writeHighlightNets((previous) => {
      const next = typeof input === 'function' ? input(previous) : input;
      return previous.size === next.size && [...previous].every((id) => next.has(id))
        ? previous
        : next;
    });
  }, []);
  const expandedSelection = useRef<{ board: PCB; key: string } | null>(null);
  const [netSearch, setNetSearch] = useState('');
  const [filters, setFilters] = useState<PCBSelectionFilters>(defaultPCBSelectionFilters);
  const annotationSelectableIds = useMemo(
    () =>
      active && visible && tool === 'annotate'
        ? new Set(allVisibleSelections().map((item) => item.id))
        : undefined,
    [active && visible && tool === 'annotate', pcb, layers, filters],
  );
  const [inspectedPadId, setInspectedPadId] = useState('');
  const [exporting, setExporting] = useState(false);
  const [imageStatus, setImageStatus] = useState('');
  const [inspector, writeInspector] = useState(false);
  const [propertiesExpanded, setPropertiesExpanded] = useState(true);
  const [inspectorMounted, setInspectorMounted] = useState(false);
  const setInspector = useCallback((next: boolean) => {
    if (next) setInspectorMounted(true);
    writeInspector(next);
  }, []);
  const propertiesShown = inspector && tool !== 'annotate';
  const propertiesActive =
    propertiesShown && propertiesExpanded && sidebarVisible && visible && active;
  const propertiesPanel = useRef<HTMLElement>(null);
  const [inspectorFocus, setInspectorFocus] = useState(0);
  const focusedInspectorRequest = useRef(0);
  const [layer, setLayer] = useState<CopperLayer>('F.Cu');
  const [priorityLayer, setPriorityLayer] = useState<BoardLayer | null>(null);
  const [net, setNet] = useState('');
  const [width, setWidth] = useState(0.4);
  const [viaDiameter, setViaDiameter] = useState(0.8);
  const [viaDrill, setViaDrill] = useState(0.4);
  const routeMode = '45';
  const routeObstacleMode = 'walk-around';
  const routeClearance = 0.25;
  const dragObstacleMode = 'shove';
  const mouseDragTracks = 'connected';
  const [routePosture, setRoutePosture] = useState(false);
  const [route, setRoute] = useState<{
    points: Point[];
    waypoints: number[];
    netId: string;
    layer: CopperLayer;
    basis: PCB;
    legs: RouteLeg[];
  } | null>(null);
  const [viaTarget, setViaTarget] = useState<CopperLayer | null>(null);
  const [outline, writeOutline] = useState<Point | null>(null);
  const [outlineShape, setOutlineShape] = useState<'line' | 'rectangle'>('line');
  const [outlinePoints, setOutlinePoints] = useState<Point[]>([]);
  const [outlineWidth, setOutlineWidth] = useState(0.05);
  const outlinePublication = useRef<PCB | null>(null);
  const outlineBasis = useRef<PCB | null>(null);
  const [zoneDraft, setZoneDraft] = useState<Point[]>([]);
  const [zoneClearance, setZoneClearance] = useState(0.25);
  const [fillClearance, setFillClearance] = useState(defaultCopperFillClearance);
  const [fillSettingsOpen, setFillSettingsOpen] = useState(false);
  useEffect(() => {
    if (toolSettings || trackDrag) setFillSettingsOpen(false);
  }, [toolSettings, Boolean(trackDrag)]);
  const [zoneThermalGap, setZoneThermalGap] = useState(0.3);
  const [zoneThermalBridge, setZoneThermalBridge] = useState(0.3);
  const [cursor, setCursor] = useState<Point>({ x: 0, y: 0 });
  const cursorPosition = useRef(cursor);
  const [coordinates] = useState(createCanvasCoordinates);
  const [routePointer, setRoutePointer] = useState<{
    raw: Point;
    gridDisabled: boolean;
    objectSnap: boolean;
  } | null>(null);
  const [error, setError] = useState('');
  const handledRuleFocus = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!active || !ruleFocus || handledRuleFocus.current === ruleFocus.request) return;
    handledRuleFocus.current = ruleFocus.request;
    cancelGesture();
    setTool('select');
    setRoute(null);
    setTrackDrag(null);
    setViaTarget(null);
    setZoneDraft([]);
    setOutline(null);
    setInspector(false);
    setInspectedPadId('');
    const bounds = pcbBounds(pcb);
    const eligible = new Set(
      selectPCBRectangle(
        pcb,
        layers,
        filters,
        { x: bounds.maxX + 1, y: bounds.minY - 1 },
        { x: bounds.minX - 1, y: bounds.maxY + 1 },
      ).map((target) => `${target.kind}:${target.id}`),
    );
    setSelection(
      mergePCBSelection(
        [],
        ruleFocus.objectIds
          .flatMap((id) => {
            const target = objectSelection(pcb, id);
            if (target) return [target];
            const owner = pcb.footprints.find((footprint) =>
              footprint.pads.some((pad) => pad.id === id),
            );
            const pad = owner?.pads.find((pad) => pad.id === id);
            const visiblePad =
              pad &&
              owner &&
              layers.footprints &&
              (pad.type === 'np_thru_hole'
                ? layers['Edge.Cuts']
                : padCopperLayers(pcb, owner, pad).some((layer) => layers[layer as BoardLayer]));
            return visiblePad ? [{ kind: 'footprint' as const, id: owner.id }] : [];
          })
          .filter((target) => eligible.has(`${target.kind}:${target.id}`)),
      ),
    );
    if (ruleFocus.location) {
      const { x, y } = ruleFocus.location;
      setView((current) => {
        const width = Math.max(8, Math.min(current.width, 50));
        const pixels = Math.max(1, host.current?.getBoundingClientRect().width ?? size.width);
        const occluded = Math.min(
          Math.max(0, ruleFocus.occludedWidth ?? 0),
          Math.max(0, pixels - 16),
        );
        return {
          x: x - (width * (pixels - occluded)) / pixels / 2,
          y: y - width / ratio / 2,
          width,
        };
      });
    } else if (ruleFocus.objectIds.includes(pcb.id)) {
      const available = Math.max(16, size.width - Math.max(0, ruleFocus.occludedWidth ?? 0));
      let fitted: View;
      try {
        fitted = fittedView(pcb, available, size.height, 'board', layers);
      } catch {
        // Missing/invalid outlines are themselves board-wide DRC findings.
        fitted = fittedView(pcb, available, size.height, 'all', layers);
      }
      setView({ ...fitted, width: (fitted.width * size.width) / available });
    }
  }, [active, ruleFocus, pcb, ratio, layers, filters, size.width, size.height]);
  const [partId, setPartId] = useState('');
  const [choosing, setChoosing] = useState(false);
  const [placement, setPlacement] = useState<Footprint | null>(null);
  const [drag, setDrag] = useState<{
    start: Point;
    current: Point;
    ids: Selection[];
    basis: PCB;
    preview: PCB;
    mode: 'pointer' | 'move';
  } | null>(null);
  const [outlineResize, setOutlineResize] = useState<{
    basis: PCB;
    rectangle: PCBRectangle;
    handle: PCBRectangleHandle;
    start: Point;
    current: Point;
    step: number;
  } | null>(null);
  const [marquee, setMarquee] = useState<{
    start: Point;
    end: Point;
    selection: Selection[];
    mode: 'replace' | 'add' | 'toggle' | 'subtract';
    basis: PCB;
    clickCandidate?: SelectionCandidate;
  } | null>(null);
  const [gesture, setGesture] = useState<{
    start: Point;
    end: Point;
    points: Point[];
    id?: string;
  } | null>(null);
  const pointer = useRef<number | null>(null);
  const pointerStart = useRef<Point | null>(null);
  const pointerMoved = useRef(false);
  const pointerSelection = useRef<{ selection: Selection; basis: PCB } | null>(null);
  const pointerPosition = useRef<{ clientX: number; clientY: number } | null>(null);
  const lastCanvasPoint = useRef<Point | null>(null);
  const pan = useRef<{
    x: number;
    y: number;
    view: View;
    button: number;
    cameraLease: LayoutCameraPanLease | null;
  } | null>(null);
  const previousBoard = useRef(pcb);
  const fitted = useRef(false);
  const latestBoard = useRef(pcb);
  latestBoard.current = pcb;
  const selected = selection.length === 1 ? selection[0] : null;
  const selectedFootprint =
    selected?.kind === 'footprint' ? pcb.footprints.find((f) => f.id === selected.id) : undefined;
  const selectedTrack =
    selected?.kind === 'track' ? pcb.tracks.find((t) => t.id === selected.id) : undefined;
  const selectedVia =
    selected?.kind === 'via' ? pcb.vias.find((v) => v.id === selected.id) : undefined;
  const selectedGraphic =
    selected?.kind === 'graphic' ? pcb.graphics.find((g) => g.id === selected.id) : undefined;
  const selectedRectangle = useMemo(() => findPCBRectangle(pcb, selection), [pcb, selection]);
  const outlineResizePreview = useMemo(() => {
    if (!outlineResize || outlineResize.basis !== pcb) return null;
    try {
      const bounds = pcbRectangleDragBounds(
        outlineResize.rectangle,
        outlineResize.handle,
        {
          x: outlineResize.current.x - outlineResize.start.x,
          y: outlineResize.current.y - outlineResize.start.y,
        },
        outlineResize.step,
      );
      return { board: resizePCBRectangle(pcb, outlineResize.rectangle, bounds), bounds, error: '' };
    } catch (error) {
      return {
        board: pcb,
        bounds: outlineResize.rectangle.bounds,
        error: (error as Error).message,
      };
    }
  }, [pcb, outlineResize]);
  const selectedZone =
    selected?.kind === 'zone' ? pcb.zones.find((z) => z.id === selected.id) : undefined;
  const inspectedFootprint = inspectedPadId
    ? pcb.footprints.find((f) => f.pads.some((p) => p.id === inspectedPadId))
    : undefined;
  const inspectedPad = inspectedFootprint?.pads.find((p) => p.id === inspectedPadId);
  const propertiesSubject = inspectedPad
    ? `pad:${inspectedPad.id}`
    : selected
      ? `${selected.kind}:${selected.id}`
      : selection.length
        ? JSON.stringify(selection)
        : 'board';
  const unplaced = useMemo(() => {
    const parts = new Map(schematic.parts.map((part) => [part.id, part]));
    const placedIds = new Set(pcb.footprints.map((footprint) => footprint.symbolId));
    const placedRefs = new Set(
      pcb.footprints.map((footprint) => parts.get(footprint.symbolId ?? '')?.ref),
    );
    const references = new Set<string>();
    return schematic.parts.filter((part) => {
      if (references.has(part.ref)) return false;
      references.add(part.ref);
      return !placedIds.has(part.id) && !placedRefs.has(part.ref) && !part.ref.startsWith('#');
    });
  }, [schematic.parts, pcb.footprints]);
  const trackDragEngine = useMemo(() => {
    if (!trackDrag || trackDrag.basis !== pcb) return { engine: null, error: '' };
    try {
      return {
        engine:
          trackDrag.mode === 'corner'
            ? createPCBTrackJointDrag(pcb, trackDrag.ids[0].id, trackDrag.pickup, {
                clearance: routeClearance,
                endpointTolerance: trackDrag.endpointTolerance,
              })
            : createPCBTrackDrag(pcb, trackDrag.ids, {
                clearance: routeClearance,
                obstacleMode: dragObstacleMode,
              }),
        error: '',
      };
    } catch (error) {
      return { engine: null, error: (error as Error).message };
    }
  }, [
    pcb,
    trackDrag?.ids,
    trackDrag?.basis,
    trackDrag?.mode,
    trackDrag?.pickup,
    trackDrag?.endpointTolerance,
    routeClearance,
    dragObstacleMode,
  ]);
  const acceptedTrackDrag = useRef<{
    engine: NonNullable<typeof trackDragEngine.engine>;
    pickup: Point;
    posture: boolean;
    delta: Point;
    requested: Point;
    constraint: PCBTrackDragPreview['constraint'];
  } | null>(null);
  function interactiveTrackDragPreview(delta: Point): PCBTrackDragPreview {
    const engine = trackDragEngine.engine;
    if (!engine) return { board: pcb, error: trackDragEngine.error, changedIds: [] };
    const accepted = acceptedTrackDrag.current;
    const previous =
      accepted &&
      accepted.engine === engine &&
      accepted.pickup === trackDrag?.pickup &&
      accepted.posture === routePosture
        ? accepted
        : undefined;
    if (
      previous?.constraint &&
      delta.x === previous.requested.x &&
      delta.y === previous.requested.y
    ) {
      // Rejected host commits and unrelated renders retain the displayed
      // boundary exactly, after rechecking it with this gesture's engine.
      const repeated = engine.preview(previous.delta, routePosture);
      if (!repeated.error) return { ...repeated, constraint: previous.constraint };
    }
    return previewConstrainedPCBTrackDrag(engine, pcb, delta, routePosture, previous?.delta);
  }
  const trackDragPreview = useMemo<PCBTrackDragPreview | null>(() => {
    if (!trackDrag || trackDrag.basis !== pcb) return null;
    try {
      const delta = {
        x: trackDrag.current.x - trackDrag.start.x,
        y: trackDrag.current.y - trackDrag.start.y,
      };
      const preview = interactiveTrackDragPreview(delta);
      return preparePCBTrackPresentation(pcb, preview);
    } catch (error) {
      return { board: pcb, error: (error as Error).message, changedIds: [] };
    }
  }, [pcb, trackDrag, trackDragEngine, routePosture]);
  useLayoutEffect(() => {
    if (!trackDrag || !trackDragEngine.engine || trackDrag.basis !== pcb) {
      acceptedTrackDrag.current = null;
    } else if (trackDragPreview && !trackDragPreview.error) {
      acceptedTrackDrag.current = {
        engine: trackDragEngine.engine,
        pickup: trackDrag.pickup,
        posture: routePosture,
        requested: {
          x: trackDrag.current.x - trackDrag.start.x,
          y: trackDrag.current.y - trackDrag.start.y,
        },
        constraint: trackDragPreview.constraint,
        delta: trackDragPreview.constraint?.appliedDelta ?? {
          x: trackDrag.current.x - trackDrag.start.x,
          y: trackDrag.current.y - trackDrag.start.y,
        },
      };
    }
  }, [pcb, trackDrag, trackDragEngine, trackDragPreview, routePosture]);
  const trackDragChangedIds = useMemo(
    () => new Set(trackDragPreview?.changedIds),
    [trackDragPreview],
  );
  const routeAnchorResolver = useMemo(
    () => (tool === 'route' ? createPCBRouteAnchorResolver(pcb, layers) : null),
    [pcb, layers, tool],
  );
  const routeAnchor = useMemo<PCBRouteAnchorResult>(
    () =>
      tool === 'route' && !viaTarget && routePointer
        ? resolveRouteAnchor(routePointer)
        : { point: cursor, error: '' },
    [
      routeAnchorResolver,
      tool,
      viaTarget,
      routePointer,
      route?.layer,
      route?.netId,
      layer,
      gridSpacing,
      view.width,
      size.width,
      cursor,
    ],
  );
  const routeHead = routeAnchor.point;
  const placed = useMemo(
    () =>
      outlineResizePreview
        ? outlineResizePreview.board
        : trackDragPreview
          ? trackDragPreview.board
          : drag && drag.basis === pcb
            ? movePCBSelection(drag.preview, drag.ids, {
                x: drag.current.x - drag.start.x,
                y: drag.current.y - drag.start.y,
              })
            : pcb,
    [pcb, drag, trackDragPreview, outlineResizePreview],
  );
  const [cameraTrackBindings] = useState(createLayoutCameraTrackBindings);
  const committedCameraTrackBinding = useRef<LayoutCameraTrackBinding | null>(null);
  const cameraTrackBinding = useMemo(
    () => cameraTrackBindings.prepare(placed.tracks, committedCameraTrackBinding.current),
    [placed.tracks, cameraTrackBindings],
  );
  useLayoutEffect(() => {
    committedCameraTrackBinding.current = cameraTrackBinding;
  }, [cameraTrackBinding]);
  const displayBoard = useMemo(
    () =>
      placement
        ? { ...placed, footprints: [...placed.footprints, { ...placement, ...cursor }] }
        : placed,
    [placed, placement, cursor],
  );
  const presentationBoard = useMemo(() => invalidatePCBFill(pcb, placed), [pcb, placed]);
  const [presentationAnalysis] = useState(createPCBPresentationAnalysis);
  // Keep the original board's expensive fill/connectivity results independently
  // of the current preview so crossing the pickup or cancelling reuses them.
  const baselineConnectivity = useMemo(() => {
    try {
      return { ...presentationAnalysis.connectivity(pcb), error: '' };
    } catch (e) {
      return { edges: [], padCount: 0, warnings: [], error: (e as Error).message };
    }
  }, [pcb]);
  const connectivity = useMemo(() => {
    if (presentationBoard === pcb) return baselineConnectivity;
    try {
      return { ...presentationAnalysis.connectivity(presentationBoard), error: '' };
    } catch (e) {
      return { edges: [], padCount: 0, warnings: [], error: (e as Error).message };
    }
  }, [presentationBoard, pcb, baselineConnectivity]);
  const boardSurface = useMemo(() => {
    try {
      return polygonPath(boardPolygons(placed));
    } catch {
      return '';
    }
  }, [placed.graphics, placed.footprints]);
  const validNet = pcb.nets.some((n) => n.id === net) ? net : (pcb.nets[0]?.id ?? '');
  const netOptions = useMemo(
    () => pcb.nets.map((n) => ({ value: n.id, label: n.name })),
    [pcb.nets],
  );
  const routers = useMemo(
    () =>
      new Map<CopperLayer, { engine: ReturnType<typeof createPCBRouter> | null; error: string }>(
        pcb.layers.map((copperLayer) => {
          if (!route) return [copperLayer, { engine: null, error: '' }] as const;
          try {
            return [
              copperLayer,
              {
                engine: createPCBRouter(pcb, {
                  layer: copperLayer,
                  netId: route.netId,
                  width,
                  clearance: routeClearance,
                  walkAround: true,
                }),
                error: '',
              },
            ] as const;
          } catch (error) {
            return [copperLayer, { engine: null, error: (error as Error).message }] as const;
          }
        }),
      ),
    [pcb, route?.netId, Boolean(route), width, routeClearance],
  );
  const router = routers.get(route?.layer ?? layer) ?? { engine: null, error: '' };
  const viaObstacleBoard = useMemo(
    () =>
      route?.legs.length
        ? {
            ...pcb,
            vias: [...pcb.vias, ...route.legs.map((leg) => leg.via)],
          }
        : pcb,
    [pcb, route?.legs],
  );
  const viaValidator = useMemo(
    () =>
      tool !== 'via' && !route
        ? { validate: () => '' }
        : createPCBViaValidator(viaObstacleBoard, {
            netId: route?.netId ?? validNet,
            diameter: viaDiameter,
            drill: viaDrill,
            clearance: routeClearance,
          }),
    [
      viaObstacleBoard,
      route?.netId,
      Boolean(route),
      tool,
      validNet,
      viaDiameter,
      viaDrill,
      routeClearance,
    ],
  );
  const lockedViaValidators = useMemo(
    () =>
      route?.legs.map((leg) => ({
        via: leg.via,
        validator: createPCBViaValidator(
          {
            ...pcb,
            vias: [
              ...pcb.vias,
              ...route.legs.filter((other) => other !== leg).map((other) => other.via),
            ],
          },
          {
            netId: route.netId,
            diameter: leg.via.diameter,
            drill: leg.via.drill,
            clearance: routeClearance,
          },
        ),
      })) ?? [],
    [pcb, route?.legs, route?.netId, routeClearance],
  );
  const partsById = useMemo(
    () => new Map(schematic.parts.map((part) => [part.id, part])),
    [schematic.parts],
  );
  const netNames = useMemo(() => new Map(pcb.nets.map((n) => [n.id, n.name])), [pcb.nets]);
  const [emptyCopper] = useState(() => ({ fills: new Map<string, Polygon[]>(), error: '' }));
  const baselineCopper = useMemo(() => {
    if (!layers.copper) return emptyCopper;
    try {
      const fills = presentationAnalysis.copper(pcb);
      return fills.size ? { fills, error: '' } : emptyCopper;
    } catch (e) {
      return { fills: new Map<string, Polygon[]>(), error: (e as Error).message };
    }
  }, [pcb, layers.copper, emptyCopper]);
  const baselineCopperPaths = useMemo(
    () => new Map([...baselineCopper.fills].map(([id, polygons]) => [id, polygonPath(polygons)])),
    [baselineCopper.fills],
  );
  const fillsHidden = Boolean(trackDrag?.fillsHidden);
  const copper = useMemo(() => {
    if (!layers.copper || fillsHidden) return emptyCopper;
    if (presentationBoard === pcb) return baselineCopper;
    try {
      const fills = presentationAnalysis.copper(presentationBoard);
      return fills.size ? { fills, error: '' } : emptyCopper;
    } catch (e) {
      return { fills: new Map<string, Polygon[]>(), error: (e as Error).message };
    }
  }, [pcb, presentationBoard, baselineCopper, layers.copper, fillsHidden, emptyCopper]);
  const copperPaths = useMemo(
    () =>
      copper === baselineCopper
        ? baselineCopperPaths
        : new Map([...copper.fills].map(([id, polygons]) => [id, polygonPath(polygons)])),
    [copper, baselineCopper, baselineCopperPaths],
  );
  const nativeZones = useMemo(() => worldZones(pcb), [pcb.footprints, pcb.zones]);
  const selectionZones = useMemo(
    () => new Map(nativeZones.map((zone) => [zone.id, zone])),
    [nativeZones],
  );
  const footprintGraphics = useMemo(
    () =>
      new Map(
        pcb.footprints.flatMap((footprint) =>
          footprint.graphics.map((graphic) => [graphic.id, graphic] as const),
        ),
      ),
    [pcb.footprints],
  );
  const copperZones = useMemo(
    () =>
      layers.copper
        ? placed.footprints === pcb.footprints && placed.zones === pcb.zones
          ? nativeZones
          : worldZones(placed)
        : [],
    [placed.footprints, placed.zones, pcb.footprints, pcb.zones, nativeZones, layers.copper],
  );
  const committedDisplayLayers = useRef<BoardLayer[]>([]);
  const displayLayers = useMemo(() => {
    const next = pcbDisplayLayers(pcb);
    const previous = committedDisplayLayers.current;
    return previous.length === next.length &&
      previous.every((layer, index) => layer === next[index])
      ? previous
      : next;
  }, [pcb.layers, pcb.graphics, pcb.zones, pcb.footprints]);
  useLayoutEffect(() => {
    committedDisplayLayers.current = displayLayers;
  }, [displayLayers]);
  const physicalLayerOrder = useMemo(
    () =>
      pcbDisplayLayerPaintOrder(layers).filter(
        (name) => !name.endsWith('.Cu') || copperLayers.includes(name as CopperLayer),
      ),
    [layers, copperLayers],
  );
  const paintLayerOrder = useMemo(() => {
    const visible = physicalLayerOrder.filter((name) => layers[name]);
    if (priorityLayer === null || !visible.includes(priorityLayer)) return visible;
    return [...visible.filter((name) => name !== priorityLayer), priorityLayer];
  }, [physicalLayerOrder, layers, priorityLayer]);
  useEffect(() => {
    const copperLayer = copperLayers.includes(layer) ? layer : copperLayers[0];
    if (copperLayer !== layer) setLayer(copperLayer);
    if (priorityLayer !== null && !displayLayers.includes(priorityLayer)) setPriorityLayer(null);
  }, [displayLayers, copperLayers, layer, priorityLayer]);
  const appearanceBoard = useMemo(
    () => ({ layers: pcb.layers, nets: pcb.nets }),
    [pcb.layers, pcb.nets],
  );
  const [emptyNetEdges] = useState<readonly { netId: string }[]>([]);
  const [netEdgePresentation] = useState(createLayoutNetEdges);
  const committedNetEdges = useRef<LayoutNetEdges | null>(null);
  const appearanceEdges =
    appearanceTab === 'nets'
      ? netEdgePresentation.prepare(connectivity.edges, committedNetEdges.current)
      : emptyNetEdges;
  useLayoutEffect(() => {
    if (appearanceTab === 'nets') committedNetEdges.current = appearanceEdges;
  }, [appearanceTab, appearanceEdges]);
  const footprintBounds = useMemo(
    () =>
      new Map(
        displayBoard.footprints.map((footprint) => [
          footprint.id,
          pcbFootprintBodyBounds({ layers: pcb.layers }, footprint, layers),
        ]),
      ),
    [pcb.layers, displayBoard.footprints, layers],
  );
  const bodyTargetsInteractive = tool === 'annotate' || (tool === 'select' && filters.footprint);
  const zoneOwners = useMemo(
    () =>
      new Map(placed.footprints.flatMap((f) => (f.zones ?? []).map((z) => [z.id, f.id] as const))),
    [placed.footprints],
  );
  const committedZonePaths = useRef<ReturnType<typeof preparePCBZoneOutlinePaths>['cache']>(
    new Map(),
  );
  const committedZoneDrawingPaths = useRef<Map<string, string>>(new Map());
  const ownedZonePaths = useMemo(
    () =>
      isOwnedProjectNode(placed.zones)
        ? preparePCBZoneOutlinePaths(placed.zones, committedZonePaths.current)
        : null,
    [placed.zones],
  );
  const zonePaths =
    ownedZonePaths ?? preparePCBZoneOutlinePaths(placed.zones, committedZonePaths.current);
  const previousZoneDrawingPaths = committedZoneDrawingPaths.current;
  let zoneOutlinePaths = zonePaths.paths;
  // Track-only previews retain this private map. Compare entries only when
  // outline preparation actually supplied another map, preserving its order.
  if (
    zoneOutlinePaths !== previousZoneDrawingPaths &&
    zoneOutlinePaths.size === previousZoneDrawingPaths.size
  ) {
    const previousZoneDrawingEntries = [...previousZoneDrawingPaths];
    if (
      [...zoneOutlinePaths].every(([id, path], index) => {
        const previous = previousZoneDrawingEntries[index];
        return previous?.[0] === id && previous[1] === path;
      })
    )
      zoneOutlinePaths = previousZoneDrawingPaths;
  }
  useLayoutEffect(() => {
    committedZonePaths.current = zonePaths.cache;
    committedZoneDrawingPaths.current = zoneOutlinePaths;
  }, [zonePaths, zoneOutlinePaths]);
  useLayoutEffect(() => {
    coordinates.update(tool === 'route' && !viaTarget ? routeHead : cursorPosition.current);
  }, [coordinates, tool, viaTarget, routeHead]);
  const selectedIds = useMemo(
    () => new Set(tool === 'annotate' ? annotationIds : selection.map((item) => item.id)),
    [tool === 'annotate', tool === 'annotate' ? annotationIds : selection],
  );
  // Publish only committed selection state. Abandoned/concurrent renders cannot
  // change the retained drawing, and layout effects update paint before display.
  useLayoutEffect(() => {
    selectionPaint.update(selectedIds, trackDragChangedIds);
  }, [selectionPaint, selectedIds, trackDragChangedIds]);
  useLayoutEffect(() => {
    if (!agentContextRef) return;
    if (!visible) {
      agentContextRef.current = null;
      return;
    }
    const context = {
      boardId: pcb.id,
      tool,
      selection,
      annotationIds,
      annotationMode,
      viewport: { ...view, height: view.width / ratio },
      layers,
      filters,
      hiddenNets: [...hiddenNets],
      highlightNets: [...highlightNets],
      layer,
      priorityLayer,
      net: validNet,
      inspectedPadId,
      inspector,
      visualizationOpen: sidebarVisible && visualizationExpanded,
      appearanceTab,
      selectionFiltersOpen: sidebarVisible && selectionFiltersOpen,
      mouseDragTrackBehavior: mouseDragTracks,
      error,
      previewError: outlineResizePreview?.error || trackDragPreview?.error || routingIssue,
      boardOutlineResize:
        outlineResize && !outlineResize.rectangle.zoneId
          ? {
              graphicIds: [...outlineResize.rectangle.ids],
              handle: outlineResize.handle,
              bounds: outlineResizePreview ? { ...outlineResizePreview.bounds } : undefined,
              blocked: Boolean(outlineResizePreview?.error),
            }
          : null,
      zoneResize: outlineResize?.rectangle.zoneId
        ? {
            zoneId: outlineResize.rectangle.zoneId,
            handle: outlineResize.handle,
            bounds: outlineResizePreview ? { ...outlineResizePreview.bounds } : undefined,
            blocked: Boolean(outlineResizePreview?.error),
          }
        : null,
      connectedTrackDrag: trackDrag
        ? {
            mode: trackDrag.mode,
            trackIds: trackDrag.ids.map((item) => item.id),
            delta: {
              x: trackDrag.current.x - trackDrag.start.x,
              y: trackDrag.current.y - trackDrag.start.y,
            },
            clearance: routeClearance,
            obstacleMode: trackDrag.mode === 'connected' ? dragObstacleMode : undefined,
            blocked: Boolean(trackDragPreview?.error),
            constrained: Boolean(trackDragPreview?.constraint),
            appliedDelta: trackDragPreview?.constraint?.appliedDelta,
          }
        : null,
      routing: {
        width,
        clearance: routeClearance,
        angle: routeMode,
        obstacleMode: routeObstacleMode,
        useExistingTrackWidth: false,
        activeLayer: route?.layer ?? layer,
        viaTarget,
        lockedLegCount: route?.legs.length ?? 0,
        viaDiameter,
        viaDrill,
        head: routeHead,
        snapTarget: routeAnchor.target
          ? { kind: routeAnchor.target.kind, id: routeAnchor.target.id }
          : null,
      },
    };
    agentContextRef.current = context;
    return () => {
      if (agentContextRef.current === context) agentContextRef.current = null;
    };
  });
  // Coordinates update existing line nodes. Track metadata refreshes only
  // their hit targets; viewport and non-track tree changes replace the binding.
  useLayoutEffect(() => {
    const target = svg.current;
    if (!active || !visible || !target) return;
    const applyCamera = createLayoutCameraApplicator(target, {
      fixedTargets: true,
      compositor: true,
      panFrameReserve: true,
      frameReserve: true,
      frameScheduled: true,
    });
    let previousScale = Number.NaN;
    const apply = (immediate = false) => {
      if (svg.current !== target) return;
      const current = camera.getSnapshot();
      const scale = current.width / size.width;
      if (immediate) applyCamera.applyNow(current, size, scale !== previousScale);
      else applyCamera(current, size, scale !== previousScale);
      previousScale = scale;
      if (agentContextRef?.current)
        agentContextRef.current.viewport = { ...current, height: current.width / ratio };
    };
    const replay = () => apply(true);
    committedCameraApply.current = replay;
    committedCameraBinding.current = applyCamera;
    committedCameraTrackTargets.current = committedCameraTrackBinding.current;
    if (pan.current) pan.current.cameraLease = applyCamera.beginPan();
    const unsubscribe = camera.subscribe(apply);
    return () => {
      unsubscribe();
      applyCamera.dispose();
      if (committedCameraApply.current === replay) committedCameraApply.current = null;
      if (committedCameraBinding.current === applyCamera) {
        committedCameraBinding.current = null;
        committedCameraTrackTargets.current = null;
      }
    };
  }, [
    camera,
    active,
    visible,
    size.width,
    size.height,
    ratio,
    agentContextRef,
    placed.vias,
    placed.graphics,
    displayBoard.footprints,
    footprintBounds,
    bodyTargetsInteractive,
    layers,
    grid,
    gridSpacing,
    copperLayers,
    layer,
    priorityLayer,
  ]);
  useLayoutEffect(() => {
    const binding = committedCameraBinding.current;
    if (!binding || committedCameraTrackTargets.current === cameraTrackBinding) return;
    binding.refreshTracks();
    committedCameraTrackTargets.current = cameraTrackBinding;
  }, [cameraTrackBinding]);
  useLayoutEffect(() => {
    // An unrelated concurrent render may have captured older viewport props.
    // Reapply the current camera after that DOM commit, retaining the bound
    // targets and their scale state instead of querying the board again.
    flushLayoutCamera(svg.current);
    committedCameraApply.current?.();
  });
  useEffect(() => {
    cancelGesture();
    const eligible = new Set(allVisibleSelections().map((item) => `${item.kind}:${item.id}`));
    setAnnotationIds((current) => {
      const next = current.filter((id) => {
        const item = objectSelection(pcb, id);
        return item && eligible.has(`${item.kind}:${id}`);
      });
      return next.length === current.length ? current : next;
    });
    setSelection((current) => {
      const next = current.filter((item) => eligible.has(`${item.kind}:${item.id}`));
      return next.length === current.length ? current : next;
    });
    const retainPad = (current: string) => {
      if (!filters.pad) return '';
      const owner = pcb.footprints.find((footprint) =>
        footprint.pads.some((pad) => pad.id === current),
      );
      const pad = owner?.pads.find((item) => item.id === current);
      return owner &&
        pad &&
        layers.footprints &&
        (pad.type === 'np_thru_hole'
          ? layers['Edge.Cuts']
          : padCopperLayers(pcb, owner, pad).some((name) => layers[name as CopperLayer]))
        ? current
        : '';
    };
    if (inspectedPadId && !retainPad(inspectedPadId)) setInspector(false);
    setInspectedPadId(retainPad);
  }, [layers, filters, leftButtonDrag]);

  useEffect(() => {
    if (previousBoard.current === pcb) return;
    previousBoard.current = pcb;
    setOutlineResize(null);
    setDrag(null);
    setTrackDrag(null);
    setMarquee(null);
    setRoute(null);
    setRoutePointer(null);
    lastCanvasPoint.current = null;
    setViaTarget(null);
    if (outlinePublication.current === pcb) outlinePublication.current = null;
    else setOutline(null);
    setZoneDraft((current) => (current.length ? [] : current));
    setPlacement(null);
    setGesture(null);
    releasePointer();
    setSelection((current) => {
      const next = current.filter((s) => pcbSelectionEligible(pcb, s, filters));
      return next.length === current.length ? current : next;
    });
    setHighlightNets((current) => {
      const next = new Set([...current].filter((id) => pcb.nets.some((n) => n.id === id)));
      return next.size === current.size ? current : next;
    });
  }, [pcb]);
  useEffect(() => {
    if (active) return;
    cancelGesture();
    pointerPosition.current = null;
    lastCanvasPoint.current = null;
    setRoutePointer((current) =>
      current ? { ...current, gridDisabled: false, objectSnap: true } : current,
    );
  }, [active]);
  useLayoutEffect(() => {
    if (onAnalysisProbe) activate('select', true);
  }, [Boolean(onAnalysisProbe)]);
  useEffect(() => {
    if (visible) return;
    if (pan.current) releasePointer();
    // Leaving this view cancels unfinished drawing transactions. Temporary
    // modal input suspension keeps them, along with retained tool settings.
    setRoute(null);
    setRoutePointer(null);
    setViaTarget(null);
    setOutline(null);
    setZoneDraft((current) => (current.length ? [] : current));
    setPlacement(null);
    setChoosing(false);
    setFillSettingsOpen(false);
    setError('');
  }, [visible]);
  useEffect(() => {
    if (!active || !visible) return;
    const releasePan = () => {
      if (pan.current) releasePointer();
    };
    window.addEventListener('blur', releasePan);
    return () => window.removeEventListener('blur', releasePan);
  }, [active, visible]);
  useEffect(() => {
    if (!active || tool !== 'route') return;
    const released = (event: KeyboardEvent) => routingModifiers(event);
    const reset = () =>
      setRoutePointer((current) =>
        current ? { ...current, gridDisabled: false, objectSnap: true } : current,
      );
    document.addEventListener('keydown', released, true);
    document.addEventListener('keyup', released, true);
    window.addEventListener('blur', reset);
    return () => {
      document.removeEventListener('keydown', released, true);
      document.removeEventListener('keyup', released, true);
      window.removeEventListener('blur', reset);
    };
  }, [active, tool]);
  useEffect(() => {
    if (active && tool === 'place' && placement && !choosing)
      svg.current?.focus({ preventScroll: true });
  }, [active, tool, placement, choosing]);
  useEffect(() => {
    if (active && drag?.mode === 'move') svg.current?.focus({ preventScroll: true });
  }, [active, drag?.mode]);
  useEffect(() => {
    if (active && trackDrag) svg.current?.focus({ preventScroll: true });
  }, [active, Boolean(trackDrag)]);
  useEffect(() => {
    if (active && visible && canvasFocusRequest && !hasOpenOverlay()) focusCanvas();
  }, [canvasFocusRequest]);
  useEffect(() => {
    if (active && viaTarget) svg.current?.focus({ preventScroll: true });
  }, [active, viaTarget]);
  useLayoutEffect(() => setPropertiesExpanded(true), [inspectorFocus]);
  useEffect(() => {
    if (!propertiesActive || inspectorFocus === focusedInspectorRequest.current) return;
    focusedInspectorRequest.current = inspectorFocus;
    const control =
      propertiesPanel.current?.querySelector<HTMLElement>(
        '.layout-inspector-content input:not([disabled]), .layout-inspector-content [role="combobox"], .layout-inspector-content button:not([disabled])',
      ) ?? propertiesPanel.current?.querySelector<HTMLElement>('button');
    control?.focus({ preventScroll: true });
  }, [propertiesActive, inspectorFocus]);
  useLayoutEffect(() => {
    if (!host.current) return;
    let previous = host.current.getBoundingClientRect();
    const update = () => {
      const next = host.current?.getBoundingClientRect();
      if (!next || next.width < 1 || next.height < 1) return;
      const before = previous;
      setSize({ width: next.width, height: next.height });
      if (!fitted.current) {
        fitted.current = true;
        setView(
          fittedView(latestBoard.current, next.width, next.height, 'all', defaultPCBDisplay()),
        );
      } else if (before.width > 0)
        setView((current) => ({
          x: current.x + ((next.left - before.left) * current.width) / before.width,
          y: current.y + ((next.top - before.top) * current.width) / before.width,
          width: (current.width * next.width) / before.width,
        }));
      previous = next;
    };
    const observer = new ResizeObserver(update);
    observer.observe(host.current);
    update();
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const update = () => {
      if (!host.current) return;
      const rgb = getComputedStyle(host.current)
        .backgroundColor.match(/[\d.]+/g)
        ?.slice(0, 3)
        .map(Number);
      if (rgb?.length === 3)
        setDarkBoard((rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722) / 255 < 0.5);
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  function commit(next: PCB, knownChanged = false) {
    if (!active || next === pcb || (!knownChanged && JSON.stringify(next) === JSON.stringify(pcb)))
      return false;
    try {
      const accepted = onCommit(invalidatePCBFill(pcb, next));
      if (accepted) setError('');
      return accepted;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  }
  function editableSelection(ids: Selection[]) {
    try {
      assertPCBSelectionUnlocked(pcb, ids);
      return true;
    } catch (error) {
      setError((error as Error).message);
      return false;
    }
  }
  function updateTrack(changes: Parameters<typeof setPCBTrackProperties>[2]) {
    if (!selectedTrack) return false;
    try {
      return commit(setPCBTrackProperties(pcb, selectedTrack.id, changes));
    } catch (error) {
      setError((error as Error).message);
      return false;
    }
  }
  function activate(next: Tool, retainAnalysisProbe = false) {
    if (next === 'zone' && !copperLayers.some((item) => item === (priorityLayer ?? layer))) {
      setError('Select a copper layer before drawing a copper zone.');
      return;
    }
    if (!retainAnalysisProbe) onAnalysisProbe?.(null);
    cancelGesture();
    setTool(next);
    setFillSettingsOpen(false);
    setCursor(cursorPosition.current);
    setChoosing(false);
    setRoute(null);
    setRoutePointer(null);
    setViaTarget(null);
    setOutline(null);
    setZoneDraft((current) => (current.length ? [] : current));
    setPlacement(null);
    setGesture(null);
    setError('');
    if (next === 'outline')
      setLayers((current) => (current['Edge.Cuts'] ? current : { ...current, 'Edge.Cuts': true }));
    if (next === 'outline') setPriorityLayer('Edge.Cuts');
    if (next !== 'annotate') setAnnotationIds((current) => (current.length ? [] : current));
    if (next === 'zone') setInspector(true);
    svg.current?.focus({ preventScroll: true });
  }
  function releasePointer() {
    const id = pointer.current;
    const panning = pan.current;
    pointer.current = null;
    pointerStart.current = null;
    pointerMoved.current = false;
    pointerSelection.current = null;
    pan.current = null;
    host.current?.classList.remove('is-panning');
    panning?.cameraLease?.release();
    if (id !== null && svg.current?.hasPointerCapture(id)) svg.current.releasePointerCapture(id);
  }
  function cancelGesture() {
    flushLayoutCamera(svg.current);
    expandedSelection.current = null;
    releasePointer();
    setDrag(null);
    setTrackDrag(null);
    setMarquee(null);
    setGesture(null);
    setOutlineResize(null);
  }
  function beginOutlineResize(e: React.PointerEvent<SVGRectElement>, handle: PCBRectangleHandle) {
    if (!active || tool !== 'select' || !selectedRectangle || drag || trackDrag || hasOpenOverlay())
      return;
    e.preventDefault();
    e.stopPropagation();
    cancelGesture();
    focusCanvas();
    const start = canvasPoint(e, false);
    pointer.current = e.pointerId;
    pointerStart.current = { x: e.clientX, y: e.clientY };
    svg.current?.setPointerCapture(e.pointerId);
    setOutlineResize({
      basis: pcb,
      rectangle: selectedRectangle,
      handle,
      start,
      current: start,
      step: e.ctrlKey || e.metaKey ? 0 : gridSpacing,
    });
    setError('');
  }
  function updateRectangle(bounds: PCBRectangle['bounds']) {
    if (!selectedRectangle) return false;
    try {
      return commit(resizePCBRectangle(pcb, selectedRectangle, bounds));
    } catch (error) {
      setError((error as Error).message);
      return false;
    }
  }
  function changePriorityLayer(next: BoardLayer | null) {
    if (next === priorityLayer) return;
    if (next === null) {
      setPriorityLayer(null);
      return;
    }
    cancelGesture();
    setRoute(null);
    setRoutePointer(null);
    setViaTarget(null);
    setZoneDraft((current) => (current.length ? [] : current));
    setError('');
    setPriorityLayer(next);
    const copperLayer = copperLayers.some((layer) => layer === next);
    if (copperLayer) setLayer(next as CopperLayer);
    if (
      (!copperLayer && ['route', 'via', 'zone'].includes(tool)) ||
      (tool === 'outline' && next !== 'Edge.Cuts')
    ) {
      setTool('select');
      setOutline(null);
      setOutlinePoints([]);
    }
  }
  function fit(mode: 'board' | 'all') {
    try {
      setView(fittedView(pcb, size.width, size.height, mode, layers));
      flushLayoutCamera(svg.current);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function exportImage() {
    if (!svg.current || exporting) return;
    setExporting(true);
    setImageStatus('');
    try {
      const image = await captureLayoutPNG(svg.current, pcbDisplayBounds(pcb, 'board', layers));
      const name = await saveDrawingPNG(image, schematic.title);
      if (name) setImageStatus(`Exported ${name}`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExporting(false);
    }
  }
  function zoom(factor: number, at?: Point) {
    setView((v) => zoomLayoutView(v, factor, ratio, at));
  }
  function canvasPoint(
    e: { clientX: number; clientY: number },
    snapped = true,
    transform = svg.current!.getScreenCTM(),
  ): Point {
    const p = transform
      ? new DOMPoint(e.clientX, e.clientY).matrixTransform(transform.inverse())
      : cursorPosition.current;
    const presented = committedCameraBinding.current?.getPresentedView();
    // Navigation state is synchronous even when its DOM presentation waits
    // for the next frame. Rebase the displayed CTM to that exact latest pose.
    const current =
      transform && presented ? rebaseLayoutCameraPoint(p, presented, camera.getSnapshot()) : p;
    return snapped ? { x: snap(current.x), y: snap(current.y) } : current;
  }
  function updateCursor(next: Point, preview = true) {
    cursorPosition.current = next;
    coordinates.update(next);
    if (preview)
      setCursor((previous) => (previous.x === next.x && previous.y === next.y ? previous : next));
  }
  function snap(value: number) {
    return Number((Math.round(value / gridSpacing) * gridSpacing).toFixed(4));
  }
  function routeFreePoint(point: Point): Point {
    return { x: Number(point.x.toFixed(6)), y: Number(point.y.toFixed(6)) };
  }
  function routePointerAt(e: {
    clientX: number;
    clientY: number;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  }) {
    return {
      raw: canvasPoint(e, false),
      gridDisabled: e.ctrlKey || e.metaKey,
      objectSnap: !e.shiftKey,
    };
  }
  function resolveRouteAnchor(at: NonNullable<typeof routePointer>): PCBRouteAnchorResult {
    const gridPoint = at.gridDisabled
      ? routeFreePoint(at.raw)
      : { x: snap(at.raw.x), y: snap(at.raw.y) };
    // Keyboard routing can start before the Route tool's first render. Prepare
    // its visible copper on demand while leaving ordinary hover inexpensive.
    const resolver = routeAnchorResolver ?? createPCBRouteAnchorResolver(pcb, layers);
    return resolver.resolve(at.raw, {
      layer: route?.layer ?? layer,
      netId: route?.netId,
      tolerance: (view.width / size.width) * 8,
      gridPoint,
      objectSnap: at.objectSnap,
    });
  }
  function routingModifiers(e: {
    key: string;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  }) {
    if (tool !== 'route' || !['Control', 'Meta', 'Shift'].includes(e.key)) return;
    setRoutePointer(
      (current) =>
        current && {
          ...current,
          gridDisabled: e.ctrlKey || e.metaKey,
          objectSnap: !e.shiftKey,
        },
    );
  }
  function objectSelection(b: PCB, id: string): Selection | null {
    if (b.footprints.some((f) => f.id === id)) return { kind: 'footprint', id };
    if (b.tracks.some((t) => t.id === id)) return { kind: 'track', id };
    if (b.vias.some((v) => v.id === id)) return { kind: 'via', id };
    if (b.graphics.some((g) => g.id === id)) return { kind: 'graphic', id };
    if (b.zones.some((z) => z.id === id)) return { kind: 'zone', id };
    return null;
  }
  function allVisibleSelections() {
    const bounds = pcbBounds(pcb);
    return selectPCBRectangle(
      pcb,
      layers,
      filters,
      { x: bounds.maxX + 1, y: bounds.minY - 1 },
      { x: bounds.minX - 1, y: bounds.maxY + 1 },
    );
  }
  function hit(e: { target: EventTarget | null }) {
    const element = e.target as Element;
    const owner = element.closest('[data-selection-id], [data-footprint-body]');
    const id =
      owner?.getAttribute('data-selection-id') ?? owner?.getAttribute('data-footprint-body');
    const padId = element.closest('[data-pad-id]')?.getAttribute('data-pad-id');
    const footprint = pcb.footprints.find((f) => f.pads.some((p) => p.id === padId));
    const pad = footprint?.pads.find((p) => p.id === padId);
    const via = pcb.vias.find((v) => v.id === id);
    const track = pcb.tracks.find((t) => t.id === id);
    const graphicId = element
      .closest('[data-footprint-graphic]')
      ?.getAttribute('data-footprint-graphic');
    const graphic = graphicId ? footprintGraphics.get(graphicId) : null;
    const zoneId =
      element.closest('[data-pcb-zone-id], [data-copper-fill]')?.getAttribute('data-pcb-zone-id') ??
      element.closest('[data-copper-fill]')?.getAttribute('data-copper-fill');
    const zone = zoneId ? selectionZones.get(zoneId) : null;
    const eligible =
      (!element.closest('[data-footprint-captions]') || (filters.text ?? filters.graphic)) &&
      (!graphic || pcbGraphicSelectionEligible(graphic, filters)) &&
      (!zone || pcbZoneSelectionEligible(zone, filters));
    return { id, footprint, pad, via, track, eligible };
  }
  function openPlacement() {
    if (tool === 'place' && placement) {
      setPartId(placement.symbolId ?? '');
      setChoosing(true);
      return;
    }
    activate('place');
    setSelection([]);
    setInspectedPadId('');
    setInspector(false);
    setPartId(unplaced[0]?.id ?? '');
    setChoosing(true);
  }
  function chooseFootprint(detail: FootprintDetail) {
    if (!active || !visible || tool !== 'place') return;
    if (!unplaced.some((part) => part.id === partId)) {
      setPlacement(null);
      setChoosing(false);
      setError('The selected component is no longer available for footprint placement.');
      setCanvasFocusRequest((value) => value + 1);
      return;
    }
    try {
      const footprint = createPCBFootprint(detail, schematic, partId, cursorPosition.current);
      setPlacement(footprint);
      setChoosing(false);
      setTool('place');
      setError('');
      svg.current?.focus({ preventScroll: true });
    } catch (e) {
      setChoosing(false);
      setError((e as Error).message);
    }
  }
  function actionSelection(
    onChoose: (candidate: SelectionCandidate, pickup: Point, padId?: string) => void,
    kinds?: Selection['kind'][],
    includePads = false,
  ) {
    if (selection.length)
      return selection.filter((item) => pcbSelectionEligible(pcb, item, filters));
    const at = pointerPosition.current;
    if (!at) return [];
    try {
      const pickup = canvasPoint(at, false);
      const available = selectionCandidates(at, false, kinds?.length === 1 && kinds[0] === 'track');
      const padIds = new Set(
        available.flatMap((candidate) => (candidate.padId ? [candidate.padId] : [])),
      );
      const padOwners = new Set(
        filters.pad
          ? pcb.footprints
              .filter((footprint) => footprint.pads.some((pad) => padIds.has(pad.id)))
              .map((footprint) => footprint.id)
          : [],
      );
      const candidates = available.filter((candidate) =>
        candidate.selection
          ? (!kinds || kinds.includes(candidate.selection.kind)) &&
            !(
              filters.pad &&
              !includePads &&
              candidate.selection.kind === 'footprint' &&
              padOwners.has(candidate.selection.id)
            )
          : includePads,
      );
      const candidate = pointCandidate(at, candidates);
      if (candidate) {
        onChoose(candidate, pickup);
        return null;
      }
    } catch (error) {
      setError((error as Error).message);
    }
    return [];
  }
  function expandTracks(targets?: Selection[]) {
    if (tool !== 'select' || drag || trackDrag || marquee) return;
    const seeds =
      (
        targets ??
        actionSelection((candidate) => expandTracks([candidate.selection!]), ['track', 'via'])
      )?.filter((s) => s.kind === 'track' || s.kind === 'via') ?? [];
    if (!seeds.length) return;
    const keyOf = (items: Selection[]) =>
      items
        .map((s) => `${s.kind}:${s.id}`)
        .sort()
        .join('|');
    const previous = expandedSelection.current;
    const mode =
      previous?.board === pcb && previous.key === keyOf(selection) ? 'connected' : 'chain';
    try {
      const expanded = expandPCBTrackSelection(pcb, seeds, layers, filters, mode);
      const next = mergePCBSelection(selection, expanded, 'add');
      expandedSelection.current = { board: pcb, key: keyOf(next) };
      setSelection(next);
      setInspectedPadId('');
      setInspector(true);
      setError('');
      setCanvasFocusRequest((value) => value + 1);
    } catch (error) {
      setError((error as Error).message);
    }
  }
  function highlightSelectionNet(targets?: Selection[], padId?: string) {
    if (tool !== 'select' || drag || trackDrag || marquee) return;
    if (
      targets === undefined &&
      inspectedPad?.netId &&
      !selection.some((item) => ['track', 'via', 'zone'].includes(item.kind))
    ) {
      setHighlightNets(new Set([inspectedPad.netId]));
      setCanvasFocusRequest((value) => value + 1);
      return;
    }
    const ids =
      targets ??
      actionSelection(
        (candidate) =>
          highlightSelectionNet(candidate.selection ? [candidate.selection] : [], candidate.padId),
        ['track', 'via', 'zone'],
        true,
      );
    if (!ids) return;
    const nets = ids.flatMap((item) => {
      const netId =
        item.kind === 'track'
          ? pcb.tracks.find((t) => t.id === item.id)?.netId
          : item.kind === 'via'
            ? pcb.vias.find((v) => v.id === item.id)?.netId
            : item.kind === 'zone'
              ? pcb.zones.find((z) => z.id === item.id)?.netId
              : null;
      return netId ? [netId] : [];
    });
    const pad = padId
      ? pcb.footprints.flatMap((footprint) => footprint.pads).find((pad) => pad.id === padId)
      : inspectedPad;
    if (!nets.length && pad?.netId) nets.push(pad.netId);
    setHighlightNets(new Set(nets));
    setCanvasFocusRequest((value) => value + 1);
  }
  function selectCandidate(
    candidate: SelectionCandidate,
    mode: 'replace' | 'add' | 'toggle' | 'subtract',
  ) {
    if (candidate.selection && !pcbSelectionEligible(pcb, candidate.selection, filters)) return;
    if (!candidate.selection && !filters.pad) return;
    expandedSelection.current = null;
    if (!candidate.selection) {
      setInspectedPadId(candidate.padId);
      setSelection([]);
    } else {
      setInspectedPadId('');
      setSelection((current) => mergePCBSelection(current, [candidate.selection], mode));
    }
    setInspector(true);
  }
  function selectionCandidates(
    e: { clientX: number; clientY: number },
    includeFills = false,
    tracksOnly = false,
  ) {
    flushLayoutCamera(svg.current);
    const raw = canvasPoint(e, false);
    const margin = (view.width / size.width) * 3;
    // D/G rank only physical track surfaces within this same tolerance. DOM
    // caption/body/fill targets cannot contribute another winning track.
    if (tracksOnly)
      return selectPCBTrackPoint(pcb, layers, filters, raw, margin).map(
        (selection): SelectionCandidate => ({
          id: `${selection.kind}:${selection.id}`,
          selection,
        }),
      );
    const objects: Selection[] = [];
    const padIds = new Set<string>();
    const captionIds = new Set<string>();
    for (const element of document.elementsFromPoint(e.clientX, e.clientY)) {
      if (!svg.current?.contains(element)) continue;
      if (!includeFills && element.closest('[data-copper-fill]')) continue;
      const target = hit({ target: element });
      const object = target.id ? objectSelection(pcb, target.id) : null;
      if (
        target.eligible &&
        object &&
        pcbSelectionEligible(pcb, object, filters) &&
        (object.kind !== 'footprint' || layers.footprints)
      ) {
        objects.push(object);
        if (object.kind === 'footprint' && element.closest('[data-footprint-captions]'))
          captionIds.add(object.id);
      }
      if (filters.pad && target.pad) padIds.add(target.pad.id);
    }
    const candidates: SelectionCandidate[] = [...padIds].map((id) => ({
      id: `pad:${id}`,
      padId: id,
    }));
    const uniqueObjects = selectPCBPoint(pcb, layers, filters, raw, margin, {
      preparedFills: placed === pcb ? copper.fills : undefined,
      includeFills,
      preciseCandidates: objects,
      hasPrecisePad: candidates.length > 0,
    });
    for (const object of uniqueObjects) {
      candidates.push({
        id: `${object.kind}:${object.id}`,
        selection: object,
        ...(captionIds.has(object.id) ? { directFootprintCaption: true } : {}),
      });
    }
    return candidates;
  }
  function pointCandidate(
    at: { clientX: number; clientY: number },
    candidates = selectionCandidates(at),
  ) {
    return choosePCBPointCandidate(pcb, layers, candidates, canvasPoint(at, false), {
      tolerance: (view.width / size.width) * 3,
      tieTolerance: (view.width / size.width) * 0.1,
      priorityLayer: priorityLayer ?? undefined,
      layerOrder: physicalLayerOrder,
      filters,
      preparedFills: placed === pcb ? copper.fills : undefined,
    });
  }
  function selectionMode(e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) {
    return e.ctrlKey || e.metaKey
      ? e.shiftKey
        ? ('subtract' as const)
        : ('toggle' as const)
      : e.shiftKey
        ? ('add' as const)
        : ('replace' as const);
  }
  function beginMove(targets?: Selection[], pickup?: Point, padId?: string) {
    if (tool !== 'select' || drag || trackDrag || marquee || pointer.current !== null) return;
    const ids =
      targets ??
      actionSelection((candidate, pickup, padId) =>
        beginMove([candidate.selection!], pickup, padId),
      );
    if (!ids?.length || !editableSelection(ids)) return;
    const footprint =
      ids.length === 1 && ids[0].kind === 'footprint'
        ? pcb.footprints.find((f) => f.id === ids[0].id)
        : null;
    const at = pickup
      ? { x: snap(pickup.x), y: snap(pickup.y) }
      : pointerPosition.current
        ? canvasPoint(pointerPosition.current)
        : cursorPosition.current;
    const rawPickup =
      pickup ?? (pointerPosition.current ? canvasPoint(pointerPosition.current, false) : undefined);
    const pickupPadId =
      padId ??
      (footprint && rawPickup
        ? choosePCBPointCandidate(
            pcb,
            layers,
            footprint.pads.map((pad) => ({ padId: pad.id })),
            rawPickup,
            {
              tolerance: 0,
              filters: { ...filters, pad: true },
              priorityLayer: priorityLayer ?? undefined,
              layerOrder: physicalLayerOrder,
            },
          )?.padId
        : undefined);
    const pickupPad = footprint?.pads.find((pad) => pad.id === pickupPadId);
    const anchor = footprint
      ? pickupPad
        ? padPosition(footprint, pickupPad)
        : { x: footprint.x, y: footprint.y }
      : at;
    setSelection(ids);
    setInspectedPadId('');
    setInspector(true);
    setDrag({ start: anchor, current: at, ids, basis: pcb, preview: pcb, mode: 'move' });
    setError('');
  }
  function beginTrackDrag(
    mode: 'connected' | 'corner' = 'connected',
    targets?: Selection[],
    pickupOverride?: Point,
  ) {
    if (tool !== 'select' || drag || trackDrag || marquee || pointer.current !== null) return;
    let ids =
      targets ??
      actionSelection(
        (candidate, pickup) => beginTrackDrag(mode, [candidate.selection!], pickup),
        ['track'],
      );
    if (!ids?.length) return;
    if (ids.some((item) => item.kind !== 'track')) {
      setError(
        mode === 'corner'
          ? 'Choose only tracks for corner drag.'
          : 'Choose only tracks for connected drag.',
      );
      return;
    }
    if (!editableSelection(ids)) return;
    cancelGesture();
    const pickup = pickupOverride
      ? mode === 'corner'
        ? pickupOverride
        : { x: snap(pickupOverride.x), y: snap(pickupOverride.y) }
      : pointerPosition.current
        ? canvasPoint(pointerPosition.current, mode !== 'corner')
        : mode === 'corner'
          ? (lastCanvasPoint.current ?? cursorPosition.current)
          : cursorPosition.current;
    const endpointTolerance = (view.width / size.width) * 6;
    let at = pickup;
    if (mode === 'corner') {
      const distance = (id: string) => {
        const track = pcb.tracks.find((item) => item.id === id)!;
        const projected = projectPointToTrack(track, pickup);
        return (projected.x - pickup.x) ** 2 + (projected.y - pickup.y) ** 2;
      };
      ids = [
        ids.reduce((nearest, item) => (distance(item.id) < distance(nearest.id) ? item : nearest)),
      ];
      const engine = createPCBTrackJointDrag(pcb, ids[0].id, pickup, {
        clearance: routeClearance,
        endpointTolerance,
      });
      const issue = engine.preview({ x: 0, y: 0 }).error;
      if (issue) {
        setError(issue);
        return;
      }
      at = engine.anchor;
    }
    setSelection(ids);
    setInspectedPadId('');
    setInspector(false);
    setTrackDrag({
      mode,
      fillsHidden: false,
      start: at,
      current: at,
      pickup,
      endpointTolerance,
      ids,
      basis: pcb,
    });
    setError('');
  }
  function finishTrackDrag(at = trackDrag?.current) {
    if (!trackDrag || trackDrag.basis !== latestBoard.current || !trackDragPreview) {
      setTrackDrag(null);
      return;
    }
    const current = at ?? trackDrag.current;
    const previousDraft = {
      ...trackDrag,
      current,
      fillsHidden:
        trackDrag.fillsHidden || current.x !== trackDrag.start.x || current.y !== trackDrag.start.y,
    };
    const requestedDelta = {
      x: (at ?? trackDrag.current).x - trackDrag.start.x,
      y: (at ?? trackDrag.current).y - trackDrag.start.y,
    };
    const preview =
      at && !same(at, trackDrag.current)
        ? interactiveTrackDragPreview(requestedDelta)
        : trackDragPreview;
    const proposal = preview && preparePCBTrackPresentation(pcb, preview);
    if (!proposal || proposal.error) {
      setError(proposal?.error || trackDragEngine.error);
      if (trackDrag.pointer) setTrackDrag(null);
      else setTrackDrag(previousDraft);
      return;
    }
    const constraint = proposal.constraint;
    if (
      constraint &&
      (constraint.basis !== pcb ||
        constraint.requestedDelta.x !== requestedDelta.x ||
        constraint.requestedDelta.y !== requestedDelta.y ||
        constraint.posture !== routePosture)
    ) {
      setError('Track preview changed. Move the pointer and try again.');
      if (trackDrag.pointer) setTrackDrag(null);
      else setTrackDrag(previousDraft);
      return;
    }
    // This local engine returns the basis for no-ops and identifies every changed
    // span. Core still validates the complete candidate before publishing it.
    const changed = proposal.board !== pcb && proposal.changedIds.length > 0;
    setTrackDrag(null);
    setInspector(true);
    // A synchronous Core publication must render the new board without its old
    // gesture. Rejected explicit placement restores the exact retryable draft.
    if (changed && !commit(proposal.board, true)) {
      setInspector(inspector);
      if (!previousDraft.pointer) setTrackDrag(previousDraft);
    }
  }
  function finishMove(at = drag?.current) {
    if (!drag || !at) return;
    if (drag.basis === latestBoard.current) {
      const next = movePCBSelection(drag.preview, drag.ids, {
        x: at.x - drag.start.x,
        y: at.y - drag.start.y,
      });
      const changed = JSON.stringify(next) !== JSON.stringify(pcb);
      const previousDraft = { ...drag, current: at };
      setDrag(null);
      if (changed && !commit(next, true)) {
        if (previousDraft.mode !== 'pointer') setDrag(previousDraft);
        return;
      }
    }
    setDrag(null);
  }
  function remove(targets?: Selection[]) {
    if (tool !== 'select') return;
    if (drag || trackDrag || marquee) return;
    const ids = targets ?? actionSelection((candidate) => remove([candidate.selection!]));
    if (ids?.length && editableSelection(ids) && commit(deletePCBSelection(pcb, ids)))
      setSelection([]);
  }
  function rotate(degrees = 90, targets?: Selection[]) {
    if (trackDrag) return;
    if (tool !== 'select' && !placement) return;
    if (placement) {
      setPlacement({ ...placement, rotation: (placement.rotation + degrees + 360) % 360 });
      return;
    }
    if (drag) {
      setDrag({
        ...drag,
        preview: rotatePCBSelection(drag.preview, drag.ids, degrees, drag.start),
      });
      return;
    }
    const ids = targets ?? actionSelection((candidate) => rotate(degrees, [candidate.selection!]));
    if (!ids?.length || !editableSelection(ids)) return;
    const has = (id: string) => ids.some((s) => s.id === id);
    const bounds =
      ids.length > 1
        ? pcbBounds({
            ...pcb,
            footprints: pcb.footprints.filter((f) => has(f.id)),
            tracks: pcb.tracks.filter((t) => has(t.id)),
            vias: pcb.vias.filter((v) => has(v.id)),
            graphics: pcb.graphics.filter((g) => has(g.id)),
            zones: pcb.zones.filter((z) => has(z.id)),
          })
        : null;
    const pivot = bounds
      ? { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
      : undefined;
    if (ids.length && commit(rotatePCBSelection(pcb, ids, degrees, pivot))) setSelection(ids);
  }
  function flip(targets?: Selection[]) {
    if (trackDrag) return;
    if (tool !== 'select' && !placement) return;
    if (placement) {
      setPlacement(flipPCBFootprint(placement));
      return;
    }
    const ids =
      drag?.ids ??
      targets ??
      actionSelection((candidate) => flip([candidate.selection!]), ['footprint']);
    if (!ids?.length) return;
    const basis = drag?.preview ?? pcb;
    const next = {
      ...basis,
      footprints: basis.footprints.map((f) => {
        if (!ids.some((s) => s.kind === 'footprint' && s.id === f.id)) return f;
        const flipped = flipPCBFootprint(f);
        return drag ? { ...flipped, y: Number((2 * drag.start.y - f.y).toFixed(6)) } : flipped;
      }),
    };
    if (drag) setDrag({ ...drag, preview: next });
    else if (commit(next)) setSelection(ids);
  }
  function inspect(targets?: Selection[], padId?: string) {
    if (tool !== 'select' || drag || trackDrag || marquee) return;
    if (padId) {
      onShowSidebar?.();
      setInspectedPadId(padId);
      setSelection([]);
      setInspector(true);
      setInspectorFocus((value) => value + 1);
      return;
    }
    const ids =
      targets ??
      actionSelection(
        (candidate) => inspect(candidate.selection ? [candidate.selection] : [], candidate.padId),
        undefined,
        true,
      );
    if (ids?.length) {
      onShowSidebar?.();
      setSelection(ids);
      setInspectedPadId('');
      setInspector(true);
      setInspectorFocus((value) => value + 1);
    }
  }
  function beginRoute(destination: PCBRouteAnchorResult) {
    const routeNet = destination.target?.netId ?? validNet;
    if (destination.error) {
      setError(destination.error);
      return;
    }
    if (!routeNet) {
      setError('Add a net before routing.');
      setInspector(true);
      return;
    }
    const routeLayer = destination.target?.layer ?? layer;
    try {
      const issue = createPCBRouter(pcb, {
        layer: routeLayer,
        netId: routeNet,
        width,
        clearance: routeClearance,
      }).validate([destination.point]);
      if (issue) {
        setError(issue);
        return;
      }
    } catch (error) {
      setError((error as Error).message);
      return;
    }
    setNet(routeNet);
    setLayer(routeLayer);
    setPriorityLayer(routeLayer);
    updateCursor(destination.point);
    setRoute({
      points: [destination.point],
      waypoints: [],
      netId: routeNet,
      layer: routeLayer,
      basis: pcb,
      legs: [],
    });
    setError('');
  }
  function finishRoute(points?: Point[], destination: PCBRouteAnchorResult = routeAnchor) {
    if (viaTarget && route) {
      lockRouteVia(cursor);
      return;
    }
    if (route && destination.error) {
      setError(destination.error);
      return;
    }
    if (route && !points) {
      const result = router.engine?.route(
        route.points.at(-1)!,
        destination.point,
        routeMode,
        routePosture,
      );
      if (!result || result.blocked) {
        setError(router.error || result?.message || 'Routing geometry is unavailable.');
        return;
      }
      points = [...route.points, ...result.points.slice(1)];
    }
    if (!route || route.basis !== latestBoard.current || !points) {
      setRoute(null);
      setViaTarget(null);
      return;
    }
    const issue = validateRoute(points);
    if (issue) {
      setError(issue || 'Routing geometry is unavailable. Restart the route.');
      return;
    }
    const tracks = [...route.legs, { points, layer: route.layer }].flatMap((leg) =>
      leg.points.slice(1).flatMap((end, i) =>
        same(leg.points[i], end)
          ? []
          : [
              {
                id: uid(),
                start: leg.points[i],
                end,
                width,
                layer: leg.layer,
                netId: route.netId,
              },
            ],
      ),
    );
    const vias = route.legs.map((leg) => leg.via);
    if (
      (!tracks.length && !vias.length) ||
      commit({
        ...pcb,
        tracks: [...pcb.tracks, ...tracks],
        vias: [...pcb.vias, ...vias],
      })
    ) {
      setRoute(null);
      setViaTarget(null);
    }
  }
  function validateRoute(points: Point[]) {
    if (!route || route.basis !== latestBoard.current)
      return 'The board changed. Restart the route.';
    const legs = [...route.legs, { points, layer: route.layer }];
    const limitMessage =
      'Routing exceeds the geometry limit. Finish a shorter route before continuing.';
    if (legs.reduce((count, leg) => count + leg.points.length, 0) > 15000) return limitMessage;
    let work = 0;
    const spend = () => {
      if (++work > 2_000_000) throw new Error(limitMessage);
    };
    for (const leg of legs) {
      const engine = routers.get(leg.layer);
      const issue = engine?.error || engine?.engine?.validate(leg.points, spend);
      if (!engine?.engine || issue)
        return issue || 'Routing geometry is unavailable. Restart the route.';
    }
    for (const { via, validator } of lockedViaValidators) {
      const issue = validator.validate(via, spend);
      if (issue) return issue;
    }
    return '';
  }
  function requestVia(target?: CopperLayer) {
    if (!route || tool !== 'route') return;
    const next =
      target ??
      (route.layer === 'F.Cu'
        ? 'B.Cu'
        : route.layer === 'B.Cu'
          ? 'F.Cu'
          : copperLayers[(copperLayers.indexOf(route.layer) + 1) % copperLayers.length]);
    if (!copperLayers.includes(next)) return;
    setViaTarget(next === route.layer || (!target && viaTarget) ? null : next);
    setError('');
    svg.current?.focus({ preventScroll: true });
  }
  function lockRouteVia(at: Point) {
    if (!route || !viaTarget || route.basis !== latestBoard.current) return;
    if (route.legs.length >= 64) {
      setError('This route has reached 64 layer transitions. Finish it before continuing.');
      return;
    }
    const result = router.engine?.route(route.points.at(-1)!, at, routeMode, routePosture);
    const points = [...route.points, ...(result?.points.slice(1) ?? [])];
    const issue =
      !result || result.blocked
        ? router.error || result?.message || 'Routing geometry is unavailable.'
        : validateRoute(points) || viaValidator.validate(at) || routers.get(viaTarget)?.error;
    if (issue) {
      setError(issue);
      return;
    }
    const via = { id: uid(), ...at, diameter: viaDiameter, drill: viaDrill, netId: route.netId };
    setRoute({
      ...route,
      layer: viaTarget,
      points: [at],
      waypoints: [],
      legs: [
        ...route.legs,
        {
          points,
          layer: route.layer,
          via,
          previous: { points: route.points, waypoints: route.waypoints },
        },
      ],
    });
    setLayer(viaTarget);
    setPriorityLayer(viaTarget);
    setViaTarget(null);
    updateCursor(at);
    setError('');
  }
  function updateFootprint(next: Footprint) {
    if (JSON.stringify(next) === JSON.stringify(selectedFootprint)) return true;
    return commit({ ...pcb, footprints: pcb.footprints.map((f) => (f.id === next.id ? next : f)) });
  }
  function setOutline(point: Point | null) {
    writeOutline(point);
    outlineBasis.current = point ? pcb : null;
    if (!point) {
      setOutlinePoints((current) => (current.length ? [] : current));
      outlinePublication.current = null;
    }
  }
  function outlinePoint(event: {
    clientX: number;
    clientY: number;
    ctrlKey?: boolean;
    metaKey?: boolean;
    shiftKey?: boolean;
  }) {
    const raw = canvasPoint(event, false);
    const snapped =
      event.ctrlKey || event.metaKey ? { x: raw.x, y: raw.y } : { x: snap(raw.x), y: snap(raw.y) };
    if (event.shiftKey) return snapped;
    const radius = (view.width / size.width) * 8;
    let distance = radius;
    let result = snapped;
    const attract = (point: Point) => {
      const next = Math.hypot(point.x - raw.x, point.y - raw.y);
      if (next < distance) {
        distance = next;
        result = point;
      }
    };
    for (const graphic of pcb.graphics) {
      if (graphic.layer !== 'Edge.Cuts' || graphic.kind === 'text' || graphic.kind === 'dimension')
        continue;
      attract(graphic.start);
      if (graphic.kind !== 'circle') attract(graphic.end);
      if (graphic.kind === 'polygon') graphic.points?.forEach(attract);
    }
    outlinePoints.forEach(attract);
    return result;
  }
  function finishOutline(finish = true, head = cursorPosition.current) {
    if (!outline) return;
    if (outlineBasis.current !== pcb) {
      setOutline(null);
      return;
    }
    let points: Point[];
    if (outlineShape === 'rectangle') {
      if (same(outline, head) || outline.x === head.x || outline.y === head.y) {
        setError('Choose an opposite corner with nonzero width and height.');
        return;
      }
      points = [outline, { x: head.x, y: outline.y }, head, { x: outline.x, y: head.y }, outline];
    } else {
      if (same(outline, head)) {
        if (finish) setOutline(null);
        return;
      }
      points = [outline, head];
    }
    const lines = points.slice(1).map((end, index) => ({
      id: uid(),
      start: points[index],
      end,
      width: outlineWidth,
      layer: 'Edge.Cuts' as const,
    }));
    // Core validates and adopts this exact internally owned candidate. Only its
    // own publication can retain the next line origin; any other board revision
    // cancels it, including Source changes, undo and external edits.
    let next: PCB;
    try {
      next = ownProjectData(
        invalidatePCBFill(pcb, { ...pcb, graphics: [...pcb.graphics, ...lines] }),
        pcb,
      );
    } catch (error) {
      setError((error as Error).message);
      return;
    }
    outlinePublication.current = next;
    if (commit(next)) {
      if (outlineShape === 'line' && !finish) {
        writeOutline(head);
        outlineBasis.current = next;
        setOutlinePoints((current) => [current[0] ?? outline, head]);
      } else setOutline(null);
      setSelection(lines.map((line) => ({ kind: 'graphic', id: line.id })));
      focusCanvas();
    } else outlinePublication.current = null;
  }
  function finishZone() {
    const zoneLayer = copperLayers.find((item) => item === (priorityLayer ?? layer));
    if (!zoneLayer) {
      setError('Select a copper layer before drawing a copper zone.');
      return;
    }
    if (zoneDraft.length < 3) {
      setError('Choose at least three corners for the copper zone.');
      return;
    }
    if (!validNet) {
      setError('Choose a net for the copper zone.');
      return;
    }
    const zone: PCB['zones'][number] = {
      id: uid(),
      netId: validNet,
      layer: zoneLayer,
      outline: zoneDraft,
      clearance: zoneClearance,
      minThickness: 0.2,
      thermalGap: zoneThermalGap,
      thermalBridge: zoneThermalBridge,
      fillEnabled: true,
    };
    if (commit({ ...pcb, zones: [...pcb.zones, zone] })) {
      setZoneDraft([]);
      setSelection([{ kind: 'zone', id: zone.id }]);
      setTool('select');
      focusCanvas();
    }
  }
  function updateZone(next: PCB['zones'][number]) {
    return commit({ ...pcb, zones: pcb.zones.map((z) => (z.id === next.id ? next : z)) });
  }
  async function fillZones(clearance: number) {
    if (!active) return false;
    try {
      let accepted: boolean;
      if (capabilityHost) {
        await capabilityHost.execute('layout.fill', { boardId: pcb.id, clearance });
        accepted = true;
      } else {
        // Standalone editor adapters receive the exact generated board. A fill
        // already contains current contours, so do not invalidate it as an edit.
        const next = fillCopperZones(pcb, clearance);
        accepted = JSON.stringify(next) === JSON.stringify(pcb) || onCommit(next);
      }
      if (accepted) {
        setFillClearance(clearance);
        setFillSettingsOpen(false);
        setLayers((current) => ({ ...current, copper: true }));
        setError('');
        focusCanvas();
      }
      return accepted;
    } catch (error) {
      setError((error as Error).message);
      return false;
    }
  }
  function start(e: React.PointerEvent<SVGSVGElement>) {
    if (!active || hasOpenOverlay() || ![0, 1, 2].includes(e.button)) return;
    flushLayoutCamera(svg.current);
    if (outlineResize) {
      e.preventDefault();
      return;
    }
    const changedPointer =
      pointerPosition.current?.clientX !== e.clientX ||
      pointerPosition.current?.clientY !== e.clientY;
    svg.current?.focus({ preventScroll: true });
    e.preventDefault();
    lastCanvasPoint.current = canvasPoint(e, false);
    if (tool === 'select') expandedSelection.current = null;
    pointerPosition.current = { clientX: e.clientX, clientY: e.clientY };
    pointer.current = e.pointerId;
    pointerStart.current = { x: e.clientX, y: e.clientY };
    pointerMoved.current = false;
    svg.current?.setPointerCapture(e.pointerId);
    if (e.button === 1 || e.button === 2 || tool === 'hand') {
      pan.current = {
        x: e.clientX,
        y: e.clientY,
        view: { ...view },
        button: e.button,
        cameraLease: committedCameraBinding.current?.beginPan() ?? null,
      };
      host.current?.classList.add('is-panning');
      return;
    }
    if (onAnalysisProbe) return;
    const p =
      tool === 'route' && (e.ctrlKey || e.metaKey)
        ? routeFreePoint(canvasPoint(e, false))
        : canvasPoint(e);
    if (trackDrag) {
      const at = changedPointer ? p : trackDrag.current;
      updateCursor(at);
      finishTrackDrag(at);
      return;
    }
    if (drag?.mode === 'move') {
      const at = changedPointer ? p : drag.current;
      updateCursor(at);
      finishMove(at);
      return;
    }
    updateCursor(p);
    if (tool === 'annotate') {
      const raw = canvasPoint(e, false);
      let id: string | undefined;
      if (annotationMode === 'element') {
        try {
          id = pointCandidate(
            e,
            selectionCandidates(e, e.altKey).filter((candidate) => candidate.selection),
          )?.selection?.id;
        } catch (error) {
          releasePointer();
          setError((error as Error).message);
          return;
        }
      }
      setGesture({
        start: raw,
        end: raw,
        points: [raw],
        id: id && annotationSelectableIds?.has(id) ? id : undefined,
      });
      return;
    }
    if (tool === 'place') {
      if (!placement) return;
      const next = { ...placement, ...p };
      if (commit({ ...pcb, footprints: [...pcb.footprints, next] })) {
        setPlacement(null);
        setTool('select');
        setSelection([{ kind: 'footprint', id: next.id }]);
        setInspector(true);
      }
      return;
    }
    if (tool === 'route') {
      if (route && viaTarget) {
        setRoutePointer(routePointerAt(e));
        lockRouteVia(p);
        return;
      }
      const at = routePointerAt(e);
      setRoutePointer(at);
      const destination = resolveRouteAnchor(at);
      const anchor = destination.point;
      const routeTarget = destination.target;
      updateCursor(anchor);
      if (destination.error) {
        setError(destination.error);
        return;
      }
      if (!route) {
        beginRoute(destination);
      } else {
        if (route.basis !== latestBoard.current) {
          setRoute(null);
          setViaTarget(null);
          return;
        }
        const result = router.engine?.route(
          route.points[route.points.length - 1],
          anchor,
          routeMode,
          routePosture,
        );
        if (!result || result.blocked) {
          setError(router.error || result?.message || 'Routing geometry is unavailable.');
          return;
        }
        const points = [...route.points, ...result.points.slice(1)];
        const issue = validateRoute(points);
        if (issue) {
          setError(issue);
          return;
        }
        updateCursor(anchor);
        setError('');
        if (routeTarget) finishRoute(points, destination);
        else if (points.length > route.points.length)
          setRoute({ ...route, points, waypoints: [...route.waypoints, route.points.length] });
      }
      return;
    }
    if (tool === 'via') {
      if (!validNet) {
        setError('Add a net before placing a via.');
        setInspector(true);
        return;
      }
      if (viaDrill >= viaDiameter) {
        setError('Via drill must be smaller than its diameter.');
        return;
      }
      const via = { id: uid(), ...p, diameter: viaDiameter, drill: viaDrill, netId: validNet };
      const issue = viaValidator.validate(p);
      if (issue) {
        setError(issue);
        return;
      }
      if (commit({ ...pcb, vias: [...pcb.vias, via] })) setSelection([{ kind: 'via', id: via.id }]);
      return;
    }
    if (tool === 'outline') {
      const corner = outlinePoint(e);
      updateCursor(corner);
      if (!outline) {
        setOutline(corner);
        setOutlinePoints([corner]);
        return;
      }
      if (outlineShape === 'rectangle') finishOutline(true, corner);
      else finishOutline(outlinePoints.length > 1 && same(corner, outlinePoints[0]), corner);
      return;
    }
    if (tool === 'zone') {
      if (!copperLayers.some((item) => item === (priorityLayer ?? layer))) {
        setError('Select a copper layer before drawing a copper zone.');
        return;
      }
      if (!validNet) {
        setError('Add a net before drawing a copper zone.');
        return;
      }
      if (zoneDraft.length >= 3 && same(p, zoneDraft[0])) finishZone();
      else if (zoneDraft.length >= 128) setError('A new zone supports at most 128 corners.');
      else if (!zoneDraft.length || !same(p, zoneDraft[zoneDraft.length - 1]))
        setZoneDraft([...zoneDraft, p]);
      return;
    }
    let candidate: SelectionCandidate | undefined;
    try {
      candidate = pointCandidate(e, selectionCandidates(e, e.altKey));
    } catch (error) {
      releasePointer();
      setError((error as Error).message);
      return;
    }
    const mode = selectionMode(e);
    if (
      candidate &&
      !pointerDragsObject(
        leftButtonDrag,
        selection.some(
          (item) => item.kind === candidate.selection?.kind && item.id === candidate.selection.id,
        ),
      )
    ) {
      setMarquee({
        start: canvasPoint(e, false),
        end: canvasPoint(e, false),
        selection,
        mode,
        basis: pcb,
        clickCandidate: candidate,
      });
      return;
    }
    if (candidate && !candidate.selection) {
      selectCandidate(candidate, mode);
      return;
    }
    setInspectedPadId('');
    const object = candidate?.selection;
    if (object) {
      if (mode === 'replace') pointerSelection.current = { selection: object, basis: pcb };
      const ids =
        mode === 'replace'
          ? selection.some((s) => s.id === object.id)
            ? selection
            : [object]
          : mergePCBSelection(selection, [object], mode);
      setSelection(ids);
      setInspector(true);
      if (
        mode === 'replace' &&
        !pcb.tracks.some(
          (track) =>
            track.locked && ids.some((item) => item.kind === 'track' && item.id === track.id),
        )
      )
        setDrag({
          start: p,
          current: p,
          ids,
          basis: pcb,
          preview: pcb,
          mode: 'pointer',
        });
    } else {
      setMarquee({
        start: canvasPoint(e, false),
        end: canvasPoint(e, false),
        selection,
        mode,
        basis: pcb,
      });
    }
  }
  function move(e: React.PointerEvent<SVGSVGElement>) {
    if (!active) return;
    pointerPosition.current = { clientX: e.clientX, clientY: e.clientY };
    if (pan.current && pointer.current === e.pointerId) {
      const origin = pan.current;
      const before = camera.getSnapshot();
      // Include any navigation queued since the displayed frame, then rebase
      // this event to its new numerical pose without forcing a camera draw.
      const transform = svg.current!.getScreenCTM();
      const mapped = canvasPoint(e, false, transform);
      pointerMoved.current ||= Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > 4;
      if (origin.button !== 2 || pointerMoved.current) {
        const update = () =>
          setView({
            ...origin.view,
            x: origin.view.x - ((e.clientX - origin.x) * origin.view.width) / size.width,
            y: origin.view.y - ((e.clientY - origin.y) * origin.view.width) / size.width,
          });
        if (origin.cameraLease) origin.cameraLease.update(update);
        else update();
      }
      const point = transform
        ? rebaseLayoutCameraPoint(mapped, before, camera.getSnapshot())
        : mapped;
      lastCanvasPoint.current = point;
      updateCursor({ x: snap(point.x), y: snap(point.y) }, false);
      return;
    }
    const raw = canvasPoint(e, false);
    lastCanvasPoint.current = raw;
    const p =
      tool === 'outline'
        ? outlinePoint(e)
        : tool === 'route' && (e.ctrlKey || e.metaKey)
          ? routeFreePoint(raw)
          : { x: snap(raw.x), y: snap(raw.y) };
    const overlayOpen = hasOpenOverlay();
    // Idle pointer motion only updates the coordinate subscriber. Tools keep
    // their live cursor preview without rebuilding the entire board on hover.
    updateCursor(p, !overlayOpen && tool !== 'select' && tool !== 'hand' && tool !== 'annotate');
    if (onAnalysisProbe) {
      if (pointer.current === e.pointerId && pointerStart.current)
        pointerMoved.current ||=
          Math.hypot(e.clientX - pointerStart.current.x, e.clientY - pointerStart.current.y) > 4;
      return;
    }
    if (gesture && pointer.current === e.pointerId) {
      const raw = canvasPoint(e, false);
      setGesture({
        ...gesture,
        end: raw,
        points: [
          ...(gesture.points.length >= 512
            ? gesture.points.filter((_, i) => i % 2 === 0)
            : gesture.points),
          raw,
        ],
      });
      return;
    }
    if (overlayOpen) return;
    if (outlineResize && pointer.current === e.pointerId) {
      pointerMoved.current ||= Boolean(
        pointerStart.current &&
        Math.hypot(e.clientX - pointerStart.current.x, e.clientY - pointerStart.current.y) > 4,
      );
      if (!pointerMoved.current) return;
      setOutlineResize({
        ...outlineResize,
        current: canvasPoint(e, false),
        step: e.ctrlKey || e.metaKey ? 0 : gridSpacing,
      });
      return;
    }
    if (pointer.current === e.pointerId && pointerStart.current) {
      pointerMoved.current ||=
        Math.hypot(e.clientX - pointerStart.current.x, e.clientY - pointerStart.current.y) > 4;
    }
    if (tool === 'route' && !pan.current) setRoutePointer(routePointerAt(e));
    if (
      trackDrag &&
      !pan.current &&
      (!trackDrag.pointer || pointer.current === e.pointerId) &&
      (trackDrag.current.x !== p.x || trackDrag.current.y !== p.y)
    )
      setTrackDrag({
        ...trackDrag,
        current: p,
        fillsHidden:
          trackDrag.fillsHidden || p.x !== trackDrag.start.x || p.y !== trackDrag.start.y,
      });
    if (marquee && pointer.current === e.pointerId)
      setMarquee({ ...marquee, end: canvasPoint(e, false) });
    if (
      drag &&
      (drag.mode === 'move' || pointer.current === e.pointerId) &&
      (drag.current.x !== p.x || drag.current.y !== p.y)
    ) {
      if (drag.mode === 'pointer' && !pointerMoved.current) return;
      if (drag.mode === 'pointer' && drag.ids.every((item) => item.kind === 'track')) {
        const endpointTolerance = (view.width / size.width) * 6;
        const pickup = drag.start;
        const ids = drag.ids;
        const start = drag.start;
        setTrackDrag({
          mode: mouseDragTracks,
          pointer: true,
          fillsHidden: p.x !== start.x || p.y !== start.y,
          start,
          current: p,
          pickup,
          endpointTolerance,
          ids,
          basis: drag.basis,
        });
        setDrag(null);
        setInspector(false);
        setError('');
      } else setDrag({ ...drag, current: p });
    }
  }
  function end(e: React.PointerEvent<SVGSVGElement>) {
    if (pointer.current !== e.pointerId) return;
    const moved =
      pointerMoved.current ||
      Boolean(
        pointerStart.current &&
        Math.hypot(e.clientX - pointerStart.current.x, e.clientY - pointerStart.current.y) > 4,
      );
    const panning = pan.current;
    const picked = pointerSelection.current;
    releasePointer();
    if (panning) return;
    if (!active || hasOpenOverlay()) {
      setOutlineResize(null);
      setDrag(null);
      if (trackDrag?.pointer) setTrackDrag(null);
      setMarquee(null);
      setGesture(null);
      return;
    }
    if (outlineResize) {
      setOutlineResize(null);
      if (!moved || outlineResize.basis !== latestBoard.current) return;
      const at = canvasPoint(e, false);
      try {
        const bounds = pcbRectangleDragBounds(
          outlineResize.rectangle,
          outlineResize.handle,
          { x: at.x - outlineResize.start.x, y: at.y - outlineResize.start.y },
          e.ctrlKey || e.metaKey ? 0 : gridSpacing,
        );
        const next = resizePCBRectangle(pcb, outlineResize.rectangle, bounds);
        if (next !== pcb) commit(next);
      } catch (error) {
        setError((error as Error).message);
      }
      return;
    }
    if (onAnalysisProbe) {
      if (!moved) onAnalysisProbe(canvasPoint(e, false));
      return;
    }
    if (!moved && picked?.basis === latestBoard.current) setSelection([picked.selection]);
    if (trackDrag?.pointer) finishTrackDrag(canvasPoint(e));
    if (drag?.mode === 'pointer') {
      if (!moved || drag.ids.every((item) => item.kind === 'track')) setDrag(null);
      else finishMove(canvasPoint(e));
    }
    if (marquee && marquee.basis === latestBoard.current) {
      const end = canvasPoint(e, false);
      const moved =
        Math.hypot(end.x - marquee.start.x, end.y - marquee.start.y) >
        (view.width / size.width) * 4;
      const ids = moved
        ? selectPCBRectangle(
            pcb,
            layers,
            filters,
            marquee.start,
            end,
            placed === pcb ? copper.fills : undefined,
            priorityLayer ?? undefined,
          )
        : [];
      if (!moved && marquee.clickCandidate) selectCandidate(marquee.clickCandidate, marquee.mode);
      else {
        const next = mergePCBSelection(marquee.selection, ids, marquee.mode);
        setSelection(next);
        if (next.length) setInspector(true);
      }
    }
    setMarquee(null);
    if (gesture) {
      const moved =
        Math.hypot(gesture.end.x - gesture.start.x, gesture.end.y - gesture.start.y) >
        (view.width / size.width) * 4;
      if (!moved && annotationMode === 'element') {
        if (gesture.id && annotationSelectableIds?.has(gesture.id))
          controller.current?.select([gesture.id]);
      } else if (moved || (annotationMode === 'freehand' && gesture.points.length > 2)) {
        const points =
          annotationMode === 'freehand' ? gesture.points : [gesture.start, gesture.end];
        const xs = points.map((p) => p.x),
          ys = points.map((p) => p.y);
        const bounds = {
          x: Math.min(...xs),
          y: Math.min(...ys),
          width: Math.max(0.5, Math.max(...xs) - Math.min(...xs)),
          height: Math.max(0.5, Math.max(...ys) - Math.min(...ys)),
        };
        const ids =
          annotationMode === 'element'
            ? selectPCBRectangle(
                pcb,
                layers,
                filters,
                gesture.start,
                gesture.end,
                placed === pcb ? copper.fills : undefined,
                priorityLayer ?? undefined,
              ).map((item) => item.id)
            : [];
        if (annotationMode !== 'element') {
          for (const id of new Set(
            [...svg.current!.querySelectorAll<SVGElement>('[data-selection-id]')].map(
              (el) => el.dataset.selectionId!,
            ),
          )) {
            if (!annotationSelectableIds?.has(id)) continue;
            try {
              const b = annotationSelectionBounds(svg.current!, [id]);
              if (
                b.x <= bounds.x + bounds.width &&
                b.x + b.width >= bounds.x &&
                b.y <= bounds.y + bounds.height &&
                b.y + b.height >= bounds.y
              )
                ids.push(id);
            } catch {
              /* Hidden layers do not contribute to the annotation selection. */
            }
          }
        }
        if (annotationMode !== 'element' || ids.length)
          controller.current?.select(
            ids,
            annotationMode === 'element'
              ? undefined
              : annotationMode === 'freehand'
                ? { kind: 'freehand', points }
                : { kind: 'rectangle', bounds },
          );
      }
      setGesture(null);
    }
  }
  function key(e: React.KeyboardEvent<SVGSVGElement>) {
    if (
      !active ||
      hasOpenOverlay() ||
      e.nativeEvent.isComposing ||
      e.nativeEvent.keyCode === 229 ||
      e.repeat ||
      e.altKey
    )
      return;
    flushLayoutCamera(svg.current);
    const key = e.key.toLowerCase();
    if (outlineResize) {
      e.preventDefault();
      e.stopPropagation();
      if (key === 'escape') {
        cancelGesture();
        setError('');
      }
      if (['pageup', 'pagedown', '+', '-'].includes(key)) {
        const target =
          key === 'pageup'
            ? 'F.Cu'
            : key === 'pagedown'
              ? 'B.Cu'
              : copperLayers[
                  (copperLayers.indexOf(layer) + (key === '+' ? 1 : copperLayers.length - 1)) %
                    copperLayers.length
                ];
        changePriorityLayer(target);
      }
      return;
    }
    if (onAnalysisProbe) {
      if (key === 'escape' || key === 'home' || key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        if (key === 'escape') onAnalysisProbe(null);
        else if (key === 'home') fit(e.ctrlKey || e.metaKey ? 'all' : 'board');
        else if (!e.ctrlKey && !e.metaKey) fit('board');
      }
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      if (key === 'a' && tool === 'select') {
        e.preventDefault();
        e.stopPropagation();
        cancelGesture();
        const targets = allVisibleSelections();
        setSelection(targets);
        setInspectedPadId('');
        if (targets.length) setInspector(true);
        return;
      }
      if (key === 'home') {
        e.preventDefault();
        e.stopPropagation();
        fit('all');
        return;
      }
      if (!(tool === 'route' && key === 'enter')) return;
    }
    if (
      ['arrowleft', 'arrowright', 'arrowup', 'arrowdown'].includes(key) &&
      tool === 'select' &&
      selection.length
    ) {
      e.preventDefault();
      e.stopPropagation();
      const step = gridSpacing * (e.shiftKey ? 10 : 1);
      if (trackDrag) {
        const current = {
          x: trackDrag.current.x + (key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0),
          y: trackDrag.current.y + (key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0),
        };
        setTrackDrag({
          ...trackDrag,
          current,
          fillsHidden:
            trackDrag.fillsHidden ||
            current.x !== trackDrag.start.x ||
            current.y !== trackDrag.start.y,
        });
        updateCursor(current);
        return;
      }
      if (drag) {
        setDrag({
          ...drag,
          current: {
            x: drag.current.x + (key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0),
            y: drag.current.y + (key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0),
          },
        });
        return;
      }
      if (!editableSelection(selection)) return;
      commit(
        movePCBSelection(pcb, selection, {
          x: key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0,
          y: key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0,
        }),
      );
      return;
    }
    if (
      ![
        'v',
        'h',
        'x',
        'm',
        'd',
        'g',
        'u',
        '`',
        '~',
        'r',
        'f',
        'e',
        'a',
        'delete',
        'backspace',
        'escape',
        ' ',
        'home',
        'enter',
        'pageup',
        'pagedown',
        '+',
        '-',
        '/',
      ].includes(key)
    )
      return;
    e.preventDefault();
    e.stopPropagation();
    if (['pageup', 'pagedown', '+', '-'].includes(key)) {
      const current = viaTarget ?? route?.layer ?? layer;
      const target =
        key === 'pageup'
          ? 'F.Cu'
          : key === 'pagedown'
            ? 'B.Cu'
            : copperLayers[
                (copperLayers.indexOf(current) + (key === '+' ? 1 : copperLayers.length - 1)) %
                  copperLayers.length
              ];
      if (route) requestVia(target);
      else changePriorityLayer(target);
      return;
    }
    if (key === 'v') {
      if (route) requestVia();
      else activate('select');
    }
    if (key === 'h') activate('hand');
    if (key === 'x' && !route) {
      const at = pointerPosition.current
        ? routePointerAt({
            ...pointerPosition.current,
            ctrlKey: e.ctrlKey,
            metaKey: e.metaKey,
            shiftKey: e.shiftKey,
          })
        : null;
      if (tool !== 'route') activate('route');
      if (at) {
        const destination = resolveRouteAnchor(at);
        setRoutePointer(at);
        updateCursor(destination.point);
        // Empty space selects the tool; only visible assigned copper supplies
        // an implicit starting net. Pointer clicks retain free starts.
        if (destination.target) beginRoute(destination);
        else if (destination.error) setError(destination.error);
      }
    }
    // Keep read-only pad inspection from redirecting edit keys to nearby copper.
    if (
      tool === 'select' &&
      inspectedPad &&
      !selection.length &&
      ['m', 'd', 'g', 'r', 'f', 'delete', 'backspace'].includes(key)
    )
      return;
    if (key === 'a') openPlacement();
    if (key === 'm') beginMove();
    if (key === 'd') beginTrackDrag();
    if (key === 'g') beginTrackDrag('corner');
    if (key === 'u') expandTracks();
    if (key === '`') highlightSelectionNet();
    if (key === '~') setHighlightNets(new Set());
    if (key === 'r') rotate(e.shiftKey ? -90 : 90);
    if (key === 'f') flip();
    if (key === 'e') inspect();
    if (key === 'backspace' && route) {
      if (viaTarget) {
        setViaTarget(null);
        setError('');
        return;
      }
      const count = route.waypoints.at(-1);
      if (count)
        setRoute({
          ...route,
          points: route.points.slice(0, count),
          waypoints: route.waypoints.slice(0, -1),
        });
      else if (route.legs.length) {
        const previous = route.legs.at(-1)!;
        setRoute({
          ...route,
          ...previous.previous,
          layer: previous.layer,
          legs: route.legs.slice(0, -1),
        });
        setLayer(previous.layer);
        setPriorityLayer(previous.layer);
        setError('');
      } else {
        setRoute(null);
        setViaTarget(null);
      }
    } else if (key === 'backspace' && tool === 'zone') {
      setZoneDraft((points) => points.slice(0, -1));
    } else if (key === 'backspace' && tool === 'outline') {
      setOutline(null);
    } else if (key === 'delete' || key === 'backspace') remove();
    if (key === '/' && (route || trackDrag?.mode === 'connected'))
      setRoutePosture((current) => !current);
    if (key === ' ' || key === 'home') fit('board');
    if (key === 'enter' && route) finishRoute();
    if (key === 'enter' && tool === 'outline') finishOutline();
    if (key === 'enter' && tool === 'zone') finishZone();
    if (key === 'enter' && drag?.mode === 'move') finishMove();
    if (key === 'enter' && trackDrag) finishTrackDrag();
    if (key === 'escape') {
      if (tool === 'outline' && outline && outlineShape === 'rectangle') {
        setOutline(null);
        setError('');
        return;
      }
      setHighlightNets(new Set());
      const moving = Boolean(drag || trackDrag || marquee);
      activate('select');
      if (!moving) setSelection([]);
      setInspectedPadId('');
    }
  }
  const fixedRouteIssue = useMemo(
    () => (route ? validateRoute(route.points) : ''),
    [route?.points, route?.legs, route?.basis, routers, pcb, routeClearance, lockedViaValidators],
  );
  const liveRouteHead = viaTarget ? cursor : routeHead;
  const routePreview = useMemo(
    () =>
      route && router.engine && !fixedRouteIssue
        ? router.engine.route(
            route.points[route.points.length - 1],
            liveRouteHead,
            routeMode,
            routePosture,
          )
        : null,
    // Raw pointer movement must still resolve magnetic targets, but a retained
    // grid point or pad centre needs no new obstacle search. Keep errors and
    // target feedback live independently of this geometry-only preview.
    [route, router, liveRouteHead.x, liveRouteHead.y, routeMode, routePosture, fixedRouteIssue],
  );
  const previewRoute = route ? [...route.points, ...(routePreview?.points.slice(1) ?? [])] : [];
  const viaIssue = useMemo(
    () => (viaTarget || tool === 'via' ? viaValidator.validate(cursor) : ''),
    [viaTarget, tool, viaValidator, cursor],
  );
  const routingIssue = route
    ? router.error ||
      fixedRouteIssue ||
      (!viaTarget ? routeAnchor.error : '') ||
      (routePreview?.blocked ? routePreview.message : '') ||
      (viaTarget ? viaIssue : '')
    : tool === 'via'
      ? viaIssue
      : tool === 'route'
        ? routeAnchor.error
        : '';
  const committedAirwires = useRef<{
    shown: boolean;
    hiddenNets: Set<string>;
    wires: readonly Airwire[];
  } | null>(null);
  const airwirePresentation = useMemo(() => {
    const next = layers.airwires
      ? connectivity.edges.filter((edge) => !hiddenNets.has(edge.netId))
      : [];
    const previous = committedAirwires.current;
    const sameAnchor = (a: Point, b: Point) =>
      a.x === b.x &&
      a.y === b.y &&
      (a as Point & { id?: string }).id === (b as Point & { id?: string }).id;
    if (
      previous?.shown === layers.airwires &&
      previous.hiddenNets === hiddenNets &&
      previous.wires.length === next.length &&
      previous.wires.every((wire, index) => {
        const candidate = next[index];
        return (
          wire.id === candidate.id &&
          wire.netId === candidate.netId &&
          wire.startPadId === candidate.startPadId &&
          wire.endPadId === candidate.endPadId &&
          sameAnchor(wire.start, candidate.start) &&
          sameAnchor(wire.end, candidate.end)
        );
      })
    )
      return previous;
    return {
      shown: layers.airwires,
      hiddenNets,
      // Keep a private immutable drawing packet, independent of the fresh
      // connectivity result. Every analysis above still runs and validates.
      wires: Object.freeze(
        next.map((wire) =>
          Object.freeze({
            ...wire,
            start: Object.freeze({ ...wire.start }),
            end: Object.freeze({ ...wire.end }),
          }),
        ),
      ),
    };
  }, [layers.airwires, connectivity.edges, hiddenNets]);
  useLayoutEffect(() => {
    committedAirwires.current = airwirePresentation;
  }, [airwirePresentation]);
  const airwires = airwirePresentation.wires;
  const appearanceAirwireCount = appearanceTab === 'nets' ? airwires.length : 0;
  const visibleLayer = (layer: string) => Boolean(layers[layer as BoardLayer]);
  function footprintBody(f: Footprint) {
    const bounds = footprintBounds.get(f.id);
    if (!bounds) return null;
    const margin = (view.width / size.width) * 2;
    return (
      <rect
        key={f.id}
        data-footprint-body={f.id}
        data-layout-body-bounds={`${bounds.minX} ${bounds.minY} ${bounds.maxX} ${bounds.maxY}`}
        transform={`translate(${f.x} ${f.y}) rotate(${-f.rotation})`}
        x={bounds.minX - margin}
        y={bounds.minY - margin}
        width={bounds.maxX - bounds.minX + margin * 2}
        height={bounds.maxY - bounds.minY + margin * 2}
        fill="transparent"
        pointerEvents={bodyTargetsInteractive ? 'all' : 'none'}
      />
    );
  }
  // Camera subscribers update these exact targets directly. Selection retains
  // their virtual attributes, avoiding a redundant replay of camera mutations.
  const footprintBodyDrawing = useMemo(
    () => displayBoard.footprints.map(footprintBody),
    [displayBoard.footprints, footprintBounds, bodyTargetsInteractive, size.width],
  );
  // A preview changes a small subset of records. Retain their JSX as well as
  // memoized component drawings so unchanged objects do no reconciliation work.
  const copperFillInputs = [
    copperLayers,
    layers,
    copperZones,
    copperPaths,
    zoneOwners,
    selectionPaint,
    highlightNets,
  ];
  const copperOutlineInputs = [
    copperLayers,
    layers,
    placed.zones,
    zoneOutlinePaths,
    selectionPaint,
  ];
  const copperInputs = [
    copperLayers,
    layers,
    copperZones,
    copperPaths,
    zoneOwners,
    zoneOutlinePaths,
    selectionPaint,
    highlightNets,
    placed.tracks,
    placed.zones,
    netNames,
  ];
  const footprintPasses = useMemo(
    () => layoutFootprintLayerPasses(displayBoard, layers, paintLayerOrder),
    [displayBoard.footprints, pcb.layers, layers, paintLayerOrder],
  );
  const footprintInputs = [
    copperLayers,
    footprintPasses.graphics,
    partsById,
    layers,
    selectionPaint,
    placement?.id,
    layer,
    paintLayerOrder,
    inspectedPadId,
    netNames,
    highlightNets,
  ];
  const captionInputs = [
    footprintPasses.captions,
    partsById,
    layers,
    selectionPaint,
    placement?.id,
  ];
  const viaInputs = [copperLayers, placed.vias, layers, selectionPaint, highlightNets, netNames];
  const graphicInputs = [placed.graphics, layers, selectionPaint];
  const drillFootprints = useMemo(
    () => displayBoard.footprints.filter((footprint) => footprint.pads.some((pad) => pad.drill)),
    [displayBoard.footprints],
  );
  const drillInputs = [
    drillFootprints,
    copperLayers,
    layers,
    selectionPaint,
    placement?.id,
    inspectedPadId,
    highlightNets,
  ];
  const retainTrack = useRetainedElements(placed.tracks, copperInputs);
  const retainTrackBatches = useRetainedElementBatches(copperInputs);
  const retainFill = useRetainedElements(copperZones, copperFillInputs);
  const retainOutline = useRetainedElements(placed.zones, copperOutlineInputs);
  const retainVia = useRetainedElements(placed.vias, viaInputs);
  const retainGraphic = useRetainedElements(placed.graphics, graphicInputs);
  const retainFootprint = useRetainedElements(footprintPasses.graphics, footprintInputs);
  const retainCaption = useRetainedElements(footprintPasses.captions, captionInputs);
  const retainFootprintDrill = useRetainedElements(drillFootprints, drillInputs);
  const retainViaDrill = useRetainedElements(placed.vias, viaInputs);
  // These ordered zone elements and their pending retention maps depend only
  // on zone presentation. Track-coordinate previews retain both preparations.
  // copperInputs includes every zone input as well as the track inputs below.
  const copperFillDrawing = useMemo(() => {
    const drawings = new Map<BoardLayer, ReactNode[]>();
    if (layers.copper)
      for (const copperLayer of copperLayers.filter(visibleLayer))
        drawings.set(
          copperLayer,
          copperZones
            .filter((zone) => zone.layer === copperLayer)
            .map((zone) =>
              retainFill(
                {
                  key: zone.id,
                  zoneId: zone.id,
                  layer: zone.layer,
                  netId: zone.netId,
                  ownerId: zoneOwners.get(zone.id) ?? zone.id,
                  path: copperPaths.get(zone.id) ?? '',
                  selection: selectionPaint,
                  highlightNets,
                },
                ({ key, ...props }) => <LayoutZoneFillDrawing key={key} {...props} />,
              ),
            ),
        );
    return drawings;
  }, copperFillInputs);
  const copperOutlineDrawing = useMemo(() => {
    const drawings = new Map<BoardLayer, ReactNode[]>();
    if (layers.zoneOutlines)
      for (const copperLayer of copperLayers.filter(visibleLayer))
        drawings.set(
          copperLayer,
          placed.zones
            .filter((zone) => zone.layer === copperLayer)
            .map((zone) =>
              retainOutline(
                {
                  key: zone.id,
                  zoneId: zone.id,
                  layer: zone.layer,
                  path: zoneOutlinePaths.get(zone.id) ?? '',
                  selection: selectionPaint,
                },
                ({ key, ...props }) => <LayoutZoneOutlineDrawing key={key} {...props} />,
              ),
            ),
        );
    return drawings;
  }, copperOutlineInputs);
  // Camera translation and tool previews retain the unchanged drawing tree.
  const copperDrawing = useMemo(() => {
    const drawings = copperLayers.filter(visibleLayer).map((copperLayer) => (
      <g key={copperLayer} data-copper-layer={copperLayer}>
        {copperFillDrawing.get(copperLayer)}
        {copperOutlineDrawing.get(copperLayer)}
        {retainTrackBatches(
          copperLayer,
          placed.tracks
            .filter((track) => track.layer === copperLayer)
            .map((track) =>
              retainTrack(
                {
                  key: track.id,
                  track,
                  netName: netNames.get(track.netId),
                  selection: selectionPaint,
                  highlightNets,
                },
                ({ key, ...props }) => <LayoutTrackDrawing key={key} {...props} />,
              ),
            ),
        )}
      </g>
    ));
    return new Map(drawings.map((drawing) => [drawing.key as BoardLayer, drawing]));
  }, copperInputs);
  const footprintDrawing = useMemo(() => {
    const drawings = new Map<BoardLayer, ReactNode[]>();
    for (const pass of footprintPasses.graphics) {
      const { footprint } = pass;
      const drawing = retainFootprint(
        {
          key: pass.id,
          copperLayers: pcb.layers,
          footprint,
          reference: partsById.get(footprint.symbolId ?? '')?.ref,
          value: partsById.get(footprint.symbolId ?? '')?.value,
          layers,
          selection: selectionPaint,
          placement: footprint.id === placement?.id,
          layer,
          onlyLayer: pass.layer,
          padLayerOrder: paintLayerOrder,
          deferDrills: true,
          inspectedPadId:
            inspectedPadId && footprint.pads.some((pad) => pad.id === inspectedPadId)
              ? inspectedPadId
              : '',
          netNames,
          highlightNets,
        },
        ({ key, ...props }) => <LayoutFootprintGraphic key={key} {...props} />,
      );
      const current = drawings.get(pass.layer);
      if (current) current.push(drawing);
      else drawings.set(pass.layer, [drawing]);
    }
    return drawings;
  }, footprintInputs);
  const viaDrawing = useMemo(
    () => (
      <>
        {copperLayers.some(visibleLayer) &&
          placed.vias.map((via) =>
            retainVia(
              {
                key: via.id,
                via,
                netName: netNames.get(via.netId),
                selection: selectionPaint,
                highlightNets,
                deferDrills: true,
              },
              ({ key, ...props }) => <LayoutViaDrawing key={key} {...props} />,
            ),
          )}
      </>
    ),
    viaInputs,
  );
  const footprintDrillDrawing = useMemo(
    () =>
      drillFootprints.map((footprint) =>
        retainFootprintDrill(
          {
            key: footprint.id,
            copperLayers: pcb.layers,
            footprint,
            layers,
            selection: selectionPaint,
            placement: footprint.id === placement?.id,
            inspectedPadId:
              inspectedPadId && footprint.pads.some((pad) => pad.id === inspectedPadId)
                ? inspectedPadId
                : '',
            highlightNets,
          },
          ({ key, ...props }) => <LayoutFootprintDrills key={key} {...props} />,
        ),
      ),
    drillInputs,
  );
  const viaDrillDrawing = useMemo(
    () =>
      copperLayers.some(visibleLayer) &&
      placed.vias.map((via) =>
        retainViaDrill(
          { key: via.id, via, selection: selectionPaint, highlightNets },
          ({ key, ...props }) => <LayoutViaDrillDrawing key={key} {...props} />,
        ),
      ),
    viaInputs,
  );
  const graphicDrawing = useMemo(() => {
    const visible = placed.graphics.filter((graphic) =>
      graphic.layer === 'Edge.Cuts'
        ? layers['Edge.Cuts']
        : layers.footprints && visibleLayer(graphic.layer),
    );
    const draw = (graphic: PCB['graphics'][number]) =>
      retainGraphic(
        { key: graphic.id, graphic, selection: selectionPaint },
        ({ key, ...props }) => <LayoutGraphicDrawing key={key} {...props} />,
      );
    const drawings = new Map<BoardLayer, ReactNode[]>();
    for (const graphic of visible) {
      const drawing = draw(graphic);
      const current = drawings.get(graphic.layer);
      if (current) current.push(drawing);
      else drawings.set(graphic.layer, [drawing]);
    }
    return drawings;
  }, graphicInputs);
  // Screen-space airwires follow routing/connectivity and the camera without
  // rebuilding unchanged footprint, caption, via or graphic element arrays.
  const airwireDrawing = useMemo(
    () => (
      <LayoutCameraScaleRender camera={camera}>
        {(view) => (
          <>
            {airwires.map((wire) => {
              const focused = route ? route.netId === wire.netId : highlightNets.has(wire.netId);
              const path = same(wire.start, wire.end)
                ? `M ${wire.start.x - (view.width / size.width) * 4} ${wire.start.y} a ${(view.width / size.width) * 4} ${(view.width / size.width) * 4} 0 1 0 ${(view.width / size.width) * 8} 0 a ${(view.width / size.width) * 4} ${(view.width / size.width) * 4} 0 1 0 ${(-view.width / size.width) * 8} 0`
                : `M ${wire.start.x} ${wire.start.y} L ${wire.end.x} ${wire.end.y}`;
              return (
                <g
                  key={wire.id}
                  data-airwire={wire.netId}
                  aria-label={`${netNames.get(wire.netId) ?? ''} · Unconnected copper`}
                  fill="none"
                  pointerEvents="none"
                  opacity={(route || highlightNets.size > 0) && !focused ? 0.25 : 1}
                >
                  <path
                    d={path}
                    stroke="var(--pcb-airwire-halo)"
                    strokeWidth={focused ? 4 : 3.2}
                    vectorEffect="non-scaling-stroke"
                  />
                  <path
                    d={path}
                    stroke={focused ? 'var(--pcb-selected)' : 'var(--pcb-airwire)'}
                    strokeWidth={focused ? 1.8 : 1.25}
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              );
            })}
          </>
        )}
      </LayoutCameraScaleRender>
    ),
    [camera, airwires, size.width, Boolean(route), route?.netId, highlightNets, netNames],
  );
  // Artwork and captions share one pass per native layer, including fallback references.
  const captionDrawing = useMemo(() => {
    const drawings = new Map<BoardLayer, ReactNode[]>();
    for (const pass of footprintPasses.captions) {
      const { footprint } = pass;
      const drawing = retainCaption(
        {
          key: pass.id,
          footprint,
          reference: partsById.get(footprint.symbolId ?? '')?.ref,
          value: partsById.get(footprint.symbolId ?? '')?.value,
          layers,
          selection: selectionPaint,
          placement: footprint.id === placement?.id,
          onlyLayer: pass.layer,
        },
        ({ key, ...props }) => <LayoutFootprintCaptions key={key} {...props} />,
      );
      const current = drawings.get(pass.layer);
      if (current) current.push(drawing);
      else drawings.set(pass.layer, [drawing]);
    }
    return drawings;
  }, captionInputs);
  const viaLayer = paintLayerOrder.findLast((name) => copperLayers.includes(name as CopperLayer));
  const detailDrawing = useMemo(
    () => (
      <g data-layout-stack={priorityLayer === null ? 'physical' : 'priority'}>
        {paintLayerOrder.map((name) => (
          <g
            key={name}
            data-layout-layer={name}
            data-priority-layer={name === priorityLayer ? name : undefined}
          >
            {copperDrawing.get(name)}
            {footprintDrawing.get(name)}
            {name === viaLayer && viaDrawing}
            {graphicDrawing.get(name)}
            {captionDrawing.get(name)}
          </g>
        ))}
        <g data-layout-drills pointerEvents="none">
          {footprintDrillDrawing}
          {viaDrillDrawing}
        </g>
        {airwireDrawing}
      </g>
    ),
    [
      footprintDrawing,
      viaDrawing,
      graphicDrawing,
      airwireDrawing,
      captionDrawing,
      priorityLayer,
      paintLayerOrder,
      viaLayer,
      copperDrawing,
      footprintDrillDrawing,
      viaDrillDrawing,
    ],
  );
  const appearancePanelContent = useMemo(
    () => (
      <LayoutAppearancePanel
        panelRef={appearancePanel}
        board={appearanceBoard}
        displayLayers={displayLayers}
        layers={layers}
        onLayersChange={setLayers}
        priorityLayer={priorityLayer}
        onPriorityLayerChange={changePriorityLayer}
        tab={appearanceTab}
        onTabChange={setAppearanceTab}
        visualizationExpanded={visualizationExpanded}
        onVisualizationExpandedChange={setVisualizationExpanded}
        filters={filters}
        onFiltersChange={setFilters}
        filtersExpanded={selectionFiltersOpen}
        onFiltersExpandedChange={setSelectionFiltersOpen}
        hiddenNets={hiddenNets}
        onHiddenNetsChange={setHiddenNets}
        highlightNets={highlightNets}
        onHighlightNetsChange={setHighlightNets}
        netSearch={netSearch}
        onNetSearchChange={setNetSearch}
        netEdges={appearanceEdges}
        airwireCount={appearanceAirwireCount}
        connectivityError={connectivity.error}
      />
    ),
    [
      inspector,
      tool,
      appearanceBoard,
      displayLayers,
      layers,
      layer,
      priorityLayer,
      appearanceTab,
      visualizationExpanded,
      filters,
      selectionFiltersOpen,
      hiddenNets,
      highlightNets,
      netSearch,
      appearanceEdges,
      connectivity.error,
      appearanceAirwireCount,
    ],
  );
  const currentToolbarActions = {
    activate,
    openPlacement,
    connect(value: Tool) {
      if (value === 'via' && route) requestVia();
      else if (value === 'route' && route) svg.current?.focus({ preventScroll: true });
      else activate(value);
    },
  };
  const toolbarActions = useRef(currentToolbarActions);
  useLayoutEffect(() => {
    toolbarActions.current = currentToolbarActions;
  });
  const connectionSettingsVisible =
    toolSettings && (tool === 'route' || tool === 'via' || tool === 'outline');
  const modeToolGroup = useMemo(
    () => (
      <div className="editor-tool-group" role="group" aria-label="Canvas modes">
        {(
          [
            ['select', 'Interaction mode', MousePointer2],
            ['annotate', 'Annotation mode', MessageSquareText],
          ] as const
        ).map(([value, label, Icon]) => (
          <button
            key={value}
            className={`tool-button${tool === value ? ' active' : ''}`}
            aria-pressed={tool === value}
            aria-label={label}
            title={label}
            onClick={() => toolbarActions.current.activate(value)}
          >
            <Icon size={17} />
          </button>
        ))}
      </div>
    ),
    [tool],
  );
  const connectToolButtons = useMemo(
    () => (
      <>
        <button
          className={`tool-button${tool === 'place' ? ' active' : ''}`}
          aria-label="Place footprint"
          title="Place footprint"
          aria-pressed={tool === 'place'}
          aria-haspopup="dialog"
          aria-expanded={choosing}
          onClick={() => toolbarActions.current.openPlacement()}
        >
          <CircuitBoard size={17} />
        </button>
        {(
          [
            ['route', 'Route tracks', Route],
            ['via', 'Place through via', CircleDot],
            ['outline', 'Draw board outline', Square],
            ['zone', 'Draw copper zone', Pentagon],
          ] as const
        ).map(([value, label, Icon]) => (
          <button
            key={value}
            className={`tool-button${tool === value || (value === 'via' && viaTarget) ? ' active' : ''}`}
            aria-pressed={tool === value || (value === 'via' && Boolean(viaTarget))}
            aria-label={label}
            title={label}
            aria-expanded={
              value === 'route' || value === 'via' || value === 'outline'
                ? tool === value
                : undefined
            }
            aria-controls={tool === value && connectionSettingsVisible ? toolSettingsId : undefined}
            onClick={() => toolbarActions.current.connect(value)}
          >
            <Icon size={17} />
          </button>
        ))}
      </>
    ),
    [tool, viaTarget, connectionSettingsVisible, toolSettingsId, choosing],
  );
  const displayToolGroup = useMemo(
    () => (
      <div
        className="editor-tool-group editor-tool-group-end"
        role="group"
        aria-label="Layout display"
      >
        {ruleAction}
        {listAction}
        {historyAction}
        {sidebarAction}
      </div>
    ),
    [ruleAction, listAction, historyAction, sidebarAction],
  );
  const moving = Boolean(
    outlineResize ||
    (drag &&
      (drag.mode === 'move' ||
        drag.start.x !== drag.current.x ||
        drag.start.y !== drag.current.y)) ||
    (trackDrag &&
      (!trackDrag.pointer ||
        trackDrag.start.x !== trackDrag.current.x ||
        trackDrag.start.y !== trackDrag.current.y)),
  );
  const fillAvailable =
    active &&
    tool !== 'annotate' &&
    !route &&
    !outline &&
    !placement &&
    !zoneDraft.length &&
    !drag &&
    !trackDrag &&
    !outlineResize &&
    !marquee &&
    nativeZones.some((z) => z.layer.endsWith('.Cu') && !z.keepout && z.fillEnabled !== false);
  return (
    <div className="layout-editor" data-layout-editor data-pcb-theme={darkBoard ? 'dark' : 'light'}>
      <div
        className="editor-toolbar layout-toolbar"
        ref={toolbarRef}
        role="group"
        aria-label="Layout tools"
      >
        {modeToolGroup}
        <div className="editor-tool-group" role="group" aria-label="Place and connect">
          {connectToolButtons}
          <button
            className={`tool-button${fillSettingsOpen ? ' active' : ''}`}
            aria-label="Fill copper zones"
            title="Fill copper zones"
            aria-expanded={fillSettingsOpen}
            disabled={!fillAvailable}
            onClick={() => {
              const open = !fillSettingsOpen;
              activate('select');
              setFillSettingsOpen(open);
            }}
          >
            <PaintBucket size={17} />
          </button>
        </div>
        <div className="editor-tool-group" role="group" aria-label="Edit and history">
          <div className={`tool-menu${tool === 'hand' ? ' active' : ''}`}>
            <Select
              label="Edit layout"
              value=""
              icon={<RotateCw size={17} />}
              compact
              iconOnly
              showChevron={false}
              options={[
                ...(tool === 'select' && selection.length && !drag && !trackDrag
                  ? [{ value: 'move', label: 'Move selection' }]
                  : []),
                ...(tool === 'select' &&
                !drag &&
                !trackDrag &&
                selection.some((s) => s.kind === 'track' || s.kind === 'via')
                  ? [
                      { value: 'expand', label: 'Expand track selection' },
                      { value: 'highlight', label: 'Highlight selected nets' },
                    ]
                  : []),
                ...(tool === 'select' &&
                !drag &&
                !trackDrag &&
                selection.length &&
                selection.every((s) => s.kind === 'track')
                  ? [
                      { value: 'track-drag', label: 'Drag connected tracks' },
                      { value: 'corner-drag', label: 'Drag track corner' },
                    ]
                  : []),
                ...((tool === 'select' && selection.length && !trackDrag) || placement
                  ? [{ value: 'rotate', label: 'Rotate selection' }]
                  : []),
                ...(placement ||
                (tool === 'select' && !trackDrag && selection.some((s) => s.kind === 'footprint'))
                  ? [{ value: 'flip', label: 'Flip footprint' }]
                  : []),
                ...(tool === 'select' && selection.length && !drag && !trackDrag
                  ? [{ value: 'delete', label: 'Delete selection' }]
                  : []),
                { value: 'hand', label: 'Pan' },
              ]}
              onChange={(value) => {
                if (value === 'move') beginMove();
                else if (value === 'track-drag') beginTrackDrag();
                else if (value === 'corner-drag') beginTrackDrag('corner');
                else if (value === 'expand') expandTracks();
                else if (value === 'highlight') highlightSelectionNet();
                else if (value === 'rotate') rotate();
                else if (value === 'flip') flip();
                else if (value === 'delete') remove();
                else activate('hand');
              }}
            />
          </div>
          {undoAction}
        </div>
        {analysisAction && (
          <div
            className="editor-tool-group editor-plugin-actions"
            role="group"
            aria-label="Plugins"
          >
            {analysisAction}
          </div>
        )}
        {displayToolGroup}
      </div>
      {syncStatus?.pending && (
        <div className="layout-sync-status" role="status">
          Loading assigned footprints…
        </div>
      )}
      {syncStatus?.error && (
        <div className="layout-sync-status" role="alert">
          {syncStatus.error}
        </div>
      )}
      {!!syncStatus?.warnings.length && !syncStatus.error && (
        <details className="layout-sync-status">
          <summary>{syncStatus.warnings.length} layout notices</summary>
          <ul>
            {syncStatus.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </details>
      )}
      <div className="layout-main">
        <div
          ref={host}
          className={`canvas-wrap layout-canvas tool-${tool}${onAnalysisProbe ? ' is-analysis-probing' : ''}${pan.current ? ' is-panning' : ''}${moving ? ' is-moving' : ''}`}
        >
          <svg
            ref={svg}
            viewBox={`${view.x} ${view.y} ${view.width} ${view.width / ratio}`}
            preserveAspectRatio="xMinYMin meet"
            tabIndex={0}
            role="application"
            aria-label="PCB layout editor"
            data-testid="layout-canvas"
            onPointerDown={start}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={cancelGesture}
            onLostPointerCapture={(e) => {
              if (pointer.current === e.pointerId) cancelGesture();
            }}
            onPointerLeave={(event) => {
              // A transient SVG border box can shrink around a stationary
              // pointer. Hover belongs to the actual drawing viewport, while
              // tool panels, docks and real outside leaves still clear it.
              const viewport = host.current;
              const bounds = viewport?.getBoundingClientRect();
              const under = document.elementFromPoint(event.clientX, event.clientY);
              if (
                !active ||
                !document.hasFocus() ||
                hasOpenOverlay() ||
                !bounds ||
                event.clientX < bounds.left ||
                event.clientX > bounds.right ||
                event.clientY < bounds.top ||
                event.clientY > bounds.bottom ||
                (under !== viewport && !(under && svg.current?.contains(under)))
              )
                pointerPosition.current = null;
            }}
            onContextMenu={(e) => e.preventDefault()}
            onKeyDown={key}
            onDoubleClick={(e) => {
              if (!active || hasOpenOverlay()) return;
              e.preventDefault();
              if (onAnalysisProbe) return;
              if (trackDrag || drag?.mode === 'move') return;
              if (route) finishRoute();
              else if (tool === 'outline') {
                // A rectangle or closed chain may have committed on the first
                // click. Its second pointerdown must not leave a fresh origin.
                if (outlineShape === 'rectangle' || outlinePoints.length < 2) {
                  setOutline(null);
                  setError('');
                } else finishOutline();
              } else if (tool === 'zone') finishZone();
              else setInspector(true);
            }}
            onWheel={(e) => {
              if (!active || hasOpenOverlay() || e.deltaY === 0) return;
              const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
              const width = camera.getSnapshot().width;
              if (layoutZoomWidth(width, factor) === width) zoom(factor);
              else zoom(factor, canvasPoint(e, false));
            }}
          >
            <defs>
              <pattern
                id={`layout-grid-${pattern}`}
                data-layout-grid-pattern
                data-layout-grid-spacing={gridSpacing}
                x={-renderedGrid.spacing / 2}
                y={-renderedGrid.spacing / 2}
                width={renderedGrid.spacing}
                height={renderedGrid.spacing}
                patternUnits="userSpaceOnUse"
              >
                <circle
                  cx={renderedGrid.spacing / 2}
                  cy={renderedGrid.spacing / 2}
                  r={renderedGrid.radius}
                  fill="var(--grid-dot)"
                />
              </pattern>
            </defs>
            <rect
              data-layout-background
              x={view.x}
              y={view.y}
              width={view.width}
              height={view.width / ratio}
              fill="var(--canvas)"
            />
            {boardSurface && (
              <path
                data-board-surface
                d={boardSurface}
                fill="var(--pcb-substrate)"
                fillRule="evenodd"
                pointerEvents="none"
              />
            )}
            {grid && (
              <rect
                data-layout-grid
                x={view.x}
                y={view.y}
                width={view.width}
                height={view.width / ratio}
                fill={`url(#layout-grid-${pattern})`}
                pointerEvents="none"
              />
            )}
            <g data-layout-drawing>
              {/* Body targets stay behind every footprint's visible artwork and pads. */}
              {footprintBodyDrawing}
              {detailDrawing}
            </g>
            {analysisDrawing && (
              <g data-annotation-overlay pointerEvents="none">
                {analysisDrawing}
              </g>
            )}
            <LayoutCameraScaleRender camera={camera}>
              {(view) => (
                <>
                  {' '}
                  {active &&
                    tool === 'select' &&
                    !onAnalysisProbe &&
                    selectedRectangle &&
                    (selectedRectangle.zoneId
                      ? selectedZone &&
                        layers[selectedZone.layer] &&
                        pcbZoneSelectionEligible(selectedZone, filters) &&
                        (layers.zoneOutlines || layers.copper)
                      : layers['Edge.Cuts'] && filters.graphic) &&
                    !drag &&
                    !trackDrag &&
                    !marquee &&
                    (() => {
                      const b = outlineResizePreview?.bounds ?? selectedRectangle.bounds;
                      const handleSize = (view.width / size.width) * 8;
                      const midX = (b.minX + b.maxX) / 2,
                        midY = (b.minY + b.maxY) / 2;
                      return (
                        <g
                          data-annotation-overlay
                          data-board-outline-resize={selectedRectangle.zoneId ? undefined : ''}
                          data-zone-resize={selectedRectangle.zoneId}
                          data-layout-region-resize
                        >
                          <rect
                            x={b.minX}
                            y={b.minY}
                            width={b.maxX - b.minX}
                            height={b.maxY - b.minY}
                            fill="none"
                            stroke="var(--selection-edge)"
                            strokeWidth={1}
                            vectorEffect="non-scaling-stroke"
                            strokeDasharray="4 3"
                            pointerEvents="none"
                          />
                          {(
                            [
                              ['nw', b.minX, b.minY],
                              ['n', midX, b.minY],
                              ['ne', b.maxX, b.minY],
                              ['e', b.maxX, midY],
                              ['se', b.maxX, b.maxY],
                              ['s', midX, b.maxY],
                              ['sw', b.minX, b.maxY],
                              ['w', b.minX, midY],
                            ] as const
                          ).map(([handle, x, y]) => (
                            <rect
                              key={handle}
                              data-outline-resize-handle={
                                selectedRectangle.zoneId ? undefined : handle
                              }
                              data-zone-resize-handle={
                                selectedRectangle.zoneId ? handle : undefined
                              }
                              role="button"
                              aria-label={`Resize ${selectedRectangle.zoneId ? 'copper zone' : 'board outline'} ${handle}`}
                              x={x - handleSize / 2}
                              y={y - handleSize / 2}
                              width={handleSize}
                              height={handleSize}
                              rx={handleSize / 8}
                              fill="var(--canvas)"
                              stroke="var(--pcb-outline)"
                              strokeWidth={1}
                              vectorEffect="non-scaling-stroke"
                              style={{
                                cursor: `${handle === 'n' || handle === 's' ? 'ns' : handle === 'e' || handle === 'w' ? 'ew' : handle === 'nw' || handle === 'se' ? 'nwse' : 'nesw'}-resize`,
                              }}
                              onPointerDown={(e) => beginOutlineResize(e, handle)}
                            />
                          ))}
                        </g>
                      );
                    })()}
                  {trackDrag && (
                    <g
                      data-annotation-overlay
                      data-track-drag-preview
                      data-track-drag-blocked={Boolean(trackDragPreview?.error)}
                      data-track-drag-constrained={Boolean(trackDragPreview?.constraint)}
                      data-track-drag-mode={trackDrag.mode}
                      pointerEvents="none"
                    >
                      {(trackDragPreview?.error || trackDragPreview?.constraint) && (
                        <circle
                          cx={trackDrag.current.x}
                          cy={trackDrag.current.y}
                          r={(view.width / size.width) * 6}
                          fill="none"
                          stroke="var(--pcb-route-blocked)"
                          strokeWidth={2}
                          vectorEffect="non-scaling-stroke"
                        />
                      )}
                    </g>
                  )}
                  {route?.legs.map((leg) => (
                    <g key={leg.via.id} data-annotation-overlay pointerEvents="none">
                      <polyline
                        data-route-leg={leg.layer}
                        points={pointString(leg.points)}
                        fill="none"
                        stroke={
                          fixedRouteIssue ? 'var(--pcb-route-blocked)' : layerColor(leg.layer)
                        }
                        strokeWidth={width}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        opacity="0.85"
                      />
                      <g data-route-locked-via>
                        <circle
                          cx={leg.via.x}
                          cy={leg.via.y}
                          r={leg.via.diameter / 2}
                          fill={fixedRouteIssue ? 'var(--pcb-route-blocked)' : 'var(--pcb-through)'}
                        />
                        <circle
                          cx={leg.via.x}
                          cy={leg.via.y}
                          r={leg.via.drill / 2}
                          fill="var(--canvas)"
                        />
                      </g>
                    </g>
                  ))}
                  {route && (
                    <polyline
                      data-annotation-overlay
                      data-route-preview
                      data-route-blocked={Boolean(routingIssue)}
                      points={pointString(previewRoute)}
                      fill="none"
                      stroke={routingIssue ? 'var(--pcb-route-blocked)' : layerColor(route.layer)}
                      strokeWidth={width}
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      opacity="0.85"
                      pointerEvents="none"
                    />
                  )}
                  {route && routingIssue && (
                    <circle
                      data-route-obstacle
                      data-annotation-overlay
                      cx={(viaTarget ? cursor : routeHead).x}
                      cy={(viaTarget ? cursor : routeHead).y}
                      r={(view.width / size.width) * 6}
                      fill="none"
                      stroke="var(--pcb-route-blocked)"
                      strokeWidth={2}
                      vectorEffect="non-scaling-stroke"
                      pointerEvents="none"
                    />
                  )}
                  {tool === 'route' && !viaTarget && routeAnchor.target && (
                    <rect
                      data-annotation-overlay
                      data-route-snap-target={routeAnchor.target.kind}
                      data-route-snap-id={routeAnchor.target.id}
                      x={routeHead.x - (view.width / size.width) * 3}
                      y={routeHead.y - (view.width / size.width) * 3}
                      width={(view.width / size.width) * 6}
                      height={(view.width / size.width) * 6}
                      fill="none"
                      stroke={
                        routeAnchor.error ? 'var(--pcb-route-blocked)' : 'var(--pcb-selected)'
                      }
                      strokeWidth={1}
                      vectorEffect="non-scaling-stroke"
                      pointerEvents="none"
                    />
                  )}
                  {outline &&
                    (outlineShape === 'rectangle' ? (
                      <rect
                        data-annotation-overlay
                        data-outline-preview="rectangle"
                        x={Math.min(outline.x, cursor.x)}
                        y={Math.min(outline.y, cursor.y)}
                        width={Math.abs(outline.x - cursor.x)}
                        height={Math.abs(outline.y - cursor.y)}
                        fill="none"
                        stroke="var(--pcb-outline)"
                        strokeWidth={Math.max(boardOutlineMinWidth, outlineWidth)}
                        strokeDasharray="1 0.5"
                        pointerEvents="none"
                      />
                    ) : (
                      <polyline
                        data-annotation-overlay
                        data-outline-preview="line"
                        points={pointString([outline, cursor])}
                        fill="none"
                        stroke="var(--pcb-outline)"
                        strokeWidth={Math.max(boardOutlineMinWidth, outlineWidth)}
                        strokeDasharray="1 0.5"
                        pointerEvents="none"
                      />
                    ))}
                  {(tool === 'via' || viaTarget) && (
                    <g
                      data-annotation-overlay
                      data-route-via-preview={viaTarget ? viaTarget : undefined}
                      data-route-blocked={Boolean(routingIssue)}
                      pointerEvents="none"
                      opacity="0.65"
                    >
                      <circle
                        cx={cursor.x}
                        cy={cursor.y}
                        r={viaDiameter / 2}
                        fill={routingIssue ? 'var(--pcb-route-blocked)' : 'var(--pcb-through)'}
                      />
                      <circle cx={cursor.x} cy={cursor.y} r={viaDrill / 2} fill="var(--canvas)" />
                    </g>
                  )}
                  {zoneDraft.length > 0 && (
                    <polyline
                      data-annotation-overlay
                      points={pointString([...zoneDraft, cursor, zoneDraft[0]])}
                      fill={layerColor(layer)}
                      fillOpacity="0.12"
                      stroke={layerColor(layer)}
                      strokeWidth={zoneOutlineWidth}
                      strokeDasharray="0.7 0.5"
                      pointerEvents="none"
                    />
                  )}
                  {gesture && (
                    <g
                      data-annotation-overlay
                      pointerEvents="none"
                      fill={annotationMode === 'element' ? 'var(--pcb-selected)' : 'none'}
                      fillOpacity={annotationMode === 'element' ? 0.08 : undefined}
                      stroke={
                        annotationMode === 'element'
                          ? 'var(--pcb-selected)'
                          : 'var(--annotation-mark)'
                      }
                      strokeWidth={
                        annotationMode === 'element' ? 1 : (view.width / size.width) * 1.5
                      }
                      strokeDasharray={
                        annotationMode === 'element' && gesture.end.x < gesture.start.x
                          ? '5 3'
                          : undefined
                      }
                    >
                      {annotationMode === 'freehand' ? (
                        <polyline points={pointString(gesture.points)} />
                      ) : (
                        <rect
                          data-selection-box={
                            annotationMode === 'element'
                              ? gesture.end.x < gesture.start.x
                                ? 'crossing'
                                : 'window'
                              : undefined
                          }
                          x={Math.min(gesture.start.x, gesture.end.x)}
                          y={Math.min(gesture.start.y, gesture.end.y)}
                          width={Math.abs(gesture.start.x - gesture.end.x)}
                          height={Math.abs(gesture.start.y - gesture.end.y)}
                          vectorEffect={
                            annotationMode === 'element' ? 'non-scaling-stroke' : undefined
                          }
                        />
                      )}
                    </g>
                  )}
                  <RuleCheckMarker
                    location={ruleFocus?.location}
                    radius={(view.width / size.width) * 8}
                  />
                  {marquee && (
                    <rect
                      data-annotation-overlay
                      data-selection-box={marquee.end.x < marquee.start.x ? 'crossing' : 'window'}
                      x={Math.min(marquee.start.x, marquee.end.x)}
                      y={Math.min(marquee.start.y, marquee.end.y)}
                      width={Math.abs(marquee.end.x - marquee.start.x)}
                      height={Math.abs(marquee.end.y - marquee.start.y)}
                      fill="var(--pcb-selected)"
                      fillOpacity="0.08"
                      stroke="var(--pcb-selected)"
                      strokeWidth={1}
                      strokeDasharray={marquee.end.x < marquee.start.x ? '5 3' : undefined}
                      vectorEffect="non-scaling-stroke"
                      pointerEvents="none"
                    />
                  )}
                </>
              )}
            </LayoutCameraScaleRender>
            <rect
              data-layout-interaction-surface
              data-annotation-overlay
              x={view.x}
              y={view.y}
              width={view.width}
              height={view.width / ratio}
              fill="transparent"
            />
          </svg>
          {analysisReadout}
          <LayoutCameraRender camera={camera}>
            {(view) => (
              <CanvasAnnotations
                ref={controller}
                svg={svg}
                doc={schematic}
                board={pcb}
                active={active && !annotationDisabled && tool === 'annotate'}
                sessionId={annotationSessionId}
                annotations={annotations}
                onChange={onAnnotationsChange}
                onAdd={onAnnotationAdd}
                onSelection={setAnnotationIds}
                selectionIds={annotationIds}
                selectableIds={annotationSelectableIds}
                view={view}
                ratio={1 / ratio}
                mode={annotationMode}
                onMode={setAnnotationMode}
                onExit={() => activate('select')}
              />
            )}
          </LayoutCameraRender>
          {fillSettingsOpen && !toolSettings && (
            <CopperFillSettings
              clearance={fillClearance}
              active={fillAvailable}
              onFill={fillZones}
              onClose={() => {
                setFillSettingsOpen(false);
                focusCanvas();
              }}
              onCancelField={focusCanvas}
            />
          )}
          {toolSettings && (
            <aside
              id={toolSettingsId}
              className="layout-tool-settings editor-tool-sheet"
              data-tool={tool}
              aria-label={
                tool === 'route'
                  ? 'Routing settings'
                  : tool === 'outline'
                    ? 'Outline settings'
                    : 'Via settings'
              }
              onKeyDown={(e) => {
                if (
                  !active ||
                  e.nativeEvent.isComposing ||
                  e.nativeEvent.keyCode === 229 ||
                  e.key !== 'Escape' ||
                  e.defaultPrevented
                )
                  return;
                e.preventDefault();
                e.stopPropagation();
                activate('select');
              }}
            >
              <header>
                <strong>
                  {tool === 'route'
                    ? 'Route tracks'
                    : tool === 'outline'
                      ? 'Draw board outline'
                      : 'Through via'}
                </strong>
              </header>
              <div className="layout-tool-settings-content">
                {tool === 'outline' && (
                  <>
                    <label className="layout-field">
                      <span>Shape</span>
                      <Select
                        label="Outline shape"
                        onClosedEscape={active ? () => activate('select') : undefined}
                        value={outlineShape}
                        options={[
                          { value: 'line', label: 'Lines' },
                          { value: 'rectangle', label: 'Rectangle' },
                        ]}
                        onChange={(value) => {
                          setOutline(null);
                          setError('');
                          setOutlineShape(value as typeof outlineShape);
                          focusCanvas();
                        }}
                      />
                    </label>
                    <div className="layout-field">
                      <span>Layer</span>
                      <span className="layout-property-value">Edge.Cuts</span>
                    </div>
                    <NumberField
                      label="Line width (mm)"
                      value={outlineWidth}
                      min={0.01}
                      max={10}
                      onCommit={setOutlineWidth}
                      onCancel={focusCanvas}
                    />
                    <button
                      className="dialog-button primary"
                      aria-label="Finish board outline"
                      disabled={!outline}
                      onClick={() => finishOutline()}
                    >
                      Finish outline
                    </button>
                  </>
                )}
                {tool === 'via' && !trackDrag && (
                  <label className="layout-field">
                    <span>Net</span>
                    <Select
                      label="Via placement net"
                      onClosedEscape={active ? () => activate('select') : undefined}
                      value={validNet}
                      options={netOptions}
                      placeholder="Choose a net"
                      onChange={(v) => {
                        setRoute(null);
                        setViaTarget(null);
                        setError('');
                        setNet(v);
                      }}
                    />
                  </label>
                )}
                {tool === 'route' ? (
                  <>
                    <NumberField
                      label="Track width (mm)"
                      value={width}
                      min={0.05}
                      max={20}
                      onCommit={setWidth}
                      onCancel={focusCanvas}
                    />
                    <NumberField
                      label="Via diameter (mm)"
                      value={viaDiameter}
                      min={Math.max(0.2, viaDrill + 0.01)}
                      max={20}
                      onCommit={setViaDiameter}
                      onCancel={focusCanvas}
                    />
                    <NumberField
                      label="Via drill (mm)"
                      value={viaDrill}
                      min={0.1}
                      max={viaDiameter - 0.01}
                      onCommit={setViaDrill}
                      onCancel={focusCanvas}
                    />
                  </>
                ) : tool === 'via' ? (
                  <div className="layout-two-fields">
                    <NumberField
                      label="Diameter (mm)"
                      value={viaDiameter}
                      min={Math.max(0.2, viaDrill + 0.01)}
                      max={20}
                      onCommit={setViaDiameter}
                      onCancel={focusCanvas}
                    />
                    <NumberField
                      label="Drill (mm)"
                      value={viaDrill}
                      min={0.1}
                      max={viaDiameter - 0.01}
                      onCommit={setViaDrill}
                      onCancel={focusCanvas}
                    />
                  </div>
                ) : null}
              </div>
              <button
                className="layout-tool-settings-close"
                aria-label="Close tool settings"
                title="Close"
                onClick={() => activate('select')}
              >
                <X size={15} />
              </button>
            </aside>
          )}
          {error && (
            <div role="alert" className="layout-error">
              <span>{error}</span>
              <button aria-label="Dismiss error" title="Dismiss error" onClick={() => setError('')}>
                <X size={14} />
              </button>
            </div>
          )}
          {copper.error && !error && (
            <div className="layout-error" role="status">
              {copper.error}
            </div>
          )}
          <LayoutCameraScaleRender camera={camera}>
            {(view) => {
              const scaleLength =
                [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100]
                  .filter((n) => (n * size.width) / view.width <= 100)
                  .at(-1) ?? 0.1;
              return (
                <div className="layout-scale" aria-label="Layout scale">
                  <i style={{ width: (scaleLength * size.width) / view.width }} />
                  {scaleLength} mm
                </div>
              );
            }}
          </LayoutCameraScaleRender>
          <CanvasContextMenu
            target={svg}
            active={active}
            identity={pcb}
            onError={setError}
            actions={[
              {
                id: 'fit-board',
                label: 'Fit board to canvas',
                icon: Maximize,
                run: () => fit('board'),
              },
              { id: 'fit-all', label: 'Fit all objects', icon: Maximize, run: () => fit('all') },
              {
                id: 'actual-size',
                label: 'Actual size (100%)',
                icon: Maximize,
                run: () => zoom(size.width / (view.width * pixelsPerMM)),
              },
              { id: 'zoom-in', label: 'Zoom in', icon: Plus, run: () => zoom(1 / 1.2) },
              { id: 'zoom-out', label: 'Zoom out', icon: Minus, run: () => zoom(1.2) },
              {
                id: 'export',
                label: 'Export image',
                icon: ImageDown,
                disabled: exporting,
                run: exportImage,
              },
              {
                id: 'select-all',
                label: 'Select all',
                icon: Scan,
                separated: true,
                disabled: tool !== 'select' || Boolean(onAnalysisProbe),
                run: () => {
                  cancelGesture();
                  setSelection(allVisibleSelections());
                  setInspectedPadId('');
                },
              },
              {
                id: 'clear-selection',
                label: 'Clear selection',
                icon: SquareDashed,
                disabled: !selection.length,
                run: () => {
                  setSelection([]);
                  setInspectedPadId('');
                },
              },
              {
                id: 'rotate',
                label: 'Rotate selection',
                icon: RotateCw,
                disabled:
                  tool !== 'select' ||
                  !selection.length ||
                  Boolean(onAnalysisProbe) ||
                  Boolean(drag || trackDrag),
                run: () => rotate(90, selection),
              },
              {
                id: 'delete',
                label: 'Delete selection',
                icon: Trash2,
                destructive: true,
                disabled:
                  tool !== 'select' ||
                  !selection.length ||
                  Boolean(onAnalysisProbe) ||
                  Boolean(drag || trackDrag),
                run: () => remove(selection),
              },
            ]}
          />
          <div className="zoom-controls">
            <button aria-label="Zoom out" title="Zoom out" onClick={() => zoom(1.2)}>
              <Minus size={15} />
            </button>
            <button
              className="zoom-value"
              aria-label="Actual size (100%)"
              onClick={() => zoom(size.width / (view.width * pixelsPerMM))}
            >
              <LayoutCameraScaleRender camera={camera}>
                {(view) => `${Math.round((size.width / view.width / pixelsPerMM) * 100)}%`}
              </LayoutCameraScaleRender>
            </button>
            <button aria-label="Zoom in" title="Zoom in" onClick={() => zoom(1 / 1.2)}>
              <Plus size={15} />
            </button>
            <i />
            <button aria-label="Fit board to canvas" title="Fit board" onClick={() => fit('board')}>
              <Maximize size={15} />
            </button>
          </div>
        </div>
        {analysisPanel}
        <aside
          ref={sidebarDock}
          className="layout-sidebar editor-sidebar-sections"
          aria-label="Layout sidebar"
          hidden={!sidebarVisible}
          style={{ width: sidebarSize.width }}
        >
          <EditorDisplayDrawer
            label="Properties"
            className="editor-properties-drawer"
            open={propertiesExpanded}
            onOpenChange={setPropertiesExpanded}
          >
            {inspectorMounted && (
              <RetainedLayoutProperties visible={propertiesActive} shown={propertiesShown}>
                {() => (
                  <aside
                    ref={propertiesPanel}
                    className={
                      'layout-inspector' +
                      (selectedFootprint && !inspectedPad ? ' layout-part-inspector' : '')
                    }
                    aria-label="Layout properties"
                    hidden={!propertiesActive}
                    inert={!propertiesActive}
                  >
                    <div className="layout-inspector-content" key={propertiesSubject}>
                      <LayoutProperties
                        board={pcb}
                        schematic={schematic}
                        active={propertiesActive}
                        resetKey={propertiesShown}
                        footprint={selectedFootprint}
                        track={selectedTrack}
                        via={selectedVia}
                        graphic={selectedGraphic}
                        zone={selectedZone}
                        pad={inspectedPad}
                        padOwner={inspectedFootprint}
                        rectangle={selectedRectangle}
                        selectionCount={selection.length}
                        showEmptyState={tool === 'select' || tool === 'hand'}
                        snap={snap}
                        onCommit={commit}
                        onFootprint={updateFootprint}
                        onSavePartProperties={onSavePartProperties}
                        onRequestSave={onRequestSave}
                        capabilityHost={capabilityHost}
                        onTrack={updateTrack}
                        onZone={updateZone}
                        onRectangle={updateRectangle}
                        onError={setError}
                        onInspectFootprint={(id) => {
                          setInspectedPadId('');
                          setSelection([{ kind: 'footprint', id }]);
                        }}
                      />
                      {tool === 'zone' && (
                        <>
                          <div className="layout-property-heading">Copper zone</div>
                          <Select
                            active={propertiesActive}
                            label="New zone net"
                            value={validNet}
                            options={netOptions}
                            placeholder="Choose a net"
                            onChange={setNet}
                          />
                          <NumberField
                            resetKey={propertiesShown}
                            active={propertiesActive}
                            label="Zone clearance (mm)"
                            value={zoneClearance}
                            min={0}
                            max={100}
                            onCommit={setZoneClearance}
                          />
                          <div className="layout-two-fields">
                            <NumberField
                              resetKey={propertiesShown}
                              active={propertiesActive}
                              label="Zone thermal gap (mm)"
                              value={zoneThermalGap}
                              min={0}
                              max={100}
                              onCommit={setZoneThermalGap}
                            />
                            <NumberField
                              resetKey={propertiesShown}
                              active={propertiesActive}
                              label="Zone thermal bridge (mm)"
                              value={zoneThermalBridge}
                              min={0.0001}
                              max={100}
                              onCommit={setZoneThermalBridge}
                            />
                          </div>
                          <button
                            className="secondary"
                            disabled={zoneDraft.length < 3}
                            onClick={finishZone}
                          >
                            Finish copper zone
                          </button>
                        </>
                      )}
                    </div>
                    {selectedFootprint && !inspectedPad && (
                      <div className="inspector-footer">
                        <button
                          className="delete-button"
                          disabled={
                            !propertiesActive ||
                            tool !== 'select' ||
                            !!drag ||
                            !!trackDrag ||
                            !!marquee
                          }
                          onClick={() => remove([{ kind: 'footprint', id: selectedFootprint.id }])}
                        >
                          <Trash2 size={14} /> Delete object
                        </button>
                      </div>
                    )}
                  </aside>
                )}
              </RetainedLayoutProperties>
            )}
            {!propertiesShown && (
              <PropertiesEmptyState icon={Cpu}>
                Select an object to view its properties.
              </PropertiesEmptyState>
            )}
          </EditorDisplayDrawer>
          {appearancePanelContent}
          <InspectorResize
            target={sidebarDock}
            size={sidebarSize}
            onResize={setSidebarSize}
            label="layout sidebar"
            axes={['width']}
            minWidth={224}
            bounds={() => ({
              width: Math.min(
                480,
                Math.max(0, (sidebarDock.current?.parentElement?.clientWidth ?? 480) - 160),
              ),
              height: sidebarDock.current?.parentElement?.clientHeight ?? 0,
            })}
          />
        </aside>
      </div>
      <EditorStatusBar
        className="layout-status"
        active={active && visible}
        mode={
          onAnalysisProbe
            ? 'Analysis probe'
            : trackDrag
              ? trackDrag.mode === 'corner'
                ? 'Dragging track corner'
                : 'Dragging connected tracks'
              : drag
                ? 'Moving selection'
                : marquee
                  ? 'Selecting'
                  : tool === 'route'
                    ? route
                      ? 'Routing'
                      : 'Route tracks'
                    : tool === 'outline'
                      ? outline
                        ? outlineShape === 'rectangle'
                          ? 'Choose opposite corner'
                          : 'Choose next corner'
                        : 'Choose first corner'
                      : tool === 'place'
                        ? 'Place footprint'
                        : tool === 'via'
                          ? 'Place through via'
                          : tool === 'zone'
                            ? zoneDraft.length
                              ? 'Choose next corner'
                              : 'Draw copper zone'
                            : tool === 'annotate'
                              ? 'Annotation mode'
                              : tool === 'hand'
                                ? 'Pan'
                                : 'Interaction mode'
        }
        coordinates={<CanvasCoordinates coordinates={coordinates} />}
        controls={gridControl}
        status={
          outlineResizePreview?.error ||
          trackDragPreview?.error ||
          (trackDragPreview?.constraint ? 'Stopped at obstacle' : '') ||
          imageStatus ||
          routingIssue ||
          draftStatus
        }
      />
      {choosing && active && (
        <LibraryChooser
          key={partId}
          capabilityHost={capabilityHost}
          kind="footprints"
          title="Place footprint"
          label="Footprint placement"
          actionLabel="Place footprint"
          canChoose={unplaced.some((part) => part.id === partId)}
          header={
            <div className="layout-placement-target">
              {unplaced.length ? (
                <label className="layout-field">
                  <span>Component</span>
                  <Select
                    label="Schematic component"
                    value={partId}
                    options={unplaced.map((part) => ({
                      value: part.id,
                      label: `${part.ref} · ${part.value}`,
                    }))}
                    onChange={setPartId}
                  />
                </label>
              ) : (
                <p className="layout-placement-empty">
                  No unplaced components in the primary schematic.
                </p>
              )}
            </div>
          }
          initialSearch={
            (placement?.symbolId === partId ? placement.libraryId : undefined) ??
            schematic.parts.find((p) => p.id === partId)?.fields?.Footprint ??
            ''
          }
          onClose={() => {
            setChoosing(false);
            if (!placement) activate('select');
          }}
          onChoose={(detail) => {
            if ('footprint' in detail && 'pads' in detail)
              chooseFootprint(detail as FootprintDetail);
          }}
        />
      )}
    </div>
  );
}

// Deactivation first cancels gestures. Hidden presentation then retains its
// inputs until reveal, which receives the latest complete project and callbacks.
export default memo(
  LayoutEditor,
  (previous, next) => previous.visible === false && next.visible === false,
);
