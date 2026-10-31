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

export type SpiceInitialCondition = {
  kind: 'C' | 'L';
  positive: string;
  negative: string;
  value: number;
  /** The compiler's series node when the original positive terminal is ground. */
  groundedSeriesNode?: string;
};

/** Preserve capacitor voltages without zero-initializing every model-internal node.
 * Only ground-referenced voltage constraints determine absolute node potentials.
 * Floating constraints and explicit inductor currents still require device IC/UIC.
 */
export function spiceInitialConditions(
  conditions: SpiceInitialCondition[],
  skipOperatingPoint = false,
): { lines: string[]; uic: boolean } {
  if (skipOperatingPoint || conditions.some(({ kind }) => kind === 'L'))
    return { lines: [], uic: true };
  const edges = conditions.flatMap(({ positive, negative, value, groundedSeriesNode }) => [
    { positive, negative, value },
    ...(groundedSeriesNode ? [{ positive: groundedSeriesNode, negative: '0', value: 0 }] : []),
  ]);
  const voltages = new Map([['0', 0]]);
  let pending = edges;
  while (pending.length) {
    const remaining: typeof edges = [];
    for (const edge of pending) {
      const positive = voltages.get(edge.positive),
        negative = voltages.get(edge.negative);
      if (positive !== undefined && negative !== undefined) {
        if (Math.abs(positive - negative - edge.value) > 1e-9 * Math.max(1, Math.abs(edge.value)))
          throw new Error('Conflicting capacitor initial voltages on connected nodes.');
      } else if (positive !== undefined) voltages.set(edge.negative, positive - edge.value);
      else if (negative !== undefined) voltages.set(edge.positive, negative + edge.value);
      else remaining.push(edge);
    }
    if (remaining.length === pending.length) return { lines: [], uic: true };
    pending = remaining;
  }
  const values = [...voltages].filter(([node]) => node !== '0');
  return {
    lines: values.length
      ? [`.ic ${values.map(([node, value]) => `v(${node})=${value}`).join(' ')}`]
      : [],
    uic: false,
  };
}
