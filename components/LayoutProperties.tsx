import { useMemo } from 'react';
import { CircuitBoard, PaintBucket, SlidersHorizontal, SquareDashed } from 'lucide-react';
import PropertiesEmptyState from './PropertiesEmptyState';
import type { ReactNode } from 'react';
import type { Circuit } from '@/lib/circuit';
import { isOwnedProjectNode } from '@/lib/immutable-project';
import type { PCB, Pad, Footprint, BoardLayer } from '@/lib/pcb';
import { replacePCBGraphic, type PCBBounds } from '@/lib/pcb-layout';
import { pcbPadShapeLabel, pcbPadTypeLabel } from '@/lib/pcb-display';
import {
  preparePCBZoneProperties,
  setPCBPadProperties,
  setPCBTrackEndpoints,
  setPCBViaProperties,
} from '@/lib/pcb-properties';
import { setPCBRectangleWidth, type PCBRectangle } from '@/lib/pcb-outline-resize';
import { pcbLockObject, type PCBLockTarget } from '@/lib/pcb-lock';
import type { CapabilityHost } from '@/api/capabilities';
import type { FootprintDetail } from './LibraryChooser';
import ComponentProperties from './ComponentProperties';
import PartIdentity from './PartIdentity';
import FootprintIdentity from './FootprintIdentity';
import { PropertySelect as Select } from './LayoutPropertyFields';
import LayoutGraphicProperties from './LayoutGraphicProperties';
import {
  NumberField,
  OptionalNumberField,
  PropertyRow,
  PropertySection,
  PropertyGrid,
  PropertyToggle,
} from './LayoutPropertyFields';
import { PropertyActionRow, PropertyTab, PropertyTabs } from './PropertyTabs';

type Props = {
  spiceAvailable?: boolean;
  fileId?: string;
  projectSource?: string;
  getRevision?: () => number;
  board: PCB;
  schematic: Circuit;
  active: boolean;
  resetKey: boolean;
  footprint?: Footprint;
  track?: PCB['tracks'][number];
  via?: PCB['vias'][number];
  graphic?: PCB['graphics'][number];
  graphicOwner?: Footprint;
  graphicDisplayText?: string;
  zone?: PCB['zones'][number];
  pad?: Pad;
  padOwner?: Footprint;
  rectangle: PCBRectangle | null;
  selectionCount: number;
  lockTargets: PCBLockTarget[];
  onLock: (locked: boolean) => void;
  showEmptyState?: boolean;
  actions?: ReactNode;
  snap: (value: number) => number;
  onCommit: (board: PCB) => boolean;
  onFootprint: (footprint: Footprint) => boolean;
  onEditFootprintText?: (board: PCB, schematic: Circuit, id: string, value: string) => boolean;
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
  graphicOwner,
  graphicDisplayText,
  zone,
  pad,
  padOwner,
  rectangle,
  selectionCount,
  lockTargets,
  onLock,
  showEmptyState = true,
  actions,
  snap,
  onCommit,
  onFootprint,
  onEditFootprintText,
  capabilityHost,
  onRequestSave,
  onSavePartProperties,
  onTrack,
  onZone,
  onRectangle,
  onError,
  onInspectFootprint,
  spiceAvailable,
  fileId,
  projectSource,
  getRevision,
}: Props) {
  const field = { active, resetKey };
  const locked =
    lockTargets.some((target) => pcbLockObject(board, target)?.locked) ||
    Boolean(pad && padOwner?.locked);
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
    via ? onCommit(setPCBViaProperties(board, via.id, changes)) : false;
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
  const lockControl = lockTargets.length > 0 && (
    <div className="layout-properties-lock">
      <PropertyToggle
        label="Locked"
        active={active}
        disabled={Boolean(pad && padOwner?.locked)}
        checked={locked}
        onChange={onLock}
      />
    </div>
  );
  const part = footprint && schematic.parts.find((part) => part.id === footprint.symbolId);
  const tabbed = (pad && padOwner) || track || zone || graphic || part;
  const rectangleFields = rectangle && (
    <>
      {!rectangle.zoneId && !graphic && (
        <NumberField
          {...field}
          label="Line width (mm)"
          value={board.graphics.find((item) => rectangle.ids.includes(item.id))!.width}
          min={0.0001}
          max={1000}
          onCommit={(width) => attempt(() => setPCBRectangleWidth(board, rectangle, width))}
        />
      )}
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
    </>
  );
  return (
    <>
      {footprint && !pad ? (
        part ? (
          <PartIdentity
            part={part}
            library={schematic.libraries[part.libId]}
            actions={lockControl}
          />
        ) : (
          <FootprintIdentity footprint={footprint} actions={lockControl} />
        )
      ) : lockTargets.length > 0 ? (
        <div className="layout-properties-heading layout-property-section-title">
          <h3>
            {pad
              ? `Pad ${pad.number || '—'}`
              : track
                ? 'Track'
                : via
                  ? 'Via'
                  : zone
                    ? zone.keepout
                      ? 'Rule area'
                      : 'Copper zone'
                    : graphic
                      ? graphic.kind === 'text'
                        ? graphicOwner
                          ? 'Footprint text'
                          : 'Text'
                        : graphic.kind === 'dimension'
                          ? 'Dimension'
                          : 'Graphic'
                      : rectangle
                        ? 'Board outline'
                        : 'Selection'}
          </h3>
          {lockControl}
        </div>
      ) : null}
      {!pad && !footprint && !track && !zone && !graphic && <PropertyActionRow action={actions} />}
      <fieldset className="layout-properties-fields" disabled={locked && !tabbed}>
        {pad && padOwner ? (
          <PropertyTabs locked={locked}>
            <PropertyTab label="General" icon={SlidersHorizontal}>
              <PropertySection title={`Pad ${pad.number || '—'}`} showTitle={false}>
                <PropertyRow
                  label="Footprint"
                  value={
                    schematic.parts.find((part) => part.id === padOwner.symbolId)?.ref ??
                    padOwner.reference ??
                    padOwner.libraryId
                  }
                />
                <PropertyRow label="Type" value={pcbPadTypeLabel(pad.type)} />
                <PropertyRow
                  label="Net"
                  value={netName(pad.netId)}
                  description="Pad nets follow the schematic pin connections."
                />
                <button
                  className="secondary layout-owner-action"
                  onClick={() => onInspectFootprint(padOwner.id)}
                  disabled={!active}
                >
                  Footprint properties
                </button>
              </PropertySection>
              <PropertySection title="Geometry" showTitle={false}>
                <Select
                  active={active}
                  label="Pad shape"
                  displayLabel="Shape"
                  value={pad.shape}
                  options={(['rect', 'circle', 'oval', 'roundrect'] as const).map((value) => ({
                    value,
                    label: pcbPadShapeLabel(value),
                  }))}
                  onChange={(shape) => padChange({ shape: shape as Pad['shape'] })}
                />
                <PropertyGrid columns={3}>
                  <NumberField
                    {...field}
                    label="X (mm)"
                    accessibleLabel="Pad X (mm)"
                    value={pad.x}
                    onCommit={(x) => padChange({ x })}
                  />
                  <NumberField
                    {...field}
                    label="Y (mm)"
                    accessibleLabel="Pad Y (mm)"
                    value={pad.y}
                    onCommit={(y) => padChange({ y })}
                  />
                  <NumberField
                    {...field}
                    label="Rotation (°)"
                    accessibleLabel="Pad rotation (°)"
                    value={pad.rotation}
                    min={-360}
                    max={360}
                    onCommit={(rotation) => padChange({ rotation })}
                  />
                </PropertyGrid>
                <PropertyGrid columns={pad.shape !== 'circle' && pad.type !== 'smd' ? 3 : 2}>
                  <NumberField
                    {...field}
                    label="Width (mm)"
                    accessibleLabel="Pad width (mm)"
                    value={pad.size.x}
                    min={0.0001}
                    max={1000}
                    onCommit={(x) => padChange({ size: { ...pad.size, x } })}
                  />
                  {pad.shape !== 'circle' && (
                    <NumberField
                      {...field}
                      label="Height (mm)"
                      accessibleLabel="Pad height (mm)"
                      value={pad.size.y}
                      min={0.0001}
                      max={1000}
                      onCommit={(y) => padChange({ size: { ...pad.size, y } })}
                    />
                  )}
                  {pad.type !== 'smd' && (
                    <NumberField
                      {...field}
                      label="Drill (mm)"
                      accessibleLabel="Pad drill (mm)"
                      value={pad.drill!}
                      min={0.0001}
                      max={
                        pad.type === 'thru_hole' ? Math.min(pad.size.x, pad.size.y) - 0.0001 : 1000
                      }
                      onCommit={(drill) => padChange({ drill })}
                    />
                  )}
                </PropertyGrid>
              </PropertySection>
            </PropertyTab>
            {pad.shape === 'roundrect' && (
              <PropertyTab label="Corners" icon={SquareDashed}>
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
              </PropertyTab>
            )}
          </PropertyTabs>
        ) : (
          <>
            {selectionCount > 1 && !rectangle && (
              <PropertySection title="Selection" showTitle={false}>
                <PropertyRow label="Items" value={selectionCount} />
              </PropertySection>
            )}
            {footprint && (
              <ComponentProperties
                showIdentity={false}
                tabAction={actions}
                footprint={footprint}
                schematic={schematic}
                active={active}
                locked={locked}
                resetKey={resetKey}
                snap={snap}
                onFootprint={onFootprint}
                capabilityHost={capabilityHost}
                onRequestSave={onRequestSave}
                onSavePartProperties={onSavePartProperties}
                fileId={fileId}
                projectSource={projectSource}
                getRevision={getRevision}
                spiceAvailable={spiceAvailable}
              />
            )}
            {track && (
              <PropertyTabs locked={locked} action={actions}>
                <PropertyTab label="General" icon={SlidersHorizontal}>
                  <PropertySection title="Track" showTitle={false}>
                    <Select
                      active={active}
                      label="Track net"
                      displayLabel="Net"
                      disabled={track.locked}
                      value={track.netId}
                      options={netOptions}
                      onChange={(netId) => onTrack({ netId })}
                    />
                    <Select
                      active={active}
                      label="Track layer"
                      displayLabel="Layer"
                      disabled={track.locked}
                      value={track.layer}
                      options={layerOptions}
                      onChange={(layer) => onTrack({ layer: layer as PCB['layers'][number] })}
                    />
                  </PropertySection>
                  <PropertySection title="Geometry" showTitle={false}>
                    <NumberField
                      {...field}
                      label="Width (mm)"
                      disabled={track.locked}
                      value={track.width}
                      min={0.0001}
                      max={1000}
                      onCommit={(width) => onTrack({ width })}
                    />
                  </PropertySection>
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
                </PropertyTab>
              </PropertyTabs>
            )}
            {via && (
              <>
                <PropertySection title="Via" showTitle={false}>
                  <PropertyRow label="Copper layers" value={board.layers.join(', ')} />
                  <Select
                    active={active}
                    label="Via net"
                    displayLabel="Net"
                    value={via.netId}
                    options={netOptions}
                    onChange={(netId) => viaChange({ netId })}
                  />
                </PropertySection>
                <PropertySection title="Geometry" showTitle={false}>
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
            {zone && (
              <PropertyTabs locked={locked} action={actions}>
                <PropertyTab label="General" icon={SlidersHorizontal}>
                  <PropertySection
                    title={zone.keepout ? 'Rule area' : 'Copper zone'}
                    showTitle={false}
                  >
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
                    {zone.keepout &&
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
                      )}
                  </PropertySection>
                  {zone.keepout && (
                    <NumberField
                      {...field}
                      label="Pour clearance (mm)"
                      value={zone.clearance}
                      min={0}
                      max={1000}
                      onCommit={(clearance) => onZone({ ...zone, clearance })}
                    />
                  )}
                  {Boolean(rectangle?.zoneId) && rectangleFields}
                </PropertyTab>
                {!zone.keepout && (
                  <PropertyTab label="Fill" icon={PaintBucket}>
                    <PropertyGrid>
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
                          try {
                            onZone(
                              preparePCBZoneProperties(zone, {
                                padConnection:
                                  value === 'thermal'
                                    ? undefined
                                    : (value as NonNullable<typeof zone.padConnection>),
                              }),
                            );
                          } catch (error) {
                            onError((error as Error).message);
                          }
                        }}
                      />
                      <Select
                        active={active}
                        label="Island removal"
                        className="layout-island-removal"
                        value={String(zone.islandRemovalMode ?? 0)}
                        options={[
                          { value: '0', label: 'Always' },
                          { value: '1', label: 'Never' },
                          { value: '2', label: 'Below area limit' },
                        ]}
                        onChange={(value) => onZone({ ...zone, islandRemovalMode: Number(value) })}
                      />
                    </PropertyGrid>
                  </PropertyTab>
                )}
              </PropertyTabs>
            )}
            {graphic && (
              <LayoutGraphicProperties
                actions={actions}
                graphic={graphic}
                active={active}
                locked={locked}
                resetKey={resetKey}
                snap={snap}
                layers={graphicLayers}
                geometry={!rectangle}
                fieldContent={
                  graphicOwner &&
                  (graphic.text?.property === 'Reference' || graphic.text?.property === 'Value')
                    ? {
                        value: graphicDisplayText ?? graphic.text.value,
                        onCommit: onEditFootprintText
                          ? (value) =>
                              active &&
                              !locked &&
                              onEditFootprintText(board, schematic, graphic.id, value)
                          : undefined,
                      }
                    : undefined
                }
                onCommit={(next) => {
                  try {
                    return onCommit(replacePCBGraphic(board, next));
                  } catch (error) {
                    onError((error as Error).message);
                    return false;
                  }
                }}
              />
            )}
            {rectangle && !rectangle.zoneId && (
              <PropertySection title="Board outline">
                <fieldset className="layout-properties-fields" disabled={locked}>
                  {rectangleFields}
                </fieldset>
              </PropertySection>
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
          </>
        )}
      </fieldset>
    </>
  );
}
