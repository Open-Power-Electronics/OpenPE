import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoardZone, CopperLayer, Footprint, PCB } from '../lib/pcb';
import { defaultPCBDisplay } from '../lib/pcb-display';
import { createEmptyPCB, type PCBSelection } from '../lib/pcb-layout';
import { copperFillContour } from '../lib/pcb-polygons';
import type { PCBSelectionFilters } from '../lib/pcb-selection';
import { expandPCBTrackSelection } from '../lib/pcb-track-selection';

const filters: PCBSelectionFilters = {
  footprint: true,
  track: true,
  via: true,
  graphic: true,
  zone: true,
};
const fixture = (): PCB => ({
  ...createEmptyPCB(),
  nets: [
    { id: 'out', name: 'OUT' },
    { id: 'gnd', name: 'GND' },
  ],
});
const track = (
  id: string,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  layer: CopperLayer = 'F.Cu',
): PCB['tracks'][number] => ({
  id,
  start: { x: x1, y: y1 },
  end: { x: x2, y: y2 },
  width: 0.2,
  layer,
  netId: 'out',
});
const seed = (id: string): PCBSelection[] => [{ kind: 'track', id }];
const ids = (selection: PCBSelection[]) => selection.map((item) => item.id);
const rectangle = (a: number, b: number, c: number, d: number) => [
  { x: a, y: b },
  { x: c, y: b },
  { x: c, y: d },
  { x: a, y: d },
];
const pad = (): Footprint => ({
  id: 'part',
  libraryId: 'Test:Selection',
  symbolId: null,
  x: 4,
  y: 0,
  rotation: 0,
  side: 'front',
  graphics: [],
  pads: [
    {
      id: 'pad',
      x: 0,
      y: 0,
      rotation: 0,
      number: '1',
      type: 'smd',
      shape: 'rect',
      size: { x: 0.8, y: 0.8 },
      netId: 'out',
    },
  ],
});
const zone = (): BoardZone => ({
  id: 'zone',
  netId: 'out',
  layer: 'F.Cu',
  outline: rectangle(-3, -3, 3, 3),
  clearance: 0.25,
  minThickness: 0.2,
  thermalGap: 0.3,
  thermalBridge: 0.3,
});

test('chain expands both directions through a bend while retaining identities and immutable source geometry', () => {
  const board = fixture();
  board.tracks = [
    track('a', 0, 0, 2, 0),
    track('b', 2, 0, 4, 0),
    track('c', 4, 0, 4, 2),
    track('disconnected', 10, 0, 12, 0),
  ];
  const before = structuredClone(board),
    originalSeeds = seed('b');
  assert.deepEqual(
    ids(expandPCBTrackSelection(board, originalSeeds, defaultPCBDisplay(), filters, 'chain')),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(originalSeeds, seed('b'));
  assert.deepEqual(board, before);
});

test('chain stops at a T branch; connected selection includes every physically joined branch', () => {
  const board = fixture();
  board.tracks = [
    track('a', 0, 0, 2, 0),
    track('b', 2, 0, 4, 0),
    track('c', 4, 0, 6, 0),
    track('branch', 4, 0, 4, 2),
  ];
  assert.deepEqual(
    ids(expandPCBTrackSelection(board, seed('a'), defaultPCBDisplay(), filters, 'chain')),
    ['a', 'b'],
  );
  assert.deepEqual(
    ids(expandPCBTrackSelection(board, seed('a'), defaultPCBDisplay(), filters, 'connected')),
    ['a', 'b', 'c', 'branch'],
  );
});

test('interior crossings are copper contacts on the same layer and terminate chain expansion', () => {
  const board = fixture();
  board.tracks = [
    track('horizontal', -2, 0, 2, 0),
    track('crossing', 0, -2, 0, 2),
    track('other-layer', -1, -1, 1, 1, 'B.Cu'),
    { ...track('foreign', 0, -3, 0, 3), netId: 'gnd' },
  ];
  assert.deepEqual(
    ids(expandPCBTrackSelection(board, seed('horizontal'), defaultPCBDisplay(), filters, 'chain')),
    ['horizontal'],
  );
  assert.deepEqual(
    ids(
      expandPCBTrackSelection(board, seed('horizontal'), defaultPCBDisplay(), filters, 'connected'),
    ),
    ['horizontal', 'crossing'],
  );
});

test('track copper width can join parallel segments without equal endpoints', () => {
  const board = fixture();
  board.tracks = [
    track('a', 0, 0, 2, 0),
    track('touching', 0.5, 0.18, 1.5, 0.18),
    track('separate', 0.5, 0.5, 1.5, 0.5),
  ];
  assert.deepEqual(
    ids(expandPCBTrackSelection(board, seed('a'), defaultPCBDisplay(), filters, 'connected')),
    ['a', 'touching'],
  );
});

test('pads stop a chain and remain read-only connectivity bridges for full selection', () => {
  const board = fixture();
  board.tracks = [track('a', 0, 0, 2, 0), track('b', 2, 0, 4, 0), track('c', 4, 0, 6, 0)];
  board.footprints = [pad()];
  assert.deepEqual(
    ids(expandPCBTrackSelection(board, seed('a'), defaultPCBDisplay(), filters, 'chain')),
    ['a', 'b'],
  );
  const selection = expandPCBTrackSelection(
    board,
    seed('a'),
    defaultPCBDisplay(),
    filters,
    'connected',
  );
  assert.deepEqual(ids(selection), ['a', 'b', 'c']);
  assert.ok(selection.every((item) => item.kind === 'track'));
});

test('through vias stop chain traversal and join full selection across copper layers', () => {
  const board = fixture();
  board.layers = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'];
  board.tracks = [
    track('front', 0, 0, 4, 0),
    track('inner', 4, 0, 6, 0, 'In1.Cu'),
    track('back', 4, 0, 4, 2, 'B.Cu'),
  ];
  board.vias = [{ id: 'via', x: 4, y: 0, diameter: 0.8, drill: 0.2, netId: 'out' }];
  assert.deepEqual(
    ids(expandPCBTrackSelection(board, seed('front'), defaultPCBDisplay(), filters, 'chain')),
    ['front'],
  );
  assert.deepEqual(
    ids(expandPCBTrackSelection(board, seed('front'), defaultPCBDisplay(), filters, 'connected')),
    ['front', 'inner', 'back', 'via'],
  );
  assert.deepEqual(
    ids(
      expandPCBTrackSelection(
        board,
        [{ kind: 'via', id: 'via' }],
        defaultPCBDisplay(),
        filters,
        'chain',
      ),
    ),
    ['via'],
  );
});

test('plated pad annuli bridge layers while drill holes and non-plated pads create no connection', () => {
  const board = fixture(),
    part = pad();
  part.x = 0;
  part.pads[0].type = 'thru_hole';
  part.pads[0].shape = 'circle';
  part.pads[0].size = { x: 4, y: 4 };
  part.pads[0].drill = 2;
  board.footprints = [part];
  board.tracks = [track('inside-hole', -0.2, 0, 0.2, 0), track('back', 2, 0, 3, 0, 'B.Cu')];
  assert.deepEqual(
    ids(
      expandPCBTrackSelection(
        board,
        seed('inside-hole'),
        defaultPCBDisplay(),
        filters,
        'connected',
      ),
    ),
    ['inside-hole'],
  );
  board.tracks[0].end.x = 1.5;
  assert.deepEqual(
    ids(
      expandPCBTrackSelection(
        board,
        seed('inside-hole'),
        defaultPCBDisplay(),
        filters,
        'connected',
      ),
    ),
    ['inside-hole', 'back'],
  );
  part.pads[0].type = 'np_thru_hole';
  assert.deepEqual(
    ids(
      expandPCBTrackSelection(
        board,
        seed('inside-hole'),
        defaultPCBDisplay(),
        filters,
        'connected',
      ),
    ),
    ['inside-hole'],
  );
});

test('a track contained inside a via drill hole does not connect to the annulus or another layer', () => {
  const board = fixture();
  board.tracks = [track('inside-hole', -0.02, 0, 0.02, 0), track('back', 0.4, 0, 1, 0, 'B.Cu')];
  board.tracks[0].width = 0.05;
  board.vias = [{ id: 'via', x: 0, y: 0, diameter: 0.8, drill: 0.4, netId: 'out' }];
  assert.deepEqual(
    ids(
      expandPCBTrackSelection(
        board,
        seed('inside-hole'),
        defaultPCBDisplay(),
        filters,
        'connected',
      ),
    ),
    ['inside-hole'],
  );
});

test('only saved visible fill contours join tracks; outlines and fill holes remain disconnected', () => {
  const board = fixture(),
    pour = zone();
  board.zones = [pour];
  board.tracks = [
    track('a', -2.5, 2, -2, 2),
    track('b', 2, 2, 2.5, 2),
    track('in-hole', -0.2, 0, 0.2, 0),
  ];
  assert.deepEqual(
    ids(expandPCBTrackSelection(board, seed('a'), defaultPCBDisplay(), filters, 'connected')),
    ['a'],
  );
  pour.filledPolygons = [
    { points: copperFillContour({ outer: pour.outline, holes: [rectangle(-1, -1, 1, 1)] }) },
  ];
  assert.deepEqual(
    ids(expandPCBTrackSelection(board, seed('a'), defaultPCBDisplay(), filters, 'connected')),
    ['a', 'b'],
  );
  assert.deepEqual(
    ids(expandPCBTrackSelection(board, seed('in-hole'), defaultPCBDisplay(), filters, 'connected')),
    ['in-hole'],
  );
  assert.deepEqual(
    ids(
      expandPCBTrackSelection(
        board,
        seed('a'),
        { ...defaultPCBDisplay(), copper: false },
        filters,
        'connected',
      ),
    ),
    ['a'],
  );
  assert.deepEqual(
    ids(expandPCBTrackSelection(board, seed('a'), defaultPCBDisplay(), filters, 'chain')),
    ['a'],
  );
});

test('saved fill islands never join disconnected same-net copper groups', () => {
  const board = fixture(),
    pour = zone();
  pour.filledPolygons = [
    { points: rectangle(-3, -1, -1, 1) },
    { points: rectangle(1, -1, 3, 1), island: true },
  ];
  board.zones = [pour];
  board.tracks = [track('left', -2, 0, -1.5, 0), track('right', 1.5, 0, 2, 0)];
  assert.deepEqual(
    ids(expandPCBTrackSelection(board, seed('left'), defaultPCBDisplay(), filters, 'connected')),
    ['left'],
  );
});

test('hidden layers and disabled track/via filters are excluded from both selection and traversal', () => {
  const board = fixture();
  board.tracks = [track('front', 0, 0, 4, 0), track('back', 4, 0, 6, 0, 'B.Cu')];
  board.vias = [{ id: 'via', x: 4, y: 0, diameter: 0.8, drill: 0.2, netId: 'out' }];
  const hiddenBack = { ...defaultPCBDisplay(), 'B.Cu': false };
  assert.deepEqual(
    ids(expandPCBTrackSelection(board, seed('front'), hiddenBack, filters, 'connected')),
    ['front', 'via'],
  );
  assert.deepEqual(
    ids(expandPCBTrackSelection(board, seed('back'), hiddenBack, filters, 'connected')),
    [],
  );
  assert.deepEqual(
    ids(
      expandPCBTrackSelection(
        board,
        seed('front'),
        defaultPCBDisplay(),
        { ...filters, via: false },
        'connected',
      ),
    ),
    ['front'],
  );
  assert.deepEqual(
    ids(
      expandPCBTrackSelection(
        board,
        [{ kind: 'via', id: 'via' }],
        defaultPCBDisplay(),
        { ...filters, track: false },
        'connected',
      ),
    ),
    ['via'],
  );
  assert.deepEqual(
    ids(
      expandPCBTrackSelection(
        board,
        [{ kind: 'footprint', id: 'part' }],
        defaultPCBDisplay(),
        filters,
        'connected',
      ),
    ),
    [],
  );
});

test('selection remains atomic when copper object bounds are exceeded', () => {
  const board = fixture();
  board.tracks = Array.from({ length: 15001 }, (_, i) => track(`track-${i}`, i, 0, i + 0.5, 0));
  const before = structuredClone(board);
  assert.throws(
    () =>
      expandPCBTrackSelection(board, seed('track-0'), defaultPCBDisplay(), filters, 'connected'),
    /geometry limit/,
  );
  assert.deepEqual(board, before);
});
