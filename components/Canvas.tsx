'use client';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { isOwnedCircuit } from '@/lib/immutable-project';
import type { RuleCheckFocus } from '@/lib/design-rule-checks';
import RuleCheckMarker from './RuleCheckMarker';
import { ImageDown, Maximize, Minus, Plus } from 'lucide-react';
import CanvasAnnotations, {
  type AnnotationMode,
  type CanvasAnnotationsHandle,
} from './CanvasAnnotations';
import type { AgentAnnotation } from '@/lib/agent-annotations';
import type { ProbeTarget } from '@/lib/spice';
import { annotationSelectionBounds } from '@/lib/annotation-screenshot';
import {
  type Circuit,
  type Kind,
  type Point,
  createPart,
  catalog,
  libraries,
  pinPositions,
  snap,
  uid,
  circuitFingerprint,
} from '@/lib/circuit';
import SymbolGraphic from './SymbolGraphic';
import SchematicDrawing from './SchematicDrawing';
import useCanvasBrightness from './useCanvasBrightness';
import type { SchematicLayers } from '@/lib/schematic-layers';
import {
  type CanvasBounds,
  fieldDragLinks,
  visibleSchematicIds,
  visibleSchematicWireTargetIds,
  visibleJunctions,
  resizeSchematicView,
} from '@/lib/schematic-view';
import { schematicTexts, schematicPolylines } from '@/lib/schematic-text';
import { type SExpr } from '@/lib/sexpr';
import { createLibraryPart, symbolAnnotation } from '@/lib/library';
import { commitWireRoute, onWire, samePoint } from '@/lib/wiring';
import {
  selectedField,
  objectPosition,
  moveSelection,
  transformSelection,
} from '@/lib/schematic-edit';
import { hasOpenOverlay } from './Dialog';
import {
  defaultLeftButtonDrag,
  pointerDragsObject,
  type LeftButtonDrag,
} from '@/lib/selection-drag';
import {
  applySelection,
  schematicIdsInRectangle,
  selectionMode,
  type SchematicSelectionBounds,
  type SelectionMode,
} from '@/lib/schematic-selection';
import { captureSchematicPNG, saveDrawingPNG } from '@/lib/drawing-export';
import { previewSchematicMove, type SchematicMoveOperation } from '@/lib/schematic-move';
import {
  createSchematicWireDraft,
  extendSchematicWireDraft,
  toggleSchematicWirePosture,
  backtrackSchematicWireDraft,
  previewSchematicWireDraft,
  type SchematicWireDraft,
} from '@/lib/schematic-wire-draft';
import {
  createSchematicWireTargetResolver,
  visibleSchematicPins,
} from '@/lib/schematic-wire-target';
import {
  defaultSchematicSelectionFilters,
  selectableSchematicIds,
  type SchematicSelectionFilters,
} from '@/lib/schematic-selection-filters';

export type SchematicMoveRequest = { id: number; schematicId: string; connected: boolean };
export type SchematicNavigationRequest = {
  id: number;
  basis: Circuit;
  tool: Tool;
  partId?: string;
  cancelPending?: boolean;
};
type Pickup = {
  basis: Circuit;
  ids: string[];
  anchor: Point;
  target: Point;
  operations: SchematicMoveOperation[];
  connected: boolean;
  axis: 'x' | 'y' | null;
  preview: Circuit;
};
type PointerDrag = {
  basis: Circuit;
  id: string;
  origin: Point;
  start: Point;
  current: Point;
  ids: string[];
  screen: Point;
  moved: boolean;
  connected: boolean;
  axis: 'x' | 'y' | null;
  preview: Circuit | null;
  error: string | null;
};
export type Tool =
  | 'select'
  | 'hand'
  | 'annotate'
  | 'wire'
  | 'place'
  | 'label'
  | 'global-label'
  | 'no-connect'
  | 'drag';
export type CanvasViewport = {
  view: { x: number; y: number; width: number };
  ratio: number;
  canvasWidth: number;
  zoomBaseWidth: number;
};
type Props = {
  ruleFocus?: RuleCheckFocus | null;
  initialViewport?: CanvasViewport;
  onViewportChange?: (viewport: CanvasViewport) => void;
  active?: boolean;
  editingBlocked?: boolean;
  moveRequest?: SchematicMoveRequest | null;
  onMoveRequestHandled?: (id: number) => void;
  onMoveStateChange?: (mode: 'move' | 'drag' | null) => void;
  navigationRequest?: SchematicNavigationRequest | null;
  onNavigationRequestHandled?: (id: number) => void;
  doc: Circuit;
  selection: string[];
  onSelection: (ids: string[]) => void;
  onSelect: (id: string | null) => void;
  tool: Tool;
  probing?: boolean;
  onProbe?: (target: ProbeTarget) => void;
  kind: Kind;
  placement?: { symbol: SExpr; unit: number };
  onProperties?: (id: string) => void;
  onDelete?: (ids: string[]) => void;
  annotations: AgentAnnotation[];
  annotationSessionId: string;
  onAnnotationsChange: (annotations: AgentAnnotation[]) => void;
  onAnnotationAdd?: () => void;
  onCommit: (d: Circuit) => boolean;
  setTool: (t: Tool) => void;
  fitKey: number;
  onPosition: (p: Point) => void;
  grid: boolean;
  gridSpacing: number;
  layers: SchematicLayers;
  selectionFilters?: SchematicSelectionFilters;
  leftButtonDrag?: LeftButtonDrag;
  onNotify?: (message: string) => void;
};
export default function Canvas({
  ruleFocus,
  initialViewport,
  onViewportChange,
  active = true,
  editingBlocked = false,
  moveRequest,
  onMoveRequestHandled,
  onMoveStateChange,
  navigationRequest,
  onNavigationRequestHandled,
  doc,
  selection,
  onSelection,
  onSelect,
  tool,
  probing = false,
  onProbe,
  kind,
  placement,
  onProperties,
  onDelete,
  annotations,
  annotationSessionId,
  onAnnotationsChange,
  onAnnotationAdd,
  onCommit,
  setTool,
  fitKey,
  onPosition,
  grid,
  gridSpacing,
  layers,
  selectionFilters = defaultSchematicSelectionFilters,
  leftButtonDrag = defaultLeftButtonDrag,
  onNotify,
}: Props) {
  const svg = useRef<SVGSVGElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const darkCanvas = useCanvasBrightness(surface);
  const [exporting, setExporting] = useState(false);
  const annotationController = useRef<CanvasAnnotationsHandle>(null);
  const [annotationMode, setAnnotationMode] = useState<AnnotationMode>('element');
  const [probeHover, setProbeHover] = useState<ProbeTarget | null>(null);
  const canProbe = probing && (tool === 'select' || tool === 'annotate');
  const probeClick = useRef<{
    pointerId: number;
    x: number;
    y: number;
    target: ProbeTarget;
  } | null>(null);
  const [annotationGesture, setAnnotationGesture] = useState<{
    start: Point;
    end: Point;
    id?: string;
    points: Point[];
  } | null>(null);
  const canvasId = useId();
  const gridId = `${canvasId}-grid`;
  const [view, setView] = useState(initialViewport?.view ?? { x: 0, y: 14, width: 185 });
  const [ratio, setRatio] = useState(initialViewport?.ratio ?? 0.75);
  const [canvasWidth, setCanvasWidth] = useState(initialViewport?.canvasWidth ?? 800);
  const [zoomBaseWidth, setZoomBaseWidth] = useState(initialViewport?.zoomBaseWidth ?? 800);
  useEffect(() => {
    onViewportChange?.({ view, ratio, canvasWidth, zoomBaseWidth });
  }, [view, ratio, canvasWidth, zoomBaseWidth, onViewportChange]);
  const zoomScale = canvasWidth / zoomBaseWidth;
  const hitPadding = Math.min(0.5, (view.width / canvasWidth) * 3);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [wireDraft, setWireDraftState] = useState<SchematicWireDraft | null>(null);
  const wireDraftRef = useRef<SchematicWireDraft | null>(null);
  const wireDraftRedo = useRef<SchematicWireDraft[]>([]);
  const [vertical, setVertical] = useState(false);
  function updateWireDraft(next: SchematicWireDraft | null, preserveRedo = false) {
    if (!preserveRedo) wireDraftRedo.current = [];
    wireDraftRef.current = next;
    setWireDraftState(next);
  }
  const wirePreview = useMemo(() => {
    if (!wireDraft) return [];
    try {
      return previewSchematicWireDraft(wireDraft, cursor);
    } catch {
      return [...wireDraft.points];
    }
  }, [wireDraft, cursor]);
  const [placementRotation, setPlacementRotation] = useState(0);
  const pendingWire = useRef<Point | null>(null);
  const pointerPosition = useRef<{ clientX: number; clientY: number } | null>(null);
  const pointerInside = useRef(false);
  const pickupRef = useRef<Pickup | null>(null);
  const pickupRejected = useRef<string | null>(null);
  const gestureGeneration = useRef(0);
  const [pickup, setPickup] = useState<Pickup | null>(null);
  const pickupMode = pickup ? (pickup.connected ? 'drag' : 'move') : null;
  useEffect(() => {
    onMoveStateChange?.(pickupMode);
    return () => onMoveStateChange?.(null);
  }, [pickupMode, onMoveStateChange]);
  const [drag, setDrag] = useState<PointerDrag | null>(null);
  const dragRef = useRef<PointerDrag | null>(null);
  function storeDrag(next: PointerDrag | null) {
    dragRef.current = next;
    setDrag(next);
  }
  const [box, setBox] = useState<{
    start: Point;
    end: Point;
    screen: Point;
    previous: string[];
    mode: SelectionMode;
    clickId?: string;
  } | null>(null);
  const visibleIds = useMemo(() => visibleSchematicIds(doc, layers), [doc, layers]);
  const wireTargetIds = useMemo(
    () => visibleSchematicWireTargetIds(doc, layers),
    [
      doc.parts,
      doc.libraries,
      doc.wires,
      doc.labels,
      doc.junctions,
      layers.symbols,
      layers.wires,
      layers.labels,
    ],
  );
  const resolveWireTarget = useMemo(
    () => createSchematicWireTargetResolver(doc, wireTargetIds),
    [doc.parts, doc.libraries, doc.wires, doc.labels, doc.junctions, wireTargetIds],
  );
  const snapTargets = useMemo(
    () => [
      ...(layers.symbols
        ? doc.parts.flatMap((part) =>
            visibleSchematicPins(part, doc.libraries[part.libId]).map((pin) => ({
              id: part.id,
              point: pin.point,
            })),
          )
        : []),
      ...(layers.wires
        ? doc.wires.flatMap((wire) => [
            { id: wire.id, point: wire.a },
            { id: wire.id, point: wire.b },
          ])
        : []),
    ],
    [doc.parts, doc.libraries, doc.wires, layers.symbols, layers.wires],
  );
  const selectableIds = useMemo(
    () => selectableSchematicIds(doc, layers, selectionFilters),
    [doc, layers, selectionFilters],
  );
  const editable = tool === 'select' || tool === 'drag';
  const drawing = pickup?.preview ?? (drag?.moved && drag.connected ? (drag.preview ?? doc) : doc);
  // Geometry depends on document/preview replacements, not selection or camera state.
  const drawingJunctions = useMemo(
    () => (layers.wires ? visibleJunctions(drawing) : []),
    [drawing.parts, drawing.libraries, drawing.wires, drawing.junctions, layers.wires],
  );
  const drawingIsDocument = drawing === doc;
  const presentationDrag =
    drawingIsDocument &&
    drag &&
    !drag.connected &&
    (drag.current.x !== drag.origin.x || drag.current.y !== drag.origin.y)
      ? drag
      : null;
  const offset = useCallback(
    (id: string): Point =>
      presentationDrag?.ids.includes(id) &&
      !(selectedField(id) && presentationDrag.ids.includes(selectedField(id)!.id))
        ? {
            x: presentationDrag.current.x - presentationDrag.origin.x,
            y: presentationDrag.current.y - presentationDrag.origin.y,
          }
        : { x: 0, y: 0 },
    [presentationDrag],
  );
  const beginHandler = useRef(begin);
  beginHandler.current = begin;
  const beginRetained = useCallback(
    (event: React.PointerEvent, id: string) => beginHandler.current(event, id),
    [],
  );
  const pinHandler = useRef(pinPointerDown);
  pinHandler.current = pinPointerDown;
  const pinPointerDownRetained = useCallback(
    (event: React.PointerEvent, id: string, point: Point) => pinHandler.current(event, id, point),
    [],
  );
  function pinPointerDown(event: React.PointerEvent, id: string, pin: Point) {
    if (canProbe) return;
    if (event.button !== 0 || !['select', 'wire'].includes(tool)) return;
    if (tool === 'select' && selectionMode(event) !== 'replace') {
      begin(event, id);
      return;
    }
    event.stopPropagation();
    if (tool === 'select') {
      pendingWire.current = pin;
      setTool('wire');
    } else addWire(event.shiftKey ? wirePoint(event) : pin);
  }
  function begin(e: React.PointerEvent, id: string) {
    if (
      !active ||
      !selectableIds.has(id) ||
      (!editable && tool !== 'annotate') ||
      e.button !== 0 ||
      pointerId.current !== null
    )
      return;
    if (editingBlocked || pickupRef.current) return;
    e.stopPropagation();
    if (tool === 'annotate') {
      startAnnotation(e, id);
      return;
    }
    const mode = selectionMode(e);
    if (tool === 'select' && !pointerDragsObject(leftButtonDrag, selection.includes(id))) {
      setBox({
        start: point(e, false),
        end: point(e, false),
        screen: { x: e.clientX, y: e.clientY },
        previous: selection,
        mode,
        clickId: id,
      });
      capturePointer(e.pointerId);
      return;
    }
    if (mode !== 'replace') {
      onSelection(applySelection(selection, [id], mode));
      return;
    }
    const ids = selection.includes(id)
      ? selection.filter((selectedId) => selectableIds.has(selectedId))
      : [id];
    onSelection(ids);
    const wire = doc.wires.find((w) => w.id === id);
    const origin = objectPosition(doc, id) || wire?.a;
    if (!origin) return;
    storeDrag({
      basis: doc,
      id,
      ids,
      origin,
      start: point(e, false),
      current: origin,
      screen: { x: e.clientX, y: e.clientY },
      moved: false,
      connected:
        tool === 'drag' ||
        ids.some((selectedId) =>
          [...doc.parts, ...doc.wires, ...doc.labels].some((object) => object.id === selectedId),
        ),
      preview: doc,
      error: null,
      // A single straight segment slides across its axis, stretching its neighbours.
      axis:
        wire && ids.length === 1
          ? wire.a.y === wire.b.y
            ? 'y'
            : wire.a.x === wire.b.x
              ? 'x'
              : null
          : null,
    });
    capturePointer(e.pointerId);
  }
  const pan = useRef<{ x: number; y: number; view: typeof view } | null>(null);
  const pointerId = useRef<number | null>(null);
  const [panning, setPanning] = useState(false);
  const [pointerFocused, setPointerFocused] = useState(false);
  function cancelGesture() {
    gestureGeneration.current++;
    pickupRef.current = null;
    pickupRejected.current = null;
    setPickup(null);
    probeClick.current = null;
    pan.current = null;
    setPanning(false);
    storeDrag(null);
    setBox(null);
    setAnnotationGesture(null);
    const id = pointerId.current;
    pointerId.current = null;
    if (id !== null && svg.current?.hasPointerCapture(id)) svg.current.releasePointerCapture(id);
  }
  function capturePointer(id: number) {
    pointerId.current = id;
    svg.current?.setPointerCapture(id);
  }
  useEffect(() => {
    cancelGesture();
    if (!active) pointerInside.current = false;
    pendingWire.current = null;
    updateWireDraft(null);
  }, [doc, layers, active, editingBlocked]);
  useEffect(() => {
    cancelGesture();
  }, [selectionFilters, leftButtonDrag]);
  useEffect(() => {
    if (tool !== 'annotate') return;
    const next = selection.filter((id) => selectableIds.has(id));
    if (next.length !== selection.length) onSelection(next);
  }, [tool, selection, selectableIds, onSelection]);
  function hovered() {
    if (!pointerInside.current) return null;
    const pointer = pointerPosition.current;
    const node = pointer ? document.elementFromPoint(pointer.clientX, pointer.clientY) : null;
    if (!node || !svg.current?.contains(node)) return null;
    const id = node.closest<SVGElement>('[data-selection-id]')?.dataset.selectionId;
    return id && selectableIds.has(id) ? { id, node } : null;
  }
  function actionSelection() {
    const ids = selection.filter((id) => selectableIds.has(id));
    const hit = hovered();
    return applySelection([], ids.length ? ids : hit ? [hit.id] : [], 'replace');
  }
  function updatePickup(next: Omit<Pickup, 'preview'>) {
    try {
      const value = {
        ...next,
        preview: previewSchematicMove(
          next.basis,
          next.ids,
          next.anchor,
          next.target,
          next.operations,
          next.connected,
        ),
      };
      pickupRef.current = value;
      pickupRejected.current = null;
      setPickup(value);
      return true;
    } catch (error) {
      pickupRejected.current = (error as Error).message;
      onNotify?.(pickupRejected.current);
      return false;
    }
  }
  function beginPickup(connected: boolean, pointerTarget = true) {
    if (!active || editingBlocked || !editable || pointerId.current !== null || hasOpenOverlay())
      return;
    const current = pickupRef.current;
    if (current) {
      const wire =
        current.ids.length === 1
          ? current.preview.wires.find((wire) => wire.id === current.ids[0])
          : null;
      updatePickup({
        ...current,
        connected,
        axis:
          connected && wire
            ? wire.a.y === wire.b.y
              ? 'y'
              : wire.a.x === wire.b.x
                ? 'x'
                : null
            : null,
      });
      return;
    }
    const ids = actionSelection();
    if (!ids.length) return;
    const hit = pointerTarget ? hovered() : null;
    const wire = ids.length === 1 ? doc.wires.find((wire) => wire.id === ids[0]) : null;
    const origin = ids.length === 1 ? objectPosition(doc, ids[0]) : null;
    const pin = hit?.id === ids[0] ? hit.node.closest<SVGElement>('[data-probe-pin]') : null;
    const part = pin ? doc.parts.find((part) => part.id === pin.dataset.probePart) : null;
    const pinAnchor = part
      ? pinPositions(part, doc.libraries[part.libId])[Number(pin!.dataset.probePin)]
      : null;
    const at =
      pointerTarget && pointerInside.current && pointerPosition.current
        ? point(pointerPosition.current)
        : (origin ??
          wire?.a ?? { x: view.x + view.width / 2, y: view.y + (view.width * ratio) / 2 });
    const anchor = pinAnchor ?? origin ?? at;
    if (
      updatePickup({
        basis: doc,
        ids,
        anchor,
        target: at,
        operations: [],
        connected,
        axis:
          connected && wire
            ? wire.a.y === wire.b.y
              ? 'y'
              : wire.a.x === wire.b.x
                ? 'x'
                : null
            : null,
      })
    ) {
      probeClick.current = null;
      setProbeHover(null);
      onSelection(ids);
    }
  }
  function pickupTarget(at: Point, current: Pickup) {
    return {
      x: current.axis === 'y' ? current.target.x : at.x,
      y: current.axis === 'x' ? current.target.y : at.y,
    };
  }
  function finishPickup() {
    const current = pickupRef.current;
    if (!current) return;
    if (pickupRejected.current) {
      onNotify?.(pickupRejected.current);
      return;
    }
    if (!active || editingBlocked || current.basis !== doc) {
      cancelGesture();
      return;
    }
    if (
      circuitFingerprint(current.preview) !== circuitFingerprint(doc) &&
      !onCommit(current.preview)
    )
      return;
    cancelGesture();
  }
  const handledMoveRequest = useRef<number | null>(null);
  const moveContext = useRef({ active, editingBlocked, doc, layers, tool, beginPickup });
  moveContext.current = { active, editingBlocked, doc, layers, tool, beginPickup };
  useEffect(() => {
    let previous: CanvasBounds | null = null;
    const observer = new ResizeObserver(() => {
      const b = svg.current?.getBoundingClientRect();
      if (!b?.width || !b.height) return;
      const before = previous;
      previous = b;
      // ResizeObserver runs before paint. Commit the SVG viewBox and scale together
      // now, so a changed sidebar cannot paint one frame with the old viewport.
      flushSync(() => {
        if (before) {
          setView((current) => resizeSchematicView(current, before, b));
        } else if (initialViewport) {
          setView((current) => ({
            ...current,
            width: (current.width * b.width) / initialViewport.canvasWidth,
          }));
        } else setZoomBaseWidth(b.width);
        setRatio(b.height / b.width);
        setCanvasWidth(b.width);
      });
    });
    if (svg.current) observer.observe(svg.current);
    return () => observer.disconnect();
  }, []);
  async function exportImage() {
    if (!svg.current || exporting) return;
    setExporting(true);
    try {
      flushSync(() => cancelGesture());
      const image = await captureSchematicPNG(svg.current);
      const name = await saveDrawingPNG(image, doc.title);
      if (name) onNotify?.(`Exported ${name}`);
    } catch (error) {
      onNotify?.((error as Error).message);
    } finally {
      setExporting(false);
    }
  }
  function fit() {
    cancelGesture();
    // Include actual glyph extents, including long parameters and rotated labels.
    // Anchor points alone can leave the beginning/end of text outside the fitted view.
    const textBounds: Point[] = [];
    const canvasMatrix = svg.current?.getCTM();
    if (canvasMatrix) {
      const inverse = canvasMatrix.inverse();
      for (const text of svg.current!.querySelectorAll('text')) {
        if (getComputedStyle(text).display === 'none') continue;
        const matrix = text.getCTM();
        if (!matrix) continue;
        const box = text.getBBox();
        for (const x of [box.x, box.x + box.width])
          for (const y of [box.y, box.y + box.height]) {
            const point = new DOMPoint(x, y).matrixTransform(inverse.multiply(matrix));
            textBounds.push({ x: point.x, y: point.y });
          }
      }
    }
    const pts = [
      ...textBounds,
      ...(layers.symbols
        ? [
            ...doc.parts,
            ...doc.parts.flatMap((p) =>
              visibleSchematicPins(p, doc.libraries[p.libId]).map((pin) => pin.point),
            ),
          ]
        : []),
      ...(layers.wires ? [...doc.wires.flatMap((w) => [w.a, w.b]), ...doc.junctions] : []),
      ...(layers.labels ? doc.labels : []),
      ...(layers.noConnects ? doc.noConnects || [] : []),
      ...doc.parts.flatMap((p) =>
        [
          ...(layers.references && !p.ref.startsWith('#')
            ? [symbolAnnotation(p, doc.libraries[p.libId], 'Reference')]
            : []),
          ...(layers.values ? [symbolAnnotation(p, doc.libraries[p.libId], 'Value')] : []),
        ].filter((p): p is NonNullable<typeof p> => !!p),
      ),
      ...(layers.notes ? schematicTexts(doc.original) : []),
      ...(layers.notes ? schematicPolylines(doc.original).flatMap((line) => line.points) : []),
    ];
    if (!pts.length) {
      setView({ x: 0, y: 0, width: 185 });
      return;
    }
    const minX = Math.min(...pts.map((p) => p.x)) - 17,
      maxX = Math.max(...pts.map((p) => p.x)) + 24,
      minY = Math.min(...pts.map((p) => p.y)) - 22,
      maxY = Math.max(...pts.map((p) => p.y)) + 24;
    const width = Math.max(maxX - minX, (maxY - minY) / ratio);
    setView({ x: (minX + maxX - width) / 2, y: (minY + maxY - width * ratio) / 2, width });
  }
  const fittedKey = useRef<number | null>(initialViewport ? fitKey : null);
  useEffect(() => {
    if (!active || !fitKey || fittedKey.current === fitKey) return;
    const timer = setTimeout(() => {
      if (fittedKey.current === fitKey) return;
      fit();
      fittedKey.current = fitKey;
    }, 60);
    return () => clearTimeout(timer);
  }, [active, fitKey, ratio]);
  const handledRuleFocus = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!active || !ruleFocus || handledRuleFocus.current === ruleFocus.request) return;
    handledRuleFocus.current = ruleFocus.request;
    cancelGesture();
    if (ruleFocus.location) {
      const { x, y } = ruleFocus.location;
      setView((current) => {
        const width = Math.max(20, Math.min(current.width, 80));
        const pixels = Math.max(1, svg.current?.getBoundingClientRect().width ?? canvasWidth);
        const occluded = Math.min(
          Math.max(0, ruleFocus.occludedWidth ?? 0),
          Math.max(0, pixels - 16),
        );
        return {
          x: x - (width * (pixels - occluded)) / pixels / 2,
          y: y - (width * ratio) / 2,
          width,
        };
      });
    }
  }, [active, ruleFocus, ratio, canvasWidth]);
  useEffect(() => {
    const start = tool === 'wire' ? pendingWire.current : null;
    cancelGesture();
    pendingWire.current = null;
    updateWireDraft(start ? createSchematicWireDraft(start, vertical) : null);
    setCursor(start);
  }, [tool]);
  useEffect(() => {
    if (!moveRequest || handledMoveRequest.current === moveRequest.id) return;
    const generation = gestureGeneration.current;
    const frame = requestAnimationFrame(() => {
      handledMoveRequest.current = moveRequest.id;
      onMoveRequestHandled?.(moveRequest.id);
      const live = moveContext.current;
      if (
        generation !== gestureGeneration.current ||
        !live.active ||
        live.editingBlocked ||
        live.doc !== doc ||
        live.layers !== layers ||
        live.tool !== tool ||
        moveRequest.schematicId !== live.doc.id ||
        hasOpenOverlay()
      )
        return;
      svg.current?.focus({ preventScroll: true });
      // Menu interaction is outside the drawing or over a popup. Retain the
      // selection's original pose until the pointer returns to the canvas.
      live.beginPickup(moveRequest.connected, false);
    });
    return () => cancelAnimationFrame(frame);
  }, [moveRequest]);
  const handledNavigationRequest = useRef<number | null>(null);
  const navigationContext = useRef({
    active,
    editingBlocked,
    doc,
    tool,
    visibleIds,
    navigationRequest,
  });
  navigationContext.current = { active, editingBlocked, doc, tool, visibleIds, navigationRequest };
  useEffect(() => {
    if (!navigationRequest || handledNavigationRequest.current === navigationRequest.id) return;
    const frame = requestAnimationFrame(() => {
      handledNavigationRequest.current = navigationRequest.id;
      onNavigationRequestHandled?.(navigationRequest.id);
      const live = navigationContext.current;
      const canvas = svg.current;
      if (
        !canvas ||
        !canvas.isConnected ||
        !live.active ||
        live.editingBlocked ||
        live.navigationRequest !== navigationRequest ||
        live.doc !== navigationRequest.basis ||
        live.tool !== navigationRequest.tool ||
        pointerId.current !== null ||
        hasOpenOverlay()
      )
        return;
      const bounds = canvas.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      if (navigationRequest.cancelPending) {
        cancelGesture();
        pendingWire.current = null;
        updateWireDraft(null);
      }
      if (navigationRequest.partId) {
        const part = live.doc.parts.find((part) => part.id === navigationRequest.partId);
        if (!part || !live.visibleIds.has(part.id)) return;
        let target: ReturnType<typeof annotationSelectionBounds>;
        try {
          target = annotationSelectionBounds(canvas, [part.id]);
        } catch {
          return;
        }
        const aspect = bounds.height / bounds.width;
        const minimumWidth = Math.max(
          8,
          2 *
            (Math.max(Math.abs(target.x - part.x), Math.abs(target.x + target.width - part.x)) + 2),
          (2 *
            (Math.max(Math.abs(target.y - part.y), Math.abs(target.y + target.height - part.y)) +
              2)) /
            aspect,
        );
        cancelGesture();
        pendingWire.current = null;
        updateWireDraft(null);
        fittedKey.current = fitKey;
        // Preserve an already readable close view; reveal distant targets at a
        // bounded scale, widening only enough to contain the complete symbol.
        setView((current) => {
          const width = Math.max(minimumWidth, Math.min(current.width, 80));
          return { x: part.x - width / 2, y: part.y - (width * aspect) / 2, width };
        });
      }
      canvas.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [navigationRequest]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (!active || e.defaultPrevented || hasOpenOverlay()) return;
      if (e.key === 'Escape') {
        updateWireDraft(null);
        cancelGesture();
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [active]);
  function point(e: { clientX: number; clientY: number }, snapped = true, bounds?: DOMRect) {
    const b = bounds ?? svg.current!.getBoundingClientRect();
    const raw = {
      x: view.x + ((e.clientX - b.left) / b.width) * view.width,
      y: view.y + ((e.clientY - b.top) / b.width) * view.width,
    };
    if (!snapped) return raw;
    let near: Point | undefined;
    let distance = (view.width / b.width) * 9;
    // Preserve nearest-target/tie order without rebuilding pin geometry or
    // sorting every anchor on each pointer event. Pickup exclusions stay live.
    for (const target of snapTargets) {
      if (pickupRef.current?.ids.includes(target.id)) continue;
      const candidate = Math.hypot(raw.x - target.point.x, raw.y - target.point.y);
      if (candidate < distance) {
        near = target.point;
        distance = candidate;
      }
    }
    return near || { x: snap(raw.x), y: snap(raw.y) };
  }
  function addWire(p: Point) {
    if (!active || editingBlocked) return;
    try {
      const current = wireDraftRef.current;
      if (!current) {
        updateWireDraft(createSchematicWireDraft(p, vertical));
        setCursor(p);
        return;
      }
      const next = extendSchematicWireDraft(current, p);
      if (next === current) return;
      if (isWireConnection(p)) {
        if (onCommit(commitWireRoute(doc, [...next.points]))) updateWireDraft(null);
      } else updateWireDraft(next);
    } catch (error) {
      onNotify?.((error as Error).message);
    }
  }
  function wirePoint(
    e: { clientX: number; clientY: number; shiftKey?: boolean },
    raw = point(e, false),
  ) {
    return resolveWireTarget(raw, (view.width / canvasWidth) * 9, !e.shiftKey);
  }
  function refreshWireCursor(shiftKey: boolean) {
    if (
      !active ||
      editingBlocked ||
      tool !== 'wire' ||
      pan.current ||
      !pointerInside.current ||
      !pointerPosition.current
    )
      return;
    const next = wirePoint({ ...pointerPosition.current, shiftKey });
    onPosition(next);
    setCursor((current) => (current?.x === next.x && current?.y === next.y ? current : next));
  }
  function isWireConnection(point: Point) {
    return (
      doc.wires.some((wire) => visibleIds.has(wire.id) && onWire(point, wire)) ||
      doc.parts.some(
        (part) =>
          visibleIds.has(part.id) &&
          visibleSchematicPins(part, doc.libraries[part.libId]).some((pin) =>
            samePoint(pin.point, point),
          ),
      ) ||
      [...doc.labels, ...doc.junctions].some(
        (anchor) => visibleIds.has(anchor.id) && samePoint(anchor, point),
      )
    );
  }
  function finishWire(head: Point | null, cancelEmpty = false) {
    const current = wireDraftRef.current;
    if (!current || !active || editingBlocked) return;
    try {
      const next = previewSchematicWireDraft(current, head);
      if (next.length < 2) {
        if (cancelEmpty) updateWireDraft(null);
        return;
      }
      if (onCommit(commitWireRoute(doc, next))) updateWireDraft(null);
    } catch (error) {
      onNotify?.((error as Error).message);
    }
  }
  function backtrackWire() {
    const current = wireDraftRef.current;
    if (!current) return;
    try {
      const previous = backtrackSchematicWireDraft(current);
      wireDraftRedo.current = [...wireDraftRedo.current, current].slice(-64);
      updateWireDraft(previous, true);
      setCursor(previous?.points.at(-1) ?? null);
      if (previous) setVertical(previous.vertical);
    } catch (error) {
      onNotify?.((error as Error).message);
    }
  }
  function down(e: React.PointerEvent<SVGSVGElement>) {
    if (!active || hasOpenOverlay()) return;
    if (editingBlocked && e.button === 0) return;
    if (pointerId.current !== null) return;
    if (e.button === 2 || e.button === 1 || (e.button === 0 && tool === 'hand')) {
      e.preventDefault();
      pan.current = { x: e.clientX, y: e.clientY, view };
      setPanning(true);
      capturePointer(e.pointerId);
      return;
    }
    if (e.button !== 0) return;
    if (tool === 'annotate') {
      startAnnotation(e);
      return;
    }
    const p = tool === 'wire' ? wirePoint(e) : point(e);
    if (tool === 'place') {
      const d = structuredClone(doc);
      const part = placement
        ? createLibraryPart(d, placement.symbol, p.x, p.y, placement.unit)
        : createPart(d, kind, p.x, p.y);
      if (placement) d.libraries[part.libId] = structuredClone(placement.symbol);
      part.rotation = placementRotation;
      d.parts.push(part);
      if (!onCommit(d)) return;
      onSelect(part.id);
      setTool('select');
    } else if (tool === 'wire') addWire(p);
    else if (tool === 'label' || tool === 'global-label') {
      const d = structuredClone(doc);
      const l = {
        id: uid(),
        ...p,
        text: 'NET',
        ...(tool === 'global-label' ? { scope: 'global' as const, shape: 'input' as const } : {}),
      };
      d.labels.push(l);
      if (!onCommit(d)) return;
      onSelect(l.id);
      setTool('select');
    } else if (tool === 'no-connect') {
      const pin = doc.parts
        .filter((part) => visibleIds.has(part.id))
        .flatMap((p) => visibleSchematicPins(p, doc.libraries[p.libId]).map((pin) => pin.point))
        .find((q) => samePoint(q, p));
      if (!pin) return;
      const d = structuredClone(doc),
        existing = d.noConnects?.find((n) => samePoint(n, p));
      if (existing) {
        onSelect(existing.id);
        return;
      }
      const n = { id: uid(), ...p };
      (d.noConnects ||= []).push(n);
      if (onCommit(d)) {
        onSelect(n.id);
        setTool('select');
      }
    } else {
      setBox({
        start: point(e, false),
        end: point(e, false),
        screen: { x: e.clientX, y: e.clientY },
        previous: selection,
        mode: selectionMode(e),
      });
      capturePointer(e.pointerId);
    }
  }
  function move(e: React.PointerEvent<SVGSVGElement>) {
    if (!active) return;
    if (pointerId.current !== null && pointerId.current !== e.pointerId) return;
    // Capture loss can share a React batch with the next move. The ref changes
    // immediately; stale rendered gesture state must not resurrect the preview.
    if (pointerId.current === null && (drag || box || annotationGesture)) return;
    pointerPosition.current = { clientX: e.clientX, clientY: e.clientY };
    pointerInside.current = true;
    const bounds = svg.current!.getBoundingClientRect();
    if (pan.current) {
      const start = pan.current;
      const next = {
        ...start.view,
        x: start.view.x - ((e.clientX - start.x) * start.view.width) / bounds.width,
        y: start.view.y - ((e.clientY - start.y) * start.view.width) / bounds.width,
      };
      setView((current) =>
        current.x === next.x && current.y === next.y && current.width === next.width
          ? current
          : next,
      );
      // Navigation keeps the held world-space preview. Only the grid readout
      // follows the new viewport; pin magnetism cannot affect this camera pose.
      onPosition({
        x: snap(next.x + ((e.clientX - bounds.left) / bounds.width) * next.width),
        y: snap(next.y + ((e.clientY - bounds.top) / bounds.width) * next.width),
      });
      return;
    }
    const raw = point(e, false, bounds);
    const pointerDragging = !!dragRef.current && !pickupRef.current;
    // Pointer drag follows its original anchor plus the raw pointer delta below.
    // Its readout only needs the grid; searching every fixed pin cannot affect
    // that pose. Floating M/G placement and wire magnetism keep their targets.
    const p =
      tool === 'wire'
        ? wirePoint(e, raw)
        : pointerDragging
          ? { x: snap(raw.x), y: snap(raw.y) }
          : point(e, true, bounds);
    onPosition(p);
    if (['place', 'wire', 'label', 'global-label', 'no-connect'].includes(tool))
      setCursor((current) => (current?.x === p.x && current?.y === p.y ? current : p));
    const currentPickup = pickupRef.current;
    if (currentPickup) {
      if (!pan.current) {
        const target = pickupTarget(p, currentPickup);
        // A floating move follows snapped poses, not every screen pixel. Retain
        // the exact validated preview and its generated IDs within the same pose.
        // Retry a rejected pose so returning to the last valid target clears it.
        if (
          target.x !== currentPickup.target.x ||
          target.y !== currentPickup.target.y ||
          pickupRejected.current
        )
          updatePickup({ ...currentPickup, target });
        return;
      }
    }
    if (canProbe && !pan.current) {
      const target = probeTarget(e);
      setProbeHover((current) =>
        current?.kind === target?.kind && current?.id === target?.id && current?.pin === target?.pin
          ? current
          : target,
      );
    }
    if (
      probeClick.current &&
      Math.hypot(e.clientX - probeClick.current.x, e.clientY - probeClick.current.y) > 3
    )
      probeClick.current = null;
    if (box) setBox({ ...box, end: raw });
    if (annotationGesture) {
      const end = raw;
      const points = annotationGesture.points;
      const last = points.at(-1)!;
      const next =
        Math.hypot(end.x - last.x, end.y - last.y) > (view.width / canvasWidth) * 2
          ? [...points, end]
          : points;
      // Keep long strokes bounded without losing their final endpoint.
      setAnnotationGesture({
        ...annotationGesture,
        end,
        points:
          next.length > 512 ? next.filter((_, i) => i % 2 === 0 || i === next.length - 1) : next,
      });
    }
    const currentDrag = dragRef.current;
    if (
      currentDrag &&
      (currentDrag.moved ||
        Math.hypot(e.clientX - currentDrag.screen.x, e.clientY - currentDrag.screen.y) > 3)
    ) {
      probeClick.current = null;
      const at = raw,
        target = {
          x:
            currentDrag.axis === 'y'
              ? currentDrag.origin.x
              : snap(currentDrag.origin.x + at.x - currentDrag.start.x),
          y:
            currentDrag.axis === 'x'
              ? currentDrag.origin.y
              : snap(currentDrag.origin.y + at.y - currentDrag.start.y),
        };
      if (target.x === currentDrag.current.x && target.y === currentDrag.current.y) return;
      try {
        storeDrag({
          ...currentDrag,
          moved: true,
          current: target,
          preview: previewSchematicMove(
            currentDrag.basis,
            currentDrag.ids,
            currentDrag.origin,
            target,
            [],
            currentDrag.connected,
          ),
          error: null,
        });
      } catch (error) {
        const message = (error as Error).message;
        storeDrag({ ...currentDrag, moved: true, current: target, preview: null, error: message });
        if (message !== currentDrag.error) onNotify?.(message);
      }
    }
  }
  function probeTarget(e: React.PointerEvent): ProbeTarget | null {
    const hit = e.target as Element;
    const pin = hit.closest<SVGElement>('[data-probe-pin]');
    if (pin && layers.symbols)
      return { kind: 'voltage', id: pin.dataset.probePart!, pin: Number(pin.dataset.probePin) };
    const id = hit.closest<SVGElement>('[data-selection-id]')?.dataset.selectionId;
    if (!id || !visibleIds.has(id)) return null;
    const part = doc.parts.find((p) => p.id === id);
    if (part)
      return {
        kind:
          part.libId === 'power:GND' ||
          (part.libId === 'Connector_Generic:Conn_01x01' && !/^VIN\b|^PWM\b/i.test(part.value))
            ? 'voltage'
            : 'current',
        id,
        ...(part.libId === 'power:GND' ||
        (part.libId === 'Connector_Generic:Conn_01x01' && !/^VIN\b|^PWM\b/i.test(part.value))
          ? { pin: 0 }
          : {}),
      };
    if (
      doc.wires.some((w) => w.id === id) ||
      doc.labels.some((l) => l.id === id) ||
      doc.junctions.some((j) => j.id === id)
    )
      return { kind: 'voltage', id };
    return null;
  }
  function up(e: React.PointerEvent<SVGSVGElement>) {
    if (!active || editingBlocked) {
      cancelGesture();
      return;
    }
    if (pointerId.current !== e.pointerId) return;
    if (pan.current && pickupRef.current) {
      pan.current = null;
      setPanning(false);
      pointerId.current = null;
      if (svg.current?.hasPointerCapture(e.pointerId))
        svg.current.releasePointerCapture(e.pointerId);
      return;
    }
    if (annotationGesture) {
      const { start, end, id, points } = annotationGesture;
      const moved = Math.hypot(end.x - start.x, end.y - start.y) > (view.width / canvasWidth) * 4;
      if (annotationMode === 'element' && !moved) {
        if (id && selectableIds.has(id)) annotationController.current?.select([id]);
      } else if (moved || (annotationMode === 'freehand' && points.length > 2)) {
        const xs = annotationMode === 'freehand' ? points.map((p) => p.x) : [start.x, end.x];
        const ys = annotationMode === 'freehand' ? points.map((p) => p.y) : [start.y, end.y];
        const bounds = {
          x: Math.min(...xs),
          y: Math.min(...ys),
          width: Math.max(0.5, Math.max(...xs) - Math.min(...xs)),
          height: Math.max(0.5, Math.max(...ys) - Math.min(...ys)),
        };
        const ids = annotationIdsInBounds(bounds);
        if (annotationMode === 'element') {
          if (ids.length) annotationController.current?.select(ids);
        } else {
          const markup =
            annotationMode === 'freehand'
              ? { kind: 'freehand' as const, points: points.length > 1 ? points : [start, end] }
              : { kind: 'rectangle' as const, bounds };
          annotationController.current?.select(ids, markup);
        }
      }
    }
    const currentDrag = dragRef.current;
    const commitPreview =
      currentDrag?.moved &&
      currentDrag.basis === doc &&
      currentDrag.preview &&
      (currentDrag.current.x !== currentDrag.origin.x ||
        currentDrag.current.y !== currentDrag.origin.y)
        ? currentDrag.preview
        : null;
    if (box) {
      const moved = Math.hypot(e.clientX - box.screen.x, e.clientY - box.screen.y) > 3;
      const ids = moved
        ? schematicIdsInRectangle(
            doc,
            selectableIds,
            box.start,
            point(e, false),
            measuredSelectionBounds(),
          )
        : box.clickId
          ? [box.clickId]
          : [];
      onSelection(
        applySelection(box.previous, ids, box.mode).filter((id) => selectableIds.has(id)),
      );
    }
    // Core publication can synchronously render a new document. Clear the
    // completed gesture first so that render cannot retain the old preview and
    // then render again solely to release it. Submit the captured exact pose.
    cancelGesture();
    if (commitPreview) onCommit(commitPreview);
  }
  function startAnnotation(e: React.PointerEvent, id?: string) {
    const start = point(e, false);
    setAnnotationGesture({
      start,
      end: start,
      id: id && selectableIds.has(id) ? id : undefined,
      points: [start],
    });
    capturePointer(e.pointerId);
  }
  function measuredSelectionBounds() {
    const bounds = new Map<string, SchematicSelectionBounds>();
    const inverse = svg.current?.getCTM()?.inverse();
    if (!inverse || !svg.current) return bounds;
    for (const node of svg.current.querySelectorAll<SVGGraphicsElement>('[data-selection-id]')) {
      const id = node.dataset.selectionId!;
      // Symbols use model body/pin geometry; their fields remain separate objects.
      if (!visibleIds.has(id) || node.matches('.part, .part-annotations')) continue;
      const matrix = node.getCTM();
      if (!matrix || getComputedStyle(node).display === 'none') continue;
      const box = node.getBBox();
      const transform = inverse.multiply(matrix);
      const corners = [
        new DOMPoint(box.x, box.y),
        new DOMPoint(box.x + box.width, box.y),
        new DOMPoint(box.x, box.y + box.height),
        new DOMPoint(box.x + box.width, box.y + box.height),
      ].map((point) => point.matrixTransform(transform));
      const x = Math.min(...corners.map((point) => point.x));
      const y = Math.min(...corners.map((point) => point.y));
      bounds.set(id, {
        x,
        y,
        width: Math.max(...corners.map((point) => point.x)) - x,
        height: Math.max(...corners.map((point) => point.y)) - y,
      });
    }
    return bounds;
  }
  function annotationIdsInBounds(bounds: { x: number; y: number; width: number; height: number }) {
    const inverse = svg.current?.getScreenCTM()?.inverse();
    if (!inverse || !svg.current) return [];
    const ids = [...svg.current.querySelectorAll<SVGGraphicsElement>('[data-selection-id]')]
      .filter((node) => {
        if (!selectableIds.has(node.dataset.selectionId!)) return false;
        const box = node.getBoundingClientRect();
        const a = new DOMPoint(box.left, box.top).matrixTransform(inverse);
        const b = new DOMPoint(box.right, box.bottom).matrixTransform(inverse);
        return (
          b.x >= bounds.x &&
          a.x <= bounds.x + bounds.width &&
          b.y >= bounds.y &&
          a.y <= bounds.y + bounds.height
        );
      })
      .map((node) => node.dataset.selectionId!);
    return [...new Set(ids)].filter((id) => {
      const field = selectedField(id);
      return !field || !ids.includes(field.id);
    });
  }
  function zoom(factor: number, anchor?: Point) {
    setView((v) => {
      const width = Math.max(35 * zoomScale, Math.min(700 * zoomScale, v.width * factor));
      const f = width / v.width;
      const p = anchor || { x: v.x + v.width / 2, y: v.y + (v.width * ratio) / 2 };
      return { width, x: p.x - (p.x - v.x) * f, y: p.y - (p.y - v.y) * f };
    });
  }
  return (
    <div
      ref={surface}
      className={`canvas-wrap tool-${tool}${panning ? ' is-panning' : ''}`}
      data-schematic-theme={darkCanvas ? 'dark' : 'light'}
      style={
        {
          '--schematic-selection-tone': darkCanvas ? '#ffffff' : '#000000',
          '--schematic-selection-ink': darkCanvas ? '#66b3ff' : '#1d4ed8',
        } as React.CSSProperties
      }
      data-probe-kind={canProbe ? probeHover?.kind : undefined}
    >
      <svg
        ref={svg}
        data-testid="schematic-canvas"
        data-pointer-focus={pointerFocused || undefined}
        data-move-preview={pickup ? (pickup.connected ? 'drag' : 'move') : undefined}
        aria-label="Schematic canvas"
        tabIndex={0}
        viewBox={`${view.x} ${view.y} ${view.width} ${view.width * ratio}`}
        onPointerDownCapture={(e) => {
          if (!active || hasOpenOverlay()) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          setPointerFocused(true);
          e.currentTarget.focus({ preventScroll: true });
          pointerPosition.current = { clientX: e.clientX, clientY: e.clientY };
          pointerInside.current = true;
          if (editingBlocked && e.button === 0) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          if (pickupRef.current && e.button === 0) {
            e.preventDefault();
            e.stopPropagation();
            probeClick.current = null;
            finishPickup();
            return;
          }
          const target = canProbe && e.button === 0 ? probeTarget(e) : null;
          probeClick.current =
            target && pointerId.current === null
              ? { pointerId: e.pointerId, x: e.clientX, y: e.clientY, target }
              : null;
        }}
        onPointerUpCapture={(e) => {
          const click = probeClick.current;
          probeClick.current = null;
          if (
            canProbe &&
            click?.pointerId === e.pointerId &&
            Math.hypot(e.clientX - click.x, e.clientY - click.y) <= 3
          )
            onProbe?.(click.target);
        }}
        onPointerDown={down}
        onDoubleClick={(e) => {
          if (!active || hasOpenOverlay()) return;
          if (tool === 'wire') {
            finishWire(wirePoint(e), true);
            return;
          }
          if (
            !editable ||
            editingBlocked ||
            pickupRef.current ||
            e.ctrlKey ||
            e.metaKey ||
            e.altKey ||
            e.shiftKey
          )
            return;
          const id =
            (e.target as Element).closest<SVGElement>('[data-selection-id]')?.dataset.selectionId ??
            hovered()?.id;
          if (id && selectableIds.has(id)) onProperties?.(id);
        }}
        onKeyDown={(e) => {
          if (!active || hasOpenOverlay() || e.nativeEvent.isComposing) return;
          const key = e.key.toLowerCase();
          const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
          const currentPickup = pickupRef.current;
          if (
            e.key === 'Escape' &&
            (currentPickup || drag || box || pan.current || annotationGesture)
          ) {
            e.preventDefault();
            e.stopPropagation();
            cancelGesture();
            return;
          }
          // A held pointer owns its preview until release or cancellation.
          if (dragRef.current) {
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          if (e.key === 'Shift' && tool === 'wire') {
            if (!e.repeat) refreshWireCursor(true);
            return;
          }
          if (editable && plain && !e.shiftKey && (key === 'm' || key === 'g')) {
            e.preventDefault();
            e.stopPropagation();
            if (!e.repeat) beginPickup(key === 'g');
            return;
          }
          if (currentPickup) {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              if (!e.repeat) finishPickup();
              return;
            }
            if (plain && ['r', 'x', 'y'].includes(key)) {
              e.preventDefault();
              e.stopPropagation();
              if (!e.repeat)
                updatePickup({
                  ...currentPickup,
                  operations: [
                    ...currentPickup.operations,
                    key === 'r'
                      ? e.shiftKey
                        ? 'rotateReverse'
                        : 'rotate'
                      : key === 'x'
                        ? 'mirrorY'
                        : 'mirrorX',
                  ],
                  axis:
                    key === 'r'
                      ? currentPickup.axis === 'x'
                        ? 'y'
                        : currentPickup.axis === 'y'
                          ? 'x'
                          : null
                      : currentPickup.axis,
                });
              return;
            }
            if (plain && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
              e.preventDefault();
              e.stopPropagation();
              updatePickup({
                ...currentPickup,
                target: pickupTarget(
                  {
                    x:
                      currentPickup.target.x +
                      (e.key === 'ArrowLeft' ? -1.27 : e.key === 'ArrowRight' ? 1.27 : 0),
                    y:
                      currentPickup.target.y +
                      (e.key === 'ArrowUp' ? -1.27 : e.key === 'ArrowDown' ? 1.27 : 0),
                  },
                  currentPickup,
                ),
              });
              return;
            }
            if (['v', 'h', 'w', 'a', 'e', 'delete', 'backspace'].includes(key)) cancelGesture();
            if ((e.ctrlKey || e.metaKey) && ['a', 'c', 'd', 'v'].includes(key)) cancelGesture();
            if ((e.ctrlKey || e.metaKey) && key === 'z') {
              e.preventDefault();
              e.stopPropagation();
              cancelGesture();
              return;
            }
          }
          if (e.key === 'Escape' && tool === 'wire') {
            e.preventDefault();
            e.stopPropagation();
            if (e.repeat) return;
            const drawingWire = wireDraftRef.current !== null;
            updateWireDraft(null);
            pendingWire.current = null;
            if (!drawingWire) setTool('select');
            return;
          }
          if (
            (e.ctrlKey || e.metaKey) &&
            !e.altKey &&
            key === 'z' &&
            tool === 'wire' &&
            (wireDraftRef.current || wireDraftRedo.current.length)
          ) {
            e.preventDefault();
            e.stopPropagation();
            if (editingBlocked || e.repeat) return;
            if (e.shiftKey) {
              const next = wireDraftRedo.current.pop();
              if (next) {
                updateWireDraft(next, true);
                setVertical(next.vertical);
                setCursor(next.points.at(-1) ?? null);
              }
            } else backtrackWire();
            return;
          }
          if (plain && !e.shiftKey && key === 'w') {
            e.preventDefault();
            e.stopPropagation();
            if (editingBlocked || e.repeat || (tool === 'wire' && wireDraftRef.current)) return;
            try {
              cancelGesture();
              const start =
                pointerInside.current && pointerPosition.current
                  ? wirePoint(pointerPosition.current)
                  : null;
              if (start) createSchematicWireDraft(start, vertical);
              if (tool === 'wire') {
                updateWireDraft(start ? createSchematicWireDraft(start, vertical) : null);
                setCursor(start);
              } else {
                pendingWire.current = start;
                setTool('wire');
              }
            } catch (error) {
              onNotify?.((error as Error).message);
            }
            return;
          }
          if (tool === 'wire' && (e.key === 'Backspace' || e.key === 'Delete')) {
            e.preventDefault();
            e.stopPropagation();
            if (!plain || e.shiftKey || editingBlocked || e.repeat) return;
            backtrackWire();
            return;
          }
          if (
            (e.ctrlKey || e.metaKey) &&
            !e.altKey &&
            e.key.toLowerCase() === 'a' &&
            (editable || tool === 'annotate')
          ) {
            e.preventDefault();
            e.stopPropagation();
            onSelection(applySelection([], [...selectableIds], 'replace'));
            return;
          }
          if (e.key === 'Enter' && tool === 'annotate' && selection.length) {
            e.preventDefault();
            annotationController.current?.select(selection.filter((id) => selectableIds.has(id)));
          }
          if (
            editable &&
            plain &&
            !editingBlocked &&
            selection.length &&
            selection.every((id) => selectableIds.has(id)) &&
            ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)
          ) {
            e.preventDefault();
            e.stopPropagation();
            try {
              onCommit(
                moveSelection(
                  doc,
                  selection,
                  {
                    x: e.key === 'ArrowLeft' ? -1.27 : e.key === 'ArrowRight' ? 1.27 : 0,
                    y: e.key === 'ArrowUp' ? -1.27 : e.key === 'ArrowDown' ? 1.27 : 0,
                  },
                  tool === 'drag' ||
                    selection.some((id) =>
                      [...doc.parts, ...doc.wires, ...doc.labels].some(
                        (object) => object.id === id,
                      ),
                    ),
                  isOwnedCircuit(doc),
                ),
              );
            } catch (error) {
              onNotify?.((error as Error).message);
            }
          }
          if (plain && !e.shiftKey && e.key === '/' && tool === 'wire') {
            e.preventDefault();
            e.stopPropagation();
            if (!editingBlocked && !e.repeat) {
              const current = wireDraftRef.current;
              if (current) {
                const next = toggleSchematicWirePosture(current);
                updateWireDraft(next);
                setVertical(next.vertical);
              } else setVertical((v) => !v);
            }
            return;
          }
          if (plain && key === 'r' && tool === 'place') {
            e.preventDefault();
            e.stopPropagation();
            if (!e.repeat) setPlacementRotation((v) => (v + (e.shiftKey ? 270 : 90)) % 360);
          }
          if (editable && plain && ['r', 'x', 'y'].includes(key) && !currentPickup) {
            e.preventDefault();
            e.stopPropagation();
            const ids = actionSelection();
            if (!editingBlocked && ids.length && !e.repeat) {
              onSelection(ids);
              onCommit(
                transformSelection(
                  doc,
                  ids,
                  key === 'r'
                    ? e.shiftKey
                      ? 'rotateReverse'
                      : 'rotate'
                    : key === 'x'
                      ? 'mirrorY'
                      : 'mirrorX',
                ),
              );
            }
            return;
          }
          if (editable && plain && !e.shiftKey && key === 'e') {
            e.preventDefault();
            e.stopPropagation();
            const ids = actionSelection();
            if (!editingBlocked && ids.length && !e.repeat) onProperties?.(ids.at(-1)!);
            return;
          }
          if (editable && plain && !e.shiftKey && (e.key === 'Delete' || e.key === 'Backspace')) {
            e.preventDefault();
            e.stopPropagation();
            const ids = actionSelection();
            if (!editingBlocked && ids.length && !e.repeat) onDelete?.(ids);
            return;
          }
          if (plain && e.key === 'Enter' && tool === 'wire') {
            e.preventDefault();
            e.stopPropagation();
            if (!e.repeat) finishWire(cursor);
            return;
          }
        }}
        onKeyUp={(e) => {
          if (e.key === 'Shift' && !hasOpenOverlay() && !e.nativeEvent.isComposing)
            refreshWireCursor(e.shiftKey);
        }}
        onPointerMove={move}
        onPointerEnter={(e) => {
          pointerInside.current = true;
          pointerPosition.current = { clientX: e.clientX, clientY: e.clientY };
        }}
        onPointerLeave={(e) => {
          pointerInside.current = false;
          pointerPosition.current = { clientX: e.clientX, clientY: e.clientY };
          setProbeHover(null);
        }}
        onPointerUp={up}
        onPointerCancel={cancelGesture}
        onLostPointerCapture={(e) => {
          if (pointerId.current === e.pointerId) cancelGesture();
        }}
        onBlur={() => {
          setPointerFocused(false);
          cancelGesture();
        }}
        onWheel={(e) => zoom(e.deltaY > 0 ? 1.1 : 0.9, point(e, false))}
        onContextMenu={(e) => e.preventDefault()}
      >
        <defs>
          {/* Center each dot inside its tile so the pattern does not clip it. */}
          <pattern
            id={gridId}
            x={-gridSpacing / 2}
            y={-gridSpacing / 2}
            width={gridSpacing}
            height={gridSpacing}
            patternUnits="userSpaceOnUse"
          >
            <circle
              cx={gridSpacing / 2}
              cy={gridSpacing / 2}
              r={Math.min(0.14, gridSpacing * 0.08)}
              fill="var(--grid-dot)"
            />
          </pattern>
        </defs>
        <rect
          data-schematic-background
          x={view.x}
          y={view.y}
          width={view.width}
          height={view.width * ratio}
          fill={grid ? `url(#${gridId})` : 'var(--canvas)'}
        />
        <SchematicDrawing
          drawing={drawing}
          libraries={doc.libraries}
          junctions={drawingJunctions}
          selection={selection}
          layers={layers}
          hitPadding={hitPadding}
          offset={offset}
          onPointerDown={beginRetained}
          onPinPointerDown={pinPointerDownRetained}
        />
        {(drag?.moved || pickup) &&
          fieldDragLinks(
            drawing,
            (pickup?.ids ?? drag?.ids ?? []).filter((id) => visibleIds.has(id)),
            offset,
          ).map((link) => (
            <line
              key={link.id}
              data-export-exclude
              data-testid="field-owner-guide"
              x1={link.from.x}
              y1={link.from.y}
              x2={link.to.x}
              y2={link.to.y}
              stroke="var(--schematic-guide)"
              strokeWidth="1"
              strokeDasharray="4 3"
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          ))}
        <RuleCheckMarker location={ruleFocus?.location} radius={(view.width / canvasWidth) * 8} />
        {box && (
          <rect
            data-export-exclude
            data-testid="schematic-selection-box"
            data-crossing={box.end.x < box.start.x}
            x={Math.min(box.start.x, box.end.x)}
            y={Math.min(box.start.y, box.end.y)}
            width={Math.abs(box.end.x - box.start.x)}
            height={Math.abs(box.end.y - box.start.y)}
            fill="var(--selection-area)"
            stroke="var(--selection-edge)"
            strokeWidth="0.2"
            strokeDasharray={box.end.x < box.start.x ? '1 1' : undefined}
            pointerEvents="none"
          />
        )}
        {wireDraft && (
          <path
            data-export-exclude
            data-testid="schematic-wire-preview"
            data-wire-start={`${wireDraft.points[0].x},${wireDraft.points[0].y}`}
            data-wire-waypoints={wireDraft.checkpoints.length}
            d={wirePreview.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ')}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="0.28"
            strokeDasharray="0.55 0.35"
            strokeLinecap="butt"
            strokeLinejoin="miter"
          />
        )}
        {tool === 'place' && cursor && (
          <g
            data-export-exclude
            opacity="0.55"
            transform={`translate(${cursor.x} ${cursor.y}) rotate(${-placementRotation})`}
            color="var(--symbol)"
          >
            <SymbolGraphic
              library={
                placement?.symbol || libraries[catalog.find((entry) => entry.kind === kind)!.libId]
              }
              unit={placement?.unit}
            />
          </g>
        )}
        {cursor && ['place', 'wire', 'label', 'global-label', 'no-connect'].includes(tool) && (
          <g data-export-exclude stroke="var(--accent)" strokeWidth="0.12">
            <path d={`M ${cursor.x - 2} ${cursor.y} h 4 M ${cursor.x} ${cursor.y - 2} v 4`} />
          </g>
        )}
        {annotationGesture && (
          <g
            data-annotation-overlay="true"
            className={annotationMode === 'element' ? undefined : 'annotation-gesture'}
            pointerEvents="none"
          >
            {annotationMode === 'element' ? (
              <rect
                data-export-exclude
                data-testid="schematic-annotation-selection-box"
                data-crossing={annotationGesture.end.x < annotationGesture.start.x}
                x={Math.min(annotationGesture.start.x, annotationGesture.end.x)}
                y={Math.min(annotationGesture.start.y, annotationGesture.end.y)}
                width={Math.abs(annotationGesture.end.x - annotationGesture.start.x)}
                height={Math.abs(annotationGesture.end.y - annotationGesture.start.y)}
                fill="var(--selection-area)"
                stroke="var(--selection-edge)"
                strokeWidth="0.2"
                strokeDasharray={
                  annotationGesture.end.x < annotationGesture.start.x ? '1 1' : undefined
                }
                pointerEvents="none"
              />
            ) : annotationMode === 'freehand' ? (
              <polyline points={annotationGesture.points.map((p) => p.x + ',' + p.y).join(' ')} />
            ) : (
              <rect
                x={Math.min(annotationGesture.start.x, annotationGesture.end.x)}
                y={Math.min(annotationGesture.start.y, annotationGesture.end.y)}
                width={Math.abs(annotationGesture.end.x - annotationGesture.start.x)}
                height={Math.abs(annotationGesture.end.y - annotationGesture.start.y)}
              />
            )}
          </g>
        )}
      </svg>
      <CanvasAnnotations
        ref={annotationController}
        svg={svg}
        doc={doc}
        active={active && !editingBlocked && tool === 'annotate'}
        sessionId={annotationSessionId}
        annotations={annotations}
        onChange={onAnnotationsChange}
        onAdd={onAnnotationAdd}
        onSelection={onSelection}
        selectionIds={selection}
        selectableIds={selectableIds}
        view={view}
        ratio={ratio}
        mode={annotationMode}
        onMode={setAnnotationMode}
        onExit={() => setTool('select')}
      />
      <div className="zoom-controls">
        <button aria-label="Zoom out" title="Zoom out" onClick={() => zoom(1.2)}>
          <Minus size={15} />
        </button>
        <span>{Math.round(((185 * zoomScale) / view.width) * 100)}%</span>
        <button aria-label="Zoom in" title="Zoom in" onClick={() => zoom(0.8)}>
          <Plus size={15} />
        </button>
        <i />
        <button
          aria-description="Recenter / fit to canvas"
          aria-label="Fit to canvas"
          title="Fit to canvas"
          onClick={fit}
        >
          <Maximize size={15} />
        </button>
        <button
          aria-label="Export image"
          title="Export image"
          disabled={exporting}
          onClick={() => void exportImage()}
        >
          <ImageDown size={15} />
        </button>
      </div>
    </div>
  );
}
