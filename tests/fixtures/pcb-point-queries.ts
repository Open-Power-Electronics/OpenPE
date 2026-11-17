// Test-only exhaustive oracle for owned PCB point queries.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Point } from '../../lib/circuit';
import type { PCB } from '../../lib/pcb';
import { ownProjectData } from '../../lib/immutable-project';
import { padPosition } from '../../lib/pcb-layout';
import { defaultPCBDisplay, type PCBDisplay } from '../../lib/pcb-display';
import { parseProject } from '../../lib/project';
import {
  choosePCBPointCandidate,
  defaultPCBSelectionFilters,
  selectPCBPoint,
  type PCBSelectionFilters,
} from '../../lib/pcb-selection';
import { filledCopperPolygons } from '../../lib/pcb-polygons';

export function compareQueries(
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

/**
 * Compare one interleaved share of the sampled EMC Flyback points. Every shard
 * runs the complete display/filter sequence, so the shards together cover each
 * sampled query exactly once per variant.
 */
export async function compareEMCPointShard({ shard, shards }: { shard: number; shards: number }) {
  if (
    !Number.isInteger(shards) ||
    shards < 1 ||
    !Number.isInteger(shard) ||
    shard < 0 ||
    shard >= shards
  )
    throw new Error(`Invalid EMC point shard ${shard} of ${shards}.`);
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
    points.filter((_, index) => index % shards === shard),
    [
      all,
      { ...all, 'F.Cu': false, 'F.SilkS': false },
      { ...all, footprints: false },
      { ...all, zoneOutlines: false },
      all,
    ],
    [filters, { ...filters, footprint: false, locked: false, text: false, ruleArea: false }],
  );
}
