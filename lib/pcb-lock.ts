import type { PCB } from './pcb';
import { findPCBGraphic, flipPCBFootprint, type PCBSelection } from './pcb-layout';

export type PCBLockTarget = PCBSelection | { kind: 'pad'; id: string };

export function pcbLockObject(board: PCB, target: PCBLockTarget): { locked?: true } | undefined {
  switch (target.kind) {
    case 'footprint':
      return board.footprints.find((item) => item.id === target.id);
    case 'track':
      return board.tracks.find((item) => item.id === target.id);
    case 'via':
      return board.vias.find((item) => item.id === target.id);
    case 'graphic': {
      const item = findPCBGraphic(board, target.id);
      return item?.owner?.locked ? item.owner : item?.graphic;
    }
    case 'zone':
      return board.zones.find((item) => item.id === target.id);
    case 'pad':
      return board.footprints.flatMap((item) => item.pads).find((item) => item.id === target.id);
  }
}

/** One exact lock transaction, shared by Properties and the Core capability. */
export function setPCBLocked(board: PCB, targets: readonly PCBLockTarget[], locked: boolean): PCB {
  if (!targets.length) throw new Error('Select an object to lock or unlock.');
  for (const target of targets) {
    if (!pcbLockObject(board, target)) throw new Error('The selected object no longer exists.');
    if (!locked && board.groupLocks?.includes(target.id))
      throw new Error('Unlock the native group in Source before editing its members.');
    if (
      target.kind === 'pad' &&
      board.footprints.some(
        (f) =>
          f.locked &&
          f.pads.some((p) => p.id === target.id) &&
          (locked || !targets.some((target) => target.kind === 'footprint' && target.id === f.id)),
      )
    )
      throw new Error('Unlock the footprint before changing its pads.');
    if (target.kind === 'graphic') {
      const owner = findPCBGraphic(board, target.id)?.owner;
      if (
        owner?.locked &&
        !targets.some((item) => item.kind === 'footprint' && item.id === owner.id)
      )
        throw new Error('Unlock the footprint before changing its text lock.');
    }
  }
  const selected = (kind: PCBLockTarget['kind'], id: string) =>
    targets.some((target) => target.kind === kind && target.id === id);
  const update = <T extends { id: string; locked?: true }>(
    item: T,
    kind: PCBLockTarget['kind'],
  ): T => {
    if (!selected(kind, item.id) || Boolean(item.locked) === locked) return item;
    const next = { ...item };
    if (locked) next.locked = true;
    else delete next.locked;
    return next;
  };
  return {
    ...board,
    footprints: board.footprints.map((f) => {
      const next = update(f, 'footprint');
      const pads = f.pads.map((p) => update(p, 'pad'));
      const graphics = f.graphics.map((g) => (g.kind === 'text' ? update(g, 'graphic') : g));
      return pads.some((p, i) => p !== f.pads[i]) || graphics.some((g, i) => g !== f.graphics[i])
        ? { ...next, pads, graphics }
        : next;
    }),
    tracks: board.tracks.map((item) => update(item, 'track')),
    vias: board.vias.map((item) => update(item, 'via')),
    graphics: board.graphics.map((item) => update(item, 'graphic')),
    zones: board.zones.map((item) => update(item, 'zone')),
  };
}

function groupLockObjects(board: PCB): Map<string, { id: string; locked?: true }> {
  const targets = new Set(board.groupLocks);
  const objects = new Map<string, { id: string; locked?: true }>();
  const collect = (items: readonly { id: string; locked?: true }[]) => {
    for (const item of items) if (targets.has(item.id)) objects.set(item.id, item);
  };
  collect(board.footprints);
  collect(board.tracks);
  collect(board.arcTracks ?? []);
  collect(board.vias);
  collect(board.graphics);
  collect(board.zones);
  for (const footprint of board.footprints) {
    collect(footprint.graphics);
    collect(footprint.pads);
    collect(footprint.zones ?? []);
  }
  return objects;
}

export function validatePCBGroupLocks(board: PCB, fail: (message: string) => never): void {
  if (!board.groupLocks?.length) return;
  const objects = groupLockObjects(board);
  if (
    objects.size !== board.groupLocks.length ||
    [...objects.values()].some((item) => !item.locked)
  )
    fail('PCB group locks require distinct existing locked members.');
}

export function assertPCBGroupLockEdits(before?: PCB | null, after?: PCB | null): void {
  if (before === after || (!before?.groupLocks?.length && !after?.groupLocks?.length)) return;
  const reject = () => {
    throw new Error('Unlock the native group in Source before editing its members.');
  };
  if (
    !before ||
    !after ||
    before.groupLocks?.length !== after.groupLocks?.length ||
    before.groupLocks?.some((id, index) => id !== after.groupLocks?.[index])
  )
    return reject();
  const beforeObjects = groupLockObjects(before);
  const afterObjects = groupLockObjects(after);
  const value = (item: unknown) =>
    JSON.stringify(item, (key, data) => (key === 'filledPolygons' ? undefined : data));
  for (const [id, item] of beforeObjects) {
    const next = afterObjects.get(id);
    if (item !== next && value(item) !== value(next)) return reject();
  }
}

/** Fills may refresh, but locked objects cannot be changed or removed by an editor command. */
export function assertPCBLockedEdits(before: PCB, after: PCB): void {
  assertPCBGroupLockEdits(before, after);
  const value = (item: unknown) =>
    JSON.stringify(item, (key, value) =>
      key === 'filledPolygons' || key === 'locked' ? undefined : value,
    );
  for (const key of ['footprints', 'tracks', 'vias', 'graphics', 'zones'] as const) {
    const candidates = new Map(after[key].map((item) => [item.id, item] as const));
    for (const item of before[key]) {
      const next = candidates.get(item.id);
      if (item.locked && (!next || (next.locked && value(item) !== value(next))))
        throw new Error('Unlock the selected object before editing.');
    }
  }
  for (const f of before.footprints) {
    const next = after.footprints.find((item) => item.id === f.id);
    if (!next) continue;
    for (const pad of f.pads) {
      const candidate = next.pads.find((item) => item.id === pad.id);
      if (pad.locked && (!candidate || (candidate.locked && value(pad) !== value(candidate))))
        throw new Error('Unlock the pad before editing.');
    }
    for (const graphic of f.graphics) {
      if (graphic.kind !== 'text' || !graphic.locked) continue;
      const candidate = next.graphics.find((item) => item.id === graphic.id);
      if (!candidate || (candidate.locked && value(graphic) !== value(candidate))) {
        // Whole-package side changes transform its local artwork with the package.
        if (
          next.side !== f.side &&
          candidate?.locked &&
          value(flipPCBFootprint(f).graphics.find((g) => g.id === graphic.id)) === value(candidate)
        )
          continue;
        throw new Error('Unlock the footprint text before editing.');
      }
    }
  }
}
