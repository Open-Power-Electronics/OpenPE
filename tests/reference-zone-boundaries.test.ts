import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import manifest from '../resources/example-catalog/manifest.json';
import { createEmptyPCB } from '../lib/pcb-layout';
import type { BoardZone, PCB } from '../lib/pcb';
import { parseProject } from '../lib/project';
import { boardPolygons } from '../lib/pcb-polygons';
import { insetReferenceZoneBoundaries } from '../scripts/reference-zone-boundaries';

const rectangle = (minX: number, minY: number, maxX: number, maxY: number) => [
  { x: minX, y: minY },
  { x: maxX, y: minY },
  { x: maxX, y: maxY },
  { x: minX, y: maxY },
];
function zone(id = 'front', layer: BoardZone['layer'] = 'F.Cu'): BoardZone {
  return {
    id,
    layer,
    netId: 'gnd',
    outline: rectangle(0, 0, 20, 16),
    holes: [rectangle(5, 5, 7, 7)],
    filledPolygons: [{ points: rectangle(0.5005, 0.5005, 19.4995, 15.4995) }],
    clearance: 0.25,
    minThickness: 0.25,
    thermalGap: 0.25,
    thermalBridge: 0.4,
    priority: 2,
    islandRemovalMode: 0,
  };
}
function board(): PCB {
  const pcb = createEmptyPCB();
  const [start, ...corners] = rectangle(0, 0, 20, 16);
  pcb.graphics = [
    {
      id: 'board',
      kind: 'polygon',
      layer: 'Edge.Cuts',
      width: 0.05,
      start,
      points: corners.slice(0, -1),
      end: corners.at(-1)!,
    },
  ];
  pcb.zones = [zone(), zone('back', 'B.Cu')];
  return pcb;
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test('board-edge zone boundaries inset while retaining saved copper, cutouts and every unrelated record', () => {
  const pcb = freeze(board());
  const before = structuredClone(pcb);
  const result = insetReferenceZoneBoundaries(pcb);
  assert.equal(result.changes.length, 2);
  assert.deepEqual(pcb, before);
  for (const key of ['footprints', 'tracks', 'vias', 'graphics', 'nets', 'layers'] as const)
    assert.equal(result.board[key], pcb[key]);
  for (let index = 0; index < pcb.zones.length; index++) {
    const original = pcb.zones[index];
    const changed = result.board.zones[index];
    assert.deepEqual(changed.outline, rectangle(0.5, 0.5, 19.5, 15.5));
    assert.equal(changed.holes, original.holes);
    assert.equal(changed.filledPolygons, original.filledPolygons);
    assert.deepEqual({ ...changed, outline: original.outline }, original);
    result.changes[index].before[0].x = 100;
    result.changes[index].after[0].x = 100;
    assert.equal(original.outline[0].x, 0);
    assert.equal(changed.outline[0].x, 0.5);
  }
  const again = insetReferenceZoneBoundaries(result.board);
  assert.equal(again.board, result.board);
  assert.deepEqual(again.changes, []);
});

test('local zones, keepouts and noncopper rules retain their exact objects', () => {
  const pcb = board();
  const local = {
    ...zone('local'),
    outline: rectangle(2, 2, 4, 4),
    holes: [],
    filledPolygons: undefined,
  };
  const keepout = {
    ...zone('keepout'),
    keepout: { tracks: false, vias: false, pads: false, copperpour: true, footprints: false },
    filledPolygons: undefined,
  };
  const technical = { ...zone('technical'), layer: 'F.SilkS' as const, filledPolygons: undefined };
  pcb.zones = [local, keepout, technical];
  const result = insetReferenceZoneBoundaries(pcb);
  assert.equal(result.board, pcb);
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.board.zones, [local, keepout, technical]);
});

test('split rails preserve their sloping internal divider rather than clamping each vertex', () => {
  const pcb = board();
  const upper = {
    ...zone('upper'),
    outline: [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 19.98, y: 8 },
      { x: 0, y: 8.025 },
    ],
    holes: [],
    filledPolygons: [{ points: rectangle(0.5005, 0.5005, 19.4995, 7.49) }],
  };
  const lower = {
    ...zone('lower'),
    outline: [
      { x: 0, y: 8.025 },
      { x: 0, y: 16 },
      { x: 20, y: 16 },
      { x: 19.98, y: 8 },
    ],
    holes: [],
    filledPolygons: [
      {
        points: [
          { x: 0.5005, y: 8.0246 },
          { x: 19.4995, y: 8.001 },
          { x: 19.4995, y: 15.4995 },
          { x: 0.5005, y: 15.4995 },
        ],
      },
    ],
  };
  pcb.zones = [upper, lower];
  const result = insetReferenceZoneBoundaries(pcb);
  const divide = (x: number) => 8.025 - (0.025 * x) / 19.98;
  for (const item of result.board.zones)
    for (const point of item.outline.filter((point) => point.y > 7.9 && point.y < 8.1))
      assert.ok(Math.abs(point.y - divide(point.x)) < 0.000001);
  assert.equal(result.board.zones[0].filledPolygons, upper.filledPolygons);
  assert.equal(result.board.zones[1].filledPolygons, lower.filledPolygons);
});

test('invalid inset and unsupported board outlines fail explicitly', () => {
  for (const value of [0, -1, NaN, Infinity, 8, 20])
    assert.throws(() => insetReferenceZoneBoundaries(board(), value));
  const absent = board();
  absent.graphics = [];
  assert.throws(() => insetReferenceZoneBoundaries(absent), /closed board outline/);
  const triangular = board();
  triangular.graphics[0] = {
    ...triangular.graphics[0],
    start: { x: 0, y: 0 },
    points: [{ x: 20, y: 0 }],
    end: { x: 0, y: 16 },
  };
  assert.throws(() => insetReferenceZoneBoundaries(triangular), /rectangular board/);
});

test('missing fills and any saved copper or cutout outside the clipped owner fail without mutation', () => {
  for (const filledPolygons of [undefined, []]) {
    const pcb = board();
    pcb.zones[0].filledPolygons = filledPolygons;
    assert.throws(() => insetReferenceZoneBoundaries(pcb), /no saved copper/);
  }
  for (const target of ['filled', 'cutout'] as const) {
    const pcb = board();
    if (target === 'filled') pcb.zones[0].filledPolygons![0].points[0].x = 0.1;
    else pcb.zones[0].holes![0][0].x = 0.1;
    const before = structuredClone(pcb);
    assert.throws(() => insetReferenceZoneBoundaries(pcb), /clip saved copper or a cutout/);
    assert.deepEqual(pcb, before);
  }
  const sloped = board();
  sloped.zones[0] = {
    ...zone('sloped'),
    outline: [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 19.98, y: 8 },
      { x: 0, y: 8.025 },
    ],
    holes: [],
    filledPolygons: [
      {
        points: [
          { x: 1, y: 1 },
          { x: 10, y: 8.02 },
          { x: 19, y: 1 },
        ],
      },
    ],
  };
  assert.throws(
    () => insetReferenceZoneBoundaries(sloped),
    /clip saved copper or a cutout/,
    'A point inside the bounding box but across the sloped owner edge must fail.',
  );
});

test('all nine curated boards preserve saved fills and become idempotent inside the board inset', () => {
  assert.equal(manifest.examples.length, 9);
  for (const entry of manifest.examples) {
    const pcb = parseProject(
      readFileSync(`tests/fixtures/reference/${entry.file}.json`, 'utf8'),
    ).pcb!;
    const before = JSON.stringify(pcb);
    const result = insetReferenceZoneBoundaries(pcb);
    assert.equal(JSON.stringify(pcb), before);
    const outer = boardPolygons(pcb)[0].outer;
    const limits = {
      minX: Math.min(...outer.map((point) => point.x)) + 0.5,
      minY: Math.min(...outer.map((point) => point.y)) + 0.5,
      maxX: Math.max(...outer.map((point) => point.x)) - 0.5,
      maxY: Math.max(...outer.map((point) => point.y)) - 0.5,
    };
    for (let index = 0; index < pcb.zones.length; index++) {
      const original = pcb.zones[index];
      const changed = result.board.zones[index];
      assert.equal(changed.id, original.id);
      assert.equal(changed.filledPolygons, original.filledPolygons);
      assert.equal(changed.holes, original.holes);
      if (!changed.keepout)
        for (const point of changed.outline)
          assert.ok(
            point.x >= limits.minX - 0.000001 &&
              point.x <= limits.maxX + 0.000001 &&
              point.y >= limits.minY - 0.000001 &&
              point.y <= limits.maxY + 0.000001,
            `${entry.id}: zone boundaries stay inside the board's 0.5 mm inset.`,
          );
    }
    const again = insetReferenceZoneBoundaries(result.board);
    assert.equal(again.board, result.board);
    assert.deepEqual(again.changes, []);
  }
});
