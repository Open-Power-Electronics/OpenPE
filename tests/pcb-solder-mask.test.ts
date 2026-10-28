import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEmptyPCB } from '../lib/pcb-layout';
import type { Footprint, Pad } from '../lib/pcb';
import { padHasMaskOpening, solderMaskOpenings } from '../lib/pcb-solder-mask';
import { intersectPolygons, type Polygon } from '../lib/pcb-polygons';
import { parseProject, serializeProject } from '../lib/project';
import manifest from '../resources/example-catalog/manifest.json';

const pad: Pad = {
  id: 'pad',
  number: '1',
  x: 2,
  y: 0,
  rotation: 0,
  size: { x: 4, y: 2 },
  shape: 'rect',
  type: 'smd',
  netId: null,
};
const footprint: Footprint = {
  id: 'footprint',
  libraryId: 'Test:Mask',
  symbolId: null,
  x: 10,
  y: 10,
  rotation: 90,
  side: 'front',
  pads: [pad],
  graphics: [],
};
function bounds(polygons: Polygon[]) {
  const points = polygons.flatMap((polygon) => polygon.outer);
  return [
    Math.min(...points.map((p) => p.x)),
    Math.min(...points.map((p) => p.y)),
    Math.max(...points.map((p) => p.x)),
    Math.max(...points.map((p) => p.y)),
  ];
}
function covers(polygons: Polygon[], x: number, y: number) {
  return (
    intersectPolygons(polygons, [
      {
        outer: [
          { x: x - 0.001, y: y - 0.001 },
          { x: x + 0.001, y: y - 0.001 },
          { x: x + 0.001, y: y + 0.001 },
          { x: x - 0.001, y: y + 0.001 },
        ],
        holes: [],
      },
    ]).length > 0
  );
}

test('mask apertures follow explicit side layers and default pad participation', () => {
  assert.equal(padHasMaskOpening(footprint, pad, 'front'), true);
  assert.equal(padHasMaskOpening(footprint, pad, 'back'), false);
  assert.equal(padHasMaskOpening({ ...footprint, side: 'back' }, pad, 'back'), true);
  for (const side of ['front', 'back'] as const) {
    assert.equal(padHasMaskOpening(footprint, { ...pad, type: 'thru_hole' }, side), true);
    assert.equal(padHasMaskOpening(footprint, { ...pad, layers: ['*.Cu', '*.Mask'] }, side), true);
    assert.equal(padHasMaskOpening(footprint, { ...pad, layers: ['F.Cu'] }, side), false);
  }
  assert.equal(padHasMaskOpening(footprint, { ...pad, layers: ['B.Cu', 'B.Mask'] }, 'back'), true);
});

test('positive and negative mask margins offset the rotated pad outline without changing pad geometry', () => {
  const board = createEmptyPCB();
  board.footprints = [structuredClone(footprint)];
  const before = structuredClone(board);
  assert.deepEqual(bounds(solderMaskOpenings(board, 'front').openings), [9, 6, 11, 10]);
  assert.deepEqual(board, before);
  board.footprints[0].pads[0].solderMaskMargin = 0.2;
  assert.deepEqual(bounds(solderMaskOpenings(board, 'front').openings), [8.8, 5.8, 11.2, 10.2]);
  board.footprints[0].pads[0].solderMaskMargin = -0.3;
  assert.deepEqual(bounds(solderMaskOpenings(board, 'front').openings), [9.3, 6.3, 10.7, 9.7]);
  board.footprints[0].pads[0].solderMaskMargin = -2;
  assert.deepEqual(solderMaskOpenings(board, 'front').openings, []);
});

test('mask artwork opens copper with its own fill, stroke and footprint transform; vias retain visible annuli', () => {
  const board = createEmptyPCB();
  board.footprints = [
    {
      ...structuredClone(footprint),
      pads: [],
      graphics: [
        {
          id: 'mask-circle',
          kind: 'circle',
          layer: 'F.Mask',
          width: 0.1,
          fill: true,
          start: { x: 2, y: 0 },
          end: { x: 3, y: 0 },
        },
      ],
    },
  ];
  board.graphics = [
    { id: 'mask-line', layer: 'B.Mask', width: 0.4, start: { x: 2, y: 2 }, end: { x: 4, y: 2 } },
  ];
  board.vias = [{ id: 'via', netId: 'net', x: 15, y: 15, diameter: 1, drill: 0.4 }];
  const before = structuredClone(board);
  const front = solderMaskOpenings(board, 'front'),
    back = solderMaskOpenings(board, 'back');
  assert.ok(covers(front.openings, 10, 8));
  assert.ok(!covers(back.openings, 10, 8));
  assert.ok(covers(back.openings, 3, 2.1));
  assert.ok(!covers(front.openings, 3, 2.1));
  for (const mask of [front, back]) {
    assert.ok(covers(mask.openings, 15.4, 15));
    assert.ok(!covers(mask.openings, 15.6, 15));
    assert.equal(mask.omittedText, false);
  }
  assert.deepEqual(board, before);
});

test('unsupported mask text stays in the project and produces a preview notice', () => {
  const board = createEmptyPCB();
  board.graphics = [
    {
      id: 'mask-text',
      kind: 'text',
      layer: 'F.Mask',
      width: 0.1,
      start: { x: 0, y: 0 },
      end: { x: 0, y: 0 },
      text: { value: 'OPEN', size: { x: 1, y: 1 }, rotation: 0, thickness: 0.1 },
    },
  ];
  const before = structuredClone(board);
  assert.equal(solderMaskOpenings(board, 'front').omittedText, true);
  assert.equal(solderMaskOpenings(board, 'back').omittedText, false);
  assert.deepEqual(board, before);
});

test('mask previews preserve all nine curated projects and their source copper bytes', () => {
  for (const entry of manifest.examples) {
    const source = readFileSync(`tests/fixtures/reference/${entry.file}.json`, 'utf8');
    const project = parseProject(source);
    for (const side of ['front', 'back'] as const) {
      const { openings } = solderMaskOpenings(project.pcb!, side);
      assert.ok(openings.length > 0);
      assert.ok(
        openings.every((p) => p.outer.every((v) => Number.isFinite(v.x) && Number.isFinite(v.y))),
      );
    }
    assert.equal(serializeProject(project), source);
  }
});
