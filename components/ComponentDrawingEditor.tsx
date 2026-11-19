'use client';

import { PadDrillGraphic } from './PadDrillGraphic';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  PencilRuler,
  MousePointer2,
  RectangleHorizontal,
  Circle,
  Minus,
  Pin,
  Square,
  Undo2,
  Redo2,
  Trash2,
  ZoomIn,
  ZoomOut,
  Scan,
  RotateCcw,
  Check,
  X,
  Crosshair,
  RefreshCw,
  LoaderCircle,
} from 'lucide-react';
import type { CapabilityHost } from '@/api/capabilities';
import type { Circuit, Point } from '@/lib/circuit';
import type { Project } from '@/lib/project';
import type { BoardLine, Pad } from '@/lib/pcb';
import { pcbPadPath } from '@/lib/pcb-geometry';
import {
  readSymbolDrawing,
  symbolPinTypes,
  type SymbolDrawing,
  type SymbolDrawingGraphic,
} from '@/lib/symbol-drawing';
import { readFootprintDrawing, type FootprintDrawing } from '@/lib/footprint-drawing';
import { layoutGridMetrics } from '@/lib/drawing-grid';
import Dialog from './Dialog';
import QuantityInput from './QuantityInput';
import PCBGraphic from './PCBGraphic';
import { FootprintIcon, SymbolIcon } from './EditorIcons';
import { drawingBounds, translateDrawingSelection } from './component-drawing-geometry';
import styles from './ComponentDrawingEditor.module.css';
import { isCommandModifier } from '@/lib/command-modifier';

type Tab = 'symbol' | 'footprint';
type Tool = 'select' | 'rectangle' | 'circle' | 'line' | 'pin' | 'pad';
type Selection = { kind: 'graphic' | 'pin' | 'pad'; index: number } | null;
type Drawings = { symbol: SymbolDrawing; footprint: FootprintDrawing };
const emptyDrawings = (): Drawings => ({
  symbol: { graphics: [], pins: [] },
  footprint: { pads: [], graphics: [] },
});
const toolIcons = {
  select: MousePointer2,
  rectangle: RectangleHorizontal,
  circle: Circle,
  line: Minus,
  pin: Pin,
  pad: Square,
};
const toolHints: Record<Tool, string> = {
  select: 'Click to select · Drag to move',
  rectangle: 'Drag a rectangle or click two corners',
  circle: 'Drag a radius or click center and edge',
  line: 'Drag a line or click two endpoints',
  pin: 'Click to place a pin',
  pad: 'Click to place a pad',
};
const pinEnd = (pin: SymbolDrawing['pins'][number]) => ({
  x: pin.x + Math.cos((pin.rotation * Math.PI) / 180) * pin.length,
  y: pin.y - Math.sin((pin.rotation * Math.PI) / 180) * pin.length,
});

/** Local drawings stay drafts. Apply uses the same revision-bound commands as Agent tools. */
export default function ComponentDrawingEditor({
  project,
  schematic,
  capabilityHost,
  revision,
  initialTab,
  onClose,
  onApplied,
}: {
  project: Project;
  schematic: Circuit;
  capabilityHost: CapabilityHost;
  revision: string;
  initialTab: Tab;
  onClose: () => void;
  onApplied: (kind: Tab, id?: string) => void;
}) {
  const [basis, setBasis] = useState({ project, schematic, revision });
  const [tab, setTab] = useState<Tab>(initialTab);
  const [drawings, setDrawings] = useState(emptyDrawings);
  const [targets, setTargets] = useState({ symbol: '', footprint: '' });
  const [names, setNames] = useState({ symbol: 'CustomComponent', footprint: 'CustomPackage' });
  const [prefix, setPrefix] = useState('U');
  const [position, setPosition] = useState<Point>({ x: 50, y: 50 });
  const [partId, setPartId] = useState('');
  const [tool, setTool] = useState<Tool>('select');
  const [selection, setSelection] = useState<Selection>(null);
  const [anchor, setAnchor] = useState<Point | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [extent, setExtent] = useState(20);
  const [center, setCenter] = useState<Point>({ x: 0, y: 0 });
  const [canvasSize, setCanvasSize] = useState({ width: 1, height: 1 });
  const [history, setHistory] = useState<Drawings[]>([]);
  const [future, setFuture] = useState<Drawings[]>([]);
  const [baseline, setBaseline] = useState(() => ({
    drawings: emptyDrawings(),
    names: { symbol: 'CustomComponent', footprint: 'CustomPackage' },
    prefix: 'U',
    position: { x: 50, y: 50 },
    partId: '',
  }));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [composing, setComposing] = useState(false);
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  const svg = useRef<SVGSVGElement>(null);
  const gesture = useRef<null | {
    id: number;
    kind: 'pan' | 'shape' | 'move';
    client: Point;
    point: Point;
    center: Point;
    scale: number;
    drawings: Drawings;
    selection: Selection;
    moved: boolean;
    newAnchor: boolean;
  }>(null);
  const skipClick = useRef(false);
  const focusValues = useRef<Record<string, string | number>>({});
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const gridId = useId();
  const stale = revision !== basis.revision;
  const board = basis.project.pcb;
  const currentTarget = targets[tab];
  const fieldsInvalid = Object.keys(invalid).length > 0;
  const dirty =
    JSON.stringify(drawings[tab]) !== JSON.stringify(baseline.drawings[tab]) ||
    names[tab] !== baseline.names[tab] ||
    (!currentTarget &&
      (JSON.stringify(position) !== JSON.stringify(baseline.position) ||
        (tab === 'symbol' ? prefix !== baseline.prefix : partId !== baseline.partId)));
  const hasGeometry =
    tab === 'symbol'
      ? drawings.symbol.graphics.length + drawings.symbol.pins.length > 0
      : drawings.footprint.graphics.length + drawings.footprint.pads.length > 0;
  const canApply =
    !busy && !stale && !composing && !fieldsInvalid && !anchor && hasGeometry && dirty;
  const shortSide = Math.min(canvasSize.width, canvasSize.height);
  const widthRatio = canvasSize.width / shortSide;
  const heightRatio = canvasSize.height / shortSide;
  const halfWidth = extent * widthRatio;
  const halfHeight = extent * heightRatio;
  const unitsPerPixel = (2 * extent) / shortSide;
  const grid = layoutGridMetrics(tab === 'symbol' ? 1.27 : 0.25, unitsPerPixel);
  useLayoutEffect(() => {
    const element = svg.current;
    if (!element) return;
    let previous: { width: number; height: number } | null = null;
    const resize = ({ width, height }: { width: number; height: number }) => {
      if (!(width > 0 && height > 0) || ![width, height].every(Number.isFinite)) return;
      if (previous?.width === width && previous.height === height) return;
      cancelGesture();
      if (previous) {
        const ratio = Math.min(width, height) / Math.min(previous.width, previous.height);
        setExtent((current) => current * ratio);
      }
      previous = { width, height };
      setCanvasSize(previous);
    };
    resize(element.getBoundingClientRect());
    const observer = new ResizeObserver(([entry]) => resize(entry.contentRect));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.deltaY) return;
      event.preventDefault();
      if (gesture.current) return;
      const at = rawPoint(event.clientX, event.clientY);
      if (at) zoom(Math.exp(Math.max(-100, Math.min(100, event.deltaY)) * 0.002), at);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [tab, extent, center.x, center.y]);
  function close() {
    if (!busy && !composing) onClose();
  }
  function edit(next: Drawings) {
    if (JSON.stringify(next) === JSON.stringify(drawings)) return;
    setHistory((old) => [...old.slice(-31), drawings]);
    setFuture([]);
    setDrawings(next);
    setError('');
  }
  function chooseTarget(id: string, kind = tab) {
    if (dirty || fieldsInvalid || busy) return;
    try {
      let nextDrawings = drawings,
        nextNames = names,
        nextPrefix = 'U',
        nextPosition = { x: 50, y: 50 };
      if (kind === 'symbol') {
        const read = id ? readSymbolDrawing(basis.schematic, id) : null;
        nextDrawings = { ...drawings, symbol: read?.drawing ?? emptyDrawings().symbol };
        nextNames = { ...names, symbol: read?.name ?? 'CustomComponent' };
        nextPrefix = read?.referencePrefix ?? 'U';
        nextPosition = read?.position ?? nextPosition;
      } else {
        const selected = board?.footprints.find((item) => item.id === id);
        nextDrawings = {
          ...drawings,
          footprint: selected ? readFootprintDrawing(selected) : emptyDrawings().footprint,
        };
        nextNames = {
          ...names,
          footprint: selected?.libraryId.split(':').at(-1) ?? 'CustomPackage',
        };
        nextPosition = selected ? { x: selected.x, y: selected.y } : nextPosition;
      }
      setDrawings(nextDrawings);
      setNames(nextNames);
      setPrefix(nextPrefix);
      setPosition(nextPosition);
      setPartId('');
      setBaseline({
        drawings: nextDrawings,
        names: nextNames,
        prefix: nextPrefix,
        position: nextPosition,
        partId: '',
      });
      setTargets({ ...targets, [kind]: id });
      setSelection(null);
      setAnchor(null);
      setHistory([]);
      setFuture([]);
      setInvalid({});
      setError('');
      fit(kind, nextDrawings);
    } catch (cause) {
      setError((cause as Error).message);
    }
  }
  function changeTab(next: Tab) {
    if (dirty || fieldsInvalid || busy || composing) return;
    setTab(next);
    setSelection(null);
    setAnchor(null);
    setTool('select');
    setError('');
    setInvalid({});
    setHistory([]);
    setFuture([]);
    chooseTarget(targets[next], next);
  }
  function undoDrawing(redo = false) {
    if (busy || composing || fieldsInvalid || gesture.current) return;
    if (anchor) {
      setAnchor(null);
      return;
    }
    const stack = redo ? future : history;
    if (!stack.length) return;
    (redo ? setHistory : setFuture)((old) => [...old.slice(-31), drawings]);
    (redo ? setFuture : setHistory)(stack.slice(0, -1));
    setDrawings(stack.at(-1)!);
    setSelection(null);
    setError('');
  }
  function resetDrawing() {
    if (busy || composing) return;
    setDrawings(baseline.drawings);
    setNames(baseline.names);
    setPrefix(baseline.prefix);
    setPosition(baseline.position);
    setPartId(baseline.partId);
    setHistory([]);
    setFuture([]);
    setInvalid({});
    setSelection(null);
    setAnchor(null);
    setError('');
  }
  function fit(kind = tab, data = drawings) {
    if (gesture.current) return;
    const bounds = drawingBounds(kind, data[kind]);
    const nextCenter = bounds
      ? { x: bounds.minX / 2 + bounds.maxX / 2, y: bounds.minY / 2 + bounds.maxY / 2 }
      : { x: 0, y: 0 };
    const nextExtent = bounds
      ? Math.max(
          3,
          Math.max(
            (bounds.maxX - bounds.minX) / widthRatio,
            (bounds.maxY - bounds.minY) / heightRatio,
          ) * 0.7,
        )
      : 20;
    const nextHalfWidth = nextExtent * widthRatio;
    const nextHalfHeight = nextExtent * heightRatio;
    if (
      ![
        nextCenter.x - nextHalfWidth,
        nextCenter.x + nextHalfWidth,
        nextCenter.y - nextHalfHeight,
        nextCenter.y + nextHalfHeight,
        nextHalfWidth * 2,
        nextHalfHeight * 2,
      ].every(Number.isFinite)
    ) {
      setError('The drawing is too large to fit. Reduce its dimensions and try again.');
      return;
    }
    setCenter(nextCenter);
    setExtent(nextExtent);
  }
  function zoom(factor: number, at = center) {
    if (gesture.current) return;
    // Resize and Fit can place the camera beyond these limits; never reverse a zoom.
    const next = Math.max(Math.min(1, extent), Math.min(Math.max(100000, extent), extent * factor)),
      ratio = next / extent;
    if (next === extent) return;
    setExtent(next);
    setCenter({ x: at.x + (center.x - at.x) * ratio, y: at.y + (center.y - at.y) * ratio });
  }
  function refreshRevision() {
    if (busy || composing) return;
    try {
      if (
        tab === 'symbol' &&
        targets.symbol &&
        JSON.stringify(readSymbolDrawing(basis.schematic, targets.symbol)) !==
          JSON.stringify(readSymbolDrawing(schematic, targets.symbol))
      )
        throw new Error(
          'The target symbol changed. Retain this draft for reference or cancel and review the current symbol.',
        );
      if (
        tab === 'footprint' &&
        targets.footprint &&
        JSON.stringify(
          basis.project.pcb?.footprints.find((item) => item.id === targets.footprint),
        ) !== JSON.stringify(project.pcb?.footprints.find((item) => item.id === targets.footprint))
      )
        throw new Error(
          'The target footprint changed. Retain this draft for reference or cancel and review the current footprint.',
        );
      setBasis({ project, schematic, revision });
      if (tab === 'symbol') {
        setTargets({ ...targets, footprint: '' });
        setDrawings({ ...drawings, footprint: emptyDrawings().footprint });
      } else if (tab === 'footprint') {
        setTargets({ ...targets, symbol: '' });
        setDrawings({ ...drawings, symbol: emptyDrawings().symbol });
      }
      setError('');
    } catch (cause) {
      setError((cause as Error).message);
    }
  }
  function rawPoint(clientX: number, clientY: number): Point | null {
    const matrix = svg.current?.getScreenCTM();
    if (!matrix) return null;
    const raw = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
    return { x: raw.x, y: raw.y };
  }
  function point(clientX: number, clientY: number): Point | null {
    const raw = rawPoint(clientX, clientY);
    if (!raw) return null;
    const step = tab === 'symbol' ? 1.27 : 0.25;
    return {
      x: Number((Math.round(raw.x / step) * step).toFixed(4)),
      y: Number((Math.round(raw.y / step) * step).toFixed(4)),
    };
  }
  function movedDrawing(session: NonNullable<typeof gesture.current>, at: Point): Drawings {
    if (!session.selection) return session.drawings;
    return {
      ...session.drawings,
      [tab]: translateDrawingSelection(tab, session.drawings[tab], session.selection, {
        x: at.x - session.point.x,
        y: at.y - session.point.y,
      }),
    };
  }
  function cancelGesture() {
    const session = gesture.current;
    if (!session) return;
    gesture.current = null;
    skipClick.current = true;
    if (session.kind === 'move') setDrawings(session.drawings);
    if (session.kind === 'shape' && session.newAnchor) setAnchor(null);
    if (session.kind === 'pan') setCenter(session.center);
    if (svg.current?.hasPointerCapture(session.id)) svg.current.releasePointerCapture(session.id);
  }
  function draw(at: Point) {
    if (tool === 'select') {
      setSelection(null);
      return;
    }
    if (tool === 'pin' && tab === 'symbol') {
      const used = new Set(drawings.symbol.pins.map((pin) => pin.number));
      let number = 1;
      while (used.has(String(number))) number++;
      edit({
        ...drawings,
        symbol: {
          ...drawings.symbol,
          pins: [
            ...drawings.symbol.pins,
            {
              ...at,
              number: String(number),
              name: `Pin_${number}`,
              rotation: 0,
              length: 2.54,
              type: 'passive',
            },
          ],
        },
      });
      setSelection({ kind: 'pin', index: drawings.symbol.pins.length });
      return;
    }
    if (tool === 'pad' && tab === 'footprint') {
      const used = new Set(drawings.footprint.pads.map((pad) => pad.number));
      let number = 1;
      while (used.has(String(number))) number++;
      edit({
        ...drawings,
        footprint: {
          ...drawings.footprint,
          pads: [
            ...drawings.footprint.pads,
            {
              ...at,
              number: String(number),
              rotation: 0,
              type: 'smd',
              shape: 'rect',
              size: { x: 1.5, y: 1.5 },
            },
          ],
        },
      });
      setSelection({ kind: 'pad', index: drawings.footprint.pads.length });
      return;
    }
    if (!anchor) {
      setAnchor(at);
      setCursor(at);
      return;
    }
    if (at.x === anchor.x && at.y === anchor.y) return;
    if (tool === 'rectangle' && (at.x === anchor.x || at.y === anchor.y)) return;
    if (tab === 'symbol') {
      const graphic: SymbolDrawingGraphic =
        tool === 'circle'
          ? {
              type: 'circle',
              center: anchor,
              radius: Number(Math.hypot(at.x - anchor.x, at.y - anchor.y).toFixed(4)),
            }
          : tool === 'rectangle'
            ? { type: 'rectangle', start: anchor, end: at }
            : { type: 'polyline', points: [anchor, at] };
      edit({
        ...drawings,
        symbol: { ...drawings.symbol, graphics: [...drawings.symbol.graphics, graphic] },
      });
      setSelection({ kind: 'graphic', index: drawings.symbol.graphics.length });
    } else if (tab === 'footprint') {
      const graphic = (start: Point, end: Point): FootprintDrawing['graphics'][number] => ({
        start,
        end,
        width: 0.12,
        layer: 'F.SilkS',
      });
      const created =
        tool === 'rectangle'
          ? [
              graphic(anchor, { x: at.x, y: anchor.y }),
              graphic({ x: at.x, y: anchor.y }, at),
              graphic(at, { x: anchor.x, y: at.y }),
              graphic({ x: anchor.x, y: at.y }, anchor),
            ]
          : [{ ...graphic(anchor, at), ...(tool === 'circle' ? { kind: 'circle' as const } : {}) }];
      edit({
        ...drawings,
        footprint: {
          ...drawings.footprint,
          graphics: [...drawings.footprint.graphics, ...created],
        },
      });
      setSelection({ kind: 'graphic', index: drawings.footprint.graphics.length });
    }
    setAnchor(null);
  }
  function remove() {
    if (!selection || busy || composing) return;
    if (tab === 'symbol')
      edit({
        ...drawings,
        symbol: {
          ...drawings.symbol,
          [selection.kind === 'pin' ? 'pins' : 'graphics']: (selection.kind === 'pin'
            ? drawings.symbol.pins
            : drawings.symbol.graphics
          ).filter((_, i) => i !== selection.index),
        },
      });
    else if (tab === 'footprint')
      edit({
        ...drawings,
        footprint: {
          ...drawings.footprint,
          [selection.kind === 'pad' ? 'pads' : 'graphics']: (selection.kind === 'pad'
            ? drawings.footprint.pads
            : drawings.footprint.graphics
          ).filter((_, i) => i !== selection.index),
        },
      });
    setSelection(null);
    setInvalid({});
  }
  function updateSelected(change: Record<string, unknown>) {
    if (!selection || busy) return;
    const key =
      selection.kind === 'graphic' ? 'graphics' : selection.kind === 'pin' ? 'pins' : 'pads';
    const drawing = drawings[tab];
    const items =
      key === 'graphics'
        ? drawing.graphics
        : key === 'pins'
          ? drawings.symbol.pins
          : drawings.footprint.pads;
    edit({
      ...drawings,
      [tab]: {
        ...drawing,
        [key]: items.map((item, i) => (i === selection.index ? { ...item, ...change } : item)),
      },
    });
  }
  function number(
    label: string,
    value: number,
    change: (value: number) => void,
    unit = 'mm',
    decimalPlaces = 2,
  ) {
    return (
      <label className={styles.field} key={label}>
        {label}
        <QuantityInput
          aria-label={label}
          disabled={busy}
          unit={unit || undefined}
          decimalPlaces={decimalPlaces}
          value={invalid[label] ?? value}
          aria-invalid={Object.hasOwn(invalid, label)}
          onFocus={() => {
            focusValues.current[label] = value;
          }}
          onKeyDown={(event) => {
            if (
              event.key !== 'Escape' ||
              composing ||
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            setInvalid((old) => {
              const next = { ...old };
              delete next[label];
              return next;
            });
            change(Number(focusValues.current[label] ?? value));
          }}
          onValueChange={(text) => {
            if (!text.trim() || !Number.isFinite(Number(text)))
              setInvalid({ ...invalid, [label]: text });
            else {
              const next = { ...invalid };
              delete next[label];
              setInvalid(next);
              change(Number(text));
            }
          }}
        />
      </label>
    );
  }
  function text(label: string, value: string, change: (value: string) => void, disabled = false) {
    return (
      <label className={styles.field}>
        {label}
        <input
          aria-label={label}
          value={value}
          disabled={disabled || busy}
          onFocus={() => {
            focusValues.current[label] = value;
          }}
          onKeyDown={(event) => {
            if (
              event.key !== 'Escape' ||
              composing ||
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            change(String(focusValues.current[label] ?? value));
          }}
          onChange={(event) => change(event.target.value)}
        />
      </label>
    );
  }
  function select(label: string, value: string, values: string[], change: (value: string) => void) {
    return (
      <label className={styles.field}>
        {label}
        <select
          aria-label={label}
          value={value}
          disabled={busy}
          onChange={(event) => change(event.target.value)}
        >
          {values.map((entry) => (
            <option key={entry} value={entry}>
              {entry}
            </option>
          ))}
        </select>
      </label>
    );
  }
  function xy(label: string, value: Point, change: (value: Point) => void) {
    return (
      <>
        {number(`${label} X`, value.x, (x) => change({ ...value, x }))}
        {number(`${label} Y`, value.y, (y) => change({ ...value, y }))}
      </>
    );
  }
  let properties: ReactNode = null;
  if (selection && tab === 'symbol') {
    if (selection.kind === 'pin') {
      const pin = drawings.symbol.pins[selection.index];
      if (pin)
        properties = (
          <>
            {text('Pin number', pin.number, (number) => updateSelected({ number }))}
            {text('Pin name', pin.name, (name) => updateSelected({ name }))}
            {xy('Pin', pin, (p) => updateSelected(p))}
            {number('Pin length', pin.length, (length) => updateSelected({ length }))}
            {select(
              'Pin direction (°)',
              String(pin.rotation),
              ['0', '90', '180', '270'],
              (rotation) => updateSelected({ rotation: Number(rotation) }),
            )}
            {select('Electrical type', pin.type ?? 'passive', [...symbolPinTypes], (type) =>
              updateSelected({ type }),
            )}
          </>
        );
    } else {
      const graphic = drawings.symbol.graphics[selection.index];
      if (graphic)
        properties = (
          <>
            {graphic.type === 'rectangle' ? (
              <>
                {xy('Start', graphic.start, (start) => updateSelected({ start }))}
                {xy('End', graphic.end, (end) => updateSelected({ end }))}
              </>
            ) : graphic.type === 'circle' ? (
              <>
                {xy('Center', graphic.center, (center) => updateSelected({ center }))}
                {number('Radius', graphic.radius, (radius) => updateSelected({ radius }))}
              </>
            ) : (
              graphic.points.map((p, index) => (
                <span key={index}>
                  {xy(`Point ${index + 1}`, p, (next) =>
                    updateSelected({
                      points: graphic.points.map((p, i) => (i === index ? next : p)),
                    }),
                  )}
                </span>
              ))
            )}
            {number('Stroke width', graphic.width ?? 0.254, (width) => updateSelected({ width }))}
            {select('Fill', graphic.fill ?? 'none', ['none', 'background', 'outline'], (fill) =>
              updateSelected({ fill }),
            )}
          </>
        );
    }
  } else if (selection && tab === 'footprint') {
    if (selection.kind === 'pad') {
      const pad = drawings.footprint.pads[selection.index];
      if (pad)
        properties = (
          <>
            {text('Pad number', pad.number, (number) => updateSelected({ number }))}
            {xy('Pad', pad, (p) => updateSelected(p))}
            {pad.customAnchor === 'circle'
              ? number(
                  'Anchor diameter',
                  pad.size.x,
                  (diameter) => updateSelected({ size: { x: diameter, y: diameter } }),
                  'mm',
                  6,
                )
              : xy(pad.outline ? 'Anchor size' : 'Size', pad.size, (size) =>
                  updateSelected({ size }),
                )}
            {number('Pad rotation', pad.rotation, (rotation) => updateSelected({ rotation }), '°')}
            {select(
              'Pad type',
              pad.type,
              pad.outline ? ['smd', 'thru_hole'] : ['smd', 'thru_hole', 'np_thru_hole'],
              (type) => {
                const next = { ...pad, type } as Partial<Pad>;
                if (type === 'smd') {
                  delete next.drill;
                  delete next.drillOffset;
                  delete next.drillSlot;
                } else next.drill = pad.drill ?? 0.8;
                const { drill: _drill, drillOffset: _offset, drillSlot: _slot, ...retained } = pad;
                edit({
                  ...drawings,
                  footprint: {
                    ...drawings.footprint,
                    pads: drawings.footprint.pads.map((p, i) =>
                      i === selection.index
                        ? ({
                            ...retained,
                            ...next,
                            ...(type === 'smd'
                              ? { drill: undefined, drillOffset: undefined, drillSlot: undefined }
                              : {}),
                          } as typeof pad)
                        : p,
                    ),
                  },
                });
              },
            )}
            {pad.outline ? (
              <div>Custom polygon</div>
            ) : (
              select('Pad shape', pad.shape, ['rect', 'circle', 'oval', 'roundrect'], (shape) =>
                updateSelected({
                  shape,
                  ...(shape === 'roundrect'
                    ? { roundrectRatio: pad.roundrectRatio ?? 0.25 }
                    : { roundrectRatio: undefined, chamferRatio: undefined, chamfer: undefined }),
                }),
              )
            )}
            {pad.type !== 'smd' &&
              number(pad.drillSlot ? 'Slot width' : 'Drill', pad.drill ?? 0.8, (drill) =>
                updateSelected({ drill }),
              )}
            {pad.drillSlot && (
              <>
                {number('Slot length', pad.drillSlot.length, (length) =>
                  updateSelected({ drillSlot: { ...pad.drillSlot!, length } }),
                )}
                {select('Slot axis', pad.drillSlot.axis, ['x', 'y'], (axis) =>
                  updateSelected({ drillSlot: { ...pad.drillSlot!, axis } }),
                )}
              </>
            )}
            {pad.shape === 'roundrect' &&
              number(
                'Corner ratio',
                pad.roundrectRatio ?? 0.25,
                (roundrectRatio) => updateSelected({ roundrectRatio }),
                '',
              )}
          </>
        );
    } else {
      const graphic = drawings.footprint.graphics[selection.index];
      if (graphic)
        properties = (
          <>
            {xy('Start', graphic.start, (start) => updateSelected({ start }))}
            {xy('End', graphic.end, (end) => updateSelected({ end }))}
            {graphic.mid && xy('Arc midpoint', graphic.mid, (mid) => updateSelected({ mid }))}
            {number('Stroke width', graphic.width, (width) => updateSelected({ width }))}
            {select(
              'Layer',
              graphic.layer,
              [
                'F.SilkS',
                'B.SilkS',
                'F.Fab',
                'B.Fab',
                'F.CrtYd',
                'B.CrtYd',
                'Dwgs.User',
                'Cmts.User',
              ],
              (layer) => updateSelected({ layer }),
            )}
            {graphic.kind === 'text' &&
              text('Text', graphic.text?.value ?? '', (value) =>
                updateSelected({ text: { ...graphic.text, value } }),
              )}
          </>
        );
    }
  }
  async function apply() {
    if (!canApply || gesture.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError('');
    try {
      let command: string, input: Record<string, unknown>;
      if (tab === 'symbol') {
        command = 'schematic.symbol.draw';
        input = {
          schematicId: basis.schematic.id,
          ...(targets.symbol ? { partId: targets.symbol } : { position }),
          name: names.symbol,
          referencePrefix: prefix,
          drawing: drawings.symbol,
        };
      } else {
        if (!board) throw new Error('This project has no PCB layout.');
        command = 'layout.footprint.draw';
        input = {
          boardId: board.id,
          ...(targets.footprint ? { footprintId: targets.footprint } : partId ? { partId } : {}),
          name: names.footprint,
          position,
          drawing: drawings.footprint,
        };
      }
      // Remove omitted optional local fields before the finite-JSON capability boundary.
      const result = (await capabilityHost.execute(command, JSON.parse(JSON.stringify(input)), {
        actor: 'human',
        expectedRevision: basis.revision,
        signal: controller.signal,
      })) as { selection?: string[]; footprintId?: string };
      onApplied(tab, result.selection?.[0] ?? result.footprintId);
      onClose();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      request.current = null;
      setBusy(false);
    }
  }
  const tools: Tool[] =
    tab === 'symbol'
      ? ['select', 'rectangle', 'circle', 'line', 'pin']
      : ['select', 'rectangle', 'circle', 'line', 'pad'];
  const selected = (kind: NonNullable<Selection>['kind'], index: number) =>
    selection?.kind === kind && selection.index === index;
  const pick = (event: React.MouseEvent, kind: NonNullable<Selection>['kind'], index: number) => {
    if (tool === 'select' && !busy) {
      event.stopPropagation();
      if (!fieldsInvalid) setSelection({ kind, index });
    }
  };
  function symbolGraphic(graphic: SymbolDrawingGraphic, index: number) {
    const fill =
      graphic.fill === 'outline'
        ? 'currentColor'
        : graphic.fill === 'background'
          ? 'var(--canvas)'
          : 'none';
    return (
      <g
        key={index}
        data-drawing-kind="graphic"
        data-drawing-index={index}
        onClick={(event) => pick(event, 'graphic', index)}
        stroke={
          selected('graphic', index) ? 'var(--schematic-reference)' : 'var(--symbol-physical)'
        }
        strokeWidth={graphic.width ?? 0.254}
        fill={fill}
        style={{ cursor: tool === 'select' ? 'pointer' : 'crosshair' }}
      >
        {graphic.type === 'rectangle' ? (
          <rect
            x={Math.min(graphic.start.x, graphic.end.x)}
            y={Math.min(graphic.start.y, graphic.end.y)}
            width={Math.abs(graphic.end.x - graphic.start.x)}
            height={Math.abs(graphic.end.y - graphic.start.y)}
          />
        ) : graphic.type === 'circle' ? (
          <circle cx={graphic.center.x} cy={graphic.center.y} r={graphic.radius} />
        ) : (
          <polyline points={graphic.points.map((p) => `${p.x},${p.y}`).join(' ')} />
        )}
      </g>
    );
  }
  return (
    <Dialog
      title="Draw component"
      icon={<PencilRuler size={20} />}
      wide
      className={styles.dialog}
      busy={busy}
      onClose={close}
      footer={
        <div
          className="dialog-footer-toolbar"
          onCompositionStartCapture={() => setComposing(true)}
          onCompositionEndCapture={() => setComposing(false)}
          onKeyDownCapture={(event) => {
            if (
              (composing || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) &&
              ['Enter', 'Escape'].includes(event.key)
            ) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
        >
          {!currentTarget && hasGeometry && (
            <details
              className={styles.placement}
              onKeyDown={(event) => {
                if (
                  event.key === 'Escape' &&
                  !composing &&
                  !event.nativeEvent.isComposing &&
                  event.nativeEvent.keyCode !== 229 &&
                  event.currentTarget.open
                ) {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!Object.keys(invalid).some((key) => key.startsWith('Placement '))) {
                    event.currentTarget.open = false;
                    event.currentTarget.querySelector('summary')?.focus();
                  }
                }
              }}
              onToggle={(event) => {
                if (Object.keys(invalid).some((key) => key.startsWith('Placement ')))
                  event.currentTarget.open = true;
              }}
            >
              <summary
                aria-label="Placement"
                title="Placement"
                onClick={(event) => {
                  if (busy || composing || gesture.current) event.preventDefault();
                }}
              >
                <Crosshair size={18} aria-hidden="true" />
              </summary>
              <div className={styles.placementFields}>{xy('Placement', position, setPosition)}</div>
            </details>
          )}
          <div className="dialog-footer-actions">
            <button
              className="icon-button dialog-footer-icon"
              aria-label="Reset drawing"
              title="Reset drawing"
              disabled={(!dirty && !fieldsInvalid) || busy || composing}
              onClick={resetDrawing}
            >
              <RotateCcw size={18} aria-hidden="true" />
            </button>
            <button
              className="icon-button dialog-footer-icon"
              aria-label="Cancel"
              title="Cancel"
              disabled={busy || composing}
              onClick={close}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>
          <button
            className="dialog-button primary dialog-footer-icon"
            aria-label="Apply drawing"
            title="Apply drawing"
            aria-busy={busy}
            disabled={!canApply}
            onClick={() => void apply()}
          >
            {busy ? (
              <LoaderCircle size={18} className={styles.preparing} aria-hidden="true" />
            ) : (
              <Check size={18} aria-hidden="true" />
            )}
          </button>
        </div>
      }
    >
      <div
        className={styles.editor}
        onCompositionStartCapture={() => setComposing(true)}
        onCompositionEndCapture={() => setComposing(false)}
        onKeyDownCapture={(event) => {
          if (composing || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
            if (['Enter', 'Escape'].includes(event.key)) event.preventDefault();
            return;
          }
          const editing =
            event.target instanceof Element &&
            event.target.closest('input,textarea,select,[contenteditable="true"],[role="listbox"]');
          if (editing || busy) return;
          if (event.repeat) {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
            }
            return;
          }
          if (event.key === 'Escape' && anchor) {
            event.preventDefault();
            event.stopPropagation();
            setAnchor(null);
            cancelGesture();
            return;
          }
          if (event.key === 'Escape' && (gesture.current || tool !== 'select' || selection)) {
            event.preventDefault();
            event.stopPropagation();
            if (gesture.current) cancelGesture();
            else if (tool !== 'select') setTool('select');
            else setSelection(null);
          }
          if (isCommandModifier(event) && ['z', 'y'].includes(event.key.toLowerCase())) {
            event.preventDefault();
            event.stopPropagation();
            undoDrawing(event.key.toLowerCase() === 'y' || event.shiftKey);
          }
        }}
      >
        <div
          className={`editor-view-switch ${styles.tabs}`}
          role="tablist"
          aria-label="Component drawing type"
          onKeyDown={(event) => {
            if (composing || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
              if (['Enter', ' ', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                event.stopPropagation();
              }
              return;
            }
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            if (busy || dirty || fieldsInvalid || event.repeat) return;
            const available: Tab[] = board ? ['symbol', 'footprint'] : ['symbol'];
            const direction = event.key === 'ArrowLeft' ? -1 : 1;
            const next =
              event.key === 'Home'
                ? available[0]
                : event.key === 'End'
                  ? available.at(-1)!
                  : available[
                      (available.indexOf(tab) + direction + available.length) % available.length
                    ];
            if (next !== tab) changeTab(next);
            event.currentTarget
              .querySelector<HTMLButtonElement>(`[data-drawing-tab="${next}"]`)
              ?.focus();
          }}
        >
          {(['symbol', 'footprint'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              className={`reveal-button${tab === kind ? ' active' : ''}`}
              role="tab"
              aria-label={kind === 'symbol' ? 'Symbol' : 'Footprint'}
              id={`${gridId}-${kind}-tab`}
              aria-controls={`${gridId}-panel`}
              aria-selected={tab === kind}
              tabIndex={tab === kind ? 0 : -1}
              data-drawing-tab={kind}
              disabled={
                busy || dirty || fieldsInvalid || composing || (kind !== 'symbol' && !board)
              }
              onClick={() => {
                if (kind !== tab) changeTab(kind);
              }}
            >
              {kind === 'symbol' ? (
                <SymbolIcon size={16} aria-hidden="true" />
              ) : (
                <FootprintIcon size={16} aria-hidden="true" />
              )}
              <span className="reveal-button-label" aria-hidden="true">
                <span>{kind === 'symbol' ? 'Symbol' : 'Footprint'}</span>
              </span>
            </button>
          ))}
        </div>
        <div
          className={styles.body}
          role="tabpanel"
          id={`${gridId}-panel`}
          aria-labelledby={`${gridId}-${tab}-tab`}
        >
          {stale && (
            <div role="alert" className={styles.error}>
              <p>
                The project changed. Your draft is retained. Refresh the revision to retry if the
                target is unchanged.
              </p>
              <button
                className="icon-button"
                aria-label="Refresh revision"
                title="Refresh revision"
                disabled={busy || composing}
                onClick={refreshRevision}
              >
                <RefreshCw size={16} aria-hidden="true" />
              </button>
            </div>
          )}
          {error && (
            <p role="alert" className={styles.error}>
              {error}
            </p>
          )}
          <div className={styles.identity}>
            <label className={styles.field}>
              Edit target
              <select
                aria-label="Drawing target"
                value={currentTarget}
                disabled={dirty || fieldsInvalid || busy}
                onChange={(event) => chooseTarget(event.target.value)}
              >
                <option value="">Create new</option>
                {tab === 'symbol'
                  ? basis.schematic.parts.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.ref} · {p.value}
                      </option>
                    ))
                  : board?.footprints.map((f) => (
                      <option key={f.id} value={f.id}>
                        {basis.project.schematic.parts.find((p) => p.id === f.symbolId)?.ref ??
                          f.reference}{' '}
                        · {f.libraryId}
                      </option>
                    ))}
              </select>
            </label>
            {text(
              'Name',
              names[tab],
              (name) => setNames({ ...names, [tab]: name }),
              !!currentTarget && tab === 'footprint',
            )}
            {tab === 'symbol'
              ? text('Reference prefix', prefix, setPrefix, !!currentTarget)
              : !currentTarget && (
                  <label className={styles.field}>
                    Component (optional)
                    <select
                      aria-label="Schematic component"
                      disabled={busy}
                      value={partId}
                      onChange={(event) => setPartId(event.target.value)}
                    >
                      <option value="">None</option>
                      {basis.project.schematic.parts
                        .filter(
                          (p, i, parts) =>
                            !board?.footprints.some((f) => f.symbolId === p.id) &&
                            parts.findIndex((q) => q.ref === p.ref) === i,
                        )
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.ref} · {p.value}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
          </div>
          <div className={styles.tools} role="group" aria-label="Drawing tools">
            <div className={styles.toolGroup}>
              {tools.map((next) => (
                <button
                  key={next}
                  className={styles.toolButton}
                  aria-label={next[0].toUpperCase() + next.slice(1)}
                  title={next[0].toUpperCase() + next.slice(1)}
                  aria-description={toolHints[next]}
                  aria-pressed={tool === next}
                  disabled={busy || composing || fieldsInvalid}
                  onClick={() => {
                    setTool(next);
                    setAnchor(null);
                    setSelection(null);
                    svg.current?.focus();
                  }}
                >
                  {(() => {
                    const Icon = toolIcons[next];
                    return <Icon size={16} aria-hidden="true" />;
                  })()}
                </button>
              ))}
            </div>
            <div className={styles.toolGroup}>
              <button
                className={styles.toolButton}
                aria-label="Undo drawing"
                title="Undo drawing"
                disabled={(!history.length && !anchor) || busy || composing || fieldsInvalid}
                onClick={() => undoDrawing()}
              >
                <Undo2 size={16} />
              </button>
              <button
                className={styles.toolButton}
                aria-label="Redo drawing"
                title="Redo drawing"
                disabled={!future.length || busy || composing || fieldsInvalid}
                onClick={() => undoDrawing(true)}
              >
                <Redo2 size={16} />
              </button>
              <button
                className={styles.toolButton}
                aria-label="Delete selected"
                title="Delete selected"
                disabled={!selection || busy || composing}
                onClick={remove}
              >
                <Trash2 size={16} />
              </button>
            </div>
            <div className={styles.toolGroup}>
              <button
                className={styles.toolButton}
                aria-label="Zoom in drawing"
                title="Zoom in"
                onClick={() => zoom(1 / 1.5)}
              >
                <ZoomIn size={16} />
              </button>
              <button
                className={styles.toolButton}
                aria-label="Zoom out drawing"
                title="Zoom out"
                onClick={() => zoom(1.5)}
              >
                <ZoomOut size={16} />
              </button>
              <button
                className={styles.toolButton}
                aria-label="Fit drawing"
                title="Fit drawing"
                onClick={() => fit()}
              >
                <Scan size={16} />
              </button>
            </div>
          </div>
          <div className={styles.workspace} data-inspector={Boolean(selection)}>
            <div className={styles.canvasPane}>
              <div className={styles.canvasFrame}>
                <svg
                  ref={svg}
                  className={styles.canvas}
                  viewBox={`${center.x - halfWidth} ${center.y - halfHeight} ${halfWidth * 2} ${halfHeight * 2}`}
                  preserveAspectRatio="xMidYMid meet"
                  style={{ cursor: tool === 'select' ? 'default' : 'crosshair' }}
                  aria-label={`${tab === 'symbol' ? 'Symbol' : 'Footprint'} drawing canvas`}
                  tabIndex={0}
                  onContextMenu={(event) => event.preventDefault()}
                  onPointerDown={(event) => {
                    if (gesture.current) return;
                    skipClick.current = false;
                    const at = point(event.clientX, event.clientY),
                      scale = svg.current?.getScreenCTM()?.a;
                    if (!at || !scale) return;
                    const pan = event.button === 1 || event.button === 2;
                    if (!pan && (event.button !== 0 || busy || composing || fieldsInvalid)) return;
                    const target = (event.target as Element).closest('[data-drawing-kind]');
                    const picked = target
                      ? {
                          kind: target.getAttribute(
                            'data-drawing-kind',
                          ) as NonNullable<Selection>['kind'],
                          index: Number(target.getAttribute('data-drawing-index')),
                        }
                      : null;
                    const kind = pan
                      ? 'pan'
                      : tool === 'select' && picked
                        ? 'move'
                        : ['rectangle', 'circle', 'line'].includes(tool)
                          ? 'shape'
                          : null;
                    svg.current?.focus();
                    if (!kind) return;
                    event.preventDefault();
                    gesture.current = {
                      id: event.pointerId,
                      kind,
                      client: { x: event.clientX, y: event.clientY },
                      point: at,
                      center,
                      scale,
                      drawings,
                      selection: picked,
                      moved: false,
                      newAnchor: !anchor,
                    };
                    event.currentTarget.setPointerCapture(event.pointerId);
                    if (kind === 'shape' && !anchor) {
                      setAnchor(at);
                      setCursor(at);
                    }
                  }}
                  onPointerMove={(event) => {
                    const at = point(event.clientX, event.clientY),
                      session = gesture.current;
                    setCursor(at);
                    if (!session || session.id !== event.pointerId) return;
                    if (
                      Math.hypot(
                        event.clientX - session.client.x,
                        event.clientY - session.client.y,
                      ) >= 4
                    )
                      session.moved = true;
                    if (!session.moved) return;
                    if (session.kind === 'pan')
                      setCenter({
                        x: session.center.x - (event.clientX - session.client.x) / session.scale,
                        y: session.center.y - (event.clientY - session.client.y) / session.scale,
                      });
                    else if (session.kind === 'move' && at) setDrawings(movedDrawing(session, at));
                  }}
                  onPointerUp={(event) => {
                    const session = gesture.current;
                    if (!session || session.id !== event.pointerId) return;
                    gesture.current = null;
                    const at = point(event.clientX, event.clientY);
                    if (session.moved && session.kind !== 'pan') {
                      skipClick.current = true;
                      if (at && session.kind === 'shape') draw(at);
                      if (session.kind === 'move') {
                        const next = at ? movedDrawing(session, at) : session.drawings;
                        setDrawings(next);
                        if (JSON.stringify(next) !== JSON.stringify(session.drawings)) {
                          setHistory((old) => [...old.slice(-31), session.drawings]);
                          setFuture([]);
                          setError('');
                        }
                      }
                    } else if (session.kind === 'move') {
                      skipClick.current = true;
                    }
                    if (event.currentTarget.hasPointerCapture(event.pointerId))
                      event.currentTarget.releasePointerCapture(event.pointerId);
                    if (session.kind === 'move') setSelection(session.selection);
                  }}
                  onPointerCancel={cancelGesture}
                  onLostPointerCapture={cancelGesture}
                  onPointerLeave={() => setCursor(null)}
                  onClickCapture={(event) => {
                    if (skipClick.current) {
                      skipClick.current = false;
                      event.stopPropagation();
                    }
                  }}
                  onClick={(event) => {
                    if (busy || composing || fieldsInvalid) return;
                    svg.current?.focus();
                    const at = point(event.clientX, event.clientY);
                    if (at) draw(at);
                  }}
                  onKeyDown={(event) => {
                    if (
                      composing ||
                      event.nativeEvent.isComposing ||
                      event.nativeEvent.keyCode === 229 ||
                      gesture.current
                    )
                      return;
                    if (event.key === 'Delete' || event.key === 'Backspace') {
                      event.preventDefault();
                      remove();
                    }
                    if (isCommandModifier(event) || event.altKey || event.repeat) return;
                    if (event.key === 'Home' || event.key === ' ') {
                      event.preventDefault();
                      fit();
                    }
                    if (event.key === '+' || event.key === '=') {
                      event.preventDefault();
                      zoom(1 / 1.5);
                    }
                    if (event.key === '-') {
                      event.preventDefault();
                      zoom(1.5);
                    }
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      if (anchor && cursor && !fieldsInvalid) draw(cursor);
                      else if (canApply) void apply();
                    }
                  }}
                >
                  <defs>
                    <pattern
                      id={gridId}
                      data-drawing-grid
                      x={-grid.spacing / 2}
                      y={-grid.spacing / 2}
                      width={grid.spacing}
                      height={grid.spacing}
                      patternUnits="userSpaceOnUse"
                    >
                      <circle
                        cx={grid.spacing / 2}
                        cy={grid.spacing / 2}
                        r={Math.min(grid.radius, unitsPerPixel * 0.75)}
                        fill="var(--soft)"
                      />
                    </pattern>
                  </defs>
                  <rect
                    data-drawing-background
                    x={center.x - halfWidth}
                    y={center.y - halfHeight}
                    width={halfWidth * 2}
                    height={halfHeight * 2}
                    fill={`url(#${gridId})`}
                  />
                  <path
                    data-drawing-origin
                    d={`M ${center.x - halfWidth} 0 H ${center.x + halfWidth} M 0 ${center.y - halfHeight} V ${center.y + halfHeight}`}
                    stroke="var(--line)"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                  />
                  {tab === 'symbol' ? (
                    <>
                      {drawings.symbol.graphics.map(symbolGraphic)}
                      {drawings.symbol.pins.map((pin, index) => {
                        const end = pinEnd(pin);
                        return (
                          <g
                            key={index}
                            data-drawing-kind="pin"
                            data-drawing-index={index}
                            onClick={(event) => pick(event, 'pin', index)}
                            stroke={
                              selected('pin', index) ? 'var(--schematic-reference)' : 'var(--wire)'
                            }
                            strokeWidth={0.2}
                            opacity={pin.hidden ? 0.4 : 1}
                          >
                            <line x1={pin.x} y1={pin.y} x2={end.x} y2={end.y} />
                            <circle cx={pin.x} cy={pin.y} r={0.25} fill="var(--canvas)" />
                            <text
                              x={(pin.x + end.x) / 2}
                              y={(pin.y + end.y) / 2 - 0.5}
                              fontSize={0.9}
                              stroke="none"
                              fill="var(--text)"
                            >
                              {pin.number}
                            </text>
                            <text
                              x={end.x + 0.5}
                              y={end.y - 0.5}
                              fontSize={0.9}
                              stroke="none"
                              fill="var(--text)"
                            >
                              {pin.name}
                            </text>
                          </g>
                        );
                      })}
                    </>
                  ) : (
                    <>
                      {drawings.footprint.graphics.map((graphic, index) => (
                        <g
                          key={graphic.id ?? index}
                          data-drawing-kind="graphic"
                          data-drawing-index={index}
                          onClick={(event) => pick(event, 'graphic', index)}
                        >
                          <PCBGraphic
                            graphic={graphic as BoardLine}
                            color={
                              selected('graphic', index)
                                ? 'var(--schematic-reference)'
                                : 'var(--symbol-physical)'
                            }
                          />
                        </g>
                      ))}
                      {drawings.footprint.pads.map((pad, index) => (
                        <g
                          key={pad.id ?? index}
                          data-drawing-kind="pad"
                          data-drawing-index={index}
                          transform={`translate(${pad.x} ${pad.y}) rotate(${-pad.rotation})`}
                          onClick={(event) => pick(event, 'pad', index)}
                          fill={
                            selected('pad', index) ? 'var(--schematic-reference)' : 'var(--wire)'
                          }
                        >
                          {pad.shape === 'circle' ? (
                            <circle r={pad.size.x / 2} />
                          ) : pad.shape === 'roundrect' || pad.outline ? (
                            <path d={pcbPadPath(pad)} />
                          ) : (
                            <rect
                              x={-pad.size.x / 2}
                              y={-pad.size.y / 2}
                              width={pad.size.x}
                              height={pad.size.y}
                              rx={pad.shape === 'oval' ? Math.min(pad.size.x, pad.size.y) / 2 : 0}
                            />
                          )}
                          {pad.drill && <PadDrillGraphic pad={pad} fill="var(--canvas)" />}
                          <text y={0.3} textAnchor="middle" fontSize={0.8} fill="var(--on-accent)">
                            {pad.number}
                          </text>
                        </g>
                      ))}
                    </>
                  )}
                  {anchor &&
                    cursor &&
                    (tool === 'rectangle' ? (
                      <rect
                        x={Math.min(anchor.x, cursor.x)}
                        y={Math.min(anchor.y, cursor.y)}
                        width={Math.abs(cursor.x - anchor.x)}
                        height={Math.abs(cursor.y - anchor.y)}
                        stroke="var(--schematic-reference)"
                        strokeWidth={0.12}
                        fill="none"
                      />
                    ) : tool === 'circle' ? (
                      <circle
                        cx={anchor.x}
                        cy={anchor.y}
                        r={Math.hypot(cursor.x - anchor.x, cursor.y - anchor.y)}
                        stroke="var(--schematic-reference)"
                        strokeWidth={0.12}
                        fill="none"
                      />
                    ) : (
                      <line
                        x1={anchor.x}
                        y1={anchor.y}
                        x2={cursor.x}
                        y2={cursor.y}
                        stroke="var(--schematic-reference)"
                        strokeWidth={0.12}
                      />
                    ))}
                </svg>
              </div>
            </div>
            {selection && (
              <aside className={styles.inspector} aria-label="Drawing properties">
                <div className={styles.inspectorHeader}>
                  {`${selection.kind[0].toUpperCase() + selection.kind.slice(1)} ${selection.index + 1}`}
                </div>
                <label className={styles.field}>
                  Selected object
                  <select
                    aria-label="Selected drawing object"
                    value={selection ? `${selection.kind}/${selection.index}` : ''}
                    disabled={busy || fieldsInvalid}
                    onChange={(event) => {
                      const [kind, index] = event.target.value.split('/');
                      setSelection(
                        kind
                          ? {
                              kind: kind as NonNullable<Selection>['kind'],
                              index: Number(index),
                            }
                          : null,
                      );
                      if (!kind) svg.current?.focus();
                    }}
                  >
                    <option value="">None</option>
                    {drawings[tab].graphics.map((_, i) => (
                      <option key={`graphic/${i}`} value={`graphic/${i}`}>
                        Graphic {i + 1}
                      </option>
                    ))}
                    {(tab === 'symbol' ? drawings.symbol.pins : drawings.footprint.pads).map(
                      (entry, i) => (
                        <option
                          key={`terminal/${i}`}
                          value={`${tab === 'symbol' ? 'pin' : 'pad'}/${i}`}
                        >
                          {tab === 'symbol' ? 'Pin' : 'Pad'} {entry.number}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                {properties}
              </aside>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
