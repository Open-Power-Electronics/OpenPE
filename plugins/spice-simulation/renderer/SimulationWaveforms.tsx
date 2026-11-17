'use client';
import {
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type RefObject,
  type ReactNode,
} from 'react';
import {
  createLucideIcon,
  Link2,
  Maximize,
  Plus,
  Redo2,
  SquareDashedMousePointer,
  Timer,
  Undo2,
  Unlink2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import Select from '../../../components/Select';
import WaveformLayoutPicker from '../../../components/WaveformLayoutPicker';
import WaveformAxisDialog from '../../../components/WaveformAxisDialog';
import type { SimulationResult } from '@/plugins/spice-simulation/domain/spice';
import type { AgentWaveformPresentation } from '@/context/agent-simulation-context';
import { createCapabilityHost, type CapabilityHost } from '@/api/capabilities';
import {
  registerSimulationPresentationCapability,
  type SimulationPresentationInput,
} from '@/plugins/spice-simulation/renderer/simulation-capabilities';
import { waveformCursorIndex, waveformIndices } from '@/plugins/spice-simulation/domain/waveform';
import { waveformRows } from '@/plugins/spice-simulation/domain/waveform-layout';
import {
  changeWaveformView,
  initialWaveformHistory,
  initialWaveformView,
  navigateWaveformView,
  niceWaveformStep,
  panWaveformAxis,
  validWaveformAxis,
  validWaveformTime,
  waveformSampleWindow,
  waveformTicks,
  zoomWaveformAxis,
  type WaveformAxis,
  type WaveformView,
  type WaveformHistory,
} from '@/plugins/spice-simulation/domain/waveform-view';
import { isCommandModifier } from '@/lib/command-modifier';
const formatted = (v: number) => Number(v.toPrecision(5)).toString();
type CursorPair = [number | null, number | null];

const SecondCursorIcon = createLucideIcon('SecondCursor', [
  ['path', { d: 'M5 3v18m-2-3h4', key: 'first-cursor' }],
  ['path', { d: 'M14 12v9m-2-3h4', key: 'second-cursor' }],
  ['path', { d: 'M14 3v6m-3-3h6', key: 'add' }],
]);

function minorGridTicks(axis: WaveformAxis, majorTicks: number[], divisions: number) {
  if (axis.step !== undefined) return [];
  const major = new Set(majorTicks);
  return waveformTicks({
    ...axis,
    step: niceWaveformStep(axis.max - axis.min, divisions) / 2,
  }).filter((value) => !major.has(value));
}

function scaleFor(value: number) {
  const magnitude = Math.abs(value);
  if (!magnitude) return { factor: 1, prefix: '' };
  const exponent = Math.max(-12, Math.min(9, Math.floor(Math.log10(magnitude) / 3) * 3));
  const prefix = (
    {
      '-12': 'p',
      '-9': 'n',
      '-6': 'µ',
      '-3': 'm',
      '0': '',
      '3': 'k',
      '6': 'M',
      '9': 'G',
    } as Record<string, string>
  )[exponent];
  return { factor: 10 ** exponent, prefix };
}
const measured = (value: number, unit: string) => {
  const scale = scaleFor(value);
  return `${formatted(value / scale.factor)} ${scale.prefix}${unit}`;
};

function Waveform({
  result,
  trace,
  timeAxis: savedTimeAxis,
  valueAxis: savedValueAxis,
  zoomMode,
  active,
  onZoom,
  onAxis,
  cursors: cursorTimes,
  visibleCursors,
  onCursor,
  controls,
  resultKey,
  presentationRef,
}: {
  result: SimulationResult;
  trace: SimulationResult['traces'][number];
  timeAxis: WaveformAxis;
  valueAxis?: WaveformAxis;
  zoomMode: boolean;
  active: boolean;
  onZoom: (time: WaveformAxis, values: WaveformAxis) => void;
  onAxis: (
    axis: 'time' | 'value',
    value: WaveformAxis,
    anchor: RefObject<HTMLElement | null>,
    point: { x: number; y: number },
  ) => void;
  cursors: CursorPair;
  visibleCursors: [boolean, boolean];
  onCursor: (which: number, index: number) => void;
  controls: ReactNode;
  resultKey?: number;
  presentationRef?: RefObject<AgentWaveformPresentation | null>;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const waveformRef = useRef<HTMLElement>(null);
  const clipId = useId();
  const zoom = useRef<{ pointerId: number; x0: number; y0: number; x1: number; y1: number } | null>(
    null,
  );
  const pan = useRef<{
    pointerId: number;
    x: number;
    y: number;
    width: number;
    height: number;
    time: WaveformAxis;
    values: WaveformAxis;
  } | null>(null);
  const [panPreview, setPanPreview] = useState<{
    time: WaveformAxis;
    values: WaveformAxis;
  } | null>(null);
  const timeAxis = panPreview?.time ?? savedTimeAxis;
  const valueAxis = panPreview?.values ?? savedValueAxis;
  const [start, end] = waveformSampleWindow(result.time, timeAxis);
  const cursors = cursorTimes.map((cursor, which) =>
    visibleCursors[which] ? waveformCursorIndex(result.time, cursor, start, end) : null,
  );
  const [marquee, setMarquee] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const valueRefs = useRef<(SVGTextElement | null)[]>([]);
  const cursorRefs = useRef<(SVGGElement | null)[]>([]);
  const drag = useRef<{ which: number; offset: number; pointerId: number } | null>(null);
  const [valueSizes, setValueSizes] = useState([
    { width: 0, height: 12 },
    { width: 0, height: 12 },
  ]);
  const [dragging, setDragging] = useState(false);
  const [size, setSize] = useState({ width: 500, height: 170 });
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize({ width, height });
    });
    observer.observe(svg);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() =>
      setValueSizes(
        Array.from({ length: 2 }, (_, index) => ({
          width: valueRefs.current[index]?.getComputedTextLength() ?? 0,
          height: valueRefs.current[index]?.getBBox().height ?? 12,
        })),
      ),
    );
    valueRefs.current.forEach((text) => {
      if (text) observer.observe(text);
    });
    return () => observer.disconnect();
  }, [cursors[0] !== null, cursors[1] !== null]);
  const valueHeight = Math.max(12, ...valueSizes.map((value) => value.height));
  const plot = useMemo(() => {
    const indices = waveformIndices(
      trace.values,
      Math.max(0, start - 1),
      Math.min(result.time.length - 1, end + 1),
    );
    let min = Infinity,
      max = -Infinity;
    for (const i of indices) {
      min = Math.min(min, trace.values[i]);
      max = Math.max(max, trace.values[i]);
    }
    const pad = max > min ? (max - min) * 0.06 : Math.abs(max) * 0.02 || 1;
    const rough =
      (max - min + 2 * pad) / Math.max(2, Math.min(4, Math.floor((size.height - 50) / 28)));
    const step = niceWaveformStep(rough, 1);
    const low =
      valueAxis?.min ?? (min >= 0 && min - pad < 0 ? 0 : Math.floor((min - pad) / step) * step);
    const high =
      valueAxis?.max ?? (max < 0 && max + pad > 0 ? 0 : Math.ceil((max + pad) / step) * step);
    const axis = valueAxis ?? { min: low, max: high };
    const divisions = Math.max(2, Math.min(4, Math.floor((size.height - 50) / 28)));
    const ticks = waveformTicks(axis, divisions);
    const timeDivisions = size.width < 480 ? 2 : 4;
    const timeTicks = waveformTicks(timeAxis, timeDivisions);
    const left = 60,
      right = Math.max(left + 1, size.width - 22),
      top = valueHeight + 12,
      bottom = Math.max(top + 1, size.height - 28);
    const span = timeAxis.max - timeAxis.min;
    const timeX = (time: number) => left + ((time - timeAxis.min) / span) * (right - left);
    const x = (i: number) => timeX(result.time[i]);
    const y = (v: number) => top + ((high - v) / (high - low)) * (bottom - top);
    return {
      min,
      max,
      ticks,
      minorTicks: minorGridTicks(axis, ticks, divisions),
      minorTimeTicks: minorGridTicks(timeAxis, timeTicks, timeDivisions),
      left,
      right,
      top,
      bottom,
      x,
      y,
      axis,
      timeX,
      timeTicks,
      timeAt: (x: number) => timeAxis.min + ((x - left) / (right - left)) * span,
      valueAt: (y: number) => high - ((y - top) / (bottom - top)) * (high - low),
      scale: scaleFor(Math.max(Math.abs(low), Math.abs(high))),
      timeScale: scaleFor(timeAxis.max),
      path: indices
        .map((i, j) => `${j ? 'L' : 'M'}${x(i).toFixed(2)},${y(trace.values[i]).toFixed(2)}`)
        .join(' '),
    };
  }, [
    result,
    trace,
    start,
    end,
    size,
    valueHeight,
    timeAxis.min,
    timeAxis.max,
    timeAxis.step,
    valueAxis,
  ]);
  useLayoutEffect(() => {
    if (presentationRef?.current)
      presentationRef.current.traces[trace.vector] = {
        time: timeAxis,
        values: plot.axis,
        cursors: [cursorTimes[0] ?? result.time[end], cursorTimes[1]],
      };
  });
  function nearestCursor(x: number) {
    const [a, b] = cursors;
    if (a === null) return b === null ? null : 1;
    if (b === null) return 0;
    return Math.abs(x - plot.x(a)) <= Math.abs(x - plot.x(b)) ? 0 : 1;
  }
  function openAxis(
    axis: 'time' | 'value',
    target: SVGGElement,
    pointer?: { clientX: number; clientY: number },
  ) {
    const owner = waveformRef.current?.getBoundingClientRect();
    if (!owner) return;
    target.focus();
    const bounds = target.getBoundingClientRect();
    onAxis(axis, axis === 'time' ? timeAxis : plot.axis, waveformRef, {
      x: (pointer?.clientX ?? bounds.left + bounds.width / 2) - owner.left,
      y: (pointer?.clientY ?? bounds.top + bounds.height / 2) - owner.top,
    });
  }
  const scaledView = (factor: number) => {
    const time = zoomWaveformAxis(timeAxis, factor, {
      min: result.time[0],
      max: result.time.at(-1)!,
    });
    const values = zoomWaveformAxis(plot.axis, factor);
    return time && values && validWaveformTime(result.time, time) ? { time, values } : null;
  };
  const zoomIn = scaledView(0.5);
  const zoomOut = scaledView(2);
  function moveCursor(event: PointerEvent<SVGSVGElement>) {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const position =
      (event.clientX - rect.left - drag.current.offset - plot.left) / (plot.right - plot.left);
    const time = timeAxis.min + Math.max(0, Math.min(1, position)) * (timeAxis.max - timeAxis.min);
    let low = start,
      high = end;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (result.time[middle] < time) low = middle + 1;
      else high = middle;
    }
    onCursor(
      drag.current.which,
      low > start && time - result.time[low - 1] < result.time[low] - time ? low - 1 : low,
    );
  }
  function finishDrag() {
    const pointerId = drag.current?.pointerId ?? zoom.current?.pointerId ?? pan.current?.pointerId;
    drag.current = null;
    zoom.current = null;
    pan.current = null;
    setPanPreview(null);
    setMarquee(null);
    setDragging(false);
    if (pointerId !== undefined && svgRef.current?.hasPointerCapture(pointerId))
      svgRef.current.releasePointerCapture(pointerId);
  }
  useLayoutEffect(() => {
    finishDrag();
  }, [
    active,
    resultKey === undefined ? result : resultKey,
    zoomMode,
    savedTimeAxis.min,
    savedTimeAxis.max,
    savedValueAxis,
    size.width,
    size.height,
    cursors[0] === null,
    cursors[1] === null,
  ]);
  function zoomPosition(event: PointerEvent<SVGSVGElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(plot.left, Math.min(plot.right, event.clientX - bounds.left)),
      y: Math.max(plot.top, Math.min(plot.bottom, event.clientY - bounds.top)),
    };
  }
  function panPosition(event: PointerEvent<SVGSVGElement>) {
    const origin = pan.current!;
    const translatedTime = panWaveformAxis(
      origin.time,
      ((origin.x - event.clientX) / origin.width) * (origin.time.max - origin.time.min),
      { min: result.time[0], max: result.time.at(-1)! },
    );
    const time =
      translatedTime && validWaveformTime(result.time, translatedTime)
        ? translatedTime
        : origin.time;
    const values =
      panWaveformAxis(
        origin.values,
        ((event.clientY - origin.y) / origin.height) * (origin.values.max - origin.values.min),
      ) ?? origin.values;
    return { time, values };
  }
  useLayoutEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const wheel = (event: WheelEvent) => {
      if (!active || !isCommandModifier(event) || drag.current || zoom.current || pan.current)
        return;
      event.preventDefault();
      event.stopPropagation();
      const anchor = Math.max(
        0,
        Math.min(
          1,
          (event.clientX - svg.getBoundingClientRect().left - plot.left) / (plot.right - plot.left),
        ),
      );
      const factor = event.deltaY > 0 ? 1.25 : 0.8;
      const span = Math.min(
        result.time.at(-1)! - result.time[0],
        (timeAxis.max - timeAxis.min) * factor,
      );
      const min = Math.max(
        result.time[0],
        Math.min(
          result.time.at(-1)! - span,
          timeAxis.min + (timeAxis.max - timeAxis.min - span) * anchor,
        ),
      );
      onZoom({ min, max: min + span }, plot.axis);
    };
    svg.addEventListener('wheel', wheel, { passive: false });
    return () => svg.removeEventListener('wheel', wheel);
  }, [active, plot, timeAxis, result, onZoom]);
  const name = trace.unit === 'A' ? trace.label.split(' · ')[0] : trace.label;
  return (
    <section className="simulation-waveform" ref={waveformRef}>
      <div className="simulation-trace-heading">
        <strong aria-description={trace.label}>{name}</strong>
      </div>
      <div
        className="simulation-plot-tools"
        role="group"
        aria-label={`${trace.label} view controls`}
      >
        <button
          type="button"
          className="icon-button"
          aria-label={`Zoom in ${trace.label}`}
          title="Zoom in"
          aria-description="Zoom in"
          disabled={!zoomIn}
          onClick={() => zoomIn && onZoom(zoomIn.time, zoomIn.values)}
        >
          <ZoomIn size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={`Zoom out ${trace.label}`}
          title="Zoom out"
          aria-description="Zoom out"
          disabled={!zoomOut}
          onClick={() => zoomOut && onZoom(zoomOut.time, zoomOut.values)}
        >
          <ZoomOut size={14} aria-hidden="true" />
        </button>
        {controls}
      </div>
      <svg
        ref={svgRef}
        className={dragging ? 'is-cursor-dragging' : panPreview ? 'is-view-panning' : undefined}
        viewBox={`0 0 ${size.width} ${size.height}`}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && (zoom.current || pan.current)) {
            event.preventDefault();
            event.stopPropagation();
            const id = (zoom.current ?? pan.current)!.pointerId;
            finishDrag();
            if (event.currentTarget.hasPointerCapture(id))
              event.currentTarget.releasePointerCapture(id);
          }
        }}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={(event) => {
          if (!active || drag.current || zoom.current || pan.current) return;
          if (event.button === 2) {
            event.preventDefault();
            pan.current = {
              pointerId: event.pointerId,
              x: event.clientX,
              y: event.clientY,
              width: plot.right - plot.left,
              height: plot.bottom - plot.top,
              time: timeAxis,
              values: plot.axis,
            };
            setPanPreview({ time: timeAxis, values: plot.axis });
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            return;
          }
          if (event.button !== 0) return;
          event.preventDefault();
          const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
          const target = (event.target as Element).closest('[data-waveform-cursor]');
          if (zoomMode && !target) {
            const { x, y } = zoomPosition(event);
            zoom.current = { pointerId: event.pointerId, x0: x, y0: y, x1: x, y1: y };
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            return;
          }
          const which = target
            ? Number(target.getAttribute('data-waveform-cursor'))
            : nearestCursor(x);
          if (which === null || cursors[which] === null) return;
          drag.current = {
            which,
            offset: target ? x - plot.x(cursors[which]!) : 0,
            pointerId: event.pointerId,
          };
          cursorRefs.current[which]?.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          setDragging(true);
          moveCursor(event);
        }}
        onPointerMove={(event) => {
          if (pan.current?.pointerId === event.pointerId) {
            setPanPreview(panPosition(event));
            return;
          }
          if (zoom.current?.pointerId === event.pointerId) {
            const { x, y } = zoomPosition(event);
            zoom.current.x1 = x;
            zoom.current.y1 = y;
            const { x0, y0 } = zoom.current;
            setMarquee({
              x: Math.min(x0, x),
              y: Math.min(y0, y),
              width: Math.abs(x - x0),
              height: Math.abs(y - y0),
            });
            return;
          }
          if (event.currentTarget.hasPointerCapture(event.pointerId)) moveCursor(event);
        }}
        onPointerUp={(event) => {
          if (pan.current?.pointerId === event.pointerId) {
            if (Math.hypot(event.clientX - pan.current.x, event.clientY - pan.current.y) >= 3) {
              const next = panPosition(event);
              onZoom(next.time, next.values);
            }
            finishDrag();
            return;
          }
          if (zoom.current?.pointerId === event.pointerId) {
            const { x0, y0 } = zoom.current;
            const { x: x1, y: y1 } = zoomPosition(event);
            const horizontal = Math.abs(x1 - x0) >= 6,
              vertical = Math.abs(y1 - y0) >= 6;
            if (horizontal || vertical) {
              onZoom(
                horizontal
                  ? { min: plot.timeAt(Math.min(x0, x1)), max: plot.timeAt(Math.max(x0, x1)) }
                  : timeAxis,
                vertical
                  ? { min: plot.valueAt(Math.max(y0, y1)), max: plot.valueAt(Math.min(y0, y1)) }
                  : plot.axis,
              );
            } else {
              const which = nearestCursor(x1);
              if (which !== null) {
                drag.current = { which, offset: 0, pointerId: event.pointerId };
                cursorRefs.current[which]?.focus();
                moveCursor(event);
              }
            }
            finishDrag();
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
            return;
          }
          if (drag.current?.pointerId !== event.pointerId) return;
          finishDrag();
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={(event) => {
          if (
            drag.current?.pointerId === event.pointerId ||
            zoom.current?.pointerId === event.pointerId ||
            pan.current?.pointerId === event.pointerId
          )
            finishDrag();
        }}
        onLostPointerCapture={(event) => {
          if (
            drag.current?.pointerId === event.pointerId ||
            zoom.current?.pointerId === event.pointerId ||
            pan.current?.pointerId === event.pointerId
          )
            finishDrag();
        }}
        role="group"
        aria-label={`${trace.label} waveform`}
        data-time-min={timeAxis.min}
        data-time-max={timeAxis.max}
        data-value-min={plot.axis.min}
        data-value-max={plot.axis.max}
      >
        <defs>
          <clipPath id={clipId}>
            <rect
              x={plot.left}
              y={plot.top}
              width={plot.right - plot.left}
              height={plot.bottom - plot.top}
            />
          </clipPath>
        </defs>
        <g aria-hidden="true" pointerEvents="none" clipPath={`url(#${clipId})`}>
          {plot.minorTicks.map((value) => (
            <path
              key={`value:${value}`}
              className="simulation-grid simulation-grid-minor simulation-grid-value"
              d={`M${plot.left} ${plot.y(value)}H${plot.right}`}
            />
          ))}
          {plot.minorTimeTicks.map((time) => (
            <path
              key={`time:${time}`}
              className="simulation-grid simulation-grid-minor simulation-grid-time"
              d={`M${plot.timeX(time)} ${plot.top}V${plot.bottom}`}
            />
          ))}
        </g>
        {plot.minorTicks.map((value) => (
          <text
            key={`value-label:${value}`}
            className="simulation-tick-minor simulation-tick-value"
            x={plot.left - 10}
            y={plot.y(value) + 4}
            textAnchor="end"
          >
            {Number((value / plot.scale.factor).toPrecision(4))}
            {value === 0 ? '' : plot.scale.prefix}
          </text>
        ))}
        {plot.minorTimeTicks.map((time) => (
          <text
            key={`time-label:${time}`}
            className="simulation-tick-minor simulation-tick-time"
            x={plot.timeX(time)}
            y={size.height - 8}
            textAnchor="middle"
          >
            {Number((time / plot.timeScale.factor).toPrecision(4))}
          </text>
        ))}
        {plot.ticks.map((value, i) => (
          <g key={i}>
            <path
              className={
                Math.abs(value) < (plot.ticks[1] - plot.ticks[0]) * 1e-6
                  ? 'simulation-grid simulation-zero'
                  : 'simulation-grid'
              }
              d={`M${plot.left} ${plot.y(value)}H${plot.right}`}
            />
            <text x={plot.left - 10} y={plot.y(value) + 4} textAnchor="end">
              {Number((value / plot.scale.factor).toPrecision(4))}
              {value === 0 ? '' : plot.scale.prefix}
            </text>
          </g>
        ))}
        {plot.timeTicks.map((time, i) => {
          const x = plot.timeX(time);
          return (
            <g key={i}>
              <path className="simulation-grid" d={`M${x} ${plot.top}V${plot.bottom}`} />
              <text
                x={x}
                y={size.height - 8}
                textAnchor={i === 0 ? 'start' : i === plot.timeTicks.length - 1 ? 'end' : 'middle'}
              >
                {Number((time / plot.timeScale.factor).toPrecision(4))}
                {i === plot.timeTicks.length - 1 ? ` ${plot.timeScale.prefix}s` : ''}
              </text>
            </g>
          );
        })}
        <path className="simulation-trace" d={plot.path} clipPath={`url(#${clipId})`} />
        {cursors.map((cursor, which) => {
          if (cursor === null) return null;
          const valueWidth = valueSizes[which].width;
          const valueX = Math.max(
            valueWidth / 2 + 8,
            Math.min(size.width - valueWidth / 2 - 8, plot.x(cursor)),
          );
          const name = which === 0 ? 'A' : 'B';
          return (
            <g
              key={name}
              ref={(element) => {
                cursorRefs.current[which] = element;
              }}
              data-waveform-cursor={which}
              tabIndex={0}
              role="slider"
              aria-label={`${trace.label} cursor ${name}`}
              aria-valuemin={result.time[start]}
              aria-valuemax={result.time[end]}
              aria-valuenow={result.time[cursor]}
              aria-valuetext={`${measured(result.time[cursor], 's')}, ${measured(trace.values[cursor], trace.unit)}`}
              onKeyDown={(event) => {
                const next = {
                  ArrowLeft: cursor - 1,
                  ArrowDown: cursor - 1,
                  ArrowRight: cursor + 1,
                  ArrowUp: cursor + 1,
                  Home: start,
                  End: end,
                }[event.key];
                if (next === undefined) return;
                event.preventDefault();
                event.stopPropagation();
                onCursor(which, Math.max(start, Math.min(end, next)));
              }}
            >
              <path
                className={`simulation-cursor${which ? ' simulation-cursor-secondary' : ''}`}
                d={`M${plot.x(cursor)} ${plot.top}V${plot.bottom}`}
              />
              <circle
                className="simulation-point"
                clipPath={`url(#${clipId})`}
                cx={plot.x(cursor)}
                cy={plot.y(trace.values[cursor])}
                r="3.5"
              />
              <text
                ref={(element) => {
                  valueRefs.current[which] = element;
                }}
                className="simulation-cursor-value"
                aria-description={`t = ${measured(result.time[cursor], 's')} · Minimum ${measured(plot.min, trace.unit)} · Maximum ${measured(plot.max, trace.unit)}`}
                x={valueX}
                y={plot.top - 8}
                textAnchor="middle"
              >
                {measured(trace.values[cursor], trace.unit)}
              </text>
              <rect
                className="simulation-cursor-hit"
                x={plot.x(cursor) - 8}
                y={plot.top}
                width={16}
                height={plot.bottom - plot.top}
              />
            </g>
          );
        })}
        {marquee && <rect className="simulation-zoom-region" {...marquee} />}
        {(['time', 'value'] as const).map((axis) => (
          <g
            key={axis}
            role="button"
            tabIndex={0}
            aria-label={`${trace.label} ${axis === 'time' ? 'time' : 'vertical'} axis`}
            className="simulation-axis-control"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              openAxis(axis, event.currentTarget, event);
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              openAxis(axis, event.currentTarget, event);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                openAxis(axis, event.currentTarget);
              }
            }}
          >
            <rect
              x={axis === 'time' ? plot.left : 0}
              y={axis === 'time' ? plot.bottom + 3 : plot.top}
              width={axis === 'time' ? plot.right - plot.left : plot.left - 4}
              height={axis === 'time' ? size.height - plot.bottom - 3 : plot.bottom - plot.top}
            />
          </g>
        ))}
      </svg>
    </section>
  );
}

export default function SimulationWaveforms({
  visible,
  result,
  selected,
  onSelected,
  frequency,
  running,
  stopped = false,
  message,
  resultKey,
  duration,
  presentationRef,
  capabilityHost,
  capabilityAvailability,
}: {
  visible: boolean;
  result: SimulationResult | null;
  selected: string[];
  onSelected: (vectors: string[]) => void;
  frequency: number | null;
  running: boolean;
  stopped?: boolean;
  message: string;
  resultKey?: number;
  duration?: number;
  presentationRef?: RefObject<AgentWaveformPresentation | null>;
  capabilityHost?: CapabilityHost;
  capabilityAvailability?: () => boolean | string;
}) {
  const [localCapabilityHost] = useState(createCapabilityHost);
  const host = capabilityHost ?? localCapabilityHost;
  const capabilityAvailabilityRef = useRef(capabilityAvailability);
  capabilityAvailabilityRef.current = capabilityAvailability;
  const resultAvailableRef = useRef(!!result);
  resultAvailableRef.current = !!result;
  const applyPresentationRef = useRef<
    ((input: SimulationPresentationInput, signal: AbortSignal) => Promise<unknown>) | null
  >(null);
  const presentationWaiters = useRef<
    {
      resolve: (state: unknown) => void;
      reject: (failure: Error) => void;
      signal: AbortSignal;
      abort: () => void;
    }[]
  >([]);
  const [, refreshPresentation] = useState(0);
  const [histories, setHistories] = useState<Record<string, WaveformHistory>>({});
  const [zoomModes, setZoomModes] = useState<Record<string, boolean>>({});
  const [axisDialog, setAxisDialog] = useState<{
    vector: string | null;
    axis: WaveformAxis;
    unit: 's' | 'V' | 'A';
    title: string;
    origin: string;
    anchor: RefObject<HTMLElement | null>;
    point: { x: number; y: number };
  } | null>(null);
  function changeViewState(vector: string, next: WaveformView) {
    setHistories((previous) => ({
      ...previous,
      [vector]: changeWaveformView(previous[vector] ?? initialWaveformHistory(), next),
    }));
  }
  function navigateViewState(vector: string, direction: 'back' | 'forward') {
    setHistories((previous) => ({
      ...previous,
      [vector]: navigateWaveformView(previous[vector] ?? initialWaveformHistory(), direction),
    }));
  }
  useLayoutEffect(() => {
    setHistories({});
    setAxisDialog(null);
  }, [resultKey === undefined ? result : resultKey]);
  useLayoutEffect(() => {
    if (!visible || (axisDialog && !selected.includes(axisDialog.origin))) setAxisDialog(null);
  }, [visible, selected, axisDialog]);
  const [cursorState, setCursorState] = useState<{
    linked: boolean;
    shared: CursorPair;
    traces: Record<string, CursorPair>;
  }>({ linked: true, shared: [null, 0], traces: {} });
  const [visibleCursors, setVisibleCursors] = useState<[boolean, boolean]>([true, false]);
  const [layout, setLayout] = useState('auto');
  useLayoutEffect(() => {
    if (!presentationRef) return;
    const traces = presentationRef.current?.traces ?? {};
    for (const vector of Object.keys(traces)) if (!selected.includes(vector)) delete traces[vector];
    presentationRef.current = { layout, linked: cursorState.linked, visibleCursors, traces };
  });
  const [area, setArea] = useState({ width: 500, height: 200 });
  const plots = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = plots.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0)
        setArea((previous) =>
          previous.width === width && previous.height === height ? previous : { width, height },
        );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [result]);
  useLayoutEffect(() => {
    if (plots.current) {
      plots.current.scrollTop = 0;
      plots.current.scrollLeft = 0;
    }
  }, [selected, layout]);
  const cursorsFor = (vector: string) =>
    cursorState.linked ? cursorState.shared : (cursorState.traces[vector] ?? cursorState.shared);
  function moveTraceCursor(vector: string, which: number, index: number) {
    if (!result) return;
    const time = result.time[index];
    changePresentation({ cursor: { vector, which: which as 0 | 1, time } });
  }
  function moveCursorState(vector: string, which: number, time: number) {
    setCursorState((previous) => {
      const linked = previous.linked;
      const pair = linked ? previous.shared : (previous.traces[vector] ?? previous.shared);
      const next: CursorPair = which === 0 ? [time, pair[1]] : [pair[0], time];
      return {
        ...previous,
        // Relinking adopts the most recently adjusted pair, even while unlinked.
        shared: next,
        traces: linked ? previous.traces : { ...previous.traces, [vector]: next },
      };
    });
  }
  function setCursorLink(linked: boolean) {
    setCursorState((previous) => {
      return {
        ...previous,
        linked,
        // Freeze every trace at the shared pair before allowing independent moves.
        traces:
          previous.linked && !linked
            ? Object.fromEntries(
                (result?.traces ?? []).map((trace) => [trace.vector, previous.shared]),
              )
            : previous.traces,
      };
    });
  }
  function changePresentation(input: SimulationPresentationInput) {
    void host.execute('simulation.presentation', input, { actor: 'human' }).catch((failure) => {
      host.emit('simulation.presentation.failed', { message: (failure as Error).message });
    });
  }
  function changeView(vector: string, next: WaveformView) {
    changePresentation({
      view: { vector, range: next.range, time: next.time, values: next.values[vector] ?? null },
    });
  }
  function navigateView(vector: string, direction: 'back' | 'forward') {
    changePresentation({ navigate: { vector, direction } });
  }
  applyPresentationRef.current = async (input, signal) => {
    if (!result) throw new Error('Run a simulation before editing waveform presentation.');
    const chosen = [input.cursor?.vector, input.view?.vector, input.navigate?.vector].filter(
      (vector): vector is string => !!vector,
    );
    if (
      chosen.some(
        (vector) =>
          !selected.includes(vector) || !result.traces.some((trace) => trace.vector === vector),
      )
    )
      throw new Error('Choose a visible trace from the current simulation result.');
    if (
      input.view?.time &&
      (!validWaveformAxis(input.view.time) || !validWaveformTime(result.time, input.view.time))
    )
      throw new Error('Choose a time axis containing actual simulation samples.');
    if (input.view?.values && !validWaveformAxis(input.view.values))
      throw new Error('Choose an increasing finite value axis and valid tick spacing.');
    if (
      input.cursor &&
      (input.cursor.time < result.time[0] || input.cursor.time > result.time.at(-1)!)
    )
      throw new Error('Choose a cursor time within the simulation samples.');
    if (input.view && input.navigate)
      throw new Error('Change the waveform view or navigate history in one command.');
    if (input.layout) setLayout(input.layout);
    if (input.linked !== undefined) setCursorLink(input.linked);
    if (input.visibleCursors) setVisibleCursors(input.visibleCursors);
    if (input.cursor) moveCursorState(input.cursor.vector, input.cursor.which, input.cursor.time);
    if (input.view) {
      const { vector, time, values, range, zoomMode } = input.view;
      const current = histories[vector]?.present ?? initialWaveformView();
      const nextValues = { ...current.values };
      if (values === null) delete nextValues[vector];
      else if (values) nextValues[vector] = values;
      changeViewState(vector, {
        range: range ?? current.range,
        time: time === undefined ? current.time : time,
        values: nextValues,
      });
      if (zoomMode !== undefined) setZoomModes((previous) => ({ ...previous, [vector]: zoomMode }));
    }
    if (input.navigate) navigateViewState(input.navigate.vector, input.navigate.direction);
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('Waveform command cancelled.'));
        return;
      }
      const waiter = { resolve, reject, signal, abort: () => {} };
      waiter.abort = () => {
        presentationWaiters.current = presentationWaiters.current.filter(
          (entry) => entry !== waiter,
        );
        reject(new Error('Waveform command cancelled.'));
      };
      signal.addEventListener('abort', waiter.abort, { once: true });
      presentationWaiters.current.push(waiter);
      refreshPresentation((revision) => revision + 1);
    });
  };
  useLayoutEffect(
    () =>
      registerSimulationPresentationCapability(host, {
        available: () => {
          const availability = capabilityAvailabilityRef.current?.() ?? true;
          return availability === true && !resultAvailableRef.current
            ? 'Run a simulation before editing waveform presentation.'
            : availability;
        },
        apply: (input, signal) => applyPresentationRef.current!(input, signal),
      }),
    [host, capabilityHost],
  );
  useLayoutEffect(() => {
    host.emit('simulation.presentation.changed', {
      layout,
      linked: cursorState.linked,
      visibleCursors,
      selectedCount: selected.length,
    });
  }, [host, layout, cursorState, visibleCursors, histories, zoomModes, selected]);
  useLayoutEffect(() => {
    for (const waiter of presentationWaiters.current.splice(0)) {
      waiter.signal.removeEventListener('abort', waiter.abort);
      if (waiter.signal.aborted) waiter.reject(new Error('Waveform command cancelled.'));
      else
        waiter.resolve(
          presentationRef?.current ?? {
            layout,
            linked: cursorState.linked,
            visibleCursors,
            traces: {},
          },
        );
    }
  });
  useLayoutEffect(
    () => () => {
      for (const waiter of presentationWaiters.current.splice(0)) {
        waiter.signal.removeEventListener('abort', waiter.abort);
        waiter.reject(new Error('Waveforms closed.'));
      }
    },
    [],
  );
  const traces = selected.flatMap((vector) => {
    const trace = result?.traces.find((item) => item.vector === vector);
    return trace ? [trace] : [];
  });
  const rows = waveformRows(traces.length, layout, area.width, area.height);
  let offset = 0;
  return (
    <section className="simulation-dock" aria-label="Simulation waveforms" hidden={!visible}>
      <div className="simulation-dock-header">
        <strong>Waveform</strong>
        {(running || stopped) && (
          <span className="simulation-footer-status" role="status">
            {running ? 'Live · Running…' : result ? 'Stopped · Partial results' : 'Stopped'}
          </span>
        )}
        {result && (
          <div className="simulation-result-controls" role="group" aria-label="Waveform controls">
            <button
              type="button"
              className="icon-button simulation-cursor-toggle"
              aria-label={visibleCursors[1] ? 'Remove second cursor' : 'Add second cursor'}
              title={visibleCursors[1] ? 'Remove second cursor' : 'Add second cursor'}
              aria-pressed={visibleCursors[1]}
              onClick={() => changePresentation({ visibleCursors: [true, !visibleCursors[1]] })}
            >
              <SecondCursorIcon size={17} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-button simulation-link"
              aria-label="Link waveform cursors"
              title="Link cursors"
              aria-pressed={cursorState.linked}
              aria-description={
                cursorState.linked ? 'Unlink waveform cursors' : 'Link waveform cursors'
              }
              onClick={() => changePresentation({ linked: !cursorState.linked })}
            >
              {cursorState.linked ? (
                <Link2 size={17} aria-hidden="true" />
              ) : (
                <Unlink2 size={17} aria-hidden="true" />
              )}
            </button>
            <Select
              compact
              iconOnly
              showChevron={false}
              icon={<Plus size={17} aria-hidden="true" />}
              label="Add waveform"
              value=""
              disabled={result.traces.every((trace) => selected.includes(trace.vector))}
              options={[
                { value: '', label: 'Add waveform…' },
                ...result.traces
                  .filter((trace) => !selected.includes(trace.vector))
                  .map((trace) => ({ value: trace.vector, label: trace.label })),
              ]}
              onChange={(vector) => {
                if (vector) onSelected([vector, ...selected]);
              }}
            />
            {visible && (
              <WaveformLayoutPicker
                value={layout}
                onChange={(layout) => changePresentation({ layout })}
              />
            )}
          </div>
        )}
      </div>
      {message && (
        <p className="simulation-probe-status" role="status">
          {message}
        </p>
      )}
      {result && (
        <>
          <div
            className="simulation-plots"
            ref={plots}
            style={{ '--simulation-rows': Math.max(1, rows.length) } as CSSProperties}
          >
            {traces.length === 0 && (
              <p className="simulation-probe-status">
                Click a wire for voltage or a component for current.
              </p>
            )}
            {rows.map((columns, row) => {
              const items = traces.slice(offset, offset + columns);
              offset += columns;
              return (
                <div
                  className="simulation-plot-row"
                  key={row}
                  style={{ '--simulation-columns': columns } as CSSProperties}
                >
                  {items.map((trace) => {
                    const history = histories[trace.vector] ?? initialWaveformHistory();
                    const view = history.present;
                    const zoomMode = zoomModes[trace.vector] !== false;
                    const timeAxis = (view.time && validWaveformTime(result.time, view.time)
                      ? view.time
                      : null) ?? {
                      min:
                        view.range === 'tail'
                          ? Math.max(
                              result.time[0],
                              result.time.at(-1)! -
                                (frequency
                                  ? 10 / frequency
                                  : (result.time.at(-1)! - result.time[0]) * 0.1),
                            )
                          : result.time[0],
                      max:
                        (running || stopped) && view.range === 'full' && duration
                          ? duration
                          : result.time.at(-1)!,
                    };
                    return (
                      <div
                        className="simulation-plot"
                        key={trace.vector}
                        onKeyDown={(event) => {
                          if (
                            isCommandModifier(event) &&
                            ['z', 'y'].includes(event.key.toLowerCase())
                          ) {
                            event.preventDefault();
                            event.stopPropagation();
                            navigateView(
                              trace.vector,
                              event.shiftKey || event.key.toLowerCase() === 'y'
                                ? 'forward'
                                : 'back',
                            );
                          }
                        }}
                        style={
                          {
                            '--trace-color': `var(--waveform-${(result.traces.findIndex((item) => item.vector === trace.vector) % 4) + 1})`,
                          } as CSSProperties
                        }
                      >
                        <button
                          className="icon-button simulation-remove"
                          aria-label={`Remove ${trace.label}`}
                          title="Remove waveform"
                          onClick={() =>
                            onSelected(selected.filter((vector) => vector !== trace.vector))
                          }
                        >
                          <X size={14} />
                        </button>
                        <Waveform
                          controls={
                            <>
                              <button
                                type="button"
                                className="icon-button"
                                aria-label={`Zoom ${trace.label} region`}
                                title="Zoom region"
                                aria-description="Zoom region"
                                aria-pressed={zoomMode}
                                onClick={() =>
                                  changePresentation({
                                    view: { vector: trace.vector, zoomMode: !zoomMode },
                                  })
                                }
                              >
                                <SquareDashedMousePointer size={14} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                className="icon-button"
                                aria-label={`Previous ${trace.label} view`}
                                title="Previous view"
                                aria-description="Previous view"
                                disabled={!history.past.length}
                                onClick={() => navigateView(trace.vector, 'back')}
                              >
                                <Undo2 size={14} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                className="icon-button"
                                aria-label={`Next ${trace.label} view`}
                                title="Next view"
                                aria-description="Next view"
                                disabled={!history.future.length}
                                onClick={() => navigateView(trace.vector, 'forward')}
                              >
                                <Redo2 size={14} aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                className="icon-button"
                                aria-label={`Auto scale ${trace.label}`}
                                title="Auto scale"
                                aria-description="Auto scale"
                                onClick={() => changeView(trace.vector, initialWaveformView())}
                              >
                                <Maximize size={14} aria-hidden="true" />
                              </button>
                              <Select
                                compact
                                iconOnly
                                showChevron={false}
                                icon={<Timer size={14} aria-hidden="true" />}
                                label={`${trace.label} time range`}
                                hint="Time range"
                                value={view.time ? 'custom' : view.range}
                                options={[
                                  { value: 'full', label: 'Full duration' },
                                  {
                                    value: 'tail',
                                    label: frequency ? 'Last 10 cycles' : 'Last 10%',
                                  },
                                  ...(view.time
                                    ? [{ value: 'custom', label: 'Custom range' }]
                                    : []),
                                ]}
                                onChange={(range) => {
                                  if (range === 'full' || range === 'tail')
                                    changeView(trace.vector, { ...view, range, time: null });
                                }}
                              />
                            </>
                          }
                          result={result}
                          resultKey={resultKey}
                          trace={trace}
                          timeAxis={timeAxis}
                          valueAxis={view.values[trace.vector]}
                          zoomMode={zoomMode}
                          active={visible}
                          onZoom={(time, values) => {
                            const unchangedTime =
                              time.min === timeAxis.min && time.max === timeAxis.max;
                            if (
                              (unchangedTime || validWaveformTime(result.time, time)) &&
                              validWaveformAxis(values)
                            )
                              changeView(trace.vector, {
                                ...view,
                                time: unchangedTime ? view.time : time,
                                values: { ...view.values, [trace.vector]: values },
                              });
                          }}
                          onAxis={(axis, value, anchor, point) =>
                            setAxisDialog({
                              origin: trace.vector,
                              anchor,
                              point,
                              vector: axis === 'time' ? null : trace.vector,
                              axis: value,
                              unit: axis === 'time' ? 's' : trace.unit,
                              title:
                                axis === 'time'
                                  ? 'Time axis'
                                  : `${trace.label.split(' · ')[0]} axis`,
                            })
                          }
                          cursors={cursorsFor(trace.vector)}
                          visibleCursors={visibleCursors}
                          onCursor={(which, index) => moveTraceCursor(trace.vector, which, index)}
                          presentationRef={presentationRef}
                        />
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </>
      )}
      {axisDialog && result && visible && (
        <WaveformAxisDialog
          key={`${axisDialog.origin}:${axisDialog.vector ?? 'time'}`}
          anchorRef={axisDialog.anchor}
          anchorPoint={axisDialog.point}
          title={axisDialog.title}
          axis={axisDialog.axis}
          unit={axisDialog.unit}
          time={axisDialog.vector === null ? result.time : undefined}
          onClose={() => setAxisDialog(null)}
          onApply={(axis) => {
            const view = histories[axisDialog.origin]?.present ?? initialWaveformView();
            if (axisDialog.vector === null) changeView(axisDialog.origin, { ...view, time: axis });
            else {
              const values = { ...view.values };
              if (axis) values[axisDialog.vector] = axis;
              else delete values[axisDialog.vector];
              changeView(axisDialog.origin, { ...view, values });
            }
            setAxisDialog(null);
          }}
        />
      )}
    </section>
  );
}
