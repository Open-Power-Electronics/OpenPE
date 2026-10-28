/** Prefer current computed values over layout-resolved transforms.
 * Older or partial Typed OM implementations retain the resolved-style path. */
export function readLayoutCameraStyle(element: Element) {
  let computed: StylePropertyMapReadOnly | undefined;
  let resolved: CSSStyleDeclaration | undefined;
  try {
    if (typeof element.computedStyleMap === 'function') computed = element.computedStyleMap();
  } catch {
    // Typed OM is optional.
  }
  return (name: string): string => {
    try {
      const value = computed?.get(name)?.toString();
      if (value) return value;
    } catch {
      // A browser may expose the map without supporting this property.
    }
    return (resolved ??= getComputedStyle(element)).getPropertyValue(name);
  };
}
