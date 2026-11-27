import type { Project } from './project';
import type { Circuit } from './circuit';
import type { PCB } from './pcb';
import { isOwnedProjectNode, recordOwnedProjectNode } from './immutable-project-ownership.mjs';
import { MAX_NATIVE_PCB_NODES, MAX_PROJECT_NODES } from './project-size-limits';
export { isOwnedProjectNode } from './immutable-project-ownership.mjs';

// Detached trees and fresh arrays constructed by the private text parser qualify
// for identity-based caches. Object.isFrozen on caller input never establishes
// ownership or protects its nested objects. Semantic acceptance is separate.

export function isOwnedProject(project: Project): boolean {
  return isOwnedProjectNode(project);
}

/** Circuit serializers can reuse bytes only after the containing tree has been
 * detached by ownProject. Caller freezing never certifies a sheet. */
export function isOwnedCircuit(circuit: Circuit): boolean {
  return isOwnedProjectNode(circuit);
}

/** Board bytes can be reused only for a detached, internally owned tree. */
export function isOwnedPCB(board: PCB): boolean {
  return isOwnedProjectNode(board);
}

/** Detach caller data, retaining unchanged, already owned subtrees. Comparing
 * copied editor drafts also preserves identities when an editor cloned a sheet
 * or board before changing one object. */
export function ownProject(project: Project, previous?: Project | null): Project {
  const maxNodes = project.pcb && project.nativeFiles ? MAX_NATIVE_PCB_NODES : MAX_PROJECT_NODES;
  return ownProjectData(project, previous ?? undefined, maxNodes);
}

/** Detach private derived JSON data with the same ownership guarantees. This
 * certifies immutability only; semantic/schema acceptance is still separate. */
export function ownProjectData<T>(value: T, previous?: T, maxNodes = MAX_PROJECT_NODES): T {
  let nodes = 0;
  function copy(value: unknown, old: unknown, depth: number): unknown {
    if (depth > 80 || ++nodes > maxNodes)
      throw new Error(
        'Invalid OpenPE project: document nesting or object count exceeds the supported limit.',
      );
    if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value))
        throw new Error('Invalid OpenPE project: numbers must be finite.');
      return value;
    }
    if (!value || typeof value !== 'object')
      throw new Error('Invalid OpenPE project: only JSON values are allowed.');
    if (isOwnedProjectNode(value)) return value;
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (!array && prototype !== Object.prototype && prototype !== null)
      throw new Error('Invalid OpenPE project: only plain JSON objects are allowed.');
    const prior =
      old && typeof old === 'object' && isOwnedProjectNode(old) && Array.isArray(old) === array
        ? (old as Record<string, unknown>)
        : null;
    const entries = Object.entries(value);
    const oldKeys = prior ? Object.keys(prior) : [];
    let equal = !!prior && entries.length === oldKeys.length;
    const result: Record<string, unknown> = array
      ? (new Array((value as unknown[]).length) as unknown as Record<string, unknown>)
      : Object.create(prototype);
    if (array && prior && (value as unknown[]).length !== (old as unknown[]).length) equal = false;
    for (let index = 0; index < entries.length; index++) {
      const [key, nested] = entries[index];
      if (['__proto__', 'prototype', 'constructor'].includes(key))
        throw new Error(`Invalid OpenPE project: reserved key ${key}.`);
      const child = copy(nested, prior?.[key], depth + 1);
      result[key] = child;
      if (key !== oldKeys[index] || !Object.is(child, prior?.[key])) equal = false;
    }
    if (equal && prior && Object.getPrototypeOf(prior) === prototype) return prior;
    Object.freeze(result);
    recordOwnedProjectNode(result);
    return result;
  }
  return copy(value, previous, 0) as T;
}
