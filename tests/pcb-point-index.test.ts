import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { Point } from '../lib/circuit';
import type { PCB, BoardLine } from '../lib/pcb';
import { ownProjectData } from '../lib/immutable-project';
import { createEmptyPCB, flipPCBFootprint, movePCBSelection, padPosition } from '../lib/pcb-layout';
import { defaultPCBDisplay, type PCBDisplay } from '../lib/pcb-display';
import { parseProject } from '../lib/project';
import {
  choosePCBPointCandidate,
  defaultPCBSelectionFilters,
  selectPCBPoint,
  type PCBPointSelectionOptions,
  type PCBSelectionFilters,
} from '../lib/pcb-selection';
import { filledCopperPolygons } from '../lib/pcb-polygons';

function compareQueries(
  board: PCB,
  points: Point[],
  variants: PCBDisplay[],
  filterVariants: PCBSelectionFilters[],
) {
  const owned = ownProjectData(board);
  const brute = structuredClone(board);
  const fills = filledCopperPolygons(board);
  // Visibility revisits still query the owned index after its bounded variants
  // have been evicted. Reuse only the exhaustive oracle for identical inputs;
  // every sampled query and nearest-candidate assertion still runs on the index.
  const exhaustive = new Map<
    string,
    {
      selections: ReturnType<typeof selectPCBPoint>;
      picks: Map<string, ReturnType<typeof choosePCBPointCandidate>>;
    }
  >();
  for (const layers of variants)
    for (const filters of filterVariants)
      for (const tolerance of [0, 0.02, 0.4])
        for (const at of points) {
          const options = { preparedFills: fills };
          const actual = selectPCBPoint(owned, layers, filters, at, tolerance, options);
          const key = JSON.stringify([layers, filters, tolerance, at.x, at.y]);
          let expected = exhaustive.get(key);
          if (!expected) {
            const selections = selectPCBPoint(brute, layers, filters, at, tolerance, options);
            const candidates = selections.map((selection) => ({ selection }));
            const picks = new Map<string, ReturnType<typeof choosePCBPointCandidate>>();
            for (const priorityLayer of ['F.Cu', 'B.Cu'])
              picks.set(
                priorityLayer,
                choosePCBPointCandidate(brute, layers, candidates, at, {
                  tolerance,
                  priorityLayer,
                  filters,
                  preparedFills: fills,
                }),
              );
            expected = { selections, picks };
            exhaustive.set(key, expected);
          }
          assert.deepEqual(actual, expected.selections, `Point ${at.x},${at.y} ±${tolerance}`);
          const candidates = expected.selections.map((selection) => ({
            selection: { ...selection },
          }));
          for (const priorityLayer of ['F.Cu', 'B.Cu']) {
            const picking = { tolerance, priorityLayer, filters, preparedFills: fills };
            assert.deepEqual(
              choosePCBPointCandidate(owned, layers, candidates, at, picking),
              expected.picks.get(priorityLayer),
              'Owned lookup maps retain nearest geometry, overlap and layer tie decisions.',
            );
          }
        }
  assert.deepEqual(owned, board);
  assert.deepEqual(brute, board);
}

test('owned EMC point index matches exhaustive geometry across viewport scales, layers and filters', async () => {
  const board = parseProject(await readFile('lib/emc-flyback-example.json', 'utf8')).pcb!;
  const all = defaultPCBDisplay();
  const filters = defaultPCBSelectionFilters();
  const points = [
    ...board.footprints
      .filter((_, index) => index % 5 === 0)
      .map((footprint) =>
        footprint.pads[0] ? padPosition(footprint, footprint.pads[0]) : footprint,
      ),
    ...board.tracks
      .filter((_, index) => index % 13 === 0)
      .flatMap((track) => [
        track.start,
        { x: (track.start.x + track.end.x) / 2, y: (track.start.y + track.end.y) / 2 },
      ]),
    { x: 61.2, y: 57.4625 },
    { x: 61, y: 57.9 },
    { x: 100, y: 41 },
    { x: -50, y: -50 },
  ];
  compareQueries(
    board,
    points,
    [
      all,
      { ...all, 'F.Cu': false, 'F.SilkS': false },
      { ...all, footprints: false },
      { ...all, zoneOutlines: false },
      all,
    ],
    [filters, { ...filters, footprint: false, locked: false, text: false, ruleArea: false }],
  );
});

test('owned broad phase retains rotated shapes, outlines, holes and exact epsilon boundaries', () => {
  const graphic = (id: string, kind: BoardLine['kind'], fill = false): BoardLine => ({
    id,
    kind,
    layer: 'F.SilkS',
    start: { x: 0, y: 0 },
    end: { x: 5, y: 0 },
    width: 0.2,
    fill,
  });
  const board: PCB = {
    ...createEmptyPCB(),
    footprints: [
      {
        id: 'part',
        libraryId: 'test',
        symbolId: null,
        x: 12,
        y: 8,
        rotation: 37,
        side: 'front',
        graphics: [],
        pads: [
          {
            id: 'pad',
            number: '1',
            x: 2,
            y: 1,
            rotation: 23,
            size: { x: 5, y: 0.8 },
            shape: 'roundrect',
            type: 'smd',
            netId: null,
          },
        ],
        zones: [
          {
            id: 'embedded',
            layer: 'F.Cu',
            netId: null,
            outline: [
              { x: -7, y: -7 },
              { x: 7, y: -7 },
              { x: 7, y: 7 },
              { x: -7, y: 7 },
            ],
            holes: [
              [
                { x: -2, y: -2 },
                { x: 2, y: -2 },
                { x: 2, y: 2 },
                { x: -2, y: 2 },
              ],
            ],
            keepout: { tracks: true, vias: true, pads: true, copperpour: true, footprints: false },
            clearance: 0.2,
            minThickness: 0.2,
            thermalGap: 0.2,
            thermalBridge: 0.2,
          },
        ],
      },
    ],
    tracks: [
      {
        id: 'locked',
        start: { x: -5, y: 2 },
        end: { x: 5, y: 2 },
        width: 0.3,
        layer: 'F.Cu',
        netId: 'n',
        locked: true,
      },
    ],
    vias: [{ id: 'via', x: 2, y: 2, diameter: 1, drill: 0.4, netId: 'n' }],
    graphics: [
      graphic('circle', 'circle'),
      { ...graphic('disk', 'circle', true), start: { x: -12, y: 0 }, end: { x: -7, y: 0 } },
      { ...graphic('arc', 'arc'), mid: { x: 2.5, y: 2.5 } },
      {
        ...graphic('poly', 'polygon', true),
        start: { x: 20, y: 0 },
        points: [
          { x: 25, y: 0 },
          { x: 25, y: 5 },
        ],
        end: { x: 20, y: 5 },
      },
      {
        ...graphic('text', 'text'),
        start: { x: 25, y: 12 },
        end: { x: 25, y: 12 },
        text: {
          value: 'A\nB',
          rotation: 45,
          size: { x: 1, y: 1 },
          thickness: 0.1,
          justify: ['mirror'],
        },
      },
    ],
  };
  board.footprints.push({
    ...flipPCBFootprint(board.footprints[0]),
    id: 'flipped',
    x: 30,
    pads: board.footprints[0].pads.map((pad) => ({ ...pad, id: 'flipped-pad' })),
    zones: [],
  });
  const points = Array.from({ length: 54 }, (_, index) => ({
    x: -18 + (index % 9) * 6,
    y: -8 + Math.floor(index / 9) * 4,
  }));
  points.push(
    { x: 5.1 + 5e-10, y: 0 },
    { x: 0, y: 2.15 + 5e-10 },
    padPosition(board.footprints[0], board.footprints[0].pads[0]),
  );
  const all = defaultPCBDisplay(),
    filters = defaultPCBSelectionFilters();
  compareQueries(
    board,
    points,
    [all, { ...all, 'F.SilkS': false }, { ...all, 'F.Cu': false }, all],
    [
      filters,
      { ...filters, locked: true, ruleArea: false },
      { ...filters, graphic: false, text: false },
    ],
  );
});

test('point caches reject foreign freezing, follow mutable previews and return independent wrappers', () => {
  const layers = defaultPCBDisplay(),
    filters = defaultPCBSelectionFilters();
  const board: PCB = {
    ...createEmptyPCB(),
    tracks: [
      {
        id: 'track',
        layer: 'F.Cu',
        netId: 'n',
        width: 0.2,
        start: { x: 0, y: 0 },
        end: { x: 10, y: 0 },
      },
    ],
  };
  const owned = ownProjectData(board),
    at = { x: 5, y: 0 };
  const result = selectPCBPoint(owned, layers, filters, at, 0);
  assert.equal(result[0].id, 'track');
  result[0].id = 'caller-mutation';
  assert.equal(selectPCBPoint(owned, layers, filters, at, 0)[0].id, 'track');
  const frozen = Object.freeze(structuredClone(board));
  assert.equal(selectPCBPoint(frozen, layers, filters, at, 0).length, 1);
  frozen.tracks[0].start.y = frozen.tracks[0].end.y = 20;
  assert.deepEqual(selectPCBPoint(frozen, layers, filters, at, 0), []);
  const preview = movePCBSelection(owned, [{ kind: 'track', id: 'track' }], { x: 0, y: 5 });
  assert.deepEqual(selectPCBPoint(preview, layers, filters, at, 0), []);
  assert.equal(selectPCBPoint(preview, layers, filters, { x: 5, y: 5 }, 0).length, 1);
  preview.tracks[0].start.y = preview.tracks[0].end.y = 9;
  assert.deepEqual(selectPCBPoint(preview, layers, filters, { x: 5, y: 5 }, 0), []);
  assert.equal(selectPCBPoint(owned, layers, filters, at, 0).length, 1);
  layers['F.Cu'] = false;
  assert.deepEqual(selectPCBPoint(owned, layers, filters, at, 0), []);
  layers['F.Cu'] = true;
  assert.equal(selectPCBPoint(owned, layers, filters, at, 0).length, 1);
});

test('saved-fill queries always read current caller maps and retain precise DOM order', () => {
  const zone = {
    id: 'zone',
    layer: 'F.Cu' as const,
    netId: 'n',
    outline: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ],
    clearance: 0.2,
    minThickness: 0.2,
    thermalGap: 0.2,
    thermalBridge: 0.2,
  };
  const board = ownProjectData({ ...createEmptyPCB(), zones: [zone] });
  const layers = { ...defaultPCBDisplay(), zoneOutlines: false },
    filters = defaultPCBSelectionFilters();
  const preparedFills = new Map([[zone.id, [{ outer: zone.outline, holes: [] }]]]);
  const options: PCBPointSelectionOptions = { preparedFills };
  for (const includeFills of [false, true]) {
    options.includeFills = includeFills;
    assert.equal(selectPCBPoint(board, layers, filters, { x: 2, y: 2 }, 0, options)[0].id, 'zone');
    preparedFills.clear();
    assert.deepEqual(selectPCBPoint(board, layers, filters, { x: 2, y: 2 }, 0, options), []);
    preparedFills.set(zone.id, [{ outer: zone.outline, holes: [] }]);
  }
  const withTracks = ownProjectData({
    ...board,
    tracks: [
      {
        id: 'first',
        layer: 'F.Cu' as const,
        netId: 'n',
        width: 0.2,
        start: { x: 0, y: 2 },
        end: { x: 10, y: 2 },
      },
      {
        id: 'second',
        layer: 'F.Cu' as const,
        netId: 'n',
        width: 0.2,
        start: { x: 0, y: 2 },
        end: { x: 10, y: 2 },
      },
    ],
  });
  assert.deepEqual(
    selectPCBPoint(withTracks, layers, filters, { x: 2, y: 2 }, 0, {
      preparedFills,
      preciseCandidates: [{ kind: 'track', id: 'second' }],
    }).map((item) => item.id),
    ['second', 'first'],
  );
});
