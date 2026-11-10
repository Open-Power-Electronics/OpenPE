import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ProjectCore } from '../core/project-core';
import { uid, type Point } from '../lib/circuit';
import { invalidatePCBFill, type BoardZone, type Footprint, type PCB } from '../lib/pcb';
import { createEmptyPCB, flipPCBFootprint, padDrillPosition } from '../lib/pcb-layout';
import { copperFillContour, fillCopperZones } from '../lib/pcb-polygons';
import { defaultPCBDesignRules, runPCBDesignRules } from '../lib/pcb-drc';
import { projectFromNativeFiles } from '../lib/kicad-project';
import {
  loadKiCadPCBDesignRuleLimits,
  workbenchPCBDesignRules,
  type RuleCheckResult,
} from '../lib/design-rule-checks';
import { readPCBDesignRuleSources } from '../lib/pcb-clearance-sources';

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

test('KiCad board limits can be overridden and a size-only report skips unrelated rules', () => {
  const limits = loadKiCadPCBDesignRuleLimits(
    JSON.stringify({
      board: {
        design_settings: {
          rules: { min_clearance: 0.1, min_via_diameter: 0.5, min_through_hole_diameter: 0.3 },
        },
      },
      net_settings: { classes: [{ name: 'Default', clearance: 0.23 }] },
    }),
  );
  assert.equal(limits.clearance, 0.1);
  assert.equal(limits.minThroughHole, 0.3);
  assert.equal(limits.minViaDiameter, 0.5);
  assert.throws(
    () =>
      loadKiCadPCBDesignRuleLimits(
        '{"board":{"design_settings":{"rules":{"min_via_diameter":"0.5"}}}}',
      ),
    /min_via_diameter/,
  );
  const board = fixture();
  board.graphics = [];
  board.vias = [
    { id: uid(), x: 5, y: 5, diameter: 0.499999, drill: 0.29, netId: board.nets[0].id },
  ];
  const footprint = pad(board, 5, 5, 1);
  footprint.pads[0].type = 'np_thru_hole';
  footprint.pads[0].drill = 0.2;
  board.zones = [zone(board)];
  const before = structuredClone(board);
  const report = runPCBDesignRules(board, { ...limits, scopes: ['dimensions'], minAnnularRing: 0 });
  assert.equal(report.complete, false);
  assert.deepEqual(
    report.issues.map((issue) => issue.ruleId),
    ['pcb.pad-drill', 'pcb.via-drill', 'pcb.via-diameter'],
  );
  assert.ok(!report.checkedRules.includes('pcb.outline'));
  const adjusted = runPCBDesignRules(board, {
    ...limits,
    scopes: ['dimensions'],
    minAnnularRing: 0,
    minViaDiameter: 0.499999,
    minThroughHole: 0.2,
  });
  assert.deepEqual(adjusted.issues, []);
  assert.deepEqual(board, before);
});

test('saved-zone clearance is applied to its fill only when selected', () => {
  const board = fixture();
  const outline = rect(2, 2, 8, 8);
  board.zones = [{ ...zone(board, outline), filledPolygons: [{ points: outline }] }];
  board.tracks = [track(board, { x: 2, y: 8.4 }, { x: 8, y: 8.4 }, 1)];
  const settings = { clearance: 0.15, scopes: ['clearance'] as const };
  assert.deepEqual(runPCBDesignRules(board, settings).issues, []);
  const report = runPCBDesignRules(board, { ...settings, useZoneClearance: true });
  assert.deepEqual(
    report.issues.map((issue) => issue.ruleId),
    ['pcb.clearance'],
  );
  assert.match(report.issues[0].message, /requires 0\.25 mm/);
  assert.equal(report.complete, false);
  assert.deepEqual(
    runPCBDesignRules(board, {
      ...settings,
      useZoneClearance: true,
      clearanceOverrides: [{ key: `zone:${board.zones[0].id}`, clearance: 0.25, enabled: false }],
    }).issues,
    [],
  );
});

test('native net-class limits and overrides participate in clearance checks', () => {
  const pcb = fixture();
  pcb.tracks = [
    track(pcb, { x: 0, y: 0 }, { x: 8, y: 0 }),
    track(pcb, { x: 0, y: 0.7 }, { x: 8, y: 0.7 }, 1),
  ];
  const entry = 'test.kicad_pro';
  const nativeFiles = {
    entry,
    files: [
      {
        name: entry,
        source: JSON.stringify({
          net_settings: {
            classes: [
              { name: 'Default', clearance: 0.2 },
              { name: 'Power', clearance: 0.5 },
            ],
            netclass_patterns: [{ pattern: 'OUT', netclass: 'Power' }],
          },
        }),
      },
    ],
  };
  const sources = readPCBDesignRuleSources({ pcb, nativeFiles });
  const settings = { useKiCadClearance: true };
  assert.match(
    runPCBDesignRules(pcb, settings, undefined, sources).issues[0].message,
    /requires 0\.5 mm \(net class Power\)/,
  );
  assert.deepEqual(
    runPCBDesignRules(
      pcb,
      {
        ...settings,
        clearanceOverrides: [{ key: 'class:Power', clearance: 0.25 }],
      },
      undefined,
      sources,
    ).issues,
    [],
  );
  const unsupported = readPCBDesignRuleSources({
    pcb,
    nativeFiles: {
      entry,
      files: [
        ...nativeFiles.files,
        {
          name: 'test.kicad_dru',
          source:
            '(version 1) (rule custom (constraint clearance (min 1mm)) (condition "A.Layer == \'F.Cu\'"))',
        },
      ],
    },
  });
  const partial = runPCBDesignRules(pcb, settings, undefined, unsupported);
  assert.equal(partial.complete, false);
  assert.ok(partial.notes.some((note) => note.includes('Unsupported KiCad rule')));
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

test('drill spacing uses actual round holes across nets and respects its independent switch', () => {
  const board = fixture();
  const part = pad(board, 5, 5);
  part.pads[0].type = 'np_thru_hole';
  part.pads[0].drill = 0.8;
  const viaId = uid();
  board.vias = [{ id: viaId, x: 5.8, y: 5, diameter: 0.6, drill: 0.4, netId: board.nets[1].id }];
  const settings = { scopes: ['holes'] as const, copperToHole: 0, holeToHole: 0.21 };
  const report = runPCBDesignRules(board, settings);
  assert.deepEqual(
    report.issues.map((issue) => issue.ruleId),
    ['pcb.hole-spacing'],
  );
  assert.deepEqual(new Set(report.issues[0].objectIds), new Set([part.pads[0].id, viaId]));
  assert.match(report.issues[0].message, /0\.2 mm; requires 0\.21 mm/);
  const spacingOnly = runPCBDesignRules(board, {
    ...settings,
    severities: { 'pcb.copper-hole': 'ignore' },
  });
  assert.deepEqual(spacingOnly.issues, report.issues);
  assert.deepEqual(runPCBDesignRules(board, { ...settings, holeToHole: 0.2 }).issues, []);
  const disabled = runPCBDesignRules(board, {
    ...settings,
    severities: { 'pcb.hole-spacing': 'ignore' },
  });
  assert.deepEqual(disabled.issues, []);
  assert.deepEqual(disabled.checkedRules, ['pcb.copper-hole']);
});

test('silkscreen geometry and visible text dimensions run as separate configurable checks', () => {
  const board = fixture();
  const part = pad(board, 0, 0);
  const stroke = {
    id: uid(),
    layer: 'F.SilkS' as const,
    start: { x: 1, y: 1 },
    end: { x: 5, y: 1 },
    width: 0.1,
  };
  part.graphics = [stroke];
  const neighbour = { ...stroke, id: uid(), start: { x: 1, y: 1.2 }, end: { x: 5, y: 1.2 } };
  const text = {
    id: uid(),
    layer: 'F.SilkS' as const,
    kind: 'text' as const,
    width: 0,
    start: { x: 12, y: 8 },
    end: { x: 12, y: 8 },
    text: { value: 'A', size: { x: 0.5, y: 0.6 }, thickness: 0.07, rotation: 0 },
  };
  board.graphics.push(neighbour, { ...neighbour, id: uid(), layer: 'B.SilkS' }, text, {
    ...text,
    id: uid(),
    text: { ...text.text, hidden: true },
  });
  const settings = {
    scopes: ['silkscreen'] as const,
    minSilkClearance: 0.15,
    minTextHeight: 0.8,
    minTextThickness: 0.08,
  };
  const report = runPCBDesignRules(board, settings);
  assert.deepEqual(report.issues.map(({ ruleId }) => ruleId).sort(), [
    'pcb.silk-clearance',
    'pcb.silk-text-height',
    'pcb.silk-text-thickness',
  ]);
  assert.match(
    report.issues.find(({ ruleId }) => ruleId === 'pcb.silk-clearance')!.message,
    /0\.1 mm/,
  );
  const reconfigured = runPCBDesignRules(board, {
    ...settings,
    severities: { 'pcb.silk-clearance': 'ignore', 'pcb.silk-text-height': 'warning' },
  });
  assert.deepEqual(
    reconfigured.issues.map(({ ruleId, severity }) => [ruleId, severity]),
    [
      ['pcb.silk-text-height', 'warning'],
      ['pcb.silk-text-thickness', 'error'],
    ],
  );
  assert.ok(!reconfigured.checkedRules.includes('pcb.silk-clearance'));
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
    runPCBDesignRules(board, {
      minTrackWidth: 0,
      minThroughHole: 0,
      minAnnularRing: 0,
    }).issues.filter((i) =>
      ['pcb.track-width', 'pcb.via-drill', 'pcb.annular-ring'].includes(i.ruleId),
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

test('board edge checks retain an offset plated drill outside its pad bounds', () => {
  const board = fixture();
  board.graphics = [];
  outline(board, rect(0, 0, 20, 20));
  const [drilled] = pad(board, 5, 5).pads;
  drilled.type = 'thru_hole';
  drilled.drill = 1;
  drilled.drillOffset = { x: -4.9, y: 0 };
  assert.deepEqual(
    issues(board, 'pcb.copper-edge').map((issue) => issue.objectIds),
    [[drilled.id]],
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
  keepout.clearance = 0;
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
  keepout.clearance = 0.5;
  pour.filledPolygons = [{ points: rect(2, 4, 3.5, 6) }];
  assert.equal(issues(board, 'pcb.keepout').length, 0);
  pour.filledPolygons = [{ points: rect(2, 4, 3.6, 6) }];
  assert.equal(issues(board, 'pcb.keepout').length, 1);
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
  keepout.clearance = 0;
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

test('courtyard DRC checks rotated closed contours on their own layer and allows shared edges', () => {
  const board = fixture();
  const a = pad(board, 10, 10);
  const b = pad(board, 10, 13);
  a.reference = 'U1';
  b.reference = 'U2';
  a.rotation = 90;
  const courtyard = (points: Point[]): Footprint['graphics'] =>
    points.map((start, index) => ({
      id: uid(),
      layer: 'F.CrtYd',
      width: 0.05,
      start,
      end: points[(index + 1) % points.length],
    }));
  a.graphics = courtyard(rect(-2, -1, 2, 1));
  b.graphics = courtyard(rect(-1, -1, 1, 1));
  assert.deepEqual(issues(board, 'pcb.courtyard-overlap'), []);
  b.y = 12.5;
  b.locked = true;
  const overlap = issues(board, 'pcb.courtyard-overlap');
  assert.equal(overlap.length, 1);
  assert.equal(overlap[0].severity, 'error');
  assert.deepEqual(new Set(overlap[0].objectIds), new Set([a.id, b.id]));
  assert.match(overlap[0].message, /U1 and U2.*F\.CrtYd/);
  assert.ok(overlap[0].location!.y >= 11.5 && overlap[0].location!.y <= 12);
  delete b.locked;
  board.footprints[1] = flipPCBFootprint(b);
  assert.deepEqual(issues(board, 'pcb.courtyard-overlap'), []);
  board.footprints[0] = flipPCBFootprint(a);
  assert.match(issues(board, 'pcb.courtyard-overlap')[0].message, /B\.CrtYd/);

  a.graphics.pop();
  board.footprints[0] = a;
  const malformed = runPCBDesignRules(board);
  assert.equal(malformed.complete, false);
  assert.deepEqual(
    malformed.issues
      .filter((issue) => issue.ruleId === 'pcb.courtyard-malformed')
      .map((issue) => [issue.severity, issue.objectIds]),
    [['error', [a.id]]],
  );
});

test('courtyards preserve independent contours and cutouts and reject crossing outlines', () => {
  const board = fixture();
  const a = pad(board, 10, 10);
  const b = pad(board, 10, 10);
  const shape = (points: Point[]): Footprint['graphics'][number] => ({
    id: uid(),
    layer: 'F.CrtYd',
    kind: 'polygon',
    start: points[0],
    end: points.at(-1)!,
    points: points.slice(1, -1),
    width: 0.05,
  });
  a.graphics = [shape(rect(-4, -4, 4, 4)), shape(rect(-2, -2, 2, 2)), shape(rect(6, 6, 8, 8))];
  b.graphics = [shape(rect(-1, -1, 1, 1))];
  assert.deepEqual(issues(board, 'pcb.courtyard-overlap'), []);
  b.x += 7;
  b.y += 7;
  assert.equal(issues(board, 'pcb.courtyard-overlap').length, 1);
  const [p, q, r, s] = rect(-4, -4, 4, 4);
  a.graphics[0] = shape([p, r, q, s]);
  assert.equal(issues(board, 'pcb.courtyard-malformed').length, 1);
});

test('native EMC Flyback uses conditional clearance precedence and accepts session overrides', async () => {
  const { readNativeProject } = createRequire(import.meta.url)('../electron/native-project.cjs');
  const filename = 'examples/project/emc-flyback/emc-flyback.kicad_pro';
  const native = await readNativeProject(filename);
  const project = projectFromNativeFiles(native);
  const board = project.pcb!;
  const core = new ProjectCore(project);
  const before = core.getSnapshot();
  const boardId = board.id;
  const nativeClearanceSettings = {
    ...workbenchPCBDesignRules,
    useZoneClearance: true,
    useKiCadClearance: true,
  };
  const report = (await core.query('layout.drc', {
    boardId,
    settings: nativeClearanceSettings,
  })) as RuleCheckResult;
  assert.equal(report.complete, true);
  assert.equal(report.truncated, false);
  assert.deepEqual(report.issues, []);
  const changed = (await core.query('layout.drc', {
    boardId,
    settings: {
      ...nativeClearanceSettings,
      clearanceOverrides: [
        { key: 'rule:low-voltage primary pairs (<= 13 V apart)', clearance: 0.3 },
      ],
    },
  })) as RuleCheckResult;
  assert.equal(changed.complete, true);
  assert.ok(
    changed.issues.some(
      ({ message, objectIds }) =>
        objectIds.includes('68276903-6104-4936-a5c5-7975a08ac27c') &&
        /0\.2004 mm; requires 0\.3 mm \(rule low-voltage/.test(message),
    ),
  );
  const disabledRule = (await core.query('layout.drc', {
    boardId,
    settings: {
      ...nativeClearanceSettings,
      clearanceOverrides: [
        { key: 'rule:low-voltage primary pairs (<= 13 V apart)', clearance: 0.2, enabled: false },
      ],
    },
  })) as RuleCheckResult;
  assert.ok(
    disabledRule.issues.some(
      ({ message, objectIds }) =>
        objectIds.includes('68276903-6104-4936-a5c5-7975a08ac27c') &&
        /0\.2004 mm; requires 0\.4 mm \(zone PGND/.test(message),
    ),
  );
  const runWorkbench = (clearance: number) =>
    core.query('layout.drc', {
      boardId,
      settings: { ...workbenchPCBDesignRules, clearance },
    }) as Promise<RuleCheckResult>;
  const workbench = await runWorkbench(0.15);
  assert.equal(workbench.complete, true);
  assert.deepEqual(workbench.issues, []);
  const tighter = await runWorkbench(0.21);
  assert.ok(
    tighter.issues.some(
      ({ message, objectIds }) =>
        objectIds.includes('68276903-6104-4936-a5c5-7975a08ac27c') &&
        /0\.2004 mm; requires 0\.21 mm\.$/.test(message),
    ),
  );
  assert.equal(core.getSnapshot(), before);
  assert.deepEqual(await readNativeProject(filename), native);
});

test('EMC Flyback DRC completes after moving a track and refreshing saved fills', async () => {
  const { readNativeProject } = createRequire(import.meta.url)('../electron/native-project.cjs');
  const native = await readNativeProject('examples/project/emc-flyback/emc-flyback.kicad_pro');
  const project = projectFromNativeFiles(native);
  const board = project.pcb!;
  const core = new ProjectCore(project);
  core.execute('layout.move', {
    boardId: board.id,
    selection: [{ kind: 'track', id: '1d86d449-e059-45b0-ae66-5414983dc04d' }],
    delta: { x: 0, y: 0.1 },
  });
  const moved = core.getSnapshot();
  assert.notDeepEqual(
    moved.project!.pcb!.zones.map((zone) => zone.filledPolygons),
    board.zones.map((zone) => zone.filledPolygons),
  );
  const report = (await core.query('layout.drc', { boardId: board.id })) as RuleCheckResult;
  assert.equal(report.complete, true, report.notes.join('\n'));
  assert.ok(!report.issues.some((issue) => issue.ruleId === 'pcb.unfilled-zone'));
  assert.deepEqual(await core.query('layout.drc', { boardId: board.id }), report);
  assert.equal(core.getSnapshot(), moved);
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
    { minThroughHole: Infinity },
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
