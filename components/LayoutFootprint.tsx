import { PadDrillGraphic } from './PadDrillGraphic';
import { memo } from 'react';
import {
  resolvePCBGraphic,
  type PCB,
  type Footprint,
  type CopperLayer,
  type BoardLayer,
  type BoardLine,
} from '@/lib/pcb';
import { padHasElectricalPin } from '@/lib/pcb-pad-role';
import { pcbPadOnLayer } from '@/lib/pcb-padstack';
import { padCopperLayers } from '@/lib/pcb-connectivity';
import { padPosition, padRotation } from '@/lib/pcb-layout';
import {
  pcbLayerColor,
  boardOutlineMinWidth,
  pcbPadBodyLayers,
  pcbPadLabels,
  pcbPadPaintLayer,
  pcbPadSilkscreenDisplayLayers,
  pcbPadTypeLabel,
  type PCBDisplay,
} from '@/lib/pcb-display';
import { pcbPadPath } from '@/lib/pcb-geometry';
import { nativeCustomPadGraphics } from '@/lib/pcb-native-custom-pad';
import { pcbZoneOutlineDisplayPath } from '@/lib/pcb-polygons';
import PCBGraphic from './PCBGraphic';
import PCBSelectionPaint from './PCBSelectionPaint';
import { useLayoutSelection, type LayoutSelection } from './LayoutSelection';

const zoneOutlineWidth = 0.08;
const layerColor = pcbLayerColor;
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

const LayoutFootprintText = memo(function LayoutFootprintText({
  graphic,
  ownerId,
  rotation,
  selection,
  locked,
}: {
  graphic: BoardLine;
  ownerId: string;
  rotation: number;
  selection: LayoutSelection;
  locked?: boolean;
}) {
  const selected = useLayoutSelection(selection, graphic.id, ownerId);
  return (
    <g data-selection-id={graphic.id} data-footprint-text={graphic.id}>
      <PCBSelectionPaint
        color={layerColor(graphic.layer)}
        selected={selected}
        locked={locked || graphic.locked}
      >
        {(color) => <PCBGraphic graphic={graphic} color={color} footprintRotation={rotation} />}
      </PCBSelectionPaint>
    </g>
  );
});
type GraphicProps = CaptionProps & {
  copperLayers: PCB['layers'];
  padLayerOrder?: readonly BoardLayer[];
  deferDrills?: boolean;
  layer: CopperLayer;
  inspectedPadId: string;
  terminalPads?: ReadonlySet<string>;
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
  terminalPads,
  netNames,
  highlightNets,
  onlyLayer,
  excludedLayer,
  padLayerOrder,
  deferDrills = false,
}: GraphicProps) {
  const selected = useLayoutSelection(selection, f.id);
  if (!layers.footprints) return null;
  const pcb = { layers: copperLayers };
  const visibleLayer = (name: string) =>
    Boolean(layers[name as BoardLayer]) &&
    (!onlyLayer || name === onlyLayer) &&
    name !== excludedLayer;
  const netOpacity = (netId: string | null, picked = false) =>
    !picked && highlightNets.size && (!netId || !highlightNets.has(netId)) ? 0.2 : 1;
  const graphics = f.graphics.filter((g) => visibleLayer(g.layer) && g.kind !== 'text');
  const points = (f.referencePoints ?? []).filter((point) => visibleLayer(point.layer));
  const zones = layers.zoneOutlines
    ? f.zones?.filter((z) => z.outline.length && visibleLayer(z.layer))
    : [];
  const pads = [];
  for (const pad of f.pads) {
    for (const silkLayer of pcbPadSilkscreenDisplayLayers(pad))
      if (visibleLayer(silkLayer))
        pads.push({
          pad: pcbPadOnLayer(pad, silkLayer),
          displayedLayer: silkLayer,
          silkscreen: true,
        });
    const padLayers = pcbPadBodyLayers(pcb, f, pad);
    // A through pad spans several copper layers but paints only once, in the
    // active pass when it belongs there, otherwise in the ordinary pass.
    if (
      onlyLayer &&
      padLayerOrder &&
      pcbPadPaintLayer(padLayers, layers, padLayerOrder) !== onlyLayer
    )
      continue;
    if (!onlyLayer && excludedLayer && layers[excludedLayer] && padLayers.includes(excludedLayer))
      continue;
    const displayedLayer =
      padLayers.find((name) => name === layer && visibleLayer(name)) ??
      padLayers.find(visibleLayer);
    if (displayedLayer)
      pads.push({ pad: pcbPadOnLayer(pad, displayedLayer), displayedLayer, silkscreen: false });
  }
  if (!graphics.length && !points.length && !zones?.length && !pads.length) return null;
  return (
    <g
      key={f.id}
      data-selection-id={f.id}
      className={`layout-footprint${selected ? ' selected' : ''}${placement ? ' is-placement' : ''}`}
    >
      <g transform={`translate(${f.x} ${f.y}) rotate(${-f.rotation})`}>
        {points.map((point) => (
          <PCBGraphic
            key={point.id}
            graphic={{
              id: point.id,
              kind: 'point',
              start: point,
              end: point,
              width: point.size,
              layer: point.layer,
            }}
            color={layerColor(point.layer)}
          />
        ))}
        {graphics.map((g) => (
          <PCBSelectionPaint
            key={g.id}
            color={layerColor(g.layer)}
            selected={selected}
            locked={f.locked || g.locked}
          >
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
          <PCBSelectionPaint
            key={z.id}
            color={layerColor(z.layer)}
            selected={selected}
            locked={f.locked || z.locked}
          >
            {(color) => (
              <path
                data-pcb-zone-id={z.id}
                d={pcbZoneOutlineDisplayPath(z)}
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
      {pads.map(({ pad, displayedLayer, silkscreen }) => {
        const p = padPosition(f, pad);
        const padSelected =
          selected || inspectedPadId === pad.id || terminalPads?.has(pad.id) === true;
        const fill = silkscreen
          ? layerColor(displayedLayer)
          : pad.type === 'np_thru_hole'
            ? 'var(--canvas)'
            : pad.type === 'thru_hole'
              ? 'var(--pcb-through)'
              : layerColor(displayedLayer);
        const labels = silkscreen
          ? undefined
          : pcbPadLabels(
              pad,
              padRotation(f, pad),
              pad.netId ? netNames.get(pad.netId) : undefined,
              layers,
            );
        const pinLabel = padHasElectricalPin(pad)
          ? ` · ${netNames.get(pad.netId ?? '') ?? 'Unassigned'}`
          : '';
        return (
          <g
            key={`${pad.id}:${displayedLayer}`}
            data-pad-id={pad.id}
            data-pad-silkscreen={silkscreen ? displayedLayer : undefined}
            aria-label={`${reference ?? f.reference ?? f.libraryId} · ${pcbPadTypeLabel(pad)}${pad.number ? ` ${pad.number}` : ''}${pinLabel}`}
            data-pad-type={pad.type}
            opacity={netOpacity(pad.netId, padSelected)}
            data-export-opacity={netOpacity(pad.netId)}
            data-net-id={pad.netId ?? undefined}
            transform={`translate(${p.x} ${p.y}) rotate(${-padRotation(f, pad)})`}
          >
            <PCBSelectionPaint
              color={fill}
              selected={padSelected && pad.type !== 'np_thru_hole'}
              locked={pad.type !== 'np_thru_hole' && (f.locked || pad.locked)}
            >
              {(color) =>
                pad.nativeCustomPad ? (
                  <g>
                    {pad.customAnchor === 'circle' ? (
                      <circle
                        r={Math.floor(Math.round(pad.size.x * 1_000_000) / 2) / 1_000_000}
                        fill={color}
                      />
                    ) : (
                      <rect
                        x={-pad.size.x / 2}
                        y={-pad.size.y / 2}
                        width={pad.size.x}
                        height={pad.size.y}
                        fill={color}
                      />
                    )}
                    {nativeCustomPadGraphics(pad).map((graphic) => (
                      <PCBGraphic key={graphic.id} graphic={graphic} color={color} />
                    ))}
                  </g>
                ) : pad.shape === 'circle' ? (
                  <circle r={pad.size.x / 2} fill={color} />
                ) : pad.shape === 'roundrect' || pad.shape === 'trapezoid' || pad.outline ? (
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
            {pad.drill && !deferDrills && !silkscreen && (
              <PCBSelectionPaint
                color="var(--pcb-outline)"
                selected={padSelected && pad.type === 'np_thru_hole'}
                locked={pad.type === 'np_thru_hole' && (f.locked || pad.locked)}
              >
                {(color) => (
                  <PadDrillGraphic
                    pad={pad}
                    surface={
                      displayedLayer === 'F.Cu'
                        ? 'front'
                        : displayedLayer === 'B.Cu'
                          ? 'back'
                          : undefined
                    }
                    fill="var(--pcb-hole)"
                    stroke={pad.type === 'np_thru_hole' ? color : undefined}
                    strokeWidth={0.08}
                  />
                )}
              </PCBSelectionPaint>
            )}
            {labels && (
              <g
                className="layout-pad-labels"
                transform={`translate(${labels.origin.x} ${labels.origin.y}) rotate(${labels.rotation})`}
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
            )}
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
  layer,
  layers,
  selection,
  placement,
  inspectedPadId,
  terminalPads,
  highlightNets,
}: Pick<
  GraphicProps,
  | 'copperLayers'
  | 'footprint'
  | 'layer'
  | 'layers'
  | 'selection'
  | 'placement'
  | 'inspectedPadId'
  | 'terminalPads'
  | 'highlightNets'
>) {
  const selected = useLayoutSelection(selection, f.id);
  const pcb = { layers: copperLayers };
  const pads = f.pads.filter(
    (pad) =>
      pad.drill &&
      (pad.removeUnusedLayers ? padCopperLayers(pcb, f, pad) : pcbPadBodyLayers(pcb, f, pad)).some(
        (layer) => layers[layer],
      ),
  );
  if (!layers.footprints || !pads.length) return null;
  const netOpacity = (netId: string | null, picked = false) =>
    !picked && highlightNets.size && (!netId || !highlightNets.has(netId)) ? 0.2 : 1;
  return (
    <g data-footprint-drills={f.id} pointerEvents="none" opacity={placement ? 0.65 : undefined}>
      {pads.map((pad) => {
        const at = padPosition(f, pad);
        const padSelected =
          selected || inspectedPadId === pad.id || terminalPads?.has(pad.id) === true;
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
              locked={pad.type === 'np_thru_hole' && (f.locked || pad.locked)}
            >
              {(color, selection) => (
                <PadDrillGraphic
                  pad={pad}
                  surface={layer === 'F.Cu' ? 'front' : layer === 'B.Cu' ? 'back' : undefined}
                  data-pad-drill={selection ? undefined : pad.id}

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
      data-footprint-captions={f.id}
      transform={`translate(${f.x} ${f.y}) rotate(${-f.rotation})`}
      pointerEvents={placement ? 'none' : undefined}
      opacity={placement ? 0.65 : undefined}
    >
      {graphics.map((g) => (
        <LayoutFootprintText
          key={g.id}
          graphic={resolvePCBGraphic(g, reference ?? f.reference ?? '', value ?? f.value ?? '')}
          ownerId={f.id}
          rotation={f.rotation}
          locked={f.locked}
          selection={selection}
        />
      ))}
      {fallbackReference && (
        <PCBSelectionPaint
          color={layerColor(f.side === 'front' ? 'F.SilkS' : 'B.SilkS')}
          selected={selected}
          locked={f.locked}
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
