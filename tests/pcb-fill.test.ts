import test from 'node:test';
import assert from 'node:assert/strict';
import { uid } from '../lib/circuit';
import {
  createProject,
  parseProject,
  serializeProject,
  exportKiCad,
  projectFromNativeFiles,
  projectNativeFiles,
} from '../lib/project';
import { createEmptyPCB, movePCBSelection } from '../lib/pcb-layout';
import { invalidatePCBFill, type BoardZone } from '../lib/pcb';
import {
  copperPolygons,
  filledCopperPolygons,
  fillCopperZones,
  copperFillContour,
  subtractPolygons,
  offsetPolygons,
  type Polygon,
} from '../lib/pcb-polygons';
import { child, children, parseSExpr, val, writeSExpr } from '../lib/sexpr';
import { convertExamplePCB } from '../scripts/example-pcb';
import { referenceExamples, createReferenceExample } from '../lib/reference-examples';
import { runPCBDesignRules } from '../lib/pcb-drc';

const rectangle = (x: number, y: number, w: number, h: number) => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];
function ringContains(ring: { x: number; y: number }[], x: number, y: number) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
const contains = (polygons: Polygon[], x: number, y: number) =>
  polygons.some((p) => ringContains(p.outer, x, y) && !p.holes.some((h) => ringContains(h, x, y)));
function fixture() {
  const board = createEmptyPCB();
  board.nets = [
    { id: uid(), name: 'GND' },
    { id: uid(), name: 'Signal' },
  ];
  const corners = rectangle(0, 0, 30, 20);
  board.graphics = corners.map((start, i) => ({
    id: uid(),
    layer: 'Edge.Cuts',
    width: 0.1,
    start,
    end: corners[(i + 1) % 4],
  }));
  const zone: BoardZone = {
    id: uid(),
    netId: board.nets[0].id,
    layer: 'F.Cu',
    outline: rectangle(-2, -2, 34, 24),
    clearance: 0.3,
    minThickness: 0.1,
    thermalGap: 0.3,
    thermalBridge: 0.3,
  };
  board.zones = [zone];
  board.tracks = [
    {
      id: uid(),
      netId: board.nets[1].id,
      layer: 'F.Cu',
      width: 0.4,
      start: { x: 5, y: 10 },
      end: { x: 25, y: 10 },
    },
  ];
  board.vias = [{ id: uid(), netId: board.nets[1].id, x: 10, y: 5, diameter: 1, drill: 0.5 }];
  return board;
}

test('zero native clearance uses the fill minimum and retains copper-edge spacing around track sides and ends', () => {
  for (const clearance of [undefined, 0.1, 0.6]) {
    for (const end of [
      { x: 24, y: 6 },
      { x: 24, y: 14 },
    ]) {
      const board = fixture();
      board.zones[0].clearance = 0;
      board.vias = [];
      const track = board.tracks[0];
      track.start = { x: 6, y: 6 };
      track.end = end;
      track.width = 1.2;
      const before = structuredClone(board);
      const filled = fillCopperZones(board, clearance);
      const gap = clearance ?? 0.25;
      const copper = filledCopperPolygons(filled).get(board.zones[0].id)!;
      const length = Math.hypot(end.x - 6, end.y - 6);
      const dx = (end.x - 6) / length,
        dy = (end.y - 6) / length;
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        for (const sign of [-1, 1]) {
          const at = { x: 6 + (end.x - 6) * t, y: 6 + (end.y - 6) * t };
          for (const delta of [-0.03, 0.03]) {
            const radius = track.width / 2 + gap + delta;
            assert.equal(
              contains(copper, at.x - sign * dy * radius, at.y + sign * dx * radius),
              delta > 0,
            );
          }
        }
      }
      for (const [at, sign] of [
        [track.start, -1],
        [end, 1],
      ] as const) {
        for (const delta of [-0.03, 0.03]) {
          const radius = track.width / 2 + gap + delta;
          assert.equal(
            contains(copper, at.x + sign * dx * radius, at.y + sign * dy * radius),
            delta > 0,
          );
        }
      }
      assert.equal(filled.zones[0].clearance, gap);
      const project = { ...createProject(), pcb: filled };
      const nativeZone = children(parseSExpr(exportKiCad(project, 'pcb')), 'zone')[0];
      assert.equal(Number(val(child(child(nativeZone, 'connect_pads')!, 'clearance'))), gap);
      assert.deepEqual(parseProject(serializeProject(project)).pcb, filled);
      assert.deepEqual(board, before);
    }
  }
});

test('fill retains larger zone rules, same-net contact and layer separation; invalid clearances fail without edits', () => {
  const board = fixture();
  board.zones[0].clearance = 0.8;
  const filled = fillCopperZones(board, 0.1);
  assert.equal(filled.zones[0].clearance, 0.8);
  const copper = filledCopperPolygons(filled).get(board.zones[0].id)!;
  assert.ok(!contains(copper, 15, 10.9));
  assert.ok(contains(copper, 15, 11.1));
  board.tracks[0].netId = board.zones[0].netId!;
  assert.ok(contains(filledCopperPolygons(fillCopperZones(board)).get(board.zones[0].id)!, 15, 10));
  board.tracks[0].netId = board.nets[1].id;
  board.tracks[0].layer = 'B.Cu';
  assert.ok(contains(filledCopperPolygons(fillCopperZones(board)).get(board.zones[0].id)!, 15, 10));
  const before = structuredClone(board);
  for (const value of [0, -1, NaN, Infinity, 1001]) {
    assert.throws(() => fillCopperZones(board, value), /clearance/);
    assert.deepEqual(board, before);
  }
});

for (const example of referenceExamples) {
  test(`${example.id}: explicit refill separates foreign tracks, pads and zones with the default minimum`, () => {
    const board = createReferenceExample(example.id).pcb!;
    const before = structuredClone(board);
    const filled = fillCopperZones(board);
    const report = runPCBDesignRules(filled);
    assert.equal(report.truncated, false);
    assert.deepEqual(
      report.issues.filter((issue) => ['pcb.short', 'pcb.clearance'].includes(issue.ruleId)),
      [],
    );
    assert.ok(
      filled.zones
        .filter((z) => !z.keepout && z.fillEnabled !== false)
        .every((z) => z.clearance >= 0.25),
    );
    assert.deepEqual(board, before, 'Pinned example input is unchanged.');
  });
}

test('manual fill persists separated copper, foreign-track/via clearances and holes in JSON/native exports', () => {
  const board = fixture();
  board.zones[0].holes = [rectangle(2, 2, 2, 2)];
  board.zones.push({
    ...board.zones[0],
    id: uid(),
    netId: board.nets[1].id,
    outline: rectangle(15, 2, 5, 5),
    priority: 10,
    holes: [],
  });
  assert.equal(filledCopperPolygons(board).size, 0, 'Unfilled outlines never stand in for copper.');
  const original = structuredClone(board),
    filled = fillCopperZones(board),
    polygons = filledCopperPolygons(filled);
  assert.deepEqual(board, original);
  const ground = polygons.get(board.zones[0].id)!,
    signal = polygons.get(board.zones[1].id)!;
  assert.ok(contains(ground, 2, 8));
  for (const [x, y] of [
    [10, 10],
    [10, 10.4],
    [10, 5],
    [3, 3],
    [17, 4],
    [14.8, 4],
    [0.1, 5],
  ])
    assert.ok(!contains(ground, x, y), `${x},${y} is cleared`);
  assert.ok(contains(signal, 17, 4));
  assert.ok(filled.zones.every((z) => z.filledPolygons?.length));
  const project = { ...createProject(), pcb: filled },
    source = serializeProject(project);
  assert.deepEqual(parseProject(source).pcb, filled);
  const native = exportKiCad(project, 'pcb');
  const root = parseSExpr(native);
  // The build-only adapter reads expert-board geometry, not the app's title block.
  const geometrySource = writeSExpr(
    root.filter((n) => !Array.isArray(n) || n[0] !== 'title_block'),
  );
  const reopened = convertExamplePCB(geometrySource, project.schematic, 'filled-roundtrip').board;
  assert.deepEqual(
    reopened.zones.map((z) => z.filledPolygons),
    filled.zones.map((z) => z.filledPolygons),
  );
  assert.ok(
    children(root, 'zone').every((z) =>
      children(z, 'filled_polygon').every((p) => val(child(p, 'layer')) === 'F.Cu'),
    ),
  );
  assert.deepEqual(filledCopperPolygons(reopened), polygons);
});

test('minimum-width smoothing retains exact owner and irregular cutout boundaries in saved native copper', () => {
  const board = fixture();
  board.tracks = [];
  board.vias = [];
  const corners = rectangle(40.2794, 43.4575, 19.4412, 13.085);
  board.graphics = corners.map((start, index) => ({
    id: uid(),
    layer: 'Edge.Cuts',
    width: 0.1,
    start,
    end: corners[(index + 1) % corners.length],
  }));
  const owner: Polygon = {
    outer: rectangle(40.7794, 43.9575, 18.4412, 12.085),
    holes: [
      [
        { x: 49.375, y: 45.25 },
        { x: 49.675, y: 44.95 },
        { x: 51.375, y: 44.95 },
        { x: 51.375, y: 46.55 },
        { x: 49.375, y: 46.55 },
      ],
      Array.from({ length: 64 }, (_, index) => ({
        x: Math.round((42.55 - 1.75 * Math.cos((index * Math.PI) / 32)) * 1e6) / 1e6,
        y: Math.round((47.375 - 1.75 * Math.sin((index * Math.PI) / 32)) * 1e6) / 1e6,
      })),
    ],
  };
  board.zones = [
    {
      ...board.zones[0],
      layer: 'B.Cu',
      outline: owner.outer,
      holes: owner.holes,
      minThickness: 0.25,
      clearance: 0.25,
    },
  ];
  const before = structuredClone(board);
  const filled = fillCopperZones(board);
  const restored = projectFromNativeFiles(
    projectNativeFiles({ ...createProject(), pcb: filled }),
  ).pcb!;
  for (const candidate of [filled, restored]) {
    const copper = [...filledCopperPolygons(candidate).values()].flat();
    assert.ok(copper.length > 0);
    assert.equal(
      contains(copper, 49.38, 46.547),
      false,
      'Rounded minimum-width opening must not add copper inside the chamfered cutout.',
    );
    assert.deepEqual(
      subtractPolygons(copper, [{ outer: owner.outer, holes: [owner.holes[0]] }]),
      [],
      'The straight owner and chamfered cutout boundaries retain exact containment.',
    );
    assert.deepEqual(
      subtractPolygons(copper, offsetPolygons([owner], 0.0002)),
      [],
      'Polygonal curve boundaries retain the existing 0.2 µm rounding band of the 0.1 µm grid.',
    );
    assert.ok(contains(copper, 55, 50), 'Valid broad copper survives the final boundary clip.');
  }
  assert.deepEqual(board, before, 'Explicit refill preserves the original board snapshot.');
});

test('native hole bridges retain multiple concave holes without copper crossing them', () => {
  const board = fixture();
  const polygon: Polygon = {
    outer: rectangle(1, 1, 28, 18),
    holes: [rectangle(4, 3, 3, 3), rectangle(5, 10, 7, 4), rectangle(17, 8, 4, 7)],
  };
  board.zones[0].filledPolygons = [{ points: copperFillContour(polygon), island: true }];
  const result = filledCopperPolygons(board).get(board.zones[0].id)!;
  for (let x = 1.5; x < 29; x += 0.5)
    for (let y = 1.5; y < 19; y += 0.5)
      assert.equal(contains(result, x, y), contains([polygon], x, y), `${x},${y}`);
});

test('footprint-local fills keep their owner coordinates through rotation and serialization', () => {
  const board = fixture();
  board.footprints = [
    {
      id: uid(),
      symbolId: null,
      libraryId: 'Test:LocalPour',
      reference: 'MECH1',
      value: '',
      x: 15,
      y: 10,
      rotation: 90,
      side: 'back',
      pads: [],
      graphics: [],
      zones: [
        {
          ...board.zones[0],
          id: uid(),
          layer: 'B.Cu',
          outline: rectangle(-3, -4, 6, 8),
          holes: [rectangle(-1, -1, 2, 2)],
        },
      ],
    },
  ];
  const filled = fillCopperZones(board),
    local = filled.footprints[0].zones![0];
  assert.ok(
    local.filledPolygons!.every((p) =>
      p.points.every((point) => Math.abs(point.x) <= 3.001 && Math.abs(point.y) <= 4.001),
    ),
  );
  const world = filledCopperPolygons(filled).get(local.id)!;
  assert.ok(contains(world, 17, 10));
  assert.ok(!contains(world, 15, 10));
  const project = { ...createProject(), pcb: filled };
  assert.deepEqual(parseProject(serializeProject(project)).pcb, filled);
  const exported = parseSExpr(exportKiCad(project, 'pcb'));
  const native = children(children(exported, 'footprint')[0], 'zone')[0];
  assert.ok(children(native, 'filled_polygon').length > 0);
});

test('saved fills are authoritative and survive display; edits invalidate them as one undoable board change', () => {
  const filled = fillCopperZones(fixture()),
    before = structuredClone(filled);
  filledCopperPolygons(filled);
  assert.deepEqual(filled, before);
  const presentationIndependent = { ...filled, thickness: 2 };
  assert.equal(invalidatePCBFill(filled, presentationIndependent), presentationIndependent);
  const moved = movePCBSelection(
    filled,
    { kind: 'track', id: filled.tracks[0].id },
    { x: 1.27, y: 0 },
  );
  const invalidated = invalidatePCBFill(filled, moved);
  assert.ok(invalidated.zones.every((z) => z.filledPolygons === undefined));
  assert.ok(
    filled.zones.every((z) => z.filledPolygons?.length),
    'The undo snapshot still has its saved fills.',
  );
  const refilled = fillCopperZones(invalidated);
  assert.notDeepEqual(refilled.zones[0].filledPolygons, filled.zones[0].filledPolygons);
  assert.deepEqual(invalidatePCBFill(filled, refilled), {
    ...refilled,
    zones: refilled.zones.map(({ filledPolygons: _filled, ...z }) => z),
  });
  const source = { ...filled, zones: [{ ...filled.zones[0], outline: rectangle(1, 1, 2, 2) }] };
  assert.ok(
    contains(filledCopperPolygons(source).get(source.zones[0].id)!, 20, 15),
    'Native saved copper is preserved even if its source boundary changed later.',
  );
});

test('invalid saved fills fail before writes, and explicit empty fills remain distinct from unfilled zones', () => {
  const board = fixture(),
    project = { ...createProject(), pcb: board };
  board.zones[0].filledPolygons = [];
  assert.deepEqual(parseProject(serializeProject(project)).pcb!.zones[0].filledPolygons, []);
  const invalid = (edit: (zone: BoardZone) => void) => {
    const next = structuredClone(project);
    edit(next.pcb.zones[0]);
    assert.throws(() => serializeProject(next));
  };
  invalid((z) => {
    z.filledPolygons = [{ points: [{ x: 1, y: 1 }] }];
  });
  invalid((z) => {
    z.filledPolygons = [{ points: rectangle(1, 1, 2, 2) }];
    z.netId = null;
  });
  invalid((z) => {
    z.fillEnabled = false;
  });
  invalid((z) => {
    z.layer = 'F.SilkS';
  });
  invalid((z) => {
    z.filledPolygons = [{ points: rectangle(1, 1, 2, 2).map((p) => ({ ...p, x: NaN })) }];
  });
  invalid((z) => {
    z.filledPolygons = [{ points: Array.from({ length: 60001 }, (_, i) => ({ x: i, y: i % 2 })) }];
  });
  assert.equal(copperPolygons(board).size, 1);
});
