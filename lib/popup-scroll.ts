// Sibling panels scroll independently. Only scrolling an anchor's ancestors
// (including the document viewport) can move a popup away from its trigger.
export function scrollMovesAnchor(event: Event, anchor: Element | null): boolean {
  if (!anchor) return false;
  const target = event.target;
  return target === window || (target instanceof Node && target.contains(anchor));
}
