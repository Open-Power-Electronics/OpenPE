import assert from 'node:assert/strict';
import test from 'node:test';
import { projectMetadataEqual } from '../lib/project-metadata-equal';
import { ownProjectData } from '../lib/immutable-project';
import type { Project } from '../lib/project';

function metadata(name: unknown, pcb: unknown, extensions: unknown): Project {
  return { name, pcb, extensions } as Project;
}

function oldEqual(left: Project | null | undefined, right: Project | null | undefined) {
  return (
    JSON.stringify([left?.name, left?.pcb, left?.extensions]) ===
    JSON.stringify([right?.name, right?.pcb, right?.extensions])
  );
}

test('metadata equality matches the previous ordered JSON slots and optional values', () => {
  const values: unknown[] = [
    undefined,
    null,
    false,
    true,
    0,
    -0,
    1,
    '',
    'same',
    '\ud800',
    [],
    [undefined],
    [null],
    new Array(1),
    [0, 1],
    [1, 0],
    {},
    { value: undefined },
    { value: null },
    { a: 1, b: 2 },
    { b: 2, a: 1 },
    { 2: 'second', 1: 'first' },
    { 1: 'first', 2: 'second' },
    { layers: ['F.Cu', 'B.Cu'], tracks: [{ start: { x: 0, y: 1.27 }, width: 0.5 }] },
    { optional: [undefined, { ignored: undefined, nested: [null, 1] }] },
  ];
  for (const left of values)
    for (const right of values) {
      const a = metadata(undefined, left, { retained: true });
      const b = metadata(undefined, right, { retained: true });
      assert.equal(projectMetadataEqual(a, b), oldEqual(a, b));
    }
  for (const a of [null, undefined, metadata(undefined, null, {}), metadata('Name', null, {})])
    for (const b of [null, undefined, metadata(undefined, null, {}), metadata('Name', null, {})])
      assert.equal(projectMetadataEqual(a, b), oldEqual(a, b));
  assert.equal(projectMetadataEqual(metadata(undefined, null, {}), metadata('', null, {})), false);
  assert.equal(projectMetadataEqual(metadata('A', null, {}), metadata('B', null, {})), false);
});

test('owned unchanged PCB/extension identities short-circuit while complete edits and undo compare exactly', () => {
  const board = ownProjectData({
    tracks: Array.from({ length: 400 }, (_, index) => ({
      id: String(index),
      start: { x: index, y: 0 },
      end: { x: index, y: 1 },
      width: 0.5,
    })),
    zones: [
      {
        filledPolygons: [
          {
            points: [
              { x: 0, y: 0 },
              { x: 1, y: 0 },
              { x: 1, y: 1 },
            ],
          },
        ],
      },
    ],
  });
  const extensions = ownProjectData({ retained: { values: [1, 2, 3] } });
  const baseline = metadata('Board', board, extensions);
  const unchanged = metadata('Board', board, extensions);
  const changedBoard = ownProjectData(
    {
      ...board,
      tracks: board.tracks.map((track, index) =>
        index === 399 ? { ...track, width: 0.6 } : track,
      ),
    },
    board,
  );
  const changed = metadata('Board', changedBoard, extensions);
  assert.equal(projectMetadataEqual(baseline, unchanged), true);
  assert.equal(projectMetadataEqual(baseline, changed), false);
  assert.equal(projectMetadataEqual(baseline, metadata('Board', board, extensions)), true);
  assert.equal(
    projectMetadataEqual(baseline, metadata('Board', board, { retained: { values: [1, 2, 4] } })),
    false,
  );
  const reordered = metadata('Board', { zones: board.zones, tracks: board.tracks }, extensions);
  assert.equal(projectMetadataEqual(baseline, reordered), oldEqual(baseline, reordered));
  const stringify = JSON.stringify;
  JSON.stringify = () => {
    throw new Error('Dirty comparison must not materialize JSON.');
  };
  try {
    assert.equal(projectMetadataEqual(baseline, unchanged), true);
    assert.equal(projectMetadataEqual(baseline, changed), false);
  } finally {
    JSON.stringify = stringify;
  }
});

test('caller freezing does not grant cached equality or retain a stale comparison', () => {
  const mutable = { points: [{ x: 1, y: 2 }] };
  const frozen = Object.freeze({ geometry: mutable });
  const current = metadata('A', frozen, {});
  const saved = metadata('A', { geometry: { points: [{ x: 1, y: 2 }] } }, {});
  assert.equal(projectMetadataEqual(current, saved), true);
  mutable.points[0].x = 3;
  assert.equal(projectMetadataEqual(current, saved), false);
  assert.equal(projectMetadataEqual(current, saved), oldEqual(current, saved));
});
