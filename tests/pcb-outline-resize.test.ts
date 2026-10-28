import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createEmptyPCB } from '../lib/pcb-layout';
import { parseProject, serializeProject } from '../lib/project';
import { ProjectCore } from '../core/project-core';
import {
  findPCBRectangle,
  pcbRectangleDragBounds,
  resizePCBRectangle,
} from '../lib/pcb-outline-resize';
import { invalidatePCBFill, type PCB } from '../lib/pcb';

function fixture(polygon = true): PCB {
  const board = createEmptyPCB();
  const corners = [
    { x: 0.123456, y: 1.234567 },
    { x: 20.123456, y: 1.234567 },
    { x: 20.123456, y: 16.234567 },
    { x: 0.123456, y: 16.234567 },
  ];
  board.graphics = polygon
    ? [
        {
          id: 'frame',
          layer: 'Edge.Cuts',
          kind: 'polygon',
          width: 0.05,
          start: corners[0],
          points: corners.slice(1, 3),
          end: corners[3],
          stroke: 'solid',
          fill: false,
        },
      ]
    : corners.map((start, i) => ({
        id: `edge-${i}`,
        layer: 'Edge.Cuts',
        width: 0.05,
        start,
        end: corners[(i + 1) % 4],
      }));
  board.graphics.push({
    id: 'other',
    layer: 'F.SilkS',
    start: { x: 3, y: 4 },
    end: { x: 8, y: 4 },
    width: 0.1,
  });
  return board;
}
test('rectangular native polygons and four-line frames resize together, retaining metadata and unrelated geometry', () => {
  for (const polygon of [false, true]) {
    const board = fixture(polygon),
      before = structuredClone(board);
    const rectangle = findPCBRectangle(board, [{ kind: 'graphic', id: board.graphics[0].id }])!;
    assert.ok(rectangle);
    assert.equal(rectangle.ids.length, polygon ? 1 : 4);
    assert.equal(resizePCBRectangle(board, rectangle, rectangle.bounds), board);
    const bounds = { ...rectangle.bounds, maxX: 24.5, minY: -2.5 };
    const next = resizePCBRectangle(board, rectangle, bounds);
    assert.deepEqual(
      findPCBRectangle(next, [{ kind: 'graphic', id: board.graphics[0].id }])!.bounds,
      bounds,
    );
    assert.deepEqual(
      next.graphics.map((g) => g.id),
      board.graphics.map((g) => g.id),
    );
    assert.equal(next.graphics.at(-1), board.graphics.at(-1));
    assert.equal(next.footprints, board.footprints);
    assert.equal(next.tracks, board.tracks);
    assert.equal(next.vias, board.vias);
    assert.equal(next.zones, board.zones);
    next.graphics.slice(0, -1).forEach((g, i) => assert.equal(g.width, board.graphics[i].width));
    assert.deepEqual(board, before);
  }
});
test('handles preserve their fixed opposite edges, snap moved axes, and retain exact no-op native coordinates', () => {
  const board = fixture(),
    rectangle = findPCBRectangle(board, [{ kind: 'graphic', id: 'frame' }])!;
  assert.deepEqual(pcbRectangleDragBounds(rectangle, 'se', { x: 0, y: 0 }, 0.5), rectangle.bounds);
  for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const) {
    const b = pcbRectangleDragBounds(rectangle, handle, { x: 1.3, y: 2.2 }, 0.5);
    assert.equal(b.minX, handle.includes('w') ? 1.5 : rectangle.bounds.minX);
    assert.equal(b.maxX, handle.includes('e') ? 21.5 : rectangle.bounds.maxX);
    assert.equal(b.minY, handle.includes('n') ? 3.5 : rectangle.bounds.minY);
    assert.equal(b.maxY, handle.includes('s') ? 18.5 : rectangle.bounds.maxY);
  }
  const clamped = pcbRectangleDragBounds(rectangle, 'nw', { x: 999, y: 999 }, 0.5);
  assert.equal(clamped.maxX - clamped.minX, 0.5);
  assert.equal(clamped.maxY - clamped.minY, 0.5);
  const raw = pcbRectangleDragBounds(rectangle, 'e', { x: 0.123456, y: 0 }, 0);
  assert.equal(raw.maxX, 20.246912);
});
test('nonrectangular, open, branched and unrelated selections cannot acquire rectangular resize handles', () => {
  const board = fixture(false);
  assert.equal(findPCBRectangle(board, [{ kind: 'graphic', id: 'other' }]), null);
  assert.equal(
    findPCBRectangle(board, [
      { kind: 'graphic', id: 'edge-0' },
      { kind: 'graphic', id: 'other' },
    ]),
    null,
  );
  const open = { ...board, graphics: board.graphics.filter((g) => g.id !== 'edge-1') };
  assert.equal(findPCBRectangle(open, [{ kind: 'graphic', id: 'edge-0' }]), null);
  const branched = {
    ...board,
    graphics: [...board.graphics, { ...board.graphics[0], id: 'branch', end: { x: -3, y: -3 } }],
  };
  assert.equal(findPCBRectangle(branched, [{ kind: 'graphic', id: 'edge-0' }]), null);
  const skew = fixture();
  skew.graphics[0].points![0] = { x: 21, y: 2 };
  assert.equal(findPCBRectangle(skew, [{ kind: 'graphic', id: 'frame' }]), null);
});
test('stale rectangles and invalid extents fail before mutation', () => {
  const board = fixture(),
    rectangle = findPCBRectangle(board, [{ kind: 'graphic', id: 'frame' }])!;
  for (const maxX of [NaN, Infinity, 100001, rectangle.bounds.minX])
    assert.throws(
      () => resizePCBRectangle(board, rectangle, { ...rectangle.bounds, maxX }),
      /dimensions/,
    );
  const next = resizePCBRectangle(board, rectangle, { ...rectangle.bounds, maxX: 25 });
  assert.throws(
    () => resizePCBRectangle(next, rectangle, { ...rectangle.bounds, maxX: 26 }),
    /changed/,
  );
});
test('zone resize scales its polygon and holes while preserving network, rules, identity and unrelated design', () => {
  const board = fixture();
  const outline = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 8, y: 8 },
    { x: 0, y: 10 },
  ];
  board.zones = [
    {
      id: 'zone',
      netId: 'net',
      layer: 'F.Cu',
      outline,
      holes: [
        [
          { x: 2, y: 2 },
          { x: 3, y: 2 },
          { x: 3, y: 3 },
          { x: 2, y: 3 },
        ],
      ],
      clearance: 0.25,
      minThickness: 0.2,
      thermalGap: 0.3,
      thermalBridge: 0.4,
      priority: 2,
      filledPolygons: [{ points: outline }],
      fillEnabled: true,
    },
  ];
  const before = structuredClone(board),
    region = findPCBRectangle(board, [{ kind: 'zone', id: 'zone' }])!;
  assert.equal(resizePCBRectangle(board, region, region.bounds), board);
  const next = resizePCBRectangle(board, region, { minX: 2, minY: 4, maxX: 22, maxY: 34 });
  assert.deepEqual(next.zones[0].outline, [
    { x: 2, y: 4 },
    { x: 22, y: 4 },
    { x: 18, y: 28 },
    { x: 2, y: 34 },
  ]);
  assert.deepEqual(next.zones[0].holes, [
    [
      { x: 6, y: 10 },
      { x: 8, y: 10 },
      { x: 8, y: 13 },
      { x: 6, y: 13 },
    ],
  ]);
  const { outline: _outline, holes: _holes, ...properties } = next.zones[0];
  const {
    outline: _originalOutline,
    holes: _originalHoles,
    ...originalProperties
  } = board.zones[0];
  assert.deepEqual(properties, originalProperties);
  assert.equal(next.graphics, board.graphics);
  assert.equal(next.tracks, board.tracks);
  assert.equal(next.footprints, board.footprints);
  assert.equal(invalidatePCBFill(board, next).zones[0].filledPolygons, undefined);
  assert.deepEqual(board, before);
  const precise = structuredClone(board);
  precise.zones[0].outline[2].x = 8.123456789;
  const preciseRegion = findPCBRectangle(precise, [{ kind: 'zone', id: 'zone' }])!;
  const taller = resizePCBRectangle(precise, preciseRegion, { ...preciseRegion.bounds, maxY: 20 });
  assert.equal(
    taller.zones[0].outline[2].x,
    8.123456789,
    'Resizing height retains exact native X coordinates.',
  );
});
test('actual LM2596 outline resize is one Core undo, preserves native identities and clears fills once', async () => {
  const sources = JSON.parse(await readFile('lib/reference-examples.json', 'utf8'));
  const project = parseProject(sources['reference-lm2596-to220-5-buck']);
  const core = new ProjectCore(project),
    board = core.getSnapshot().project!.pcb!;
  const frame = board.graphics.find((g) => g.layer === 'Edge.Cuts')!;
  const rectangle = findPCBRectangle(board, [{ kind: 'graphic', id: frame.id }])!;
  const resized = resizePCBRectangle(board, rectangle, {
    ...rectangle.bounds,
    maxX: rectangle.bounds.maxX + 5,
  });
  const next = invalidatePCBFill(board, resized);
  assert.equal(core.replaceBoard(next), true);
  const accepted = core.getSnapshot().project!.pcb!;
  assert.equal(accepted.graphics.find((g) => g.id === frame.id)!.id, frame.id);
  assert.deepEqual(accepted.tracks, board.tracks);
  assert.deepEqual(accepted.footprints, board.footprints);
  assert.ok(accepted.zones.every((z) => z.filledPolygons === undefined));
  assert.deepEqual(parseProject(serializeProject({ ...project, pcb: accepted })).pcb, accepted);
  core.undo();
  assert.deepEqual(core.getSnapshot().project!.pcb, board);
  core.redo();
  assert.deepEqual(core.getSnapshot().project!.pcb, accepted);
});
