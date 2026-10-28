import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Footprint, Pad, PCB } from '../lib/pcb';
import { createEmptyPCB } from '../lib/pcb-layout';
import { borrowPCBTrackAnchors, preparePCBTrackAnchors } from '../lib/pcb-track-anchors';
import { analyzePCBConnectivity } from '../lib/pcb-connectivity';
import { ownProjectData } from '../lib/immutable-project';
import { borrowPCBPadCopperContour, borrowPCBPadOutline } from '../lib/pcb-pad-contour';

const pad = (id: string): Pad => ({
  id,
  number: id,
  x: 2,
  y: 3,
  rotation: 0,
  type: 'thru_hole',
  shape: 'circle',
  size: { x: 4, y: 4 },
  drill: 2,
  drillOffset: { x: 1, y: 0 },
  netId: 'out',
});
const footprint = (pads: Pad[]): Footprint => ({
  id: 'part',
  libraryId: 'Test:Anchor',
  symbolId: null,
  x: 10,
  y: 20,
  rotation: 90,
  side: 'back',
  graphics: [],
  pads,
});

test('fixed contacts retain native transforms, real drill holes, pad/via order and fresh geometry', () => {
  const board = createEmptyPCB();
  board.footprints = [footprint([pad('pad'), { ...pad('unassigned'), netId: null }])];
  board.vias = [{ id: 'via', x: 50, y: 60, diameter: 2, drill: 0.5, netId: 'out' }];
  const before = structuredClone(board);
  const anchors = preparePCBTrackAnchors(board, { limitMessage: 'limit', centers: true });
  assert.deepEqual(
    anchors.map(({ id }) => id),
    ['pad', 'via'],
  );
  assert.deepEqual(
    anchors.map(({ center }) => center),
    [
      { x: 13, y: 18 },
      { x: 50, y: 60 },
    ],
  );
  assert.deepEqual(anchors[0].polygon.holes[0][0], { x: 14, y: 17 });
  assert.deepEqual(anchors[1].polygon.holes[0][0], { x: 50.25, y: 60 });
  assert.deepEqual(anchors[0].layers, board.layers);
  assert.equal(anchors[1].layers, board.layers);
  anchors[0].polygon.outer[0].x = -100;
  const uncentered = preparePCBTrackAnchors(board, { limitMessage: 'limit' });
  assert.ok(uncentered.every((anchor) => !Object.hasOwn(anchor, 'center')));
  assert.notEqual(uncentered[0].polygon.outer[0].x, -100);
  assert.deepEqual(board, before);
});

test('shared owned pad contours retain independent public anchors and invalidate changed native geometry', () => {
  const data = createEmptyPCB();
  data.footprints = [footprint([pad('pad')])];
  const board = ownProjectData(data);
  // Connectivity populates the same private geometry before a drag starts.
  const connectivity = analyzePCBConnectivity(board);
  const outline = borrowPCBPadOutline(board.footprints[0], board.footprints[0].pads[0]);
  assert.equal(
    outline.holes.length,
    0,
    'Router pad outlines do not acquire the shared drill hole.',
  );
  assert.throws(() => {
    outline.outer[0].x = -100;
  }, TypeError);
  const expected = preparePCBTrackAnchors(structuredClone(board), {
    limitMessage: 'limit',
    centers: true,
  });
  const escaped = preparePCBTrackAnchors(board, { limitMessage: 'limit', centers: true });
  assert.deepEqual(escaped, expected);
  escaped[0].polygon.outer[0].x = -100;
  escaped[0].polygon.holes[0][0].y = 999;
  escaped[0].polygon.holes.push([{ x: -1, y: -1 }]);
  escaped[0].layers.length = 0;
  escaped[0].center.x = 100;
  assert.deepEqual(
    preparePCBTrackAnchors(board, { limitMessage: 'limit', centers: true }),
    expected,
  );
  assert.deepEqual(analyzePCBConnectivity(board), connectivity);
  assert.equal(outline.holes.length, 0);
  assert.deepEqual(outline.outer, expected[0].polygon.outer);

  const changed = ownProjectData(
    {
      ...board,
      footprints: board.footprints.map((f) => ({
        ...f,
        rotation: 45,
        pads: f.pads.map((p) => ({
          ...p,
          size: { x: 6, y: 6 },
          drill: 1,
          drillOffset: { x: -0.5, y: 0.25 },
        })),
      })),
    },
    board,
  );
  const next = preparePCBTrackAnchors(changed, { limitMessage: 'limit' });
  assert.notDeepEqual(next[0].polygon, expected[0].polygon);
  assert.deepEqual(
    next,
    preparePCBTrackAnchors(structuredClone(changed), { limitMessage: 'limit' }),
  );

  const mutable = structuredClone(data);
  Object.freeze(mutable.footprints[0]);
  const before = preparePCBTrackAnchors(mutable, { limitMessage: 'limit' });
  mutable.footprints[0].pads[0].drillOffset!.x = -1;
  const after = preparePCBTrackAnchors(mutable, { limitMessage: 'limit' });
  assert.notDeepEqual(after[0].polygon.holes, before[0].polygon.holes);
  assert.deepEqual(
    after,
    preparePCBTrackAnchors(structuredClone(mutable), { limitMessage: 'limit' }),
  );
});

test('private Shove contacts borrow only owned pad geometry while public anchors and vias stay independent', () => {
  const data = createEmptyPCB();
  data.footprints = [footprint([pad('pad')])];
  data.vias = [{ id: 'via', x: 50, y: 60, diameter: 2, drill: 0.5, netId: 'out' }];
  const board = ownProjectData(data);
  const borrowed = borrowPCBTrackAnchors(board, { limitMessage: 'limit' });
  const next = borrowPCBTrackAnchors(board, { limitMessage: 'limit' });
  const expected = preparePCBTrackAnchors(structuredClone(board), { limitMessage: 'limit' });
  assert.deepEqual(borrowed, expected);
  assert.notEqual(borrowed, next);
  assert.notEqual(borrowed[0], next[0]);
  assert.equal(
    borrowed[0].polygon,
    borrowPCBPadCopperContour(board.footprints[0], board.footprints[0].pads[0]),
  );
  assert.equal(borrowed[0].polygon, next[0].polygon);
  assert.throws(() => (borrowed[0].polygon.holes[0][0].x = 999), TypeError);
  assert.throws(() => borrowed[0].polygon.outer.reverse(), TypeError);
  assert.notEqual(borrowed[1].polygon, next[1].polygon, 'Via geometry is freshly generated.');
  borrowed[1].polygon.outer[0].x = 999;
  const exposed = preparePCBTrackAnchors(board, { limitMessage: 'limit' });
  assert.notEqual(exposed[0].polygon, borrowed[0].polygon);
  exposed[0].polygon.outer[0].x = -100;
  exposed[0].polygon.holes[0].push({ x: -1, y: -1 });
  assert.deepEqual(borrowPCBTrackAnchors(board, { limitMessage: 'limit' }), expected);
  assert.deepEqual(preparePCBTrackAnchors(board, { limitMessage: 'limit' }), expected);

  // Owned packages alone do not authorize the private path on a caller basis.
  const caller = Object.freeze({ ...board });
  const detached = borrowPCBTrackAnchors(caller, { limitMessage: 'limit' });
  assert.notEqual(detached[0].polygon, borrowed[0].polygon);
  detached[0].polygon.holes[0][0].x = 999;
  assert.deepEqual(borrowPCBTrackAnchors(board, { limitMessage: 'limit' }), expected);
});

test('private Shove contacts recompute caller-frozen geometry and changed owned transforms and drills', () => {
  const data = createEmptyPCB();
  data.footprints = [footprint([pad('pad')])];
  const board = ownProjectData(data);
  const original = borrowPCBTrackAnchors(board, { limitMessage: 'limit' });
  for (const frozen of [false, true]) {
    const caller = structuredClone(data);
    if (frozen) Object.freeze(caller);
    const before = borrowPCBTrackAnchors(caller, { limitMessage: 'limit' });
    caller.footprints[0].rotation = 45;
    caller.footprints[0].pads[0].drillOffset!.x = -1;
    const after = borrowPCBTrackAnchors(caller, { limitMessage: 'limit' });
    assert.notDeepEqual(after, before);
    assert.deepEqual(after, preparePCBTrackAnchors(caller, { limitMessage: 'limit' }));
    after[0].polygon.outer[0].x = 999;
    assert.deepEqual(
      borrowPCBTrackAnchors(caller, { limitMessage: 'limit' }),
      preparePCBTrackAnchors(caller, { limitMessage: 'limit' }),
    );
  }
  const changedData: PCB = {
    ...board,
    layers: ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'],
    footprints: board.footprints.map((f) => ({
      ...f,
      rotation: 45,
      pads: f.pads.map((p) => ({ ...p, drill: 1, drillOffset: { x: -0.5, y: 0.25 } })),
    })),
  };
  const changed = ownProjectData(changedData, board);
  const next = borrowPCBTrackAnchors(changed, { limitMessage: 'limit' });
  assert.notEqual(next[0].polygon, original[0].polygon);
  assert.notDeepEqual(next[0].polygon, original[0].polygon);
  assert.deepEqual(next[0].layers, ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
  assert.deepEqual(
    next,
    preparePCBTrackAnchors(structuredClone(changed), { limitMessage: 'limit' }),
  );
});

test('corner contact filtering precedes geometry budgets without weakening full-board anchor limits', () => {
  const board = createEmptyPCB();
  const unrelated = Array.from({ length: 1000 }, (_, index): Pad => {
    const { drill: _drill, ...source } = pad(`unrelated-${index}`);
    return {
      ...source,
      type: 'smd',
      size: { x: 100, y: 100 },
      netId: index % 2 ? 'out' : 'other',
      layers: [index % 2 ? 'B.Cu' : 'F.Cu'],
    };
  });
  board.footprints = [footprint([...unrelated, pad('target')])];
  assert.throws(
    () => preparePCBTrackAnchors(board, { limitMessage: 'complete anchor budget' }),
    /complete anchor budget/,
  );
  const anchors = preparePCBTrackAnchors(board, {
    limitMessage: 'corner anchor budget',
    netId: 'out',
    layer: 'F.Cu',
    centers: true,
  });
  assert.deepEqual(
    anchors.map(({ id }) => id),
    ['target'],
  );
  assert.deepEqual(anchors[0].center, { x: 13, y: 18 });
  const owned = ownProjectData(board);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.throws(
      () => borrowPCBTrackAnchors(owned, { limitMessage: 'private complete anchor budget' }),
      /private complete anchor budget/,
    );
    const filtered = borrowPCBTrackAnchors(owned, {
      limitMessage: 'private filtered anchor budget',
      netId: 'out',
      layer: 'F.Cu',
    });
    assert.deepEqual(
      filtered.map(({ id }) => id),
      ['target'],
    );
  }
});
