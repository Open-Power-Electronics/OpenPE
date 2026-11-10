import { memo } from 'react';
import type { PCB, BoardLayer, BoardLine } from '@/lib/pcb';
import { boardOutlineMinWidth, pcbLayerColor, copperFillOpacity } from '@/lib/pcb-display';
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
      <PCBSelectionPaint color={pcbLayerColor(track.layer)} selected={selected}>
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

export const LayoutViaDrawing = memo(function LayoutViaDrawing({
  via,
  netName,
  selection,
  highlightNets,
  deferDrills = false,
}: Paint & {
  via: PCB['vias'][number];
  netName: string | undefined;
  deferDrills?: boolean;
}) {
  const selected = useLayoutSelection(selection, via.id);
  return (
    <g
      data-selection-id={via.id}
      aria-label={`Through via · ${netName ?? 'Unassigned'} · All copper layers`}
      data-via-type="through"
      data-net-id={via.netId}
      opacity={netOpacity(via.netId, highlightNets, selected)}
      data-export-opacity={netOpacity(via.netId, highlightNets)}
    >
      <circle
        cx={via.x}
        cy={via.y}
        data-layout-via-target={via.diameter / 2}
        r={via.diameter / 2}
        fill="transparent"
        aria-hidden="true"
      />
      <PCBSelectionPaint color="var(--pcb-through)" selected={selected}>
        {(color) => <circle cx={via.x} cy={via.y} r={via.diameter / 2} fill={color} />}
      </PCBSelectionPaint>
      {!deferDrills && <circle cx={via.x} cy={via.y} r={via.drill / 2} fill="var(--pcb-hole)" />}
    </g>
  );
});

export const LayoutViaDrillDrawing = memo(function LayoutViaDrillDrawing({
  via,
  selection,
  highlightNets,
}: Paint & { via: PCB['vias'][number] }) {
  const selected = useLayoutSelection(selection, via.id);
  return (
    <circle
      data-via-drill={via.id}
      cx={via.x}
      cy={via.y}
      r={via.drill / 2}
      fill="var(--pcb-hole)"
      pointerEvents="none"
      opacity={netOpacity(via.netId, highlightNets, selected)}
      data-export-opacity={netOpacity(via.netId, highlightNets)}
    />
  );
});

export const LayoutZoneFillDrawing = memo(function LayoutZoneFillDrawing({
  zoneId,
  layer,
  netId,
  ownerId,
  path,
  preview,
  selection,
  highlightNets,
}: Paint & {
  zoneId: string;
  layer: BoardLayer;
  netId: string | null;
  ownerId: string;
  path: string;
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
      <PCBSelectionPaint color={pcbLayerColor(layer, true)} selected={selected}>
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
  selection,
}: {
  zoneId: string;
  layer: BoardLayer;
  path: string;
  target?: string;
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
      <PCBSelectionPaint color={pcbLayerColor(layer)} selected={selected}>
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
        <PCBGraphic graphic={graphic} color="transparent" width={graphic.width} />
      </g>
      <PCBSelectionPaint color={pcbLayerColor(graphic.layer)} selected={selected}>
        {(color) => (
          <PCBGraphic
            graphic={graphic}
            color={color}
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
