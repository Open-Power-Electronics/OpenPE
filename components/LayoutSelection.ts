'use client';

import { useCallback, useSyncExternalStore } from 'react';

/** Selection is presentation-only. Parent commits publish after render; each
 * drawing record subscribes only to its own IDs, preserving the rest of the SVG. */
export function createLayoutSelection() {
  let selected: ReadonlySet<string> = new Set();
  const listeners = new Map<string, Set<() => void>>();
  return {
    has: (id: string) => selected.has(id),
    subscribe: (id: string, listener: () => void) => {
      let entries = listeners.get(id);
      if (!entries) listeners.set(id, (entries = new Set()));
      entries.add(listener);
      return () => {
        entries.delete(listener);
        if (!entries.size && listeners.get(id) === entries) listeners.delete(id);
      };
    },
    update: (ids: ReadonlySet<string>, previewIds: ReadonlySet<string>) => {
      const next = new Set([...ids, ...previewIds]);
      const changed = [...selected].filter((id) => !next.has(id));
      for (const id of next) if (!selected.has(id)) changed.push(id);
      selected = next;
      const notify = new Set<() => void>();
      for (const id of changed)
        for (const listener of listeners.get(id) ?? []) notify.add(listener);
      for (const listener of notify) listener();
    },
  };
}

export type LayoutSelection = ReturnType<typeof createLayoutSelection>;

export function useLayoutSelection(selection: LayoutSelection, id: string, ownerId?: string) {
  const snapshot = useCallback(
    () => selection.has(id) || Boolean(ownerId && selection.has(ownerId)),
    [selection, id, ownerId],
  );
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribe = selection.subscribe(id, listener);
      const unsubscribeOwner =
        ownerId && ownerId !== id ? selection.subscribe(ownerId, listener) : undefined;
      return () => {
        unsubscribe();
        unsubscribeOwner?.();
      };
    },
    [selection, id, ownerId],
  );
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
