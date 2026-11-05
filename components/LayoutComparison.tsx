'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Maximize, Minus, Plus } from 'lucide-react';
import { parseProject, type Project } from '@/lib/project';
import { defaultPCBDisplay, pcbDisplayLayers, pcbLayerPaintOrder } from '@/lib/pcb-display';
import {
  boardPolygons,
  filledCopperPolygons,
  polygonPath,
  worldZones,
  type Polygon,
} from '@/lib/pcb-polygons';
import {
  LayoutGraphicDrawing,
  LayoutTrackDrawing,
  LayoutViaDrawing,
  LayoutViaDrillDrawing,
  LayoutZoneFillDrawing,
  LayoutZoneOutlineDrawing,
} from './LayoutBoardDrawing';
import {
  LayoutFootprintCaptions,
  LayoutFootprintDrills,
  LayoutFootprintGraphic,
} from './LayoutFootprint';
import { createLayoutSelection } from './LayoutSelection';
import useCanvasBrightness from './useCanvasBrightness';

type View = { x: number; y: number; width: number; height: number };
const emptyView: View = { x: -5, y: -5, width: 90, height: 70 };

// These are the editor's artwork renderers, without edit tools or connectivity
// analysis. Saved copper is observed as-is; viewing never fills a zone.
const Drawing = memo(function Drawing({
  project,
  onNotice,
}: {
  project: Project;
  onNotice: (notice: string) => void;
}) {
  const board = project.pcb!;
  const [selection] = useState(createLayoutSelection);
  const [highlightNets] = useState<ReadonlySet<string>>(() => new Set());
  const drawing = useMemo(() => {
    const layers = defaultPCBDisplay();
    for (const layer of pcbDisplayLayers(board)) layers[layer] = true;
    const order = pcbLayerPaintOrder(pcbDisplayLayers(board));
    const netNames = new Map(board.nets.map((net) => [net.id, net.name]));
    const parts = new Map(project.schematic.parts.map((part) => [part.id, part]));
    const notices: string[] = [];
    let fills = new Map<string, Polygon[]>();
    try {
      fills = filledCopperPolygons(board);
    } catch (error) {
      notices.push(`Copper preview unavailable: ${(error as Error).message}`);
    }
    const zones = worldZones(board);
    let substrate = '';
    try {
      substrate = polygonPath(boardPolygons(board));
    } catch (error) {
      // Empty and open outlines are valid Layout documents. Their native
      // artwork remains viewable without inventing a closed board surface.
      if (
        board.graphics.some((graphic) => graphic.layer === 'Edge.Cuts') ||
        board.footprints.some((footprint) =>
          footprint.graphics.some((graphic) => graphic.layer === 'Edge.Cuts'),
        )
      )
        notices.push(`Board surface unavailable: ${(error as Error).message}`);
    }
    const caption = (footprint: (typeof board.footprints)[number]) => ({
      footprint,
      reference: parts.get(footprint.symbolId ?? '')?.ref,
      value: parts.get(footprint.symbolId ?? '')?.value,
      layers,
      selection,
      placement: false,
    });
    return {
      notice: notices.join(' '),
      artwork: (
        <>
          {substrate && <path d={substrate} fill="var(--pcb-substrate)" fillRule="evenodd" />}
          {order.map((layer) => (
            <g key={layer} data-pcb-layer={layer}>
              {zones
                .filter((zone) => zone.layer === layer)
                .map((zone) => (
                  <LayoutZoneFillDrawing
                    key={zone.id}
                    zoneId={zone.id}
                    layer={layer}
                    netId={zone.netId}
                    ownerId={zone.id}
                    path={polygonPath(fills.get(zone.id) ?? [])}
                    selection={selection}
                    highlightNets={highlightNets}
                  />
                ))}
              {board.zones
                .filter((zone) => zone.layer === layer)
                .map((zone) => (
                  <LayoutZoneOutlineDrawing
                    key={zone.id}
                    zoneId={zone.id}
                    layer={layer}
                    path={polygonPath([{ outer: zone.outline, holes: zone.holes ?? [] }])}
                    selection={selection}
                  />
                ))}
              {board.tracks
                .filter((track) => track.layer === layer)
                .map((track) => (
                  <LayoutTrackDrawing
                    key={track.id}
                    track={track}
                    netName={netNames.get(track.netId)}
                    selection={selection}
                    highlightNets={highlightNets}
                  />
                ))}
              {board.graphics
                .filter((graphic) => graphic.layer === layer)
                .map((graphic) => (
                  <LayoutGraphicDrawing key={graphic.id} graphic={graphic} selection={selection} />
                ))}
              {board.footprints.map((footprint) => (
                <LayoutFootprintGraphic
                  key={footprint.id}
                  {...caption(footprint)}
                  copperLayers={board.layers}
                  layer="F.Cu"
                  onlyLayer={layer}
                  padLayerOrder={order}
                  deferDrills
                  inspectedPadId=""
                  netNames={netNames}
                  highlightNets={highlightNets}
                />
              ))}
              {board.footprints.map((footprint) => (
                <LayoutFootprintCaptions
                  key={footprint.id}
                  {...caption(footprint)}
                  onlyLayer={layer}
                />
              ))}
            </g>
          ))}
          {board.vias.map((via) => (
            <LayoutViaDrawing
              key={via.id}
              via={via}
              netName={netNames.get(via.netId)}
              selection={selection}
              highlightNets={highlightNets}
              deferDrills
            />
          ))}
          {board.footprints.map((footprint) => (
            <LayoutFootprintDrills
              key={footprint.id}
              {...caption(footprint)}
              copperLayers={board.layers}
              inspectedPadId=""
              highlightNets={highlightNets}
            />
          ))}
          {board.vias.map((via) => (
            <LayoutViaDrillDrawing
              key={via.id}
              via={via}
              selection={selection}
              highlightNets={highlightNets}
            />
          ))}
        </>
      ),
    };
  }, [board, project.schematic, selection, highlightNets]);
  useEffect(() => onNotice(drawing.notice), [drawing.notice, onNotice]);
  return drawing.artwork;
});

export default function LayoutComparison({
  active,
  beforeSource,
  afterSource,
  beforeLabel,
  afterLabel,
}: {
  active: boolean;
  beforeSource: string;
  afterSource: string;
  beforeLabel: string;
  afterLabel: string;
}) {
  const [sources, setSources] = useState({ beforeSource, afterSource });
  if (active && (sources.beforeSource !== beforeSource || sources.afterSource !== afterSource))
    setSources({ beforeSource, afterSource });
  const before = useMemo(() => parseProject(sources.beforeSource), [sources.beforeSource]);
  const after = useMemo(() => parseProject(sources.afterSource), [sources.afterSource]);
  const surface = useRef<HTMLElement>(null);
  const dark = useCanvasBrightness(surface);
  const leftRef = useRef<SVGGElement>(null),
    rightRef = useRef<SVGGElement>(null);
  const [view, setView] = useState(emptyView);
  const [beforeNotice, setBeforeNotice] = useState('');
  const [afterNotice, setAfterNotice] = useState('');
  const initialView = useRef(view);
  const fitted = useRef<{ before: Project; after: Project } | null>(null);
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    scale: number;
    view: View;
    target: SVGSVGElement;
  } | null>(null);
  const cancelDrag = useCallback(() => {
    const current = drag.current;
    drag.current = null;
    if (current?.target.hasPointerCapture(current.id))
      current.target.releasePointerCapture(current.id);
  }, []);
  useEffect(() => {
    cancelDrag();
    if (!active || (fitted.current?.before === before && fitted.current.after === after)) return;
    const boxes = [leftRef.current, rightRef.current]
      .filter((group) => group?.childElementCount)
      .map((group) => group!.getBBox());
    let next = emptyView;
    if (boxes.length) {
      const x = Math.min(...boxes.map((box) => box.x)) - 5;
      const y = Math.min(...boxes.map((box) => box.y)) - 5;
      next = {
        x,
        y,
        width: Math.max(20, Math.max(...boxes.map((box) => box.x + box.width)) - x + 5),
        height: Math.max(20, Math.max(...boxes.map((box) => box.y + box.height)) - y + 5),
      };
    }
    initialView.current = next;
    fitted.current = { before, after };
    setView(next);
    return cancelDrag;
  }, [active, before, after, cancelDrag]);
  const zoom = useCallback(
    (factor: number) => {
      cancelDrag();
      setView((current) => {
        const ratio = (current.width / initialView.current.width) * factor;
        if (ratio < 0.02 || ratio > 20) return current;
        return {
          x: current.x + (current.width * (1 - factor)) / 2,
          y: current.y + (current.height * (1 - factor)) / 2,
          width: current.width * factor,
          height: current.height * factor,
        };
      });
    },
    [cancelDrag],
  );
  useEffect(() => {
    if (!active) return;
    const surfaces = [leftRef.current, rightRef.current]
      .map((group) => group?.ownerSVGElement)
      .filter((svg): svg is SVGSVGElement => Boolean(svg));
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (event.deltaY) zoom(event.deltaY < 0 ? 0.8 : 1.25);
    };
    const observer = new ResizeObserver(cancelDrag);
    for (const svg of surfaces) {
      svg.addEventListener('wheel', wheel, { passive: false });
      observer.observe(svg);
    }
    return () => {
      observer.disconnect();
      for (const svg of surfaces) svg.removeEventListener('wheel', wheel);
      cancelDrag();
    };
  }, [active, before, after, zoom, cancelDrag]);
  return (
    <section
      ref={surface}
      className="layout-comparison layout-editor"
      data-pcb-theme={dark ? 'dark' : 'light'}
      aria-label="Layout comparison"
    >
      <div className="schematic-compare-toolbar">
        <span className="history-preview-label">PCB layout · Read-only</span>
        <div className="compare-view-actions">
          <button
            className="tool-button"
            aria-label="Zoom out comparison"
            title="Zoom out"
            onClick={() => zoom(1.25)}
          >
            <Minus size={17} />
          </button>
          <button
            className="tool-button"
            aria-label="Zoom in comparison"
            title="Zoom in"
            onClick={() => zoom(0.8)}
          >
            <Plus size={17} />
          </button>
          <button
            className="tool-button"
            aria-label="Fit comparison"
            title="Fit view"
            onClick={() => {
              cancelDrag();
              setView(initialView.current);
            }}
          >
            <Maximize size={17} />
          </button>
        </div>
      </div>
      <div className="schematic-compare-panes">
        {(
          [
            {
              project: before,
              label: beforeLabel,
              side: 'Before',
              ref: leftRef,
              notice: beforeNotice,
              onNotice: setBeforeNotice,
            },
            {
              project: after,
              label: afterLabel,
              side: 'After',
              ref: rightRef,
              notice: afterNotice,
              onNotice: setAfterNotice,
            },
          ] as const
        ).map(({ project, label, side, ref, notice, onNotice }) => (
          <section key={side} className="schematic-compare-pane" aria-label={`${side} layout`}>
            <header>
              <span>{side}</span>
              <strong title={label}>{label}</strong>
            </header>
            {project.pcb && notice && (
              <p className="history-preview-notice" role="status">
                {notice}
              </p>
            )}
            {project.pcb ? (
              <svg
                role="img"
                tabIndex={0}
                aria-label={`${side}: ${label}`}
                viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key))
                    return;
                  event.preventDefault();
                  event.stopPropagation();
                  cancelDrag();
                  setView((current) => ({
                    ...current,
                    x:
                      current.x +
                      ((event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0) *
                        current.width) /
                        10,
                    y:
                      current.y +
                      ((event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0) *
                        current.height) /
                        10,
                  }));
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  const matrix = event.currentTarget.getScreenCTM();
                  if (!matrix) return;
                  event.currentTarget.focus({ preventScroll: true });
                  event.currentTarget.setPointerCapture(event.pointerId);
                  drag.current = {
                    id: event.pointerId,
                    x: event.clientX,
                    y: event.clientY,
                    view,
                    scale: matrix.a,
                    target: event.currentTarget,
                  };
                }}
                onPointerMove={(event) => {
                  const current = drag.current;
                  if (current && current.id === event.pointerId)
                    setView({
                      ...current.view,
                      x: current.view.x - (event.clientX - current.x) / current.scale,
                      y: current.view.y - (event.clientY - current.y) / current.scale,
                    });
                }}
                onPointerUp={cancelDrag}
                onPointerCancel={cancelDrag}
                onLostPointerCapture={cancelDrag}
              >
                <g ref={ref}>
                  <Drawing project={project} onNotice={onNotice} />
                </g>
              </svg>
            ) : (
              <div className="compare-sheet-missing">PCB layout not present in this version.</div>
            )}
          </section>
        ))}
      </div>
    </section>
  );
}
