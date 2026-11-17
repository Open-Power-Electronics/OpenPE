import assert from 'node:assert/strict';
import test from 'node:test';
import { createPart, emptyCircuit, pinPositions, uid, type Circuit } from '../lib/circuit';
import { ownProject } from '../lib/immutable-project';
import { createProject } from '../lib/project';
import { projectNetGroups } from '../lib/project-net-groups';
import { moveSelection, rerouteSelectionConnections, simplifyWires } from '../lib/schematic-edit';
import { child, children } from '../lib/sexpr';

function countCosines<T>(operation: () => T) {
  const cosine = Math.cos;
  let count = 0;
  Math.cos = (value) => {
    count++;
    return cosine(value);
  };
  try {
    return { result: operation(), count };
  } finally {
    Math.cos = cosine;
  }
}

test('connected movement reuses owned source pins and computes each changed pose once without caching mutable edits', () => {
  const circuit = emptyCircuit();
  for (let index = 0; index < 20; index++)
    circuit.parts.push(createPart(circuit, 'R', index * 25.4, 25.4));
  const source = ownProject(createProject(circuit)).schematic;
  // Initial canonical grouping already supplies this immutable source's nets.
  projectNetGroups(source);
  const selected = source.parts[0];
  const before = structuredClone(source);
  const cold = countCosines(() =>
    moveSelection(source, [selected.id], { x: 1.27, y: 0 }, true, true),
  );
  // Grouping prepared the owned source pairs; only the changed pose transforms.
  assert.equal(cold.count, 1);
  assert.equal(cold.result.parts[0].x, selected.x + 1.27);
  assert.equal(cold.result.parts[1], source.parts[1]);
  const warm = countCosines(() =>
    moveSelection(source, [selected.id], { x: 2.54, y: 0 }, true, true),
  );
  assert.equal(warm.count, 1);
  assert.deepEqual(source, before);

  const caller = structuredClone(source);
  Object.freeze(caller);
  const first = moveSelection(caller, [selected.id], { x: 1.27, y: 0 }, true);
  caller.parts[0].x += 5.08;
  const changed = moveSelection(caller, [selected.id], { x: 1.27, y: 0 }, true);
  assert.equal(changed.parts[0].x, first.parts[0].x + 5.08);
});

test('wire cleanup rejects right-angle bends before any full-wire contact scan', () => {
  const source = emptyCircuit();
  const bends = 24;
  for (let index = 0; index < bends; index++) {
    const x = index * 50.8;
    source.wires.push(
      { id: uid(), a: { x, y: 0 }, b: { x: x + 10.16, y: 0 } },
      { id: uid(), a: { x: x + 10.16, y: 0 }, b: { x: x + 10.16, y: 10.16 } },
    );
  }
  const absolute = Math.abs;
  let checks = 0;
  Math.abs = (value) => {
    checks++;
    return absolute(value);
  };
  try {
    const result = simplifyWires(source);
    assert.deepEqual(result, source);
    assert.equal(checks, bends, 'Only the cheap collinearity predicate runs for these bends.');
  } finally {
    Math.abs = absolute;
  }
});

test('cheap cleanup filters retain interior contacts, protected anchors and ordered retained UUIDs', () => {
  const line = (): Circuit => {
    const circuit = emptyCircuit();
    circuit.wires = [
      { id: uid(), a: { x: 0, y: 0 }, b: { x: 10.16, y: 0 } },
      { id: uid(), a: { x: 10.16, y: 0 }, b: { x: 20.32, y: 0 } },
    ];
    return circuit;
  };
  const source = line();
  source.wires.push({ id: uid(), a: { x: 10.16, y: -5.08 }, b: { x: 10.16, y: 5.08 } });
  assert.deepEqual(
    simplifyWires(source).wires,
    source.wires,
    'An interior crossing is a third contact.',
  );
  for (const kind of ['label', 'junction', 'no-connect'] as const) {
    const anchored = line();
    const point = { id: uid(), x: 10.16, y: 0 };
    if (kind === 'label') anchored.labels.push({ ...point, text: 'ANCHOR' });
    else if (kind === 'junction') anchored.junctions.push(point);
    else anchored.noConnects = [point];
    assert.deepEqual(simplifyWires(anchored).wires, anchored.wires, kind);
  }
  const joined = line();
  const retained = joined.wires[1].id;
  assert.deepEqual(simplifyWires(joined, [retained]).wires, [
    { id: retained, a: { x: 0, y: 0 }, b: { x: 20.32, y: 0 }, raw: undefined },
  ]);
});

test('private pose reuse still checks a selected shared Part against its current posed library', () => {
  const source = emptyCircuit();
  const selected = createPart(source, 'R', 25.4, 25.4);
  source.parts.push(selected);
  const library = structuredClone(source.libraries[selected.libId]);
  const graphics = children(library, 'symbol').find((node) => children(node, 'pin').length)!;
  const pin = children(graphics, 'pin')[0];
  child(pin, 'at')![1] = String(Number(child(pin, 'at')![1]) + 1.27);
  const posed = { ...source, libraries: { ...source.libraries, [selected.libId]: library } };
  const movedPin = pinPositions(selected, library)[0];
  source.wires = [
    { id: uid(), a: { x: movedPin.x - 5.08, y: movedPin.y }, b: movedPin },
    { id: uid(), a: movedPin, b: { x: movedPin.x + 5.08, y: movedPin.y } },
  ];
  posed.wires = source.wires;
  const before = structuredClone(source);
  const result = rerouteSelectionConnections(source, posed, [selected.id], true);
  assert.equal(
    result.wires.length,
    2,
    'The current posed pin still protects the simplification joint.',
  );
  assert.deepEqual(source, before);

  const extraPin = structuredClone(pin);
  child(extraPin, 'number')![1] = '"99"';
  graphics.push(extraPin);
  for (let attempt = 0; attempt < 2; attempt++)
    assert.throws(
      () => rerouteSelectionConnections(source, posed, [selected.id], true),
      /changed its pins/,
    );
  assert.deepEqual(source, before, 'A rejected pose remains atomic and retryable.');
});
