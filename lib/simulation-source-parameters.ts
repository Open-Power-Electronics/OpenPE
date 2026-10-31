import { numericSimulationParameters } from './simulation-parameters';

export const sourceParameterSpecs = {
  DC: [{ key: 'dc', label: 'Voltage', unit: 'V', required: true }],
  PULSE: [
    { key: 'y1', label: 'Initial voltage', unit: 'V', required: true },
    { key: 'y2', label: 'Pulsed voltage', unit: 'V', required: true },
    { key: 'td', label: 'Delay', unit: 's', required: true },
    { key: 'tr', label: 'Rise time', unit: 's', required: true },
    { key: 'tf', label: 'Fall time', unit: 's', required: true },
    { key: 'tw', label: 'Pulse width', unit: 's', required: true },
    { key: 'per', label: 'Period', unit: 's', required: true },
  ],
  SIN: [
    { key: 'dc', label: 'Offset', unit: 'V', required: false },
    { key: 'ampl', label: 'Amplitude', unit: 'V', required: true },
    { key: 'f', label: 'Frequency', unit: 'Hz', required: true },
    { key: 'td', label: 'Delay', unit: 's', required: false },
    { key: 'theta', label: 'Damping', unit: '1/s', required: false },
    { key: 'phase', label: 'Phase', unit: '°', required: false },
    { key: 'ac', label: 'AC magnitude', unit: 'V', required: false },
  ],
} as const;
export type SimulationSourceType = keyof typeof sourceParameterSpecs;

export function simulationSourceParameterSpecs(type: SimulationSourceType, device: string) {
  return sourceParameterSpecs[type].map((spec) => ({
    ...spec,
    label:
      device === 'I'
        ? spec.label.replace(/voltage/i, (word) => (word === 'Voltage' ? 'Current' : 'current'))
        : spec.label,
    unit: device === 'I' && spec.unit === 'V' ? 'A' : spec.unit,
  }));
}

export function simulationSourceExpression(
  type: string,
  text: string,
  value: string,
  reference: string,
) {
  const values = simulationSourceValues(type, text, value, reference);
  if (type === 'DC') return `DC ${values.dc}`;
  if (type === 'PULSE')
    return `PULSE(${['y1', 'y2', 'td', 'tr', 'tf', 'tw', 'per'].map((key) => values[key]).join(' ')})`;
  return `SIN(${[values.dc ?? 0, values.ampl, values.f, values.td ?? 0, values.theta ?? 0, values.phase ?? 0].join(' ')})`;
}

export function simulationSourceValues(
  type: string,
  text: string,
  literalValue: string,
  reference: string,
): Record<string, number> {
  if (!Object.hasOwn(sourceParameterSpecs, type))
    throw new Error(`${reference}: unsupported source type.`);
  const values = numericSimulationParameters(
    text,
    sourceParameterSpecs[type as SimulationSourceType].map((spec) => spec.key),
  );
  if (type === 'DC') {
    // DC sources may store their literal in Value instead of Sim.Params.
    const dc = text ? values.dc : numericSimulationParameters(`dc=${literalValue}`, ['dc']).dc;
    if (!Number.isFinite(dc) || Math.abs(dc) > 10000)
      throw new Error(`${reference}: invalid DC source level.`);
    return { dc };
  }
  if (type === 'PULSE') {
    if (
      sourceParameterSpecs.PULSE.some(({ key }) => values[key] === undefined) ||
      ['td', 'tr', 'tf', 'tw'].some((key) => values[key] < 0) ||
      values.per <= 0
    )
      throw new Error(`${reference}: invalid PULSE parameters.`);
  } else if (values.ampl === undefined || !(values.f > 0) || (values.td ?? 0) < 0)
    throw new Error(`${reference}: invalid SIN parameters.`);
  return values;
}
