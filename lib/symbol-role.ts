import type { Part } from './circuit';
import { child, val, type SExpr } from './sexpr';
import { partFootprint, propertyValue } from './library';

export const symbolRoles = {
  physical: { label: 'Physical component', color: '--symbol-physical' },
  virtual: { label: 'Virtual component · no footprint', color: '--symbol-virtual' },
  marker: { label: 'Electrical marker', color: '--symbol' },
} as const;

export const symbolRoleColors = {
  light: { '--symbol-physical': '#202020', '--symbol-virtual': '#b45309' },
  dark: { '--symbol-physical': '#f0f0f0', '--symbol-virtual': '#fbbf77' },
} as const;

/** A component without an assigned footprint is virtual, independently of model support. */
export function symbolRole(library: SExpr, part?: Pick<Part, 'libId' | 'raw' | 'fields'>) {
  // lib_name identifies a local drawing; lib_id retains its original catalog identity.
  const id =
    (part?.raw && child(part.raw, 'lib_name') && val(child(part.raw, 'lib_id'))) ||
    part?.libId ||
    val(library);
  if (id.startsWith('power:') || id === 'Simulation_SPICE:0' || child(library, 'power'))
    return 'marker';
  const footprint = part ? partFootprint(part) : propertyValue(library, 'Footprint').trim();
  return footprint ? 'physical' : 'virtual';
}
