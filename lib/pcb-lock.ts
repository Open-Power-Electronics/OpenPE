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
