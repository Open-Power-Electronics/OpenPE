import type { ReactNode } from 'react';
import type { Circuit } from '@/lib/circuit';
import type { Footprint } from '@/lib/pcb';
import type { CapabilityHost } from '@/api/capabilities';
import type { FootprintDetail } from './LibraryChooser';
import PartIdentity from './PartIdentity';
import PartProperties from './PartProperties';
import FootprintIdentity from './FootprintIdentity';
import FootprintModels from './FootprintModels';
import { NumberField, TextField } from './LayoutPropertyFields';
import Select from './Select';
import { PropertyTab, PropertyTabs } from './PropertyTabs';
import { SlidersHorizontal } from 'lucide-react';
import { preparePCBFootprintProperties, type PCBFootprintProperties } from '@/lib/pcb-properties';
export type ComponentPropertiesProps = {
  footprint: Footprint;
  schematic: Circuit;
  active: boolean;
  locked?: boolean;
  resetKey: boolean;
  snap: (v: number) => number;
  onFootprint: (f: Footprint) => boolean;
  capabilityHost?: CapabilityHost;
  onRequestSave?: (saveAs: boolean) => void;
  actions?: ReactNode;
  tabAction?: ReactNode;
  showIdentity?: boolean;
  fileId?: string;
  projectSource?: string;
  getRevision?: () => number;
  geometryEditable?: boolean;
  spiceAvailable?: boolean;
  onSavePartProperties?: (
    basis: Circuit,
    partId: string,
    ref: string,
    value: string,
    fields: Record<string, string>,
    detail?: FootprintDetail,
  ) => boolean;
};
export default function ComponentProperties({
  footprint,
  schematic,
  active,
  locked,
  resetKey,
  snap,
  onFootprint,
  capabilityHost,
  onRequestSave,
  onSavePartProperties,
  actions,
  tabAction,
  showIdentity = true,
  fileId,
  projectSource,
  getRevision,
  geometryEditable = true,
  spiceAvailable = false,
}: ComponentPropertiesProps) {
  const part = schematic.parts.find((p) => p.id === footprint.symbolId);
  const update = (changes: PCBFootprintProperties) =>
    onFootprint(preparePCBFootprintProperties(footprint, changes));
  const field = { active: active && geometryEditable, resetKey };
  const assignmentFields = (
    <>
      <FootprintModels
        footprint={footprint}
        active={active}
        fileId={fileId}
        projectSource={projectSource}
        getRevision={getRevision}
        capabilityHost={capabilityHost}
        onChange={(models) => update({ models })}
      />
      <div className="property-field">
        <span className="property-parameter-name">Side</span>
        <Select
          active={active && geometryEditable}
          label="Footprint side"
          value={footprint.side}
          options={[
            { value: 'front', label: 'Front' },
            { value: 'back', label: 'Back' },
          ]}
          onChange={(side) =>
            side === footprint.side || update({ side: side as Footprint['side'] })
          }
        />
      </div>
    </>
  );
  const geometryFields = (
    <div className="geometry-fields component-geometry">
      <NumberField
        {...field}
        label="X (mm)"
        value={footprint.x}
        normalize={snap}
        onCommit={(x) => update({ x })}
      />
      <NumberField
        {...field}
        label="Y (mm)"
        value={footprint.y}
        normalize={snap}
        onCommit={(y) => update({ y })}
      />
      <NumberField
        {...field}
        label="Rotation (°)"
        value={footprint.rotation}
        min={-360}
        max={360}
        onCommit={(rotation) => update({ rotation })}
      />
    </div>
  );
  return (
    <>
      {part ? (
        <>
          {showIdentity && (
            <PartIdentity part={part} library={schematic.libraries[part.libId]} actions={actions} />
          )}
          <PartProperties
            part={part}
            circuit={schematic}
            fileId={fileId}
            getRevision={getRevision}
            spiceAvailable={spiceAvailable}
            tabAction={tabAction}
            modelFields={assignmentFields}
            geometryFields={geometryFields}
            active={active && !!onSavePartProperties}
            locked={locked}
            capabilityHost={capabilityHost}
            onRequestSave={onRequestSave}
            onSave={(ref, value, fields, footprintDetail) =>
              onSavePartProperties?.(schematic, part.id, ref, value, fields, footprintDetail) ??
              false
            }
          />
        </>
      ) : (
        <>
          {showIdentity && <FootprintIdentity footprint={footprint} actions={actions} />}
          <PropertyTabs locked={locked} action={tabAction}>
            <PropertyTab label="General" icon={SlidersHorizontal}>
              <div className="layout-property-section">
                <div className="property-primary layout-property-primary">
                  <TextField
                    {...field}
                    label="Reference"
                    value={footprint.reference ?? ''}
                    onCommit={(reference) => update({ reference })}
                  />
                  <TextField
                    {...field}
                    label="Value"
                    value={footprint.value ?? ''}
                    onCommit={(value) => update({ value })}
                  />
                </div>
              </div>
              {assignmentFields}
              {geometryFields}
            </PropertyTab>
          </PropertyTabs>
        </>
      )}
    </>
  );
}
