'use client';
import { lazy, memo, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, FolderSearch, Plus, Trash2 } from 'lucide-react';
import { type Part } from '@/lib/circuit';
import { displayPartValue, partFields } from '@/lib/library';
import { preparePartProperties, type FieldRow } from '@/lib/part-properties';
import { participatesInSimulation } from '@/lib/simulation-participation';
import { isSimulationField } from '@/lib/simulation-fields';
import type { FootprintDetail } from './LibraryChooser';
import DeferredDialog from './DeferredDialog';
import type { CapabilityHost } from '@/api/capabilities';

const LibraryChooser = lazy(() => import('./LibraryChooser'));

const simulationParameterLabels = new Map([
  ['OpenPE.SeriesResistance', 'Series resistance (Ω)'],
  ['OpenPE.InitialVoltage', 'Initial voltage (V)'],
  ['OpenPE.Coupling', 'Coupling (unitless)'],
]);
type PropertyRow = FieldRow & { simulation: boolean; label?: string };

function propertyRows(part: Part): PropertyRow[] {
  // Keep the editing group stable until a name change is committed.
  return Object.entries({ Footprint: '', ...partFields(part) }).map(([name, value]) => ({
    name,
    value,
    simulation: isSimulationField(name),
    label: simulationParameterLabels.get(name),
  }));
}

function PartProperties({
  part,
  onSave,
  onRequestSave,
  capabilityHost,
  active = true,
}: {
  part: Part;
  active?: boolean;
  onRequestSave?: (saveAs: boolean) => void;
  capabilityHost?: CapabilityHost;
  onSave: (
    ref: string,
    value: string,
    fields: Record<string, string>,
    includeInSimulation?: boolean,
    footprintDetail?: FootprintDetail,
  ) => boolean;
}) {
  const fields = partFields(part);
  const valueOwnsParams = part.value === '${SIM.PARAMS}' && !!fields['Sim.Params'];
  const visibleRow = (row: FieldRow) => !(valueOwnsParams && row.name === 'Sim.Params');
  const fieldsKey = JSON.stringify(fields);
  const included = participatesInSimulation(part);
  const snapshot = JSON.stringify([
    part.id,
    part.libId,
    part.unit,
    part.ref,
    part.value,
    fieldsKey,
    included,
  ]);
  const [basis, setBasis] = useState(snapshot);
  const [includeInSimulation, setIncludeInSimulation] = useState(included);
  const [ref, setRef] = useState(part.ref),
    [value, setValue] = useState(() => displayPartValue(part));
  const [rows, setRows] = useState(() => propertyRows(part));
  const [picker, setPicker] = useState(false),
    [error, setError] = useState('');
  const composing = useRef(false);
  const hasSimulationFields = rows.some((row) => row.simulation && visibleRow(row));
  const update = (i: number, key: 'name' | 'value', text: string) =>
    active && setRows((r) => r.map((row, j) => (j === i ? { ...row, [key]: text } : row)));
  function reset() {
    setBasis(snapshot);
    setRef(part.ref);
    setValue(displayPartValue(part));
    setRows(propertyRows(part));
    setIncludeInSimulation(included);
    setError('');
  }
  useLayoutEffect(() => {
    reset();
  }, [snapshot]);
  useLayoutEffect(() => {
    if (!active) setPicker(false);
  }, [active]);
  function save(
    draftRows = rows,
    participation = includeInSimulation,
    footprintDetail?: FootprintDetail,
  ): boolean {
    if (!active || composing.current || basis !== snapshot) return false;
    try {
      const change = preparePartProperties(part, ref, value, draftRows);
      if (
        (change || participation !== included) &&
        !onSave(
          change?.ref ?? part.ref,
          change?.value ?? part.value,
          change?.fields ?? fields,
          participation !== included ? participation : undefined,
          footprintDetail,
        )
      ) {
        setError('The change could not be applied. Check the reference and field values.');
        return false;
      }
      setError('');
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Invalid property values.');
      return false;
    }
  }

  const simulationHeading = (
    <>
      {hasSimulationFields && <ChevronRight size={15} aria-hidden="true" />}
      <span>Simulation</span>
      <button
        type="button"
        role="switch"
        className="appearance-toggle simulation-participation"
        aria-label="Include in simulation"
        aria-checked={includeInSimulation}
        disabled={!active}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!active) return;
          const next = !includeInSimulation;
          if (save(rows, next)) setIncludeInSimulation(next);
        }}
      >
        <span aria-hidden="true" />
      </button>
    </>
  );

  function renderFields(simulation: boolean) {
    return rows.map(
      (row, i) =>
        row.simulation === simulation &&
        visibleRow(row) && (
          <div className="property-field" key={i}>
            {row.label ? (
              <span className="property-parameter-name" aria-description={row.label}>
                {row.label}
              </span>
            ) : (
              <input
                className="property-field-name"
                aria-label={`Field ${i + 1} name`}
                aria-description={row.name}
                placeholder="Name"
                value={row.name}
                readOnly={['Footprint', 'Datasheet'].includes(row.name)}
                disabled={!active}
                onChange={(e) => update(i, 'name', e.target.value)}
              />
            )}
            <input
              className="property-field-value"
              aria-label={row.label || row.name || `Field ${i + 1} value`}
              aria-description={row.value}
              placeholder={
                row.name === 'Footprint' ? 'Unassigned' : row.fresh ? 'Value' : undefined
              }
              value={row.value}
              disabled={!active}
              onChange={(e) => update(i, 'value', e.target.value)}
            />
            {row.name === 'Footprint' ? (
              <button
                type="button"
                className="icon-button"
                aria-label="Browse footprints"
                title="Browse footprints"
                disabled={!active}
                onClick={() => setPicker(true)}
              >
                <FolderSearch size={17} />
              </button>
            ) : (
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove field ${row.label || row.name || i + 1}`}
                title="Remove field"
                disabled={!active}
                onClick={() => {
                  if (!active) return;
                  const next = rows.filter((_, j) => i !== j);
                  setRows(next);
                  save(next);
                }}
              >
                <Trash2 size={17} />
              </button>
            )}
          </div>
        ),
    );
  }

  return (
    <>
      <div
        className="part-properties"
        onCompositionStart={() => {
          composing.current = true;
        }}
        onCompositionEnd={() => {
          composing.current = false;
        }}
        onBlur={(event) => {
          if (event.target instanceof HTMLInputElement) save();
        }}
        onKeyDown={(event) => {
          if (!active || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
            event.stopPropagation();
            return;
          }
          if (
            onRequestSave &&
            event.target instanceof HTMLInputElement &&
            (event.ctrlKey || event.metaKey) &&
            event.key.toLowerCase() === 's'
          ) {
            event.preventDefault();
            event.stopPropagation();
            if (save()) onRequestSave(event.shiftKey);
            return;
          }
          if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
            event.preventDefault();
            event.target.blur();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            reset();
          }
        }}
      >
        <div className="property-primary">
          <label>
            Reference
            <input
              aria-label="Component reference"
              value={ref}
              disabled={!active}
              onChange={(e) => {
                if (active) setRef(e.target.value);
              }}
            />
          </label>
          <label>
            Value
            <input
              aria-label="Component value"
              value={value}
              disabled={!active}
              onChange={(e) => {
                if (active) setValue(e.target.value);
              }}
            />
          </label>
        </div>
        <div className="property-fields">
          <div className="property-field-heading">
            <span>Field</span>
            <span>Value</span>
          </div>
          {renderFields(false)}
        </div>
        <button
          type="button"
          className="property-add-field"
          disabled={!active}
          onClick={() =>
            setRows([...rows, { name: '', value: '', fresh: true, simulation: false }])
          }
        >
          <Plus size={15} />
          Add field
        </button>
        {hasSimulationFields ? (
          <details className="property-simulation">
            <summary className="property-simulation-heading">{simulationHeading}</summary>
            <div className="property-fields">{renderFields(true)}</div>
          </details>
        ) : (
          <div className="property-simulation">
            <div className="property-simulation-heading">{simulationHeading}</div>
          </div>
        )}
        {error && (
          <p className="dialog-error" role="alert">
            {error}
          </p>
        )}
      </div>
      {picker && active && (
        <DeferredDialog title="Choose footprint" onClose={() => setPicker(false)}>
          <LibraryChooser
            capabilityHost={capabilityHost}
            kind="footprints"
            initialSearch={rows.find((row) => row.name === 'Footprint')?.value ?? ''}
            onClose={() => setPicker(false)}
            onChoose={(detail) => {
              if (!('pads' in detail && 'models' in detail)) return;
              const i = rows.findIndex((r) => r.name === 'Footprint');
              const next =
                i >= 0
                  ? rows.map((row, j) => (j === i ? { ...row, value: detail.id } : row))
                  : [...rows, { name: 'Footprint', value: detail.id, simulation: false }];
              if (save(next, includeInSimulation, detail)) setRows(next);
              setPicker(false);
            }}
          />
        </DeferredDialog>
      )}
    </>
  );
}

// Pose inputs live beside this form. Moving a component retains its property
// drafts, while every association used to interpret or save fields stays exact.
export default memo(
  PartProperties,
  (previous, next) =>
    previous.onSave === next.onSave &&
    previous.onRequestSave === next.onRequestSave &&
    previous.active === next.active &&
    previous.capabilityHost === next.capabilityHost &&
    previous.part.id === next.part.id &&
    previous.part.libId === next.part.libId &&
    previous.part.unit === next.part.unit &&
    previous.part.ref === next.part.ref &&
    previous.part.value === next.part.value &&
    previous.part.raw === next.part.raw &&
    previous.part.fields === next.part.fields &&
    previous.part.excludeFromSimulation === next.part.excludeFromSimulation &&
    previous.part.mirror === next.part.mirror,
);
