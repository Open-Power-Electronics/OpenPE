import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Point } from '../lib/circuit';
import type { Footprint, PCB } from '../lib/pcb';
import { defaultPCBDisplay } from '../lib/pcb-display';
import { createEmptyPCB, flipPCBFootprint, footprintPoint, padPosition } from '../lib/pcb-layout';
import {
  createPCBRouteAnchorResolver,
  resolvePCBRouteAnchor,
  type PCBRouteAnchorOptions,
} from '../lib/pcb-route-anchor';

const fixture = (): PCB => ({
  ...createEmptyPCB(),
  nets: [
    { id: 'out', name: 'OUT' },
    { id: 'gnd', name: 'GND' },
  ],
});
const footprint = (id: string, x = 0, y = 0): Footprint => ({
  id: `footprint-${id}`,
  symbolId: null,
  libraryId: 'Test:RouteAnchor',
  x,
  y,
  rotation: 0,
  side: 'front',
  graphics: [],
  pads: [
    {
      id,
      number: '1',
      x: 0,
      y: 0,
      rotation: 0,
      type: 'smd',
      shape: 'rect',
      size: { x: 0.2, y: 0.2 },
      netId: 'out',
    },
  ],
});
const track = (id = 'track'): PCB['tracks'][number] => ({
  id,
  start: { x: 0.1234, y: 1.2345 },
  end: { x: 10.1234, y: 1.2345 },
  width: 0.2,
  layer: 'F.Cu',
  netId: 'out',
});
const resolve = (board: PCB, point: Point, options: Partial<PCBRouteAnchorOptions> = {}) =>
  resolvePCBRouteAnchor(board, point, {
    display: defaultPCBDisplay(),
    layer: 'F.Cu',
    tolerance: 0.5,
    gridPoint: { x: Math.round(point.x * 2) / 2, y: Math.round(point.y * 2) / 2 },
    ...options,
  });

test('magnetic attraction preserves an exact off-grid small pad center independently of artwork stacking', () => {
  const board = fixture(),
    part = footprint('pad', 3.123456, 4.654321);
  board.footprints = [part];
  board.graphics = [
    {
      id: 'cover',
      kind: 'polygon',
      layer: 'F.SilkS',
      width: 0.1,
      fill: true,
      start: { x: 0, y: 0 },
      points: [
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      end: { x: 0, y: 10 },
    },
  ];
  const before = structuredClone(board);
  const result = resolve(board, { x: 3.4, y: 4.8 });
  assert.equal(result.error, '');
  assert.deepEqual(result.point, { x: 3.123456, y: 4.654321 });
  assert.equal(result.target?.kind, 'pad');
  if (result.target?.kind === 'pad') {
    assert.equal(result.target.pad, part.pads[0]);
    assert.equal(result.target.footprint, part);
  }
  assert.deepEqual(board, before);
});

test('rotated narrow pads use transformed body geometry instead of empty world bounding corners', () => {
  const board = fixture(),
    part = footprint('pad', 10, 10);
  part.rotation = 45;
  part.pads[0].size = { x: 8, y: 0.3 };
  board.footprints = [part];
  const actualBody = footprintPoint(part, { x: 3, y: 0 });
  assert.equal(resolve(board, actualBody, { tolerance: 0.05 }).target?.id, 'pad');
  const emptyCorner = { x: 12, y: 12 };
  assert.deepEqual(resolve(board, emptyCorner, { tolerance: 0.05 }), {
    point: emptyCorner,
    error: '',
  });
  const flipped = flipPCBFootprint(part);
  flipped.pads[0].x = 2;
  flipped.pads[0].y = 1;
  board.footprints = [flipped];
  const center = padPosition(flipped, flipped.pads[0]);
  assert.deepEqual(resolve(board, center).point, center);
});

test('plated pad and via hole interiors retain normal center anchors, while NPTH has none', () => {
  const board = fixture(),
    part = footprint('pad');
  part.pads[0] = {
    ...part.pads[0],
    type: 'thru_hole',
    shape: 'circle',
    size: { x: 2, y: 2 },
    drill: 1.95,
  };
  board.footprints = [part];
  assert.equal(resolve(board, { x: 0.5, y: 0 }, { tolerance: 0 }).target?.id, 'pad');
  board.footprints = [];
  board.vias = [{ id: 'via', x: 0, y: 0, diameter: 2, drill: 1.95, netId: 'out' }];
  assert.deepEqual(resolve(board, { x: 0.5, y: 0 }, { tolerance: 0 }).point, { x: 0, y: 0 });
  board.vias = [];
  part.pads[0].type = 'np_thru_hole';
  part.pads[0].netId = null;
  board.footprints = [part];
  assert.deepEqual(resolve(board, { x: 0, y: 0 }), { point: { x: 0, y: 0 }, error: '' });
});

test('near track endpoints win over their own projection; middle anchors retain precise projection', () => {
  const board = fixture();
  board.tracks = [track()];
  assert.deepEqual(resolve(board, { x: 0.3234, y: 1.2845 }).point, board.tracks[0].start);
  assert.deepEqual(resolve(board, { x: 9.9234, y: 1.2845 }).point, board.tracks[0].end);
  assert.deepEqual(resolve(board, { x: 5.2345, y: 1.3545 }).point, { x: 5.2345, y: 1.2345 });
  assert.deepEqual(resolve(board, { x: 10.4, y: 1.3 }).point, board.tracks[0].end);
});

test('track hit testing uses copper capsules rather than empty diagonal bounding corners', () => {
  const board = fixture();
  board.tracks = [{ ...track(), start: { x: 0, y: 0 }, end: { x: 10, y: 10 } }];
  assert.equal(resolve(board, { x: 8, y: 2 }, { tolerance: 0.1 }).target, undefined);
  const result = resolve(board, { x: 4.2, y: 4 });
  assert.deepEqual(result.point, { x: 4.1, y: 4.1 });
  assert.equal(result.target?.kind, 'track');
});

test('starting routes may choose visible source layers but prefer the active layer in an overlap', () => {
  const board = fixture(),
    back = footprint('back'),
    front = footprint('front');
  back.side = 'back';
  board.footprints = [back, front];
  assert.equal(resolve(board, { x: 0, y: 0 }).target?.id, 'front');
  board.footprints = [back];
  const result = resolve(board, { x: 0, y: 0 });
  assert.equal(result.target?.id, 'back');
  assert.equal(result.target?.layer, 'B.Cu');
  assert.equal(result.error, '');
  board.footprints = [];
  board.tracks = [{ ...track(), layer: 'B.Cu' }];
  assert.equal(resolve(board, { x: 5, y: 1.2345 }).target?.layer, 'B.Cu');
});

test('active routes choose compatible visible copper in an overlap and by proximity', () => {
  const board = fixture(),
    foreign = footprint('foreign'),
    own = footprint('own');
  foreign.pads[0].netId = 'gnd';
  board.footprints = [foreign, own];
  assert.equal(resolve(board, { x: 0, y: 0 }, { netId: 'out' }).target?.id, 'own');
  board.footprints = [footprint('far', 0.4), footprint('near', 0.15)];
  const result = resolve(board, { x: 0, y: 0 }, { netId: 'out' });
  assert.equal(result.target?.id, 'near');
  assert.equal(result.error, '');
});

test('an explicit foreign object is actionable even with compatible magnetic copper nearby', () => {
  const board = fixture(),
    foreign = footprint('foreign'),
    own = footprint('own', 0.4);
  foreign.pads[0].netId = 'gnd';
  board.footprints = [own, foreign];
  const result = resolve(board, { x: 0, y: 0 }, { netId: 'out' });
  assert.equal(result.target?.id, 'foreign');
  assert.deepEqual(result.point, { x: 0, y: 0 });
  assert.match(result.error, /another net/);
  board.footprints = [];
  board.tracks = [{ ...track(), netId: 'gnd' }];
  assert.match(resolve(board, { x: 5, y: 1.2345 }, { netId: 'out' }).error, /another net/);
  assert.equal(
    resolve(board, { x: 5, y: 1.6 }, { netId: 'out' }).target,
    undefined,
    'A merely nearby foreign object does not attract the active route.',
  );
});

test('explicit wrong-layer pads and tracks return the exact rejected endpoint and guidance', () => {
  const board = fixture(),
    back = footprint('back', 0.123456, 0.654321);
  back.side = 'back';
  board.footprints = [back];
  const result = resolve(board, { x: back.x, y: back.y }, { netId: 'out' });
  assert.equal(result.target?.layer, 'B.Cu');
  assert.deepEqual(result.point, { x: back.x, y: back.y });
  assert.match(result.error, /pad on its copper layer/);
  board.footprints = [];
  board.tracks = [{ ...track(), layer: 'B.Cu' }];
  assert.match(resolve(board, { x: 5, y: 1.2345 }, { netId: 'out' }).error, /same copper layer/);
});

test('netless pads fail visibly, and a supplied empty net cannot masquerade as a route start', () => {
  const board = fixture(),
    part = footprint('pad');
  part.pads[0].netId = null;
  board.footprints = [part];
  const result = resolve(board, { x: 0, y: 0 });
  assert.equal(result.target?.id, 'pad');
  assert.match(result.error, /no net/);
  assert.match(resolve(board, { x: 0, y: 0 }, { netId: '' }).error, /valid routing net/);
});

test('hidden copper and footprint display remove targets while visible through anchors stay usable', () => {
  const board = fixture(),
    part = footprint('pad'),
    display = defaultPCBDisplay();
  board.footprints = [part];
  board.tracks = [track()];
  board.vias = [{ id: 'via', x: 3, y: 0, diameter: 0.8, drill: 0.4, netId: 'out' }];
  display['F.Cu'] = false;
  const resolver = createPCBRouteAnchorResolver(board, display);
  const options = { layer: 'F.Cu' as const, tolerance: 0.1, gridPoint: { x: 0, y: 0 } };
  assert.equal(resolver.resolve({ x: 0, y: 0 }, options).target, undefined);
  assert.equal(resolver.resolve({ x: 5, y: 1.2345 }, options).target, undefined);
  assert.equal(resolver.resolve({ x: 3, y: 0 }, options).target?.id, 'via');
  part.pads[0].type = 'thru_hole';
  assert.equal(
    createPCBRouteAnchorResolver(board, display).resolve({ x: 0, y: 0 }, options).target?.id,
    'pad',
  );
  display.footprints = false;
  assert.equal(
    createPCBRouteAnchorResolver(board, display).resolve({ x: 0, y: 0 }, options).target,
    undefined,
  );
  display['B.Cu'] = false;
  assert.equal(
    createPCBRouteAnchorResolver(board, display).resolve({ x: 3, y: 0 }, options).target,
    undefined,
  );
});

test('through pads, vias and inner-layer pads return their actual physical layer metadata', () => {
  const board = fixture(),
    part = footprint('pad');
  board.layers = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'];
  part.pads[0].layers = ['In2.Cu'];
  board.footprints = [part];
  const result = resolve(board, { x: 0, y: 0 }, { layer: 'In2.Cu', netId: 'out' });
  assert.equal(result.error, '');
  assert.equal(result.target?.layer, 'In2.Cu');
  if (result.target?.kind === 'pad') assert.deepEqual(result.target.layers, ['In2.Cu']);
  board.footprints = [];
  board.vias = [{ id: 'via', x: 0, y: 0, diameter: 0.8, drill: 0.4, netId: 'out' }];
  assert.equal(
    resolve(board, { x: 0, y: 0 }, { layer: 'In1.Cu', netId: 'out' }).target?.layer,
    'In1.Cu',
  );
});

test('object-snap suppression returns the exact supplied free/grid point without a target', () => {
  const board = fixture();
  board.footprints = [footprint('pad')];
  const gridPoint = { x: 0.765432, y: 0.123456 };
  assert.deepEqual(resolve(board, { x: 0, y: 0 }, { gridPoint, objectSnap: false }), {
    point: gridPoint,
    error: '',
  });
  assert.deepEqual(resolve(fixture(), { x: 10, y: 10 }), { point: { x: 10, y: 10 }, error: '' });
});

test('prepared resolvers and tie ordering are deterministic and never mutate board or settings', () => {
  const board = fixture();
  board.footprints = [footprint('first'), footprint('second')];
  const before = structuredClone(board),
    display = defaultPCBDisplay(),
    originalDisplay = structuredClone(display),
    resolver = createPCBRouteAnchorResolver(board, display),
    options = { layer: 'F.Cu' as const, tolerance: 0.5, gridPoint: { x: 0, y: 0 } },
    originalOptions = structuredClone(options);
  const first = resolver.resolve({ x: 0, y: 0 }, options);
  assert.equal(first.target?.id, 'first');
  for (let i = 0; i < 10; i++) assert.deepEqual(resolver.resolve({ x: 0, y: 0 }, options), first);
  assert.deepEqual(board, before);
  assert.deepEqual(display, originalDisplay);
  assert.deepEqual(options, originalOptions);
});

test('invalid coordinates and tolerance return nonthrowing actionable errors before target changes', () => {
  const board = fixture();
  for (const point of [
    { x: NaN, y: 0 },
    { x: 100001, y: 0 },
  ])
    assert.match(resolve(board, point).error, /outside the supported range/);
  for (const tolerance of [-1, NaN, Infinity, 100001])
    assert.match(
      resolve(board, { x: 0, y: 0 }, { tolerance }).error,
      /outside the supported range/,
    );
  assert.match(
    resolve(board, { x: 0, y: 0 }, { gridPoint: { x: Infinity, y: 0 } }).error,
    /outside/,
  );
});

test('object, vertex and dense-candidate bounds fail atomically and snap suppression remains usable', () => {
  const board = fixture();
  board.tracks = Array.from({ length: 15001 }, (_, i) => track(`track-${i}`));
  const large = createPCBRouteAnchorResolver(board, defaultPCBDisplay()),
    options = { layer: 'F.Cu' as const, tolerance: 0.5, gridPoint: { x: 5, y: 1 } };
  assert.match(large.resolve({ x: 5, y: 1.2345 }, options).error, /geometry limit/);
  assert.deepEqual(large.resolve({ x: 5, y: 1.2345 }, { ...options, objectSnap: false }), {
    point: options.gridPoint,
    error: '',
  });
  board.tracks = Array.from({ length: 513 }, (_, i) => track(`track-${i}`));
  assert.match(resolve(board, { x: 5, y: 1.2345 }).error, /geometry limit/);
  board.tracks.pop();
  assert.equal(resolve(board, { x: 5, y: 1.2345 }).target?.id, 'track-0');
  board.tracks = [];
  board.footprints = Array.from({ length: 1000 }, (_, i) => {
    const part = footprint(`pad-${i}`);
    part.pads[0].shape = 'circle';
    part.pads[0].size = { x: 100, y: 100 };
    return part;
  });
  const result = resolve(board, { x: 0, y: 0 });
  assert.match(result.error, /geometry limit/);
  assert.equal(result.target, undefined);
});
