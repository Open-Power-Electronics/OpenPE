import {
  createElement,
  Fragment,
  useLayoutEffect,
  useMemo,
  useRef,
  type DependencyList,
  type ReactElement,
} from 'react';

type Entry = { children: readonly ReactElement[]; element: ReactElement };

/** Retain small ordered child subtrees without adding SVG/DOM containers.
 * Inputs must match the memo that calls this hook's returned builder. Pending
 * entries stay paired with that memo through replay; abandoned renders never
 * replace the committed cache. Child subscriptions can still update a retained
 * Fragment independently of its parent's drawing props. */
export default function useRetainedElementBatches(inputs: DependencyList) {
  const entries = useRef(new Map<string, Entry>());
  const pending = useMemo(
    () => ({ entries: new Map(entries.current), used: new Set<string>() }),
    inputs,
  );
  useLayoutEffect(() => {
    for (const key of pending.entries.keys())
      if (!pending.used.has(key)) pending.entries.delete(key);
    entries.current = pending.entries;
  }, [pending]);

  return (scope: string, children: readonly ReactElement[], size = 32): ReactElement[] => {
    if (!Number.isSafeInteger(size) || size < 1) throw new Error('Invalid element batch size.');
    const batches: ReactElement[] = [];
    for (let start = 0; start < children.length; start += size) {
      const key = JSON.stringify([scope, size, start / size]);
      pending.used.add(key);
      const previous = pending.entries.get(key);
      const length = Math.min(size, children.length - start);
      if (
        previous &&
        previous.children.length === length &&
        previous.children.every((child, index) => child === children[start + index])
      ) {
        batches.push(previous.element);
        continue;
      }
      // Own the ordered array and protect the copy exposed as Fragment children.
      // Replacing the caller's presentation container cannot alter this entry.
      const ordered = Object.freeze(children.slice(start, start + size));
      const element = createElement(Fragment, { key }, ordered);
      pending.entries.set(key, { children: ordered, element });
      batches.push(element);
    }
    return batches;
  };
}
