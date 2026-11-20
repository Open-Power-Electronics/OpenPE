import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  analyzeLayoutParasitics,
  PARASITICS_DEFAULTS,
} from '../plugins/layout-parasitics/domain/analysis';
import type { Point } from '../lib/circuit';
import {
  serializePCB,
  type BoardZone,
  type CopperLayer,
  type Footprint,
  type PCB,
} from '../lib/pcb';
import { createEmptyPCB } from '../lib/pcb-layout';
import { parseKiCadPCB } from '../lib/kicad-pcb';
import { parseProject } from '../lib/project';
import referenceSources from '../lib/reference-examples.json';
import { preparePCBTrackAnchors } from '../lib/pcb-track-anchors';
import { polygonEdges, segmentDistance } from '../lib/pcb-collision';

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

function straightPartialInductance(length: number, radius: number) {
  return 0.2 * (length * Math.asinh(length / radius) - Math.hypot(length, radius) + radius);
}

test('partial inductance includes collinear mutual terms and is invariant to route direction', () => {
  const board = makeBoard();
  const radius = Math.exp(-1.5) * (0.25 + PARASITICS_DEFAULTS.copperThicknessMm);
  const expected = straightPartialInductance(10, radius);
  board.tracks = [track('whole', origin, finish)];
  close(analyzeLayoutParasitics(board, endpoints).shortestPartialInductanceNh!, expected);

  const middle = { x: 3, y: 0 };
  board.tracks = [track('left', origin, middle), track('right', finish, middle)];
  const split = analyzeLayoutParasitics(board, endpoints).shortestPartialInductanceNh!;
  const reversed = analyzeLayoutParasitics(board, {
    startId: endpoints.endId,
    endId: endpoints.startId,
  }).shortestPartialInductanceNh!;
  assert.ok(Math.abs(split - expected) < 1e-6);
  assert.ok(Math.abs(reversed - expected) < 1e-6);
});

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
  const expectedInductance =
    straightPartialInductance(span, (0.3 + 0.03) / 2) +
    straightPartialInductance(10, Math.exp(-1.5) * (0.25 + PARASITICS_DEFAULTS.copperThicknessMm));
  assert.ok(Math.abs(result.shortestPartialInductanceNh! - expectedInductance) < 1e-6);
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

test('off-center endpoints join the copper pad and retain native track length', () => {
  const board = makeBoard();
  board.tracks = [track('offset', { x: 0.2, y: 0 }, { x: 9.8, y: 0 })];
  const result = analyzeLayoutParasitics(board, endpoints);
  close(result.shortestLengthMm, 9.6);
  close(
    result.equivalentResistanceOhm,
    (rho * 9.6) / (0.25 * PARASITICS_DEFAULTS.copperThicknessMm),
  );
});

test('a track endpoint on a via annulus joins the barrel on its own layer', () => {
  const board = makeBoard('B.Cu');
  board.footprints.shift();
  board.vias = [{ ...origin, id: 'via', drill: 0.3, diameter: 0.6, netId }];
  board.tracks = [track('back', { x: 0.2, y: 0 }, finish, 'B.Cu')];
  const result = analyzeLayoutParasitics(board, { ...endpoints, startId: 'via' });
  close(result.shortestLengthMm, 9.8 + board.thickness);
  assert.deepEqual(result.path, [
    { id: 'via', kind: 'via' },
    { id: 'back', kind: 'track' },
  ]);
});

test('a round end cap joins a pad and carries the contact to a narrower track at its junction', () => {
  const board = makeBoard();
  const joint = { x: 0.45, y: 0 };
  board.tracks = [
    track('wide', joint, { x: 1.45, y: 2 }, 'F.Cu', 0.25),
    track('narrow', joint, finish, 'F.Cu', 0.05),
  ];
  const result = analyzeLayoutParasitics(board, endpoints);
  close(result.shortestLengthMm, 9.55);
  close(
    result.equivalentResistanceOhm,
    (rho * 9.55) / (0.05 * PARASITICS_DEFAULTS.copperThicknessMm),
  );
});

test('LM2596 Buck measures both the native input and output pad pairs', () => {
  const project = parseProject(referenceSources['reference-lm2596-to220-5-buck']);
  const stem = 'lm2596-to220-5-buck';
  const source = readFileSync(`examples/${stem}/${stem}.kicad_pcb`, 'utf8');
  const { board } = parseKiCadPCB(source, project.schematic, stem);
  const pad = (reference: string) => {
    const symbol = project.schematic.parts.find(({ ref }) => ref === reference)!;
    return board.footprints
      .find(({ symbolId }) => symbolId === symbol.id)!
      .pads.find(({ number }) => number === '1')!;
  };
  const result = analyzeLayoutParasitics(board, { startId: pad('C2').id, endId: pad('J2').id });
  assert.equal(result.netName, '/VOUT');
  const length = 2.95 + Math.hypot(2.31, 2.31) + 2.94;
  close(result.shortestLengthMm, length);
  close(
    result.equivalentResistanceOhm,
    (rho * length) / (0.8 * PARASITICS_DEFAULTS.copperThicknessMm),
  );
  assert.ok(result.shortestPartialInductanceNh! > 0);

  const input = analyzeLayoutParasitics(board, { startId: pad('C1').id, endId: pad('U1').id });
  assert.equal(input.netName, '/VIN');
  const inputLength = 54.725 - 48.25;
  close(input.shortestLengthMm, inputLength);
  assert.ok(input.shortestPartialInductanceNh! > 0);
  close(
    input.equivalentResistanceOhm,
    (rho * inputLength) / (0.8 * PARASITICS_DEFAULTS.copperThicknessMm),
  );
});

test('LM25017 native and Home D1.2–C8.1 measurement handles its annulus entry and drill-erased finishing stub without rewriting copper', () => {
  const project = parseProject(referenceSources['reference-lm25017-wson8-flybuck']);
  const stem = 'lm25017-wson8-flybuck';
  const { board: native } = parseKiCadPCB(
    readFileSync(`examples/${stem}/${stem}.kicad_pcb`, 'utf8'),
    project.schematic,
    stem,
  );
  for (const board of [project.pcb!, native]) {
    const pad = (reference: string, number: string) =>
      board.footprints
        .find(
          ({ symbolId }) =>
            symbolId === project.schematic.parts.find(({ ref }) => ref === reference)!.id,
        )!
        .pads.find((pad) => pad.number === number)!;
    const input = { startId: pad('D1', '2').id, endId: pad('C8', '1').id };
    const before = structuredClone(board);
    const bytes = serializePCB(board, project.schematic);
    const result = analyzeLayoutParasitics(board, input);
    assert.equal(result.netName, '/VOUT1');
    close(result.shortestLengthMm, 19.30698051533947);
    close(result.equivalentResistanceOhm, 0.02377516743460375);
    assert.ok(result.shortestPartialInductanceNh! > 0);
    const noStub = {
      ...board,
      tracks: board.tracks.filter((track) => track.id !== '274a57d5-fc73-4c34-b998-b2adee6fd995'),
    };
    assert.deepEqual(analyzeLayoutParasitics(noStub, input), result);
    assert.ok(
      analyzeLayoutParasitics(board, { ...input, endId: pad('J2', '1').id }).shortestLengthMm >
        result.shortestLengthMm,
    );
    assert.deepEqual(board, before);
    assert.equal(serializePCB(board, project.schematic), bytes);
  }
});

test('interior pad contacts split the read-only graph once and match explicit native splits and reversed routes', () => {
  const board = makeBoard();
  board.footprints[0].x = 2;
  board.footprints[1].x = 8;
  board.tracks = [track('whole', origin, finish)];
  const before = structuredClone(board);
  const result = analyzeLayoutParasitics(board, endpoints);
  close(result.shortestLengthMm, 6);
  close(result.equivalentResistanceOhm, (rho * 6) / (0.25 * PARASITICS_DEFAULTS.copperThicknessMm));
  assert.deepEqual(result.path, [{ id: 'whole', kind: 'track' }]);
  const explicit = {
    ...board,
    tracks: [
      track('left', origin, { x: 2, y: 0 }),
      track('middle', { x: 2, y: 0 }, { x: 8, y: 0 }),
      track('right', { x: 8, y: 0 }, finish),
    ],
  };
  for (const candidate of [
    result,
    analyzeLayoutParasitics(explicit, endpoints),
    analyzeLayoutParasitics(board, { startId: endpoints.endId, endId: endpoints.startId }),
    analyzeLayoutParasitics({ ...board, tracks: [track('reversed', finish, origin)] }, endpoints),
  ]) {
    close(candidate.shortestLengthMm, result.shortestLengthMm);
    close(candidate.shortestResistanceOhm, result.shortestResistanceOhm);
    close(candidate.equivalentResistanceOhm, result.equivalentResistanceOhm);
    assert.ok(
      Math.abs(candidate.shortestPartialInductanceNh! - result.shortestPartialInductanceNh!) < 1e-6,
    );
  }
  assert.deepEqual(board, before);
  const through = makeBoard();
  through.footprints.push(footprint('middle', { x: 5, y: 0 }));
  through.tracks = [track('one-source-track', origin, finish)];
  const subdivided = analyzeLayoutParasitics(through, endpoints);
  close(subdivided.shortestLengthMm, 10);
  assert.deepEqual(subdivided.path, [{ id: 'one-source-track', kind: 'track' }]);
  assert.ok(
    Math.abs(
      subdivided.shortestPartialInductanceNh! -
        straightPartialInductance(
          10,
          Math.exp(-1.5) * (0.25 + PARASITICS_DEFAULTS.copperThicknessMm),
        ),
    ) < 1e-6,
  );
});

test('virtual body junctions retain parallel copper conductance without duplicating the original unsplit edge', () => {
  const board = makeBoard();
  board.footprints[0].x = 5;
  const middle = { x: 5, y: 0 },
    a = { x: 5, y: 3 },
    b = { x: 10, y: 3 };
  board.tracks = [
    track('whole', origin, finish),
    track('up', middle, a, 'F.Cu', 0.7),
    track('across', a, b, 'F.Cu', 0.7),
    track('down', b, finish, 'F.Cu', 0.7),
  ];
  const result = analyzeLayoutParasitics(board, endpoints);
  const direct = (rho * 5) / (0.25 * PARASITICS_DEFAULTS.copperThicknessMm),
    parallel = (rho * 11) / (0.7 * PARASITICS_DEFAULTS.copperThicknessMm);
  close(result.shortestLengthMm, 5);
  close(result.shortestResistanceOhm, direct);
  close(result.equivalentResistanceOhm, 1 / (1 / direct + 1 / parallel));
});

test('a shared proven copper land permits interior track intersections while an ordinary T junction remains unsupported', () => {
  const board = makeBoard();
  board.footprints.push(footprint('middle', { x: 5, y: 0 }));
  board.tracks = [track('main', origin, finish), track('branch', { x: 5, y: -3 }, { x: 5, y: 3 })];
  const result = analyzeLayoutParasitics(board, endpoints);
  close(result.shortestLengthMm, 10);
  close(
    result.equivalentResistanceOhm,
    (rho * 10) / (0.25 * PARASITICS_DEFAULTS.copperThicknessMm),
  );
  board.footprints.pop();
  assert.throws(() => analyzeLayoutParasitics(board, endpoints), /shared endpoint/);
});

test('interior via contacts retain layer-local nodes, finite barrel resistance and native conductor lengths', () => {
  const board = makeBoard('B.Cu');
  board.footprints.shift();
  board.vias = [{ id: 'middle-via', x: 5, y: 0, drill: 0.3, diameter: 0.6, netId }];
  board.tracks = [track('back', origin, finish, 'B.Cu')];
  const result = analyzeLayoutParasitics(board, { startId: 'middle-via', endId: endpoints.endId });
  close(result.shortestLengthMm, 5 + board.thickness);
  close(
    result.equivalentResistanceOhm,
    (rho * 5) / (0.25 * PARASITICS_DEFAULTS.copperThicknessMm) +
      (rho * board.thickness) / (Math.PI * 0.025 * (0.3 + 0.025)),
  );
  assert.deepEqual(result.path, [
    { id: 'middle-via', kind: 'via' },
    { id: 'back', kind: 'track' },
  ]);
  assert.ok(result.shortestPartialInductanceNh! > 0);
  const separate = makeBoard('B.Cu');
  separate.footprints[0].x = 5;
  separate.tracks = board.tracks;
  assert.throws(() => analyzeLayoutParasitics(separate, endpoints), /disconnected/);
});

test('off-center hole endpoints retain full native length and wholly drill-erased stubs cannot create a connection', () => {
  const board = makeBoard();
  Object.assign(board.footprints[0].pads[0], {
    type: 'thru_hole',
    shape: 'oval',
    size: { x: 2, y: 1.5 },
    drill: 0.8,
    layers: ['*.Cu'],
    rotation: 30,
    drillOffset: { x: 0.1, y: 0 },
  });
  const offset = { x: 0.025, y: 0.025 };
  board.tracks = [
    track('real', offset, finish, 'F.Cu', 0.1),
    track('drilled', origin, offset, 'F.Cu', 0.1),
  ];
  const result = analyzeLayoutParasitics(board, endpoints);
  close(result.shortestLengthMm, Math.hypot(10 - 0.025, 0.025));
  assert.deepEqual(result.path, [{ id: 'real', kind: 'track' }]);
  const holeOnly = { ...board, tracks: [board.tracks[1]] };
  assert.throws(() => analyzeLayoutParasitics(holeOnly, endpoints), /disconnected/);
  const anchor = preparePCBTrackAnchors(board, { centers: true, netId, limitMessage: 'limit' })[0];
  const minimum = Math.sqrt(
    Math.min(
      ...polygonEdges({ outer: anchor.polygon.holes[0], holes: [] }).map(([a, b]) =>
        segmentDistance(origin, offset, a, b),
      ),
    ),
  );
  const uncertain = {
    ...board,
    tracks: [track('uncertain', origin, offset, 'F.Cu', 2 * (minimum + 0.0000005))],
  };
  assert.throws(() => analyzeLayoutParasitics(uncertain, endpoints), /positive-area/);
});

test('body contacts require positive copper area rather than tangency, small gaps or ambiguous transverse joining', () => {
  for (const gap of [0, 0.0000005, 0.00001]) {
    const board = makeBoard();
    board.footprints[0].pads[0].shape = 'rect';
    const x = 0.4 + 0.125 + gap;
    board.footprints[1].x = x;
    board.footprints[1].y = 3;
    board.tracks = [track('near', { x, y: -2 }, { x, y: 3 })];
    assert.throws(() => analyzeLayoutParasitics(board, endpoints), /positive-area|disconnected/);
  }
  const touching = makeBoard();
  touching.footprints[0].pads[0].shape = 'rect';
  const x = 0.4 + 0.125 - 0.00001;
  touching.footprints[1].x = x;
  touching.footprints[1].y = 3;
  touching.tracks = [track('overlap', { x, y: -2 }, { x, y: 3 })];
  close(analyzeLayoutParasitics(touching, endpoints).shortestLengthMm, 3);
  const ambiguous = makeBoard();
  ambiguous.footprints[0].x = 5;
  ambiguous.footprints[0].y = 0.6;
  ambiguous.footprints[1].x = 5;
  ambiguous.footprints[1].y = -0.6;
  ambiguous.tracks = [track('bridge', origin, finish, 'F.Cu', 0.5)];
  assert.throws(() => analyzeLayoutParasitics(ambiguous, endpoints), /multiple pads or vias/);
});

test('unsupported copper contacts and zone fills fail instead of reporting a partial resistance', () => {
  const board = makeBoard();
  board.tracks = [track('main', origin, finish), track('branch', { x: 5, y: 0 }, { x: 5, y: 3 })];
  assert.throws(() => analyzeLayoutParasitics(board, endpoints), /shared endpoint/);
  board.tracks = [
    track('main', origin, finish),
    track('parallel', { x: 0, y: 0.2 }, { x: 5, y: 0.2 }),
  ];
  assert.throws(() => analyzeLayoutParasitics(board, endpoints), /shared endpoint/);
  board.tracks = [track('grazing', { x: 0.45, y: -2 }, { x: 0.45, y: 2 })];
  assert.throws(() => analyzeLayoutParasitics(board, endpoints), /disconnected/);
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
  board.tracks = Array.from({ length: 513 }, (_, index) =>
    track(`erased-${index}`, { x: 0, y: 0 }, { x: 0.01, y: 0 }, 'F.Cu', 0.01),
  );
  Object.assign(board.footprints[0].pads[0], {
    type: 'thru_hole',
    size: { x: 2, y: 2 },
    drill: 1,
    layers: ['*.Cu'],
  });
  assert.throws(() => analyzeLayoutParasitics(board, endpoints), /analysis limit/);
});
