import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLayoutParasitics, PARASITICS_DEFAULTS } from '../lib/layout-parasitics';
import type { Point } from '../lib/circuit';
import type { BoardZone, CopperLayer, Footprint, PCB } from '../lib/pcb';
import { createEmptyPCB } from '../lib/pcb-layout';

const rho = 1.724e-5;
const netId = 'signal';
const origin = { x: 0, y: 0 };
const finish = { x: 10, y: 0 };
const endpoints = { startId: 'start-pad', endId: 'end-pad' };

function footprint(name: string, at: Point, layer: CopperLayer = 'F.Cu'): Footprint {
  return {
    ...at,
    id: name,
    symbolId: null,
    libraryId: 'Test:Terminal',
    side: layer === 'B.Cu' ? 'back' : 'front',
    rotation: 0,
    graphics: [],
    pads: [
      {
        ...origin,
        id: `${name}-pad`,
        number: '1',
        netId,
        layers: [layer],
        size: { x: 0.8, y: 0.8 },
        type: 'smd',
        shape: 'circle',
        rotation: 0,
      },
    ],
  };
}

function track(
  id: string,
  start: Point,
  end: Point,
  layer: CopperLayer = 'F.Cu',
  width = 0.25,
): PCB['tracks'][number] {
  return { id, start, end, width, layer, netId };
}

function makeBoard(endLayer: CopperLayer = 'F.Cu'): PCB {
  return {
    ...createEmptyPCB(),
    nets: [{ id: netId, name: 'Signal' }],
    footprints: [footprint('start', origin), footprint('end', finish, endLayer)],
  };
}

function close(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * 1e-12, `${actual} vs ${expected}`);
}

test('straight series tracks use their native lengths, widths and explicit copper thickness', () => {
  const board = makeBoard();
  const middle = { x: 3, y: 0 };
  board.tracks = [track('thin', origin, middle), track('thick', middle, finish, 'F.Cu', 0.5)];
  const before = structuredClone(board);
  const result = analyzeLayoutParasitics(board, { ...endpoints, copperThicknessMm: 0.07 });
  const expected = (rho * (3 / 0.25 + 7 / 0.5)) / 0.07;
  assert.equal(result.netName, 'Signal');
  assert.equal(result.shortestLengthMm, 10);
  assert.deepEqual(result.path, [
    { id: 'thin', kind: 'track' },
    { id: 'thick', kind: 'track' },
  ]);
  close(result.shortestResistanceOhm, expected);
  close(result.equivalentResistanceOhm, expected);
  assert.deepEqual(board, before);
});

test('the shortest path is length based and parallel copper lowers equivalent resistance', () => {
  const board = makeBoard();
  const cornerA = { x: 0, y: 3 };
  const cornerB = { x: 10, y: 3 };
  board.tracks = [
    track('direct', origin, finish),
    track('branch-a', origin, cornerA, 'F.Cu', 0.7),
    track('branch-b', cornerA, cornerB, 'F.Cu', 0.7),
    track('branch-c', cornerB, finish, 'F.Cu', 0.7),
    track('stub', cornerB, { x: 10, y: 7 }),
  ];
  const result = analyzeLayoutParasitics(board, endpoints);
  const short = (rho * 10) / (0.25 * PARASITICS_DEFAULTS.copperThicknessMm);
  const long = (rho * 16) / (0.7 * PARASITICS_DEFAULTS.copperThicknessMm);
  assert.equal(result.shortestLengthMm, 10);
  assert.deepEqual(result.path, [{ id: 'direct', kind: 'track' }]);
  close(result.shortestResistanceOhm, short);
  close(result.equivalentResistanceOhm, 1 / (1 / short + 1 / long));
});

test('a selected through via uses F.Cu and measures only the traversed barrel sections', () => {
  const board = makeBoard('In2.Cu');
  board.layers = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'];
  board.footprints.shift();
  board.vias = [{ ...origin, id: 'via', drill: 0.3, diameter: 0.6, netId }];
  board.tracks = [track('inner', origin, finish, 'In2.Cu')];
  const result = analyzeLayoutParasitics(board, {
    ...endpoints,
    startId: 'via',
    viaPlatingMm: 0.03,
  });
  const span = (2 * board.thickness) / 3;
  const barrel = (rho * span) / (Math.PI * 0.03 * (0.3 + 0.03));
  const inner = (rho * 10) / (0.25 * PARASITICS_DEFAULTS.copperThicknessMm);
  assert.equal(result.startLayer, 'F.Cu');
  assert.equal(result.endLayer, 'In2.Cu');
  assert.deepEqual(result.path, [
    { id: 'via', kind: 'via' },
    { id: 'inner', kind: 'track' },
  ]);
  close(result.shortestLengthMm, 10 + span);
  close(result.shortestResistanceOhm, barrel + inner);
  close(result.equivalentResistanceOhm, barrel + inner);
});

test('different copper layers do not connect without a via or plated pad', () => {
  const board = makeBoard('B.Cu');
  const middle = { x: 5, y: 0 };
  board.tracks = [track('top', origin, middle), track('back', middle, finish, 'B.Cu')];
  assert.throws(() => analyzeLayoutParasitics(board, endpoints), /disconnected/);
  board.vias = [{ ...middle, id: 'bridge', drill: 0.3, diameter: 0.6, netId }];
  const result = analyzeLayoutParasitics(board, endpoints);
  const plating = PARASITICS_DEFAULTS.viaPlatingMm;
  const barrel = (rho * board.thickness) / (Math.PI * plating * (0.3 + plating));
  close(
    result.equivalentResistanceOhm,
    (rho * 10) / (0.25 * PARASITICS_DEFAULTS.copperThicknessMm) + barrel,
  );
  close(result.shortestLengthMm, 10 + board.thickness);
  assert.throws(
    () => analyzeLayoutParasitics(board, { ...endpoints, viaPlatingMm: 0.2 }),
    /annuli/,
  );
});

test('unsupported copper contacts and zone fills fail instead of reporting a partial resistance', () => {
  const board = makeBoard();
  board.tracks = [track('main', origin, finish), track('branch', { x: 5, y: 0 }, { x: 5, y: 3 })];
  assert.throws(() => analyzeLayoutParasitics(board, endpoints), /shared endpoint/);
  board.tracks = [track('off-center', { x: 0.2, y: 0 }, finish)];
  assert.throws(() => analyzeLayoutParasitics(board, endpoints), /pad or via at its center/);
  const outline = [origin, { x: 2, y: 0 }, { x: 2, y: 2 }];
  const zone: BoardZone = {
    id: 'pour',
    netId,
    layer: 'F.Cu',
    outline,
    clearance: 0.2,
    minThickness: 0.2,
    thermalGap: 0.2,
    thermalBridge: 0.3,
    filledPolygons: [{ points: outline }],
  };
  board.tracks = [track('main', origin, finish)];
  board.zones = [zone];
  assert.throws(() => analyzeLayoutParasitics(board, endpoints), /Filled copper zones/);
  board.zones = [{ ...zone, filledPolygons: [] }];
  assert.equal(analyzeLayoutParasitics(board, endpoints).shortestLengthMm, 10);
});

test('unknown terminals, invalid thicknesses and oversized nets are rejected', () => {
  const board = makeBoard();
  assert.throws(
    () => analyzeLayoutParasitics(board, { ...endpoints, startId: 'missing' }),
    /same assigned net/,
  );
  assert.throws(
    () => analyzeLayoutParasitics(board, { ...endpoints, startId: endpoints.endId }),
    /two different/,
  );
  assert.throws(
    () => analyzeLayoutParasitics(board, { ...endpoints, copperThicknessMm: 0 }),
    /between/,
  );
  board.tracks = Array.from({ length: 256 }, (_, index) =>
    track(`track-${index}`, { x: index, y: 10 }, { x: index + 1, y: 10 }),
  );
  assert.throws(() => analyzeLayoutParasitics(board, endpoints), /analysis limit/);
});
