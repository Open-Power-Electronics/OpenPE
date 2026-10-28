import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyCircuit, uid, type Point } from '../lib/circuit';
import { commitWireRoute } from '../lib/wiring';
import {
  backtrackSchematicWireDraft,
  createSchematicWireDraft,
  extendSchematicWireDraft,
  previewSchematicWireDraft,
  schematicWireDraftPointLimit,
  toggleSchematicWirePosture,
  type SchematicWireDraft,
} from '../lib/schematic-wire-draft';

test('a new draft preserves exact pin coordinates and owns a copy of its starting point', () => {
  const start = { x: 10.636, y: -8.255 },
    draft = createSchematicWireDraft(start, true);
  assert.deepEqual(draft.points, [start]);
  assert.equal(draft.vertical, true);
  assert.deepEqual(draft.checkpoints, []);
  start.x = 100;
  assert.deepEqual(draft.points, [{ x: 10.636, y: -8.255 }]);
  assert.deepEqual(previewSchematicWireDraft(draft, null), draft.points);
  assert.equal(backtrackSchematicWireDraft(draft), null);
});

test('both postures preview the exact live head without adding document or draft history', () => {
  const head = { x: 10.636, y: 8.255 },
    horizontal = createSchematicWireDraft({ x: 0, y: 0 }),
    vertical = toggleSchematicWirePosture(horizontal),
    before = structuredClone(horizontal);
  assert.deepEqual(previewSchematicWireDraft(horizontal, head), [
    { x: 0, y: 0 },
    { x: head.x, y: 0 },
    head,
  ]);
  assert.deepEqual(previewSchematicWireDraft(vertical, head), [
    { x: 0, y: 0 },
    { x: 0, y: head.y },
    head,
  ]);
  previewSchematicWireDraft(horizontal, { x: 20.32, y: -3.81 });
  assert.deepEqual(horizontal, before);
  assert.equal(vertical.points, horizontal.points);
  assert.equal(vertical.checkpoints, horizontal.checkpoints);
});

test('each backtrack restores the entire previous click and posture, including generated elbows', () => {
  const initial = createSchematicWireDraft({ x: 0, y: 0 }),
    first = extendSchematicWireDraft(initial, { x: 10.16, y: 10.16 }),
    beforeSecond = toggleSchematicWirePosture(first),
    second = extendSchematicWireDraft(beforeSecond, { x: 20.32, y: 20.32 }),
    beforeThird = toggleSchematicWirePosture(second),
    third = extendSchematicWireDraft(beforeThird, { x: 30.48, y: 30.48 });
  assert.deepEqual(third.points, [
    { x: 0, y: 0 },
    { x: 10.16, y: 0 },
    { x: 10.16, y: 10.16 },
    { x: 10.16, y: 20.32 },
    { x: 20.32, y: 20.32 },
    { x: 30.48, y: 20.32 },
    { x: 30.48, y: 30.48 },
  ]);
  const restoredThird = backtrackSchematicWireDraft(third)!;
  assert.deepEqual(restoredThird, beforeThird);
  const restoredSecond = backtrackSchematicWireDraft(restoredThird)!;
  assert.deepEqual(restoredSecond, beforeSecond);
  const restoredFirst = backtrackSchematicWireDraft(restoredSecond)!;
  assert.deepEqual(restoredFirst, initial);
  assert.equal(backtrackSchematicWireDraft(restoredFirst), null);
  assert.equal(third.points.length, 7);
  assert.equal(third.checkpoints.length, 3);
});

test('posture changes affect only the live leg and backtracking restores the posture recorded at the last click', () => {
  const initial = createSchematicWireDraft({ x: 1.27, y: 2.54 }, true),
    first = extendSchematicWireDraft(initial, { x: 8.89, y: 10.16 }),
    toggled = toggleSchematicWirePosture(first),
    head = { x: 15.24, y: 17.78 };
  assert.deepEqual(
    previewSchematicWireDraft(toggled, head).slice(0, first.points.length),
    first.points,
  );
  assert.deepEqual(previewSchematicWireDraft(toggled, head).slice(first.points.length), [
    { x: head.x, y: 10.16 },
    head,
  ]);
  assert.deepEqual(backtrackSchematicWireDraft(toggled), initial);
  assert.deepEqual(toggleSchematicWirePosture(toggled), first);
});

test('duplicate clicks and axis-aligned clicks add no redundant elbow or checkpoint', () => {
  for (const vertical of [false, true]) {
    const initial = createSchematicWireDraft({ x: 0, y: 0 }, vertical);
    assert.equal(extendSchematicWireDraft(initial, { x: 0, y: 0 }), initial);
    assert.equal(extendSchematicWireDraft(initial, { x: 0.00001, y: 0.00001 }), initial);
    const horizontal = extendSchematicWireDraft(initial, { x: 10.16, y: 0 });
    assert.deepEqual(horizontal.points, [
      { x: 0, y: 0 },
      { x: 10.16, y: 0 },
    ]);
    assert.equal(horizontal.checkpoints.length, 1);
    assert.equal(extendSchematicWireDraft(horizontal, { x: 10.16, y: 0 }), horizontal);
    assert.deepEqual(backtrackSchematicWireDraft(horizontal), initial);
    const upright = extendSchematicWireDraft(initial, { x: 0, y: 10.16 });
    assert.deepEqual(upright.points, [
      { x: 0, y: 0 },
      { x: 0, y: 10.16 },
    ]);
    assert.equal(upright.checkpoints.length, 1);
  }
});

test('returning to an earlier waypoint stays a distinct click and backtracks by checkpoint rather than coordinate', () => {
  const initial = createSchematicWireDraft({ x: 0, y: 0 }),
    first = extendSchematicWireDraft(initial, { x: 10.16, y: 0 }),
    second = extendSchematicWireDraft(first, { x: 10.16, y: 10.16 }),
    loop = extendSchematicWireDraft(second, { x: 0, y: 0 });
  assert.deepEqual(loop.points, [
    { x: 0, y: 0 },
    { x: 10.16, y: 0 },
    { x: 10.16, y: 10.16 },
    { x: 0, y: 10.16 },
    { x: 0, y: 0 },
  ]);
  assert.deepEqual(backtrackSchematicWireDraft(loop), second);
});

test('Enter commits the visible head and all locked waypoints once, including a draft with no intermediate clicks', () => {
  for (const waypoints of [
    [],
    [
      { x: 10.16, y: 10.16 },
      { x: 20.32, y: 10.16 },
    ],
  ]) {
    const source = emptyCircuit(),
      before = structuredClone(source),
      head = { x: 30.48, y: 20.32 };
    let draft = createSchematicWireDraft({ x: 0, y: 0 });
    for (const waypoint of waypoints) draft = extendSchematicWireDraft(draft, waypoint);
    const preview = previewSchematicWireDraft(draft, head),
      committed = commitWireRoute(source, preview);
    assert.deepEqual(preview.at(-1), head);
    assert.deepEqual(
      committed.wires.map((wire) => wire.a),
      preview.slice(0, -1),
    );
    assert.deepEqual(
      committed.wires.map((wire) => wire.b),
      preview.slice(1),
    );
    assert.deepEqual(source, before);
  }
});

test('draft previews and backtracking never introduce a junction at an incidental existing-wire crossing', () => {
  const source = emptyCircuit(),
    existing = { id: uid(), a: { x: 5.08, y: -5.08 }, b: { x: 5.08, y: 5.08 } };
  source.wires.push(existing);
  const before = structuredClone(source),
    initial = createSchematicWireDraft({ x: 0, y: 0 }),
    first = extendSchematicWireDraft(initial, { x: 10.16, y: 0 }),
    discarded = extendSchematicWireDraft(first, { x: 20.32, y: 10.16 }),
    restored = backtrackSchematicWireDraft(discarded)!,
    committed = commitWireRoute(
      source,
      previewSchematicWireDraft(restored, { x: 10.16, y: 10.16 }),
    );
  assert.equal(committed.wires.length, 3);
  assert.deepEqual(
    committed.wires.find((wire) => wire.id === existing.id),
    existing,
  );
  assert.deepEqual(committed.junctions, []);
  assert.deepEqual(source, before);
});

test('the returned preview is an independent commit payload rather than mutable draft storage', () => {
  const target = { x: 10.16, y: 10.16 },
    draft = extendSchematicWireDraft(createSchematicWireDraft({ x: 0, y: 0 }), target),
    before = structuredClone(draft),
    preview = previewSchematicWireDraft(draft, { x: 20.32, y: 20.32 });
  target.x = 100;
  preview[0].x = 200;
  preview.at(-1)!.y = 300;
  preview.push({ x: 400, y: 400 });
  assert.deepEqual(draft, before);
});

test('draft memory is bounded and an oversized live leg or click fails atomically', () => {
  const points: Point[] = Array.from({ length: schematicWireDraftPointLimit - 1 }, (_, index) => ({
      x: index,
      y: 0,
    })),
    draft: SchematicWireDraft = { points, vertical: false, checkpoints: [] },
    tail = points.at(-1)!,
    diagonal = { x: tail.x + 1, y: 1 };
  assert.throws(() => extendSchematicWireDraft(draft, diagonal), /30,000 anchors/);
  assert.throws(() => previewSchematicWireDraft(draft, diagonal), /30,000 anchors/);
  assert.equal(draft.points, points);
  assert.equal(draft.checkpoints.length, 0);
  const limit = extendSchematicWireDraft(draft, { x: tail.x + 1, y: 0 });
  assert.equal(limit.points.length, schematicWireDraftPointLimit);
  assert.equal(
    previewSchematicWireDraft(limit, limit.points.at(-1)!).length,
    schematicWireDraftPointLimit,
  );
  assert.throws(() => extendSchematicWireDraft(limit, { x: tail.x + 2, y: 0 }), /30,000 anchors/);
  assert.deepEqual(backtrackSchematicWireDraft(limit), draft);
  assert.equal(previewSchematicWireDraft(limit, null).length, schematicWireDraftPointLimit);
});

test('invalid coordinates and damaged checkpoints fail without changing an accepted draft', () => {
  const draft = extendSchematicWireDraft(createSchematicWireDraft({ x: -100_000, y: 100_000 }), {
      x: 0,
      y: 0,
    }),
    before = structuredClone(draft);
  for (const point of [
    { x: NaN, y: 0 },
    { x: 0, y: Infinity },
    { x: 100_001, y: 0 },
    { x: 0, y: -100_001 },
  ]) {
    assert.throws(() => createSchematicWireDraft(point), /Wire coordinates/);
    assert.throws(() => extendSchematicWireDraft(draft, point), /Wire coordinates/);
    assert.throws(() => previewSchematicWireDraft(draft, point), /Wire coordinates/);
  }
  assert.throws(
    () =>
      backtrackSchematicWireDraft({ ...draft, checkpoints: [{ pointCount: 0, vertical: false }] }),
    /checkpoint/,
  );
  assert.deepEqual(draft, before);
});
