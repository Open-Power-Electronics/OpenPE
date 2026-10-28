import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { uid, type Point } from '../lib/circuit';
import { createEmptyPCB, footprintPoint } from '../lib/pcb-layout';
import { createPCBRouter } from '../lib/pcb-routing';
import type { BoardZone, PCB } from '../lib/pcb';
import { parseProject } from '../lib/project';

const rect = (a: number, b: number, c: number, d: number) => [
  { x: a, y: b },
  { x: c, y: b },
  { x: c, y: d },
  { x: a, y: d },
];
function fixture() {
  const board = createEmptyPCB();
  board.nets = [
    { id: uid(), name: 'OUT' },
    { id: uid(), name: 'GND' },
  ];
  return board;
}
const router = (b: PCB, layer: 'F.Cu' | 'B.Cu' = 'F.Cu', width = 0.4) =>
  createPCBRouter(b, { layer, width, clearance: 0.25, netId: b.nets[0].id });
const zone = (b: PCB, outline = rect(4, -2, 6, 2)): BoardZone => ({
  id: uid(),
  netId: b.nets[1].id,
  layer: 'F.Cu',
  outline,
  clearance: 0.25,
  minThickness: 0.2,
  thermalGap: 0.3,
  thermalBridge: 0.3,
});
const uOutline = () => [
  { x: -3, y: -3 },
  { x: 3, y: -3 },
  { x: 3, y: 3 },
  { x: 2, y: 3 },
  { x: 2, y: -2 },
  { x: -2, y: -2 },
  { x: -2, y: 3 },
  { x: -3, y: 3 },
];
const keepout = (board: PCB, outline = uOutline()): BoardZone => ({
  ...zone(board, outline),
  keepout: { tracks: true, vias: false, pads: false, copperpour: false, footprints: false },
});
function checkRoute(b: PCB) {
  const before = structuredClone(b),
    engine = router(b);
  const start = { x: 0.123456, y: 0.654321 },
    end = { x: 10.234567, y: 0.654321 };
  const result = engine.route(start, end);
  assert.equal(result.blocked, false, result.message);
  assert.deepEqual(result.points[0], start);
  assert.deepEqual(result.points.at(-1), end);
  assert.ok(result.points.length > 2, 'The trace detours around the obstacle.');
  assert.equal(engine.validate(result.points), '');
  for (let i = 1; i < result.points.length; i++) {
    const dx = Math.abs(result.points[i].x - result.points[i - 1].x),
      dy = Math.abs(result.points[i].y - result.points[i - 1].y);
    assert.ok(dx < 0.000002 || dy < 0.000002 || Math.abs(dx - dy) < 0.000002);
  }
  assert.deepEqual(b, before, 'Routing never pushes or mutates existing copper.');
  return result;
}
test('Walk Around respects track/via clearance and copper layers while retaining exact anchors', () => {
  const board = fixture();
  board.tracks = [
    {
      id: uid(),
      start: { x: 5, y: -2 },
      end: { x: 5, y: 2 },
      width: 0.8,
      layer: 'F.Cu',
      netId: board.nets[1].id,
    },
  ];
  checkRoute(board);
  assert.equal(router(board, 'B.Cu').route({ x: 0, y: 0 }, { x: 10, y: 0 }).points.length, 2);
  board.tracks[0].netId = board.nets[0].id;
  assert.equal(router(board).route({ x: 0, y: 0 }, { x: 10, y: 0 }).points.length, 2);
  board.vias = [{ id: uid(), x: 5, y: 0, diameter: 2, drill: 0.8, netId: board.nets[1].id }];
  checkRoute(board);
  assert.ok(router(board, 'B.Cu').route({ x: 0, y: 0 }, { x: 10, y: 0 }).points.length > 2);
});

test('detour hints retain constructor geometry and settings snapshots before the first search', () => {
  // These route points and caller charges are the eager-hull behavior. Shrinking
  // the live segment must not regenerate its construction-time detour hints.
  const expected = [
    { x: 0, y: 0 },
    { x: 2.353738, y: -2.353738 },
    { x: 5.854, y: -2.353738 },
    { x: 8.207738, y: 0 },
    { x: 10, y: 0 },
  ];
  for (const posture of [false, true]) {
    const board = fixture();
    board.tracks = [
      {
        id: uid(),
        start: { x: 5, y: -2 },
        end: { x: 5, y: 2 },
        width: 0.8,
        layer: 'F.Cu',
        netId: board.nets[1].id,
      },
    ];
    const options = {
      layer: 'F.Cu' as const,
      netId: board.nets[0].id,
      width: 0.4,
      clearance: 0.25,
    };
    const engine = createPCBRouter(board, options),
      start = expected[0],
      end = expected.at(-1)!;
    assert.equal(
      engine.validate([
        { x: 0, y: -5 },
        { x: 10, y: -5 },
      ]),
      '',
    );
    board.tracks[0].start.y = -0.5;
    board.tracks[0].end.y = 0.5;
    options.width = 3;
    options.clearance = 2;
    const expectedWork = posture ? 127 : 114;
    for (let attempt = 0; attempt < 2; attempt++) {
      let work = 0;
      const result = engine.route(start, end, '45', posture, () => work++);
      assert.deepEqual(result, { points: expected, blocked: false, message: '' });
      assert.equal(work, expectedWork, 'Initial and retained hints charge the same exact checks.');
      assert.equal(engine.validate(result.points), '');
    }
    assert.notDeepEqual(
      router(board).route(start, end, '45', posture).points,
      expected,
      'A newly constructed router observes the changed source geometry.',
    );
    let work = 0;
    const limited = engine.route(start, end, '45', posture, () => {
      if (++work >= expectedWork) throw new Error('Snapshot routing work limit.');
    });
    assert.deepEqual(limited, {
      points: [start],
      blocked: true,
      message: 'Snapshot routing work limit.',
    });
    assert.equal(work, expectedWork);
  }
});

test('Highlight collisions checks manual segments without detours or copper changes', () => {
  const board = fixture();
  board.tracks = [
    {
      id: uid(),
      start: { x: 5, y: -2 },
      end: { x: 5, y: 2 },
      width: 0.8,
      layer: 'F.Cu',
      netId: board.nets[1].id,
    },
  ];
  const original = structuredClone(board);
  const engine = createPCBRouter(board, {
    layer: 'F.Cu',
    netId: board.nets[0].id,
    width: 0.4,
    clearance: 0.25,
    walkAround: false,
  });
  const start = { x: 0, y: 0 },
    end = { x: 10, y: 0 };
  assert.equal(router(board).route(start, end).blocked, false);
  const collision = engine.route(start, end);
  assert.equal(collision.blocked, true);
  assert.ok(collision.points.at(-1)!.x < 5, 'The blocked head stops before the obstacle.');
  assert.equal(engine.validate(collision.points), '');
  assert.match(engine.validate([start, end]), /blocked/);
  const angled = engine.route(start, { x: 2, y: 0.7 }, 'straight');
  assert.equal(angled.blocked, false);
  assert.deepEqual(angled.points, [start, { x: 2, y: 0.7 }]);
  assert.deepEqual(board, original);
});

test('Walk Around follows the 45-degree clearance hull of diagonal copper without square corners', () => {
  const board = fixture();
  board.tracks = [
    {
      id: uid(),
      start: { x: 1, y: -4 },
      end: { x: 9, y: 4 },
      width: 0.5,
      layer: 'F.Cu',
      netId: board.nets[1].id,
    },
  ];
  const before = structuredClone(board);
  const engine = router(board);
  const start = { x: 0, y: 0 },
    end = { x: 10, y: 0 };
  const result = engine.route(start, end);
  assert.equal(result.blocked, false, result.message);
  assert.deepEqual(result.points[0], start);
  assert.deepEqual(result.points.at(-1), end);
  assert.equal(engine.validate(result.points), '');
  let distance = 0;
  for (let i = 1; i < result.points.length; i++) {
    const a = result.points[i - 1],
      b = result.points[i];
    distance += Math.hypot(b.x - a.x, b.y - a.y);
    if (i === result.points.length - 1) continue;
    const c = result.points[i + 1];
    const cosine =
      ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) /
      (Math.hypot(b.x - a.x, b.y - a.y) * Math.hypot(c.x - b.x, c.y - b.y));
    assert.ok(cosine >= Math.SQRT1_2 - 0.00001, 'Every turn uses at most a 45-degree bevel.');
  }
  assert.ok(distance < 16.3, 'Beveling the clearance hull avoids the longer rectangular detour.');
  assert.deepEqual(board, before);
});

test('nearby routing retains exact collision checks without scanning distant copper', () => {
  const board = fixture();
  board.tracks = Array.from({ length: 14000 }, (_, index) => ({
    id: `distant-${index}`,
    start: { x: 10000 + index * 4, y: 0 },
    end: { x: 10001 + index * 4, y: 0 },
    width: 0.4,
    layer: 'F.Cu' as const,
    netId: board.nets[1].id,
  }));
  board.tracks.push({
    id: 'nearby',
    start: { x: 5, y: -2 },
    end: { x: 5, y: 2 },
    width: 0.8,
    layer: 'F.Cu',
    netId: board.nets[1].id,
  });
  const before = structuredClone(board);
  const engine = router(board);
  let work = 0;
  const result = engine.route({ x: 0, y: 0 }, { x: 10, y: 0 }, '45', false, () => {
    if (++work > 5000) throw new Error('Nearby routing work exceeded its test budget.');
  });
  assert.equal(result.blocked, false, result.message);
  assert.equal(engine.validate(result.points), '');
  assert.ok(result.points.length > 2, 'The nearby foreign track remains an obstacle.');
  for (const x of [5, 10000.5, 65996.5]) {
    assert.match(
      engine.validate([
        { x, y: -1 },
        { x, y: 1 },
      ]),
      /blocked/,
    );
  }
  assert.deepEqual(board, before);
});
test('the local search expands its candidate set when a more distant obstacle supplies the detour', () => {
  const board = fixture();
  board.vias = Array.from({ length: 32 }, (_, index) => ({
    id: uid(),
    x: -3 - index * 0.01,
    y: 0,
    diameter: 0.1,
    drill: 0.05,
    netId: board.nets[1].id,
  }));
  board.tracks = [
    {
      id: uid(),
      start: { x: 5, y: -2 },
      end: { x: 5, y: 2 },
      width: 0.8,
      layer: 'F.Cu',
      netId: board.nets[1].id,
    },
  ];
  const engine = router(board);
  const result = engine.route({ x: 0, y: 0 }, { x: 10, y: 0 });
  assert.equal(result.blocked, false, result.message);
  assert.equal(engine.validate(result.points), '');
  assert.ok(result.points.some((point) => Math.abs(point.y) > 2.8));
});

test('concave keepout exits retain checked H/V/45 paths across rotation, winding and repeated vertices', () => {
  const variants: { name: string; transform: (point: Point) => Point; outline?: Point[] }[] = [
    { name: 'original', transform: (point) => point },
    { name: 'clockwise', transform: (point) => point, outline: uOutline().reverse() },
    {
      name: 'different starting vertex',
      transform: (point) => point,
      outline: [...uOutline().slice(3), ...uOutline().slice(0, 3)],
    },
    {
      name: 'duplicate, closing and nearly collinear points',
      transform: (point) => point,
      outline: [uOutline()[0], { x: -1, y: -3 + 1e-12 }, ...uOutline(), uOutline()[0]],
    },
    {
      name: 'acute protrusion with discarded long miters',
      transform: (point) => point,
      outline: [
        uOutline()[0],
        { x: -0.000001, y: -3 },
        { x: 0, y: -4 },
        { x: 0.000001, y: -3 },
        ...uOutline().slice(1),
      ],
    },
    { name: 'mirror', transform: ({ x, y }) => ({ x: -x || 0, y }) },
    { name: 'quarter turn', transform: ({ x, y }) => ({ x: -y || 0, y: x }) },
    {
      name: '45 degree turn',
      transform: ({ x, y }) => ({
        x: Number(((x - y) * Math.SQRT1_2).toFixed(6)),
        y: Number(((x + y) * Math.SQRT1_2).toFixed(6)),
      }),
    },
  ];
  for (const { name, transform, outline = uOutline() } of variants) {
    const board = fixture();
    board.zones = [keepout(board, outline.map(transform))];
    const before = structuredClone(board),
      engine = router(board),
      start = transform({ x: 0, y: 0 }),
      end = transform({ x: 5, y: 0 });
    assert.equal(
      engine.validate([start, transform({ x: 0, y: 4 }), transform({ x: 5, y: 4 }), end]),
      '',
      `${name}: a manual route fits through the opening.`,
    );
    const result = engine.route(start, end);
    assert.equal(result.blocked, false, `${name}: ${result.message}`);
    assert.deepEqual(result.points[0], start);
    assert.deepEqual(result.points.at(-1), end);
    assert.equal(engine.validate(result.points), '', name);
    for (let i = 1; i < result.points.length; i++) {
      const dx = Math.abs(result.points[i].x - result.points[i - 1].x),
        dy = Math.abs(result.points[i].y - result.points[i - 1].y);
      assert.ok(dx < 0.000002 || dy < 0.000002 || Math.abs(dx - dy) < 0.000002, name);
    }
    assert.deepEqual(board, before, name);
  }
});

test('concave keepout holes remain free passages and widening cannot bypass their clearance', () => {
  const board = fixture();
  board.zones = [{ ...keepout(board, rect(-10, -10, 10, 10)), holes: [uOutline()] }];
  const before = structuredClone(board),
    engine = router(board),
    start = { x: -2.5, y: 2 },
    end = { x: 2.5, y: 2 },
    manual = [start, { x: -2.5, y: -2.5 }, { x: 2.5, y: -2.5 }, end];
  assert.equal(engine.validate(manual), '');
  const result = engine.route(start, end);
  assert.equal(result.blocked, false, result.message);
  assert.deepEqual(result.points.at(-1), end);
  assert.equal(engine.validate(result.points), '');
  const wider = router(board, 'F.Cu', 0.6);
  assert.match(wider.validate(manual), /blocked/);
  assert.equal(wider.route(start, end).blocked, true);
  assert.deepEqual(board, before);
});

test('closed concave mouths and foreign copper still block escape candidates', () => {
  for (const closing of ['keepout', 'foreign track']) {
    const board = fixture();
    board.zones = [keepout(board)];
    if (closing === 'keepout') board.zones.push(keepout(board, rect(-3, 2.5, 3, 3.5)));
    else
      board.tracks = [
        {
          id: uid(),
          netId: board.nets[1].id,
          layer: 'F.Cu',
          width: 0.8,
          start: { x: -3, y: 3 },
          end: { x: 3, y: 3 },
        },
      ];
    const before = structuredClone(board),
      engine = router(board),
      result = engine.route({ x: 0, y: 0 }, { x: 5, y: 0 });
    assert.equal(result.blocked, true, closing);
    assert.match(result.message, /blocked/, closing);
    assert.equal(engine.validate(result.points), '', closing);
    assert.deepEqual(board, before, closing);
  }
});

test('polygon detours retain filled-artwork, unfilled-outline and nonblocking-pour semantics', () => {
  const board = fixture(),
    outline = uOutline();
  board.graphics = [
    {
      id: uid(),
      kind: 'polygon',
      layer: 'F.Cu',
      width: 0,
      start: outline[0],
      points: outline.slice(1, -1),
      end: outline.at(-1)!,
      fill: true,
    },
  ];
  const result = router(board).route({ x: 0, y: 0 }, { x: 5, y: 0 });
  assert.equal(result.blocked, false, result.message);
  assert.equal(router(board).validate(result.points), '');
  assert.equal(router(board).route({ x: 2.5, y: 0 }, { x: 2.5, y: 1 }).blocked, true);
  board.graphics[0].fill = false;
  assert.equal(router(board).route({ x: 2.5, y: 0 }, { x: 2.5, y: 1 }).blocked, false);
  board.graphics = [];
  board.zones = [{ ...zone(board, outline), filledPolygons: [{ points: outline }] }];
  assert.deepEqual(router(board).route({ x: 0, y: 0 }, { x: 5, y: 0 }).points, [
    { x: 0, y: 0 },
    { x: 5, y: 0 },
  ]);
});

test('concave fallback retains coordinate bounds and the caller work budget', () => {
  for (const direction of [-1, 1]) {
    const board = fixture(),
      transform = ({ x, y }: Point) => ({ x: direction * (99996.8 + x), y });
    board.zones = [keepout(board, uOutline().map(transform))];
    const engine = router(board),
      start = transform({ x: 0, y: 0 }),
      end = transform({ x: -5, y: 0 });
    let work = 0;
    const result = engine.route(start, end, '45', false, () => {
      work++;
    });
    assert.equal(result.blocked, false, result.message);
    assert.deepEqual(result.points.at(-1), end);
    assert.equal(engine.validate(result.points), '');
    assert.ok(
      result.points.every(
        (point) =>
          Number.isFinite(point.x) &&
          Number.isFinite(point.y) &&
          Math.abs(point.x) <= 100000 &&
          Math.abs(point.y) <= 100000,
      ),
    );
    let limitedWork = 0;
    const limited = engine.route(start, end, '45', false, () => {
      if (++limitedWork >= work) throw new Error('Concave routing work limit.');
    });
    assert.equal(limited.blocked, true);
    assert.equal(limited.message, 'Concave routing work limit.');
  }
});

test('EMC Flyback routes around real copper and returns a checked blocked head without changing native data', async () => {
  const board = parseProject(await readFile('lib/emc-flyback-example.json', 'utf8')).pcb!;
  const before = structuredClone(board);
  const track = board.tracks.find((value) => value.id === '33cdc88b-d74e-4100-8239-7380156abb0b')!;
  assert.ok(track);
  const engine = createPCBRouter(board, {
    layer: track.layer,
    netId: track.netId,
    width: track.width,
    clearance: 0.25,
  });
  for (const y of [122.86, 114.86, 116.86]) {
    const end = { x: 81.52, y };
    const result = engine.route(track.start, end);
    assert.equal(result.blocked, y === 116.86, result.message);
    assert.deepEqual(result.points[0], track.start);
    assert.equal(engine.validate(result.points), '');
    if (!result.blocked) {
      assert.deepEqual(result.points.at(-1), end);
      assert.ok(result.points.length > 3, 'The live EMC copper requires a detour.');
    }
    assert.deepEqual(engine.route(track.start, end), result);
  }
  assert.deepEqual(board, before);
});

test('rotated pads, netless copper and mechanical holes obstruct routes', () => {
  const board = fixture();
  board.footprints = [
    {
      id: uid(),
      symbolId: null,
      libraryId: 'Test:Pad',
      x: 5,
      y: 0,
      rotation: 35,
      side: 'front',
      graphics: [],
      pads: [
        {
          id: uid(),
          number: '1',
          x: 0,
          y: 0,
          rotation: 15,
          type: 'smd',
          shape: 'roundrect',
          roundrectRatio: 0.25,
          size: { x: 2, y: 4 },
          netId: null,
        },
      ],
    },
  ];
  checkRoute(board);
  const p = board.footprints[0].pads[0];
  p.type = 'np_thru_hole';
  p.drill = 1.5;
  p.netId = board.nets[0].id;
  checkRoute(board);
  assert.ok(
    router(board, 'B.Cu').validate([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]),
  );
});
test('pours allow routes through and within saved fills; explicit track keepouts still obstruct', () => {
  const board = fixture(),
    z = zone(board);
  board.zones = [z];
  assert.equal(
    router(board).route({ x: 0, y: 0 }, { x: 10, y: 0 }).points.length,
    2,
    'Unfilled outlines do not invent copper.',
  );
  z.filledPolygons = [{ points: z.outline }];
  for (const netId of [board.nets[1].id, board.nets[0].id, null]) {
    z.netId = netId;
    const before = structuredClone(board);
    const engine = router(board);
    for (const [start, end] of [
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      [
        { x: 4.8, y: 0 },
        { x: 5.2, y: 0 },
      ],
    ]) {
      for (const mode of ['45', 'straight'] as const) {
        const result = engine.route(start, end, mode);
        assert.equal(result.blocked, false);
        assert.deepEqual(result.points, [start, end]);
        assert.equal(engine.validate(result.points), '');
      }
    }
    assert.deepEqual(board, before, 'Preview and validation preserve the original fill.');
  }
  z.keepout = { tracks: true, vias: false, pads: false, copperpour: false, footprints: false };
  checkRoute(board);
  z.keepout.tracks = false;
  assert.equal(router(board).route({ x: 0, y: 0 }, { x: 10, y: 0 }).points.length, 2);
  z.keepout.tracks = true;
  z.outline = rect(-5, -5, 15, 5);
  z.holes = [rect(-2, -2, 12, 2)];
  assert.equal(
    router(board).route({ x: 0, y: 0 }, { x: 10, y: 0 }).points.length,
    2,
    'A hole in an explicit track keepout remains usable.',
  );
});
test('board boundaries, cutouts and impossible gaps fail closed, including straight mode', () => {
  const board = fixture();
  board.graphics = [
    {
      id: uid(),
      kind: 'polygon',
      layer: 'Edge.Cuts',
      width: 0.1,
      start: { x: -2, y: -3 },
      points: [
        { x: 12, y: -3 },
        { x: 12, y: 3 },
      ],
      end: { x: -2, y: 3 },
    },
  ];
  board.tracks = [
    {
      id: uid(),
      layer: 'F.Cu',
      width: 0.8,
      netId: board.nets[1].id,
      start: { x: 5, y: -1 },
      end: { x: 5, y: 1 },
    },
  ];
  checkRoute(board);
  assert.equal(router(board).route({ x: 0, y: 0 }, { x: 15, y: 0 }).blocked, true);
  const stopped = router(board).route({ x: 0, y: 0 }, { x: 10, y: 0 }, 'straight');
  assert.equal(stopped.blocked, true);
  assert.ok(stopped.points.at(-1)!.x < 5);
  assert.equal(router(board).validate(stopped.points), '');
  board.tracks[0].start.y = -3;
  board.tracks[0].end.y = 3;
  assert.equal(router(board).route({ x: 0, y: 0 }, { x: 10, y: 0 }).blocked, true);
  assert.ok(
    router(board).validate([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]),
  );
  board.tracks = [];
  board.graphics.push({
    id: uid(),
    kind: 'circle',
    layer: 'Edge.Cuts',
    width: 0.1,
    start: { x: 5, y: 0 },
    end: { x: 6, y: 0 },
  });
  checkRoute(board);
  board.graphics[0].kind = undefined;
  board.graphics[0].points = undefined;
  assert.throws(() => router(board), /outline is open/);
});
test('posture switching, settings changes and invalid coordinates cannot bypass validation', () => {
  const board = fixture(),
    engine = router(board);
  assert.notDeepEqual(
    engine.route({ x: 0, y: 0 }, { x: 5, y: 2 }).points,
    engine.route({ x: 0, y: 0 }, { x: 5, y: 2 }, '45', true).points,
  );
  assert.ok(engine.validate([{ x: NaN, y: 0 }]));
  assert.ok(engine.validate([]));
  assert.equal(engine.route({ x: Infinity, y: 0 }, { x: 5, y: 0 }).blocked, true);
  board.vias = [{ id: uid(), x: 5, y: 0, diameter: 1, drill: 0.4, netId: board.nets[1].id }];
  const path = router(board).route({ x: 0, y: 0 }, { x: 10, y: 0 });
  assert.equal(path.blocked, false);
  assert.ok(
    router(board, 'F.Cu', 2).validate(path.points),
    'Widening a draft route requires rechecking all fixed segments.',
  );
});

test('a blocked routing head retains the selected bend posture and a checked prefix', () => {
  const board = fixture();
  board.vias = [{ id: uid(), x: 5, y: 2, diameter: 1, drill: 0.4, netId: board.nets[1].id }];
  const engine = router(board);
  const start = { x: 0, y: 0 },
    end = { x: 5, y: 2 };
  const diagonalFirst = engine.route(start, end);
  const axisFirst = engine.route(start, end, '45', true);
  for (const result of [diagonalFirst, axisFirst]) {
    assert.equal(result.blocked, true);
    assert.match(result.message, /blocked/);
    assert.deepEqual(result.points[0], start);
    assert.equal(engine.validate(result.points), '');
    assert.notDeepEqual(result.points.at(-1), end);
  }
  assert.deepEqual(diagonalFirst.points[1], { x: 2, y: 2 });
  assert.deepEqual(axisFirst.points[1], { x: 3, y: 0 });
});

test('omitting a failed head preserves collision errors while default routes retain their checked prefix', () => {
  const board = fixture();
  board.vias = [{ id: uid(), x: 5, y: 2, diameter: 1, drill: 0.4, netId: board.nets[1].id }];
  const before = structuredClone(board),
    engine = router(board),
    start = { x: 0, y: 0 },
    end = { x: 5, y: 2 };
  for (const posture of [false, true]) {
    const clipped = engine.route(start, end, '45', posture);
    const omitted = engine.route(start, end, '45', posture, undefined, 'omit');
    assert.equal(clipped.blocked, true);
    assert.equal(omitted.blocked, clipped.blocked);
    assert.equal(omitted.message, clipped.message);
    assert.deepEqual(omitted.points, [start]);
    assert.ok(clipped.points.length > 1);
    assert.equal(engine.validate(clipped.points), '');
    assert.deepEqual(engine.route(start, end, '45', posture), clipped);
  }
  const outside = { x: 100001, y: 0 };
  assert.deepEqual(
    engine.route(start, outside, '45', false, undefined, 'omit'),
    engine.route(start, outside),
  );
  assert.deepEqual(board, before);
});

test('successful direct and detoured routes keep the same geometry and caller budget in either failed-head mode', () => {
  const board = fixture();
  board.vias = [{ id: uid(), x: 5, y: 0, diameter: 1, drill: 0.4, netId: board.nets[1].id }];
  for (const y of [-4, 0])
    for (const posture of [false, true]) {
      const start = { x: 0, y },
        end = { x: 10, y };
      let clippedWork = 0,
        omittedWork = 0;
      const clipped = router(board).route(start, end, '45', posture, () => clippedWork++);
      const omitted = router(board).route(start, end, '45', posture, () => omittedWork++, 'omit');
      assert.equal(clipped.blocked, false, clipped.message);
      assert.deepEqual(omitted, clipped);
      assert.equal(
        omittedWork,
        clippedWork,
        'Accepted geometry retains every caller budget charge.',
      );
      if (!y) assert.ok(clipped.points.length > 2, 'Foreign copper requires an exact detour.');
      for (const blockedHead of ['clip', 'omit'] as const) {
        let work = 0;
        const limited = router(board).route(
          start,
          end,
          '45',
          posture,
          () => {
            if (++work >= clippedWork) throw new Error('Caller route work limit.');
          },
          blockedHead,
        );
        assert.equal(limited.blocked, true);
        assert.equal(limited.message, 'Caller route work limit.');
        assert.deepEqual(limited.points, [start]);
        assert.equal(work, clippedWork);
      }
    }
});

test('a caller overflow during failed-head clipping cannot change the original rejection', () => {
  const board = fixture();
  board.vias = [{ id: uid(), x: 5, y: 2, diameter: 1, drill: 0.4, netId: board.nets[1].id }];
  const start = { x: 0, y: 0 },
    end = { x: 5, y: 2 };
  for (const posture of [false, true]) {
    let decisionWork = 0;
    const decision = router(board).route(start, end, '45', posture, () => decisionWork++, 'omit');
    assert.equal(decision.blocked, true);
    let work = 0,
      overflow = false;
    const clipped = router(board).route(start, end, '45', posture, () => {
      if (++work > decisionWork) {
        overflow = true;
        throw new Error('Failed-head feedback work limit.');
      }
    });
    assert.equal(overflow, true, 'The original output-only clipping reaches the caller limit.');
    assert.deepEqual(
      clipped,
      decision,
      'Feedback failure retains the collision error and publishes no route.',
    );
  }
});

test('new routes check dimension strokes with their width while keeping text coverage bounded', () => {
  const board = fixture();
  board.graphics = [
    {
      id: uid(),
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
        caption: { x: 0, y: 5, value: 'OUT', rotation: 0, size: { x: 1, y: 1 }, thickness: 0.1 },
      },
    },
  ];
  const before = structuredClone(board),
    engine = router(board),
    start = { x: 0, y: -1 },
    end = { x: 0, y: 1 };
  assert.match(engine.validate([start, end]), /blocked/);
  const straight = engine.route(start, end, 'straight');
  assert.equal(straight.blocked, true);
  assert.equal(engine.validate(straight.points), '');
  assert.ok(straight.points.at(-1)!.y < -0.55, 'The dimension width contributes to clearance.');
  const result = engine.route(start, end);
  assert.equal(result.blocked, false, result.message);
  assert.ok(result.points.length > 2);
  assert.equal(engine.validate(result.points), '');
  assert.deepEqual(result.points[0], start);
  assert.deepEqual(result.points.at(-1), end);
  assert.equal(
    engine.validate([
      { x: 0, y: 3 },
      { x: 0, y: 4 },
    ]),
    '',
    'New tracks do not inherit the large conservative caption envelope used by via checks.',
  );
  assert.deepEqual(router(board, 'B.Cu').route(start, end).points, [start, end]);
  assert.deepEqual(board, before);
  board.graphics[0].layer = 'F.SilkS';
  assert.deepEqual(router(board).route(start, end).points, [start, end]);
});

test('footprint copper dimensions check local strokes after the native footprint transform', () => {
  const board = fixture();
  board.footprints = [
    {
      id: uid(),
      symbolId: null,
      libraryId: 'Test:Dimension',
      x: 10.123456,
      y: -2.345678,
      rotation: 37,
      side: 'back',
      pads: [],
      graphics: [
        {
          id: uid(),
          kind: 'dimension',
          layer: 'B.Cu',
          start: { x: -3, y: -2 },
          end: { x: 3, y: -2 },
          width: 0.2,
          dimension: {
            type: 'aligned',
            height: 2,
            format: { prefix: '', suffix: '', units: 0, unitsFormat: 0, precision: 0 },
            style: { arrowLength: 1, textPositionMode: 0, extensionOffset: 0 },
            caption: { x: 0, y: 5, value: '', rotation: 0, size: { x: 1, y: 1 }, thickness: 0.1 },
          },
        },
      ],
    },
  ];
  const before = structuredClone(board),
    footprint = board.footprints[0],
    start = footprintPoint(footprint, { x: 0, y: -1 }),
    end = footprintPoint(footprint, { x: 0, y: 1 }),
    engine = router(board, 'B.Cu');
  assert.match(engine.validate([start, end]), /blocked/);
  const result = engine.route(start, end);
  assert.equal(result.blocked, false, result.message);
  assert.equal(engine.validate(result.points), '');
  assert.deepEqual(result.points[0], start);
  assert.deepEqual(result.points.at(-1), end);
  assert.deepEqual(router(board).route(start, end, 'straight').points, [start, end]);
  assert.deepEqual(board, before);
});

test('swept regions catch fixed copper and keepouts fully enclosed between clear boundary poses', () => {
  const sweep = rect(-3, 0, 3, 6);
  for (const kind of ['via', 'pad', 'keepout', 'artwork']) {
    const board = fixture();
    if (kind === 'via')
      board.vias = [{ id: uid(), netId: board.nets[1].id, x: 0, y: 3, diameter: 0.8, drill: 0.3 }];
    if (kind === 'pad')
      board.footprints = [
        {
          id: uid(),
          symbolId: null,
          libraryId: 'Test:SweepPad',
          x: 0,
          y: 3,
          rotation: 35,
          side: 'front',
          graphics: [],
          pads: [
            {
              id: uid(),
              number: '1',
              x: 0,
              y: 0,
              rotation: 0,
              type: 'smd',
              shape: 'rect',
              size: { x: 0.8, y: 0.8 },
              netId: board.nets[1].id,
            },
          ],
        },
      ];
    if (kind === 'keepout')
      board.zones = [
        {
          ...zone(board, rect(-0.5, 2.5, 0.5, 3.5)),
          keepout: { tracks: true, vias: false, pads: false, copperpour: false, footprints: false },
        },
      ];
    if (kind === 'artwork')
      board.graphics = [
        {
          id: uid(),
          layer: 'F.Cu',
          width: 0.1,
          start: { x: -0.5, y: 3 },
          end: { x: 0.5, y: 3 },
        },
      ];
    const before = structuredClone(board),
      engine = router(board);
    assert.equal(engine.validate(sweep.concat(sweep[0])), '', `${kind}: sweep edges are clear.`);
    assert.match(
      engine.validateRegion(sweep),
      /blocked/,
      `${kind}: the enclosed obstacle still blocks motion.`,
    );
    assert.deepEqual(board, before);
  }
});

test('swept regions respect enclosed board cutouts and retain empty-board and layer semantics', () => {
  const board = fixture(),
    sweep = rect(-3, 0, 3, 6);
  assert.equal(router(board).validateRegion(sweep), '');
  board.graphics = [
    {
      id: uid(),
      kind: 'polygon',
      layer: 'Edge.Cuts',
      width: 0.1,
      start: { x: -10, y: -10 },
      points: [
        { x: 10, y: -10 },
        { x: 10, y: 10 },
      ],
      end: { x: -10, y: 10 },
    },
  ];
  assert.equal(router(board).validateRegion(sweep), '');
  board.graphics.push({
    id: uid(),
    kind: 'circle',
    layer: 'Edge.Cuts',
    width: 0.1,
    start: { x: 0, y: 3 },
    end: { x: 0.5, y: 3 },
  });
  const engine = router(board);
  assert.equal(engine.validate(sweep.concat(sweep[0])), '');
  assert.match(engine.validateRegion(sweep), /blocked/);
  board.graphics = [
    {
      id: uid(),
      layer: 'B.Cu',
      width: 0.1,
      start: { x: -0.5, y: 3 },
      end: { x: 0.5, y: 3 },
    },
  ];
  assert.equal(router(board).validateRegion(sweep), '');
  assert.match(router(board, 'B.Cu').validateRegion(sweep), /blocked/);
});

test('swept region validation bounds coordinates and shares the caller work budget', () => {
  const board = fixture(),
    engine = router(board);
  for (const points of [[], [{ x: NaN, y: 0 }], [{ x: 100001, y: 0 }]])
    assert.match(engine.validateRegion(points), /coordinates/);
  assert.equal(
    engine.validateRegion([
      { x: -3, y: 0 },
      { x: 3, y: 0 },
    ]),
    '',
  );
  assert.equal(
    engine.validateRegion([
      { x: -3, y: 0 },
      { x: 0, y: 0 },
      { x: 3, y: 0 },
    ]),
    '',
  );
  board.vias = [{ id: uid(), netId: board.nets[1].id, x: 20, y: 20, diameter: 0.8, drill: 0.3 }];
  assert.equal(
    router(board).validateRegion(rect(-3, 0, 3, 6), () => {
      throw new Error('Sweep work limit.');
    }),
    'Sweep work limit.',
  );
});
