import { runSchematicERC } from '../lib/schematic-erc';
import { switchingStageFixture } from './fixtures/switching-stage';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyCircuit,
  serializeCircuit,
  parseCircuit,
  materializedCircuitTree,
  parseCircuitTree,
  pinPositions,
  createPart,
  libraries,
} from '../lib/circuit';
import { parseSExpr, child, children, val, writeSExpr } from '../lib/sexpr';
import { extractProposal, applyProposal } from '../lib/proposals';
import { isOwnedCircuit, ownProject } from '../lib/immutable-project';
import { createProject, serializeProject } from '../lib/project';
test('KiCad round trip preserves circuit identity, pin connectivity, parameters and library geometry', () => {
  const before = switchingStageFixture(),
    source = serializeCircuit(before),
    after = parseCircuit(source);
  assert.equal(after.id, before.id);
  assert.equal(after.parts.length, 11);
  assert.equal(after.wires.length, before.wires.length);
  for (const p of before.parts) {
    const other = after.parts.find((x) => x.id === p.id)!;
    for (const k of ['x', 'y', 'rotation', 'ref', 'value', 'libId'] as const)
      assert.equal(other[k], p[k]);
    assert.deepEqual(
      pinPositions(other, after.libraries[other.libId]),
      pinPositions(p, before.libraries[p.libId]),
    );
  }
  assert.deepEqual(runSchematicERC(after), runSchematicERC(before));
  assert.equal(serializeCircuit(after), serializeCircuit(parseCircuit(serializeCircuit(after))));
});

test('circuit byte reuse requires owned immutable sheets and never replaces project validation', () => {
  const caller = parseCircuit(serializeCircuit(switchingStageFixture()));
  const expected = serializeCircuit(caller);
  const project = ownProject(createProject(caller));
  assert.equal(isOwnedCircuit(caller), false);
  assert.equal(isOwnedCircuit(project.schematic), true);
  for (let index = 0; index < 3; index++)
    assert.equal(serializeCircuit(project.schematic), expected);

  Object.freeze(caller);
  caller.parts[0].value = 'Changed caller value';
  assert.equal(isOwnedCircuit(caller), false);
  const changed = serializeCircuit(caller);
  assert.notEqual(changed, expected);
  assert.equal(parseCircuit(changed).parts[0].value, 'Changed caller value');
  assert.equal(serializeCircuit(project.schematic), expected);

  const next = ownProject(
    {
      ...project,
      schematic: {
        ...project.schematic,
        parts: project.schematic.parts.map((part, index) =>
          index ? part : { ...part, x: part.x + 1.27, value: 'New owned value' },
        ),
      },
    },
    project,
  );
  assert.notEqual(next.schematic, project.schematic);
  const current = serializeCircuit(next.schematic);
  assert.notEqual(current, expected);
  assert.equal(current, serializeCircuit(structuredClone(next.schematic)));
  assert.equal(parseCircuit(current).parts[0].value, 'New owned value');
  assert.equal(serializeCircuit(project.schematic), expected);

  // A serializer memo is only a byte cache. Even if invalid owned content was
  // serialized earlier, the complete project must still fail every validation.
  const invalid = ownProject({ ...next, schematic: { ...next.schematic, id: 'invalid UUID' } });
  const invalidSource = serializeCircuit(invalid.schematic);
  for (let index = 0; index < 2; index++) {
    assert.equal(serializeCircuit(invalid.schematic), invalidSource);
    assert.throws(() => serializeProject(invalid), /Invalid OpenPE project/);
  }
});
test('owned materialized schematic trees match native bytes and cannot poison subsequent reads', () => {
  const project = ownProject(createProject(switchingStageFixture()));
  const tree = materializedCircuitTree(project.schematic);
  const source = serializeCircuit(project.schematic);
  assert.equal(writeSExpr(tree) + '\n', source);
  assert.equal(materializedCircuitTree(project.schematic), tree);
  assert.deepEqual(parseCircuitTree(tree), parseCircuit(source));
  assert.throws(() => tree.push('unexpected atom'), /read only|readonly|extensible/);
  assert.throws(
    () => (child(tree, 'uuid')![1] = 'invalid UUID'),
    /read only|readonly|Cannot assign/,
  );
  const first = parseCircuit(source);
  first.parts[0].raw![0] = 'wire';
  first.libraries[first.parts[0].libId][0] = 'changed library';
  assert.equal(serializeCircuit(project.schematic), source);
  assert.deepEqual(parseCircuitTree(tree), parseCircuit(source));
});

test('MOSFET drain is on input, source on output and gate is on PWM in switching-stage fixture', () => {
  const d = switchingStageFixture(),
    q = d.parts.find((p) => p.ref === 'Q1')!;
  const [g, drain, source] = pinPositions(q, d.libraries[q.libId]);
  assert.ok(Math.abs(drain.x - 60.96) < 0.001);
  assert.ok(Math.abs(source.x - 71.12) < 0.001);
  assert.ok(Math.abs(g.y - 63.5) < 0.001);
});
test('all fixture parts use official snapshots and empty projects carry no private symbol catalog', () => {
  assert.deepEqual(emptyCircuit().libraries, {});
  const d = switchingStageFixture();
  for (const p of d.parts) {
    assert.ok(!p.libId.startsWith('OpenPE:'));
    assert.deepEqual(d.libraries[p.libId], libraries[p.libId]);
  }
  const exported = parseCircuit(serializeCircuit(d));
  for (const [id, symbol] of Object.entries(d.libraries))
    assert.deepEqual(exported.libraries[id], symbol);
});
test('metadata and imported attributes survive parameter edits and moves', () => {
  const root = parseSExpr(serializeCircuit(switchingStageFixture()));
  child(root, 'title_block')!.push(['company', '"My lab"']);
  root.push(['paper', '"A3"']);
  const s = children(root, 'symbol')[0];
  s.push([
    'property',
    '"Footprint"',
    '"Connector:Test"',
    ['at', '25.4', '50.8', '0'],
    ['effects', ['font', ['size', '1', '1']], 'hide'],
  ]);
  child(s, 'dnp')![1] = 'yes';
  const doc = parseCircuit(writeSExpr(root));
  doc.parts[0].value = '24V "source"';
  doc.parts[0].x += 1.27;
  const output = parseSExpr(serializeCircuit(doc));
  assert.equal(val(child(child(output, 'title_block')!, 'company')), 'My lab');
  assert.equal(child(doc.original!, 'paper'), undefined);
  assert.equal(child(output, 'paper'), undefined);
  assert.equal(val(child(children(output, 'symbol')[0], 'dnp')), 'yes');
  assert.equal(
    val(
      children(children(output, 'symbol')[0], 'property').find((p) => val(p) === 'Footprint'),
      2,
    ),
    'Connector:Test',
  );
  assert.equal(parseCircuit(serializeCircuit(doc)).parts[0].value, '24V "source"');
});
test('unsupported KiCad objects fail loudly before any save', () => {
  const src = serializeCircuit(switchingStageFixture());
  assert.throws(
    () => parseCircuit(src.replace('(lib_symbols', '(sheet (uuid "x")) (lib_symbols')),
    /sheet/,
  );
  assert.throws(() => parseCircuit(src.slice(0, -4)), /Unbalanced/);
  assert.throws(() => parseCircuit('(foo)'), /KiCad/);
});
test('unconnected moved pin is reported and duplicate references are found', () => {
  const d = switchingStageFixture();
  const capacitor = d.parts.find((part) => part.ref === 'C1')!;
  capacitor.x += 2.54;
  assert.ok(
    runSchematicERC(d).issues.some(
      (issue) => issue.ruleId === 'erc.pin-unconnected' && issue.objectIds.includes(capacitor.id),
    ),
  );
  d.parts[1].ref = d.parts[0].ref;
  assert.ok(runSchematicERC(d).issues.some((issue) => issue.ruleId === 'erc.reference-conflict'));
});
test('answers without edits and explicit empty proposals do not offer changes', () => {
  for (const text of [
    'Keep L1 unchanged until the output voltage and load are confirmed.',
    'Keep L1 unchanged.\n\n```openpe\n[]\n```',
    '```openpe\n[ \n ]\n```',
  ])
    assert.equal(extractProposal(text), null);
  for (const payload of ['{}', 'null', '[null]', '[{}]', '[', '{"ops":[]}'])
    assert.throws(() => extractProposal('```openpe\n' + payload + '\n```'));
});

test('proposals validate atomically and never mutate original circuit', () => {
  const d = switchingStageFixture();
  const ops = extractProposal(
    '建议如下\n```openpe\n[{"type":"setValue","ref":"C2","value":"220uF"}]\n```',
  )!;
  const next = applyProposal(d, ops);
  assert.equal(next.parts.find((p) => p.ref === 'C2')!.value, '220uF');
  assert.equal(d.parts.find((p) => p.ref === 'C2')!.value, '100uF / 25V');
  assert.throws(
    () => applyProposal(d, [...ops, { type: 'removePart', ref: 'R999' }]),
    /Cannot find/,
  );
  assert.throws(
    () => extractProposal('```openpe\n[{"type":"addPart","kind":"R","x":"bad","y":1}]\n```'),
    /Invalid/,
  );
  assert.throws(
    () => extractProposal('```openpe\n[{"type":"exec","command":"x"}]\n```'),
    /unsupported/,
  );
});
test('reference allocation fills gaps and survives deleted parts', () => {
  const d = emptyCircuit();
  d.parts.push(createPart(d, 'R', 10, 10));
  d.parts.push(createPart(d, 'R', 20, 20));
  assert.equal(d.parts[1].ref, 'R2');
  d.parts.shift();
  assert.equal(createPart(d, 'R', 30, 30).ref, 'R1');
});
