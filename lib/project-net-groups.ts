import { pinPositions, type Circuit, type Point } from './circuit';
import { unitGraphics } from './library';
import { child, children, val } from './sexpr';
import { isOwnedCircuit } from './immutable-project';

type Group = { wires: number[]; junctions: number[]; labels: number[]; pins: string[] };
const ownedGroups = new WeakMap<Circuit, Group[]>();
const copyGroups = (groups: Group[]): Group[] =>
  groups.map((group) => ({
    wires: [...group.wires],
    junctions: [...group.junctions],
    labels: [...group.labels],
    pins: [...group.pins],
  }));
export const documentPinKey = (component: string, pin: string) => JSON.stringify([component, pin]);
export const documentPhysicalPinKey = (reference: string, pin: string) =>
  `physical:${JSON.stringify([reference, pin])}`;

/** Organize existing geometry without creating electrical connections. Crossings
 * join only at explicit anchors. Conflicting names and unfinished wiring remain
 * editable; this is neither an ERC nor a solver support check. */
export function projectNetGroups(circuit: Circuit): Group[] {
  const owned = isOwnedCircuit(circuit);
  const cached = owned ? ownedGroups.get(circuit) : undefined;
  if (cached) return copyGroups(cached);
  const groups = groupCircuit(circuit);
  if (owned) {
    ownedGroups.set(circuit, groups);
    return copyGroups(groups);
  }
  return groups;
}

function groupCircuit(circuit: Circuit): Group[] {
  const points: Point[] = [],
    parent: number[] = [];
  const add = (p: Point) => {
    if (points.length >= 30000)
      throw new Error(
        'Invalid OpenPE project: schematic grouping supports at most 30,000 physical anchors. Reduce the schematic size.',
      );
    points.push(p);
    parent.push(parent.length);
    return parent.length - 1;
  };
  const root = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const join = (a: number, b: number) => {
    parent[root(a)] = root(b);
  };
  const wires = circuit.wires.map((w) => {
    const a = add(w.a),
      b = add(w.b);
    join(a, b);
    return a;
  });
  const pins: { key: string; index: number }[] = [];
  const names: { name: string; index: number }[] = [];
  const physical = new Map<string, number>();
  for (const part of circuit.parts) {
    const library = circuit.libraries[part.libId];
    const definitions = unitGraphics(library, part.unit || 1).flatMap((s) => children(s, 'pin'));
    const positions = pinPositions(part, library);
    definitions.forEach((pin, i) => {
      const index = add(positions[i]),
        number = val(child(pin, 'number'));
      const key = JSON.stringify([part.ref, number]);
      const previous = physical.get(key);
      if (previous !== undefined) join(index, previous);
      physical.set(key, index);
      pins.push(
        { key: documentPinKey(part.id, number), index },
        { key: documentPhysicalPinKey(part.ref, number), index },
      );
      if (child(library, 'power') && definitions.length === 1 && val(pin) === 'power_in')
        names.push({ name: part.value, index });
      else if (
        val(pin) === 'power_in' &&
        (pin.includes('hide') || val(child(pin, 'hide')) === 'yes')
      )
        names.push({ name: val(child(pin, 'name')), index });
    });
  }
  const labels = circuit.labels.map((label) => {
    const index = add(label);
    names.push({ name: label.text, index });
    return index;
  });
  const junctions = circuit.junctions.map(add);
  // Spatial buckets keep serialization bounded even for the largest supported
  // schematic. A bucket is only a candidate filter; exact geometry decides joins.
  const cell = 10;
  const bucketKey = (x: number, y: number) => `${x},${y}`;
  const buckets = new Map<string, number[]>();
  const long: number[] = [];
  circuit.wires.forEach((w, i) => {
    const minX = Math.floor((Math.min(w.a.x, w.b.x) - 0.00005) / cell);
    const maxX = Math.floor((Math.max(w.a.x, w.b.x) + 0.00005) / cell);
    const minY = Math.floor((Math.min(w.a.y, w.b.y) - 0.00005) / cell);
    const maxY = Math.floor((Math.max(w.a.y, w.b.y) + 0.00005) / cell);
    if ((maxX - minX + 1) * (maxY - minY + 1) > 256) {
      long.push(i);
      return;
    }
    for (let x = minX; x <= maxX; x++)
      for (let y = minY; y <= maxY; y++) {
        const key = bucketKey(x, y),
          list = buckets.get(key) ?? [];
        list.push(i);
        buckets.set(key, list);
      }
  });
  const coordinates = new Map<string, number>();
  let comparisons = 0;
  points.forEach((p, i) => {
    const key = `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
    const previous = coordinates.get(key);
    if (previous !== undefined) {
      join(i, previous);
      return;
    }
    coordinates.set(key, i);
    const candidates = [
      ...(buckets.get(bucketKey(Math.floor(p.x / cell), Math.floor(p.y / cell))) ?? []),
      ...long,
    ];
    comparisons += candidates.length;
    if (comparisons > 10000000)
      throw new Error(
        'Invalid OpenPE project: schematic grouping exceeds the geometry work limit. Reduce long or overlapping wires.',
      );
    for (const index of candidates) {
      const w = circuit.wires[index],
        length = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
      if (
        length &&
        Math.abs((p.x - w.a.x) * (w.b.y - w.a.y) - (p.y - w.a.y) * (w.b.x - w.a.x)) / length <
          0.00005 &&
        p.x >= Math.min(w.a.x, w.b.x) - 0.00005 &&
        p.x <= Math.max(w.a.x, w.b.x) + 0.00005 &&
        p.y >= Math.min(w.a.y, w.b.y) - 0.00005 &&
        p.y <= Math.max(w.a.y, w.b.y) + 0.00005
      )
        join(i, wires[index]);
    }
  });
  const named = new Map<string, number>();
  for (const item of names) {
    const previous = named.get(item.name);
    if (previous !== undefined) join(item.index, previous);
    named.set(item.name, item.index);
  }
  const groups = new Map<number, Group>();
  const group = (index: number) => {
    const key = root(index);
    if (!groups.has(key)) groups.set(key, { wires: [], junctions: [], labels: [], pins: [] });
    return groups.get(key)!;
  };
  wires.forEach((index, i) => group(index).wires.push(i));
  junctions.forEach((index, i) => group(index).junctions.push(i));
  labels.forEach((index, i) => group(index).labels.push(i));
  pins.forEach((pin) => group(pin.index).pins.push(pin.key));
  return [...groups.values()];
}
