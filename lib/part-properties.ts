import type { Part } from './circuit';
import { displayPartValue, partFields, singleSimulationParameter } from './library';

export type FieldRow = { name: string; value: string; fresh?: boolean };

// A blur with no changes must not dirty the project or add optional empty fields.
export function preparePartProperties(
  part: Part,
  reference: string,
  value: string,
  rows: FieldRow[],
) {
  const pending = rows.filter((row) => !(row.fresh && !row.name.trim() && !row.value));
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
  const current = partFields(part);
  const fields = Object.fromEntries(pending.map((row, i) => [names[i], row.value]));
  if (!Object.hasOwn(current, 'Footprint') && fields.Footprint === '') delete fields.Footprint;
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
  if (
    ref === part.ref &&
    storedValue === part.value &&
    Object.keys(fields).length === Object.keys(current).length &&
    Object.entries(fields).every(([name, text]) => current[name] === text)
  )
    return null;
  return { ref, value: storedValue, fields };
}
