import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ProjectCore } from '../core/project-core';
import { uid } from '../lib/circuit';
import { createEmptyPCB, padPosition } from '../lib/pcb-layout';
import type { Footprint, PCB } from '../lib/pcb';
import { analyzePCBConnectivity, padCopperLayers } from '../lib/pcb-connectivity';
import { defaultPCBDisplay, pcbDisplayBounds } from '../lib/pcb-display';
import { pcbSilkscreen } from '../lib/pcb-silkscreen';
import { modelMeshGroup, disposeModelGroup } from '../lib/model-mesh';
import { Mesh } from 'three';
import { copperFillContour } from '../lib/pcb-polygons';
import { invalidatePCBFill } from '../lib/pcb';
import { parseProject } from '../lib/project';
import { ownProjectData } from '../lib/immutable-project';

function fixture(count = 3): PCB {
  const board = createEmptyPCB();
  const netId = uid();
  board.nets = [{ id: netId, name: 'OUT' }];
  board.footprints = Array.from({ length: count }, (_, i): Footprint => ({
    id: uid(),
    symbolId: null,
    reference: `J${i + 1}`,
    value: '',
    libraryId: 'Test:Pad',
    x: i * 10,
    y: 0,
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
        type: 'smd',
        shape: 'rect',
        size: { x: 2, y: 2 },
        netId,
      },
    ],
  }));
  return board;
}
const track = (
  b: PCB,
  start: { x: number; y: number },
  end: { x: number; y: number },
  layer: PCB['tracks'][number]['layer'] = 'F.Cu',
) => ({ id: uid(), start, end, layer, width: 0.4, netId: b.nets[0].id });
test('airwires join disconnected copper groups instead of every assigned pad', () => {
  const board = fixture(),
    before = structuredClone(board);
  assert.equal(analyzePCBConnectivity(board).edges.length, 2);
  board.tracks.push(track(board, { x: 0, y: 0 }, { x: 10, y: 0 }));
  const edge = analyzePCBConnectivity(board).edges[0];
  assert.deepEqual([edge.start.x, edge.end.x], [10, 20]);
  board.tracks.push(track(board, { x: 10, y: 0 }, { x: 20, y: 0 }));
  assert.equal(analyzePCBConnectivity(board).edges.length, 0);
  assert.deepEqual(board.footprints, before.footprints);
});
test('layer crossings stay disconnected until a through via or plated pad joins them', () => {
  const board = fixture(2);
  board.footprints[1].side = 'back';
  board.tracks = [
    track(board, { x: 0, y: 0 }, { x: 5, y: 0 }),
    track(board, { x: 5, y: 0 }, { x: 10, y: 0 }, 'B.Cu'),
  ];
  assert.equal(analyzePCBConnectivity(board).edges.length, 1);
  board.vias = [{ id: uid(), x: 5, y: 0, diameter: 0.8, drill: 0.4, netId: board.nets[0].id }];
  assert.equal(analyzePCBConnectivity(board).edges.length, 0);
  const pad = board.footprints[0].pads[0];
  assert.deepEqual(padCopperLayers(board, board.footprints[0], pad), ['F.Cu']);
  pad.layers = ['F.Mask'];
  assert.deepEqual(padCopperLayers(board, board.footprints[0], pad), []);
});

test('retained pad contours keep current geometry, layers and independent public airwire anchors', () => {
  const original = fixture(2);
  original.tracks = [track(original, { x: 0, y: 0 }, { x: 10, y: 0 })];
  const board = ownProjectData(original);
  assert.equal(analyzePCBConnectivity(board).edges.length, 0);
  const isolated = ownProjectData({ ...board, tracks: [] }, board);
  const result = analyzePCBConnectivity(isolated);
  assert.equal(result.edges.length, 1);
  result.edges[0].start.x = 999;
  result.edges[0].end.y = -999;
  assert.deepEqual(
    analyzePCBConnectivity(isolated),
    analyzePCBConnectivity(structuredClone(isolated)),
  );

  const moved = ownProjectData(
    {
      ...board,
      footprints: board.footprints.map((footprint, index) =>
        index ? { ...footprint, x: 20 } : footprint,
      ),
    },
    board,
  );
  assert.equal(analyzePCBConnectivity(moved).edges.length, 1);
  const back = ownProjectData(
    {
      ...board,
      footprints: board.footprints.map((footprint, index) =>
        index ? { ...footprint, side: 'back' as const } : footprint,
      ),
    },
    board,
  );
  assert.equal(analyzePCBConnectivity(back).edges.length, 1);

  const mutable = structuredClone(original);
  Object.freeze(mutable.footprints[1]);
  assert.equal(analyzePCBConnectivity(mutable).edges.length, 0);
  mutable.footprints[1].pads[0].x = 10;
  assert.equal(analyzePCBConnectivity(mutable).edges.length, 1, 'Caller freezing grants no reuse.');
});
test('retained pad boundary trees match fresh analysis through holes, crossings, layers and edits', () => {
  const data = fixture(3);
  for (const f of data.footprints) {
    const pad = f.pads[0];
    pad.type = 'thru_hole';
    pad.shape = 'circle';
    pad.size = { x: 4, y: 4 };
    pad.drill = 2;
    pad.drillOffset = { x: 0.25, y: 0 };
  }
  data.footprints[1].rotation = 45;
  const board = ownProjectData(data);
  for (const y of [0, 1, 2, 0.5, 2.200000001, 2.201, -1, 0])
    for (const layer of ['F.Cu', 'B.Cu', 'In1.Cu'] as const) {
      const next = ownProjectData({
        ...board,
        layers: ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'] as PCB['layers'],
        tracks: [
          track(board, { x: -3, y }, { x: 23, y }, layer),
          track(board, { x: 0.25, y: 0 }, { x: 0.35, y: 0 }, layer),
        ],
      });
      const expected = analyzePCBConnectivity(structuredClone(next));
      if (y === 0)
        assert.equal(expected.edges.length, 0, 'Outside endpoints still cross each annulus.');
      if (y === 2.201)
        assert.equal(expected.edges.length, 2, 'Distant endpoints create no pad contact.');
      const actual = analyzePCBConnectivity(next);
      assert.deepEqual(actual, expected, `Fresh contacts at ${y} on ${layer}.`);
      if (actual.edges.length) actual.edges[0].start.x = 1000;
      actual.warnings.push('escaped result');
      assert.deepEqual(analyzePCBConnectivity(next), expected);
    }
  const mutable = structuredClone(board);
  Object.freeze(mutable.footprints[0]);
  mutable.tracks = [track(mutable, { x: -3, y: 1 }, { x: 23, y: 1 })];
  analyzePCBConnectivity(mutable);
  mutable.footprints[0].pads[0].size = { x: 6, y: 6 };
  mutable.footprints[0].pads[0].drillOffset = { x: -0.25, y: 0.5 };
  assert.deepEqual(
    analyzePCBConnectivity(mutable),
    analyzePCBConnectivity(structuredClone(mutable)),
  );
  const edited = ownProjectData(mutable);
  assert.deepEqual(analyzePCBConnectivity(edited), analyzePCBConnectivity(structuredClone(edited)));
});

test('retained pad trees charge their original build work and keep aggregate failures retryable', () => {
  const data = fixture(800);
  data.footprints.forEach((f, index) => {
    f.x = index * 110;
    const pad = f.pads[0];
    pad.type = 'thru_hole';
    pad.shape = 'circle';
    pad.size = { x: 100, y: 100 };
    pad.drill = 50;
  });
  data.tracks = data.footprints.map((f) =>
    track(data, { x: f.x, y: f.y }, { x: f.x + 0.1, y: f.y }),
  );
  const board = ownProjectData(data);
  // Each short span lies wholly within a real drill hole. Its exact boundary
  // check prepares that pad's tree, without connecting it to copper.
  for (let index = 0; index < board.footprints.length; index++) {
    const single = ownProjectData({
      ...board,
      footprints: [board.footprints[index]],
      tracks: [board.tracks[index]],
    });
    assert.deepEqual(analyzePCBConnectivity(single), { edges: [], padCount: 1, warnings: [] });
  }
  const limit = /Airwire preview exceeds the geometry limit/;
  assert.throws(() => analyzePCBConnectivity(structuredClone(board)), limit);
  assert.throws(
    () => analyzePCBConnectivity(board),
    limit,
    'Warm trees retain their logical cost.',
  );
  assert.throws(() => analyzePCBConnectivity(board), limit, 'A failed analysis remains retryable.');
  const reduced = ownProjectData({
    ...board,
    footprints: board.footprints.slice(0, 2),
    tracks: board.tracks.slice(0, 2),
  });
  assert.deepEqual(
    analyzePCBConnectivity(reduced),
    analyzePCBConnectivity(structuredClone(reduced)),
  );
});

test('rounded pads, rotation and disconnected zones preserve geometric connectivity semantics', () => {
  const board = fixture(2),
    f = board.footprints[0];
  f.rotation = 90;
  f.pads[0].shape = 'roundrect';
  f.pads[0].roundrectRatio = 0.25;
  board.tracks = [track(board, { x: 0.9, y: 0 }, { x: 10, y: 0 })];
  assert.equal(
    analyzePCBConnectivity(board).edges.length,
    0,
    'Tracks touching pad edges connect without reaching the center.',
  );
  board.tracks = [];
  board.zones = [
    {
      id: uid(),
      netId: board.nets[0].id,
      layer: 'F.Cu',
      outline: [
        { x: -2, y: -2 },
        { x: 12, y: -2 },
        { x: 12, y: 2 },
        { x: -2, y: 2 },
      ],
      clearance: 0.25,
      minThickness: 0.2,
      thermalGap: 0.3,
      thermalBridge: 0.3,
    },
  ];
  assert.equal(
    analyzePCBConnectivity(board).edges.length,
    1,
    'Unfilled zones and generated display pours cannot establish verified connections.',
  );
  assert.equal(analyzePCBConnectivity(board).warnings.length, 1);
});
test('only saved, same-layer fill contours connect pads; holes, islands and invalidation stay disconnected', () => {
  const board = fixture(3);
  const rectangle = (x1: number, y1: number, x2: number, y2: number) => [
    { x: x1, y: y1 },
    { x: x2, y: y1 },
    { x: x2, y: y2 },
    { x: x1, y: y2 },
  ];
  const zone = {
    id: uid(),
    netId: board.nets[0].id,
    layer: 'F.Cu' as const,
    outline: rectangle(-5, -5, 25, 5),
    clearance: 0.25,
    minThickness: 0.2,
    thermalGap: 0.3,
    thermalBridge: 0.3,
    filledPolygons: [{ points: rectangle(-2, -2, 12, 2) }],
  };
  board.zones = [zone];
  assert.equal(
    analyzePCBConnectivity(board).edges.length,
    1,
    'Saved fill connects the first two pads.',
  );
  assert.equal(analyzePCBConnectivity(board).warnings.length, 0);
  zone.filledPolygons = [{ points: rectangle(-2, -2, 2, 2) }, { points: rectangle(8, -2, 12, 2) }];
  assert.equal(analyzePCBConnectivity(board).edges.length, 2, 'Islands in one zone stay separate.');
  zone.filledPolygons = [
    {
      points: copperFillContour({
        outer: rectangle(-5, -5, 25, 5),
        holes: [rectangle(8, -2, 12, 2)],
      }),
    },
  ];
  assert.equal(
    analyzePCBConnectivity(board).edges.length,
    1,
    'A pad wholly in a hole stays disconnected.',
  );
  zone.filledPolygons = [{ points: rectangle(-5, -5, 25, 5) }];
  board.footprints[1].side = 'back';
  assert.equal(
    analyzePCBConnectivity(board).edges.length,
    1,
    'Front fill cannot reach a back SMD pad.',
  );
  board.footprints[1].pads[0].type = 'thru_hole';
  assert.equal(analyzePCBConnectivity(board).edges.length, 0, 'A plated pad reaches front copper.');
  const changed = invalidatePCBFill(board, {
    ...board,
    tracks: [track(board, { x: 50, y: 0 }, { x: 60, y: 0 })],
  });
  assert.equal(
    analyzePCBConnectivity(changed).edges.length,
    2,
    'Invalidated fills cannot hide airwires.',
  );
  assert.ok(board.zones[0].filledPolygons, 'Analysis never changes the saved fill.');
});
test('footprint-local fills use the actual package rotation and layer', () => {
  const board = fixture(2),
    f = board.footprints[0];
  f.x = 10;
  f.y = 10;
  f.rotation = 90;
  board.footprints[1].x = 10;
  board.footprints[1].y = 0;
  f.zones = [
    {
      id: uid(),
      netId: board.nets[0].id,
      layer: 'F.Cu',
      outline: [
        { x: -2, y: -2 },
        { x: 12, y: -2 },
        { x: 12, y: 2 },
        { x: -2, y: 2 },
      ],
      clearance: 0.25,
      minThickness: 0.2,
      thermalGap: 0.3,
      thermalBridge: 0.3,
    },
  ];
  f.zones[0].filledPolygons = [{ points: f.zones[0].outline }];
  assert.equal(analyzePCBConnectivity(board).edges.length, 0);
  f.zones[0].netId = uid();
  assert.equal(analyzePCBConnectivity(board).edges.length, 1);
});
test('saved fill holes separate nested copper and boundary crossings connect outside representatives', () => {
  const board = fixture(2);
  board.footprints[1].x = 4.5;
  const rectangle = (x1: number, y1: number, x2: number, y2: number) => [
    { x: x1, y: y1 },
    { x: x2, y: y1 },
    { x: x2, y: y2 },
    { x: x1, y: y2 },
  ];
  const zone = (points: { x: number; y: number }[]) => ({
    id: uid(),
    netId: board.nets[0].id,
    layer: 'F.Cu' as const,
    outline: points,
    clearance: 0.25,
    minThickness: 0.2,
    thermalGap: 0.3,
    thermalBridge: 0.3,
    filledPolygons: [{ points }],
  });
  board.zones = [
    zone(
      copperFillContour({
        outer: rectangle(-6, -6, 6, 6),
        holes: [rectangle(-3, -3, 3, 3)],
      }),
    ),
    zone(rectangle(-1, -1, 1, 1)),
  ];
  assert.equal(
    analyzePCBConnectivity(board).edges.length,
    1,
    "An island inside another fill's hole stays disconnected.",
  );
  board.zones[1] = zone(rectangle(-1, -1, 4.5, 1));
  assert.equal(
    analyzePCBConnectivity(board).edges.length,
    0,
    'Crossing a hole boundary connects fills even when both first vertices are outside copper.',
  );
  board.zones.pop();
  board.footprints[0].x = 2;
  assert.equal(
    analyzePCBConnectivity(board).edges.length,
    0,
    'Copper touching the boundary of a fill hole connects exactly.',
  );
  board.footprints[0].x = 1.9;
  assert.equal(
    analyzePCBConnectivity(board).edges.length,
    1,
    'A finite gap to the same hole boundary stays disconnected.',
  );
  board.footprints[0].x = 0;
  board.footprints[0].y = -4.5;
  board.footprints[1].x = 10;
  board.footprints[1].y = 4.5;
  board.tracks = [track(board, { x: -10, y: 4.5 }, { x: 10, y: 4.5 })];
  assert.equal(
    analyzePCBConnectivity(board).edges.length,
    0,
    'A track crossing fill connects with both endpoints outside the outer boundary.',
  );
  board.tracks[0].layer = 'B.Cu';
  board.footprints[1].side = 'back';
  assert.equal(
    analyzePCBConnectivity(board).edges.length,
    1,
    'The same geometric crossing on another layer cannot connect the front fill.',
  );
});
test('the complete EMC saved fills analyze within the bounded budget and expose an isolated pad', async () => {
  const project = parseProject(await readFile('lib/emc-flyback-example.json', 'utf8'));
  const core = new ProjectCore(project);
  const board = core.getSnapshot().project!.pcb!;
  const before = structuredClone(board);
  assert.equal(board.footprints.length, 90);
  assert.equal(board.tracks.length, 359);
  assert.deepEqual(analyzePCBConnectivity(board), { edges: [], padCount: 194, warnings: [] });
  assert.deepEqual(board, before, 'Saved fills and native metadata remain unchanged.');

  const changed = structuredClone(board);
  const resistor = project.schematic.parts.find((part) => part.ref === 'R1')!;
  const footprint = changed.footprints.find((item) => item.symbolId === resistor.id)!;
  const netId = changed.nets.find((net) => net.name === 'VBUS')!.id;
  const pad = footprint.pads.find((item) => item.netId === netId)!;
  pad.x += 1000;
  const position = padPosition(footprint, pad);
  const nearest = changed.footprints
    .flatMap((item) =>
      item.pads
        .filter((candidate) => candidate.netId === netId && candidate.id !== pad.id)
        .map((candidate) => ({ id: candidate.id, ...padPosition(item, candidate) })),
    )
    .sort(
      (a, b) =>
        Math.hypot(a.x - position.x, a.y - position.y) -
        Math.hypot(b.x - position.x, b.y - position.y),
    )[0];
  const changedBefore = structuredClone(changed);
  const result = analyzePCBConnectivity(changed);
  assert.equal(result.padCount, 194);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.edges.length, 1);
  assert.equal(result.edges[0].netId, netId);
  assert.deepEqual(
    new Set([result.edges[0].startPadId, result.edges[0].endPadId]),
    new Set([pad.id, nearest.id]),
    'The isolated VBUS pad joins the nearest pad in the otherwise connected net.',
  );
  assert.deepEqual(changed, changedBefore, 'Analysis also leaves mutable inputs unchanged.');
});
test('connectivity still fails closed when disconnected copper exceeds the work budget', () => {
  const board = fixture(2200);
  const before = structuredClone(board);
  assert.throws(() => analyzePCBConnectivity(board), /Airwire preview exceeds the geometry limit/);
  assert.deepEqual(board, before, 'Exhausting the budget never changes copper.');
});
test('board fit requires closed geometry while all-elements fit respects independent visibility', () => {
  const board = fixture(2),
    visible = defaultPCBDisplay();
  assert.throws(() => pcbDisplayBounds(board, 'board', visible), /closed board outline/);
  board.graphics = [
    {
      id: uid(),
      layer: 'Edge.Cuts',
      kind: 'polygon',
      start: { x: -2, y: -2 },
      end: { x: -2, y: 2 },
      points: [
        { x: 12, y: -2 },
        { x: 12, y: 2 },
      ],
      width: 0.1,
    },
    { id: uid(), layer: 'F.Fab', start: { x: 100, y: 100 }, end: { x: 110, y: 100 }, width: 0.1 },
  ];
  assert.deepEqual(pcbDisplayBounds(board, 'board', visible), {
    minX: -2,
    minY: -2,
    maxX: 12,
    maxY: 2,
  });
  assert.ok(pcbDisplayBounds(board, 'all', visible).maxX >= 110);
  visible['F.Fab'] = false;
  assert.ok(pcbDisplayBounds(board, 'all', visible).maxX < 100);
  assert.equal(visible['B.SilkS'], true);
  visible['B.Cu'] = false;
  assert.equal(visible['B.SilkS'], true);
});
test('3D silkscreen resolves reference content and complete world transforms without changing the board', () => {
  const board = fixture(1),
    f = board.footprints[0];
  f.reference = 'J42';
  f.x = 10;
  f.y = 20;
  f.rotation = 90;
  f.graphics = [
    {
      id: uid(),
      kind: 'text',
      layer: 'F.SilkS',
      width: 0,
      start: { x: 2, y: 0 },
      end: { x: 2, y: 0 },
      text: {
        value: '${REFERENCE}',
        property: 'Reference',
        rotation: 30,
        size: { x: 1, y: 1 },
        thickness: 0.15,
      },
    },
  ];
  const before = structuredClone(board),
    silk = pcbSilkscreen(board);
  assert.equal(silk[0].text!.value, 'J42');
  assert.equal(silk[0].text!.rotation, 120);
  assert.deepEqual(silk[0].start, { x: 10, y: 18 });
  assert.deepEqual(board, before);
});
test('uncoloured 3D meshes without per-face ranges receive a renderable material group', () => {
  const group = modelMeshGroup([
    {
      attributes: { position: { array: [0, 0, 0, 1, 0, 0, 0, 1, 0] } },
      index: { array: [0, 1, 2] },
    },
  ]);
  assert.deepEqual((group.children[0] as Mesh).geometry.groups, [
    { start: 0, count: 3, materialIndex: 0 },
  ]);
  disposeModelGroup(group);
});
