import test from 'node:test';
import assert from 'node:assert/strict';
import { polygonResolution } from '../lib/pcb-polygons';
import { thermalContourSnapTolerance, thermalPlanarGraph } from '../server/thermal-planar.mjs';

const square = (left: number, top: number, right: number, bottom: number) => [
  { x: left, y: top },
  { x: right, y: top },
  { x: right, y: bottom },
  { x: left, y: bottom },
];
const scenario = (
  rings: { x: number; y: number }[][],
  hole: { x: number; y: number }[] | null = null,
) => ({
  config: { meshSizeMm: 2 },
  board: [{ outer: square(0, 0, 10, 10), holes: hole ? [hole] : [] }],
  layers: rings.map((outer) => ({ polygons: [{ outer, holes: [] }] })),
  sources: [],
  barrels: [],
});

test('thermal planar graph merges repeated and reversed contours without adding physical boundaries', () => {
  const body = square(0, 0, 10, 10);
  const graph = thermalPlanarGraph(scenario([body, [...body].reverse(), body]));
  assert.equal(graph.points.length, 4);
  assert.equal(graph.segments.length, 4);
  assert.equal(graph.embedded.length, 0);
  assert.equal(graph.loops[0][0].length, 4);
});

test('crossings and partial collinear overlap become one conforming shared edge arrangement', () => {
  const graph = thermalPlanarGraph(
    scenario([square(2, 2, 8, 8), square(0, 4, 10, 6), square(2, 2, 5, 4)]),
  );
  for (const p of [
    { x: 2, y: 4 },
    { x: 8, y: 4 },
    { x: 2, y: 6 },
    { x: 8, y: 6 },
    { x: 5, y: 2 },
  ])
    assert.ok(
      graph.points.some((point: { x: number; y: number }) => point.x === p.x && point.y === p.y),
    );
  const crossing = (
    a: { x: number; y: number },
    b: { x: number; y: number },
    c: { x: number; y: number },
  ) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  for (let i = 0; i < graph.segments.length; i++)
    for (let j = i + 1; j < graph.segments.length; j++) {
      const edge = graph.segments[i],
        other = graph.segments[j];
      if (edge.some((id: number) => other.includes(id))) continue;
      const [a, b] = edge.map((id: number) => graph.points[id]),
        [c, d] = other.map((id: number) => graph.points[id]);
      assert.ok(
        !(crossing(a, b, c) * crossing(a, b, d) < 0 && crossing(c, d, a) * crossing(c, d, b) < 0),
        'Mesh constraints must not retain an unsplit crossing.',
      );
    }
  const segments = graph.segments.map((edge: number[]) => edge.join(','));
  assert.equal(new Set(segments).size, segments.length);
});

test('board-edge weld tolerance is half a clipping-cell diagonal and does not consume a full cell', () => {
  assert.equal(thermalContourSnapTolerance, polygonResolution / Math.SQRT2);
  assert.ok(thermalContourSnapTolerance < polygonResolution);
});

test('a quantized cutout intrusion is welded onto the board edge', () => {
  const dipped = polygonResolution / 4;
  assert.ok(dipped < thermalContourSnapTolerance);
  const graph = thermalPlanarGraph(
    scenario(
      [
        [
          { x: 3, y: 3 },
          { x: 5, y: 4 + dipped },
          { x: 7, y: 3 },
          { x: 5, y: 2 },
        ],
      ],
      square(4, 4, 6, 6),
    ),
  );
  assert.equal(
    graph.points.some((point: { x: number; y: number }) => point.y === 4 + dipped),
    false,
  );
  assert.ok(graph.points.some((point: { x: number; y: number }) => point.x === 5 && point.y === 4));
  assert.equal(
    graph.points.some(
      (point: { x: number; y: number }) => point.x > 4 && point.x < 6 && point.y > 4 && point.y < 6,
    ),
    false,
  );
});

test('a full clipping-cell offset stays off the board edge', () => {
  const offset = polygonResolution;
  assert.ok(offset > thermalContourSnapTolerance);
  const graph = thermalPlanarGraph(
    scenario(
      [
        [
          { x: 3, y: 3 },
          { x: 5, y: 4 + offset },
          { x: 7, y: 3 },
          { x: 5, y: 2 },
        ],
      ],
      square(4, 4, 6, 6),
    ),
  );
  assert.ok(
    graph.points.some((point: { x: number; y: number }) => point.x === 5 && point.y === 4 + offset),
  );
});

test('coincident hole/material contours share boundary edges and keep the complete cutout loop', () => {
  const hole = square(4, 4, 6, 6);
  const graph = thermalPlanarGraph(scenario([hole, square(3, 3, 7, 7)], hole));
  assert.equal(graph.loops[0].length, 2);
  const edges = graph.loops[0][1].map(Math.abs);
  assert.equal(edges.length, 4);
  assert.ok(edges.every((id: number) => !graph.embedded.includes(id)));
});
