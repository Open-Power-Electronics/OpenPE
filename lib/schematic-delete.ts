import { pinPositions, uid, type Circuit, type Point, type Wire } from './circuit';
import { child, quote } from './sexpr';
import { onWire, samePoint } from './wiring';

/** Remove a component's complete wire leads, stopping at surviving pins and
 * shared branches. Pure crossings are not vertices; labels do not join nets here. */
export function removePartConnections(source: Circuit, selected: ReadonlySet<string>): Circuit {
  const d = structuredClone(source);
  const removedParts = source.parts.filter((p) => selected.has(p.id));
  if (!removedParts.length) return d;
  const key = (p: Point) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
  const removedPins = removedParts.flatMap((p) => pinPositions(p, source.libraries[p.libId]));
  const remainingPins = source.parts
    .filter((p) => !selected.has(p.id))
    .flatMap((p) => pinPositions(p, source.libraries[p.libId]));
  const protectedPins = new Set(remainingPins.map(key));
  const points: Point[] = [];
  const nodes = new Map<string, number>();
  const add = (p: Point) => {
    const k = key(p);
    const previous = nodes.get(k);
    if (previous !== undefined) return previous;
    if (points.length >= 30000)
      throw new Error(
        'The schematic connections exceed 30,000 anchors. Remove unnecessary wires or junctions before deleting components.',
      );
    nodes.set(k, points.length);
    points.push(p);
    return points.length - 1;
  };
  const splits = source.wires.map((w) => [add(w.a), add(w.b)]);
  for (const junction of source.junctions) add(junction);

  // Index candidate wires before testing endpoint-on-segment T connections.
  // Bound both long-wire indexing and geometry work for large imported drawings.
  const cell = 10;
  const buckets = new Map<string, number[]>();
  const long: number[] = [];
  source.wires.forEach((w, i) => {
    const minX = Math.floor((Math.min(w.a.x, w.b.x) - 0.0001) / cell);
    const maxX = Math.floor((Math.max(w.a.x, w.b.x) + 0.0001) / cell);
    const minY = Math.floor((Math.min(w.a.y, w.b.y) - 0.0001) / cell);
    const maxY = Math.floor((Math.max(w.a.y, w.b.y) + 0.0001) / cell);
    if ((maxX - minX + 1) * (maxY - minY + 1) > 256) {
      long.push(i);
      return;
    }
    for (let x = minX; x <= maxX; x++)
      for (let y = minY; y <= maxY; y++) {
        const k = `${x},${y}`;
        const list = buckets.get(k) || [];
        list.push(i);
        buckets.set(k, list);
      }
  });
  let checks = 0;
  points.forEach((p, node) => {
    const candidates = [
      ...(buckets.get(`${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`) || []),
      ...long,
    ];
    checks += candidates.length;
    if (checks > 10000000)
      throw new Error(
        'The schematic connections exceed the geometry work limit. Reduce long or overlapping wires before deleting components.',
      );
    for (const i of candidates) if (onWire(p, source.wires[i])) splits[i].push(node);
  });
  const edges: { wire: number; a: number; b: number }[] = [];
  const incident = points.map(() => new Set<number>());
  const wireEdges = source.wires.map((w, i) => {
    const ordered = [...new Set(splits[i])].sort(
      (a, b) =>
        Math.hypot(points[a].x - w.a.x, points[a].y - w.a.y) -
        Math.hypot(points[b].x - w.a.x, points[b].y - w.a.y),
    );
    return ordered.slice(1).map((b, j) => {
      const a = ordered[j];
      const index = edges.length;
      if (index >= 100000)
        throw new Error(
          'The schematic connections exceed the editing graph limit. Reduce overlapping wires before deleting components.',
        );
      edges.push({ wire: i, a, b });
      incident[a].add(index);
      incident[b].add(index);
      return index;
    });
  });
  const queue = removedPins.flatMap((p) => {
    const node = nodes.get(key(p));
    return node === undefined ? [] : [node];
  });
  const removed = new Set<number>();
  for (const [index, edge] of edges.entries())
    if (selected.has(source.wires[edge.wire].id)) {
      removed.add(index);
      incident[edge.a].delete(index);
      incident[edge.b].delete(index);
    }
  // Entire unanchored wire islands (including closed loops) belong to the
  // removed components. Visit each island once, without following named nets.
  const visited = new Set<number>();
  for (const start of queue) {
    if (visited.has(start)) continue;
    const island = [start];
    const islandEdges = new Set<number>();
    let anchored = false;
    visited.add(start);
    for (let i = 0; i < island.length; i++) {
      const node = island[i];
      if (protectedPins.has(key(points[node]))) anchored = true;
      for (const index of incident[node]) {
        islandEdges.add(index);
        const edge = edges[index];
        const other = edge.a === node ? edge.b : edge.a;
        if (!visited.has(other)) {
          visited.add(other);
          island.push(other);
        }
      }
    }
    if (!anchored)
      for (const index of islandEdges) {
        removed.add(index);
        incident[edges[index].a].delete(index);
        incident[edges[index].b].delete(index);
      }
  }
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i];
    if (protectedPins.has(key(points[node])) || incident[node].size !== 1) continue;
    const index = incident[node].values().next().value!;
    const edge = edges[index];
    removed.add(index);
    incident[edge.a].delete(index);
    incident[edge.b].delete(index);
    queue.push(edge.a === node ? edge.b : edge.a);
  }
  const removedSegments = [...removed].map((i) => {
    const edge = edges[i];
    return { id: source.wires[edge.wire].id, a: points[edge.a], b: points[edge.b] };
  });
  d.wires = source.wires.flatMap((w, i) => {
    const indices = wireEdges[i];
    if (!indices.some((index) => removed.has(index))) return [structuredClone(w)];
    // Rejoin untouched consecutive pieces without normalizing other source wires.
    const retained: Wire[] = [];
    let current: Wire | undefined;
    for (const index of indices) {
      if (removed.has(index)) {
        current = undefined;
        continue;
      }
      const edge = edges[index];
      if (current) current.b = { ...points[edge.b] };
      else {
        current = { ...structuredClone(w), a: { ...points[edge.a] }, b: { ...points[edge.b] } };
        if (retained.length) {
          current.id = uid();
          if (current.raw) child(current.raw, 'uuid')![1] = quote(current.id);
        }
        retained.push(current);
      }
    }
    return retained;
  });
  const detached = (p: Point) =>
    !protectedPins.has(key(p)) &&
    (removedPins.some((pin) => samePoint(pin, p)) || removedSegments.some((w) => onWire(p, w))) &&
    !d.wires.some((w) => onWire(p, w));
  d.labels = d.labels.filter((p) => !detached(p));
  d.junctions = d.junctions.filter((p) => !detached(p));
  if (d.noConnects) d.noConnects = d.noConnects.filter((p) => !detached(p));
  return d;
}
