import type { Project } from './project';
import { isOwnedProjectNode } from './immutable-project';

// ProjectCore accepts plain JSON data. Match JSON's ordered object keys and
// optional array-slot values without materializing the entire PCB as text.
function absent(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

function jsonSlot(value: unknown): unknown {
  return absent(value) || (typeof value === 'number' && !Number.isFinite(value)) ? null : value;
}

function orderedJsonEqual(left: unknown, right: unknown): boolean {
  left = jsonSlot(left);
  right = jsonSlot(right);
  if (left === right && (left === null || typeof left !== 'object' || isOwnedProjectNode(left)))
    return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
    return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    // Index every slot, including holes that JSON writes as null.
    for (let index = 0; index < left.length; index++)
      if (!orderedJsonEqual(left[index], right[index])) return false;
    return true;
  }
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const aKeys = Object.keys(a).filter((key) => !absent(a[key]));
  const bKeys = Object.keys(b).filter((key) => !absent(b[key]));
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((key, index) => key === bKeys[index] && orderedJsonEqual(a[key], b[key]))
  );
}

/** The exact [name, pcb, extensions] JSON comparison used by sheet dirty dots.
 * Inputs are validated ProjectCore snapshots; no native-byte or hash proxy. */
export function projectMetadataEqual(
  left: Project | null | undefined,
  right: Project | null | undefined,
): boolean {
  return (
    orderedJsonEqual(left?.name, right?.name) &&
    orderedJsonEqual(left?.pcb, right?.pcb) &&
    orderedJsonEqual(left?.extensions, right?.extensions)
  );
}
