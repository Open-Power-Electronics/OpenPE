export type LayoutNetEdges = readonly Readonly<{ netId: string }>[];

/** Keep only the net membership needed by the Nets panel. The caller supplies
 * its last committed snapshot; preparation never advances that baseline. */
export function createLayoutNetEdges() {
  const owned = new WeakSet<LayoutNetEdges>();
  return {
    prepare(edges: readonly { netId: string }[], previous: LayoutNetEdges | null): LayoutNetEdges {
      if (
        previous &&
        owned.has(previous) &&
        edges.length === previous.length &&
        edges.every((edge, index) => edge.netId === previous[index].netId)
      )
        return previous;
      const next = Object.freeze(edges.map((edge) => Object.freeze({ netId: edge.netId })));
      owned.add(next);
      return next;
    },
  };
}
