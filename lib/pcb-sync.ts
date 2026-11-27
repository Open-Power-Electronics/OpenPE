import { pinPositions, uid, type Circuit, type Part, type Point } from './circuit';
import { partFields, unitGraphics } from './library';
import { child, children, val, type SExpr } from './sexpr';
import { invalidatePCBFill, type PCB, type Footprint, type Pad } from './pcb';
import { createEmptyPCB, createPCBFootprint, flipPCBFootprint, pcbBounds } from './pcb-layout';
import { isOwnedCircuit, isOwnedPCB } from './immutable-project';
import { parasiticPhysicalModels } from './parasitic-model';
import { padApertureLayers, padHasElectricalPin } from './pcb-pad-role';

type Pin = { key: string; ref: string; number: string; index: number };
type SchematicNet = { name: string; pins: string[] };
type PCBUpdate = {
  board: PCB;
  added: number;
  replaced: number;
  changed: boolean;
  warnings: string[];
};
export type FootprintSource = { id: string; footprint: SExpr; projectAssets?: true };
export type EmbeddedFootprintAssignment = { libraryId: string; assignment: string };
type EmbeddedAssignments = ReadonlyMap<string, EmbeddedFootprintAssignment>;
export const pcbPinKey = (ref: string, number: string) => JSON.stringify([ref, number]);
function fail(message: string): never {
  throw new Error(message);
}
const key = (p: Point) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
const ownedSchematicNets = new WeakMap<Circuit, SchematicNet[]>();
const copyNets = (nets: SchematicNet[]) =>
  nets.map((net) => ({ name: net.name, pins: [...net.pins] }));

/** Physical pin numbers, independent of simulation models. Only explicit anchors
 * join crossing wires. Work is bounded before the wire/anchor intersection pass. */
export function schematicPCBNets(circuit: Circuit): SchematicNet[] {
  const owned = isOwnedCircuit(circuit);
  const cached = owned ? ownedSchematicNets.get(circuit) : undefined;
  if (cached) return copyNets(cached);
  const nets = computeSchematicPCBNets(circuit);
  if (owned) {
    ownedSchematicNets.set(circuit, nets);
    return copyNets(nets);
  }
  return nets;
}

function computeSchematicPCBNets(
  circuit: Circuit,
  conductorModels: ReturnType<typeof parasiticPhysicalModels> = [],
): SchematicNet[] {
  if (circuit.parts.length > 2000 || circuit.wires.length > 10000)
    fail('PCB update supports at most 2,000 symbols and 10,000 wires.');
  const points: Point[] = [],
    parents: number[] = [];
  const add = (p: Point) => {
    if (points.length >= 30000) fail('This schematic exceeds the PCB connectivity update limit.');
    points.push(p);
    parents.push(parents.length);
    return parents.length - 1;
  };
  const root = (n: number): number => {
    while (parents[n] !== n) {
      parents[n] = parents[parents[n]];
      n = parents[n];
    }
    return n;
  };
  const join = (a: number, b: number) => {
    parents[root(a)] = root(b);
  };
  const names: { name: string; index: number }[] = [];
  // An explicitly declared extracted conductor is finite R/L in the schematic
  // and SPICE, but remains the same piece of copper for PCB synchronization.
  // Ordinary virtual passives never receive this physical-only equivalence.
  const conductorParts = new Set(conductorModels.flatMap((model) => model.parts.map((p) => p.id)));
  const conductorAliases = new Set(
    conductorModels.flatMap((model) => [model.startLabel, model.endLabel]),
  );
  const wires = circuit.wires.map((w) => {
    const a = add(w.a),
      b = add(w.b);
    join(a, b);
    return a;
  });
  const pins: Pin[] = [];
  const physical = new Map<string, number>();
  for (const part of circuit.parts) {
    const library = circuit.libraries[part.libId];
    const definitions = unitGraphics(library, part.unit || 1).flatMap((s) => children(s, 'pin'));
    const positions = pinPositions(part, library);
    const power = Boolean(child(library, 'power'));
    const modelPins: number[] = [];
    definitions.forEach((pin, i) => {
      const index = add(positions[i]),
        number = val(child(pin, 'number'));
      const pinKey = pcbPinKey(part.ref, number);
      const previous = physical.get(pinKey);
      if (previous !== undefined) join(index, previous);
      physical.set(pinKey, index);
      if (conductorParts.has(part.id)) modelPins.push(index);
      else pins.push({ key: pinKey, ref: part.ref, number, index });
      // KiCad power symbols use Value; hidden power-input pins use their name.
      if (power && definitions.length === 1 && val(pin) === 'power_in')
        names.push({ name: part.value, index });
      else if (
        !power &&
        val(pin) === 'power_in' &&
        (pin.includes('hide') || val(child(pin, 'hide')) === 'yes')
      )
        names.push({ name: val(child(pin, 'name')), index });
    });
    if (modelPins.length === 2) join(modelPins[0], modelPins[1]);
  }
  circuit.labels.forEach((l) => names.push({ name: l.text, index: add(l) }));
  circuit.junctions.forEach(add);
  if (points.length > 30000 || points.length * circuit.wires.length > 5000000)
    fail(
      'This schematic exceeds the PCB connectivity update limit. Reduce its size before updating.',
    );
  // Keep the existing eligibility bound above. Buckets only filter candidates;
  // the original distance/bounds predicate still determines every connection.
  const cell = 10;
  const bucketKey = (x: number, y: number) => `${x},${y}`;
  const buckets = new Map<string, number[]>();
  const long: number[] = [];
  const segments = circuit.wires.map((wire, index) => {
    const { a, b } = wire;
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const segment = {
      a,
      dx,
      dy,
      length: Math.hypot(dx, dy),
      minX: Math.min(a.x, b.x) - 0.00005,
      maxX: Math.max(a.x, b.x) + 0.00005,
      minY: Math.min(a.y, b.y) - 0.00005,
      maxY: Math.max(a.y, b.y) + 0.00005,
    };
    const minX = Math.floor(segment.minX / cell),
      maxX = Math.floor(segment.maxX / cell),
      minY = Math.floor(segment.minY / cell),
      maxY = Math.floor(segment.maxY / cell);
    const count = (maxX - minX + 1) * (maxY - minY + 1);
    if (!Number.isFinite(count) || count > 256) long.push(index);
    else
      for (let x = minX; x <= maxX; x++)
        for (let y = minY; y <= maxY; y++) {
          const key = bucketKey(x, y),
            candidates = buckets.get(key) ?? [];
          candidates.push(index);
          buckets.set(key, candidates);
        }
    return segment;
  });
  const coordinates = new Map<string, number>();
  points.forEach((p, i) => {
    const previous = coordinates.get(key(p));
    if (previous !== undefined) join(i, previous);
    coordinates.set(key(p), i);
    const nearby = buckets.get(bucketKey(Math.floor(p.x / cell), Math.floor(p.y / cell))) ?? [];
    // Both lists follow native wire order; merge them to retain exact traversal.
    let local = 0,
      distant = 0;
    while (local < nearby.length || distant < long.length) {
      const j =
        distant === long.length || (local < nearby.length && nearby[local] < long[distant])
          ? nearby[local++]
          : long[distant++];
      const s = segments[j];
      if (
        s.length > 0 &&
        Math.abs((p.x - s.a.x) * s.dy - (p.y - s.a.y) * s.dx) / s.length < 0.00005 &&
        p.x >= s.minX &&
        p.x <= s.maxX &&
        p.y >= s.minY &&
        p.y <= s.maxY
      )
        join(i, wires[j]);
    }
  });
  const named = new Map<string, number>();
  names.forEach((n) => {
    const previous = named.get(n.name);
    if (previous !== undefined) join(n.index, previous);
    named.set(n.name, n.index);
  });
  const groups = new Map<number, Pin[]>();
  pins.forEach((p) => {
    const r = root(p.index);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(p);
  });
  const groupNames = new Map<number, Set<string>>();
  names.forEach((n) => {
    if (conductorAliases.has(n.name)) return;
    const r = root(n.index);
    if (!groupNames.has(r)) groupNames.set(r, new Set());
    groupNames.get(r)!.add(n.name);
  });
  const wireRoots = new Set(wires.map(root));
  const noConnects = new Set((circuit.noConnects || []).map(key));
  const result: SchematicNet[] = [];
  for (const [r, members] of groups) {
    const labels = [...(groupNames.get(r) || [])].sort();
    // Conflicting names are ambiguous; never silently pick a power rail.
    if (labels.length > 1)
      fail(
        `Connected net has conflicting names: ${labels.join(', ')}. Use one net name before updating PCB.`,
      );
    const unique = [...new Set(members.map((p) => p.key))].sort();
    const connected = unique.length > 1 || wireRoots.has(r) || labels.length > 0;
    if (members.some((p) => noConnects.has(key(points[p.index])))) {
      if (connected)
        fail(
          `${members[0].ref} pin ${members[0].number} has both a connection and a no-connect marker.`,
        );
      continue;
    }
    if (!connected) continue;
    const first = [...members].sort((a, b) => a.key.localeCompare(b.key))[0];
    result.push({ name: labels[0] || `Net-(${first.ref}-Pad${first.number})`, pins: unique });
  }
  if (new Set(result.map((n) => n.name)).size !== result.length)
    fail(
      'Generated PCB net names conflict with schematic labels. Add distinct labels before updating.',
    );
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

function componentGroups(circuit: Circuit) {
  const groups = new Map<string, Part[]>();
  circuit.parts.forEach((p) => groups.set(p.ref, [...(groups.get(p.ref) || []), p]));
  return [...groups.values()].filter((parts) => {
    const included = parts.map(
      (p) =>
        val(child(p.raw || [], 'on_board')) !== 'no' && !child(circuit.libraries[p.libId], 'power'),
    );
    if (included.some(Boolean) && included.some((v) => !v))
      fail(`${parts[0].ref}: units disagree about board inclusion.`);
    if (
      parts.length > 1 &&
      (new Set(parts.map((p) => p.libId)).size !== 1 ||
        new Set(parts.map((p) => p.unit || 1)).size !== parts.length)
    )
      fail(`${parts[0].ref}: duplicate references must be distinct units of the same symbol.`);
    return included[0];
  });
}

/** Symbols eligible for board packages, independently of simulation participation.
 * Keep unassigned instances here: their pins still contribute physical net names. */
export function pcbIncludedParts(circuit: Circuit): Part[] {
  return componentGroups(circuit).flat();
}

/** Resolve all schematic connections before projecting onto board-included pins.
 * Virtual sources, power symbols and labels can join/name physical nets, while
 * an isolated simulation-only island has no corresponding PCB net. */
export function schematicPCBPhysicalNets(circuit: Circuit, board?: PCB): SchematicNet[] {
  const models = parasiticPhysicalModels(circuit, board);
  const pins = new Set(
    pcbIncludedParts(circuit).flatMap((part) =>
      unitGraphics(circuit.libraries[part.libId], part.unit || 1).flatMap((unit) =>
        children(unit, 'pin').map((pin) => pcbPinKey(part.ref, val(child(pin, 'number')))),
      ),
    ),
  );
  return (models.length ? computeSchematicPCBNets(circuit, models) : schematicPCBNets(circuit))
    .map((net) => ({ ...net, pins: net.pins.filter((pin) => pins.has(pin)) }))
    .filter((net) => net.pins.length > 0);
}
function assignment(parts: Part[]) {
  const assigned = [
    ...new Set(parts.map((p) => (partFields(p).Footprint || '').trim()).filter(Boolean)),
  ];
  if (assigned.length > 1) fail(`${parts[0].ref}: units have different footprint assignments.`);
  return assigned[0];
}
function retainsAssignedFootprint(
  footprint: Footprint | undefined,
  id: string,
  embedded?: EmbeddedAssignments,
) {
  if (!footprint) return false;
  if (footprint.libraryId === id) return true;
  const original = embedded?.get(footprint.id);
  return original?.libraryId === footprint.libraryId && original.assignment === id;
}
export function pcbUpdateFootprintIds(
  circuit: Circuit,
  board?: PCB,
  embedded?: EmbeddedAssignments,
): string[] {
  return [
    ...new Set(
      componentGroups(circuit).flatMap((parts) => {
        const id = assignment(parts);
        const existing =
          board?.footprints.filter((f) => parts.some((p) => p.id === f.symbolId)) || [];
        if (existing.length > 1)
          fail(
            `${parts[0].ref}: multiple board footprints exist for one component. Resolve them before updating.`,
          );
        return id && !retainsAssignedFootprint(existing[0], id, embedded) ? [id] : [];
      }),
    ),
  ];
}

/** Incremental, immutable update. Existing copper geometry is never rebuilt.
 * Split/disconnected nets retain their copper net separately for manual review. */
export function updatePCBFromSchematic(
  circuit: Circuit,
  current: PCB | undefined,
  sources: ReadonlyMap<string, FootprintSource>,
  embedded?: EmbeddedAssignments,
): PCBUpdate {
  const schematicNets = schematicPCBPhysicalNets(circuit, current);
  pcbUpdateFootprintIds(circuit, current, embedded);
  const board = current || createEmptyPCB(),
    warnings: string[] = [];
  let added = 0,
    replaced = 0;
  let cursor: number | undefined;
  const sourceParts = new Map(circuit.parts.map((part) => [part.id, part]));
  const excludedFootprints = new Set(
    board.footprints
      .filter((footprint) => {
        const part = sourceParts.get(footprint.symbolId ?? '');
        return part && val(child(part.raw ?? [], 'on_board')) === 'no';
      })
      .map((footprint) => footprint.id),
  );
  const footprints = board.footprints.filter((footprint) => !excludedFootprints.has(footprint.id));
  for (const parts of componentGroups(circuit)) {
    const part = parts[0],
      id = assignment(parts);
    const index = footprints.findIndex((f) => parts.some((p) => p.id === f.symbolId));
    const old = footprints[index];
    if (!id) {
      // No assignment means a virtual component. Clearing an assignment removes
      // its package; existing tracks and other board geometry remain untouched.
      if (old) footprints.splice(index, 1);
      continue;
    }
    if (retainsAssignedFootprint(old, id, embedded)) continue;
    const detail = sources.get(id);
    if (!detail || detail.id !== id)
      fail(
        `${part.ref}: could not load assigned footprint ${id}. Retry after checking the bundled library.`,
      );
    let next: Footprint;
    try {
      next = createPCBFootprint(detail, circuit, old?.symbolId || part.id, { x: 0, y: 0 });
    } catch (error) {
      fail(`${part.ref} (${id}): ${(error as Error).message}`);
    }
    if (old) {
      if (old.side === 'back') next = flipPCBFootprint(next);
      const ids = new Map<string, string[]>();
      const padKey = (pad: Pad) =>
        `${padApertureLayers(pad)?.toSorted().join(',') ?? (padHasElectricalPin(pad) ? 'electrical' : 'mechanical')}:${pad.number}`;
      for (const pad of old.pads) {
        const key = padKey(pad);
        ids.set(key, [...(ids.get(key) ?? []), pad.id]);
      }
      next = {
        ...old,
        ...next,
        id: old.id,
        x: old.x,
        y: old.y,
        rotation: old.rotation,
        pads: next.pads.map((p) => ({ ...p, id: ids.get(padKey(p))?.shift() ?? p.id })),
      };
      footprints[index] = next;
      replaced++;
      warnings.push(
        `${part.ref}: footprint replaced at its existing position. Check pad-to-track alignment.`,
      );
    } else {
      cursor ??= pcbBounds(board).maxX + 10;
      const bounds = pcbBounds({ ...createEmptyPCB(), footprints: [next] });
      next = {
        ...next,
        x: Number((cursor - bounds.minX).toFixed(4)),
        y: Number((-bounds.minY).toFixed(4)),
      };
      cursor += bounds.maxX - bounds.minX + 10;
      footprints.push(next);
      added++;
    }
  }
  const pinNet = new Map(schematicNets.flatMap((n, i) => n.pins.map((p) => [p, i] as const)));
  const parts = new Map(circuit.parts.map((p) => [p.id, p]));
  const targets = new Map<string, Set<number | null>>();
  board.footprints.forEach((f) =>
    f.pads.forEach((p) => {
      if (excludedFootprints.has(f.id)) return;
      const part = parts.get(f.symbolId || '');
      if (!p.netId || !part) return;
      const target = pinNet.get(pcbPinKey(part.ref, p.number)) ?? null;
      if (!targets.has(p.netId)) targets.set(p.netId, new Set());
      targets.get(p.netId)!.add(target);
    }),
  );
  const copperNets = new Set(
    [...board.tracks, ...(board.arcTracks ?? []), ...board.vias, ...board.zones].map(
      (c) => c.netId,
    ),
  );
  const safe = (id: string, i: number) =>
    !targets.has(id) || (targets.get(id)!.size === 1 && targets.get(id)!.has(i));
  const used = new Set<string>(),
    remap = new Map<string, string>();
  const nets = schematicNets.map((n, i) => {
    const old =
      board.nets.find((o) => o.name === n.name && !used.has(o.id) && safe(o.id, i)) ||
      board.nets.find(
        (o) => !used.has(o.id) && targets.get(o.id)?.size === 1 && targets.get(o.id)?.has(i),
      );
    const id = old?.id || uid();
    used.add(id);
    board.nets.forEach((o) => {
      if (targets.get(o.id)?.size === 1 && targets.get(o.id)?.has(i)) remap.set(o.id, id);
    });
    return old?.name === n.name ? old : { id, name: n.name };
  });
  const names = new Set(nets.map((n) => n.name));
  board.nets.forEach((n) => {
    if (used.has(n.id)) return;
    // Preserve manual/unused nets too; never delete user data during synchronization.
    let name = n.name,
      suffix = 1;
    while (names.has(name)) name = `${n.name} (retained ${suffix++})`;
    names.add(name);
    nets.push(name === n.name ? n : { ...n, name });
  });
  board.nets.forEach((n) => {
    if (copperNets.has(n.id) && !remap.has(n.id) && !used.has(n.id))
      warnings.push(
        `${n.name}: retained copper has split, disconnected or unmatched connectivity. Review it manually.`,
      );
  });
  const unchanged = <T>(before: T[], after: T[]) =>
    before.length === after.length && before.every((item, index) => item === after[index]);
  const retainArray = <T>(before: T[], after: T[]) => (unchanged(before, after) ? before : after);
  const updated = retainArray(
    board.footprints,
    footprints.map((f) => {
      const part = parts.get(f.symbolId || '');
      if (!part) return f;
      const pads = retainArray(
        f.pads,
        f.pads.map((pad) => {
          if (!padHasElectricalPin(pad)) return pad;
          const index = pinNet.get(pcbPinKey(part.ref, pad.number));
          const netId = index === undefined ? null : nets[index].id;
          return pad.netId === netId ? pad : { ...pad, netId };
        }),
      );
      return pads === f.pads ? f : { ...f, pads };
    }),
  );
  const copper = <T extends { netId: string | null }>(items: T[]) =>
    retainArray(
      items,
      items.map((item) => {
        const id = item.netId ? remap.get(item.netId) : undefined;
        return id && id !== item.netId ? { ...item, netId: id } : item;
      }),
    );
  // Retain existing net order so a repeated update is a true no-op.
  const order = new Map(board.nets.map((n, i) => [n.id, i]));
  nets.sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
  const nextNets = retainArray(board.nets, nets),
    tracks = copper(board.tracks),
    arcTracks = board.arcTracks && copper(board.arcTracks),
    vias = copper(board.vias),
    zones = copper(board.zones);
  // The updater only changes these collections. When each one retains its
  // original objects and order, the complete board and its saved fills agree.
  if (
    nextNets === board.nets &&
    updated === board.footprints &&
    tracks === board.tracks &&
    arcTracks === board.arcTracks &&
    vias === board.vias &&
    zones === board.zones
  )
    return { board, added, replaced, changed: false, warnings };
  const next: PCB = invalidatePCBFill(board, {
    ...board,
    nets: nextNets,
    footprints: updated,
    tracks,
    ...(arcTracks?.length ? { arcTracks } : {}),
    vias,
    zones,
  });
  // Every replacement above changes a net ID/name, package or collection order.
  // Identity equality already handled the complete no-op case; saved copper need
  // not be stringified again to rediscover these field changes.
  // Unowned adapter input retains the defensive equivalence comparison.
  const changed = isOwnedPCB(board) || JSON.stringify(next) !== JSON.stringify(board);
  return { board: changed ? next : board, added, replaced, changed, warnings };
}
