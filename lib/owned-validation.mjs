import { isOwnedProjectNode } from './immutable-project-ownership.mjs';

// A result belongs to one generated, data-only schema function and one exact
// immutable node. Failed checks and caller-frozen/mutable data are never cached.
const successful = new WeakMap();

export function wasValidatedOwned(validator, value) {
  return !!value && typeof value === 'object' && (successful.get(validator)?.has(value) ?? false);
}

export function rememberValidatedOwned(validator, value, valid) {
  if (valid && value && typeof value === 'object' && isOwnedProjectNode(value)) {
    let accepted = successful.get(validator);
    if (!accepted) successful.set(validator, (accepted = new WeakSet()));
    accepted.add(value);
  }
  return valid;
}
