import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPart,
  emptyCircuit,
  parseCircuit,
  pinPositions,
  uid,
  type Circuit,
  type Label,
  type Point,
} from '../lib/circuit';
import { moveSelection } from '../lib/schematic-edit';
import { createProject, exportKiCad, parseProject, serializeProject } from '../lib/project';
import { projectNetGroups } from '../lib/project-net-groups';
import { child, val } from '../lib/sexpr';
import { onWire, samePoint } from '../lib/wiring';

// Pin-only comparisons cannot detect a detached label when the remaining wire
// still joins the same pins. Include every label's stable identity in its net.
const topology = (d: Circuit) =>
  projectNetGroups(d)
    .map((group) =>
      [...group.pins, ...group.labels.map((index) => `label:${d.labels[index].id}`)].sort(),
    )
    .filter((members) => members.length)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const native = (d: Circuit) => parseCircuit(exportKiCad(createProject(d), 'schematic'));
const wire = (d: Circuit, a: Point, b: Point) => {
  const next = { id: uid(), a, b };
  d.wires.push(next);
  return next;
};
function portAt(d: Circuit, point: Point) {
  const part = createPart(d, 'Port', point.x, point.y);
  const pin = pinPositions(part, d.libraries[part.libId])[0];
  part.x += point.x - pin.x;
  part.y += point.y - pin.y;
  d.parts.push(part);
  return part;
}
function labelAt(d: Circuit, point: Point, scope: Label['scope']) {
  const label: Label = {
    id: uid(),
    ...point,
    text: 'SIGNAL',
    ...(scope ? { scope, shape: 'input' as const } : {}),
  };
  d.labels.push(label);
  return label;
}
function drag(d: Circuit, id: string, delta: Point) {
  const before = structuredClone(d);
  const moved = moveSelection(d, [id], delta, true);
  assert.deepEqual(d, before, 'the preview must not mutate its source');
  assert.deepEqual(moved.parts, d.parts, 'label drag must keep components stationary');
  for (const segment of moved.wires)
    if (segment.raw) assert.equal(val(child(segment.raw, 'uuid')), segment.id);
  return moved;
}
function assertPreserved(d: Circuit, moved: Circuit, id: string, position: Point) {
  for (const result of [
    moved,
    parseProject(serializeProject(createProject(moved))).schematic,
    native(moved),
  ]) {
    assert.deepEqual(topology(result), topology(d));
    const label = result.labels.find((candidate) => candidate.id === id)!;
    assert.ok(samePoint(label, position));
    assert.equal(label.scope, d.labels.find((candidate) => candidate.id === id)!.scope);
    assert.ok(result.wires.some((segment) => onWire(label, segment)));
    assert.ok(
      result.wires.every((segment) => segment.a.x === segment.b.x || segment.a.y === segment.b.y),
    );
  }
}

for (const scope of [undefined, 'global'] as const) {
  const name = scope || 'local';

  test(`dragging a ${name} endpoint label stretches its wire and retains the fixed pin`, () => {
    for (const reverse of [false, true]) {
      const d = emptyCircuit();
      const fixed = { x: 12.7, y: 25.4 },
        endpoint = { x: 38.1, y: 25.4 };
      portAt(d, fixed);
      const lead = wire(d, reverse ? endpoint : fixed, reverse ? fixed : endpoint);
      const label = labelAt(d, endpoint, scope);
      const source = native(d);
      const moved = drag(source, label.id, { x: 5.08, y: 5.08 });
      assert.ok(moved.wires.some((segment) => segment.id === lead.id));
      assert.ok(
        moved.wires.some((segment) => samePoint(segment.a, fixed) || samePoint(segment.b, fixed)),
      );
      assertPreserved(source, moved, label.id, { x: 43.18, y: 30.48 });
    }
  });

  test(`dragging a ${name} interior label reroutes both sides without detaching its net`, () => {
    for (const reverse of [false, true]) {
      const d = emptyCircuit();
      const a = { x: 12.7, y: 25.4 },
        b = { x: 63.5, y: 25.4 };
      portAt(d, a);
      portAt(d, b);
      const trunk = wire(d, reverse ? b : a, reverse ? a : b);
      const label = labelAt(d, { x: 38.1, y: 25.4 }, scope);
      const source = native(d);
      const moved = drag(source, label.id, { x: 5.08, y: 5.08 });
      assert.ok(moved.wires.some((segment) => segment.id === trunk.id));
      assertPreserved(source, moved, label.id, { x: 43.18, y: 30.48 });
    }
  });

  test(`dragging a ${name} branch label carries its junction and preserves a stationary branch`, () => {
    const d = emptyCircuit();
    const a = { x: 0, y: 40.64 },
      b = { x: 101.6, y: 40.64 },
      tee = { x: 25.4, y: 40.64 },
      fixedTee = { x: 50.8, y: 40.64 },
      branchPin = { x: tee.x, y: 60.96 },
      fixedBranchPin = { x: fixedTee.x, y: 60.96 };
    for (const point of [a, b, branchPin, fixedBranchPin]) portAt(d, point);
    wire(d, a, b);
    wire(d, tee, branchPin);
    const stationary = wire(d, fixedTee, fixedBranchPin);
    const junction = { id: uid(), ...tee },
      fixedJunction = { id: uid(), ...fixedTee };
    d.junctions.push(junction, fixedJunction);
    const label = labelAt(d, tee, scope);
    const source = native(d);
    const moved = drag(source, label.id, { x: 50.8, y: 5.08 });
    assert.ok(
      samePoint(
        moved.junctions.find((candidate) => candidate.id === junction.id)!,
        {
          x: 76.2,
          y: 45.72,
        },
      ),
    );
    assert.ok(
      samePoint(
        moved.junctions.find((candidate) => candidate.id === fixedJunction.id)!,
        fixedTee,
      ),
    );
    assert.deepEqual(
      moved.wires.find((segment) => segment.id === stationary.id),
      source.wires.find((segment) => segment.id === stationary.id),
    );
    assertPreserved(source, moved, label.id, { x: 76.2, y: 45.72 });
  });

  test(`dragging a ${name} label directly on a stationary pin creates its connecting lead`, () => {
    const d = emptyCircuit();
    const pin = { x: 25.4, y: 25.4 };
    portAt(d, pin);
    const label = labelAt(d, pin, scope);
    const source = native(d);
    const moved = drag(source, label.id, { x: 5.08, y: 5.08 });
    assert.equal(source.wires.length, 0);
    assert.ok(moved.wires.length > 0);
    assertPreserved(source, moved, label.id, { x: 30.48, y: 30.48 });
  });

  test(`an unattached ${name} label moves freely without creating wires`, () => {
    const d = emptyCircuit();
    const label = labelAt(d, { x: 25.4, y: 25.4 }, scope);
    const source = native(d);
    const moved = drag(source, label.id, { x: 5.08, y: 5.08 });
    for (const result of [moved, native(moved)]) {
      assert.deepEqual(topology(result), topology(source));
      assert.equal(result.wires.length, 0);
      assert.ok(samePoint(result.labels[0], { x: 30.48, y: 30.48 }));
    }
  });

  test(`explicit disconnected movement of a ${name} label leaves wires in place`, () => {
    const d = emptyCircuit();
    const pin = { x: 12.7, y: 25.4 },
      endpoint = { x: 38.1, y: 25.4 };
    portAt(d, pin);
    wire(d, pin, endpoint);
    const label = labelAt(d, endpoint, scope);
    const source = native(d),
      before = structuredClone(source);
    const moved = moveSelection(source, [label.id], { x: 5.08, y: 5.08 });
    assert.deepEqual(source, before);
    assert.deepEqual(moved.wires, source.wires);
    for (const result of [moved, native(moved)]) {
      const group = projectNetGroups(result).find((candidate) => candidate.labels.length)!;
      assert.equal(group.pins.length, 0, 'explicit Move may detach the label');
      assert.equal(group.wires.length, 0);
      assert.ok(samePoint(result.labels[0], { x: 43.18, y: 30.48 }));
    }
  });
}
