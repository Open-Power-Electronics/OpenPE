import { simulationFieldNames } from './simulation-fields';

// Closed SPICE numeric grammar shared by Properties and compilation.
export const simulationNumberLiteral =
  '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?(?:meg|[fpnumkgtµμ])?';

export function simulationNumber(text: string): number {
  if (!new RegExp(`^${simulationNumberLiteral}$`, 'i').test(text.trim()))
    throw new Error('Use a finite numeric simulation value.');
  const match = text.trim().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(.*)$/i)!;
  const scales: Record<string, number> = {
    f: 1e-15,
    p: 1e-12,
    n: 1e-9,
    u: 1e-6,
    µ: 1e-6,
    μ: 1e-6,
    m: 1e-3,
    k: 1e3,
    meg: 1e6,
    g: 1e9,
    t: 1e12,
  };
  const number = Number(match[1]) * (scales[match[2].toLowerCase()] ?? 1);
  if (!Number.isFinite(number) || Math.abs(number) > 1e12)
    throw new Error('Simulation value is out of range.');
  return number;
}

export function simulationParameterEntries(text: string, keys: readonly string[]) {
  const result: { key: string; value: string }[] = [];
  let rest = text.trim();
  const regex = new RegExp(`^([a-z][a-z0-9]*)\\s*=\\s*(${simulationNumberLiteral})(?:\\s+|$)`, 'i');
  while (rest) {
    const match = rest.match(regex),
      key = match?.[1].toLowerCase();
    if (!match || !key || !keys.includes(key) || result.some((entry) => entry.key === key))
      throw new Error(
        'Unsupported simulation parameter. Only the documented numeric parameters are accepted.',
      );
    simulationNumber(match[2]);
    result.push({ key, value: match[2] });
    rest = rest.slice(match[0].length);
  }
  return result;
}

export function numericSimulationParameters(
  text: string,
  keys: readonly string[],
): Record<string, number> {
  return Object.fromEntries(
    simulationParameterEntries(text, keys).map(({ key, value }) => [key, simulationNumber(value)]),
  );
}

export const editableSimulationParameters = [
  simulationFieldNames.seriesResistance,
  simulationFieldNames.initialVoltage,
  simulationFieldNames.initialCurrent,
  simulationFieldNames.coupling,
] as const;

export function simulationParameterValue(
  name: (typeof editableSimulationParameters)[number],
  text: string,
  reference = '',
): number {
  const number = simulationNumber(text);
  const prefix = reference ? `${reference}: ` : '';
  if (name === simulationFieldNames.seriesResistance && (number < 0 || number > 10))
    throw new Error(`${prefix}series resistance must be between 0 and 10 ohms.`);
  if (name === simulationFieldNames.initialVoltage && Math.abs(number) > 1000)
    throw new Error(`${prefix}initial voltage must be within ±1000 V.`);
  if (name === simulationFieldNames.coupling && (number <= 0 || number > 1))
    throw new Error(`${prefix}coupling must be greater than 0 and at most 1.`);
  return number;
}
