import { localPadDrillLine } from '../lib/pcb-drill';
import type { Point } from '@/lib/circuit';
import type { FootprintDrawing } from '@/lib/footprint-drawing';
import type { BoardLine } from '@/lib/pcb';
import { pcbGraphicPoints, transformPCBGraphic } from '@/lib/pcb-geometry';
import type { SymbolDrawing } from '@/lib/symbol-drawing';

type DrawingBounds = { minX: number; minY: number; maxX: number; maxY: number };
type DrawingSelection = { kind: 'graphic' | 'pin' | 'pad'; index: number };
type DrawingKind = 'symbol' | 'footprint';
type Drawing = SymbolDrawing | FootprintDrawing;

/** Presentation bounds for Fit. They neither validate nor change native geometry. */
export function drawingBounds(kind: DrawingKind, drawing: Drawing): DrawingBounds | null {
  let bounds: DrawingBounds | null = null;
  const include = (point: Point, margin = 0) => {
    if (![point.x, point.y, margin].every(Number.isFinite)) return;
    const radius = Math.max(0, margin);
    if (!bounds) {
      bounds = {
        minX: point.x - radius,
        minY: point.y - radius,
        maxX: point.x + radius,
        maxY: point.y + radius,
      };
      return;
    }
    bounds.minX = Math.min(bounds.minX, point.x - radius);
    bounds.minY = Math.min(bounds.minY, point.y - radius);
    bounds.maxX = Math.max(bounds.maxX, point.x + radius);
    bounds.maxY = Math.max(bounds.maxY, point.y + radius);
  };
  if (kind === 'symbol') {
    const symbol = drawing as SymbolDrawing;
    for (const graphic of symbol.graphics) {
      const stroke = (graphic.width ?? 0.254) / 2;
      if (graphic.type === 'circle') include(graphic.center, Math.abs(graphic.radius) + stroke);
      else if (graphic.type === 'rectangle') {
        include(graphic.start, stroke);
        include(graphic.end, stroke);
      } else for (const point of graphic.points) include(point, stroke);
    }
    for (const pin of symbol.pins) {
      const angle = (pin.rotation * Math.PI) / 180;
      include(pin, 0.25);
      include(
        {
          x: pin.x + Math.cos(angle) * pin.length,
          y: pin.y - Math.sin(angle) * pin.length,
        },
        0.25,
      );
    }
  } else {
    const footprint = drawing as FootprintDrawing;
    for (const graphic of footprint.graphics)
      for (const point of pcbGraphicPoints(graphic as BoardLine)) include(point, graphic.width / 2);
    for (const pad of footprint.pads) {
      const angle = (-pad.rotation * Math.PI) / 180;
      const cosine = Math.cos(angle),
        sine = Math.sin(angle);
      const halfX = Math.abs(pad.size.x) / 2,
        halfY = Math.abs(pad.size.y) / 2;
      const extentX =
        pad.shape === 'circle' ? halfX : Math.abs(cosine) * halfX + Math.abs(sine) * halfY;
      const extentY =
        pad.shape === 'circle' ? halfY : Math.abs(sine) * halfX + Math.abs(cosine) * halfY;
      if (pad.outline) {
        for (const { x, y } of pad.outline)
          include({ x: pad.x + x * cosine - y * sine, y: pad.y + x * sine + y * cosine });
      } else {
        include({ x: pad.x - extentX, y: pad.y - extentY });
        include({ x: pad.x + extentX, y: pad.y + extentY });
      }
      if (pad.drill)
        for (const offset of localPadDrillLine(pad)) {
          include(
            {
              x: pad.x + offset.x * cosine - offset.y * sine,
              y: pad.y + offset.x * sine + offset.y * cosine,
            },
            Math.abs(pad.drill) / 2,
          );
        }
    }
  }
  return bounds;
}

export function translateDrawingSelection(
  kind: 'symbol',
  drawing: SymbolDrawing,
  selection: DrawingSelection,
  delta: Point,
): SymbolDrawing;
export function translateDrawingSelection(
  kind: 'footprint',
  drawing: FootprintDrawing,
  selection: DrawingSelection,
  delta: Point,
): FootprintDrawing;
export function translateDrawingSelection(
  kind: DrawingKind,
  drawing: Drawing,
  selection: DrawingSelection,
  delta: Point,
): Drawing;
/** Translate a local draft only. The ordinary drawing capability validates Apply. */
export function translateDrawingSelection(
  kind: DrawingKind,
  drawing: Drawing,
  selection: DrawingSelection,
  delta: Point,
): Drawing {
  if (![delta.x, delta.y].every(Number.isFinite))
    throw new Error('Drawing displacement must be finite.');
  const next = structuredClone(drawing);
  if ((!delta.x && !delta.y) || !Number.isInteger(selection.index) || selection.index < 0)
    return next;
  const precision = kind === 'symbol' ? 4 : 6;
  const point = (value: Point): Point => ({
    x: Number((value.x + delta.x).toFixed(precision)),
    y: Number((value.y + delta.y).toFixed(precision)),
  });
  if (kind === 'symbol') {
    const symbol = next as SymbolDrawing;
    if (selection.kind === 'pin') {
      const pin = symbol.pins[selection.index];
      if (pin) symbol.pins[selection.index] = { ...pin, ...point(pin) };
    } else if (selection.kind === 'graphic') {
      const graphic = symbol.graphics[selection.index];
      if (!graphic) return next;
      symbol.graphics[selection.index] =
        graphic.type === 'circle'
          ? { ...graphic, center: point(graphic.center) }
          : graphic.type === 'rectangle'
            ? { ...graphic, start: point(graphic.start), end: point(graphic.end) }
            : { ...graphic, points: graphic.points.map(point) };
    }
  } else {
    const footprint = next as FootprintDrawing;
    if (selection.kind === 'pad') {
      const pad = footprint.pads[selection.index];
      if (pad) footprint.pads[selection.index] = { ...pad, ...point(pad) };
    } else if (selection.kind === 'graphic') {
      const graphic = footprint.graphics[selection.index];
      if (graphic)
        footprint.graphics[selection.index] = transformPCBGraphic(graphic as BoardLine, point);
    }
  }
  return next;
}
