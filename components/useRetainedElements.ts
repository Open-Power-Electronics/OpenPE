import { useLayoutEffect, useMemo, useRef, type DependencyList, type ReactElement } from 'react';

/** Retain an element and its drawing when its flat presentation props agree.
 * Inputs must include every value used to build those props, including objects.
 * The dependency-keyed pending map stays paired with memoized layer elements
 * through StrictMode replay; only a committed render replaces the live cache. */
export default function useRetainedElements(
  objects: readonly { id: string }[],
  inputs: DependencyList,
) {
  const entries = useRef(new Map<string, { props: object; element: ReactElement }>());
  const pending = useMemo(() => new Map(entries.current), inputs);
  useLayoutEffect(() => {
    const ids = new Set(objects.map((object) => object.id));
    for (const id of pending.keys()) if (!ids.has(id)) pending.delete(id);
    entries.current = pending;
  }, [pending, objects]);
  return <P extends { key: string }>(props: P, render: (props: P) => ReactElement) => {
    const previous = pending.get(props.key);
    if (previous) {
      const keys = Object.keys(props) as (keyof P)[];
      if (
        keys.length === Object.keys(previous.props).length &&
        keys.every((key) => Object.is(props[key], (previous.props as P)[key]))
      )
        return previous.element;
    }
    const element = render(props);
    pending.set(props.key, { props, element });
    return element;
  };
}
