import { useMemo, type ReactNode } from 'react';
import { CircuitBoard } from 'lucide-react';
import PropertiesEmptyState from './PropertiesEmptyState';
import type { Circuit } from '@/lib/circuit';
import { isOwnedProjectNode } from '@/lib/immutable-project';
import type { PCB, Pad, Footprint, BoardLayer } from '@/lib/pcb';
import { flipPCBFootprint, padPosition, type PCBBounds } from '@/lib/pcb-layout';
import { padCopperLayers } from '@/lib/pcb-connectivity';
import { pcbPadShapeLabel, pcbPadTypeLabel } from '@/lib/pcb-display';
import { setPCBPadProperties, setPCBTrackEndpoints } from '@/lib/pcb-properties';
import type { PCBRectangle } from '@/lib/pcb-outline-resize';
import type { CapabilityHost } from '@/api/capabilities';
import type { FootprintDetail } from './LibraryChooser';
import PartIdentity from './PartIdentity';
import FootprintIdentity from './FootprintIdentity';
import PartProperties from './PartProperties';
import { PropertySelect as Select } from './LayoutPropertyFields';
import LayoutGraphicProperties from './LayoutGraphicProperties';
import {
  NumberField,
  OptionalNumberField,
  TextField,
  PropertyRow,
  PropertySection,
  PropertyGrid,
  PropertyToggle,
  PropertyVertices,
} from './LayoutPropertyFields';

type Props = {
  actions?: ReactNode;
  board: PCB;
  schematic: Circuit;
  active: boolean;
  resetKey: boolean;
  footprint?: Footprint;
  track?: PCB['tracks'][number];
  via?: PCB['vias'][number];
  graphic?: PCB['graphics'][number];
  zone?: PCB['zones'][number];
  pad?: Pad;
  padOwner?: Footprint;
  rectangle: PCBRectangle | null;
  selectionCount: number;
  showEmptyState?: boolean;
  snap: (value: number) => number;
  onCommit: (board: PCB) => boolean;
  onFootprint: (footprint: Footprint) => boolean;
  capabilityHost?: CapabilityHost;
  onRequestSave?: (saveAs: boolean) => void;
  onSavePartProperties?: (
    schematicBasis: Circuit,
    partId: string,
    ref: string,
    value: string,
    fields: Record<string, string>,
    footprintDetail?: FootprintDetail,
  ) => boolean;
  onTrack: (changes: {
    netId?: string;
    layer?: PCB['layers'][number];
    width?: number;
    locked?: boolean;
  }) => boolean;
  onZone: (zone: PCB['zones'][number]) => boolean;
  onRectangle: (bounds: PCBBounds) => boolean;
  onError: (message: string) => void;
  onInspectFootprint: (id: string) => void;
};

/** Native object properties share the same retained field controls and transaction port. */
export default function LayoutProperties({
  board,
  schematic,
  active,
  resetKey,
  footprint,
  track,
  via,
  graphic,
  zone,
  pad,
  padOwner,
  rectangle,
  selectionCount,
  showEmptyState = true,
  snap,
  onCommit,
  onFootprint,
  capabilityHost,
  onRequestSave,
  onSavePartProperties,
  onTrack,
  onZone,
  onRectangle,
  onError,
  onInspectFootprint,
  actions,
}: Props) {
  const field = { active, resetKey };
  const ownedNets = isOwnedProjectNode(board.nets) ? board.nets : null;
  const ownedLayers = isOwnedProjectNode(board.layers) ? board.layers : null;
  const retainedNetOptions = useMemo(
    () => ownedNets?.map((net) => ({ value: net.id, label: net.name })),
    [ownedNets],
  );
  const retainedLayerOptions = useMemo(
    () => ownedLayers?.map((value) => ({ value, label: value })),
    [ownedLayers],
  );
  // Caller data, including caller-frozen arrays, is prepared on every render.
  const netOptions =
    retainedNetOptions ?? board.nets.map((net) => ({ value: net.id, label: net.name }));
  const layerOptions =
    retainedLayerOptions ?? board.layers.map((value) => ({ value, label: value }));
  const netName = (id: string | null) =>
    board.nets.find((net) => net.id === id)?.name ?? 'Unconnected';
  const symbolId = footprint?.symbolId;
  const part = symbolId ? schematic.parts.find((part) => part.id === symbolId) : undefined;
  const attempt = (create: () => PCB) => {
    try {
      return onCommit(create());
    } catch (error) {
      onError((error as Error).message);
      return false;
    }
  };
  const padChange = (changes: Parameters<typeof setPCBPadProperties>[2]) =>
    pad ? attempt(() => setPCBPadProperties(board, pad.id, changes)) : false;
  const viaChange = (changes: Partial<PCB['vias'][number]>) =>
    via
      ? onCommit({
          ...board,
          vias: board.vias.map((item) => (item.id === via.id ? { ...item, ...changes } : item)),
        })
      : false;
  const endpoint = (end: 'start' | 'end', axis: 'x' | 'y', value: number) =>
    track
      ? attempt(() =>
          setPCBTrackEndpoints(board, track.id, { [end]: { ...track[end], [axis]: value } }),
        )
      : false;
  const graphicLayers: BoardLayer[] = [
    ...board.layers,
    'F.SilkS',
    'B.SilkS',
    'F.Fab',
    'B.Fab',
    'F.CrtYd',
    'B.CrtYd',
    'F.Mask',
    'B.Mask',
    'F.Paste',
    'B.Paste',
    'F.Adhes',
    'B.Adhes',
    'Edge.Cuts',
    'Dwgs.User',
    'Cmts.User',
    'Eco1.User',
    'Eco2.User',
    'Margin',
    'User.1',
    'User.2',
    'User.3',
    'User.4',
  ];
  return (
    <>
      {pad && padOwner ? (
        <>
          <PropertySection title="Pad">
            <PropertyRow
              label="Footprint"
              value={
                schematic.parts.find((part) => part.id === padOwner.symbolId)?.ref ??
                padOwner.reference ??
                padOwner.libraryId
              }
            />
            <PropertyRow label="Pad number" value={pad.number || '—'} />
            <PropertyRow label="Type" value={pcbPadTypeLabel(pad.type)} />
            <PropertyRow
              label="Net"
              value={netName(pad.netId)}
              description="Pad nets follow the schematic pin connections."
            />
            <PropertyRow
              label="Copper layers"
              value={padCopperLayers(board, padOwner, pad).join(', ') || 'None'}
            />
            <button
              className="secondary layout-owner-action"
              onClick={() => onInspectFootprint(padOwner.id)}
              disabled={!active}
            >
              Footprint properties
            </button>
          </PropertySection>
          <PropertySection title="Geometry">
            <PropertyRow
              label="Board position (mm)"
              value={`${Number(padPosition(padOwner, pad).x.toFixed(4))} / ${Number(padPosition(padOwner, pad).y.toFixed(4))}`}
            />
            <PropertyGrid columns={3}>
              <NumberField
                {...field}
                label="Pad X (mm)"
                value={pad.x}
                onCommit={(x) => padChange({ x })}
              />
              <NumberField
                {...field}
                label="Pad Y (mm)"
                value={pad.y}
                onCommit={(y) => padChange({ y })}
              />
              <NumberField
                {...field}
                label="Pad rotation (°)"
                value={pad.rotation}
                min={-360}
                max={360}
                onCommit={(rotation) => padChange({ rotation })}
              />
            </PropertyGrid>
            <Select
              active={active}
              label="Pad shape"
              value={pad.shape}
              options={(['rect', 'circle', 'oval', 'roundrect'] as const).map((value) => ({
                value,
                label: pcbPadShapeLabel(value),
              }))}
              onChange={(shape) => padChange({ shape: shape as Pad['shape'] })}
            />
            <PropertyGrid>
              <NumberField
                {...field}
                label="Pad width (mm)"
                value={pad.size.x}
                min={0.0001}
                max={1000}
                onCommit={(x) => padChange({ size: { ...pad.size, x } })}
              />
              {pad.shape !== 'circle' && (
                <NumberField
                  {...field}
                  label="Pad height (mm)"
                  value={pad.size.y}
                  min={0.0001}
                  max={1000}
                  onCommit={(y) => padChange({ size: { ...pad.size, y } })}
                />
              )}
            </PropertyGrid>
            {pad.shape === 'roundrect' && (
              <>
                <NumberField
                  {...field}
                  label="Corner radius ratio"
                  value={pad.roundrectRatio ?? 0.25}
                  min={0}
                  max={0.5}
                  onCommit={(roundrectRatio) => padChange({ roundrectRatio })}
                />
                <OptionalNumberField
                  {...field}
                  label="Chamfer ratio"
                  value={pad.chamferRatio}
                  min={0}
                  max={0.5}
                  onCommit={(chamferRatio) => padChange({ chamferRatio })}
                />
                {(['top_left', 'top_right', 'bottom_left', 'bottom_right'] as const).map(
                  (corner) => (
                    <PropertyToggle
                      key={corner}
                      active={active}
                      label={`Chamfer ${corner.replace('_', ' ')}`}
                      checked={pad.chamfer?.includes(corner) ?? false}
                      onChange={(checked) => {
                        const chamfer = checked
                          ? [...(pad.chamfer ?? []), corner]
                          : (pad.chamfer ?? []).filter((value) => value !== corner);
                        padChange({ chamfer: chamfer.length ? chamfer : undefined });
                      }}
                    />
                  ),
                )}
              </>
            )}
            {pad.type !== 'smd' && (
              <>
                <NumberField
                  {...field}
                  label="Pad drill (mm)"
                  value={pad.drill!}
                  min={0.0001}
                  max={pad.type === 'thru_hole' ? Math.min(pad.size.x, pad.size.y) - 0.0001 : 1000}
                  onCommit={(drill) => padChange({ drill })}
                />
                <PropertyGrid>
                  <NumberField
                    {...field}
                    label="Drill offset X (mm)"
                    value={pad.drillOffset?.x ?? 0}
                    onCommit={(x) => padChange({ drillOffset: { x, y: pad.drillOffset?.y ?? 0 } })}
                  />
                  <NumberField
                    {...field}
                    label="Drill offset Y (mm)"
                    value={pad.drillOffset?.y ?? 0}
                    onCommit={(y) => padChange({ drillOffset: { x: pad.drillOffset?.x ?? 0, y } })}
                  />
                </PropertyGrid>
              </>
            )}
          </PropertySection>
          <PropertySection title="Fabrication">
            <OptionalNumberField
              {...field}
              label="Solder mask margin (mm)"
              value={pad.solderMaskMargin}
              onCommit={(solderMaskMargin) => padChange({ solderMaskMargin })}
            />
            <OptionalNumberField
              {...field}
              label="Solder paste margin (mm)"
              value={pad.solderPasteMargin}
              onCommit={(solderPasteMargin) => padChange({ solderPasteMargin })}
            />
            <OptionalNumberField
              {...field}
              label="Solder paste ratio"
              value={pad.solderPasteMarginRatio}
              min={-1}
              max={1}
              onCommit={(solderPasteMarginRatio) => padChange({ solderPasteMarginRatio })}
            />
            <Select
              active={active}
              label="Pad zone connection"
              value={pad.zoneConnect === undefined ? '' : String(pad.zoneConnect)}
              options={[
                { value: '', label: 'Inherit' },
                { value: '0', label: 'None' },
                { value: '1', label: 'Thermal relief' },
                { value: '2', label: 'Solid' },
                { value: '3', label: 'Thermal relief for through-hole' },
              ]}
              onChange={(value) =>
                padChange({ zoneConnect: value === '' ? undefined : Number(value) })
              }
            />
            <OptionalNumberField
              {...field}
              label="Thermal bridge angle (°)"
              value={pad.thermalBridgeAngle}
              min={-360}
              max={360}
              onCommit={(thermalBridgeAngle) => padChange({ thermalBridgeAngle })}
            />
            {pad.type === 'thru_hole' && (
              <Select
                active={active}
                label="Unused copper layers"
                value={pad.removeUnusedLayers === undefined ? '' : String(pad.removeUnusedLayers)}
                options={[
                  { value: '', label: 'Inherit' },
                  { value: 'false', label: 'Keep' },
                  { value: 'true', label: 'Remove' },
                ]}
                onChange={(value) =>
                  padChange({ removeUnusedLayers: value === '' ? undefined : value === 'true' })
                }
              />
            )}
          </PropertySection>
        </>
      ) : (
        <>
          {footprint && (
            <>
              {part ? (
                <>
                  <PartIdentity
                    part={part}
                    library={schematic.libraries[part.libId]}
                    actions={actions}
                  />
                  <PartProperties
                    part={part}
                    active={active && !!onSavePartProperties}
                    capabilityHost={capabilityHost}
                    onRequestSave={onRequestSave}
                    onSave={(ref, value, fields, footprintDetail) =>
                      onSavePartProperties?.(
                        schematic,
                        part.id,
                        ref,
                        value,
                        fields,
                        footprintDetail,
                      ) ?? false
                    }
                  />
                </>
              ) : (
                <>
                  <FootprintIdentity footprint={footprint} actions={actions} />
                  <div className="layout-property-section">
                    <div className="property-primary layout-property-primary">
                      <TextField
                        {...field}
                        label="Reference"
                        value={footprint.reference ?? ''}
                        onCommit={(reference) => onFootprint({ ...footprint, reference })}
                      />
                      <TextField
                        {...field}
                        label="Value"
                        value={footprint.value ?? ''}
                        onCommit={(value) => onFootprint({ ...footprint, value })}
                      />
                    </div>
                    <PropertyRow
                      label="Library"
                      value={footprint.libraryId}
                      description={footprint.libraryId}
                    />
                  </div>
                </>
              )}
              <div className="layout-footprint-geometry component-geometry">
                <PropertyGrid columns={3}>
                  <NumberField
                    {...field}
                    label="X (mm)"
                    value={footprint.x}
                    normalize={snap}
                    onCommit={(x) => onFootprint({ ...footprint, x })}
                  />
                  <NumberField
                    {...field}
                    label="Y (mm)"
                    value={footprint.y}
                    normalize={snap}
                    onCommit={(y) => onFootprint({ ...footprint, y })}
                  />
                  <NumberField
                    {...field}
                    label="Rotation (°)"
                    value={footprint.rotation}
                    min={-360}
                    max={360}
                    onCommit={(rotation) => onFootprint({ ...footprint, rotation })}
                  />
                </PropertyGrid>
                <Select
                  active={active}
                  label="Footprint side"
                  value={footprint.side}
                  options={[
                    { value: 'front', label: 'Front' },
                    { value: 'back', label: 'Back' },
                  ]}
                  onChange={(side) =>
                    side === footprint.side || onFootprint(flipPCBFootprint(footprint))
                  }
                />
              </div>
            </>
          )}
          {track && (
            <>
              <PropertySection title="Track">
                <PropertyToggle
                  label="Locked track"
                  active={active}
                  checked={Boolean(track.locked)}
                  onChange={(locked) => onTrack({ locked })}
                />
                <Select
                  active={active}
                  label="Track net"
                  disabled={track.locked}
                  value={track.netId}
                  options={netOptions}
                  onChange={(netId) => onTrack({ netId })}
                />
                <Select
                  active={active}
                  label="Track layer"
                  disabled={track.locked}
                  value={track.layer}
                  options={layerOptions}
                  onChange={(layer) => onTrack({ layer: layer as PCB['layers'][number] })}
                />
              </PropertySection>
              <PropertySection title="Geometry">
                {(['start', 'end'] as const).map((end) => (
                  <PropertyGrid key={end}>
                    {(['x', 'y'] as const).map((axis) => (
                      <NumberField
                        {...field}
                        key={`${end}-${axis}`}
                        disabled={track.locked}
                        label={`${end === 'start' ? 'Start' : 'End'} ${axis.toUpperCase()} (mm)`}
                        value={track[end][axis]}
                        normalize={snap}
                        onCommit={(value) => endpoint(end, axis, value)}
                      />
                    ))}
                  </PropertyGrid>
                ))}
                <NumberField
                  {...field}
                  label="Width (mm)"
                  disabled={track.locked}
                  value={track.width}
                  min={0.0001}
                  max={1000}
                  onCommit={(width) => onTrack({ width })}
                />
                <PropertyRow
                  label="Length (mm)"
                  value={Number(
                    Math.hypot(track.end.x - track.start.x, track.end.y - track.start.y).toFixed(4),
                  )}
                />
              </PropertySection>
            </>
          )}
          {via && (
            <>
              <PropertySection title="Via">
                <PropertyRow label="Type" value="Through via" />
                <PropertyRow label="Copper layers" value={board.layers.join(', ')} />
                <Select
                  active={active}
                  label="Via net"
                  value={via.netId}
                  options={netOptions}
                  onChange={(netId) => viaChange({ netId })}
                />
              </PropertySection>
              <PropertySection title="Geometry">
                <PropertyGrid>
                  <NumberField
                    {...field}
                    label="X (mm)"
                    value={via.x}
                    normalize={snap}
                    onCommit={(x) => viaChange({ x })}
                  />
                  <NumberField
                    {...field}
                    label="Y (mm)"
                    value={via.y}
                    normalize={snap}
                    onCommit={(y) => viaChange({ y })}
                  />
                </PropertyGrid>
                <PropertyGrid>
                  <NumberField
                    {...field}
                    label="Diameter (mm)"
                    value={via.diameter}
                    min={via.drill + 0.0001}
                    max={1000}
                    onCommit={(diameter) => viaChange({ diameter })}
                  />
                  <NumberField
                    {...field}
                    label="Drill (mm)"
                    value={via.drill}
                    min={0.0001}
                    max={via.diameter - 0.0001}
                    onCommit={(drill) => viaChange({ drill })}
                  />
                </PropertyGrid>
              </PropertySection>
            </>
          )}
          {rectangle && (
            <PropertySection title={rectangle.zoneId ? 'Zone bounds' : 'Board outline'}>
              <PropertyGrid>
                <NumberField
                  {...field}
                  label="X (mm)"
                  value={rectangle.bounds.minX}
                  normalize={snap}
                  onCommit={(x) =>
                    onRectangle({
                      ...rectangle.bounds,
                      minX: x,
                      maxX: x + rectangle.bounds.maxX - rectangle.bounds.minX,
                    })
                  }
                />
                <NumberField
                  {...field}
                  label="Y (mm)"
                  value={rectangle.bounds.minY}
                  normalize={snap}
                  onCommit={(y) =>
                    onRectangle({
                      ...rectangle.bounds,
                      minY: y,
                      maxY: y + rectangle.bounds.maxY - rectangle.bounds.minY,
                    })
                  }
                />
              </PropertyGrid>
              <PropertyGrid>
                <NumberField
                  {...field}
                  label="Width (mm)"
                  value={rectangle.bounds.maxX - rectangle.bounds.minX}
                  min={0.001}
                  max={200000}
                  onCommit={(width) =>
                    onRectangle({ ...rectangle.bounds, maxX: rectangle.bounds.minX + width })
                  }
                />
                <NumberField
                  {...field}
                  label="Height (mm)"
                  value={rectangle.bounds.maxY - rectangle.bounds.minY}
                  min={0.001}
                  max={200000}
                  onCommit={(height) =>
                    onRectangle({ ...rectangle.bounds, maxY: rectangle.bounds.minY + height })
                  }
                />
              </PropertyGrid>
              {!rectangle.zoneId && !graphic && (
                <NumberField
                  {...field}
                  label="Line width (mm)"
                  value={board.graphics.find((item) => rectangle.ids.includes(item.id))!.width}
                  min={0.0001}
                  max={1000}
                  onCommit={(width) =>
                    onCommit({
                      ...board,
                      graphics: board.graphics.map((item) =>
                        rectangle.ids.includes(item.id) ? { ...item, width } : item,
                      ),
                    })
                  }
                />
              )}
            </PropertySection>
          )}
          {graphic && (
            <LayoutGraphicProperties
              graphic={graphic}
              active={active}
              resetKey={resetKey}
              snap={snap}
              layers={graphicLayers}
              geometry={!rectangle}
              onCommit={(next) =>
                onCommit({
                  ...board,
                  graphics: board.graphics.map((item) => (item.id === next.id ? next : item)),
                })
              }
            />
          )}
          {zone && (
            <>
              <PropertySection title={zone.keepout ? 'Rule area' : 'Copper zone'}>
                {!zone.keepout && (
                  <Select
                    active={active}
                    label="Zone net"
                    value={zone.netId ?? ''}
                    options={[{ value: '', label: 'Unassigned' }, ...netOptions]}
                    onChange={(netId) => onZone({ ...zone, netId: netId || null })}
                  />
                )}
                <Select
                  active={active}
                  label="Zone layer"
                  value={zone.layer}
                  options={
                    zone.keepout
                      ? graphicLayers.map((value) => ({ value, label: value }))
                      : layerOptions
                  }
                  onChange={(layer) => onZone({ ...zone, layer: layer as BoardLayer })}
                />
                {zone.keepout ? (
                  (Object.keys(zone.keepout) as (keyof NonNullable<typeof zone.keepout>)[]).map(
                    (key) => (
                      <PropertyToggle
                        active={active}
                        key={key}
                        label={`Keep out ${key === 'copperpour' ? 'copper pours' : key}`}
                        checked={zone.keepout![key]}
                        onChange={(checked) =>
                          onZone({ ...zone, keepout: { ...zone.keepout!, [key]: checked } })
                        }
                      />
                    ),
                  )
                ) : (
                  <>
                    <PropertyToggle
                      label="Fill zone"
                      active={active}
                      checked={zone.fillEnabled !== false}
                      onChange={(fillEnabled) => onZone({ ...zone, fillEnabled })}
                    />
                    <NumberField
                      {...field}
                      label="Clearance (mm)"
                      value={zone.clearance}
                      min={0}
                      max={100}
                      onCommit={(clearance) => onZone({ ...zone, clearance })}
                    />
                    <NumberField
                      {...field}
                      label="Minimum width (mm)"
                      value={zone.minThickness}
                      min={0.0001}
                      max={100}
                      onCommit={(minThickness) => onZone({ ...zone, minThickness })}
                    />
                    <NumberField
                      {...field}
                      label="Thermal gap (mm)"
                      value={zone.thermalGap}
                      min={0}
                      max={100}
                      onCommit={(thermalGap) => onZone({ ...zone, thermalGap })}
                    />
                    <NumberField
                      {...field}
                      label="Thermal bridge (mm)"
                      value={zone.thermalBridge}
                      min={0.0001}
                      max={100}
                      onCommit={(thermalBridge) => onZone({ ...zone, thermalBridge })}
                    />
                    <NumberField
                      {...field}
                      label="Zone priority"
                      value={zone.priority ?? 0}
                      min={0}
                      max={10000}
                      step="1"
                      onCommit={(priority) => onZone({ ...zone, priority })}
                    />
                    <Select
                      active={active}
                      label="Pad connection"
                      value={zone.padConnection ?? 'thermal'}
                      options={[
                        { value: 'thermal', label: 'Thermal relief' },
                        { value: 'yes', label: 'Solid' },
                        { value: 'no', label: 'None' },
                        { value: 'thru_hole_only', label: 'Thermal relief for through-hole' },
                      ]}
                      onChange={(value) => {
                        const next = { ...zone };
                        delete next.padConnection;
                        onZone(
                          value === 'thermal'
                            ? next
                            : {
                                ...next,
                                padConnection: value as NonNullable<typeof zone.padConnection>,
                              },
                        );
                      }}
                    />
                    <Select
                      active={active}
                      label="Island removal"
                      value={String(zone.islandRemovalMode ?? 0)}
                      options={[
                        { value: '0', label: 'Always' },
                        { value: '1', label: 'Never' },
                        { value: '2', label: 'Below area limit' },
                      ]}
                      onChange={(value) => onZone({ ...zone, islandRemovalMode: Number(value) })}
                    />
                  </>
                )}
              </PropertySection>
              <PropertyVertices title="Zone corners" count={zone.outline.length} active={active}>
                {(index) => {
                  const point = zone.outline[index];
                  return (
                    <div key={index}>
                      <NumberField
                        {...field}
                        label={`Corner ${index + 1} X (mm)`}
                        value={point.x}
                        normalize={snap}
                        onCommit={(x) =>
                          onZone({
                            ...zone,
                            outline: zone.outline.map((item, i) =>
                              i === index ? { ...item, x } : item,
                            ),
                          })
                        }
                      />
                      <NumberField
                        {...field}
                        label={`Corner ${index + 1} Y (mm)`}
                        value={point.y}
                        normalize={snap}
                        onCommit={(y) =>
                          onZone({
                            ...zone,
                            outline: zone.outline.map((item, i) =>
                              i === index ? { ...item, y } : item,
                            ),
                          })
                        }
                      />
                    </div>
                  );
                }}
              </PropertyVertices>
              {zone.holes?.map((hole, holeIndex) => (
                <PropertyVertices
                  title={`Cutout ${holeIndex + 1}`}
                  count={hole.length}
                  active={active}
                  key={holeIndex}
                >
                  {(index) => {
                    const point = hole[index];
                    return (
                      <div key={index}>
                        {(['x', 'y'] as const).map((axis) => (
                          <NumberField
                            {...field}
                            key={axis}
                            label={`Cutout ${holeIndex + 1} corner ${index + 1} ${axis.toUpperCase()} (mm)`}
                            value={point[axis]}
                            normalize={snap}
                            onCommit={(value) =>
                              onZone({
                                ...zone,
                                holes: zone.holes!.map((points, i) =>
                                  i === holeIndex
                                    ? points.map((item, j) =>
                                        j === index ? { ...item, [axis]: value } : item,
                                      )
                                    : points,
                                ),
                              })
                            }
                          />
                        ))}
                      </div>
                    );
                  }}
                </PropertyVertices>
              ))}
            </>
          )}
          {showEmptyState &&
            !selectionCount &&
            !footprint &&
            !track &&
            !via &&
            !graphic &&
            !zone && (
              <PropertiesEmptyState icon={CircuitBoard}>
                Select an object to view its properties.
              </PropertiesEmptyState>
            )}
          {selectionCount > 1 && !rectangle && (
            <PropertySection title="Selection">
              <PropertyRow label="Items" value={selectionCount} />
            </PropertySection>
          )}
        </>
      )}
    </>
  );
}
