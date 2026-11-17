type Interval = { minX: number; maxX: number };
type Branch = Interval & { start: number; end: number; left?: Branch; right?: Branch };

/** Broad phase for privately prepared stationary contacts. Snapshot bounds and
 * visit matches in the input order, preserving the exact contact/work ledger. */
export function createPCBContactIntervals<T extends Interval>(items: readonly T[]) {
  const entries = items.map((item) => ({ item, minX: item.minX, maxX: item.maxX }));
  if (
    entries.some(
      ({ minX, maxX }) => !Number.isFinite(minX) || !Number.isFinite(maxX) || minX > maxX,
    )
  )
    throw new Error('Track contact bounds must be finite and ordered.');
  const build = (start: number, end: number): Branch => {
    if (end - start <= 8) {
      let minX = Infinity,
        maxX = -Infinity;
      for (let index = start; index < end; index++) {
        minX = Math.min(minX, entries[index].minX);
        maxX = Math.max(maxX, entries[index].maxX);
      }
      return { start, end, minX, maxX };
    }
    const middle = Math.floor((start + end) / 2);
    const left = build(start, middle),
      right = build(middle, end);
    return {
      start,
      end,
      minX: Math.min(left.minX, right.minX),
      maxX: Math.max(left.maxX, right.maxX),
      left,
      right,
    };
  };
  const root = entries.length ? build(0, entries.length) : undefined;
  return (minX: number, maxX: number, tolerance: number, visit: (item: T) => void) => {
    if (![minX, maxX, tolerance].every(Number.isFinite) || minX > maxX || tolerance < 0)
      throw new Error('Track contact query bounds and tolerance must be finite and ordered.');
    const scan = (node: Branch) => {
      if (node.minX > maxX + tolerance || node.maxX + tolerance < minX) return;
      if (node.left && node.right) {
        scan(node.left);
        scan(node.right);
      } else
        for (let index = node.start; index < node.end; index++) {
          const entry = entries[index];
          if (entry.minX <= maxX + tolerance && entry.maxX + tolerance >= minX) visit(entry.item);
        }
    };
    if (root) scan(root);
  };
}
