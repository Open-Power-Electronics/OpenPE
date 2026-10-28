import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoardLine, BoardZone, Footprint, PCB } from '../lib/pcb';
import { createEmptyPCB, padDrillPosition } from '../lib/pcb-layout';
import { createPCBViaValidator, validatePCBVia } from '../lib/pcb-via-routing';

const fixture = (): PCB => ({
  ...createEmptyPCB(),
  nets: [
    { id: 'out', name: 'OUT' },
    { id: 'gnd', name: 'GND' },
  ],
});
const via = { x: 0, y: 0, netId: 'out', diameter: 0.8, drill: 0.4 };
const rectangle = (minX: number, minY: number, maxX: number, maxY: number) => [
  { x: minX, y: minY },
  { x: maxX, y: minY },
  { x: maxX, y: maxY },
  { x: minX, y: maxY },
];
const zone = (): BoardZone => ({
  id: 'zone',
  layer: 'F.Cu',
  netId: 'gnd',
  outline: rectangle(-1, -1, 1, 1),
  clearance: 0.25,
  minThickness: 0.2,
  thermalGap: 0.3,
  thermalBridge: 0.3,
});
const footprint = (): Footprint => ({
  id: 'part',
  x: 0,
  y: 0,
  rotation: 0,
  side: 'front',
  libraryId: 'Test:ViaObstacle',
  symbolId: null,
  graphics: [],
  pads: [
    {
      id: 'pad',
      number: '1',
      x: 0,
      y: 0,
      rotation: 0,
      type: 'smd',
      shape: 'rect',
      size: { x: 1, y: 1 },
      netId: 'gnd',
    },
  ],
});
const edge = (): BoardLine => ({
  id: 'edge',
  kind: 'polygon',
  layer: 'Edge.Cuts',
  width: 0.1,
  start: { x: -5, y: -5 },
  points: [
    { x: 5, y: -5 },
    { x: 5, y: 5 },
  ],
  end: { x: -5, y: 5 },
});

test('via copper diameter and clearance are checked on every copper layer, without changing board data', () => {
  for (const layer of ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] as const) {
    const board = fixture();
    board.layers = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'];
    board.tracks = [
      {
        id: 'obstacle',
        start: { x: 0.7, y: -2 },
        end: { x: 0.7, y: 2 },
        width: 0.2,
        layer,
        netId: 'gnd',
      },
    ];
    const before = structuredClone(board),
      validator = createPCBViaValidator(board, { ...via, clearance: 0.25 });
    assert.match(
      validator.validate(via),
      /Via blocked/,
      `${layer} copper obstructs the full via annulus.`,
    );
    assert.equal(validator.validate({ x: -0.1, y: 0 }), '');
    assert.equal(validator.validate({ x: -1, y: 1 }), '');
    assert.deepEqual(board, before);
  }
});

test('same-net copper can connect while foreign and netless rotated pads obstruct placement', () => {
  const board = fixture(),
    part = footprint();
  part.side = 'back';
  part.rotation = 35;
  part.pads[0].rotation = 20;
  part.pads[0].size = { x: 2, y: 3 };
  part.pads[0].layers = ['B.Cu'];
  board.footprints = [part];
  for (const netId of ['gnd', null]) {
    part.pads[0].netId = netId;
    assert.match(validatePCBVia(board, via, 0.25), /Via blocked/);
  }
  part.pads[0].netId = 'out';
  assert.equal(validatePCBVia(board, via, 0.25), '');
  board.tracks = [
    {
      id: 'same',
      start: { x: -2, y: 0 },
      end: { x: 2, y: 0 },
      width: 1,
      layer: 'F.Cu',
      netId: 'out',
    },
  ];
  assert.equal(
    validatePCBVia(board, via, 0.25),
    '',
    'Existing same-net tracks remain connectable.',
  );
});

test('existing same-net via holes block new drilling but their wider copper annulus remains connectable', () => {
  const board = fixture();
  board.vias = [{ id: 'existing', x: 0, y: 0, diameter: 3, drill: 0.4, netId: 'out' }];
  assert.match(validatePCBVia(board, via, 0.25), /existing via hole/);
  assert.equal(validatePCBVia(board, { ...via, x: 1.85, drill: 0.1 }, 0.25), '');
  board.vias[0].netId = 'gnd';
  assert.match(validatePCBVia(board, { ...via, x: 1.85, drill: 0.1 }, 0.25), /Via blocked/);
});

test('asymmetric same-net vias enforce mutual copper-to-hole clearance in either placement order', () => {
  const large = { ...via, x: 0, diameter: 3, drill: 0.2 };
  const small = { ...via, x: 1.5, diameter: 1, drill: 0.8 };
  for (const [existing, candidate] of [
    [large, small],
    [small, large],
  ]) {
    const board = fixture();
    board.vias = [{ id: 'existing', ...existing }];
    const before = structuredClone(board);
    assert.match(
      validatePCBVia(board, candidate, 0.25),
      /existing via hole/,
      'Each copper disc must clear the other via drill before placement commits.',
    );
    assert.equal(validatePCBVia(board, { ...candidate, x: existing.x + 2.2 }, 0.25), '');
    assert.deepEqual(board, before);
  }
});

test('all pad drills use their transformed offset centers, including same-net plated and mechanical holes', () => {
  const board = fixture(),
    part = footprint();
  part.x = 5;
  part.y = 7;
  part.rotation = 90;
  const pad = part.pads[0];
  pad.x = 2;
  pad.rotation = 90;
  pad.type = 'thru_hole';
  pad.drill = 1;
  pad.drillOffset = { x: 1, y: 0 };
  pad.netId = 'out';
  board.footprints = [part];
  const at = padDrillPosition(part, pad);
  assert.match(validatePCBVia(board, { ...via, ...at }, 0.25), /existing pad hole/);
  assert.equal(validatePCBVia(board, { ...via, x: at.x + 1.3, y: at.y }, 0.25), '');
  pad.type = 'np_thru_hole';
  assert.match(validatePCBVia(board, { ...via, ...at }, 0.25), /existing pad hole/);
});

test('via keepouts are independent of track keepouts and preserve their holes on inner layers', () => {
  const board = fixture(),
    keepout = zone();
  board.layers = ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'];
  keepout.layer = 'In2.Cu';
  keepout.keepout = {
    tracks: false,
    vias: true,
    pads: false,
    copperpour: false,
    footprints: false,
  };
  board.zones = [keepout];
  assert.match(validatePCBVia(board, via, 0.25), /Via blocked/);
  keepout.keepout.vias = false;
  keepout.keepout.tracks = true;
  assert.equal(validatePCBVia(board, via, 0.25), '');
  keepout.keepout.vias = true;
  keepout.outline = rectangle(-3, -3, 3, 3);
  keepout.holes = [rectangle(-2, -2, 2, 2)];
  assert.equal(validatePCBVia(board, via, 0.25), '');
  assert.match(validatePCBVia(board, { ...via, x: 1.5 }, 0.25), /Via blocked/);
});

test('package-local via keepouts are transformed and checked even on otherwise empty layers', () => {
  const board = fixture(),
    part = footprint(),
    keepout = zone();
  part.pads = [];
  part.x = 10;
  part.y = 5;
  part.rotation = 90;
  keepout.layer = 'B.Cu';
  keepout.outline = rectangle(1, -1, 3, 1);
  keepout.keepout = {
    tracks: false,
    vias: true,
    pads: false,
    copperpour: false,
    footprints: false,
  };
  part.zones = [keepout];
  board.footprints = [part];
  assert.match(validatePCBVia(board, { ...via, x: 10, y: 3 }, 0.25), /Via blocked/);
  assert.equal(validatePCBVia(board, { ...via, x: 10, y: 0 }, 0.25), '');
});

test('closed boundaries and cutouts constrain the full copper disc; broken outlines fail without throwing', () => {
  const board = fixture();
  assert.equal(validatePCBVia(board, via, 0.25), '', 'A missing outline permits early layout.');
  board.graphics = [edge()];
  assert.match(validatePCBVia(board, { ...via, x: 4.4 }, 0.25), /Via blocked/);
  assert.equal(validatePCBVia(board, { ...via, x: 4.3 }, 0.25), '');
  board.graphics.push({
    id: 'cutout',
    kind: 'circle',
    layer: 'Edge.Cuts',
    width: 0.1,
    start: { x: 0, y: 0 },
    end: { x: 1, y: 0 },
  });
  assert.match(validatePCBVia(board, via, 0.25), /Via blocked/);
  assert.match(validatePCBVia(board, { ...via, x: 1.5 }, 0.25), /Via blocked/);
  assert.equal(validatePCBVia(board, { ...via, x: 1.8 }, 0.25), '');
  board.graphics = [{ ...edge(), kind: undefined, points: undefined }];
  assert.match(validatePCBVia(board, via, 0.25), /outline is open/);
});

test('copper artwork uses conservative curved geometry; non-copper artwork does not obstruct vias', () => {
  const board = fixture();
  board.graphics = [
    {
      id: 'copper',
      kind: 'circle',
      layer: 'B.Cu',
      width: 0.2,
      start: { x: 0, y: 0 },
      end: { x: 2, y: 0 },
    },
  ];
  assert.equal(
    validatePCBVia(board, via, 0.25),
    '',
    'The center of a large unfilled copper circle is open.',
  );
  assert.match(validatePCBVia(board, { ...via, x: 1.5 }, 0.25), /Via blocked/);
  board.graphics[0].fill = true;
  assert.match(validatePCBVia(board, via, 0.25), /Via blocked/);
  board.graphics[0].layer = 'F.SilkS';
  assert.equal(validatePCBVia(board, via, 0.25), '');
});

test('copper text and dimension envelopes cannot be bypassed by placing a via through their lettering or lines', () => {
  const board = fixture();
  board.graphics = [
    {
      id: 'lettering',
      kind: 'text',
      layer: 'B.Cu',
      start: { x: 0, y: 0 },
      end: { x: 0, y: 0 },
      width: 0.1,
      text: { value: 'OUT', rotation: 45, size: { x: 1, y: 1 }, thickness: 0.15 },
    },
  ];
  assert.match(validatePCBVia(board, via, 0.25), /Via blocked/);
  board.graphics = [
    {
      id: 'dimension',
      kind: 'dimension',
      layer: 'F.Cu',
      start: { x: -3, y: -2 },
      end: { x: 3, y: -2 },
      width: 0.2,
      dimension: {
        type: 'aligned',
        height: 2,
        format: { prefix: '', suffix: '', units: 0, unitsFormat: 0, precision: 0 },
        style: { arrowLength: 1, textPositionMode: 0, extensionOffset: 0 },
        caption: { x: 10, y: 10, value: '', rotation: 0, size: { x: 1, y: 1 }, thickness: 0.1 },
      },
    },
  ];
  assert.match(validatePCBVia(board, via, 0.25), /Via blocked/);
});

test('ordinary zones and saved pours never obstruct or mutate via placement checks', () => {
  const board = fixture(),
    pour = zone();
  pour.filledPolygons = [{ points: pour.outline }];
  board.zones = [pour];
  for (const netId of ['out', 'gnd', null]) {
    pour.netId = netId;
    const before = structuredClone(board);
    assert.equal(validatePCBVia(board, via, 0.25), '');
    assert.deepEqual(board, before);
  }
});

test('invalid settings and coordinates return actionable errors without throwing or creating geometry', () => {
  const board = fixture();
  for (const patch of [
    { netId: '' },
    { diameter: 0 },
    { diameter: 21 },
    { drill: 0 },
    { drill: 0.8 },
    { diameter: NaN },
    { drill: Infinity },
    { clearance: 0 },
    { clearance: Infinity },
  ])
    assert.match(
      createPCBViaValidator(board, { ...via, clearance: 0.25, ...patch }).validate(via),
      /Choose a board net/,
    );
  assert.match(
    createPCBViaValidator(createEmptyPCB(), { ...via, clearance: 0.25 }).validate(via),
    /Choose a board net/,
  );
  const validator = createPCBViaValidator(board, { ...via, clearance: 0.25 });
  for (const at of [
    { x: NaN, y: 0 },
    { x: 0, y: Infinity },
    { x: 100001, y: 0 },
  ])
    assert.match(validator.validate(at), /coordinates/);
  assert.equal(
    validator.validate(via),
    '',
    'An invalid pointer does not poison prepared geometry.',
  );
});

test('physical hole and routing geometry limits fail closed during preparation', () => {
  const board = fixture();
  board.vias = Array.from({ length: 15001 }, (_, i) => ({
    id: `hole-${i}`,
    x: i,
    y: 100,
    diameter: 1,
    drill: 0.5,
    netId: 'out',
  }));
  assert.match(
    createPCBViaValidator(board, { ...via, clearance: 0.25 }).validate(via),
    /geometry limit/,
  );
  board.vias = [];
  board.tracks = Array.from({ length: 15001 }, (_, i) => ({
    id: `trace-${i}`,
    start: { x: i, y: 100 },
    end: { x: i, y: 101 },
    width: 0.4,
    layer: 'B.Cu',
    netId: 'gnd',
  }));
  assert.match(
    createPCBViaValidator(board, { ...via, clearance: 0.25 }).validate(via),
    /geometry limit/,
  );
});

test('a shared draft budget bounds via checks and returns its failure without poisoning prepared geometry', () => {
  const board = fixture();
  board.tracks = Array.from({ length: 4 }, (_, i) => ({
    id: `trace-${i}`,
    // The bounds overlap the proposed disc; exact diagonal checks are needed.
    start: { x: -5, y: -3 + i * 0.1 },
    end: { x: 5, y: 7 + i * 0.1 },
    width: 0.4,
    layer: 'F.Cu',
    netId: 'gnd',
  }));
  const before = structuredClone(board);
  const validator = createPCBViaValidator(board, { ...via, clearance: 0.25 });
  let work = 0;
  const issue = validator.validate(via, () => {
    if (++work > 2) throw new Error('Draft routing exceeds the shared geometry limit.');
  });
  assert.equal(issue, 'Draft routing exceeds the shared geometry limit.');
  assert.equal(work, 3, 'The shared budget interrupts checks at its boundary.');
  assert.equal(
    validator.validate(via),
    '',
    'A budget failure does not poison the prepared engines.',
  );
  let total = 0;
  assert.equal(
    validator.validate(via, () => {
      total++;
    }),
    '',
  );
  assert.ok(total >= 4, 'Successful all-layer checks also spend the supplied budget.');
  assert.deepEqual(board, before);
});
