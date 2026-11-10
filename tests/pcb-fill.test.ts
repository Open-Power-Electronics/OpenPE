import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  fillCopperZone,
  refreshPCBFill,
  copperFillContour,
  subtractPolygons,
  offsetPolygons,
  type Polygon,
} from '../lib/pcb-polygons';
import { child, children, parseSExpr, val, writeSExpr } from '../lib/sexpr';
import { convertExamplePCB } from '../scripts/example-pcb';
import { referenceExamples, createReferenceExample } from '../lib/reference-examples';
import { runPCBDesignRules } from '../lib/pcb-drc';
import { isOwnedPCB, ownProjectData } from '../lib/immutable-project';
import { parseKiCadPCB } from '../lib/kicad-pcb';

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

test('selected zone fill enables exactly that zone, preserves unrelated fills and rejects missing or unassigned targets', () => {
  const board = fixture();
  const selected = { ...board.zones[0], fillEnabled: false };
  const other = { ...selected, id: uid(), layer: 'B.Cu' as const };
  board.zones = [selected, other];
  const before = structuredClone(board);
  const filled = fillCopperZone(board, selected.id);
  assert.equal(filled.zones[0].fillEnabled, true);
  assert.ok(filled.zones[0].filledPolygons!.length);
  assert.deepEqual(filled.zones[1], other);
  assert.deepEqual(board, before);
  assert.throws(() => fillCopperZone(board, uid()), /existing board copper zone/);
  const unassigned = { ...board, zones: [{ ...selected, netId: null }] };
  assert.throws(() => fillCopperZone(unassigned, selected.id), /Assign a net/);
  assert.deepEqual(board, before);
  const refilled = fillCopperZone(filled, selected.id, 0.5);
  assert.equal(refilled.zones[0].clearance, 0.5);
  assert.deepEqual(refilled.zones[1], other);
});

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
    const report = runPCBDesignRules(filled, { useZoneClearance: true });
    assert.equal(report.complete, true);
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

test('native island policies remove or mark a disconnected fragment of a connected pour', () => {
  const board = fixture();
  board.vias = [];
  const zone = board.zones[0];
  board.tracks[0].start = { x: 15, y: 0 };
  board.tracks[0].end = { x: 15, y: 20 };
  board.footprints = [
    {
      id: uid(),
      libraryId: 'Test:IslandAnchor',
      x: 5,
      y: 10,
      rotation: 0,
      side: 'front',
      symbolId: null,
      pads: [
        {
          id: uid(),
          number: '1',
          type: 'smd',
          shape: 'rect',
          x: 0,
          y: 0,
          rotation: 0,
          size: { x: 1, y: 1 },
          netId: zone.netId,
        },
      ],
      graphics: [],
    },
  ];
  zone.padConnection = 'yes';
  zone.islandRemovalMode = 1;
  const kept = fillCopperZone(board, zone.id).zones[0].filledPolygons!;
  assert.equal(kept.length, 2);
  assert.equal(kept.filter((polygon) => polygon.island).length, 1);
  zone.islandRemovalMode = 0;
  const removed = fillCopperZones(board).zones[0].filledPolygons!;
  assert.deepEqual(
    removed,
    kept.filter((polygon) => !polygon.island),
  );
  board.footprints = [];
  const floating = fillCopperZones(board).zones[0].filledPolygons!;
  assert.equal(floating.length, 2);
  assert.ok(floating.every((polygon) => !polygon.island));
});

test('TPS61046 runtime refill matches KiCad empty-zone and island outcomes', () => {
  const board = createReferenceExample('reference-tps61046-bga6-boost').pcb!;
  const refilled = fillCopperZones(board);
  for (const zone of refilled.zones) {
    const saved = board.zones.find((original) => original.id === zone.id)!;
    assert.deepEqual(
      zone.filledPolygons!.map((polygon) => !!polygon.island),
      (saved.filledPolygons ?? []).map((polygon) => !!polygon.island),
    );
  }
});

test('LM25017 native GND2 refill matches the saved copper along all three exposed L1 keepout edges', () => {
  const source = readFileSync(
    'examples/lm25017-wson8-flybuck/lm25017-wson8-flybuck.kicad_pcb',
    'utf8',
  );
  const { board } = parseKiCadPCB(source, createProject().schematic, 'lm25017');
  const saved = filledCopperPolygons(board);
  const net = board.nets.find(({ name }) => name === 'GND2')!;
  for (const layer of ['F.Cu', 'B.Cu']) {
    const zone = board.zones.find((item) => item.layer === layer && item.netId === net.id)!;
    const refilled = filledCopperPolygons(fillCopperZone(board, zone.id)).get(zone.id)!;
    for (const copper of [saved.get(zone.id)!, refilled]) {
      for (const [x, y] of [
        [48, 48.05],
        [43.6, 49.2],
        [52.1, 49.2],
      ])
        assert.equal(contains(copper, x, y), true, `${layer} outside the keepout at ${x}, ${y}`);
      for (const [x, y] of [
        [48, 48.4],
        [43.95, 49.2],
        [51.75, 49.2],
      ])
        assert.equal(contains(copper, x, y), false, `${layer} inside the keepout at ${x}, ${y}`);
    }
  }
});

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

test('dynamic fills follow a moved foreign track, including pre-cleared candidates, and retain fine rules', () => {
  const board = fixture();
  board.zones[0].clearance = 0.1;
  const filled = fillCopperZones(board, 0.1);
  const before = structuredClone(filled);
  const moved = movePCBSelection(
    filled,
    { kind: 'track', id: filled.tracks[0].id },
    { x: 0, y: 3 },
  );
  const candidate = structuredClone(moved);
  for (const next of [moved, invalidatePCBFill(filled, moved)]) {
    const refreshed = refreshPCBFill(filled, next);
    const copper = filledCopperPolygons(refreshed).get(filled.zones[0].id)!;
    assert.ok(contains(copper, 15, 10), 'The old route channel becomes copper again.');
    assert.ok(!contains(copper, 15, 13), 'The new route has its own clearance channel.');
    assert.equal(refreshed.zones[0].clearance, 0.1);
    assert.deepEqual(
      refreshed.zones[0].filledPolygons,
      fillCopperZones(next, 0.0001).zones[0].filledPolygons,
    );
  }
  assert.deepEqual(filled, before);
  assert.deepEqual(moved, candidate);
});

test('LM2596 dynamic fill resolves native inherited clearance without flooding foreign copper', () => {
  const board = createReferenceExample('reference-lm2596-to220-5-buck').pcb!;
  const before = structuredClone(board);
  assert.ok(board.zones.some((zone) => zone.clearance === 0 && zone.filledPolygons !== undefined));
  const track = board.tracks.find(
    (item) =>
      item.start.x === 32 && item.start.y === 45.5 && item.end.x === 38.3 && item.end.y === 45.5,
  )!;
  assert.notEqual(track.netId, board.zones[0].netId);
  const moved = movePCBSelection(board, { kind: 'track', id: track.id }, { x: 0, y: 0.25 });
  const refreshed = refreshPCBFill(board, moved);
  const active = refreshed.zones.filter((zone) => zone.filledPolygons !== undefined);
  assert.equal(active.length, 2);
  assert.ok(active.every((zone) => zone.clearance === 0.25 && zone.filledPolygons!.length > 0));
  const report = runPCBDesignRules(refreshed);
  assert.equal(report.truncated, false);
  assert.deepEqual(
    report.issues.filter((issue) => ['pcb.short', 'pcb.clearance'].includes(issue.ruleId)),
    [],
  );
  assert.deepEqual(board, before, 'Imported native contours and inherited rules remain unchanged.');
});

test('dynamic fills use edited zone bounds, board edges and copper-pour keepouts', () => {
  const filled = fillCopperZones(fixture());
  const keepout: BoardZone = {
    ...filled.zones[0],
    id: uid(),
    netId: null,
    outline: rectangle(18, 4, 4, 3),
    clearance: 0,
    fillEnabled: false,
    keepout: { tracks: false, vias: false, pads: false, copperpour: true, footprints: false },
  };
  delete keepout.filledPolygons;
  const next = {
    ...filled,
    zones: [{ ...filled.zones[0], outline: rectangle(2, 2, 24, 15) }, keepout],
  };
  const copper = filledCopperPolygons(refreshPCBFill(filled, next)).get(filled.zones[0].id)!;
  assert.ok(!contains(copper, 1, 8), 'The previous zone extent disappears.');
  assert.ok(contains(copper, 15, 15));
  assert.ok(!contains(copper, 20, 5), 'Disabled rule areas still remove copper.');
  const resized = {
    ...filled,
    graphics: filled.graphics.map((graphic) => ({
      ...graphic,
      start: { ...graphic.start, x: graphic.start.x / 2 },
      end: { ...graphic.end, x: graphic.end.x / 2 },
    })),
  };
  const resizedCopper = filledCopperPolygons(refreshPCBFill(filled, resized)).get(
    filled.zones[0].id,
  )!;
  assert.ok(!contains(resizedCopper, 20, 15), 'Board outline changes clip the accepted fill.');
  assert.ok(contains(resizedCopper, 12, 15));
});

test('dynamic updates preserve unfinished zones while respecting their priority and refresh completed empty fills', () => {
  const filled = fillCopperZones(fixture());
  const unfinished: BoardZone = {
    ...filled.zones[0],
    id: uid(),
    netId: null,
    priority: 10,
    outline: rectangle(18, 4, 4, 3),
  };
  delete unfinished.filledPolygons;
  const next = { ...filled, zones: [...filled.zones, unfinished] };
  const refreshed = refreshPCBFill(filled, next);
  assert.equal(refreshed.zones[1].filledPolygons, undefined);
  assert.equal(refreshed.zones[1], unfinished);
  const copper = filledCopperPolygons(refreshed).get(filled.zones[0].id)!;
  assert.ok(
    !contains(copper, 20, 5),
    'Higher-priority unfinished zones remain calculation inputs.',
  );
  const outside = {
    ...fixture(),
    zones: [{ ...filled.zones[0], outline: rectangle(40, 40, 2, 2) }],
  };
  const empty = fillCopperZones(outside);
  assert.deepEqual(empty.zones[0].filledPolygons, []);
  const inside = { ...empty, zones: [{ ...empty.zones[0], outline: rectangle(2, 2, 4, 4) }] };
  assert.ok(refreshPCBFill(empty, inside).zones[0].filledPolygons!.length);
});

test('dynamic fills refresh embedded zones in their owner coordinates and retain newly filled zones', () => {
  const board = fixture();
  board.footprints = [
    {
      id: uid(),
      symbolId: null,
      libraryId: 'Test:DynamicZones',
      x: 10,
      y: 10,
      rotation: 90,
      side: 'back',
      pads: [],
      graphics: [],
      zones: [{ ...board.zones[0], id: uid(), layer: 'B.Cu', outline: rectangle(-3, -3, 6, 6) }],
    },
  ];
  const filled = fillCopperZones(board);
  const moved = {
    ...filled,
    footprints: filled.footprints.map((footprint) => ({ ...footprint, x: footprint.x + 2 })),
  };
  const refreshed = refreshPCBFill(filled, invalidatePCBFill(filled, moved));
  assert.deepEqual(
    refreshed.footprints[0].zones,
    fillCopperZones(moved, 0.0001).footprints[0].zones,
  );
  assert.ok(refreshed.zones[0].filledPolygons!.length);
  const disabled: BoardZone = {
    ...filled.zones[0],
    id: uid(),
    layer: 'B.Cu',
    fillEnabled: false,
    outline: rectangle(18, 3, 5, 5),
  };
  delete disabled.filledPolygons;
  const beforeFill = { ...filled, zones: [...filled.zones, disabled] };
  const selectedFill = fillCopperZone(beforeFill, disabled.id);
  assert.equal(selectedFill.zones[0].filledPolygons, undefined);
  const allActive = refreshPCBFill(beforeFill, selectedFill);
  assert.ok(allActive.zones.every((zone) => zone.filledPolygons!.length));
  assert.ok(allActive.footprints[0].zones![0].filledPolygons!.length);
});

test('dynamic fill no-ops preserve native contours and disabled outlines; failed updates retain every input', () => {
  const filled = fillCopperZones(fixture());
  const contourOnly = { ...filled, zones: [{ ...filled.zones[0], filledPolygons: [] }] };
  for (const next of [
    filled,
    { ...filled, thickness: 2 },
    { ...filled, tracks: filled.tracks.map((track) => ({ ...track, locked: true as const })) },
    contourOnly,
    { ...contourOnly, id: uid() },
    invalidatePCBFill(filled, { ...filled, zones: [] }),
  ])
    assert.equal(refreshPCBFill(filled, next), next);
  const disabled = {
    ...filled,
    zones: filled.zones.map((zone) => ({ ...zone, fillEnabled: false })),
  };
  assert.equal(refreshPCBFill(filled, disabled).zones[0].filledPolygons, undefined);
  const unassigned = {
    ...filled,
    zones: filled.zones.map((zone) => ({ ...zone, netId: null })),
  };
  const before = structuredClone({ filled, unassigned });
  assert.throws(() => refreshPCBFill(filled, unassigned), /Assign a net/);
  assert.deepEqual({ filled, unassigned }, before);
  const fillFree = invalidatePCBFill(filled, {
    ...filled,
    tracks: filled.tracks.map((track) => ({ ...track, end: { x: 24, y: 10 } })),
  });
  assert.equal(
    refreshPCBFill(fillFree, { ...fillFree, thickness: 2 }).zones[0].filledPolygons,
    undefined,
  );
});

test('owned dynamic fill previews reuse exact refreshed results while mutable inputs remain retryable', () => {
  const basis = ownProjectData(fillCopperZones(fixture()));
  const next = {
    ...basis,
    tracks: basis.tracks.map((track) => ({
      ...track,
      start: { ...track.start, y: 12 },
      end: { ...track.end, y: 12 },
    })),
  };
  const refreshed = refreshPCBFill(basis, next);
  assert.equal(isOwnedPCB(refreshed), true);
  assert.equal(refreshPCBFill(basis, refreshed), refreshed);
  const mutable = structuredClone(refreshed);
  mutable.tracks[0].start.y = mutable.tracks[0].end.y = 14;
  const retried = refreshPCBFill(basis, mutable);
  assert.notDeepEqual(retried.zones[0].filledPolygons, refreshed.zones[0].filledPolygons);
  const copper = filledCopperPolygons(retried).get(basis.zones[0].id)!;
  assert.ok(!contains(copper, 15, 14));
  assert.ok(contains(copper, 15, 12));
});

test('owned track-only updates retain opposite-layer native pours after candidate invalidation', () => {
  const board = fixture();
  board.zones.push({ ...board.zones[0], id: uid(), layer: 'B.Cu' });
  const filled = fillCopperZones(board);
  // An imported layer may retain inherited rules and different saved contours.
  filled.zones[1].clearance = 0;
  const basis = ownProjectData(filled);
  const moved = movePCBSelection(basis, { kind: 'track', id: basis.tracks[0].id }, { x: 0, y: 3 });
  const candidate = ownProjectData(invalidatePCBFill(basis, moved), basis);
  assert.equal(candidate.zones[1].filledPolygons, undefined);
  const refreshed = refreshPCBFill(basis, candidate);
  assert.equal(refreshed.zones[1], basis.zones[1]);
  assert.equal(refreshed.zones[1].filledPolygons, basis.zones[1].filledPolygons);
  assert.equal(refreshed.zones[1].clearance, 0);
  assert.notDeepEqual(refreshed.zones[0].filledPolygons, basis.zones[0].filledPolygons);
  assert.equal(refreshPCBFill(basis, refreshed), refreshed);
  const explicit = ownProjectData(
    {
      ...candidate,
      zones: [candidate.zones[0], { ...basis.zones[1], filledPolygons: [] }],
    },
    basis,
  );
  const explicitResult = refreshPCBFill(basis, explicit);
  assert.equal(explicitResult.zones[1].filledPolygons, explicit.zones[1].filledPolygons);
  assert.deepEqual(explicitResult.zones[1].filledPolygons, []);
  const mutable = structuredClone(candidate);
  const fullyCalculated = refreshPCBFill(basis, mutable);
  assert.equal(
    fullyCalculated.zones[1].clearance,
    0.25,
    'Mutable candidates take the complete fill path.',
  );
});

test('owned layer transfers refresh both layers and retain complete-board fill bounds', () => {
  const board = fixture();
  board.zones.push({ ...board.zones[0], id: uid(), layer: 'B.Cu' });
  const basis = ownProjectData(fillCopperZones(board));
  const candidate = ownProjectData(
    {
      ...basis,
      tracks: basis.tracks.map((track) => ({ ...track, layer: 'B.Cu' as const })),
    },
    basis,
  );
  const refreshed = refreshPCBFill(basis, candidate);
  for (const layer of ['F.Cu', 'B.Cu']) {
    const zone = refreshed.zones.find((item) => item.layer === layer)!;
    const copper = filledCopperPolygons(refreshed).get(zone.id)!;
    assert.equal(contains(copper, 15, 10), layer === 'F.Cu');
  }
  const excessive = ownProjectData({
    ...basis,
    zones: Array.from({ length: 65 }, (_, index) => ({
      ...basis.zones[0],
      id: uid(),
      layer: (index ? 'B.Cu' : 'F.Cu') as 'F.Cu' | 'B.Cu',
    })),
  });
  const moved = ownProjectData(
    {
      ...excessive,
      tracks: excessive.tracks.map((track) => ({ ...track, width: track.width + 0.1 })),
    },
    excessive,
  );
  assert.throws(() => refreshPCBFill(excessive, moved), /geometry limit/);
});

test('adding or editing disabled zone outlines retains existing copper on either layer, including overlapping regions', () => {
  const filled = fillCopperZones(fixture());
  const original = structuredClone(filled);
  for (const layer of ['F.Cu', 'B.Cu'] as const) {
    for (const outline of [rectangle(2, 2, 20, 12), rectangle(40, 30, 5, 5)]) {
      const zone: BoardZone = {
        ...filled.zones[0],
        id: uid(),
        layer,
        outline,
        netId: null,
        fillEnabled: false,
      };
      delete zone.filledPolygons;
      const added = { ...filled, zones: [...filled.zones, zone] };
      assert.equal(invalidatePCBFill(filled, added), added);
      assert.equal(added.zones[0], filled.zones[0]);
      assert.equal(added.zones[0].filledPolygons, filled.zones[0].filledPolygons);
      const assigned = {
        ...added,
        zones: [
          filled.zones[0],
          { ...zone, netId: filled.nets[1].id, clearance: 0.6, outline: rectangle(1, 1, 25, 16) },
        ],
      };
      assert.equal(invalidatePCBFill(added, assigned), assigned);
      assert.equal(
        invalidatePCBFill(assigned, filled),
        filled,
        'Removing an inactive outline retains copper too.',
      );
      const enabled = {
        ...assigned,
        zones: assigned.zones.map((item) =>
          item.id === zone.id ? { ...item, fillEnabled: true } : item,
        ),
      };
      assert.equal(
        invalidatePCBFill(assigned, enabled).zones[0].filledPolygons,
        undefined,
        'Enabling a pour still checks existing copper.',
      );
      const keepout = {
        ...added,
        zones: [
          filled.zones[0],
          {
            ...zone,
            keepout: {
              tracks: false,
              vias: false,
              pads: false,
              copperpour: true,
              footprints: false,
            },
          },
        ],
      };
      assert.equal(
        invalidatePCBFill(added, keepout).zones[0].filledPolygons,
        undefined,
        'A disabled fill flag cannot hide a copper keepout.',
      );
    }
  }
  assert.deepEqual(filled, original);
});

test('disabled embedded zone outlines retain saved board and package copper', () => {
  const board = fixture();
  board.footprints = [
    {
      id: uid(),
      symbolId: null,
      libraryId: 'Test:Zones',
      x: 10,
      y: 10,
      rotation: 0,
      side: 'back',
      pads: [],
      graphics: [],
      zones: [{ ...board.zones[0], id: uid(), layer: 'B.Cu', outline: rectangle(-3, -3, 6, 6) }],
    },
  ];
  const filled = fillCopperZones(board);
  const embedded: BoardZone = {
    ...board.zones[0],
    id: uid(),
    netId: null,
    fillEnabled: false,
    outline: rectangle(-1, -1, 2, 2),
  };
  const next = {
    ...filled,
    footprints: filled.footprints.map((footprint) => ({
      ...footprint,
      zones: [...footprint.zones!, embedded],
    })),
  };
  assert.equal(invalidatePCBFill(filled, next), next);
  assert.equal(next.zones[0].filledPolygons, filled.zones[0].filledPolygons);
  assert.equal(
    next.footprints[0].zones![0].filledPolygons,
    filled.footprints[0].zones![0].filledPolygons,
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
