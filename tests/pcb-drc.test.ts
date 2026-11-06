import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { uid, type Point } from '../lib/circuit';
import { invalidatePCBFill, type BoardZone, type Footprint, type PCB } from '../lib/pcb';
import { createEmptyPCB, padDrillPosition } from '../lib/pcb-layout';
import { copperFillContour, fillCopperZones } from '../lib/pcb-polygons';
import { defaultPCBDesignRules, runPCBDesignRules } from '../lib/pcb-drc';
import { projectFromNativeFiles } from '../lib/kicad-project';

const rect = (a: number, b: number, c: number, d: number): Point[] => [
  { x: a, y: b },
  { x: c, y: b },
  { x: c, y: d },
  { x: a, y: d },
];
function outline(board: PCB, points = rect(-10, -10, 50, 40)) {
  board.graphics.push({
    id: uid(),
    layer: 'Edge.Cuts',
    kind: 'polygon',
    start: points[0],
    end: points.at(-1)!,
    points: points.slice(1, -1),
    width: 0.05,
  });
}
function fixture(): PCB {
  const board = createEmptyPCB();
  board.nets = [
    { id: uid(), name: 'OUT' },
    { id: uid(), name: 'GND' },
  ];
  outline(board);
  return board;
}
const track = (
  board: PCB,
  start: Point,
  end: Point,
  net = 0,
  layer: 'F.Cu' | 'B.Cu' = 'F.Cu',
  width = 0.4,
): PCB['tracks'][number] => ({
  id: uid(),
  start,
  end,
  netId: board.nets[net].id,
  layer,
  width,
});
function pad(board: PCB, x: number, y: number, net = 0): Footprint {
  const footprint: Footprint = {
    id: uid(),
    symbolId: null,
    libraryId: 'Test:Pad',
    reference: 'J1',
    x,
    y,
    rotation: 0,
    side: 'front',
    graphics: [],
    pads: [
      {
        id: uid(),
        number: '1',
        x: 0,
        y: 0,
        rotation: 0,
        shape: 'rect',
        size: { x: 2, y: 2 },
        type: 'smd',
        netId: board.nets[net].id,
      },
    ],
  };
  board.footprints.push(footprint);
  return footprint;
}
const zone = (board: PCB, points = rect(2, 2, 8, 8)): BoardZone => ({
  id: uid(),
  netId: board.nets[0].id,
  layer: 'F.Cu',
  outline: points,
  clearance: 0.25,
  minThickness: 0.2,
  thermalGap: 0.3,
  thermalBridge: 0.3,
});
const issues = (board: PCB, rule: string) =>
  runPCBDesignRules(board).issues.filter((issue) => issue.ruleId === rule);

test('foreign-net contact is a short only on common copper layers; same-net contact is legal', () => {
  const board = fixture();
  board.tracks = [
    track(board, { x: 0, y: 5 }, { x: 10, y: 5 }),
    track(board, { x: 5, y: 0 }, { x: 5, y: 10 }, 1),
  ];
  assert.equal(issues(board, 'pcb.short').length, 1);
  board.tracks[1].layer = 'B.Cu';
  assert.equal(issues(board, 'pcb.short').length, 0);
  board.tracks[1].layer = 'F.Cu';
  board.tracks[1].netId = board.nets[0].id;
  const report = runPCBDesignRules(board);
  assert.equal(report.issues.length, 0);
  assert.equal(report.complete, true);
});

test('clearance uses trace widths and accepts the exact configured gap, while zero still checks shorts', () => {
  const board = fixture();
  board.tracks = [
    track(board, { x: 0, y: 0 }, { x: 10, y: 0 }),
    track(board, { x: 0, y: 0.53 }, { x: 10, y: 0.53 }, 1),
  ];
  assert.equal(issues(board, 'pcb.clearance').length, 1);
  board.tracks[1].start.y = board.tracks[1].end.y = 0.55;
  assert.equal(issues(board, 'pcb.clearance').length, 0);
  board.tracks[1].start.y = board.tracks[1].end.y = 0.3;
  assert.equal(
    runPCBDesignRules(board, { clearance: 0 }).issues.filter((i) => i.ruleId === 'pcb.short')
      .length,
    1,
  );
});

test('independent unassigned copper is reported as unknown contact rather than silently treated as one net', () => {
  const board = fixture();
  pad(board, 5, 5).pads[0].netId = null;
  pad(board, 5.5, 5).pads[0].netId = null;
  const report = runPCBDesignRules(board);
  assert.equal(report.complete, false);
  assert.ok(
    report.issues.some((i) => i.ruleId === 'pcb.unassigned-copper' && i.severity === 'warning'),
  );
});

test('circular pad/via contacts and minimum rings do not depend on polygon sample angles', () => {
  const board = fixture();
  const a = pad(board, 5, 5);
  a.pads[0].shape = 'circle';
  a.pads[0].size = { x: 0.6, y: 0.6 };
  a.pads[0].type = 'thru_hole';
  a.pads[0].drill = 0.3;
  const angle = Math.PI / 24;
  const b = pad(board, 5 + 0.599 * Math.cos(angle), 5 + 0.599 * Math.sin(angle), 1);
  b.pads[0].shape = 'circle';
  b.pads[0].size = { x: 0.6, y: 0.6 };
  assert.equal(issues(board, 'pcb.annular-ring').length, 0);
  assert.equal(issues(board, 'pcb.short').length, 1);
});

test('pad checks use transformed shape and explicit copper layers rather than axis-aligned package bounds', () => {
  const board = fixture();
  const f = pad(board, 10, 10);
  f.rotation = 90;
  f.side = 'back';
  f.pads[0].x = 2;
  f.pads[0].size = { x: 4, y: 1 };
  f.pads[0].layers = ['B.Cu'];
  board.tracks = [track(board, { x: 9.3, y: 6 }, { x: 9.3, y: 10 }, 1, 'B.Cu', 0.2)];
  assert.equal(issues(board, 'pcb.clearance').length, 1);
  board.tracks[0].layer = 'F.Cu';
  assert.equal(issues(board, 'pcb.clearance').length, 0);
  board.tracks[0].layer = 'B.Cu';
  board.tracks[0].start.x = board.tracks[0].end.x = 8;
  assert.equal(issues(board, 'pcb.clearance').length, 0);
});

test('NPTH holes have no copper but enforce all-layer hole clearance, including same-labelled nets', () => {
  const board = fixture();
  const f = pad(board, 5, 5);
  f.pads[0].type = 'np_thru_hole';
  f.pads[0].drill = 1;
  board.tracks = [track(board, { x: 5.7, y: 3 }, { x: 5.7, y: 7 }, 0, 'B.Cu', 0.2)];
  assert.equal(issues(board, 'pcb.copper-hole').length, 1);
  assert.equal(issues(board, 'pcb.short').length, 0);
  board.tracks[0].start.x = board.tracks[0].end.x = 6;
  assert.equal(issues(board, 'pcb.copper-hole').length, 0);
});

test('same-net plated holes accept legal routing anchors but foreign nets remain blocked on other layers', () => {
  const board = fixture();
  const f = pad(board, 5, 5);
  f.pads[0].type = 'thru_hole';
  f.pads[0].drill = 0.8;
  f.pads[0].layers = ['F.Cu'];
  board.tracks = [track(board, { x: 5, y: 5 }, { x: 8, y: 5 }, 0, 'B.Cu')];
  assert.equal(issues(board, 'pcb.copper-hole').length, 0);
  board.tracks[0].netId = board.nets[1].id;
  assert.equal(issues(board, 'pcb.copper-hole').length, 1);
  assert.equal(issues(board, 'pcb.short').length, 0);
});

test('track width, via drill and offset plated annular rings use configurable minimums', () => {
  const board = fixture();
  board.tracks = [track(board, { x: 0, y: 0 }, { x: 5, y: 0 }, 0, 'F.Cu', 0.1)];
  board.vias = [
    { id: uid(), x: 15, y: 5, diameter: 0.6, drill: 0.08, netId: board.nets[0].id },
    { id: uid(), x: 20, y: 5, diameter: 0.4, drill: 0.35, netId: board.nets[0].id },
  ];
  const f = pad(board, 30, 10);
  f.rotation = 90;
  f.pads[0].type = 'thru_hole';
  f.pads[0].drill = 0.3;
  f.pads[0].drillOffset = { x: 0.85, y: 0 };
  const report = runPCBDesignRules(board);
  assert.equal(report.issues.filter((i) => i.ruleId === 'pcb.track-width').length, 1);
  assert.equal(report.issues.filter((i) => i.ruleId === 'pcb.via-drill').length, 1);
  assert.equal(report.issues.filter((i) => i.ruleId === 'pcb.annular-ring').length, 2);
  assert.deepEqual(padDrillPosition(f, f.pads[0]), { x: 30, y: 9.15 });
  assert.equal(
    runPCBDesignRules(board, { minTrackWidth: 0, minViaDrill: 0, minAnnularRing: 0 }).issues.filter(
      (i) => ['pcb.track-width', 'pcb.via-drill', 'pcb.annular-ring'].includes(i.ruleId),
    ).length,
    0,
  );
});

test('missing, open and self-intersecting board outlines leave explicit incomplete reports', () => {
  const board = fixture();
  board.graphics = [];
  let report = runPCBDesignRules(board);
  assert.equal(report.complete, false);
  assert.equal(report.issues[0].ruleId, 'pcb.outline');
  board.graphics = [
    { id: uid(), layer: 'Edge.Cuts', width: 0.05, start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
  ];
  assert.match(runPCBDesignRules(board).issues[0].message, /open|ambiguous/);
  board.graphics = [];
  outline(board, [
    { x: 0, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
    { x: 10, y: 0 },
  ]);
  report = runPCBDesignRules(board);
  assert.equal(report.complete, false);
  assert.ok(report.issues.some((i) => i.ruleId === 'pcb.outline'));
});

test('copper-to-edge checks include cutouts, outside copper and trace widths', () => {
  const board = fixture();
  board.graphics = [];
  outline(board, rect(0, 0, 20, 20));
  outline(board, rect(8, 8, 12, 12));
  board.tracks = [
    track(board, { x: 2, y: 0.3 }, { x: 5, y: 0.3 }, 0, 'F.Cu', 0.2),
    track(board, { x: 9, y: 10 }, { x: 11, y: 10 }),
  ];
  assert.equal(issues(board, 'pcb.copper-edge').length, 2);
  assert.equal(
    runPCBDesignRules(board, { copperToEdge: 0.1 }).issues.filter(
      (i) => i.ruleId === 'pcb.copper-edge',
    ).length,
    1,
  );
});

test('zero edge separation allows a true boundary touch but rejects polygon crossings through a concave notch', () => {
  const board = fixture();
  board.graphics = [];
  outline(board, rect(0, 0, 20, 20));
  pad(board, 19, 10);
  assert.equal(
    runPCBDesignRules(board, { copperToEdge: 0 }).issues.filter(
      (i) => i.ruleId === 'pcb.copper-edge',
    ).length,
    0,
  );
  board.footprints = [];
  board.graphics = [];
  outline(board, [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 20 },
    { x: 12, y: 20 },
    { x: 12, y: 8 },
    { x: 8, y: 8 },
    { x: 8, y: 20 },
    { x: 0, y: 20 },
  ]);
  const z = zone(board, rect(5, 10, 15, 12));
  z.filledPolygons = [{ points: z.outline }];
  board.zones = [z];
  assert.equal(
    runPCBDesignRules(board, { copperToEdge: 0 }).issues.filter(
      (i) => i.ruleId === 'pcb.copper-edge',
    ).length,
    1,
  );
});

test('zone outlines never become copper; saved native fills and holes are checked without refilling', () => {
  const board = fixture();
  const z = zone(board);
  board.zones = [z];
  board.tracks = [track(board, { x: 4.5, y: 5 }, { x: 5.5, y: 5 }, 1, 'F.Cu', 0.2)];
  let report = runPCBDesignRules(board);
  assert.equal(report.complete, false);
  assert.ok(report.issues.some((i) => i.ruleId === 'pcb.unfilled-zone'));
  assert.equal(report.issues.filter((i) => i.ruleId === 'pcb.short').length, 0);
  z.filledPolygons = [
    { points: copperFillContour({ outer: z.outline, holes: [rect(4, 4, 6, 6)] }) },
  ];
  report = runPCBDesignRules(board);
  assert.deepEqual(
    report.issues,
    [],
    'The saved fill hole remains empty without a blanket warning.',
  );
  assert.equal(report.complete, true);
  board.tracks[0].end.x = 7;
  report = runPCBDesignRules(board);
  assert.equal(report.issues.filter((i) => i.ruleId === 'pcb.short').length, 1);
  assert.equal(report.complete, true);
  assert.ok(report.issues.every((i) => i.severity === 'error'));
  z.filledPolygons = [];
  report = runPCBDesignRules(board);
  assert.deepEqual(
    report.issues,
    [],
    'An empty completed fill has no copper or missing-fill warning.',
  );
  assert.equal(report.complete, true);
});

test('copper edits warn after fill invalidation and refilling clears the warning', () => {
  const board = fixture();
  const z = zone(board);
  z.filledPolygons = [{ points: z.outline }];
  board.zones = [z];
  board.tracks = [track(board, { x: 3, y: 3 }, { x: 4, y: 3 })];
  assert.equal(runPCBDesignRules(board).complete, true);
  const changed = structuredClone(board);
  changed.tracks[0].end.x = 5;
  const invalidated = invalidatePCBFill(board, changed);
  assert.equal(invalidated.zones[0].filledPolygons, undefined);
  const before = structuredClone(invalidated);
  const report = runPCBDesignRules(invalidated);
  assert.equal(report.complete, false);
  assert.deepEqual(
    report.issues.map((issue) => issue.ruleId),
    ['pcb.unfilled-zone'],
  );
  assert.deepEqual(invalidated, before, 'Checking never refills or changes invalidated geometry.');
  const refilled = runPCBDesignRules(fillCopperZones(invalidated));
  assert.equal(refilled.complete, true);
  assert.deepEqual(refilled.issues, []);
});

test('indexed polygon checks retain boundary crossings even when neither polygon contains the other’s vertices', () => {
  const board = fixture();
  const a = zone(board, rect(2, 4, 8, 6));
  const b = zone(board, rect(4, 2, 6, 8));
  b.netId = board.nets[1].id;
  a.filledPolygons = [{ points: a.outline }];
  b.filledPolygons = [{ points: b.outline }];
  board.zones = [a, b];
  assert.equal(issues(board, 'pcb.short').length, 1);
});

test('large saved contours retain hole semantics and finish within the unchanged geometry budget', () => {
  const board = fixture();
  const ring = (radius: number) =>
    Array.from({ length: 2000 }, (_, i) => ({
      x: 15 + radius * Math.cos((i * Math.PI) / 1000),
      y: 15 + radius * Math.sin((i * Math.PI) / 1000),
    }));
  const z = zone(board, ring(6));
  z.filledPolygons = [{ points: copperFillContour({ outer: z.outline, holes: [ring(2)] }) }];
  board.zones = [z];
  board.tracks = [track(board, { x: 14.5, y: 15 }, { x: 15.5, y: 15 }, 1)];
  const before = structuredClone(board);
  let report = runPCBDesignRules(board);
  assert.equal(report.issues.filter((i) => i.ruleId === 'pcb.short').length, 0);
  assert.ok(!report.issues.some((i) => i.ruleId === 'pcb.geometry-limit'));
  assert.deepEqual(board, before);
  board.tracks[0].end.x = 18;
  report = runPCBDesignRules(board);
  assert.equal(report.issues.filter((i) => i.ruleId === 'pcb.short').length, 1);
  assert.ok(!report.issues.some((i) => i.ruleId === 'pcb.geometry-limit'));
});

test('footprint-owned saved fills and keepouts use world transforms and per-layer/per-object flags', () => {
  const board = fixture();
  const f = pad(board, 10, 10);
  f.pads = [];
  f.rotation = 90;
  const z = zone(board, rect(0, 0, 2, 2));
  z.filledPolygons = [{ points: z.outline }];
  f.zones = [z];
  board.tracks = [track(board, { x: 11, y: 8.5 }, { x: 11, y: 9.5 }, 1)];
  assert.equal(issues(board, 'pcb.short').length, 1);
  z.keepout = { tracks: true, vias: false, pads: false, copperpour: false, footprints: false };
  assert.equal(issues(board, 'pcb.keepout').length, 1);
  board.tracks[0].layer = 'B.Cu';
  assert.equal(issues(board, 'pcb.keepout').length, 0);
});

test('unrouted results use physical connectivity across track layers and plated vias', () => {
  const board = fixture();
  pad(board, 0, 0);
  pad(board, 10, 0).side = 'back';
  board.tracks = [
    track(board, { x: 0, y: 0 }, { x: 5, y: 0 }),
    track(board, { x: 5, y: 0 }, { x: 10, y: 0 }, 0, 'B.Cu'),
  ];
  assert.equal(issues(board, 'pcb.unrouted').length, 1);
  board.vias = [{ id: uid(), x: 5, y: 0, diameter: 0.8, drill: 0.4, netId: board.nets[0].id }];
  assert.equal(issues(board, 'pcb.unrouted').length, 0);
});

test('pour keepouts allow shared boundaries and holes but reject actual filled-area overlap', () => {
  const board = fixture();
  const keepout = zone(board, rect(4, 4, 6, 6));
  keepout.keepout = {
    tracks: false,
    vias: false,
    pads: false,
    copperpour: true,
    footprints: false,
  };
  const pour = zone(board);
  board.zones = [keepout, pour];
  for (const [polygon, expected] of [
    [{ outer: rect(2, 4, 4, 6), holes: [] }, 0],
    [{ outer: rect(2, 2, 4, 4), holes: [] }, 0],
    [{ outer: rect(2, 4, 4.01, 6), holes: [] }, 1],
    [{ outer: rect(2, 4, 4.0002, 6), holes: [] }, 1],
    [{ outer: rect(4.5, 4.5, 4.5001, 4.5001), holes: [] }, 1],
    [{ outer: rect(2, 4.5, 8, 5.5), holes: [] }, 1],
    [{ outer: rect(4.5, 4.5, 5.5, 5.5), holes: [] }, 1],
    [{ outer: rect(2, 2, 8, 8), holes: [] }, 1],
    [{ outer: rect(2, 2, 8, 8), holes: [keepout.outline] }, 0],
  ] as [{ outer: Point[]; holes: Point[][] }, number][]) {
    pour.filledPolygons = [{ points: copperFillContour(polygon) }];
    const before = structuredClone(board);
    assert.equal(issues(board, 'pcb.keepout').length, expected);
    assert.deepEqual(board, before);
  }
  keepout.layer = 'B.Cu';
  pour.filledPolygons = [{ points: rect(4.5, 4.5, 5.5, 5.5) }];
  assert.equal(issues(board, 'pcb.keepout').length, 0);
  keepout.layer = 'F.Cu';
  keepout.keepout.copperpour = false;
  assert.equal(issues(board, 'pcb.keepout').length, 0);
});

test('pour keepouts tolerate coordinate rounding along a shared sloped boundary', () => {
  const board = fixture();
  const a = { x: 8.575314, y: 5.026666 };
  const b = { x: 9.74, y: 5.18 };
  const keepout = zone(board, [a, b, { x: b.x, y: 4 }]);
  keepout.keepout = {
    tracks: false,
    vias: false,
    pads: false,
    copperpour: true,
    footprints: false,
  };
  const pour = zone(board);
  pour.filledPolygons = [
    {
      points: [a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, b, { x: b.x, y: 6 }],
    },
  ];
  board.zones = [keepout, pour];
  const before = structuredClone(board);
  assert.deepEqual(issues(board, 'pcb.keepout'), []);
  assert.deepEqual(board, before);

  // A narrow pour well inside the keepout must still fail, regardless of area.
  pour.filledPolygons = [{ points: rect(9.5, 4.5, 9.5001, 4.5001) }];
  assert.equal(issues(board, 'pcb.keepout').length, 1);

  keepout.holes = [rect(9, 4.5, 9.6, 5)];
  pour.filledPolygons = [{ points: keepout.holes[0] }];
  assert.deepEqual(issues(board, 'pcb.keepout'), []);
  pour.filledPolygons = [{ points: rect(8.9998, 4.5, 9.6, 5) }];
  assert.equal(issues(board, 'pcb.keepout').length, 1);
});

test('the actual native EMC Flyback board passes DRC without changing saved copper or files', async () => {
  const { readNativeProject } = createRequire(import.meta.url)('../electron/native-project.cjs');
  const filename = 'recent/emc-flyback/emc-flyback.kicad_pro';
  const native = await readNativeProject(filename);
  const board = projectFromNativeFiles(native).pcb!;
  const before = structuredClone(board);
  const report = runPCBDesignRules(board);
  assert.equal(report.complete, true);
  assert.equal(report.truncated, false);
  assert.deepEqual(report.issues, []);
  assert.deepEqual(board, before);
  assert.deepEqual(await readNativeProject(filename), native);
});

test('checks are deterministic and never change board geometry or fills', () => {
  const board = fixture();
  const z = zone(board);
  z.filledPolygons = [{ points: z.outline }];
  board.zones = [z];
  board.tracks = [track(board, { x: 3, y: 4 }, { x: 6, y: 4 }, 1)];
  const before = structuredClone(board);
  const first = runPCBDesignRules(board);
  assert.deepEqual(runPCBDesignRules(board), first);
  assert.deepEqual(board, before);
});

test('threshold validation rejects unknown, non-finite and out-of-range inputs', () => {
  const board = fixture();
  assert.equal(defaultPCBDesignRules.clearance, 0.15);
  for (const config of [
    { clearance: -1 },
    { minViaDrill: Infinity },
    { copperToEdge: 1001 },
    { unknown: 1 },
    null,
    [],
  ])
    assert.throws(() => runPCBDesignRules(board, config as never), /valid|threshold/);
});

test('issue and geometry budgets return partial reports instead of claiming a clean board', () => {
  const board = fixture();
  board.tracks = Array.from({ length: 1002 }, () =>
    track(board, { x: 0, y: 0 }, { x: 1, y: 0 }, 0, 'F.Cu', 0.1),
  );
  let report = runPCBDesignRules(board);
  assert.equal(report.issues.length, 1000);
  assert.equal(report.truncated, true);
  assert.equal(report.complete, false);
  board.tracks = Array.from({ length: 2100 }, () => track(board, { x: 0, y: 0 }, { x: 1, y: 0 }));
  report = runPCBDesignRules(board);
  assert.equal(report.complete, false);
  assert.ok(report.notes.some((note) => note.includes('geometry work limit')));
});
