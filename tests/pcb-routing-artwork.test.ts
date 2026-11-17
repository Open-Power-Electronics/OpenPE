import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BoardLine, Footprint } from '../lib/pcb';
import { transformPCBGraphic } from '../lib/pcb-geometry';
import { createEmptyPCB, footprintPoint } from '../lib/pcb-layout';
import { pcbDimensionStrokes, preparePCBArtworkObstacles } from '../lib/pcb-routing-artwork';
import { ownProjectData } from '../lib/immutable-project';

const dimension = (): BoardLine => ({
  id: 'dimension',
  kind: 'dimension',
  layer: 'F.Cu',
  start: { x: 1, y: 2 },
  end: { x: 4, y: 6 },
  width: 0.2,
  dimension: {
    type: 'aligned',
    height: 5,
    format: { prefix: '', suffix: '', units: 0, unitsFormat: 0, precision: 0 },
    style: { arrowLength: 1, textPositionMode: 0, extensionOffset: 0 },
    caption: {
      x: 100,
      y: 100,
      value: 'A distant caption',
      rotation: 37,
      size: { x: 1, y: 1 },
      thickness: 0.1,
    },
  },
});
const spans = (graphics: BoardLine[]) => graphics.map(({ start, end }) => [start, end]);

test('artwork preparation retains only exact owned footprints with unchanged collision artwork', () => {
  const footprint: Footprint = {
    id: 'footprint',
    symbolId: null,
    libraryId: 'Test:Pad',
    reference: 'J1',
    value: '',
    x: 0,
    y: 0,
    rotation: 0,
    side: 'front',
    pads: [],
    graphics: [],
  };
  const mutable = { ...createEmptyPCB(), footprints: [footprint] };
  const prepared = preparePCBArtworkObstacles(mutable);
  assert.notEqual(prepared.footprints[0], footprint);
  prepared.footprints[0].x = 3;
  assert.equal(footprint.x, 0);
  const owned = ownProjectData(mutable);
  assert.equal(preparePCBArtworkObstacles(owned).footprints[0], owned.footprints[0]);
  const withCopper = ownProjectData(
    {
      ...owned,
      footprints: [{ ...owned.footprints[0], graphics: [dimension()] }],
    },
    owned,
  );
  const converted = preparePCBArtworkObstacles(withCopper);
  assert.notEqual(converted.footprints[0], withCopper.footprints[0]);
  assert.equal(converted.footprints[0].graphics[0].kind, undefined);
  assert.equal(withCopper.footprints[0].graphics[0].kind, 'dimension');
});

test('dimension strokes match the bounded drawn path without enclosing captions', () => {
  for (const type of ['aligned', 'radial', 'leader'] as const) {
    const graphic = dimension();
    graphic.dimension!.type = type;
    const before = structuredClone(graphic),
      strokes = pcbDimensionStrokes(graphic);
    assert.deepEqual(strokes, [
      { id: 'dimension', start: { x: 1, y: 2 }, end: { x: -3, y: 5 }, width: 0.2, layer: 'F.Cu' },
      { id: 'dimension', start: { x: -3, y: 5 }, end: { x: 0, y: 9 }, width: 0.2, layer: 'F.Cu' },
      { id: 'dimension', start: { x: 0, y: 9 }, end: { x: 4, y: 6 }, width: 0.2, layer: 'F.Cu' },
    ]);
    assert.deepEqual(graphic, before);
    strokes[0].start.x = 200;
    strokes[0].end.x = 200;
    assert.deepEqual(graphic, before, 'Returned stroke points cannot change the source.');
    assert.equal(strokes[1].start.x, -3, 'Stroke endpoints have independent point wrappers.');
    assert.deepEqual(
      pcbDimensionStrokes(graphic).map((g) => Object.keys(g)),
      [
        ['id', 'start', 'end', 'width', 'layer'],
        ['id', 'start', 'end', 'width', 'layer'],
        ['id', 'start', 'end', 'width', 'layer'],
      ],
    );
  }
});

test('dimension height signs, missing height and coincident anchors retain finite stroke geometry', () => {
  const graphic = dimension();
  graphic.dimension!.height = -5;
  assert.deepEqual(spans(pcbDimensionStrokes(graphic)), [
    [
      { x: 1, y: 2 },
      { x: 5, y: -1 },
    ],
    [
      { x: 5, y: -1 },
      { x: 8, y: 3 },
    ],
    [
      { x: 8, y: 3 },
      { x: 4, y: 6 },
    ],
  ]);
  for (const height of [0, undefined]) {
    graphic.dimension!.height = height;
    assert.deepEqual(spans(pcbDimensionStrokes(graphic)), [
      [graphic.start, graphic.start],
      [graphic.start, graphic.end],
      [graphic.end, graphic.end],
    ]);
  }
  graphic.start = { x: 4, y: -7 };
  graphic.end = { ...graphic.start };
  graphic.dimension!.height = 100;
  assert.deepEqual(
    spans(pcbDimensionStrokes(graphic)),
    Array.from({ length: 3 }, () => [graphic.start, graphic.end]),
  );
  assert.deepEqual(pcbDimensionStrokes({ ...graphic, dimension: undefined }), []);
  assert.deepEqual(pcbDimensionStrokes({ ...graphic, kind: undefined }), []);
});

test('artwork preparation shares dimension strokes while retaining its existing copper caption envelope', () => {
  const graphic = dimension(),
    technical = { ...dimension(), id: 'technical', layer: 'F.Fab' as const },
    edge = { ...dimension(), id: 'edge', layer: 'Edge.Cuts' as const },
    missing = { ...dimension(), id: 'missing', dimension: undefined },
    board = { ...createEmptyPCB(), graphics: [graphic, technical, edge, missing] },
    before = structuredClone(board),
    prepared = preparePCBArtworkObstacles(board);
  assert.deepEqual(prepared.graphics.slice(0, 3), pcbDimensionStrokes(graphic));
  assert.equal(
    prepared.graphics[3].kind,
    'circle',
    'Caption coverage retains the existing bounded envelope.',
  );
  assert.deepEqual(prepared.graphics[3].start, graphic.dimension!.caption);
  assert.deepEqual(prepared.graphics.slice(4), [technical, edge, missing]);
  assert.deepEqual(board, before);
  for (const caption of [
    { ...graphic.dimension!.caption, value: '' },
    { ...graphic.dimension!.caption, hidden: true },
  ]) {
    const next = { ...graphic, dimension: { ...graphic.dimension!, caption } };
    assert.deepEqual(
      preparePCBArtworkObstacles({ ...board, graphics: [next] }).graphics,
      pcbDimensionStrokes(next),
    );
  }
});

test('local back-side dimension strokes transform once with the native footprint pose', () => {
  const graphic = dimension();
  graphic.layer = 'B.Cu';
  graphic.start = { x: 1, y: -2 };
  graphic.end = { x: 5, y: -2 };
  graphic.dimension!.height = -3;
  graphic.dimension!.caption.hidden = true;
  const footprint: Footprint = {
      id: 'part',
      x: 10,
      y: 20,
      rotation: 90,
      side: 'back',
      libraryId: 'Test:Dimension',
      symbolId: null,
      pads: [],
      graphics: [graphic],
    },
    board = { ...createEmptyPCB(), footprints: [footprint] },
    before = structuredClone(board),
    prepared = preparePCBArtworkObstacles(board),
    world = prepared.footprints[0].graphics.map((g) =>
      transformPCBGraphic(g, (p) => footprintPoint(footprint, p)),
    );
  assert.deepEqual(spans(world), [
    [
      { x: 8, y: 19 },
      { x: 5, y: 19 },
    ],
    [
      { x: 5, y: 19 },
      { x: 5, y: 15 },
    ],
    [
      { x: 5, y: 15 },
      { x: 8, y: 15 },
    ],
  ]);
  assert.ok(
    world.every((g) => g.id === graphic.id && g.width === graphic.width && g.layer === 'B.Cu'),
  );
  assert.deepEqual(
    world,
    pcbDimensionStrokes(graphic).map((g) =>
      transformPCBGraphic(g, (p) => footprintPoint(footprint, p)),
    ),
  );
  assert.deepEqual(
    board,
    before,
    'Deriving and transforming obstacles never alters source footprint artwork.',
  );
});
