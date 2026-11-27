import { child, children, val, type SExpr } from './sexpr';
import type { PCB } from './pcb';

const groupMemberKinds = new Set([
  'footprint',
  'gr_line',
  'gr_rect',
  'gr_arc',
  'gr_curve',
  'gr_circle',
  'gr_poly',
  'gr_text',
  'gr_text_box',
  'dimension',
  'point',
  'segment',
  'arc',
  'generated',
  'via',
  'zone',
]);
const footprintMemberKinds = new Set([
  'property',
  'fp_line',
  'fp_rect',
  'fp_arc',
  'fp_curve',
  'fp_circle',
  'fp_poly',
  'fp_text',
  'fp_text_box',
  'point',
  'pad',
  'zone',
]);
const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const fail = (message: string): never => {
  throw new Error(`KiCad PCB: ${message}`);
};

function quoted(atom: SExpr[number] | undefined): atom is string {
  return typeof atom === 'string' && atom.startsWith('"');
}

export function validatePCBAssemblyVariants(board: SExpr) {
  const lists = children(board, 'variants');
  if (lists.length > 1 || (lists[0] && lists[0].length > 257))
    fail('Invalid native board assembly variants.');
  const failVariant = () => fail('Invalid native assembly variant.');
  const validateName = (node: SExpr, names: Set<string>) => {
    const name = val(node);
    if (node.length !== 2 || !quoted(node[1]) || !name || names.has(name)) failVariant();
    names.add(name);
  };
  const validateVariants = (records: SExpr[number][], footprint: boolean) => {
    const names = new Set<string>();
    for (const record of records) {
      if (!Array.isArray(record) || record[0] !== 'variant') return failVariant();
      const name = child(record, 'name') ?? failVariant();
      validateName(name, names);
      const seen = new Set(['name']);
      const fields = new Set<string>();
      for (const item of record.slice(1)) {
        if (item === name) continue;
        if (!Array.isArray(item) || typeof item[0] !== 'string') return failVariant();
        const key = item[0];
        if (footprint && key === 'field') {
          const fieldName = child(item, 'name') ?? failVariant();
          const value = child(item, 'value');
          validateName(fieldName, fields);
          if (item.length !== 3 || value?.length !== 2 || !quoted(value[1])) failVariant();
          continue;
        }
        if (seen.has(key) || item.length !== 2) return failVariant();
        if (
          footprint
            ? !['dnp', 'exclude_from_bom', 'exclude_from_pos_files'].includes(key) ||
              (item[1] !== 'yes' && item[1] !== 'no')
            : key !== 'description' || !quoted(item[1])
        )
          return failVariant();
        seen.add(key);
      }
    }
  };
  if (lists[0]) validateVariants(lists[0].slice(1), false);
  for (const footprint of children(board, 'footprint')) {
    const variants = children(footprint, 'variant');
    if (variants.length > 256) failVariant();
    validateVariants(variants, true);
  }
}

function nativeId(record: SExpr): string {
  const id = val(child(record, 'uuid'));
  return uuidPattern.test(id) ? id.toLowerCase() : '';
}

const tuningText = new Set(['name', 'last_netname', 'last_tuning']);
const tuningFlags = new Set(['is_time_domain', 'override_custom_rules', 'rounded', 'single_sided']);
const tuningMeasures = new Set([
  'corner_radius_percent',
  'last_diff_pair_gap',
  'last_track_width',
  'last_tuning_length',
  'max_amplitude',
  'min_amplitude',
  'min_spacing',
  'target_delay',
  'target_delay_min',
  'target_delay_max',
  'target_length',
  'target_length_min',
  'target_length_max',
  'target_skew',
  'target_skew_min',
  'target_skew_max',
]);
const tuningOption: Record<string, readonly string[]> = {
  initial_side: ['left', 'right'],
  last_status: ['tuned', 'too_long', 'too_short', 'unknown'],
  tuning_mode: ['single', 'diff_pair', 'diff_pair_skew'],
};

function tuningNumber(atom: SExpr[number] | undefined, limit: number) {
  return (
    typeof atom === 'string' &&
    /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(atom) &&
    Math.abs(Number(atom)) <= limit
  );
}
function tuningPoint(node: SExpr[number] | undefined) {
  return (
    Array.isArray(node) &&
    node.length === 3 &&
    node[0] === 'xy' &&
    tuningNumber(node[1], 100000) &&
    tuningNumber(node[2], 100000)
  );
}

/** Retain the KiCad generator and all physical members without replaying it. */
export function validateNativePCBTuningPatterns(
  patterns: SExpr[],
  tracks: readonly PCB['tracks'][number][],
  layers: PCB['layers'],
  groups: SExpr[] = [],
): string[] {
  if (!patterns.length) return [];
  if (patterns.length > 256) return fail('Too many native PCB tuning patterns.');
  const byTrack = new Map(tracks.map((track) => [track.id.toLowerCase(), track.layer]));
  const claimed = new Set(
    groups.flatMap((group) => {
      const members = child(group, 'members') ?? [];
      return members.slice(1).map((_, index) => val(members, index + 1).toLowerCase());
    }),
  );
  return patterns.map((pattern) => {
    if (pattern[0] !== 'generated') return fail('Invalid native PCB tuning pattern.');
    const seen = new Set<string>();
    const layer = val(child(pattern, 'layer'));
    const rawId = val(child(pattern, 'uuid'));
    if (!uuidPattern.test(rawId) || !layers.some((name) => name === layer))
      return fail('Invalid PCB tuning pattern identity or layer.');
    for (const field of pattern.slice(1)) {
      if (!Array.isArray(field) || typeof field[0] !== 'string' || seen.has(field[0]))
        return fail('Invalid or repeated PCB tuning pattern field.');
      const [key, value] = field;
      seen.add(key);
      let valid: boolean;
      if (key === 'members') {
        valid =
          field.length >= 2 &&
          field.slice(1).every((_, index) => {
            const member = val(field, index + 1).toLowerCase();
            if (!uuidPattern.test(member) || claimed.has(member) || byTrack.get(member) !== layer)
              return false;
            claimed.add(member);
            return true;
          });
      } else if (field.length !== 2) valid = false;
      else if (key === 'type') valid = value === 'tuning_pattern';
      else if (key === 'uuid' || key === 'layer') valid = quoted(value);
      else if (key === 'origin' || key === 'end') valid = tuningPoint(value);
      else if (key === 'base_line' || key === 'base_line_coupled')
        valid =
          Array.isArray(value) &&
          value[0] === 'pts' &&
          value.length >= (key === 'base_line_coupled' ? 2 : 3) &&
          value.slice(1).every(tuningPoint);
      else if (tuningText.has(key)) valid = quoted(value) && val(field).length <= 4096;
      else if (tuningFlags.has(key)) valid = value === 'yes' || value === 'no';
      else if (tuningMeasures.has(key)) valid = tuningNumber(value, 1000000000);
      else
        valid =
          Object.hasOwn(tuningOption, key) &&
          quoted(value) &&
          tuningOption[key].includes(val(field));
      if (!valid) return fail(`Unsupported or invalid PCB tuning pattern field ${key}.`);
    }
    if (
      !['uuid', 'type', 'name', 'layer', 'origin', 'end', 'members'].every((key) => seen.has(key))
    )
      return fail('Incomplete PCB tuning pattern.');
    return rawId;
  });
}

function boardMemberIds(board: SExpr): Set<string> {
  const ids = new Set<string>();
  const kinds = board[0] === 'footprint' ? footprintMemberKinds : groupMemberKinds;
  for (const item of board) {
    if (!Array.isArray(item) || !kinds.has(String(item[0]))) continue;
    const id = nativeId(item);
    if (!id) continue;
    if (ids.has(id)) fail('Board group member identities are ambiguous.');
    ids.add(id);
  }
  return ids;
}

type BoardGroup = {
  node: SExpr;
  id: string;
  members: SExpr;
  memberIds: string[];
  ownedMembers: Set<string>;
  locked: boolean;
};

function readBoardGroups(board: SExpr) {
  const records = children(board, 'group');
  if (!records.length)
    return { groups: [], memberFirst: [], parentByMember: new Map<string, BoardGroup>() };
  if (records.length > 4096) return fail('PCB groups exceed the scope object limit.');
  const items = boardMemberIds(board);
  const byId = new Map<string, BoardGroup>();
  const parentByMember = new Map<string, BoardGroup>();
  for (const node of records) {
    const id = nativeId(node);
    const members = child(node, 'members');
    const lock = child(node, 'locked');
    if (
      !quoted(node[1]) ||
      val(node).length > 4096 ||
      !id ||
      items.has(id) ||
      byId.has(id) ||
      !members ||
      (lock && (lock.length !== 2 || (lock[1] !== 'yes' && lock[1] !== 'no'))) ||
      children(node, 'uuid').length !== 1 ||
      child(node, 'uuid')?.length !== 2 ||
      children(node, 'members').length !== 1 ||
      children(node, 'locked').length > 1 ||
      node
        .slice(2)
        .some(
          (item) =>
            !Array.isArray(item) || !['uuid', 'members', 'locked'].includes(String(item[0])),
        )
    )
      return fail('Invalid or unsupported PCB group metadata.');
    const memberIds = members.slice(1).map((_, index) => val(members, index + 1).toLowerCase());
    if (memberIds.some((member) => !uuidPattern.test(member)))
      return fail('Invalid PCB group membership.');
    byId.set(id, {
      node,
      id,
      members,
      memberIds,
      ownedMembers: new Set(),
      locked: lock?.[1] === 'yes',
    });
  }

  const groups = [...byId.values()];
  // KiCad resolves declarations in file order and moves each item from its
  // former group into the new group. Keep the raw records for native Save.
  for (const group of groups) {
    for (const member of new Set(group.memberIds)) {
      if (byId.has(member)) {
        for (
          let ancestor: BoardGroup | undefined = group;
          ancestor;
          ancestor = parentByMember.get(ancestor.id)
        )
          if (ancestor.id === member) return fail('PCB groups contain a membership cycle.');
      } else if (!items.has(member)) {
        return fail('PCB group references a missing or unsupported board item.');
      }
      parentByMember.get(member)?.ownedMembers.delete(member);
      parentByMember.set(member, group);
      group.ownedMembers.add(member);
    }
  }
  const remaining = new Map<string, number>();
  const ready: BoardGroup[] = [];
  for (const group of groups) {
    let childGroups = 0;
    for (const member of group.ownedMembers) if (byId.has(member)) childGroups++;
    remaining.set(group.id, childGroups);
    if (childGroups === 0) ready.push(group);
  }

  const memberFirst: BoardGroup[] = [];
  while (ready.length) {
    const group = ready.pop()!;
    memberFirst.push(group);
    const parent = parentByMember.get(group.id);
    if (parent === undefined) continue;
    const unresolved = remaining.get(parent.id)! - 1;
    remaining.set(parent.id, unresolved);
    if (unresolved === 0) ready.push(parent);
  }
  if (memberFirst.length !== groups.length) return fail('PCB groups contain a membership cycle.');
  return { groups, memberFirst, parentByMember };
}

export function validateNativeBoardMetadata(board: SExpr) {
  const scopes = [board, ...children(board, 'footprint')];
  const groupIds = new Set<string>();
  for (const scope of scopes)
    for (const group of readBoardGroups(scope).groups) {
      if (groupIds.has(group.id)) fail('PCB group identities must be unique across the board.');
      groupIds.add(group.id);
    }
  if (groupIds.size)
    for (const scope of scopes)
      for (const item of scope)
        if (Array.isArray(item) && item[0] !== 'group' && groupIds.has(nativeId(item)))
          fail('A PCB group identity conflicts with another board object.');
  const variables = new Map<string, string>();
  for (const property of children(board, 'property')) {
    const name = val(property);
    if (
      property.length !== 3 ||
      !quoted(property[1]) ||
      !quoted(property[2]) ||
      !name ||
      variables.has(name)
    )
      fail('Invalid or repeated PCB board property.');
    variables.set(name, val(property, 2));
  }
  return variables;
}

/** Native embedded payloads stay opaque. Layout neither decompresses nor reads
 * an embedded worksheet, font or model from a filesystem or network path. */
export function validateNativePCBEmbeddedFiles(scope: SExpr) {
  const listings = children(scope, 'embedded_files');
  const listing = listings[0];
  if (!listing) return;
  if (listings.length !== 1 || listing.length > 129)
    return fail('Invalid native PCB embedded file listing.');
  const names = new Set<string>();
  for (const entry of listing.slice(1)) {
    if (!Array.isArray(entry) || entry[0] !== 'file' || entry.length < 4 || entry.length > 5)
      return fail('Invalid native PCB embedded file entry.');
    const name = child(entry, 'name');
    const type = child(entry, 'type');
    const checksum = child(entry, 'checksum');
    const data = child(entry, 'data');
    const filename = val(name);
    if (
      new Set(entry.slice(1).map((field) => (Array.isArray(field) ? field[0] : field))).size !==
        entry.length - 1 ||
      name?.length !== 2 ||
      !quoted(name[1]) ||
      !filename ||
      filename.length > 256 ||
      /[\\/\u0000-\u001f]/.test(filename) ||
      filename === '.' ||
      filename === '..' ||
      names.has(filename) ||
      type?.length !== 2 ||
      !['worksheet', 'model', 'font', 'other'].includes(val(type)) ||
      checksum?.length !== 2 ||
      !quoted(checksum[1]) ||
      !/^[A-F0-9]{32}$/i.test(val(checksum)) ||
      (entry.length === 5 &&
        (!data ||
          data.length < 2 ||
          data
            .slice(1)
            .some((atom) => typeof atom !== 'string' || !/^[A-Za-z0-9+/=|]+$/.test(atom))))
    )
      return fail('Invalid native PCB embedded file metadata.');
    names.add(filename);
  }
}

/** Group locks apply recursively. A footprint with a locked nested group
 * retains its placement as well as the locked members' local geometry. */
export function nativePCBGroupLocks(board: SExpr): ReadonlySet<string> {
  const result = new Set<string>();
  const add = (scope: SExpr) => {
    const { memberFirst } = readBoardGroups(scope);
    const locked = new Set<string>();
    for (const group of memberFirst.toReversed())
      if (group.locked || locked.has(group.id))
        for (const member of group.ownedMembers) locked.add(member);
    if (locked.size && scope[0] === 'footprint') {
      const footprintId = nativeId(scope);
      if (!footprintId) return fail('A footprint with locked groups requires a native UUID.');
      result.add(footprintId);
    }
    for (const member of locked) result.add(member);
  };
  add(board);
  for (const footprint of children(board, 'footprint')) add(footprint);
  return result;
}

/** Follow accepted PCB edits by UUID. Only a removed item or empty child group
 * changes membership. Group records and member order otherwise stay native. */
export function retainNativeBoardGroups(before: SExpr, after: SExpr) {
  const { groups, memberFirst, parentByMember } = readBoardGroups(before);
  if (!groups.length) return;
  const known = boardMemberIds(after);
  for (const group of memberFirst)
    if (!group.ownedMembers.size || [...group.ownedMembers].some((member) => known.has(member)))
      known.add(group.id);
  for (const group of groups) {
    if (!known.has(group.id)) continue;
    const members = group.members.slice(1).filter((_, index) => {
      const member = group.memberIds[index];
      return known.has(member) && known.has(parentByMember.get(member)!.id);
    });
    const record =
      members.length === group.memberIds.length
        ? group.node
        : group.node.map((item) => (item === group.members ? ['members', ...members] : item));
    after.push(record);
  }
}
