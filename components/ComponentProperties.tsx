import type { ReactNode } from 'react';
import type { Circuit } from '@/lib/circuit';
import type { Footprint } from '@/lib/pcb';
import type { CapabilityHost } from '@/api/capabilities';
import type { FootprintDetail } from './LibraryChooser';
import PartIdentity from './PartIdentity';
import PartProperties from './PartProperties';
import FootprintIdentity from './FootprintIdentity';
import FootprintModels from './FootprintModels';
import {
  NumberField,
  TextField,
  PropertyRow,
  PropertyGrid,
  PropertySelect as Select,
} from './LayoutPropertyFields';
import { flipPCBFootprint } from '@/lib/pcb-layout';
export type ComponentPropertiesProps = {
  footprint: Footprint;
  schematic: Circuit;
  active: boolean;
  resetKey: boolean;
  snap: (v: number) => number;
  onFootprint: (f: Footprint) => boolean;
  capabilityHost?: CapabilityHost;
  onRequestSave?: (saveAs: boolean) => void;
  actions?: ReactNode;
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
  resetKey,
  snap,
  onFootprint,
  capabilityHost,
  onRequestSave,
  onSavePartProperties,
  actions,
  fileId,
  projectSource,
  getRevision,
  geometryEditable = true,
  spiceAvailable = false,
}: ComponentPropertiesProps) {
  const part = schematic.parts.find((p) => p.id === footprint.symbolId);
  const field = { active: active && geometryEditable, resetKey };
  const modelFields = (
    <FootprintModels
      footprint={footprint}
      active={active}
      fileId={fileId}
      projectSource={projectSource}
      getRevision={getRevision}
      capabilityHost={capabilityHost}
      onChange={(models) => onFootprint({ ...footprint, models })}
    />
  );
  return (
    <>
      {part ? (
        <>
          <PartIdentity part={part} library={schematic.libraries[part.libId]} actions={actions} />
          <PartProperties
            part={part}
            circuit={schematic}
            fileId={fileId}
            getRevision={getRevision}
            spiceAvailable={spiceAvailable}
            modelFields={modelFields}
            active={active && !!onSavePartProperties}
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
          <FootprintIdentity footprint={footprint} actions={actions} />
          {modelFields}
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
              singleLine
            />
          </div>
        </>
      )}
      <div className="layout-footprint-geometry component-geometry">
        <PropertyGrid>
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
          <Select
            active={active && geometryEditable}
            label="Footprint side"
            value={footprint.side}
            options={[
              { value: 'front', label: 'Front' },
              { value: 'back', label: 'Back' },
            ]}
            onChange={(side) => side === footprint.side || onFootprint(flipPCBFootprint(footprint))}
          />
        </PropertyGrid>
      </div>
    </>
  );
}
