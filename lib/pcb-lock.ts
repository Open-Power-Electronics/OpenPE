import type { PCB } from './pcb';
import type { PCBSelection } from './pcb-layout';

export type PCBLockTarget = PCBSelection | { kind: 'pad'; id: string };

export function pcbLockObject(board: PCB, target: PCBLockTarget): { locked?: true } | undefined {
  switch (target.kind) {
    case 'footprint':
      return board.footprints.find((item) => item.id === target.id);
    case 'track':
      return board.tracks.find((item) => item.id === target.id);
    case 'via':
      return board.vias.find((item) => item.id === target.id);
    case 'graphic':
      return board.graphics.find((item) => item.id === target.id);
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
      return pads.some((p, i) => p !== f.pads[i]) ? { ...next, pads } : next;
    }),
    tracks: board.tracks.map((item) => update(item, 'track')),
    vias: board.vias.map((item) => update(item, 'via')),
    graphics: board.graphics.map((item) => update(item, 'graphic')),
    zones: board.zones.map((item) => update(item, 'zone')),
  };
}

/** Fills may refresh, but locked objects cannot be changed or removed by an editor command. */
export function assertPCBLockedEdits(before: PCB, after: PCB): void {
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
  }
}
