import test from 'node:test';
import assert from 'node:assert/strict';
import { ownProjectData } from '../lib/immutable-project';
import { unitGraphics, extraSymbolAnnotations, partFields } from '../lib/library';
import { child, parseSExpr, type SExpr } from '../lib/sexpr';
import { exampleProject } from '../lib/project-example';

test('owned library unit caches preserve body selection, independent arrays and mutable caller changes', () => {
  const source = parseSExpr(
    '(symbol "Units" (symbol "Units_0_1") (symbol "Units_1_1") (symbol "Units_1_2") (symbol "Units_2_1") (symbol "Units_3_1") (symbol "Units_4_1"))',
  );
  const library = ownProjectData(source);
  const first = unitGraphics(library, 1);
  assert.equal(first.length, 2);
  first.length = 0;
  for (const unit of [2, 3, 4, 1, 3, 2])
    assert.deepEqual(unitGraphics(library, unit), unitGraphics(structuredClone(source), unit));
  assert.equal(unitGraphics(library, 1).length, 2);
  Object.freeze(source);
  assert.equal(unitGraphics(source, 1).length, 2);
  (source[3] as SExpr)[1] = '"Units_2_1"';
  assert.equal(unitGraphics(source, 1).length, 1);
  assert.equal(unitGraphics(library, 1).length, 2);
});

test('owned annotation and field caches retain independent scalar wrappers and follow part edits', () => {
  const source = {
    ...exampleProject().schematic.parts[0],
    x: 10,
    y: 20,
    raw: parseSExpr(
      '(symbol (at 1 2 0) (property "Sim.Params" "1k" (at 4 5 0) (effects (font (size 1 1)) (justify left))))',
    ),
    fields: { 'Sim.Params': '2k' },
  };
  const part = ownProjectData(source);
  const expected = extraSymbolAnnotations(part);
  assert.equal(expected[0].text, '2k');
  assert.equal(expected[0].x, 13);
  expected[0].text = 'poison';
  expected[0].x = 999;
  partFields(part)['Sim.Params'] = 'poison';
  assert.equal(extraSymbolAnnotations(part)[0].text, '2k');
  assert.equal(extraSymbolAnnotations(part)[0].x, 13);
  assert.equal(partFields(part)['Sim.Params'], '2k');
  const moved = ownProjectData({ ...part, x: part.x + 1.27, fields: { 'Sim.Params': '3k' } });
  assert.equal(extraSymbolAnnotations(moved)[0].text, '3k');
  assert.equal(extraSymbolAnnotations(moved)[0].x, 14.27);
  Object.freeze(source);
  extraSymbolAnnotations(source);
  partFields(source);
  source.fields['Sim.Params'] = '4k';
  child(source.raw, 'property')![2] = '"5k"';
  assert.equal(extraSymbolAnnotations(source)[0].text, '4k');
  assert.equal(partFields(source)['Sim.Params'], '4k');
});
