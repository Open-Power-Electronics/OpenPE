'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ComparisonViewActions, useComparisonView } from './ComparisonView';
import { parseProject, type Project } from '@/lib/project';
import {
  defaultPCBDisplay,
  pcbDisplayLayers,
  pcbLayerColor,
  pcbLayerPaintOrder,
} from '@/lib/pcb-display';
import { pcbViaCopperLayers } from '@/lib/pcb-native-via';
import {
  boardPolygons,
  filledCopperPolygons,
  polygonPath,
  worldZones,
  pcbSavedZoneDisplayPath,
  pcbZoneOutlineDisplayPath,
  type Polygon,
} from '@/lib/pcb-polygons';
import {
  LayoutGraphicDrawing,
  LayoutArcTrackDrawing,
  LayoutTrackDrawing,
  LayoutTrackMaskDrawing,
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

const emptyView = { x: -5, y: -5, width: 90, height: 70 };

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
                .filter((zone) => zone.layer === layer && layer.endsWith('.Cu'))
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
              {zones
                .filter(
                  (zone) =>
                    zone.layer === layer &&
                    (layer === 'Edge.Cuts' || layer.endsWith('.Mask')) &&
                    zone.filledPolygons?.length,
                )
                .map((zone) => (
                  <path
                    key={zone.id}
                    d={pcbSavedZoneDisplayPath(zone)}
                    fill={pcbLayerColor(layer)}
                    fillRule="evenodd"
                  />
                ))}
              {board.zones
                .filter((zone) => zone.layer === layer)
                .map((zone) => (
                  <LayoutZoneOutlineDrawing
                    key={zone.id}
                    zoneId={zone.id}
                    layer={layer}
                    path={pcbZoneOutlineDisplayPath(zone)}
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
              {board.arcTracks
                ?.filter((track) => track.layer === layer)
                .map((track) => (
                  <LayoutArcTrackDrawing
                    key={track.id}
                    track={track}
                    netName={netNames.get(track.netId)}
                    highlightNets={highlightNets}
                  />
                ))}
              {(layer === 'F.Mask' || layer === 'B.Mask') &&
                [...board.tracks, ...(board.arcTracks ?? [])]
                  .filter((track) => track.maskLayer === layer)
                  .map((track) => <LayoutTrackMaskDrawing key={track.id} track={track} />)}
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
              copperLayers={pcbViaCopperLayers(board.layers, via)}
              paintLayer={via.span?.start}
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
              layer="F.Cu"
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
  const [beforeNotice, setBeforeNotice] = useState('');
  const [afterNotice, setAfterNotice] = useState('');
  const { leftRef, rightRef, svgProps, zoom, fit } = useComparisonView({
    active,
    before,
    after,
    initialView: emptyView,
    emptyView,
    padding: 5,
    focusOnPointerDown: true,
    stopArrowPropagation: true,
  });
  return (
    <section
      ref={surface}
      className="layout-comparison layout-editor"
      data-pcb-theme={dark ? 'dark' : 'light'}
      aria-label="Layout comparison"
    >
      <div className="schematic-compare-footer">
        <ComparisonViewActions zoom={zoom} fit={fit} />
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
          <section
            key={side}
            className="schematic-compare-pane"
            aria-label={`${side} layout`}
            aria-description={label}
          >
            {project.pcb && notice && (
              <p className="history-preview-notice" role="status">
                {notice}
              </p>
            )}
            {project.pcb ? (
              <svg role="img" tabIndex={0} aria-label={`${side}: ${label}`} {...svgProps}>
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
