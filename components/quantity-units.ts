export type QuantityUnit = { label: string; factor: number; offset?: number };

export function formatFixedQuantity(value: number, decimalPlaces = 2): string {
  const display = value.toFixed(decimalPlaces);
  return Number(display) === 0 ? (0).toFixed(decimalPlaces) : display;
}

const prefixes = [
  ['p', 1e-12],
  ['n', 1e-9],
  ['µ', 1e-6],
  ['m', 1e-3],
  ['', 1],
  ['k', 1e3],
  ['M', 1e6],
  ['G', 1e9],
] as const;
const electrical = ['s', 'Hz', 'V', 'A', 'W', 'Ω', 'F', 'H', '1/s', 'W/m·K', 'W/m²·K'];
const lengths: QuantityUnit[] = [
  { label: 'µm', factor: 1e-6 },
  { label: 'mm', factor: 1e-3 },
  { label: 'cm', factor: 1e-2 },
  { label: 'm', factor: 1 },
  { label: 'mil', factor: 0.0000254 },
  { label: 'in', factor: 0.0254 },
];
const angles: QuantityUnit[] = [
  { label: '°', factor: 1 },
  { label: 'rad', factor: 180 / Math.PI },
];
const temperatures: QuantityUnit[] = [
  { label: '°C', factor: 1 },
  { label: 'K', factor: 1, offset: -273.15 },
];

function shiftDecimal(value: number, exponent: number) {
  const [mantissa, power = '0'] = String(value).toLowerCase().split('e');
  return Number(`${mantissa}e${Number(power) + exponent}`);
}

export function convertQuantity(value: number, from: QuantityUnit, to: QuantityUnit) {
  const fromExponent = Math.log10(from.factor);
  const toExponent = Math.log10(to.factor);
  if (!from.offset && !to.offset && Number.isInteger(fromExponent) && Number.isInteger(toExponent))
    return shiftDecimal(value, fromExponent - toExponent);
  return (value * from.factor + (from.offset ?? 0) - (to.offset ?? 0)) / to.factor;
}

export function quantityUnits(unit: string): QuantityUnit[] {
  if (lengths.some((entry) => entry.label === unit)) return lengths;
  if (angles.some((entry) => entry.label === unit)) return angles;
  if (temperatures.some((entry) => entry.label === unit)) return temperatures;
  for (const base of electrical) {
    const options = prefixes.map(([prefix, factor]) => ({ label: `${prefix}${base}`, factor }));
    if (options.some((entry) => entry.label === unit)) return options;
  }
  return [{ label: unit, factor: 1 }];
}

export function quantityUnitFromLabel(label: string) {
  return /\((mm|cm|µm|m|mil|in|°|degrees|%|s|ms|µs|Hz|kHz|MHz|V|A|W|°C)\)$/
    .exec(label)?.[1]
    ?.replace('degrees', '°');
}

export function quantityLabel(label: string) {
  return quantityUnitFromLabel(label) ? label.replace(/\s*\([^)]*\)$/, '') : label;
}

export function readQuantity(text: string, unit: string): number {
  if (!text.trim()) return NaN;
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text.trim())) return Number(text);
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(.*)$/i.exec(text.trim());
  if (!match) return NaN;
  const options = quantityUnits(unit);
  const canonical = options.find((entry) => entry.label === unit)!;
  const suffix = match[2].replace(/u|μ/g, 'µ');
  const explicit = options.find((entry) => entry.label === suffix);
  if (explicit) return convertQuantity(Number(match[1]), explicit, canonical);
  // Existing SPICE parameter drafts use a bare SI prefix in their base unit.
  const prefix = prefixes.find(
    ([name]) => name === suffix || (suffix.toLowerCase() === 'meg' && name === 'M'),
  );
  return prefix ? shiftDecimal(Number(match[1]), Math.log10(prefix[1])) : NaN;
}

export function preferredQuantityUnit(value: string, unit: string) {
  const options = quantityUnits(unit);
  const canonical = options.find((entry) => entry.label === unit)!;
  const number = readQuantity(value, unit);
  if (!Number.isFinite(number) || number === 0 || canonical.offset !== undefined) return unit;
  const magnitude = Math.abs(number * canonical.factor);
  return (
    options.find((entry) => magnitude / entry.factor >= 1 && magnitude / entry.factor < 1000)
      ?.label ?? unit
  );
}
