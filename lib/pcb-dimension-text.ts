import type { BoardLine } from './pcb';

type Dimension = NonNullable<BoardLine['dimension']>;

/** Native dimensions append unit text before their user-supplied suffix. */
export function pcbDimensionUnitSuffix(dimension: Dimension): string | null {
  const format = dimension.format;
  if (format.unitsFormat === 0) return '';
  if (format.unitsFormat !== 1 && format.unitsFormat !== 2) return null;
  const fixedUnit = ['in', 'mils', 'mm'][format.units];
  if (fixedUnit) return format.unitsFormat === 1 ? ` ${fixedUnit}` : ` (${fixedUnit})`;
  // Automatic units belong to the native editor's display preference, which is
  // not design data. Retain the unit resolved in the loaded caption.
  const caption =
    format.suffix && dimension.caption.value.endsWith(format.suffix)
      ? dimension.caption.value.slice(0, -format.suffix.length)
      : dimension.caption.value;
  return (
    caption.match(format.unitsFormat === 1 ? / (?:in|mils|mm)$/ : / \((?:in|mils|mm)\)$/)?.[0] ??
    null
  );
}

/** The editable value excludes the separately retained prefix, units and suffix. */
export function pcbDimensionOverrideValue(dimension: Dimension): string {
  const format = dimension.format;
  if (format.overrideValue !== undefined) return format.overrideValue;
  let value = dimension.caption.value;
  if (format.prefix && value.startsWith(format.prefix)) value = value.slice(format.prefix.length);
  if (format.suffix && value.endsWith(format.suffix)) value = value.slice(0, -format.suffix.length);
  const units = pcbDimensionUnitSuffix(dimension);
  if (units && value.endsWith(units)) value = value.slice(0, -units.length);
  return value;
}

/** Keep the rendered caption and KiCad's authoritative override in one edit. */
export function setPCBDimensionOverrideValue(dimension: Dimension, value: string): Dimension {
  const units = pcbDimensionUnitSuffix(dimension);
  if (units === null)
    throw new Error('The stored dimension caption does not identify its automatic units.');
  return {
    ...dimension,
    format: { ...dimension.format, overrideValue: value },
    caption: {
      ...dimension.caption,
      value: dimension.format.prefix + value + units + dimension.format.suffix,
    },
  };
}
