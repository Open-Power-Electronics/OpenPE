import { child, children, quote, val, type SExpr } from './sexpr';

/** Deterministic editor identities for native objects that have no UUID.
 * These are local identifiers, never file paths or security capabilities. */
export function nativeIdentity(value: string): string {
  const words = [2166136261, 2246822519, 3266489917, 668265263];
  for (let i = 0; i < value.length; i++) {
    for (let j = 0; j < words.length; j++)
      words[j] = Math.imul(words[j] ^ (value.charCodeAt(i) + j * 257), 16777619);
  }
  const h = words.map((word) => (word >>> 0).toString(16).padStart(8, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
}
/** KiCad can read these compact test/design IDs but may issue new random IDs
 * when writing them. Use stable private IDs for the accepted board projection.
 * Clean Source and Save continue to own the original bytes. */
export function normalizeNativePCBIdentifiers(root: SExpr): SExpr {
  const normalizeAtom = (atom: SExpr[number], value: string) =>
    /^0-0-0-0-[0-9a-f]{12}$/i.test(value)
      ? quote(nativeIdentity(`KiCad PCB compact UUID: ${value.toLowerCase()}`))
      : atom;
  const visit = (node: SExpr, parent?: SExpr[number]): SExpr => {
    const key = node[0];
    const ids =
      key === 'uuid' || (key === 'members' && (parent === 'group' || parent === 'generated'));
    let next: SExpr | undefined;
    for (let index = 1; index < node.length; index++) {
      const entry = node[index];
      const normalized = Array.isArray(entry)
        ? visit(entry, key)
        : ids
          ? normalizeAtom(entry, val(node, index))
          : entry;
      if (entry !== normalized) {
        next ??= [...node];
        next[index] = normalized;
      }
    }
    return next ?? node;
  };
  const board = visit(root);
  return separateNativeScopedIdentities(separateNativeZoneIdentities(board));
}

/** Footprint copies can share child property or zone IDs. Separate same-kind
 * records only across distinct scopes and when no member reference uses the ID. */
function separateNativeScopedIdentities(board: SExpr): SExpr {
  type ScopedRecord = { container: SExpr; record: SExpr; owner: string; kind: 'property' | 'zone' };
  const records = new Map<string, ScopedRecord[]>();
  const uses = new Map<string, number>();
  const references = new Set<string>();
  const collect = (container: SExpr, owner: string) => {
    for (const record of container) {
      if (!Array.isArray(record)) continue;
      const kind = record[0];
      if (kind === 'group' || kind === 'generated') {
        const members = child(record, 'members');
        for (let i = 1; members && i < members.length; i++)
          references.add(val(members, i).toLowerCase());
      }
      const id = val(child(record, 'uuid')).toLowerCase();
      if (!id) continue;
      uses.set(id, (uses.get(id) ?? 0) + 1);
      if (!owner || (kind !== 'zone' && (kind !== 'property' || container === board))) continue;
      const occurrence: ScopedRecord = { container, record, owner, kind };
      const group = records.get(id);
      if (group) group.push(occurrence);
      else records.set(id, [occurrence]);
    }
  };
  collect(board, 'board');
  for (const footprint of children(board, 'footprint'))
    collect(footprint, val(child(footprint, 'uuid')).toLowerCase());
  const copies = new Map<SExpr, SExpr>();
  for (const [id, occurrences] of records) {
    if (
      occurrences.length < 2 ||
      uses.get(id) !== occurrences.length ||
      references.has(id) ||
      new Set(occurrences.map(({ owner }) => owner)).size !== occurrences.length ||
      occurrences.some(({ kind }) => kind !== occurrences[0].kind)
    )
      continue;
    for (const { container, record, owner, kind } of occurrences.slice(1)) {
      const updated = copies.get(container) ?? [...container];
      const uuid = child(record, 'uuid');
      updated[container.indexOf(record)] = record.map((field) =>
        field === uuid
          ? ['uuid', quote(nativeIdentity(`KiCad PCB footprint ${kind} UUID: ${owner}: ${id}`))]
          : field,
      );
      copies.set(container, updated);
    }
  }
  return copies.size
    ? board.map((record) => (Array.isArray(record) ? (copies.get(record) ?? record) : record))
    : board;
}

/** Some native boards reuse a UUID for separately named board zones. A linked
 * identity is ambiguous and stays subject to normal group/UUID validation. */
function separateNativeZoneIdentities(board: SExpr): SExpr {
  const zonesById = new Map<string, SExpr[]>();
  const references = new Set<string>();
  for (const record of board) {
    if (!Array.isArray(record)) continue;
    const id = val(child(record, 'uuid')).toLowerCase();
    if (record[0] === 'zone' && id) {
      const zones = zonesById.get(id);
      if (zones) zones.push(record);
      else zonesById.set(id, [record]);
    } else if (id) references.add(id);
    if (record[0] === 'group') {
      const members = child(record, 'members') ?? [];
      for (let i = 1; i < members.length; i++) references.add(val(members, i).toLowerCase());
    }
  }
  const changed = new Map<SExpr, SExpr>();
  for (const [id, zones] of zonesById) {
    if (zones.length < 2 || references.has(id)) continue;
    const names = zones.map((zone) => val(child(zone, 'name')));
    if (names.some((name) => !name) || new Set(names).size !== zones.length) continue;
    for (let i = 1; i < zones.length; i++) {
      const zone = zones[i];
      if (children(zone, 'uuid').length !== 1) continue;
      const uuid = child(zone, 'uuid');
      changed.set(
        zone,
        zone.map((field) =>
          field === uuid
            ? ['uuid', quote(nativeIdentity(`KiCad PCB named zone UUID: ${id}: ${names[i]}`))]
            : field,
        ),
      );
    }
  }
  return changed.size
    ? board.map((record) => (Array.isArray(record) ? (changed.get(record) ?? record) : record))
    : board;
}
