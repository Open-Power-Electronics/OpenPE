import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyPCB } from '../lib/pcb-layout';
import { analyzePCBConnectivity } from '../lib/pcb-connectivity';
import { ownProjectData } from '../lib/immutable-project';
import type { Footprint, PCB } from '../lib/pcb';

type Track = PCB['tracks'][number];
type Via = PCB['vias'][number];
const netId = 'copper';
function footprint(id: string, x: number, side: Footprint['side'] = 'front'): Footprint {
  return {
    id,
    symbolId: null,
    reference: id,
    value: '',
    libraryId: 'Test:Contact',
    x,
    y: 0,
    rotation: 0,
    side,
    graphics: [],
    pads: [
      {
        id: `${id}-pad`,
        number: '1',
        x: 0,
        y: 0,
        rotation: 0,
        type: 'smd',
        shape: 'circle',
        size: { x: 1, y: 1 },
        netId,
      },
    ],
  };
}
function track(id: string, start: number, end: number, layer: Track['layer'] = 'F.Cu'): Track {
  return { id, netId, layer, width: 0.2, start: { x: start, y: 0 }, end: { x: end, y: 0 } };
}
function bridge(): PCB {
  return {
    ...createEmptyPCB(),
    nets: [{ id: netId, name: 'Copper' }],
    footprints: [footprint('A', 0), footprint('B', 10), footprint('C', 20, 'back')],
    tracks: [track('front', 0, 10), track('back', 10, 20, 'B.Cu')],
    vias: [{ id: 'bridge', netId, x: 10, y: 0.6, diameter: 1.6, drill: 0.2 }],
  };
}
function agrees(board: PCB, expectedEdges?: number) {
  const reference = analyzePCBConnectivity(structuredClone(board));
  assert.deepEqual(analyzePCBConnectivity(board), reference);
  assert.deepEqual(analyzePCBConnectivity(board), reference, 'Repeated analysis agrees.');
  if (expectedEdges !== undefined) assert.equal(reference.edges.length, expectedEdges);
}

test('retained track and via geometry follows changed coordinates, layer, diameter and zero spans', () => {
  const board = ownProjectData(bridge());
  agrees(board, 0);
  const moved = ownProjectData(
    {
      ...board,
      tracks: board.tracks.map((item, index) =>
        index ? item : { ...item, start: { x: 0, y: 3 }, end: { x: 10, y: 3 } },
      ),
    },
    board,
  );
  assert.equal(moved.tracks[1], board.tracks[1]);
  assert.equal(moved.vias[0], board.vias[0]);
  agrees(moved, 1);
  agrees(
    ownProjectData(
      { ...board, tracks: [board.tracks[0], { ...board.tracks[1], layer: 'F.Cu' }] },
      board,
    ),
    1,
  );
  agrees(ownProjectData({ ...board, vias: [{ ...board.vias[0], diameter: 0.1 }] }, board), 1);
  agrees(ownProjectData({ ...board, vias: [{ ...board.vias[0], x: 15 }] }, board), 1);
  agrees(
    ownProjectData(
      {
        ...board,
        tracks: [board.tracks[0], { ...board.tracks[1], end: board.tracks[1].start }],
      },
      board,
    ),
    1,
  );
  agrees(board, 0);
});

test('a changed track width changes finite copper contact after geometry was retained', () => {
  const data = bridge();
  data.footprints = data.footprints.slice(0, 2);
  data.vias = [];
  data.tracks = [{ ...data.tracks[0], width: 0.8, start: { x: 0, y: 1 }, end: { x: 10, y: 1 } }];
  const narrow = ownProjectData(data);
  agrees(narrow, 1);
  const wide = ownProjectData({ ...narrow, tracks: [{ ...narrow.tracks[0], width: 1.2 }] }, narrow);
  assert.notEqual(wide.tracks[0], narrow.tracks[0]);
  agrees(wide, 0);
  agrees(narrow, 1);
});

function innerBridge(): PCB {
  const data = bridge();
  data.layers = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'];
  data.tracks[1].layer = 'In1.Cu';
  data.vias.push({ id: 'back-bridge', netId, x: 20, y: 0.6, diameter: 1.6, drill: 0.2 });
  return data;
}
test('the same owned via refreshes its copper layers through repeated two/four-layer contexts', () => {
  const four = ownProjectData(innerBridge());
  agrees(four, 0);
  const two = ownProjectData<PCB>({ ...four, layers: ['F.Cu', 'B.Cu'] }, four);
  assert.equal(two.vias[0], four.vias[0]);
  assert.equal(two.tracks[1], four.tracks[1]);
  assert.notEqual(two.layers, four.layers);
  agrees(two, 1);
  agrees(four, 0);
  agrees(two, 1);
});

test('mutable and caller-frozen boards cannot retain geometry even with owned copper records', () => {
  const owned = ownProjectData(innerBridge());
  agrees(owned, 0);
  for (const freeze of [false, true]) {
    const mutable: PCB = { ...owned, layers: ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] };
    const candidate = freeze ? Object.freeze(mutable) : mutable;
    agrees(candidate, 0);
    candidate.layers.splice(1, 2);
    agrees(candidate, 1);
  }
  const mutable = bridge();
  agrees(mutable, 0);
  mutable.vias[0].diameter = 0.1;
  agrees(mutable, 1);
  const frozen = Object.freeze(bridge());
  agrees(frozen, 0);
  frozen.tracks[0].start.y = 3;
  frozen.tracks[0].end.y = 3;
  agrees(frozen, 1);
});

test('exact owned objects used in different copper roles retain independent geometry', () => {
  const data = bridge();
  data.footprints = data.footprints.slice(0, 2);
  const both: Track & Via = { ...track('hybrid', 0, 10), x: 5, y: 3, diameter: 0.2, drill: 0.1 };
  data.tracks = [both];
  data.vias = [];
  const asTrack = ownProjectData(data);
  agrees(asTrack, 0);
  const asVia = ownProjectData<PCB>(
    { ...asTrack, tracks: [], vias: [asTrack.tracks[0] as Track & Via] },
    asTrack,
  );
  assert.equal(asVia.vias[0], asTrack.tracks[0]);
  agrees(asVia, 1);
  agrees(asTrack, 0);
});

test('geometry reuse does not expose cached point or airwire containers', () => {
  const data = bridge();
  data.tracks = [];
  data.vias = [];
  const board = ownProjectData(data);
  const expected = analyzePCBConnectivity(structuredClone(board));
  assert.equal(expected.edges.length, 2);
  const first = analyzePCBConnectivity(board);
  first.edges[0].start.x = 1234;
  first.edges[0].end.y = 5678;
  first.edges[0].netId = 'other';
  first.edges.length = 0;
  first.warnings.push('poison');
  assert.deepEqual(analyzePCBConnectivity(board), expected);
  assert.equal(board.footprints[0].pads[0].x, 0);
});

test('retained geometry rebuilds the analysis work ledger and preserves global limits after failure', () => {
  const data = createEmptyPCB();
  data.nets = [{ id: netId, name: 'Copper' }];
  data.tracks = Array.from({ length: 1994 }, (_, index) => track(`span-${index}`, 0, 1));
  const accepted = ownProjectData(data);
  const result = analyzePCBConnectivity(accepted);
  assert.deepEqual(result, { edges: [], padCount: 0, warnings: [] });
  // A new source changes the net and forces independent contact calculation.
  // Reusing a previous Body.edgeTree would incorrectly omit enough work to let
  // this just-over-budget network through, despite all geometry being retained.
  const rejected = ownProjectData(
    { ...accepted, tracks: [...accepted.tracks, track('one-more-span', 0, 1)] },
    accepted,
  );
  assert.equal(rejected.tracks[1], accepted.tracks[1]);
  for (let attempt = 0; attempt < 2; attempt++)
    assert.throws(
      () => analyzePCBConnectivity(rejected),
      /Airwire preview exceeds the geometry limit/,
    );
  assert.deepEqual(analyzePCBConnectivity(accepted), result);
  const tooMany = ownProjectData(
    {
      ...accepted,
      tracks: Array.from({ length: 15001 }, (_, index) => track(`limit-${index}`, 0, 1)),
    },
    accepted,
  );
  assert.throws(() => analyzePCBConnectivity(tooMany), /at most 15000 copper objects/);
  assert.deepEqual(analyzePCBConnectivity(accepted), result);
});
