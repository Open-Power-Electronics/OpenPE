import test from 'node:test';
import assert from 'node:assert/strict';
import { createPart, emptyCircuit, parseCircuit, serializeCircuit, uid } from '../lib/circuit';
import { compareSchematicVersions } from '../lib/schematic-version-diff';

function fixture() {
  const circuit = emptyCircuit();
  circuit.parts.push(createPart(circuit, 'R', 25.4, 25.4));
  circuit.wires.push({ id: uid(), a: { x: 25.4, y: 21.59 }, b: { x: 25.4, y: 12.7 } });
  circuit.labels.push({ id: uid(), text: 'IN', x: 25.4, y: 12.7 });
  circuit.junctions.push({ id: uid(), x: 25.4, y: 12.7 });
  circuit.noConnects = [{ id: uid(), x: 25.4, y: 29.21 }];
  // Include real native raw records to exercise stale raw after live edits.
  return parseCircuit(serializeCircuit(circuit));
}

test('schematic comparison follows stable IDs and materializes live values and geometry without writes', () => {
  const before = fixture(),
    after = structuredClone(before);
  const original = JSON.stringify(before);
  after.parts[0].value = '4.7k';
  after.parts[0].x += 1.27;
  after.wires[0].b.x += 1.27;
  after.labels[0].text = 'INPUT';
  after.junctions[0].y += 1.27;
  after.noConnects![0].x += 1.27;
  const addition = createPart(after, 'C', 50.8, 25.4);
  after.parts.unshift(addition);
  const diff = compareSchematicVersions(before, after);
  assert.equal(diff.size, 6);
  for (const item of [
    before.parts[0],
    before.wires[0],
    before.labels[0],
    before.junctions[0],
    before.noConnects![0],
  ])
    assert.equal(diff.get(item.id), 'changed');
  assert.equal(diff.get(addition.id), 'added');
  assert.equal(JSON.stringify(before), original);
  assert.equal(compareSchematicVersions(before, structuredClone(before)).size, 0);
  after.parts.reverse();
  assert.deepEqual(
    compareSchematicVersions(before, after),
    diff,
    'Native object ordering does not mark unchanged objects.',
  );
  after.parts = after.parts.filter((part) => part.id !== before.parts[0].id);
  assert.equal(compareSchematicVersions(before, after).get(before.parts[0].id), 'removed');
});

test('library changes mark their instances and missing/empty sheets compare completely', () => {
  const before = fixture(),
    after = structuredClone(before);
  const part = before.parts[0];
  after.libraries[part.libId].push(['property', 'Description', 'Updated library']);
  assert.deepEqual([...compareSchematicVersions(before, after)], [[part.id, 'changed']]);
  const added = compareSchematicVersions(undefined, before);
  assert.equal(added.size, 5);
  assert.ok([...added.values()].every((kind) => kind === 'added'));
  assert.ok(
    [...compareSchematicVersions(before, undefined).values()].every((kind) => kind === 'removed'),
  );
  assert.equal(compareSchematicVersions(emptyCircuit(), emptyCircuit()).size, 0);
});

test('free text and its native appearance changes receive their own stable highlights', () => {
  const before = fixture(),
    textId = uid();
  before.original!.push([
    'text',
    'Before',
    ['at', '10', '10', '0'],
    ['effects', ['font', ['size', '1.27', '1.27']]],
    ['uuid', textId],
  ]);
  const after = structuredClone(before);
  const text = after.original!.find(
    (node) => Array.isArray(node) && node[0] === 'text',
  ) as unknown[];
  text[1] = 'After';
  assert.deepEqual([...compareSchematicVersions(before, after)], [[textId, 'changed']]);
});
