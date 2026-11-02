import { memo } from 'react';
import {
  resolvePCBGraphic,
  type PCB,
  type Footprint,
  type CopperLayer,
  type BoardLayer,
} from '@/lib/pcb';
import { padCopperLayers } from '@/lib/pcb-connectivity';
import { padPosition, padRotation } from '@/lib/pcb-layout';
import {
  pcbLayerColor,
  boardOutlineMinWidth,
  pcbPadLabels,
  pcbPadPaintLayer,
  pcbPadTypeLabel,
  type PCBDisplay,
} from '@/lib/pcb-display';
import { pcbPadPath } from '@/lib/pcb-geometry';
import PCBGraphic from './PCBGraphic';
import PCBSelectionPaint from './PCBSelectionPaint';
import { useLayoutSelection, type LayoutSelection } from './LayoutSelection';

const zoneOutlineWidth = 0.08;
const layerColor = pcbLayerColor;
const zonePath = (zone: PCB['zones'][number]) =>
  [zone.outline, ...(zone.holes ?? [])]
    .map((points) => `M ${points.map((point) => `${point.x} ${point.y}`).join(' L ')} Z`)
    .join(' ');

type CaptionProps = {
  footprint: Footprint;
  reference: string | undefined;
  value: string | undefined;
  layers: PCBDisplay;
  selection: LayoutSelection;
  placement: boolean;
  onlyLayer?: BoardLayer;
  excludedLayer?: BoardLayer;
};
type GraphicProps = CaptionProps & {
  copperLayers: PCB['layers'];
  padLayerOrder?: readonly BoardLayer[];
  deferDrills?: boolean;
  layer: CopperLayer;
  inspectedPadId: string;
  netNames: ReadonlyMap<string, string>;
  highlightNets: ReadonlySet<string>;
};

// Camera and tool changes retain unchanged footprint artwork and pad text.
export const LayoutFootprintGraphic = memo(function LayoutFootprintGraphic({
  copperLayers,
  footprint: f,
  reference,
  value,
  layers,
  selection,
  placement,
  layer,
  inspectedPadId,
  netNames,
  highlightNets,
  onlyLayer,
  excludedLayer,
  padLayerOrder,
  deferDrills = false,
}: GraphicProps) {
  const selected = useLayoutSelection(selection, f.id);
  const pcb = { layers: copperLayers };
  const visibleLayer = (name: string) =>
    Boolean(layers[name as BoardLayer]) &&
    (!onlyLayer || name === onlyLayer) &&
    name !== excludedLayer;
  const netOpacity = (netId: string | null, picked = false) =>
    !picked && highlightNets.size && (!netId || !highlightNets.has(netId)) ? 0.2 : 1;
  const graphics = f.graphics.filter((g) => visibleLayer(g.layer) && g.kind !== 'text');
  const zones = layers.zoneOutlines ? f.zones?.filter((z) => visibleLayer(z.layer)) : [];
  const pads = f.pads.filter((pad) => {
    const padLayers = pad.type === 'np_thru_hole' ? ['Edge.Cuts'] : padCopperLayers(pcb, f, pad);
    if (onlyLayer && padLayerOrder)
      return (
        pcbPadPaintLayer(padLayers, layers, padLayerOrder) === onlyLayer && visibleLayer(onlyLayer)
      );
    // A through pad spans several copper layers but paints only once, in the
    // active pass when it belongs there, otherwise in the ordinary pass.
    if (onlyLayer) return padLayers.includes(onlyLayer) && visibleLayer(onlyLayer);
    if (excludedLayer && layers[excludedLayer] && padLayers.includes(excludedLayer)) return false;
    return padLayers.some(visibleLayer);
  });
  if (!layers.footprints || (!graphics.length && !zones?.length && !pads.length)) return null;
  return (
    <g
      key={f.id}
      data-selection-id={f.id}
      className={`layout-footprint${selected ? ' selected' : ''}${placement ? ' is-placement' : ''}`}
    >
      <g transform={`translate(${f.x} ${f.y}) rotate(${-f.rotation})`}>
        {graphics.map((g) => (
          <PCBSelectionPaint key={g.id} color={layerColor(g.layer)} selected={selected}>
            {(color) => (
              <g data-footprint-graphic={g.id}>
                <PCBGraphic
                  graphic={resolvePCBGraphic(
                    g,
                    reference ?? f.reference ?? '',
                    value ?? f.value ?? '',
                  )}
                  color={color}
                  width={
                    g.layer === 'Edge.Cuts' ? Math.max(g.width, boardOutlineMinWidth) : g.width
                  }
                />
              </g>
            )}
          </PCBSelectionPaint>
        ))}
        {zones?.map((z) => (
          <PCBSelectionPaint key={z.id} color={layerColor(z.layer)} selected={selected}>
            {(color) => (
              <path
                data-pcb-zone-id={z.id}
                d={zonePath(z)}
                fill="none"
                fillRule="evenodd"
                stroke={color}
                strokeWidth={zoneOutlineWidth}
                strokeDasharray="0.5 0.35"
              />
            )}
          </PCBSelectionPaint>
        ))}
      </g>
      {pads.map((pad) => {
        const p = padPosition(f, pad);
        const padLayers = padCopperLayers(pcb, f, pad);
        const displayedLayer =
          padLayers.find((name) => name === layer && visibleLayer(name)) ??
          padLayers.find(visibleLayer);
        const padSelected = selected || inspectedPadId === pad.id;
        const fill =
          pad.type === 'np_thru_hole'
            ? 'var(--canvas)'
            : pad.type === 'thru_hole'
              ? 'var(--pcb-through)'
              : layerColor(displayedLayer ?? (f.side === 'front' ? 'F.Cu' : 'B.Cu'));
        const labels = pcbPadLabels(
          pad,
          padRotation(f, pad),
          pad.netId ? netNames.get(pad.netId) : undefined,
          layers,
        );
        return (
          <g
            key={pad.id}
            data-pad-id={pad.id}
            aria-label={`${reference ?? f.reference ?? f.libraryId} · ${pcbPadTypeLabel(pad.type)}${pad.number ? ` ${pad.number}` : ''} · ${pad.type === 'np_thru_hole' ? 'Mechanical' : pad.netId ? (netNames.get(pad.netId) ?? 'Unassigned') : 'Unassigned'}`}
            data-pad-type={pad.type}
            opacity={netOpacity(pad.netId, padSelected)}
            data-export-opacity={netOpacity(pad.netId)}
            data-net-id={pad.netId ?? undefined}
            transform={`translate(${p.x} ${p.y}) rotate(${-padRotation(f, pad)})`}
          >
            <PCBSelectionPaint color={fill} selected={padSelected && pad.type !== 'np_thru_hole'}>
              {(color) =>
                pad.shape === 'circle' ? (
                  <circle r={pad.size.x / 2} fill={color} />
                ) : pad.shape === 'roundrect' ? (
                  <path d={pcbPadPath(pad)} fill={color} />
                ) : (
                  <rect
                    x={-pad.size.x / 2}
                    y={-pad.size.y / 2}
                    width={pad.size.x}
                    height={pad.size.y}
                    rx={pad.shape === 'oval' ? Math.min(pad.size.x, pad.size.y) / 2 : 0}
                    fill={color}
                  />
                )
              }
            </PCBSelectionPaint>
            {pad.drill && !deferDrills && (
              <PCBSelectionPaint
                color="var(--pcb-outline)"
                selected={padSelected && pad.type === 'np_thru_hole'}
              >
                {(color) => (
                  <circle
                    cx={pad.drillOffset?.x ?? 0}
                    cy={pad.drillOffset?.y ?? 0}
                    r={pad.drill! / 2}
                    fill="var(--pcb-hole)"
                    stroke={pad.type === 'np_thru_hole' ? color : undefined}
                    strokeWidth={0.08}
                  />
                )}
              </PCBSelectionPaint>
            )}
            <g
              className="layout-pad-labels"
              transform={`rotate(${labels.rotation})`}
              aria-hidden="true"
            >
              {labels.lines.map((line) => (
                <text
                  key={line.kind}
                  data-pad-label={line.kind}
                  y={line.y}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={line.size}
                >
                  {line.text}
                </text>
              ))}
            </g>
          </g>
        );
      })}
    </g>
  );
});

/** Drill voids stay above physical artwork without becoming additional picking targets. */
export const LayoutFootprintDrills = memo(function LayoutFootprintDrills({
  copperLayers,
  footprint: f,
  layers,
  selection,
  placement,
  inspectedPadId,
  highlightNets,
}: Pick<
  GraphicProps,
  | 'copperLayers'
  | 'footprint'
  | 'layers'
  | 'selection'
  | 'placement'
  | 'inspectedPadId'
  | 'highlightNets'
>) {
  const selected = useLayoutSelection(selection, f.id);
  const pcb = { layers: copperLayers };
  const pads = f.pads.filter(
    (pad) =>
      pad.drill &&
      (pad.type === 'np_thru_hole'
        ? layers['Edge.Cuts']
        : padCopperLayers(pcb, f, pad).some((layer) => layers[layer as BoardLayer])),
  );
  if (!layers.footprints || !pads.length) return null;
  const netOpacity = (netId: string | null, picked = false) =>
    !picked && highlightNets.size && (!netId || !highlightNets.has(netId)) ? 0.2 : 1;
  return (
    <g data-footprint-drills={f.id} pointerEvents="none" opacity={placement ? 0.65 : undefined}>
      {pads.map((pad) => {
        const at = padPosition(f, pad);
        const padSelected = selected || inspectedPadId === pad.id;
        return (
          <g
            key={pad.id}
            opacity={netOpacity(pad.netId, padSelected)}
            data-export-opacity={netOpacity(pad.netId)}
            transform={`translate(${at.x} ${at.y}) rotate(${-padRotation(f, pad)})`}
          >
            <PCBSelectionPaint
              color="var(--pcb-outline)"
              selected={padSelected && pad.type === 'np_thru_hole'}
            >
              {(color, selection) => (
                <circle
                  data-pad-drill={selection ? undefined : pad.id}
                  cx={pad.drillOffset?.x ?? 0}
                  cy={pad.drillOffset?.y ?? 0}
                  r={pad.drill! / 2}
                  fill="var(--pcb-hole)"
                  stroke={pad.type === 'np_thru_hole' ? color : undefined}
                  strokeWidth={0.08}
                />
              )}
            </PCBSelectionPaint>
          </g>
        );
      })}
    </g>
  );
});

export const LayoutFootprintCaptions = memo(function LayoutFootprintCaptions({
  footprint: f,
  reference,
  value,
  layers,
  selection,
  placement,
  onlyLayer,
  excludedLayer,
}: CaptionProps) {
  const selected = useLayoutSelection(selection, f.id);
  const visibleLayer = (name: string) =>
    Boolean(layers[name as BoardLayer]) &&
    (!onlyLayer || name === onlyLayer) &&
    name !== excludedLayer;
  const graphics = f.graphics.filter((g) => g.kind === 'text' && visibleLayer(g.layer));
  const fallbackReference =
    visibleLayer(f.side === 'front' ? 'F.SilkS' : 'B.SilkS') &&
    !f.graphics.some((g) => g.text?.property === 'Reference');
  if (!layers.footprints || (!graphics.length && !fallbackReference)) return null;
  return (
    <g
      key={f.id}
      data-selection-id={f.id}
      data-footprint-captions={f.id}
      transform={`translate(${f.x} ${f.y}) rotate(${-f.rotation})`}
      pointerEvents={placement ? 'none' : undefined}
      opacity={placement ? 0.65 : undefined}
    >
      {graphics.map((g) => (
        <PCBSelectionPaint key={g.id} color={layerColor(g.layer)} selected={selected}>
          {(color) => (
            <PCBGraphic
              graphic={resolvePCBGraphic(g, reference ?? f.reference ?? '', value ?? f.value ?? '')}
              color={color}
              footprintRotation={f.rotation}
            />
          )}
        </PCBSelectionPaint>
      ))}
      {fallbackReference && (
        <PCBSelectionPaint
          color={layerColor(f.side === 'front' ? 'F.SilkS' : 'B.SilkS')}
          selected={selected}
        >
          {(color) => (
            <text
              data-pcb-layer={f.side === 'front' ? 'F.SilkS' : 'B.SilkS'}
              transform={`translate(0 -3.5) rotate(${f.rotation})`}
              textAnchor="middle"
              className="layout-reference"
              style={{ fill: color }}
              fontSize="1.2"
            >
              {reference ?? f.reference ?? ''}
            </text>
          )}
        </PCBSelectionPaint>
      )}
    </g>
  );
});
