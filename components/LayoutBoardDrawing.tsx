import { memo } from 'react';
import { pcbTrackMaskOpeningWidth, type PCB, type BoardLayer, type BoardLine } from '@/lib/pcb';
import type { Point } from '@/lib/circuit';
import { boardOutlineMinWidth, pcbLayerColor, copperFillOpacity } from '@/lib/pcb-display';
import { pcbGraphicPath } from '@/lib/pcb-geometry';
import { pcbViaDiameter } from '@/lib/pcb-padstack';
import { pcbViaOpeningDiameter } from '@/lib/pcb-native-via';
import PCBGraphic from './PCBGraphic';
import PCBSelectionPaint from './PCBSelectionPaint';
import { useLayoutSelection, type LayoutSelection } from './LayoutSelection';

type Paint = { selection: LayoutSelection; highlightNets: ReadonlySet<string> };
const netOpacity = (netId: string | null, highlightNets: ReadonlySet<string>, selected = false) =>
  !selected && highlightNets.size && (!netId || !highlightNets.has(netId)) ? 0.2 : 1;

export const LayoutTrackDrawing = memo(function LayoutTrackDrawing({
  track,
  netName,
  selection,
  highlightNets,
}: Paint & {
  track: PCB['tracks'][number];
  netName: string | undefined;
}) {
  const selected = useLayoutSelection(selection, track.id);
  return (
    <g
      data-selection-id={track.id}
      aria-label={`${netName ?? ''} · ${track.layer} · ${track.width} mm`}
      data-net-id={track.netId}
      opacity={netOpacity(track.netId, highlightNets, selected)}
      data-export-opacity={netOpacity(track.netId, highlightNets)}
    >
      <line
        x1={track.start.x}
        y1={track.start.y}
        x2={track.end.x}
        y2={track.end.y}
        stroke="transparent"
        data-layout-track-target={track.width}
        strokeWidth={track.width}
        aria-hidden="true"
      />
      <PCBSelectionPaint
        color={pcbLayerColor(track.layer)}
        selected={selected}
        locked={track.locked}
      >
        {(color) => (
          <line
            x1={track.start.x}
            y1={track.start.y}
            x2={track.end.x}
            y2={track.end.y}
            stroke={color}
            strokeWidth={track.width}
            strokeLinecap="round"
          />
        )}
      </PCBSelectionPaint>
    </g>
  );
});

export const LayoutArcTrackDrawing = memo(function LayoutArcTrackDrawing({
  track,
  netName,
  highlightNets,
}: Pick<Paint, 'highlightNets'> & {
  track: NonNullable<PCB['arcTracks']>[number];
  netName: string | undefined;
}) {
  const opacity = netOpacity(track.netId, highlightNets);
  return (
    <path
      data-layout-arc-track={track.id}
      aria-label={`Arc track · ${netName ?? ''} · ${track.layer}`}
      data-net-id={track.netId}
      data-export-opacity={opacity}
      opacity={opacity}
      d={pcbGraphicPath({ ...track, kind: 'arc' })}
      fill="none"
      stroke={pcbLayerColor(track.layer)}
      strokeWidth={track.width}
      strokeLinecap="round"
      pointerEvents="none"
    />
  );
});

export const LayoutTrackMaskDrawing = memo(function LayoutTrackMaskDrawing({
  track,
}: {
  track: PCB['tracks'][number] & { mid?: Point };
}) {
  const layer = track.maskLayer;
  const width = pcbTrackMaskOpeningWidth(track);
  if (!layer || width <= 0) return null;
  return (
    <path
      data-layout-track-mask={track.id}
      aria-label={`Track mask opening · ${layer}`}
      d={pcbGraphicPath({ ...track, kind: track.mid ? 'arc' : undefined })}
      fill="none"
      stroke={pcbLayerColor(layer)}
      strokeWidth={width}
      strokeLinecap="round"
      pointerEvents="none"
    />
  );
});

export const LayoutViaDrawing = memo(function LayoutViaDrawing({
  via,
  netName,
  copperLayers,
  paintLayer,
  selection,
  highlightNets,
  deferDrills = false,
}: Paint & {
  via: PCB['vias'][number];
  netName: string | undefined;
  copperLayers?: readonly PCB['layers'][number][];
  paintLayer?: PCB['layers'][number];
  deferDrills?: boolean;
}) {
  const selected = useLayoutSelection(selection, via.id);
  const kind = via.span?.kind ?? 'through';
  const title = `${kind[0].toUpperCase()}${kind.slice(1)} via`;
  const diameter = pcbViaDiameter(via, paintLayer);
  const hitRadius = Math.max(diameter, pcbViaOpeningDiameter(via)) / 2;
  return (
    <g
      data-selection-id={via.id}
      aria-label={`${title} · ${netName ?? 'Unassigned'} · ${via.span ? copperLayers?.join(', ') : 'All copper layers'}`}
      data-via-type={kind}
      data-via-layers={copperLayers?.join(' ')}
      data-net-id={via.netId}
      opacity={netOpacity(via.netId, highlightNets, selected)}
      data-export-opacity={netOpacity(via.netId, highlightNets)}
    >
      <circle
        cx={via.x}
        cy={via.y}
        data-layout-via-target={hitRadius}
        r={hitRadius}
        fill="transparent"
        aria-hidden="true"
      />
      {diameter > 0 && (
        <PCBSelectionPaint
          color={
            (via.span || via.padstack) && paintLayer
              ? pcbLayerColor(paintLayer)
              : 'var(--pcb-through)'
          }
          selected={selected}
          locked={via.locked}
        >
          {(color) => <circle cx={via.x} cy={via.y} r={diameter / 2} fill={color} />}
        </PCBSelectionPaint>
      )}
      {!deferDrills && (
        <>
          <circle cx={via.x} cy={via.y} r={via.drill / 2} fill="var(--pcb-hole)" />
          {via.backdrills && <ViaBackdrillIndicators via={via} />}
        </>
      )}
    </g>
  );
});

function ViaBackdrillIndicators({ via }: { via: PCB['vias'][number] }) {
  return Object.entries(via.backdrills ?? {}).map(([slot, drill]) => {
    const r = drill.diameter / 2;
    const half = (sweep: number) => `M${-r} 0 A${r} ${r} 0 0 ${sweep} ${r} 0`;
    return (
      <g
        key={slot}
        data-layout-via-backdrill={via.id}
        data-backdrill-slot={slot}
        data-backdrill-diameter={drill.diameter}
        data-backdrill-start={drill.start}
        data-backdrill-end={drill.end}
        transform={`translate(${via.x} ${via.y})`}
        fill="none"
        strokeWidth={Math.min(0.05, drill.diameter / 4)}
        pointerEvents="none"
        aria-hidden="true"
      >
        <path d={half(1)} stroke={pcbLayerColor(drill.start)} />
        <path d={half(0)} stroke={pcbLayerColor(drill.end)} />
      </g>
    );
  });
}

export const LayoutViaDrillDrawing = memo(function LayoutViaDrillDrawing({
  via,
  selection,
  highlightNets,
}: Paint & { via: PCB['vias'][number] }) {
  const selected = useLayoutSelection(selection, via.id);
  const opacity = netOpacity(via.netId, highlightNets, selected);
  const exportOpacity = netOpacity(via.netId, highlightNets);
  if (!via.backdrills) {
    return (
      <circle
        data-via-drill={via.id}
        cx={via.x}
        cy={via.y}
        r={via.drill / 2}
        fill="var(--pcb-hole)"
        pointerEvents="none"
        opacity={opacity}
        data-export-opacity={exportOpacity}
      />
    );
  }
  return (
    <g
      data-via-drill={via.id}
      pointerEvents="none"
      opacity={opacity}
      data-export-opacity={exportOpacity}
    >
      <circle cx={via.x} cy={via.y} r={via.drill / 2} fill="var(--pcb-hole)" />
      <ViaBackdrillIndicators via={via} />
    </g>
  );
});

export const LayoutZoneFillDrawing = memo(function LayoutZoneFillDrawing({
  zoneId,
  layer,
  netId,
  ownerId,
  path,
  preview,
  locked,
  selection,
  highlightNets,
}: Paint & {
  zoneId: string;
  layer: BoardLayer;
  netId: string | null;
  ownerId: string;
  path: string;
  locked?: boolean;
  preview?: {
    id: string;
    outline: string;
    boardOutline: string;
    blockers: { path: string; strokeWidth: number }[];
  };
}) {
  const selected = useLayoutSelection(selection, zoneId, ownerId);
  return (
    <g
      data-copper-fill={zoneId}
      data-selection-id={ownerId}
      opacity={copperFillOpacity * netOpacity(netId, highlightNets, selected)}
      data-export-opacity={copperFillOpacity * netOpacity(netId, highlightNets)}
    >
      {preview && (
        <defs>
          <clipPath id={`${preview.id}-board`}>
            <path d={preview.boardOutline} clipRule="evenodd" />
          </clipPath>
          <mask id={preview.id} maskContentUnits="userSpaceOnUse" style={{ maskType: 'luminance' }}>
            <path d={preview.outline} fill="white" fillRule="evenodd" />
            {preview.blockers.map((blocker, index) => (
              <path
                key={index}
                d={blocker.path}
                fill="black"
                fillRule="evenodd"
                stroke="black"
                strokeWidth={blocker.strokeWidth}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ))}
          </mask>
        </defs>
      )}
      <PCBSelectionPaint color={pcbLayerColor(layer, true)} selected={selected} locked={locked}>
        {(color, selection) => (
          <path
            data-copper-zone={selection ? undefined : zoneId}
            d={path}
            fill={color}
            fillRule="evenodd"
            mask={preview ? `url(#${preview.id})` : undefined}
            clipPath={preview ? `url(#${preview.id}-board)` : undefined}
          />
        )}
      </PCBSelectionPaint>
    </g>
  );
});

export const LayoutZoneOutlineDrawing = memo(function LayoutZoneOutlineDrawing({
  zoneId,
  layer,
  path,
  target,
  locked,
  selection,
}: {
  zoneId: string;
  layer: BoardLayer;
  path: string;
  target?: string;
  locked?: boolean;
  selection: LayoutSelection;
}) {
  const selected = useLayoutSelection(selection, zoneId);
  return (
    <g data-selection-id={zoneId}>
      {target && (
        <path
          d={target}
          fill="none"
          stroke="transparent"
          strokeWidth={0.08}
          strokeDasharray="0.5 0.35"
          data-export-exclude
        />
      )}
      <PCBSelectionPaint color={pcbLayerColor(layer)} selected={selected} locked={locked}>
        {(color) => (
          <path
            d={path}
            fillRule="evenodd"
            fill="none"
            stroke={color}
            strokeWidth={0.08}
            strokeDasharray="0.5 0.35"
            pointerEvents={target ? 'none' : undefined}
          />
        )}
      </PCBSelectionPaint>
    </g>
  );
});

export const LayoutGraphicDrawing = memo(function LayoutGraphicDrawing({
  graphic,
  selection,
}: {
  graphic: BoardLine;
  selection: LayoutSelection;
}) {
  const selected = useLayoutSelection(selection, graphic.id);
  return (
    <g data-selection-id={graphic.id}>
      <g data-layout-graphic-target={graphic.width} aria-hidden="true">
        <PCBGraphic graphic={graphic} color="transparent" width={graphic.width} nativeRenderCache />
      </g>
      <PCBSelectionPaint
        color={pcbLayerColor(graphic.layer)}
        selected={selected}
        locked={graphic.locked}
      >
        {(color) => (
          <PCBGraphic
            graphic={graphic}
            color={color}
            nativeRenderCache
            width={
              graphic.layer === 'Edge.Cuts'
                ? Math.max(graphic.width, boardOutlineMinWidth)
                : graphic.width
            }
          />
        )}
      </PCBSelectionPaint>
    </g>
  );
});
