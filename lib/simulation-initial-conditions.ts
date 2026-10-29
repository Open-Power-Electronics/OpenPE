import type { Part } from './circuit';
import { partFields } from './library';
import { simulationParameterValue } from './simulation-parameters';

/** Two-terminal storage primitives; coupled windings have separate model rules. */
export function storagePrimitive(part: Part): 'C' | 'L' | null {
  if (/Coupled/.test(part.libId)) return null;
  const device = partFields(part)['Sim.Device'];
  if (device === 'C' || device === 'L') return device;
  if (/^Device:(?:C|CP)(?:_|$)/.test(part.libId)) return 'C';
  if (/^Device:L(?:_|$)/.test(part.libId) && !/Coupled/.test(part.libId)) return 'L';
  return null;
}

export function initialConditionField(kind: 'C' | 'L') {
  return kind === 'C' ? 'OpenPE.InitialVoltage' : 'OpenPE.InitialCurrent';
}

export function primitiveInitialCondition(
  kind: 'C' | 'L',
  fields: Record<string, string>,
  reference: string,
) {
  const name = initialConditionField(kind);
  const other = initialConditionField(kind === 'C' ? 'L' : 'C');
  if (fields[other] !== undefined)
    throw new Error(
      `${reference}: use ${kind === 'C' ? 'initial voltage for a capacitor' : 'initial current for an inductor'}.`,
    );
  return fields[name] === undefined
    ? undefined
    : simulationParameterValue(name, fields[name], reference);
}
