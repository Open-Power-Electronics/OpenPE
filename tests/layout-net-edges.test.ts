import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLayoutNetEdges } from '../components/layoutNetEdges';

test('endpoint-only previews retain a detached net-only presentation', () => {
  const prepare = createLayoutNetEdges();
  const source = [
    { netId: 'N1', start: { x: 0, y: 0 }, end: { x: 1, y: 1 } },
    { netId: 'N1', start: { x: 2, y: 2 }, end: { x: 3, y: 3 } },
    { netId: 'N2', start: { x: 4, y: 4 }, end: { x: 5, y: 5 } },
  ];
  const before = structuredClone(source);
  const first = prepare.prepare(source, null);
  assert.deepEqual(first, [{ netId: 'N1' }, { netId: 'N1' }, { netId: 'N2' }]);
  assert.ok(Object.isFrozen(first));
  assert.ok(first.every(Object.isFrozen));
  const moved = source.map((edge) => ({ ...edge, end: { x: 10, y: 20 } }));
  assert.equal(prepare.prepare(moved, first), first);
  assert.deepEqual(source, before);
  assert.notEqual(first[0], source[0]);
});

test('membership, edge counts and ordering update the presentation', () => {
  const prepare = createLayoutNetEdges();
  const source = [{ netId: 'A' }, { netId: 'B' }];
  const first = prepare.prepare(source, null);
  for (const changed of [
    [{ netId: 'A' }, { netId: 'A' }],
    [...source, { netId: 'B' }],
    source.slice(0, 1),
    [...source].reverse(),
  ]) {
    const next = prepare.prepare(changed, first);
    assert.notEqual(next, first);
    assert.deepEqual(next, changed);
  }
});

test('mutable and shallow-frozen input containers cannot hide changed net membership', () => {
  const prepare = createLayoutNetEdges();
  for (const freeze of [false, true]) {
    const source = [{ netId: 'A' }];
    if (freeze) Object.freeze(source);
    const first = prepare.prepare(source, null);
    source[0].netId = 'B';
    const next = prepare.prepare(source, first);
    assert.notEqual(next, first);
    assert.deepEqual(next, [{ netId: 'B' }]);
    assert.deepEqual(first, [{ netId: 'A' }]);
  }
});

test("foreign or caller-frozen copies are not this factory's committed snapshots", () => {
  const prepare = createLayoutNetEdges();
  const source = [{ netId: 'A' }];
  const foreign = createLayoutNetEdges().prepare(source, null);
  const forged = Object.freeze(source.map((edge) => Object.freeze({ ...edge })));
  assert.notEqual(prepare.prepare(source, foreign), foreign);
  assert.notEqual(prepare.prepare(source, forged), forged);
  const own = prepare.prepare(source, null);
  assert.equal(prepare.prepare(source, own), own);
});

test("abandoned preparation cannot replace the caller's committed baseline", () => {
  const prepare = createLayoutNetEdges();
  const first = prepare.prepare([{ netId: 'A' }], null);
  const abandoned = prepare.prepare([{ netId: 'B' }], first);
  assert.equal(prepare.prepare([{ netId: 'A' }], first), first);
  assert.equal(prepare.prepare([{ netId: 'B' }], abandoned), abandoned);
});

test('empty or failed connectivity clears old counts and can retain an empty snapshot', () => {
  const prepare = createLayoutNetEdges();
  const first = prepare.prepare([{ netId: 'A' }], null);
  const empty = prepare.prepare([], first);
  assert.deepEqual(empty, []);
  assert.notEqual(empty, first);
  assert.equal(prepare.prepare([], empty), empty);
  assert.deepEqual(prepare.prepare([{ netId: 'unknown-net' }], empty), [{ netId: 'unknown-net' }]);
});
