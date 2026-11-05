'use client';
import { useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import { modelScaleLength } from './model-scale';
import {
  measurementDistance,
  measurementAngles,
  measurementTicks,
  type CanvasMeasurement,
  type MeasurementPoint,
} from '@/lib/canvas-measurement';

const formatMeasurement = (value: number) => {
  const text = value.toFixed(3);
  return text === '-0.000' ? '0.000' : text;
};

export function MeasurementReadout({
  measurement,
  spatial = false,
}: {
  measurement: CanvasMeasurement;
  spatial?: boolean;
}) {
  const value = useSyncExternalStore(
    measurement.subscribe,
    measurement.getSnapshot,
    measurement.getSnapshot,
  );
  if (!value.start || !value.end) return null;
  const result = measurementDistance(value.start, value.end);
  const angles = measurementAngles(value.start, value.end);
  const degrees = (angle: number | null) => (angle === null ? '—' : `${formatMeasurement(angle)}°`);
  const detail = `ΔX ${formatMeasurement(result.x)} mm · ΔY ${formatMeasurement(result.y)} mm${spatial ? ` · ΔZ ${formatMeasurement(result.z)} mm` : ''} · ${spatial ? 'XY angle' : 'Angle'} ${degrees(angles.angle)}${spatial ? ` · Elevation ${degrees(angles.elevation)}` : ''}`;
  const estimated = value.start.estimated || value.end.estimated;
  return (
    <span
      className="measurement-distance"
      title={`${detail}. Angle from native +X toward +Y${spatial ? '; elevation from the XY plane' : ''}.`}
      aria-label={`Distance ${formatMeasurement(result.distance)} mm. ${detail}${estimated ? '. Estimated body' : ''}`}
    >
      <span>{formatMeasurement(result.distance)} mm</span>
      <span className="measurement-detail">{detail}</span>
      {estimated && <small>Estimated</small>}
    </span>
  );
}

function rulerGeometry(
  start: MeasurementPoint,
  end: MeasurementPoint,
  project: (point: MeasurementPoint) => { x: number; y: number } | null,
  scale = 1,
  unitsPerPixel = scale,
  interval?: number,
) {
  const a = project(start),
    b = project(end);
  if (!a || !b || !Number.isFinite(scale) || scale <= 0) return '';
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length / scale < 1) return '';
  const distance = measurementDistance(start, end).distance;
  // Normalize to unit intervals so the shared bounded thinning also supports
  // the compact Model scale beyond Layout's fixed length range.
  const ticks = interval
    ? measurementTicks(distance / interval, 0.01)
    : measurementTicks(distance, unitsPerPixel);
  if (!ticks.length) return '';
  const nx = -(b.y - a.y) / length,
    ny = (b.x - a.x) / length;
  return ticks
    .map((tick) => {
      const point = project({
        x: start.x + (end.x - start.x) * tick.fraction,
        y: start.y + (end.y - start.y) * tick.fraction,
        z: start.z + (end.z - start.z) * tick.fraction,
      });
      if (!point) return '';
      const size = 7 * scale;
      return `M${point.x - (nx * size) / 2},${point.y - (ny * size) / 2}l${nx * size},${ny * size}`;
    })
    .join('');
}

export function MeasurementDrawing({
  measurement,
  scale = 1,
}: {
  measurement: CanvasMeasurement;
  scale?: number;
}) {
  const { start, end, hover } = useSyncExternalStore(
    measurement.subscribe,
    measurement.getSnapshot,
    measurement.getSnapshot,
  );
  if (!start && !hover) return null;
  const ruler = start && end ? rulerGeometry(start, end, (point) => point, scale) : null;
  return (
    <g
      className="canvas-measurement-ink"
      data-annotation-overlay
      data-measurement-overlay
      pointerEvents="none"
    >
      {start && end && <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} />}
      {ruler && (
        <g data-measurement-ticks>
          <path d={ruler} />
        </g>
      )}
      {start && <circle cx={start.x} cy={start.y} r={4 * scale} />}
      {end && <circle cx={end.x} cy={end.y} r={4 * scale} />}
      {hover && <circle data-measurement-snap cx={hover.x} cy={hover.y} r={7 * scale} />}
    </g>
  );
}

/** Project only the overlay on camera changes; it never participates in scene bounds or picking. */
export function ModelMeasurementDrawing({
  measurement,
  project,
  redraw,
  unitsPerPixel,
}: {
  measurement: CanvasMeasurement;
  project: RefObject<(point: MeasurementPoint) => { x: number; y: number } | null>;
  redraw: RefObject<() => void>;
  unitsPerPixel: RefObject<() => number>;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const line = useRef<SVGLineElement>(null);
  const first = useRef<SVGCircleElement>(null);
  const second = useRef<SVGCircleElement>(null);
  const snap = useRef<SVGCircleElement>(null);
  const ticks = useRef<SVGGElement>(null);
  useLayoutEffect(() => {
    const update = () => {
      if (
        !svg.current ||
        !line.current ||
        !first.current ||
        !second.current ||
        !snap.current ||
        !ticks.current
      )
        return;
      const { start, end, hover } = measurement.getSnapshot();
      const a = start && project.current(start);
      const b = end && project.current(end);
      const h = hover && project.current(hover);
      svg.current.style.display = a || h ? '' : 'none';
      if (!a && !h) return;
      svg.current.setAttribute(
        'viewBox',
        `0 0 ${svg.current.clientWidth} ${svg.current.clientHeight}`,
      );
      first.current.style.display = a ? '' : 'none';
      snap.current.style.display = h ? '' : 'none';
      if (h) {
        snap.current.setAttribute('cx', String(h.x));
        snap.current.setAttribute('cy', String(h.y));
      }
      if (a) {
        first.current.setAttribute('cx', String(a.x));
        first.current.setAttribute('cy', String(a.y));
      }
      line.current.style.display = second.current.style.display = a && b ? '' : 'none';
      ticks.current.replaceChildren();
      if (!a || !b || !start || !end) return;
      const spacing = unitsPerPixel.current();
      const ruler = rulerGeometry(
        start,
        end,
        project.current,
        1,
        spacing,
        modelScaleLength(spacing),
      );
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', ruler);
      ticks.current.append(path);
      for (const [key, value] of Object.entries({ x1: a.x, y1: a.y, x2: b.x, y2: b.y }))
        line.current.setAttribute(key, String(value));
      for (const [node, point] of [
        [first.current, a],
        [second.current, b],
      ] as const) {
        node.setAttribute('cx', String(point.x));
        node.setAttribute('cy', String(point.y));
      }
    };
    redraw.current = update;
    const unsubscribe = measurement.subscribe(update);
    update();
    return () => {
      unsubscribe();
      redraw.current = () => {};
    };
  }, [measurement, project, redraw, unitsPerPixel]);
  return (
    <svg
      ref={svg}
      className="model-measurement-overlay canvas-measurement-ink"
      aria-hidden="true"
      data-measurement-overlay
    >
      <line ref={line} />
      <g ref={ticks} data-measurement-ticks />
      <circle ref={first} r={4} />
      <circle ref={second} r={4} />
      <circle ref={snap} r={7} data-measurement-snap />
    </svg>
  );
}
