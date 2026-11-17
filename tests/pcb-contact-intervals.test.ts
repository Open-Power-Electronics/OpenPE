import assert from 'node:assert/strict';
import test from 'node:test';
import { createPCBContactIntervals } from '../lib/pcb-contact-intervals';

test('stationary interval queries retain exact padded contact candidates and their input order', () => {
  const items = Array.from({ length: 1025 }, (_, index) => {
    const minX = ((index * 173) % 1025) / 3 - 200;
    return { id: index, minX, maxX: minX + (index % 17 ? index % 5 : 300) };
  });
  for (const ordered of [items, [...items].sort((a, b) => a.minX - b.minX)]) {
    const query = createPCBContactIntervals(ordered);
    for (const tolerance of [0, 0.000001, 0.25])
      for (let sample = -220; sample < 250; sample += 3.7) {
        const actual: typeof items = [];
        query(sample, sample + 0.2, tolerance, (item) => actual.push(item));
        assert.deepEqual(
          actual,
          ordered.filter(
            (item) => item.minX <= sample + 0.2 + tolerance && item.maxX + tolerance >= sample,
          ),
        );
      }
  }
});

test('zero-length, touching and near-epsilon bounds keep the original inclusive comparisons', () => {
  const items = [-200000, -0.000001, 0, 0.000001, 200000].flatMap((minX) =>
    [0, 0.000001, 0.1].map((width) => ({ minX, maxX: minX + width })),
  );
  const query = createPCBContactIntervals(items);
  for (const item of items)
    for (const tolerance of [0, 0.000001]) {
      const actual: typeof items = [];
      query(item.minX, item.maxX, tolerance, (value) => actual.push(value));
      assert.deepEqual(
        actual,
        items.filter(
          (value) => value.minX <= item.maxX + tolerance && value.maxX + tolerance >= item.minX,
        ),
      );
    }
  createPCBContactIntervals([])(0, 1, 0, () => assert.fail('An empty board has no contacts.'));
});

test('private interval preparation detaches its order and bounds; bad queries cannot poison retries', () => {
  const item = { minX: 0, maxX: 1 };
  const items = [item];
  const query = createPCBContactIntervals(items);
  items.length = 0;
  item.minX = 100;
  const hits: typeof items = [];
  for (const args of [
    [NaN, 1, 0],
    [0, Infinity, 0],
    [2, 1, 0],
    [0, 1, -1],
  ])
    assert.throws(() => query(args[0], args[1], args[2], () => {}), /finite and ordered/);
  query(0, 1, 0, (value) => hits.push(value));
  assert.deepEqual(hits, [item]);
  for (const value of [
    { minX: NaN, maxX: 1 },
    { minX: 0, maxX: Infinity },
    { minX: 2, maxX: 1 },
  ])
    assert.throws(() => createPCBContactIntervals([value]), /finite and ordered/);
});
