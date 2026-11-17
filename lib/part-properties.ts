import { snap, type Part } from './circuit';
import { displayPartValue, partFields, singleSimulationParameter } from './library';
import { editableSimulationParameters, simulationParameterValue } from './simulation-parameters';
import { simulationParameterEntries } from './simulation-parameters';
import { storagePrimitive, initialConditionField } from './simulation-initial-conditions';
import {
  simulationModelSource,
  basicSimulationAvailable,
  effectiveSimulationModelFields,
} from './simulation-model-source';
import {
  sourceParameterSpecs,
  simulationSourceParameterSpecs,
  simulationSourceValues,
  type SimulationSourceType,
} from './simulation-source-parameters';

export type FieldRow = { name: string; value: string; fresh?: boolean; sourceKey?: string };

/** Numeric Properties edits use one precision/grid rule for both clients. */
export function preparePartGeometry(key: 'x' | 'y' | 'rotation', value: number): number {
  const limit = key === 'rotation' ? 360 : 100000;
  if (!Number.isFinite(value) || Math.abs(value) > limit)
    throw new Error(
      `${key === 'rotation' ? 'Rotation' : 'Position'} is outside the supported range.`,
    );
  const next =
    key === 'rotation'
      ? Number((((Number(value.toFixed(4)) % 360) + 360) % 360).toFixed(4))
      : snap(value);
  if (Math.abs(next) > limit) throw new Error('Position is outside the supported grid range.');
  return next;
}

export function simulationSourceProperties(part: Part) {
  const stored = partFields(part);
  const fields =
      simulationModelSource(stored) === 'basic' && basicSimulationAvailable(part)
        ? effectiveSimulationModelFields(part, stored)
        : stored,
    type = fields['Sim.Type'];
  if (!['V', 'I'].includes(fields['Sim.Device']) || !Object.hasOwn(sourceParameterSpecs, type))
    return null;
  const specs = simulationSourceParameterSpecs(type as SimulationSourceType, fields['Sim.Device']);
  let entries;
  try {
    entries = simulationParameterEntries(
      fields['Sim.Params'] || '',
      specs.map(({ key }) => key),
    );
  } catch {
    return null; // Unsupported parameter text keeps its existing native Value editor.
  }
  return {
    type: type as SimulationSourceType,
    rows: specs.map((spec) => ({
      name: 'Sim.Params',
      sourceKey: spec.key,
      value:
        entries.find(({ key }) => key === spec.key)?.value ??
        (type === 'DC' && !fields['Sim.Params'] ? part.value : ''),
      label: `${spec.label} (${spec.unit})`,
      unit: spec.unit,
      optional: !spec.required,
    })),
  };
}

// A blur with no changes must not dirty the project or add optional empty fields.
export function preparePartProperties(
  part: Part,
  reference: string,
  value: string,
  rows: FieldRow[],
) {
  const current = partFields(part);
  const primitive = storagePrimitive(part);
  const initialField = primitive && initialConditionField(primitive);
  const sourceRows = rows.filter((row) => row.sourceKey);
  if (sourceRows.length) {
    const source = simulationSourceProperties(part);
    if (
      !source ||
      sourceRows.length !== source.rows.length ||
      sourceRows.some(
        (row, i) => row.name !== 'Sim.Params' || row.sourceKey !== source.rows[i].sourceKey,
      )
    )
      throw new Error('The source parameters changed. Select the source again.');
    const changed = sourceRows.some((row, i) => row.value !== source.rows[i].value);
    const params = changed
      ? sourceRows
          .filter((row) => row.value.trim())
          .map((row) => `${row.sourceKey}=${row.value.trim()}`)
          .join(' ')
      : current['Sim.Params'];
    if (changed) {
      simulationSourceValues(source.type, params || '', sourceRows[0].value, reference);
      if (part.value === '${SIM.PARAMS}')
        value = singleSimulationParameter(params!)?.value ?? params!;
      else if (!current['Sim.Params'] && source.type === 'DC') value = sourceRows[0].value;
    }
    let emitted = false;
    rows = rows.flatMap((row) => {
      if (!row.sourceKey) return [row];
      if (emitted) return [];
      emitted = true;
      return current['Sim.Params'] !== undefined || (changed && source.type !== 'DC')
        ? [{ name: 'Sim.Params', value: params! }]
        : [];
    });
  }
  const pending = rows.filter(
    (row) =>
      !(row.fresh && !row.name.trim() && !row.value) &&
      !(row.name === initialField && !row.value.trim() && current[row.name] !== row.value),
  );
  const names = pending.map((row) => row.name.trim());
  const ref = reference.trim();
  if (
    !ref ||
    !value.trim() ||
    names.some(
      (name) =>
        !name || ['Reference', 'Value', '__proto__', 'constructor', 'prototype'].includes(name),
    ) ||
    new Set(names).size !== names.length
  )
    throw new Error('Use a reference, a value and unique, non-empty field names.');
  const fields = Object.fromEntries(pending.map((row, i) => [names[i], row.value]));
  if (!Object.hasOwn(current, 'Footprint') && fields.Footprint === '') delete fields.Footprint;
  for (const name of editableSimulationParameters)
    if (fields[name] !== undefined && fields[name] !== current[name])
      simulationParameterValue(name, fields[name], ref);
  // The inspector edits the displayed value. Merely viewing an expanded value
  // must not replace its template or overwrite edits made in the field table.
  const displayed = displayPartValue(part);
  let storedValue = value === displayed ? part.value : value;
  if (
    part.value === '${SIM.PARAMS}' &&
    current['Sim.Params'] &&
    value !== displayed &&
    !value.includes('${SIM.PARAMS}')
  ) {
    const parameter = singleSimulationParameter(current['Sim.Params']);
    if (parameter && /[=\s]/.test(value.trim()))
      throw new Error('Enter only the component value, without a parameter name or spaces.');
    fields['Sim.Params'] = parameter
      ? `${parameter.prefix}${value.trim()}${parameter.suffix}`
      : value;
    storedValue = part.value;
  }
  const effectiveFields = effectiveSimulationModelFields(part, fields);
  const sourceType = effectiveFields['Sim.Type'];
  if (
    ['V', 'I'].includes(effectiveFields['Sim.Device']) &&
    Object.hasOwn(sourceParameterSpecs, sourceType) &&
    (fields['Sim.Params'] !== current['Sim.Params'] || storedValue !== part.value)
  )
    simulationSourceValues(
      sourceType as SimulationSourceType,
      fields['Sim.Params'] || '',
      storedValue,
      ref,
    );
  if (
    ref === part.ref &&
    storedValue === part.value &&
    Object.keys(fields).length === Object.keys(current).length &&
    Object.entries(fields).every(([name, text]) => current[name] === text)
  )
    return null;
  return { ref, value: storedValue, fields };
}
