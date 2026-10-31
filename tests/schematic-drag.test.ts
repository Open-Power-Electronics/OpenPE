import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createPart,
  emptyCircuit,
  parseCircuit,
  pinPositions,
  uid,
  type Circuit,
  type Point,
} from '../lib/circuit';
import { moveSelection } from '../lib/schematic-edit';
import { previewSchematicMove } from '../lib/schematic-move';
import { createProject, exportKiCad, parseProject, serializeProject } from '../lib/project';
import { projectFromNativeFiles } from '../lib/kicad-project';
import { projectNetGroups } from '../lib/project-net-groups';
import { ProjectCore } from '../core/project-core';
import { child, val } from '../lib/sexpr';
import { onWire, samePoint } from '../lib/wiring';

const topology = (d: Circuit) =>
  projectNetGroups(d)
    .map((group) => ({
      pins: [...group.pins].sort(),
      labels: group.labels
        .map((index) => [d.labels[index].id, d.labels[index].text])
        .sort((a, b) => a[0].localeCompare(b[0])),
    }))
    .filter((group) => group.pins.length || group.labels.length)
    .map((group) => JSON.stringify(group))
    .sort();
const wire = (d: Circuit, a: Point, b: Point) => {
  const w = { id: uid(), a, b };
  d.wires.push(w);
  return w;
};
function fixture() {
  const d = emptyCircuit();
  d.parts.push(createPart(d, 'R', 25.4, 25.4), createPart(d, 'C', 76.2, 25.4));
  for (const p of d.parts) p.rotation = 180;
  const [a, b] = d.parts.map((p) => pinPositions(p, d.libraries[p.libId])[0]);
  wire(d, a, { x: a.x, y: 40.64 });
  const middle = wire(d, { x: a.x, y: 40.64 }, { x: b.x, y: 40.64 });
  wire(d, { x: b.x, y: 40.64 }, b);
  d.labels.push({ id: uid(), x: 50.8, y: 40.64, text: 'SIGNAL' });
  return { d, a, b, middle };
}

for (const pose of [
  { name: 'horizontal leads', target: { x: 167.64, y: 74.93 }, wires: 204 },
  { name: 'collapsed short lead', target: { x: 165.1, y: 77.47 }, wires: 202 },
])
  test(`real EMC R1 connected drag retains pin and label nets through ${pose.name} and one native undo`, () => {
    const core = new ProjectCore(
      parseProject(readFileSync('lib/emc-flyback-example.json', 'utf8')),
      { nativeEntryName: 'emc-flyback.kicad_pro' },
    );
    const originalFiles = core.getNativeFiles();
    const before = core.getSnapshot();
    const source = before.project!.schematic;
    const part = source.parts.find((part) => part.ref === 'R1')!;
    const leadId = '93e1b175-0d39-43f8-ba23-5645b6da7ae6';
    const label = source.labels.find((label) => label.text === 'LEDP')!;
    assert.equal(part.id, 'c3a5e462-128c-5a61-b5bb-fbf1b427d406');
    assert.ok(samePoint(part, { x: 165.1, y: 74.93 }));
    assert.ok(samePoint(label, { x: 165.1, y: 80.01 }));
    const preview = previewSchematicMove(source, [part.id], part, pose.target, [], true);
    assert.equal(core.getSnapshot().source, before.source, 'The complete preview remains local.');
    assert.equal(core.getSnapshot().undoDepth, 0);
    assert.deepEqual(
      topology(preview),
      topology(source),
      'Labels retain their original physical pin groups.',
    );
    assert.ok(
      samePoint(
        preview.parts.find((item) => item.id === part.id)!,
        pose.target,
      ),
    );
    assert.equal(preview.wires.length, pose.wires + 10);
    assert.ok(
      preview.wires.every((wire) => !samePoint(wire.a, wire.b)),
      'A collapsed lead creates no zero-length wire.',
    );
    const placedLabel = preview.labels.find((item) => item.id === label.id)!;
    assert.ok(samePoint(placedLabel, { x: 165.1, y: 81.28 }));
    assert.deepEqual(
      { ...placedLabel, x: label.x, y: label.y },
      label,
      'The native label retains UUID, rotation and all metadata.',
    );
    for (const wire of source.wires.filter((wire) => wire.id !== leadId))
      assert.deepEqual(
        preview.wires.find((item) => item.id === wire.id),
        wire,
        'Stationary branches and unrelated wire metadata remain exact.',
      );
    assert.equal(core.replaceSchematic(preview), true);
    assert.equal(core.getSnapshot().undoDepth, 1);
    assert.equal(core.getSnapshot().project!.pcb, before.project!.pcb);
    const committedFiles = core.getNativeFiles();
    assert.deepEqual(
      committedFiles.files.filter((file) => file.name !== 'emc-flyback.kicad_sch'),
      originalFiles.files.filter((file) => file.name !== 'emc-flyback.kicad_sch'),
      'Connected schematic editing retains native PCB and project bytes.',
    );
    assert.deepEqual(topology(projectFromNativeFiles(committedFiles).schematic), topology(source));
    assert.equal(core.undo(), true);
    assert.equal(core.getSnapshot().undoDepth, 0);
    assert.deepEqual(
      core.getNativeFiles(),
      originalFiles,
      'One Undo restores every original native byte.',
    );
  });

test('collapsing a lead past an interior label retains its stationary branch anchor', () => {
  const { d, a } = fixture();
  const anchor = { x: a.x, y: 35.56 };
  const branch = wire(d, anchor, { x: 5.08, y: anchor.y });
  d.labels.push({ id: uid(), ...anchor, text: 'BRANCH' });
  const source = parseCircuit(exportKiCad(createProject(d), 'schematic'));
  const moved = moveSelection(source, [source.parts[0].id], { x: 0, y: 40.64 - a.y }, true);
  assert.deepEqual(
    moved.wires.find((wire) => wire.id === branch.id),
    source.wires.find((wire) => wire.id === branch.id),
  );
  assert.ok(
    samePoint(
      moved.labels.find((label) => label.text === 'BRANCH')!,
      anchor,
    ),
  );
  assert.deepEqual(topology(moved), topology(source));
});

test('sliding a wire stretches adjacent legs, carries interior labels and keeps pin nets through both formats', () => {
  const { d, a, b, middle } = fixture();
  const imported = parseCircuit(exportKiCad(createProject(d), 'schematic'));
  const before = structuredClone(imported);
  const moved = moveSelection(imported, [middle.id], { x: 0, y: 5.08 }, true);
  assert.deepEqual(imported, before);
  assert.deepEqual(moved.parts, imported.parts);
  assert.equal(moved.wires.length, 3, 'existing bends stretch without extra elbows');
  assert.deepEqual(new Set(moved.wires.map((w) => w.id)), new Set(d.wires.map((w) => w.id)));
  assert.deepEqual(moved.wires.find((w) => w.id === middle.id)!.a, { x: a.x, y: 45.72 });
  assert.deepEqual(moved.wires.find((w) => w.id === middle.id)!.b, { x: b.x, y: 45.72 });
  assert.ok(samePoint(moved.labels[0], { x: 50.8, y: 45.72 }));
  for (const doc of [
    moved,
    parseProject(serializeProject(createProject(moved))).schematic,
    parseCircuit(exportKiCad(createProject(moved), 'schematic')),
  ]) {
    assert.deepEqual(topology(doc), topology(d));
    assert.ok(doc.wires.some((w) => samePoint(w.a, a) || samePoint(w.b, a)));
    assert.ok(doc.wires.some((w) => samePoint(w.a, b) || samePoint(w.b, b)));
  }
  for (const w of moved.wires) assert.equal(val(child(w.raw!, 'uuid')), w.id);
});

test('connected symbol drag slides free bends and the labels on them instead of creating backtracking stubs', () => {
  const { d, a } = fixture();
  d.labels.push({ id: uid(), x: a.x, y: 35.56, text: 'LEG' });
  const moved = moveSelection(d, [d.parts[0].id], { x: 5.08, y: 0 }, true);
  assert.equal(moved.wires.length, 3);
  assert.ok(samePoint(moved.wires[0].a, { x: a.x + 5.08, y: a.y }));
  assert.ok(samePoint(moved.wires[0].b, { x: a.x + 5.08, y: 40.64 }));
  assert.ok(samePoint(moved.labels[1], { x: a.x + 5.08, y: 35.56 }));
  assert.deepEqual(topology(moved), topology(d));
});

test('branches and stationary pins stay connected while unrelated crossings stay separate', () => {
  const { d, middle } = fixture();
  const tee = { x: 38.1, y: 40.64 };
  d.junctions.push({ id: uid(), ...tee });
  d.parts.push(createPart(d, 'Port', tee.x, 60.96));
  const branchPin = pinPositions(d.parts[2], d.libraries[d.parts[2].libId])[0];
  wire(d, tee, branchPin);
  const crossing = wire(d, { x: 63.5, y: 35.56 }, { x: 63.5, y: 55.88 });
  const moved = moveSelection(d, [middle.id], { x: 0, y: 5.08 }, true);
  assert.ok(
    samePoint(
      moved.junctions.find((j) => j.id === d.junctions[0].id)!,
      { x: tee.x, y: 45.72 },
    ),
  );
  assert.deepEqual(
    moved.wires.find((w) => w.id === crossing.id),
    crossing,
  );
  assert.equal(moved.junctions.length, 1, 'no dot at incidental crossing');
  assert.deepEqual(topology(moved), topology(d));
  const direct = emptyCircuit();
  direct.parts.push(createPart(direct, 'R', 25.4, 25.4), createPart(direct, 'C', 76.2, 25.4));
  const [a, b] = direct.parts.map((p) => pinPositions(p, direct.libraries[p.libId])[0]);
  const w = wire(direct, a, b);
  direct.labels.push({ id: uid(), x: 50.8, y: a.y, text: 'NODE' });
  const dragged = moveSelection(direct, [w.id], { x: 0, y: 5.08 }, true);
  assert.deepEqual(topology(dragged), topology(direct));
  assert.deepEqual(dragged.parts, direct.parts);
  assert.ok(
    dragged.wires.every((segment) => segment.a.x === segment.b.x || segment.a.y === segment.b.y),
  );
});

test('a label on a fixed-pin wire stays attached when a new elbow is needed in either endpoint order', () => {
  for (const reverse of [false, true]) {
    const d = emptyCircuit();
    d.parts.push(createPart(d, 'R', 25.4, 25.4), createPart(d, 'C', 76.2, 25.4));
    const [a, b] = d.parts.map((p) => pinPositions(p, d.libraries[p.libId])[0]);
    wire(d, reverse ? b : a, reverse ? a : b);
    d.labels.push({ id: uid(), x: 50.8, y: a.y, text: 'NODE' });
    const moved = moveSelection(d, [d.parts[0].id], { x: 0, y: 5.08 }, true);
    assert.equal(moved.wires.length, 2);
    assert.ok(moved.wires.some((w) => onWire(moved.labels[0], w)));
    assert.equal(moved.labels[0].y, a.y + 5.08);
    assert.deepEqual(topology(moved), topology(d));
  }
});

test('zero displacement is a no-op and selected UUID survives collapsing a collinear bend', () => {
  const d = emptyCircuit();
  const adjacent = wire(d, { x: 0, y: 0 }, { x: 10.16, y: 0 });
  const selected = wire(d, { x: 10.16, y: 0 }, { x: 20.32, y: 0 });
  assert.deepEqual(moveSelection(d, [selected.id], { x: 0, y: 0 }, true), d);
  const moved = moveSelection(d, [selected.id], { x: 0, y: 5.08 }, true);
  assert.equal(moved.wires.length, 1);
  assert.equal(moved.wires[0].id, selected.id);
  assert.notEqual(moved.wires[0].id, adjacent.id);
  assert.deepEqual(moved.wires[0].a, { x: 0, y: 5.08 });
  assert.deepEqual(moved.wires[0].b, { x: 20.32, y: 5.08 });
});

test('diagonal wires keep their geometry and metadata during a connected translation', () => {
  const d = emptyCircuit();
  const w = wire(d, { x: 0, y: 0 }, { x: 10.16, y: 10.16 });
  const imported = parseCircuit(exportKiCad(createProject(d), 'schematic'));
  const moved = moveSelection(imported, [w.id], { x: 2.54, y: 5.08 }, true);
  assert.equal(moved.wires.length, 1);
  assert.equal(moved.wires[0].id, w.id);
  assert.deepEqual(moved.wires[0].a, { x: 2.54, y: 5.08 });
  assert.deepEqual(moved.wires[0].b, { x: 12.7, y: 15.24 });
  assert.deepEqual(moved.wires[0].raw, imported.wires[0].raw);
});

test('group dragging moves selected symbols and wires together and retains boundary pin connections', () => {
  const { d, middle } = fixture();
  const selectedPart = d.parts[0];
  const moved = moveSelection(
    d,
    [selectedPart.id, d.wires[0].id, middle.id],
    { x: 5.08, y: 5.08 },
    true,
  );
  assert.ok(samePoint(moved.parts[0], { x: 30.48, y: 30.48 }));
  assert.deepEqual(moved.parts[1], d.parts[1]);
  assert.ok(samePoint(moved.labels[0], { x: 55.88, y: 45.72 }));
  assert.deepEqual(topology(moved), topology(d));
  assert.ok(moved.wires.some((w) => w.id === middle.id));
  const reopened = parseProject(serializeProject(createProject(moved))).schematic;
  assert.deepEqual(topology(reopened), topology(d));
});

test('dragging multiple components past a stationary interior branch keeps its original net', () => {
  for (const reverse of [false, true]) {
    const { d, middle } = fixture();
    if (reverse) [middle.a, middle.b] = [middle.b, middle.a];
    const tee = { x: 38.1, y: 40.64 };
    d.junctions.push({ id: uid(), ...tee });
    const stationary = createPart(d, 'Port', 38.1, 60.96);
    d.parts.push(stationary);
    const branch = wire(d, tee, pinPositions(stationary, d.libraries[stationary.libId])[0]);
    const selected = d.parts.slice(0, 2);
    d.noConnects = selected.map((part) => ({
      id: uid(),
      ...pinPositions(part, d.libraries[part.libId])[1],
    }));
    const imported = parseCircuit(exportKiCad(createProject(d), 'schematic'));
    const before = structuredClone(imported);
    const moved = moveSelection(
      imported,
      selected.map((part) => part.id),
      { x: 50.8, y: 5.08 },
      true,
    );
    assert.deepEqual(imported, before);
    assert.deepEqual(moved.parts[2], imported.parts[2]);
    assert.deepEqual(
      moved.wires.find((segment) => segment.id === branch.id),
      imported.wires[3],
    );
    assert.ok(samePoint(moved.junctions[0], tee));
    assert.equal(new Set(moved.wires.map((segment) => segment.id)).size, moved.wires.length);
    for (const segment of moved.wires) assert.equal(val(child(segment.raw!, 'uuid')), segment.id);
    for (const part of moved.parts.slice(0, 2)) {
      const pins = pinPositions(part, moved.libraries[part.libId]);
      assert.ok(
        moved.wires.some(
          (segment) => samePoint(segment.a, pins[0]) || samePoint(segment.b, pins[0]),
        ),
      );
      assert.ok(moved.noConnects!.some((marker) => samePoint(marker, pins[1])));
    }
    for (const result of [
      moved,
      parseProject(serializeProject(createProject(moved))).schematic,
      parseCircuit(exportKiCad(createProject(moved), 'schematic')),
    ])
      assert.deepEqual(topology(result), topology(imported));
  }
});

test('dragging an interior component past another branch preserves the unsplit trunk connections', () => {
  const source = emptyCircuit();
  const portAt = (point: Point) => {
    const part = createPart(source, 'Port', point.x, point.y);
    const pin = pinPositions(part, source.libraries[part.libId])[0];
    part.x += point.x - pin.x;
    part.y += point.y - pin.y;
    source.parts.push(part);
    return part;
  };
  const a = { x: 0, y: 40.64 },
    b = { x: 101.6, y: 40.64 },
    tee = { x: 38.1, y: 40.64 },
    branchPin = { x: tee.x, y: 60.96 },
    selectedPin = { x: 25.4, y: 40.64 };
  portAt(a);
  portAt(b);
  portAt(branchPin);
  const selected = portAt(selectedPin);
  wire(source, a, b);
  const branch = wire(source, tee, branchPin);
  source.junctions.push({ id: uid(), ...selectedPin }, { id: uid(), ...tee });
  const imported = parseCircuit(exportKiCad(createProject(source), 'schematic'));
  const before = structuredClone(imported);
  const moved = moveSelection(imported, [selected.id], { x: 50.8, y: 5.08 }, true);
  assert.deepEqual(imported, before);
  assert.deepEqual(moved.parts.slice(0, 3), imported.parts.slice(0, 3));
  assert.deepEqual(
    moved.wires.find((segment) => segment.id === branch.id),
    imported.wires[1],
  );
  assert.ok(moved.junctions.some((junction) => samePoint(junction, tee)));
  assert.ok(moved.junctions.some((junction) => samePoint(junction, { x: 76.2, y: 45.72 })));
  for (const result of [
    moved,
    parseProject(serializeProject(createProject(moved))).schematic,
    parseCircuit(exportKiCad(createProject(moved), 'schematic')),
  ])
    assert.deepEqual(topology(result), topology(imported));
});
