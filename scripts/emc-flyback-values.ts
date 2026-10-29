import type { Circuit } from '../lib/circuit';

/** Build-only cleanup of the pinned demo's passive values. Keep the original
 * rating, dielectric, package or series text in an ordinary native field. */
export function emcFlybackPassiveValue(ref: string, value: string) {
  if (!/^[RCL]\d+$/.test(ref)) return { value, specifications: '' };
  const [nominal, ...details] = value.trim().split(/\s+/);
  return { value: nominal, specifications: details.join(' ') };
}

export function prepareEmcFlybackValues(circuit: Circuit) {
  for (const part of circuit.parts) {
    const { value, specifications } = emcFlybackPassiveValue(part.ref, part.value);
    part.value = value;
    if (specifications) part.fields = { ...part.fields, Specifications: specifications };
  }
}
