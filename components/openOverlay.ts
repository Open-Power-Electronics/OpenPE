const selector = 'dialog[open], [role="listbox"], [role="menu"]';
const registryKey = Symbol.for('openpe.overlay-query.v1');
type OverlayState = { dirty: boolean; open: boolean; observer: MutationObserver };
type Registry = WeakMap<Document, OverlayState>;

function registry(): Registry {
  // Development refresh can replace this module while the document survives.
  // Retain one observer per document across those replacements.
  const shared = globalThis as typeof globalThis & { [key: symbol]: unknown };
  let value = shared[registryKey] as Registry | undefined;
  if (!value) shared[registryKey] = value = new WeakMap();
  return value;
}

/** Same document-wide overlay predicate, without rescanning retained SVG trees
 * for every pointer/wheel event. Every selector-affecting mutation invalidates
 * it; takeRecords also covers mutations made in the current synchronous turn. */
export function hasOpenOverlay(root: Document = document): boolean {
  const states = registry();
  let state = states.get(root);
  if (!state) {
    const next = { dirty: true, open: false } as OverlayState;
    next.observer = new MutationObserver(() => {
      next.dirty = true;
    });
    next.observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['role', 'open'],
    });
    states.set(root, (state = next));
  }
  if (state.observer.takeRecords().length) state.dirty = true;
  if (state.dirty) {
    state.open = Boolean(root.querySelector(selector));
    state.dirty = false;
  }
  return state.open;
}
