import type { Part } from './circuit';
import { partFields } from './library';
import {
  preparePartProperties,
  simulationSourceProperties,
  type FieldRow,
} from './part-properties';
import { basicSimulationKind } from './simulation-model-source';
import { simulationSourceValues, type SimulationSourceType } from './simulation-source-parameters';

/** One Properties transaction; symbol identity, geometry and external binding stay intact. */
export function prepareSourceConversion(
  part: Part,
  reference: string,
  value: string,
  rows: FieldRow[],
  type: SimulationSourceType,
) {
  if (basicSimulationKind(part) !== 'V' || !['DC', 'PULSE', 'SIN'].includes(type))
    throw new Error('Choose a compatible voltage source model.');
  const prepared = preparePartProperties(part, reference, value, rows);
  const accepted = prepared ? { ...part, ...prepared } : part;
  const fields = partFields(accepted);
  const source = simulationSourceProperties({
    ...accepted,
    fields: { ...fields, 'OpenPE.ModelSource': 'basic' },
  });
  const oldType = source?.type;
  if (!oldType)
    throw new Error('Select the intrinsic voltage source before changing its waveform.');
  const old = simulationSourceValues(
    oldType,
    fields['Sim.Params'] || '',
    accepted.value,
    accepted.ref,
  );
  if (oldType === type)
    return fields['OpenPE.ModelSource'] === 'external' ||
      (!fields['OpenPE.ModelSource'] && fields['Sim.Library'])
      ? {
          ref: accepted.ref,
          value: accepted.value,
          fields: { ...fields, 'OpenPE.ModelSource': 'basic', 'OpenPE.SourceType': type },
        }
      : prepared;
  const low = oldType === 'PULSE' ? old.y1 : oldType === 'SIN' ? (old.dc ?? 0) - old.ampl : 0;
  const high = oldType === 'PULSE' ? old.y2 : oldType === 'SIN' ? (old.dc ?? 0) + old.ampl : old.dc;
  const period = oldType === 'PULSE' ? old.per : oldType === 'SIN' ? 1 / old.f : 0.001;
  const params =
    type === 'DC'
      ? `dc=${oldType === 'SIN' ? (old.dc ?? 0) : high}`
      : type === 'PULSE'
        ? `y1=${low} y2=${high} td=${old.td ?? 0} tr=1n tf=1n tw=${period / 2} per=${period}`
        : `dc=${(low + high) / 2} ampl=${Math.abs(high - low) / 2} f=${1 / period} td=${old.td ?? 0}`;
  simulationSourceValues(type, params, accepted.value, accepted.ref);
  const genericValue =
    accepted.value === part.libId.split(':').at(-1) ||
    accepted.value === '${SIM.PARAMS}' ||
    (oldType === 'DC' && !fields['Sim.Params']);
  return {
    ref: accepted.ref,
    value: genericValue ? '${SIM.PARAMS}' : accepted.value,
    fields: {
      ...fields,
      'OpenPE.ModelSource': 'basic',
      'OpenPE.SourceType': type,
      'Sim.Params': params,
    },
  };
}
