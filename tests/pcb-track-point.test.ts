import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { Point } from '../lib/circuit';
import type { PCB } from '../lib/pcb';
import { ownProjectData } from '../lib/immutable-project';
import { defaultPCBDisplay, type PCBDisplay } from '../lib/pcb-display';
import { createEmptyPCB } from '../lib/pcb-layout';
import { parseProject } from '../lib/project';
import {
  choosePCBPointCandidate,
  defaultPCBSelectionFilters,
  selectPCBPoint,
  selectPCBTrackPoint,
  type PCBSelectionFilters,
} from '../lib/pcb-selection';

function compareTrackQueries(board: PCB, points: Point[], variants: PCBDisplay[]) {
  const defaults = defaultPCBSelectionFilters();
  const filterVariants: PCBSelectionFilters[] = [
    defaults,
    { ...defaults, locked: true, pad: false },
    { ...defaults, track: false },
  ];
  const original = structuredClone(board);
  const preparedFills = new Map();
  for (const layers of variants)
    for (const filters of filterVariants)
      for (const tolerance of [0, 0.02, 0.4])
        for (const at of points) {
          const actual = selectPCBTrackPoint(board, layers, filters, at, tolerance);
          const expected = selectPCBPoint(board, layers, filters, at, tolerance, {
            preparedFills,
          }).filter((selection) => selection.kind === 'track');
          assert.deepEqual(actual, expected, `Track candidates at ${at.x},${at.y} ±${tolerance}.`);
          // Original DOM hits may enlarge/reorder the candidate list. A track
          // outside physical tolerance cannot become the final D/G pickup.
          const domCandidates = board.tracks
            .slice(0, 3)
            .reverse()
            .map((track) => ({ kind: 'track' as const, id: track.id }));
          const originalCandidates = selectPCBPoint(board, layers, filters, at, tolerance, {
            preciseCandidates: domCandidates,
            preparedFills,
          })
            .filter((selection) => selection.kind === 'track')
            .map((selection) => ({ selection }));
          for (const priorityLayer of ['F.Cu', 'B.Cu']) {
            const options = { tolerance, tieTolerance: 0.001, filters, priorityLayer };
            assert.deepEqual(
              choosePCBPointCandidate(
                board,
                layers,
                actual.map((selection) => ({ selection })),
                at,
                options,
              ),
              choosePCBPointCandidate(board, layers, originalCandidates, at, options),
              'Early track narrowing retains the original nearest/priority/lock decision.',
            );
          }
        }
  assert.deepEqual(board, original);
}

test('EMC track-only pickups match generic candidates filtered after all-category picking', async () => {
  const board = ownProjectData(
    parseProject(await readFile('lib/emc-flyback-example.json', 'utf8')),
  ).pcb!;
  const all = defaultPCBDisplay();
  const points = board.tracks
    .filter((_, index) => index % 31 === 0)
    .flatMap((track) => [
      track.start,
      { x: (track.start.x + track.end.x) / 2, y: (track.start.y + track.end.y) / 2 },
    ]);
  points.push({ x: -50, y: -50 });
  compareTrackQueries(board, points, [
    all,
    { ...all, 'F.Cu': false },
    { ...all, 'B.Cu': false, footprints: false, zoneOutlines: false },
  ]);
});

test('track-only pickups retain crossing, epsilon, layer and degenerate-span decisions', () => {
  const board = createEmptyPCB();
  const track = (id: string, start: Point, end: Point): PCB['tracks'][number] => ({
    id,
    start,
    end,
    layer: 'F.Cu',
    width: 0.4,
    netId: 'n',
  });
  board.tracks = [
    track('horizontal', { x: -3, y: 0 }, { x: 3, y: 0 }),
    { ...track('vertical', { x: 0, y: -3 }, { x: 0, y: 3 }), locked: true },
    { ...track('back', { x: -3, y: 0 }, { x: 3, y: 0 }), layer: 'B.Cu' },
    track('diagonal', { x: 0, y: 0 }, { x: 3, y: 3 }),
    track('point', { x: 5, y: 5 }, { x: 5, y: 5 }),
  ];
  const all = defaultPCBDisplay();
  compareTrackQueries(
    ownProjectData(board),
    [
      { x: 0, y: 0 },
      { x: 0.15, y: 0 },
      { x: 0, y: 0.15 },
      { x: 1, y: 1 },
      { x: 3.2, y: 0 },
      { x: 3.200000001, y: 0 },
      { x: 5, y: 5 },
      { x: 5.2, y: 5 },
    ],
    [all, { ...all, 'F.Cu': false }, { ...all, 'B.Cu': false }],
  );
});

test('track-only queries avoid unrelated geometry and keep mutable inputs and results independent', () => {
  const board = createEmptyPCB();
  board.tracks = [
    {
      id: 'track',
      start: { x: 0, y: 0 },
      end: { x: 10, y: 0 },
      layer: 'F.Cu',
      width: 0.4,
      netId: 'n',
    },
  ];
  for (const key of ['footprints', 'graphics', 'zones', 'vias'])
    Object.defineProperty(board, key, {
      get() {
        throw new Error(`Unrelated ${key} must not be prepared for a track-only tool.`);
      },
    });
  Object.freeze(board);
  const layers = defaultPCBDisplay(),
    filters = defaultPCBSelectionFilters(),
    at = { x: 5, y: 0 };
  const actual = selectPCBTrackPoint(board, layers, filters, at, 0);
  const choose = () =>
    choosePCBPointCandidate(
      board,
      layers,
      selectPCBTrackPoint(board, layers, filters, at, 0).map((selection) => ({ selection })),
      at,
      { tolerance: 0, filters },
    );
  assert.equal(choose()?.selection.id, 'track');
  actual[0].id = 'escaped';
  assert.equal(choose()?.selection.id, 'track');
  board.tracks[0].start.y = board.tracks[0].end.y = 10;
  assert.deepEqual(selectPCBTrackPoint(board, layers, filters, at, 0), []);
  assert.equal(choose(), undefined);
  assert.deepEqual(selectPCBTrackPoint(board, layers, filters, at, -1), []);
  assert.deepEqual(selectPCBTrackPoint(board, layers, filters, { x: NaN, y: 0 }, 0), []);
  assert.throws(
    () =>
      selectPCBTrackPoint(
        { ...createEmptyPCB(), tracks: new Array(15001) },
        layers,
        filters,
        at,
        0,
      ),
    /geometry limit/,
  );
});
