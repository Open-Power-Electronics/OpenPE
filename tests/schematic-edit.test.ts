import { runSchematicERC } from '../lib/schematic-erc';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createPart,
  emptyCircuit,
  parseCircuit,
  serializeCircuit,
  pinPositions,
  uid,
} from '../lib/circuit';
import { child, children, parseSExpr, quote, val } from '../lib/sexpr';
import { extraSymbolAnnotations, partFields, symbolAnnotation } from '../lib/library';
import { createExample } from '../lib/examples';
import { visibleSchematicIds } from '../lib/schematic-view';
import { defaultSchematicLayers } from '../lib/schematic-layers';
import { createProject, exportKiCad, parseProject, serializeProject } from '../lib/project';
import { exampleProject } from '../lib/project-example';
import {
  fieldId,
  moveText,
  moveSelection,
  duplicateSelection,
  transformSelection,
  simplifyWires,
  removeSelection,
  saveAnnotation,
} from '../lib/schematic-edit';
import { schematicTexts } from '../lib/schematic-text';
import { onWire, samePoint } from '../lib/wiring';
import { importDocument as serviceImportDocument } from '../server/project-format.mjs';

test('annotations preserve multiline text, identity and project data through editing, JSON and native export', () => {
  const project = exampleProject();
  const before = structuredClone(project);
  const text = 'Check "gate drive"\n输入 12 V · verify timing';
  const added = saveAnnotation(project.schematic, text, { x: 30.1, y: 20.1 });
  assert.deepEqual(project, before);
  const note = schematicTexts(added.circuit.original).find((t) => t.id === added.id)!;
  assert.equal(note.text, text);
  assert.equal(note.x, 30.48);
  assert.equal(note.y, 20.32);
  const updated = saveAnnotation(added.circuit, text + '\nReviewed', note, added.id);
  assert.equal(updated.id, added.id);
  assert.equal(schematicTexts(added.circuit.original).find((t) => t.id === added.id)!.text, text);
  project.schematic = updated.circuit;
  const source = serializeProject(project);
  const reopened = parseProject(source);
  assert.deepEqual(serviceImportDocument(source), reopened);
  assert.deepEqual(reopened.pcb, before.pcb);
  assert.deepEqual(reopened.extensions, before.extensions);
  const stored = JSON.parse(source).schematic;
  const baseline = JSON.parse(serializeProject(before)).schematic;
  assert.deepEqual(stored.components, baseline.components);
  assert.deepEqual(stored.wires, baseline.wires);
  assert.deepEqual(stored.labels, baseline.labels);
  const exported = parseCircuit(exportKiCad(reopened, 'schematic'));
  assert.deepEqual(
    schematicTexts(exported.original).find((t) => t.id === added.id),
    { ...note, text: text + '\nReviewed' },
  );
  assert.throws(() => saveAnnotation(updated.circuit, ' ', note), /Enter annotation text/);
  assert.throws(() => saveAnnotation(updated.circuit, 'x'.repeat(4097), note), /4096/);
  assert.throws(() => saveAnnotation(updated.circuit, 'x', { x: NaN, y: 0 }), /position/);
  assert.throws(() => saveAnnotation(updated.circuit, 'x', note, uid()), /no longer exists/);
  assert.deepEqual(project.schematic, updated.circuit);
});

test('independent field movement preserves component pins, other fields, wires, PCB and extensions through JSON and native export', () => {
  const project = exampleProject();
  project.extensions.note = { arbitrary: true };
  const before = structuredClone(project),
    p = project.schematic.parts[0];
  const value = symbolAnnotation(p, project.schematic.libraries[p.libId], 'Value');
  project.schematic = moveText(project.schematic, fieldId(p.id, 'Reference'), {
    x: 35.57,
    y: 29.2,
  });
  const moved = project.schematic.parts[0];
  assert.deepEqual(
    pinPositions(moved, project.schematic.libraries[p.libId]),
    pinPositions(p, project.schematic.libraries[p.libId]),
  );
  assert.deepEqual(symbolAnnotation(moved, project.schematic.libraries[p.libId], 'Value'), value);
  assert.deepEqual(project.schematic.wires, before.schematic.wires);
  const reopened = parseProject(serializeProject(project));
  assert.deepEqual(reopened.pcb, before.pcb);
  assert.deepEqual(reopened.extensions, before.extensions);
  const native = parseCircuit(exportKiCad(reopened, 'schematic'));
  const at = symbolAnnotation(native.parts[0], native.libraries[p.libId], 'Reference')!;
  assert.ok(Math.abs(at.x - 35.56) < 0.0001 && Math.abs(at.y - 29.21) < 0.0001);
  const shifted = moveSelection(native, [p.id], { x: 2.54, y: 0 });
  assert.ok(
    Math.abs(
      symbolAnnotation(shifted.parts[0], shifted.libraries[p.libId], 'Reference')!.x - 38.1,
    ) < 0.0001,
  );
  assert.deepEqual(before.schematic.parts[0], p, 'source immutable');
});

test('simulation parameter text stays visible with values and moves independently through project and KiCad round trips', () => {
  const project = createExample('kicad-buck');
  const before = structuredClone(project.schematic);
  const part = before.parts.find((p) => p.ref === 'V101')!;
  const id = fieldId(part.id, 'Sim.Params');
  const at = extraSymbolAnnotations(part).find((field) => field.name === 'Sim.Params')!;
  assert.ok(
    visibleSchematicIds(before, defaultSchematicLayers).has(id),
    'simulation parameters remain selectable in either mode',
  );
  assert.ok(visibleSchematicIds(before, { ...defaultSchematicLayers, fields: false }).has(id));
  assert.ok(!visibleSchematicIds(before, { ...defaultSchematicLayers, values: false }).has(id));
  const inductor = before.parts.find((p) => p.ref === 'L101')!;
  assert.ok(
    !visibleSchematicIds(before, defaultSchematicLayers).has(fieldId(inductor.id, 'Sim.Params')),
    'hidden parameters represented by Value do not appear twice',
  );
  project.schematic = moveSelection(before, [id], { x: 2.54, y: -1.27 });
  const moved = project.schematic.parts.find((p) => p.id === part.id)!;
  assert.deepEqual(partFields(moved), partFields(part));
  assert.deepEqual(
    pinPositions(moved, before.libraries[part.libId]),
    pinPositions(part, before.libraries[part.libId]),
  );
  assert.deepEqual(project.schematic.wires, before.wires);
  assert.deepEqual(
    symbolAnnotation(moved, before.libraries[part.libId], 'Value'),
    symbolAnnotation(part, before.libraries[part.libId], 'Value'),
  );
  const reopened = parseProject(serializeProject(project));
  const native = parseCircuit(exportKiCad(reopened, 'schematic'));
  for (const doc of [project.schematic, reopened.schematic, native]) {
    const p = doc.parts.find((p) => p.id === part.id)!;
    const field = extraSymbolAnnotations(p).find((field) => field.name === 'Sim.Params')!;
    assert.equal(field.text, at.text);
    assert.ok(Math.abs(field.x - at.x - 2.54) < 0.0001);
    assert.ok(Math.abs(field.y - at.y + 1.27) < 0.0001);
    assert.deepEqual(partFields(p), partFields(part));
  }
  const together = moveSelection(before, [part.id, id], { x: 2.54, y: -1.27 });
  const togetherAt = extraSymbolAnnotations(together.parts.find((p) => p.id === part.id)!).find(
    (f) => f.name === 'Sim.Params',
  )!;
  assert.ok(
    Math.abs(togetherAt.x - at.x - 2.54) < 0.0001,
    'moving the owner and field applies the offset once',
  );
});

test('free multiline text moves, duplicates with a new UUID and deletes without losing original metadata', () => {
  const d = emptyCircuit();
  d.original = parseSExpr(serializeCircuit(d));
  const id = uid();
  d.original.push([
    'text',
    quote('Notes\nSecond line'),
    ['at', '25.4', '25.4', '0'],
    ['effects', ['font', ['size', '1.27', '1.27']], ['justify', 'left', 'top']],
    ['uuid', quote(id)],
  ]);
  const moved = moveText(d, id, { x: 30.48, y: 38.1 });
  assert.deepEqual(schematicTexts(moved.original)[0], {
    ...schematicTexts(d.original)[0],
    x: 30.48,
    y: 38.1,
  });
  const copy = duplicateSelection(moved, [id]);
  assert.equal(schematicTexts(copy.circuit.original).length, 2);
  assert.notEqual(copy.selection[0], id);
  assert.equal(schematicTexts(removeSelection(copy.circuit, copy.selection).original).length, 1);
  assert.equal(
    schematicTexts(parseCircuit(exportKiCad(createProject(copy.circuit), 'schematic')).original)
      .length,
    2,
  );
});

test('multi-selection duplicates grouped units with fresh references and UUIDs, transforms round trip', () => {
  const d = emptyCircuit(),
    p = createPart(d, 'NMOS', 20.32, 20.32);
  d.parts.push(p);
  const second = createPart(d, 'R', 40.64, 20.32);
  d.parts.push(second);
  d.wires.push({ id: uid(), a: { x: 20.32, y: 20.32 }, b: { x: 40.64, y: 20.32 } });
  const imported = parseCircuit(serializeCircuit(d));
  const ids = [...d.parts, ...d.wires].map((p) => p.id);
  const copied = duplicateSelection(imported, ids);
  assert.equal(copied.circuit.parts.length, 4);
  assert.equal(new Set(copied.circuit.parts.map((p) => p.ref)).size, 4);
  assert.ok(copied.selection.every((id) => !ids.includes(id)));
  serializeProject(createProject(copied.circuit));
  for (const op of ['mirrorX', 'mirrorY'] as const) {
    const twice = transformSelection(transformSelection(d, ids, op), ids, op);
    assert.deepEqual(twice, d);
  }
  let rotated = d;
  for (let i = 0; i < 4; i++) rotated = transformSelection(rotated, ids, 'rotate');
  assert.deepEqual(rotated, d);
  const mirrored = transformSelection(d, [p.id], 'mirrorX'),
    round = parseCircuit(serializeCircuit(mirrored));
  assert.equal(round.parts[0].mirror, 'x');
  assert.deepEqual(
    pinPositions(round.parts[0], round.libraries[p.libId]),
    pinPositions(mirrored.parts[0], mirrored.libraries[p.libId]),
  );
  const deleted = removeSelection(copied.circuit, copied.selection);
  assert.equal(deleted.parts.length, 2);
  assert.equal(deleted.wires.length, 1);
});

test('no-connect and global labels round trip and intentionally unconnected pins are distinguished', () => {
  const d = emptyCircuit(),
    p = createPart(d, 'R', 25.4, 25.4);
  d.parts.push(p);
  const pins = pinPositions(p, d.libraries[p.libId]);
  d.noConnects = [{ id: uid(), ...pins[0] }];
  d.labels = [{ id: uid(), ...pins[1], text: 'SENSE', scope: 'global', shape: 'input' }];
  assert.deepEqual(runSchematicERC(d).issues, []);
  const root = parseSExpr(exportKiCad(createProject(d), 'schematic'));
  assert.equal(children(root, 'no_connect').length, 1);
  assert.equal(children(root, 'global_label').length, 1);
  const round = parseCircuit(exportKiCad(createProject(d), 'schematic'));
  serializeProject(createProject(round));
  assert.equal(round.noConnects![0].id, d.noConnects[0].id);
  assert.equal(round.labels[0].scope, 'global');
  d.wires.push({ id: uid(), a: pins[0], b: { x: pins[0].x + 10.16, y: pins[0].y } });
  assert.ok(runSchematicERC(d).issues.some((issue) => issue.ruleId === 'erc.no-connect-connected'));
  const bad = createProject(d);
  bad.schematic.noConnects![0].id = p.id;
  assert.throws(() => serializeProject(bad), /duplicate UUID/);
});

test('connected dragging reroutes attached ends, keeps a stationary shared pin and preserves text-only wires', () => {
  const d = emptyCircuit(),
    r = createPart(d, 'R', 25.4, 25.4);
  d.parts.push(r);
  const pins = pinPositions(r, d.libraries[r.libId]);
  const pin = pins[0];
  const c = createPart(d, 'C', r.x, r.y);
  d.parts.push(c); // Same endpoint shared with a stationary pin.
  d.wires = [{ id: uid(), a: { x: pin.x - 10.16, y: pin.y }, b: { x: pin.x + 10.16, y: pin.y } }];
  d.labels = [{ id: uid(), ...pin, text: 'NODE' }];
  d.junctions = [{ id: uid(), ...pin }];
  const moved = moveSelection(d, [r.id], { x: 5.08, y: 5.08 }, true),
    next = pinPositions(moved.parts[0], d.libraries[r.libId])[0];
  assert.ok(moved.wires.some((w) => onWire(next, w)));
  assert.ok(moved.wires.some((w) => onWire(pin, w)));
  assert.ok(moved.wires.every((w) => w.a.x === w.b.x || w.a.y === w.b.y));
  assert.ok(samePoint(moved.labels[0], next));
  assert.equal(moved.parts[1].x, c.x);
  assert.ok(moved.wires.some((w) => w.id === d.wires[0].id));
  serializeProject(createProject(moved));
  const text = moveSelection(d, [fieldId(r.id, 'Reference')], { x: 2.54, y: 0 }, true);
  assert.deepEqual(text.wires, d.wires);
  const independent = moveSelection(d, [r.id], { x: 5.08, y: 5.08 });
  assert.deepEqual(independent.wires, d.wires);
});

test('wire cleanup preserves junctions, label anchors and different imported stroke metadata', () => {
  const d = emptyCircuit(),
    a = { x: 0, y: 0 },
    joint = { x: 10.16, y: 0 },
    b = { x: 20.32, y: 0 };
  d.wires = [
    { id: uid(), a, b: joint },
    { id: uid(), a: joint, b },
  ];
  assert.equal(simplifyWires(d).wires.length, 1);
  assert.equal(simplifyWires(d).wires[0].id, d.wires[0].id);
  d.labels = [{ id: uid(), ...joint, text: 'NODE' }];
  assert.equal(simplifyWires(d).wires.length, 2);
  d.labels = [];
  const imported = parseCircuit(serializeCircuit(d));
  child(child(imported.wires[1].raw!, 'stroke')!, 'width')![1] = '0.5';
  assert.equal(simplifyWires(imported).wires.length, 2);
  assert.equal(val(child(imported.wires[1].raw!, 'uuid')), d.wires[1].id);
});

test('wire cleanup retains endpoint tolerance and selected UUIDs across adjacent spatial cells', () => {
  const d = emptyCircuit();
  const retained = uid();
  d.wires = [
    { id: uid(), a: { x: 10.00009, y: -0.00001 }, b: { x: 20, y: -0.00001 } },
    { id: retained, a: { x: 20.00003, y: 0.00001 }, b: { x: 10.00011, y: 0.00001 } },
  ];
  const before = structuredClone(d);
  const deduplicated = simplifyWires(d, [retained]);
  assert.equal(deduplicated.wires.length, 1);
  assert.equal(deduplicated.wires[0].id, retained);
  assert.deepEqual(d, before);

  d.wires = [
    { id: uid(), a: { x: 0, y: 0 }, b: { x: 5.00009, y: 0 } },
    { id: retained, a: { x: 5.00011, y: 0 }, b: { x: 10, y: 0 } },
  ];
  const joined = simplifyWires(d, [retained]);
  assert.equal(joined.wires.length, 1);
  assert.equal(joined.wires[0].id, retained);
  assert.deepEqual(joined.wires[0].a, { x: 0, y: 0 });
  assert.deepEqual(joined.wires[0].b, { x: 10, y: 0 });
});
