import test from 'node:test';
import assert from 'node:assert/strict';
import { createPart, emptyCircuit, pinPositions, uid } from '../lib/circuit';
import { ownProjectData } from '../lib/immutable-project';
import { projectNetGroups } from '../lib/project-net-groups';

function fixture() {
  const circuit = emptyCircuit();
  const part = createPart(circuit, 'R', 10.16, 10.16);
  circuit.parts.push(part);
  const pins = pinPositions(part, circuit.libraries[part.libId]);
  circuit.wires = [{ id: uid(), a: pins[0], b: pins[1] }];
  circuit.labels = [{ id: uid(), ...pins[0], text: 'NET' }];
  circuit.junctions = [{ id: uid(), ...pins[1] }];
  return circuit;
}

test('owned grouping reuses exact circuit geometry without exposing mutable cache containers', () => {
  const circuit = ownProjectData(fixture());
  const expected = projectNetGroups(structuredClone(circuit));
  const groups = projectNetGroups(circuit);
  assert.deepEqual(groups, expected);
  for (const group of groups) {
    group.wires.push(999);
    group.junctions.length = 0;
    group.labels.reverse();
    group.pins.push('poison');
  }
  groups.length = 0;
  assert.deepEqual(projectNetGroups(circuit), expected);

  const moved = ownProjectData({
    ...circuit,
    parts: circuit.parts.map((part) => ({ ...part, x: part.x + 100 })),
  });
  assert.equal(moved.wires, circuit.wires);
  assert.equal(moved.junctions, circuit.junctions);
  assert.deepEqual(projectNetGroups(moved), projectNetGroups(structuredClone(moved)));
  assert.notDeepEqual(projectNetGroups(moved), expected);
  assert.deepEqual(projectNetGroups(circuit), expected);
});

test('caller freezing never certifies mutable grouping geometry or embedded pin definitions', () => {
  const circuit = fixture();
  Object.freeze(circuit);
  const before = projectNetGroups(circuit);
  circuit.parts[0].x += 100;
  assert.notDeepEqual(projectNetGroups(circuit), before);
  assert.deepEqual(projectNetGroups(circuit), projectNetGroups(structuredClone(circuit)));
  circuit.labels[0].text = 'OTHER';
  assert.deepEqual(projectNetGroups(circuit), projectNetGroups(structuredClone(circuit)));
});
