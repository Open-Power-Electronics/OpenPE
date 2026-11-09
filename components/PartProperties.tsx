'use client';
import QuantityInput from './QuantityInput';
import {
  Fragment,
  type ReactNode,
  lazy,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Activity, Check, FolderSearch, Plus, SlidersHorizontal, Trash2 } from 'lucide-react';
import { type Part, type Circuit } from '@/lib/circuit';
import { displayPartValue, partFields } from '@/lib/library';
import {
  preparePartProperties,
  simulationSourceProperties,
  type FieldRow,
} from '@/lib/part-properties';
import { isSimulationField } from '@/lib/simulation-fields';
import { storagePrimitive, initialConditionField } from '@/lib/simulation-initial-conditions';
import {
  simulationLibraryPath,
  simulationLibraryDeclaration,
  simulationLibraryModelName,
  simulationComponentPresentation,
} from '@/lib/simulation-model-presentation';
import type { FootprintDetail } from './LibraryChooser';
import DeferredDialog from './DeferredDialog';
import Select from './Select';
import { PropertyTab, PropertyTabs } from './PropertyTabs';
import type { CapabilityHost } from '@/api/capabilities';
import type { SpiceModelDeclaration } from '@/lib/bridge';
import {
  simulationModelSource,
  activePassiveModel,
  canSelectPassiveSimulationModel,
  isPassiveSimulationModel,
  passiveSimulationModels,
  basicSimulationAvailable,
  basicSimulationKind,
} from '@/lib/simulation-model-source';
import { externalModelBinding, validateExternalModelMapping } from '@/lib/simulation-model-binding';
import {
  prepareSimulationLibrarySelection,
  prepareSimulationModelSelection,
} from '@/lib/model-resource-preparation';

import { prepareSourceConversion } from '@/lib/simulation-source-conversion';
import type { SimulationSourceType } from '@/lib/simulation-source-parameters';

const LibraryChooser = lazy(() => import('./LibraryChooser'));

function withModelFields(
  rows: PropertyRow[],
  fields: Record<string, string | undefined>,
): PropertyRow[] {
  const seen = new Set(rows.map((row) => row.name));
  const next = rows.flatMap((row) =>
    !Object.hasOwn(fields, row.name)
      ? [row]
      : fields[row.name] === undefined
        ? []
        : [{ ...row, value: fields[row.name]! }],
  );
  for (const [name, value] of Object.entries(fields))
    if (value !== undefined && !seen.has(name))
      next.push({ name, value, simulation: true, label: name.replace(/^Sim\./, '') });
  return next;
}

function withPreparedModelFields(rows: PropertyRow[], fields: Record<string, string>) {
  const changes: Record<string, string | undefined> = { ...fields };
  for (const row of rows)
    if (!row.sourceKey && !Object.hasOwn(fields, row.name)) changes[row.name] = undefined;
  return withModelFields(rows, changes);
}

const simulationParameterLabels = new Map([
  ['OpenPE.InitialVoltage', 'Initial voltage (V)'],
  ['OpenPE.InitialCurrent', 'Initial current (A)'],
]);
const simulationParameterUnits = new Map([
  ['OpenPE.InitialVoltage', 'V'],
  ['OpenPE.InitialCurrent', 'A'],
]);
type PropertyRow = FieldRow & {
  simulation: boolean;
  label?: string;
  unit?: string;
  optional?: boolean;
  edited?: boolean;
};

function displayedSimulationValue(row: PropertyRow): string {
  return row.name === 'Sim.Name' ? row.value.replace(/^OPENPE_(?:DERIVED_)?/i, '') : row.value;
}

function propertyRows(part: Part): PropertyRow[] {
  const source = simulationSourceProperties(part);
  const primitive = storagePrimitive(part);
  // Keep the editing group stable until a name change is committed.
  const rows: PropertyRow[] = Object.entries({ Footprint: '', ...partFields(part) }).map(
    ([name, value]) => ({
      name,
      value,
      simulation: isSimulationField(name),
      label:
        simulationParameterLabels.get(name) ??
        (/^Sim\./i.test(name) ? name.replace(/^Sim\./i, '') : undefined),
    }),
  );
  if (primitive) {
    const name = initialConditionField(primitive);
    const initial = rows.find((row) => row.name === name);
    if (initial) initial.optional = true;
    else
      rows.push({
        name,
        value: '',
        simulation: true,
        optional: true,
        label: simulationParameterLabels.get(name),
      });
  }
  if (!source) return rows;
  const sourceRows: PropertyRow[] = source.rows.map((row) => ({ ...row, simulation: true }));
  return rows.some((row) => row.name === 'Sim.Params')
    ? rows.flatMap((row) => (row.name === 'Sim.Params' ? sourceRows : [row]))
    : [...rows, ...sourceRows];
}

function PartProperties({
  part,
  circuit,
  onSave,
  modelFields,
  geometryFields,
  onRequestSave,
  capabilityHost,
  active = true,
  locked = false,
  spiceAvailable = false,
  fileId,
  getRevision,
}: {
  part: Part;
  modelFields?: ReactNode;
  geometryFields?: ReactNode;
  circuit?: Circuit;
  active?: boolean;
  locked?: boolean;
  /** Shared component controls owned by the installed and enabled SPICE plugin. */
  spiceAvailable?: boolean;
  fileId?: string;
  getRevision?: () => number;
  onRequestSave?: (saveAs: boolean) => void;
  capabilityHost?: CapabilityHost;
  onSave: (
    ref: string,
    value: string,
    fields: Record<string, string>,
    footprintDetail?: FootprintDetail,
  ) => boolean;
}) {
  const fields = partFields(part);
  const presentation = useMemo(
    () =>
      spiceAvailable
        ? simulationComponentPresentation(part, circuit)
        : { model: '', basicModel: '', initial: '' },
    [part, circuit, spiceAvailable],
  );
  const valueOwnsParams = part.value === '${SIM.PARAMS}' && !!fields['Sim.Params'];
  const visibleRow = (row: FieldRow) =>
    ![
      'LCSC',
      'MPN',
      'Sim.Device',
      'Sim.Type',
      'Sim.Pins',
      'Sim.Name',
      'Sim.Library',
      'OpenPE.ModelSource',
      'OpenPE.PassiveModel',
      'OpenPE.SourceType',
      'OpenPE.SeriesResistance',
      'OpenPE.Coupling',
    ].includes(row.name) &&
    !(
      externalModel &&
      (row.sourceKey ||
        (simulationParameterLabels.has(row.name) &&
          !(row.name === 'OpenPE.InitialVoltage' && rowFields['Sim.Device'] === 'C') &&
          !(row.name === 'OpenPE.InitialCurrent' && rowFields['Sim.Device'] === 'L')))
    ) &&
    (row.name !== 'OpenPE.InitialVoltage' || storagePrimitive(part) === 'C') &&
    (row.name !== 'OpenPE.InitialCurrent' || storagePrimitive(part) === 'L') &&
    !(valueOwnsParams && row.name === 'Sim.Params' && !row.sourceKey);
  const fieldsKey = JSON.stringify(fields);
  const snapshot = JSON.stringify([
    part.id,
    part.libId,
    part.unit,
    part.ref,
    part.value,
    fieldsKey,
  ]);
  const [basis, setBasis] = useState(snapshot);
  const [ref, setRef] = useState(part.ref),
    [value, setValue] = useState(() => displayPartValue(part));
  const [rows, setRows] = useState(() => propertyRows(part));
  const rowFields = Object.fromEntries(
    rows.filter((row) => !row.sourceKey).map((row) => [row.name, row.value]),
  );
  const externalModel = simulationModelSource(rowFields) === 'external';
  const basicAvailable = basicSimulationAvailable(part);
  const basicKind = basicSimulationKind(part);
  const passive = isPassiveSimulationModel(basicKind) ? basicKind : null;
  const passiveChoices = canSelectPassiveSimulationModel(part, circuit);
  const libraryPath = simulationLibraryPath(rowFields['Sim.Library'] || '');
  const libraryFilename = libraryPath.split(/[\\/]/).at(-1) || '';
  const externalName = rowFields['Sim.Name'] || '';
  const [catalog, setCatalog] = useState<{
    path: string;
    models: SpiceModelDeclaration[];
    issues: string[];
  } | null>(null);
  const [mapping, setMapping] = useState<{
    declaration: SpiceModelDeclaration;
    binding: ReturnType<typeof externalModelBinding>;
    choices: Record<string, string>;
    snapshot: string;
    revision: number | undefined;
  } | null>(null);
  const declarations = catalog?.path === libraryPath ? catalog.models : [];
  const [picker, setPicker] = useState(false),
    [error, setError] = useState('');
  const [modelBrowsing, setModelBrowsing] = useState(false);
  const modelBrowseButton = useRef<HTMLButtonElement>(null);
  const modelBrowseRequest = useRef(0);
  const composing = useRef(false);
  const geometryContainer = useRef<HTMLDivElement>(null);
  const update = (i: number, key: 'name' | 'value', text: string) =>
    active &&
    setRows((r) =>
      r.map((row, j) =>
        j === i ? { ...row, [key]: text, edited: key === 'value' ? true : row.edited } : row,
      ),
    );
  function reset() {
    setBasis(snapshot);
    setRef(part.ref);
    setValue(displayPartValue(part));
    setRows(propertyRows(part));
    setError('');
  }
  useLayoutEffect(() => {
    reset();
  }, [snapshot]);
  useLayoutEffect(() => {
    if (!active) setPicker(false);
  }, [active, spiceAvailable]);
  useLayoutEffect(() => {
    setCatalog(null);
    setMapping(null);
  }, [part.id, fileId]);
  useLayoutEffect(() => {
    setModelBrowsing(false);
    return () => {
      modelBrowseRequest.current++;
    };
  }, [active, spiceAvailable, fileId, snapshot]);
  useEffect(() => {
    if (
      !active ||
      !spiceAvailable ||
      !fileId ||
      !libraryPath ||
      catalog?.path === libraryPath ||
      !window.openpe
    )
      return;
    let cancelled = false;
    const revision = getRevision?.();
    async function inspect() {
      try {
        if (typeof window.openpe?.inspectSpiceModel !== 'function')
          throw new Error('Restart OpenPE to load automatic SPICE model inspection.');
        const result = await window.openpe.inspectSpiceModel(fileId!, libraryPath);
        if (cancelled || getRevision?.() !== revision || !result) return;
        if (
          result.path !== libraryPath ||
          !Array.isArray(result.models) ||
          !Array.isArray(result.issues)
        )
          throw new Error('Invalid SPICE model inspection.');
        setCatalog(result);
        if (
          externalName &&
          !simulationLibraryDeclaration(rowFields['Sim.Library'] || '', externalName, result.models)
        )
          setError(
            `This library does not contain model "${simulationLibraryModelName(rowFields['Sim.Library'] || '', externalName)}". Choose a matching model.`,
          );
      } catch (reason) {
        if (!cancelled && getRevision?.() === revision)
          setError(reason instanceof Error ? reason.message : 'Could not inspect the model file.');
      }
    }
    void inspect();
    return () => {
      cancelled = true;
    };
  }, [active, spiceAvailable, fileId, part.id, libraryPath, snapshot, catalog]);
  function save(draftRows = rows, footprintDetail?: FootprintDetail): boolean {
    if (!active || locked || composing.current || basis !== snapshot) return false;
    try {
      const change = preparePartProperties(part, ref, value, draftRows);
      if (change && !onSave(change.ref, change.value, change.fields, footprintDetail)) {
        setError('The change could not be applied. Check the reference and field values.');
        return false;
      }
      setError('');
      if (draftRows.some((row) => row.optional && !row.value && row.edited))
        setRows(
          draftRows.map((row) => (row.optional && !row.value ? { ...row, edited: false } : row)),
        );
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Invalid property values.');
      return false;
    }
  }

  async function browseModel() {
    if (!active || !spiceAvailable || modelBrowsing || composing.current) return;
    if (!fileId || !window.openpe) {
      setError('Use the desktop app to browse model files.');
      return;
    }
    if (typeof window.openpe.chooseSpiceModel !== 'function') {
      setError('Restart OpenPE to load the native SPICE model picker.');
      return;
    }
    const request = ++modelBrowseRequest.current;
    const revision = getRevision?.();
    setModelBrowsing(true);
    try {
      const result = await window.openpe.chooseSpiceModel(fileId, libraryPath || undefined);
      if (request !== modelBrowseRequest.current || !result) return;
      if (getRevision?.() !== revision) {
        setError('The project changed. Choose the SPICE model again.');
        return;
      }
      if (
        typeof result.path !== 'string' ||
        !Array.isArray(result.models) ||
        !Array.isArray(result.issues)
      )
        throw new Error('Restart OpenPE to load SPICE model inspection.');
      setCatalog({
        path: result.path,
        models: result.models,
        issues: result.issues,
      });
      setMapping(null);
      const prepared = prepareSimulationLibrarySelection(
        part,
        rowFields,
        result.path,
        result.models,
      );
      const next = withPreparedModelFields(rows, prepared);
      setRows(next);
      save(next);
    } catch (reason) {
      if (request === modelBrowseRequest.current)
        setError(reason instanceof Error ? reason.message : 'Could not choose a model file.');
    } finally {
      if (request === modelBrowseRequest.current) setModelBrowsing(false);
    }
  }

  function parameterValue(row: PropertyRow) {
    if (row.value || row.edited || !row.optional) return row.value;
    const implicit = row.sourceKey ? '0' : presentation.initial;
    return implicit && Number.isFinite(Number(implicit)) ? implicit : '';
  }

  function selectModel(selection: string) {
    if (
      !active ||
      locked ||
      !spiceAvailable ||
      modelBrowsing ||
      composing.current ||
      basis !== snapshot
    )
      return;
    if (selection.startsWith('source:')) {
      try {
        const change = prepareSourceConversion(
          part,
          ref,
          value,
          rows,
          selection.slice(7) as SimulationSourceType,
        );
        if (change && !onSave(change.ref, change.value, change.fields))
          throw new Error('The source change could not be applied.');
        setMapping(null);
        setError('');
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Invalid source model.');
      }
      return;
    }
    const passiveModel = selection.startsWith('passive:') ? selection.slice(8) : undefined;
    if (
      selection === 'intrinsic' ||
      selection === 'unassigned' ||
      isPassiveSimulationModel(passiveModel)
    ) {
      try {
        const next = withPreparedModelFields(
          rows,
          prepareSimulationModelSelection(circuit, part, rowFields, {
            source: 'basic',
            passiveModel:
              selection === 'unassigned'
                ? null
                : isPassiveSimulationModel(passiveModel)
                  ? passiveModel
                  : undefined,
          }),
        );
        if (save(next)) {
          setRows(next);
          setMapping(null);
        }
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Invalid intrinsic model.');
      }
      return;
    }
    if (!selection.startsWith('external:') || !libraryPath) return;
    const name = selection.slice('external:'.length);
    const declaration = simulationLibraryDeclaration(
      rowFields['Sim.Library'] || '',
      name,
      declarations,
    );
    if (declaration && modelOptionDisabled(declaration)) return;
    if (catalog?.path === libraryPath && !declaration) {
      setError('This model is not declared in the selected library. Choose a matching model.');
      return;
    }
    if (name === externalName) {
      try {
        if (declaration && circuit) {
          const binding = externalModelBinding(circuit, part, declaration);
          if (!binding.compatible)
            throw new Error(binding.reason || 'This model is incompatible with the component.');
        }
        const next = withPreparedModelFields(
          rows,
          prepareSimulationModelSelection(circuit, part, rowFields, {
            source: 'external',
            name,
            declarations: catalog?.path === libraryPath ? declarations : undefined,
          }),
        );
        setMapping(null);
        setRows(next);
        save(next);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : 'Invalid model declaration.');
      }
      return;
    }
    if (!declaration || !circuit) {
      setError('Choose the model file again.');
      return;
    }
    try {
      const binding = externalModelBinding(circuit, part, declaration);
      if (!binding.compatible)
        throw new Error(binding.reason || 'This model is incompatible with the component.');
      if (!binding.mapping) {
        setMapping({
          declaration,
          binding,
          choices: { ...binding.suggested },
          snapshot,
          revision: getRevision?.(),
        });
        setError('');
        return;
      }
      const next = withPreparedModelFields(
        rows,
        prepareSimulationModelSelection(circuit, part, rowFields, {
          source: 'external',
          name,
          declarations,
          mapping: binding.mapping,
        }),
      );
      setMapping(null);
      setRows(next);
      save(next);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Invalid model mapping.');
    }
  }

  function applyMapping() {
    if (!mapping || !circuit || !active || !spiceAvailable || composing.current) return;
    if (mapping.snapshot !== snapshot || mapping.revision !== getRevision?.()) {
      setError('The component changed. Select the model again.');
      return;
    }
    try {
      validateExternalModelMapping(mapping.binding, mapping.choices);
      const next = withPreparedModelFields(
        rows,
        prepareSimulationModelSelection(circuit, part, rowFields, {
          source: 'external',
          name: mapping.declaration.name,
          declarations: [mapping.declaration],
          mapping: mapping.choices,
        }),
      );
      setRows(next);
      if (save(next)) setMapping(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Invalid model mapping.');
    }
  }

  function modelOptionLabel(name: string) {
    return name.replace(/^OPENPE_(?:DERIVED_)?/i, '');
  }

  function modelOptionIssue(declaration: SpiceModelDeclaration) {
    if (!circuit) return 'Component terminals are unavailable.';
    try {
      const binding = externalModelBinding(circuit, part, declaration);
      return binding.compatible ? '' : binding.reason || 'Incompatible with this component.';
    } catch (reason) {
      return reason instanceof Error ? reason.message : 'Invalid model declaration.';
    }
  }

  function modelOptionDisabled(declaration: SpiceModelDeclaration) {
    return !!modelOptionIssue(declaration);
  }

  function modelSelector() {
    const selectedPassive = activePassiveModel(rowFields) ?? passive;
    const storedPassive = rowFields['OpenPE.PassiveModel'];
    const retainedPassive = isPassiveSimulationModel(storedPassive) ? storedPassive : passive;
    const availablePassives = libraryPath
      ? retainedPassive
        ? [retainedPassive]
        : []
      : passiveSimulationModels;
    const unassigned = passiveChoices && !passive && !libraryPath;
    const currentBuiltin =
      !externalModel &&
      !basicAvailable &&
      !selectedPassive &&
      !unassigned &&
      !rowFields['OpenPE.ModelSource'];
    const sourceDevice = basicSimulationKind(part);
    const waveformSource = sourceDevice === 'V' || sourceDevice === 'I';
    const sourceType = rowFields['OpenPE.SourceType'] || simulationSourceProperties(part)?.type;
    const selection = mapping
      ? `external:${mapping.declaration.name}`
      : currentBuiltin
        ? 'current'
        : !externalModel && (basicAvailable || selectedPassive || unassigned)
          ? waveformSource
            ? 'source:' + sourceType
            : selectedPassive
              ? 'passive:' + selectedPassive
              : unassigned
                ? 'unassigned'
                : 'intrinsic'
          : externalName && libraryPath
            ? `external:${externalName}`
            : '';
    const choices = [
      ...(waveformSource
        ? ['DC', 'PULSE', 'SIN'].map((type) => ({
            value: 'source:' + type,
            label: type + (sourceDevice === 'I' ? ' current source' : ' voltage source'),
            disabled: false,
          }))
        : passiveChoices
          ? availablePassives.map((model) => ({
              value: 'passive:' + model,
              label: 'ngspice ' + model,
              disabled: false,
            }))
          : basicAvailable
            ? [{ value: 'intrinsic', label: presentation.basicModel, disabled: false }]
            : []),
      ...(unassigned ? [{ value: 'unassigned', label: 'Unassigned', disabled: false }] : []),
      ...(currentBuiltin
        ? [{ value: 'current', label: presentation.basicModel, disabled: true }]
        : []),
      ...(externalName &&
      libraryPath &&
      (catalog?.path !== libraryPath ||
        simulationLibraryDeclaration(rowFields['Sim.Library'] || '', externalName, declarations)) &&
      !declarations.some((model) => model.name === externalName)
        ? [
            {
              value: 'external:' + externalName,
              label: modelOptionLabel(externalName),
              disabled: false,
            },
          ]
        : []),
      ...declarations.map((model) => {
        const issue = modelOptionIssue(model);
        return {
          value: 'external:' + model.name,
          label: modelOptionLabel(model.name),
          disabled: !!issue,
          muted: !!issue,
        };
      }),
    ].sort((a, b) => Number(b.value === selection) - Number(a.value === selection));
    return (
      <>
        <div className="property-file-models">
          <span>File</span>
          <div className="property-model-choice">
            <input
              className="property-model-path"
              aria-label="Model library"
              value={libraryFilename}
              title={libraryPath}
              placeholder="Choose model file"
              readOnly
            />
            <button
              ref={modelBrowseButton}
              type="button"
              className="icon-button"
              aria-label="Browse SPICE models"
              title="Choose model file"
              disabled={!active || !spiceAvailable || modelBrowsing}
              aria-busy={modelBrowsing}
              onClick={() => void browseModel()}
            >
              <FolderSearch size={17} />
            </button>
          </div>
        </div>
        <div className="property-file-models">
          <span>Model</span>
          <Select
            label="Simulation model"
            value={selection}
            placeholder={
              catalog?.path !== libraryPath
                ? libraryPath
                  ? 'Browse file to list models'
                  : 'Choose model'
                : declarations.length
                  ? 'Choose model from file'
                  : 'No models found'
            }
            active={active && spiceAvailable && !modelBrowsing}
            disabled={!choices.length}
            options={choices}
            onChange={selectModel}
            popupClassName="property-model-menu"
            popupMatchWidth="trigger"
            popupMaxHeight={240}
          />
        </div>
        {catalog?.path === libraryPath && catalog.issues.length > 0 && (
          <span
            className="property-model-file"
            role="status"
            title={catalog.issues.join(' ').slice(0, 2048)}
          >
            {catalog.issues.length} unavailable {catalog.issues.length === 1 ? 'model' : 'models'}
          </span>
        )}
        {mapping && (
          <details className="property-model-mapping" open>
            <summary>Pins</summary>
            {mapping.binding.terminals.map((terminal) => (
              <label key={terminal}>
                {terminal}
                <select
                  autoFocus={terminal === mapping.binding.terminals[0]}
                  aria-label={`Map ${terminal}`}
                  value={mapping.choices[terminal] || ''}
                  disabled={!active || !spiceAvailable}
                  onChange={(event) =>
                    setMapping(
                      (current) =>
                        current && {
                          ...current,
                          choices: { ...current.choices, [terminal]: event.target.value },
                        },
                    )
                  }
                >
                  <option value="">Choose pin</option>
                  {mapping.binding.symbolPins.map((pin) => (
                    <option key={pin.number} value={pin.number}>
                      {pin.number} · {pin.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
            <div className="property-model-mapping-actions">
              <button
                type="button"
                className="icon-button property-apply-action"
                aria-label="Apply model"
                title="Apply model"
                onClick={applyMapping}
                disabled={!active || !spiceAvailable}
              >
                <Check size={17} aria-hidden="true" />
              </button>
              <button
                type="button"
                className="dialog-button secondary"
                aria-label="Cancel mapping"
                disabled={!active || !spiceAvailable}
                onClick={() => {
                  if (!composing.current) setMapping(null);
                }}
              >
                Cancel
              </button>
            </div>
          </details>
        )}
      </>
    );
  }

  function renderFields(simulation: boolean) {
    const displayedRows = rows.map((row, i) => ({ row, i }));
    return displayedRows.map(
      ({ row, i }) =>
        row.simulation === simulation &&
        visibleRow(row) && (
          <Fragment key={i}>
            <div
              className={`property-field${!simulation && row.name === 'Footprint' ? ' property-resource-field' : ''}${simulation ? ' property-simulation-field' : ''}${simulation && row.name === 'Sim.Library' ? ' property-simulation-library' : ''}${simulationParameterLabels.has(row.name) || row.sourceKey ? ' property-simulation-parameter' : ''}`}
              key={i}
            >
              {simulation && row.name === 'Sim.Library' ? null : simulation || row.label ? (
                <span className="property-parameter-name" aria-description={row.label || row.name}>
                  {simulationParameterLabels.has(row.name) || row.sourceKey
                    ? row.label?.replace(/ \([^)]*\)$/, '')
                    : row.label || row.name}
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
              {simulationParameterLabels.has(row.name) || row.sourceKey ? (
                <div className="property-simulation-value">
                  <QuantityInput
                    decimalPlaces={2}
                    unit={row.unit || simulationParameterUnits.get(row.name)}
                    autoScale
                    className="property-field-value"
                    aria-label={row.label || row.name}
                    value={parameterValue(row)}
                    placeholder={
                      row.optional
                        ? row.sourceKey
                          ? '0'
                          : presentation.initial
                        : row.sourceKey
                          ? 'Value'
                          : undefined
                    }
                    title={
                      row.optional && !row.value
                        ? row.sourceKey
                          ? '0'
                          : presentation.initial === 'Computed'
                            ? 'Calculated from the circuit operating point.'
                            : presentation.initial
                        : undefined
                    }
                    disabled={!active || !spiceAvailable}
                    onValueChange={(inputValue) => update(i, 'value', inputValue)}
                  />
                </div>
              ) : simulation ? (
                <span
                  className="property-readonly-value"
                  aria-label={row.label || row.name}
                  title={displayedSimulationValue(row)}
                >
                  {displayedSimulationValue(row) || '—'}
                </span>
              ) : (
                <input
                  className={`property-field-value${['Datasheet', 'Description'].includes(row.name) ? ' property-field-prose' : ''}`}
                  aria-label={row.label || row.name || `Field ${i + 1} value`}
                  aria-description={row.value}
                  title={row.name === 'Footprint' ? row.value : undefined}
                  placeholder={
                    row.name === 'Footprint' ? 'Unassigned' : row.fresh ? 'Value' : undefined
                  }
                  value={row.value}
                  disabled={!active}
                  onChange={(e) => update(i, 'value', e.target.value)}
                />
              )}
              {simulation ? null : row.name === 'Footprint' ? (
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
            {!simulation && row.name === 'Footprint' ? modelFields : null}
          </Fragment>
        ),
    );
  }

  return (
    <>
      <div
        className="part-properties"
        onCompositionStart={(event) => {
          if (geometryContainer.current?.contains(event.target as Node)) return;
          composing.current = true;
        }}
        onCompositionEnd={(event) => {
          if (geometryContainer.current?.contains(event.target as Node)) return;
          composing.current = false;
        }}
        onBlur={(event) => {
          if (geometryContainer.current?.contains(event.target)) return;
          if (event.target instanceof HTMLInputElement) save();
        }}
        onKeyDown={(event) => {
          if (geometryContainer.current?.contains(event.target as Node)) return;
          if (!active || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
            event.preventDefault();
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
        <PropertyTabs locked={locked}>
          <PropertyTab label="General" icon={SlidersHorizontal}>
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
                  readOnly={spiceAvailable && rows.some((row) => row.sourceKey)}
                  value={value}
                  disabled={!active}
                  onChange={(e) => {
                    if (active) setValue(e.target.value);
                  }}
                />
              </label>
            </div>
            <div className="property-fields">
              {renderFields(false)}
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
            </div>
            {geometryFields && <div ref={geometryContainer}>{geometryFields}</div>}
          </PropertyTab>
          {spiceAvailable && (
            <PropertyTab label="SPICE" icon={Activity}>
              <div className="property-simulation">
                {modelSelector()}
                <div className="property-fields">{renderFields(true)}</div>
              </div>
            </PropertyTab>
          )}
        </PropertyTabs>
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
              if (save(next, detail)) setRows(next);
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
    previous.modelFields === next.modelFields &&
    previous.circuit === next.circuit &&
    previous.onRequestSave === next.onRequestSave &&
    previous.active === next.active &&
    previous.locked === next.locked &&
    previous.spiceAvailable === next.spiceAvailable &&
    previous.fileId === next.fileId &&
    previous.getRevision === next.getRevision &&
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
