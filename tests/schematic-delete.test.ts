import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPart,
  emptyCircuit,
  parseCircuit,
  pinPositions,
  serializeCircuit,
  uid,
  type Circuit,
  type Point,
} from '../lib/circuit';
import { fieldId, removeSelection } from '../lib/schematic-edit';
import { applyProposal } from '../lib/proposals';
import { createProject, exportKiCad, parseProject, serializeProject } from '../lib/project';
import { child, val } from '../lib/sexpr';
import { samePoint } from '../lib/wiring';

const wire = (d: Circuit, a: Point, b: Point) => {
  const w = { id: uid(), a, b };
  d.wires.push(w);
  return w;
};
function fixture() {
  const d = emptyCircuit();
  for (const [kind, x] of [
    ['R', 25.4],
    ['C', 76.2],
    ['L', 127],
  ] as const) {
    const p = createPart(d, kind, x, 25.4);
    p.rotation = 180;
    d.parts.push(p);
  }
  const pins = d.parts.map((p) => pinPositions(p, d.libraries[p.libId])[0]);
  return { d, pins };
}
function both(d: Circuit, ids: string[]) {
  const manual = removeSelection(d, ids);
  const agent = applyProposal(
    d,
    d.parts
      .filter((p) => ids.includes(p.id))
      .map((p) => ({ type: 'removePart' as const, ref: p.ref })),
  );
  assert.deepEqual(agent, manual, 'manual and Agent removals share the exact cleanup');
  return manual;
}

test('manual and Agent deletion remove a complete bent lead, orphan labels and pin markers without changing the source', () => {
  const {
    d,
    pins: [a, b],
  } = fixture();
  wire(d, a, { x: a.x, y: 50.8 });
  wire(d, { x: a.x, y: 50.8 }, { x: b.x, y: 50.8 });
  wire(d, { x: b.x, y: 50.8 }, b);
  d.labels.push({ id: uid(), x: 50.8, y: 50.8, text: 'LEAD' });
  d.junctions.push({ id: uid(), x: a.x, y: 50.8 });
  const freePin = pinPositions(d.parts[0], d.libraries[d.parts[0].libId])[1];
  d.noConnects = [{ id: uid(), ...freePin }];
  const before = structuredClone(d);
  const removed = both(d, [d.parts[0].id]);
  assert.deepEqual(d, before);
  assert.deepEqual(removed.parts, before.parts.slice(1));
  assert.deepEqual(removed.wires, []);
  assert.deepEqual(removed.labels, []);
  assert.deepEqual(removed.junctions, []);
  assert.deepEqual(removed.noConnects, []);
  for (const reopened of [
    parseProject(serializeProject(createProject(removed))).schematic,
    parseCircuit(exportKiCad(createProject(removed), 'schematic')),
  ]) {
    assert.deepEqual(
      reopened.parts.map((p) => p.id),
      before.parts.slice(1).map((p) => p.id),
    );
    assert.deepEqual(reopened.wires, []);
  }
});

test('deletion stops at a shared T branch and preserves the other components and source wires exactly', () => {
  const {
    d,
    pins: [a, b, c],
  } = fixture();
  const tee = { x: b.x, y: 50.8 };
  wire(d, a, { x: a.x, y: 50.8 });
  wire(d, { x: a.x, y: 50.8 }, tee);
  wire(d, b, tee);
  wire(d, tee, { x: c.x, y: 50.8 });
  wire(d, { x: c.x, y: 50.8 }, c);
  d.junctions.push({ id: uid(), ...tee });
  d.labels.push({ id: uid(), ...tee, text: 'SHARED' });
  const imported = parseCircuit(serializeCircuit(d));
  const removed = both(imported, [d.parts[0].id]);
  assert.deepEqual(removed.wires, imported.wires.slice(2));
  assert.deepEqual(removed.junctions, imported.junctions);
  assert.deepEqual(removed.labels, imported.labels);
  assert.deepEqual(removed.parts, imported.parts.slice(1));
});

test('a branch ending inside an unsplit trunk leaves the trunk intact and incidental crossings do not join cleanup', () => {
  const {
    d,
    pins: [a, b, c],
  } = fixture();
  const tee = { x: 101.6, y: b.y };
  const trunk = wire(d, b, c);
  wire(d, a, { x: a.x, y: 50.8 });
  wire(d, { x: a.x, y: 50.8 }, { x: tee.x, y: 50.8 });
  wire(d, { x: tee.x, y: 50.8 }, tee);
  const crossing = wire(d, { x: 50.8, y: 40.64 }, { x: 50.8, y: 60.96 });
  const removed = both(d, [d.parts[0].id]);
  assert.deepEqual(removed.wires, [trunk, crossing]);
});

test('partial deletion of an unsplit lead preserves its shared remainder, UUID and imported stroke metadata', () => {
  const {
    d,
    pins: [a, b, c],
  } = fixture();
  const tee = { x: 50.8, y: a.y };
  const lead = wire(d, a, b);
  wire(d, tee, { x: tee.x, y: 50.8 });
  wire(d, { x: tee.x, y: 50.8 }, { x: c.x, y: 50.8 });
  wire(d, { x: c.x, y: 50.8 }, c);
  const imported = parseCircuit(serializeCircuit(d));
  child(child(imported.wires[0].raw!, 'stroke')!, 'width')![1] = '0.5';
  const removed = both(imported, [d.parts[0].id]);
  const retained = removed.wires.find((w) => w.id === lead.id)!;
  assert.ok(samePoint(retained.a, tee));
  assert.deepEqual(retained.b, b);
  assert.deepEqual(retained.raw, imported.wires[0].raw);
  assert.deepEqual(removed.wires.slice(1), imported.wires.slice(1));
  const native = parseCircuit(exportKiCad(createProject(removed), 'schematic'));
  assert.equal(val(child(child(native.wires[0].raw!, 'stroke')!, 'width')), '0.5');
  assert.equal(val(child(native.wires[0].raw!, 'uuid')), lead.id);
});

test('shared pins and pass-through terminals preserve connections still used by remaining components', () => {
  const {
    d,
    pins: [a, b],
  } = fixture();
  Object.assign(d.parts[2], { x: d.parts[0].x, y: d.parts[0].y });
  const shared = wire(d, a, b);
  d.labels.push({ id: uid(), ...a, text: 'SHARED' });
  assert.deepEqual(both(d, [d.parts[0].id]).wires, [shared]);
  assert.deepEqual(both(d, [d.parts[0].id]).labels, d.labels);
  const pass = fixture();
  const [left, middle, right] = pass.pins;
  wire(pass.d, left, middle);
  wire(pass.d, middle, right);
  assert.deepEqual(both(pass.d, [pass.d.parts[1].id]).wires, pass.d.wires);
});

test('deleting a group prunes its formerly shared leads and complete unanchored loops, retaining unrelated drawing', () => {
  const {
    d,
    pins: [a, b, c],
  } = fixture();
  const tee = { x: b.x, y: 50.8 };
  wire(d, a, { x: a.x, y: 50.8 });
  wire(d, { x: a.x, y: 50.8 }, tee);
  wire(d, b, tee);
  wire(d, tee, { x: c.x, y: 50.8 });
  wire(d, { x: c.x, y: 50.8 }, c);
  const unrelated = wire(d, { x: 0, y: 0 }, { x: 10.16, y: 0 });
  assert.deepEqual(
    both(
      d,
      d.parts.slice(0, 2).map((p) => p.id),
    ).wires,
    [unrelated],
  );
  const loop = fixture();
  const pin = loop.pins[0];
  const corner = { x: pin.x + 10.16, y: pin.y + 10.16 };
  wire(loop.d, pin, { x: corner.x, y: pin.y });
  wire(loop.d, { x: corner.x, y: pin.y }, corner);
  wire(loop.d, corner, { x: pin.x, y: corner.y });
  wire(loop.d, { x: pin.x, y: corner.y }, pin);
  assert.deepEqual(both(loop.d, [loop.d.parts[0].id]).wires, []);
});

test('wire-only and text-only selection keep existing deletion scope, and failed Agent batches remain atomic', () => {
  const {
    d,
    pins: [a, b],
  } = fixture();
  const lead = wire(d, a, b);
  const unrelated = wire(d, { x: 0, y: 0 }, { x: 10.16, y: 0 });
  const explicit = removeSelection(d, [lead.id]);
  assert.deepEqual(explicit.parts, d.parts);
  assert.deepEqual(explicit.wires, [unrelated]);
  assert.deepEqual(removeSelection(d, [fieldId(d.parts[0].id, 'Reference')]), d);
  const before = structuredClone(d);
  assert.throws(
    () =>
      applyProposal(d, [
        { type: 'removePart', ref: d.parts[0].ref },
        { type: 'removePart', ref: 'R999' },
      ]),
    /Cannot find/,
  );
  assert.deepEqual(d, before);
});
