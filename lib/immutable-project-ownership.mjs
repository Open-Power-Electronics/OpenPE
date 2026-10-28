// One private ownership registry is shared by editor code and generated schema
// validators. The detaching copier and private fresh-text parser record nodes;
// caller freezing is inert. Ownership certifies immutability, never validity.
const ownedNodes = new WeakSet();

/** @param {object} value */
export function isOwnedProjectNode(value) {
  return ownedNodes.has(value);
}

/** @param {object} value */
export function recordOwnedProjectNode(value) {
  ownedNodes.add(value);
}
