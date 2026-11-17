import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createLayoutCameraTrackBindings,
  type LayoutCameraTrackBinding,
} from '../components/layoutCameraTargets';
import { isOwnedProjectNode, ownProjectData } from '../lib/immutable-project';
import type { PCB } from '../lib/pcb';

type BoardTrack = PCB['tracks'][number];
const tracks = (): BoardTrack[] => [
  {
    id: 'track-a',
    start: { x: 0, y: 1 },
    end: { x: 3, y: 1 },
    width: 0.4,
    layer: 'F.Cu',
    netId: 'net-a',
  },
  {
    id: 'track-b',
    start: { x: 3, y: 1 },
    end: { x: 5, y: 3 },
    width: 0.6,
    layer: 'B.Cu',
    netId: 'net-b',
  },
];

test('owned coordinate, net and lock-only previews retain one trusted track binding', () => {
  const bindings = createLayoutCameraTrackBindings();
  const original = ownProjectData(tracks());
  const committed = bindings.prepare(original);
  assert.equal(Object.isFrozen(committed), true);
  assert.deepEqual(
    Object.keys(committed),
    [],
    'Public packets expose neither metadata nor old geometry.',
  );
  for (const edit of [
    (track: BoardTrack): BoardTrack => ({ ...track, start: { x: 10, y: -7 } }),
    (track: BoardTrack): BoardTrack => ({ ...track, end: { x: -2, y: 8 } }),
    (track: BoardTrack): BoardTrack => ({ ...track, netId: 'renamed-net' }),
    (track: BoardTrack): BoardTrack => ({ ...track, locked: true }),
  ]) {
    const preview = ownProjectData(original.map(edit));
    assert.notEqual(preview, original);
    assert.equal(bindings.prepare(preview, committed), committed);
  }
  assert.equal(bindings.prepare(original, committed), committed);
});

for (const [name, change] of [
  [
    'width',
    (input: BoardTrack[]) => input.map((track, i) => (i ? track : { ...track, width: 0.8 })),
  ],
  [
    'id',
    (input: BoardTrack[]) => input.map((track, i) => (i ? track : { ...track, id: 'replacement' })),
  ],
  [
    'layer',
    (input: BoardTrack[]) =>
      input.map((track, i) => (i ? track : { ...track, layer: 'B.Cu' as const })),
  ],
  ['addition', (input: BoardTrack[]) => [...input, { ...input[0], id: 'track-c' }]],
  ['removal', (input: BoardTrack[]) => input.slice(1)],
  ['order', (input: BoardTrack[]) => input.toReversed()],
] as const) {
  test(`owned ${name} changes replace the camera target binding`, () => {
    const bindings = createLayoutCameraTrackBindings();
    const original = ownProjectData(tracks());
    const committed = bindings.prepare(original);
    const changed = ownProjectData(change(original));
    assert.notEqual(bindings.prepare(changed, committed), committed);
  });
}

test('fresh mutable and caller-frozen arrays cannot borrow owned metadata retention', () => {
  const bindings = createLayoutCameraTrackBindings();
  const committed = bindings.prepare(ownProjectData(tracks()));
  const raw = tracks();
  const frozen = Object.freeze(tracks().map((track) => Object.freeze(track)));
  assert.equal(isOwnedProjectNode(frozen), false);
  assert.notEqual(bindings.prepare(raw, committed), committed);
  assert.notEqual(bindings.prepare(frozen, committed), committed);
  const rawPacket = bindings.prepare(raw);
  const frozenPacket = bindings.prepare(frozen);
  assert.notEqual(bindings.prepare(tracks(), rawPacket), rawPacket);
  assert.notEqual(bindings.prepare(Object.freeze([...frozen]), frozenPacket), frozenPacket);
  assert.equal(
    bindings.prepare(raw, rawPacket),
    rawPacket,
    'The exact raw array retains its prior behavior.',
  );
  assert.equal(bindings.prepare(frozen, frozenPacket), frozenPacket);
});

test('raw identity reuse never grants owned-binding reuse', () => {
  const bindings = createLayoutCameraTrackBindings();
  const raw = tracks();
  const committed = bindings.prepare(raw);
  raw[0].width = 0.9;
  assert.equal(bindings.prepare(raw, committed), committed);
  const detached = ownProjectData(raw);
  assert.notEqual(
    bindings.prepare(detached, committed),
    committed,
    'A new owned array cannot reuse a packet prepared from a mutable source.',
  );
});

test('raw-to-owned transition replaces the binding after in-place identity changes', () => {
  const bindings = createLayoutCameraTrackBindings();
  const raw = tracks();
  const originalOwned = ownProjectData(raw);
  const committed = bindings.prepare(raw);
  raw[0].id = 'changed-in-place';
  assert.equal(
    bindings.prepare(raw, committed),
    committed,
    'Raw arrays retain their exact-reference behavior.',
  );
  assert.notEqual(
    bindings.prepare(originalOwned, committed),
    committed,
    'Restoring initial metadata through an owned array cannot retain stale raw DOM references.',
  );
  assert.notEqual(
    bindings.prepare(ownProjectData(raw), committed),
    committed,
    'Matching current raw metadata does not grant previous packet ownership.',
  );
});

test('foreign factories and forged packets never qualify as trusted baselines', () => {
  const first = createLayoutCameraTrackBindings();
  const second = createLayoutCameraTrackBindings();
  const input = ownProjectData(tracks());
  const foreign = first.prepare(input);
  assert.notEqual(second.prepare(input, foreign), foreign);
  const forged = Object.freeze({}) as LayoutCameraTrackBinding;
  assert.notEqual(first.prepare(input, forged), forged);
  const copied = Object.freeze({ ...foreign }) as LayoutCameraTrackBinding;
  assert.notEqual(first.prepare(input, copied), copied);
});

test('abandoned preparation cannot replace or poison the caller committed baseline', () => {
  const bindings = createLayoutCameraTrackBindings();
  const original = ownProjectData(tracks());
  const committed = bindings.prepare(original);
  const abandonedTracks = ownProjectData(
    original.map((track) => ({ ...track, width: track.width + 0.1 })),
  );
  const abandoned = bindings.prepare(abandonedTracks, committed);
  assert.notEqual(abandoned, committed);
  const laterPreview = ownProjectData(
    original.map((track) => ({ ...track, start: { x: 7, y: 8 } })),
  );
  assert.equal(bindings.prepare(laterPreview, committed), committed);
  assert.equal(bindings.prepare(abandonedTracks, abandoned), abandoned);
  assert.notEqual(
    bindings.prepare(original),
    committed,
    'No hidden factory baseline or history supplies reuse without an explicit previous packet.',
  );
});
