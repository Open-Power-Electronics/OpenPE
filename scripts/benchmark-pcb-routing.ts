import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createPCBRouter } from '../lib/pcb-routing';
import { parseProject } from '../lib/project';

// Domain-only measurements: exclude file parsing, React, SVG paint and Core commits.
// Fresh means a new prepared engine in this process; warm retains that engine.
const board = parseProject(await readFile('lib/emc-flyback-example.json', 'utf8')).pcb!;
const before = JSON.stringify(board);
const cases = [
  {
    name: 'VBUS existing span',
    trackId: '55e76c6c-a882-41a3-85b9-455b1a2d200e',
    end: { x: 118.7931, y: 64.9017 },
    blocked: false,
  },
  {
    name: 'EMC walk around lower copper',
    trackId: '33cdc88b-d74e-4100-8239-7380156abb0b',
    end: { x: 81.52, y: 122.86 },
    blocked: false,
  },
  {
    name: 'EMC walk around upper copper',
    trackId: '33cdc88b-d74e-4100-8239-7380156abb0b',
    end: { x: 81.52, y: 114.86 },
    blocked: false,
  },
  {
    name: 'EMC blocked head',
    trackId: '33cdc88b-d74e-4100-8239-7380156abb0b',
    end: { x: 81.52, y: 116.86 },
    blocked: true,
  },
];
const samples = 40;
const budgetMs = 100;
const round = (value: number) => Number(value.toFixed(3));
function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50Ms: round(sorted[Math.floor(sorted.length * 0.5)]),
    p95Ms: round(sorted[Math.floor(sorted.length * 0.95)]),
    maxMs: round(sorted.at(-1)!),
    withinBudget: sorted.at(-1)! < budgetMs,
  };
}
const results = cases.map((item) => {
  const track = board.tracks.find((value) => value.id === item.trackId)!;
  assert.ok(track);
  const prepare = () =>
    createPCBRouter(board, {
      layer: track.layer,
      netId: track.netId,
      width: track.width,
      clearance: 0.25,
      allowInheritedWidth: true,
    });
  let began = performance.now();
  const engine = prepare();
  const firstPrepareMs = performance.now() - began;
  began = performance.now();
  const first = engine.route(track.start, item.end);
  const firstRouteMs = performance.now() - began;
  assert.equal(first.blocked, item.blocked, first.message);
  assert.equal(
    engine.validate(first.points),
    '',
    'Every visible prefix remains collision checked.',
  );
  let workUnits = 0;
  assert.deepEqual(
    engine.route(track.start, item.end, '45', false, () => {
      workUnits++;
    }),
    first,
  );
  const warmRoute: number[] = [],
    freshPrepare: number[] = [],
    freshRoute: number[] = [],
    freshTotal: number[] = [];
  for (let i = 0; i < samples; i++) {
    began = performance.now();
    const result = engine.route(track.start, item.end);
    warmRoute.push(performance.now() - began);
    assert.deepEqual(result, first);
  }
  for (let i = 0; i < samples; i++) {
    began = performance.now();
    const fresh = prepare();
    freshPrepare.push(performance.now() - began);
    began = performance.now();
    const result = fresh.route(track.start, item.end);
    freshRoute.push(performance.now() - began);
    freshTotal.push(freshPrepare.at(-1)! + freshRoute.at(-1)!);
    assert.deepEqual(result, first);
  }
  const firstTotalMs = firstPrepareMs + firstRouteMs;
  const freshTotalStats = stats(freshTotal);
  const warmRouteStats = stats(warmRoute);
  return {
    name: item.name,
    trackId: item.trackId,
    blocked: first.blocked,
    points: first.points.length,
    pathLengthMm: round(
      first.points
        .slice(1)
        .reduce(
          (sum, point, index) =>
            sum + Math.hypot(point.x - first.points[index].x, point.y - first.points[index].y),
          0,
        ),
    ),
    firstPrepareMs: round(firstPrepareMs),
    firstRouteMs: round(firstRouteMs),
    firstTotalMs: round(firstTotalMs),
    workUnits,
    freshPrepare: stats(freshPrepare),
    freshRoute: stats(freshRoute),
    freshTotal: freshTotalStats,
    warmRoute: warmRouteStats,
    withinBudget:
      firstTotalMs < budgetMs && freshTotalStats.withinBudget && warmRouteStats.withinBudget,
  };
});
assert.equal(JSON.stringify(board), before, 'Preparing/routing never changes the example.');
const withinBudget = results.every((result) => result.withinBudget);
console.log(
  JSON.stringify(
    {
      scope: 'Shared router only; file parsing, UI rendering and document commits excluded.',
      budgetMs,
      samples,
      withinBudget,
      board: {
        tracks: board.tracks.length,
        vias: board.vias.length,
        pads: board.footprints.reduce((sum, footprint) => sum + footprint.pads.length, 0),
      },
      results,
    },
    null,
    2,
  ),
);
if (!withinBudget) process.exitCode = 1;
