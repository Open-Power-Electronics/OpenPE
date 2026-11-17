import assert from 'node:assert/strict';
import test from 'node:test';
import type { PCB } from '../lib/pcb';
import { createEmptyPCB } from '../lib/pcb-layout';
import { isOwnedProjectNode, ownProjectData } from '../lib/immutable-project';
import { createPCBTrackDrag, type PCBTrackDragPreview } from '../lib/pcb-track-drag';

type Track = PCB['tracks'][number];

function fixture(): PCB {
  const track = (id: string, x: number, y: number): Track => ({
    id,
    start: { x: 0, y: 0 },
    end: { x, y },
    width: 0.4,
    layer: 'F.Cu',
    netId: 'out',
  });
  return {
    ...createEmptyPCB(),
    nets: [
      { id: 'out', name: 'OUT' },
      { id: 'gnd', name: 'GND' },
    ],
    tracks: [track('selected', 10, 0), track('retained', 2, 2)],
    vias: [{ id: 'via', x: 0, y: 0, diameter: 0.6, drill: 0.2, netId: 'out' }],
  };
}

const plan = (board: PCB) =>
  createPCBTrackDrag(board, [{ kind: 'track', id: 'selected' }], { clearance: 0.25 });

/** New reconnect UUIDs belong to each independent gesture; all other public data agrees. */
function comparable(result: PCBTrackDragPreview, basis: PCB) {
  const originalIds = new Set(basis.tracks.map((track) => track.id));
  const ids = new Map(
    result.board.tracks
      .filter((track) => !originalIds.has(track.id))
      .map((track, index) => [track.id, `reconnect-${index}`]),
  );
  return {
    ...result,
    board: {
      ...result.board,
      tracks: result.board.tracks.map((track) => ({
        ...track,
        id: ids.get(track.id) ?? track.id,
      })),
    },
    changedIds: result.changedIds.map((id) => ids.get(id) ?? id),
  };
}

function checkPreview(board: PCB, engine = plan(board), y = 2, expectedReconnects = 0) {
  const result = engine.preview({ x: 0, y });
  const reference = plan(structuredClone(board)).preview({ x: 0, y });
  assert.equal(result.error, '');
  assert.deepEqual(comparable(result, board), comparable(reference, board));
  assert.equal(result.board.tracks.length, board.tracks.length + expectedReconnects);
  assert.equal(result.board.tracks[1], board.tracks[1], 'Unchanged copper retains its exact node.');
  assert.deepEqual(result.board.tracks[0].start, { x: y, y });
  assert.deepEqual(result.board.tracks[0].end, { x: 10, y });
  return result;
}

test('owned retained copper deduplicates reversed reconnects through an unowned board wrapper', () => {
  const owned = ownProjectData(fixture());
  const wrapper = { ...owned, tracks: [...owned.tracks] };
  assert.equal(isOwnedProjectNode(wrapper), false);
  assert.equal(isOwnedProjectNode(wrapper.tracks), false);
  assert.equal(wrapper.tracks[1], owned.tracks[1]);
  assert.equal(isOwnedProjectNode(wrapper.tracks[1]), true);
  const engine = plan(wrapper);
  for (const y of [2, 1, 3, 2]) checkPreview(wrapper, engine, y, y === 2 ? 0 : 1);
  const accepted = checkPreview(wrapper, engine);
  const failed = engine.preview({ x: NaN, y: 2 });
  assert.match(failed.error, /coordinates/);
  assert.equal(failed.board, wrapper);
  assert.deepEqual(failed.changedIds, []);
  assert.deepEqual(engine.preview({ x: 0, y: 2 }), accepted);

  const reversed = ownProjectData(
    {
      ...owned,
      tracks: [
        owned.tracks[0],
        { ...owned.tracks[1], start: owned.tracks[1].end, end: owned.tracks[1].start },
      ],
    },
    owned,
  );
  checkPreview(reversed);
});

test('new owned tracks with the same IDs retain all copper-key fields and geometry', () => {
  const owned = ownProjectData(fixture());
  checkPreview(owned);
  const variants: { change: (board: PCB) => void; reconnects: number }[] = [
    {
      change(board) {
        for (const track of board.tracks) track.width = 0.6;
      },
      reconnects: 0,
    },
    {
      change(board) {
        for (const track of board.tracks) track.layer = 'B.Cu';
      },
      reconnects: 0,
    },
    {
      change(board) {
        for (const track of board.tracks) track.netId = 'gnd';
        board.vias[0].netId = 'gnd';
      },
      reconnects: 0,
    },
    {
      change(board) {
        board.tracks[1].locked = true;
      },
      reconnects: 1,
    },
    {
      change(board) {
        board.tracks[1].end = { x: 3, y: 3 };
      },
      reconnects: 1,
    },
  ];
  for (const { change, reconnects } of variants) {
    const data = structuredClone(owned);
    change(data);
    const next = ownProjectData(data, owned);
    assert.equal(next.tracks[1].id, owned.tracks[1].id);
    assert.notEqual(next.tracks[1], owned.tracks[1]);
    checkPreview(next, undefined, 2, reconnects);
  }
});

test('mutable retained copper and caller-frozen nodes refresh their public deduplication decisions', () => {
  for (const frozen of [false, true]) {
    const board = fixture();
    const retained = board.tracks[1];
    if (frozen) {
      Object.freeze(board);
      Object.freeze(retained);
    }
    assert.equal(isOwnedProjectNode(retained), false);
    const engine = plan(board);
    checkPreview(board, engine);
    if (frozen) {
      retained.end.x = 3;
      retained.end.y = 3;
    } else retained.locked = true;
    checkPreview(board, engine, 2, 1);
    if (frozen) {
      retained.end.x = 2;
      retained.end.y = 2;
    } else delete retained.locked;
    checkPreview(board, engine);
  }
});
