import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyCircuit, type Circuit, type Part, type Point } from '../lib/circuit';
import { fieldId } from '../lib/schematic-edit';
import { parseSExpr } from '../lib/sexpr';
import { defaultSchematicLayers } from '../lib/schematic-layers';
import { visibleSchematicIds } from '../lib/schematic-view';
import {
  applySelection,
  schematicIdsInRectangle,
  selectionMode,
  type SchematicSelectionBounds,
} from '../lib/schematic-selection';

const part: Part = {
  id: 'part',
  libId: 'Test:Body',
  ref: 'U1',
  value: 'Test body',
  x: 20,
  y: 30,
  rotation: 0,
};
function circuitWithPart(overrides: Partial<Part> = {}) {
  const doc = emptyCircuit();
  doc.parts = [{ ...part, ...overrides }];
  doc.libraries[part.libId] = parseSExpr(`(symbol "Test:Body"
    (symbol "Body_1_1"
      (rectangle (start 2 1) (end 6 -1))
      (pin passive line (at 8 0 180) (length 2)))
    (symbol "Body_2_1" (rectangle (start 100 100) (end 110 110))))`);
  return doc;
}
const select = (
  doc: Circuit,
  start: Point,
  end: Point,
  measured = new Map<string, SchematicSelectionBounds>(),
) =>
  schematicIdsInRectangle(
    doc,
    visibleSchematicIds(doc, defaultSchematicLayers),
    start,
    end,
    measured,
  );

test('click and rectangle modifiers use the same add, toggle and subtract semantics on both platforms', () => {
  assert.equal(selectionMode({}), 'replace');
  assert.equal(selectionMode({ shiftKey: true }), 'add');
  for (const control of [{ ctrlKey: true }, { metaKey: true }, { ctrlKey: true, metaKey: true }]) {
    assert.equal(selectionMode(control), 'toggle');
    assert.equal(selectionMode({ ...control, shiftKey: true }), 'subtract');
  }
});

test('selection merging deduplicates stably without changing either input', () => {
  const previous = ['a', 'b', 'a'],
    candidates = ['b', 'c', 'b', 'd'];
  assert.deepEqual(applySelection(previous, candidates, 'replace'), ['b', 'c', 'd']);
  assert.deepEqual(applySelection(previous, candidates, 'add'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(applySelection(previous, candidates, 'toggle'), ['a', 'c', 'd']);
  assert.deepEqual(applySelection(previous, candidates, 'subtract'), ['a']);
  assert.deepEqual(applySelection(previous, [], 'replace'), []);
  assert.deepEqual(applySelection(previous, [], 'toggle'), ['a', 'b']);
  assert.deepEqual(previous, ['a', 'b', 'a']);
  assert.deepEqual(candidates, ['b', 'c', 'b', 'd']);
});

test('selecting a parent suppresses duplicate field motion while independent fields remain selectable', () => {
  const reference = fieldId(part.id, 'Reference'),
    value = fieldId(part.id, 'Value');
  assert.deepEqual(applySelection([], [reference, part.id, value], 'replace'), [part.id]);
  assert.deepEqual(applySelection([value], [part.id, reference], 'add'), [part.id]);
  assert.deepEqual(applySelection([part.id], [reference], 'add'), [part.id]);
  assert.deepEqual(applySelection([value], [reference], 'add'), [value, reference]);
  assert.deepEqual(applySelection([value], [value], 'toggle'), []);
  assert.deepEqual(applySelection([value, reference], [reference], 'subtract'), [value]);
  assert.deepEqual(applySelection([part.id], [part.id, reference, value], 'toggle'), []);
  assert.deepEqual(applySelection([reference], [part.id, reference, value], 'toggle'), [part.id]);
  assert.deepEqual(applySelection([], [part.id, reference, value], 'toggle'), [part.id]);
});

test('marquees retain parent and field hits until subtraction or toggling has been applied', () => {
  const doc = circuitWithPart(),
    reference = fieldId(part.id, 'Reference'),
    measured = new Map([[reference, { x: 22, y: 26, width: 4, height: 2 }]]);
  for (const [start, end] of [
    [
      { x: 21, y: 25 },
      { x: 29, y: 32 },
    ],
    [
      { x: 29, y: 25 },
      { x: 21, y: 32 },
    ],
  ]) {
    const hits = select(doc, start, end, measured);
    assert.deepEqual(hits, [part.id, reference]);
    assert.deepEqual(applySelection([reference], hits, 'subtract'), []);
    assert.deepEqual(applySelection([reference, 'unrelated'], hits, 'subtract'), ['unrelated']);
    assert.deepEqual(applySelection([reference], hits, 'toggle'), [part.id]);
    assert.deepEqual(applySelection([part.id], hits, 'toggle'), []);
    assert.deepEqual(applySelection([], hits, 'replace'), [part.id]);
    assert.deepEqual(applySelection([reference], hits, 'add'), [part.id]);
  }
});

test('containment includes body and full visible pin geometry; crossing can touch either without an origin hit', () => {
  const doc = circuitWithPart(),
    before = structuredClone(doc);
  assert.deepEqual(select(doc, { x: 21, y: 28 }, { x: 27, y: 32 }), []);
  assert.deepEqual(select(doc, { x: 27, y: 28 }, { x: 21, y: 32 }), [part.id]);
  assert.deepEqual(select(doc, { x: 22, y: 29 }, { x: 28, y: 31 }), [part.id]);
  assert.deepEqual(select(doc, { x: 21, y: 29 }, { x: 20, y: 31 }), []);
  assert.deepEqual(select(doc, { x: 27.1, y: 29.9 }, { x: 26.9, y: 30.1 }), [part.id]);
  assert.deepEqual(select(doc, { x: 129, y: -81 }, { x: 119, y: -69 }), []);
  assert.deepEqual(doc, before);
});

test('symbol bounds and pin segments use the same rotation and mirror order as the drawing', () => {
  const rotated = circuitWithPart({ rotation: 90 });
  assert.deepEqual(select(rotated, { x: 20.1, y: 22.5 }, { x: 19.9, y: 23.5 }), [part.id]);
  assert.deepEqual(select(rotated, { x: 19, y: 22 }, { x: 21, y: 28 }), [part.id]);
  assert.deepEqual(select(rotated, { x: 19, y: 24 }, { x: 21, y: 28 }), []);
  const mirrored = circuitWithPart({ rotation: 90, mirror: 'x' });
  assert.deepEqual(select(mirrored, { x: 20.1, y: 36.5 }, { x: 19.9, y: 37.5 }), [part.id]);
  assert.deepEqual(select(mirrored, { x: 20.1, y: 22.5 }, { x: 19.9, y: 23.5 }), []);
  assert.deepEqual(select(mirrored, { x: 19, y: 32 }, { x: 21, y: 38 }), [part.id]);
  const reflected = circuitWithPart({ mirror: 'y' });
  assert.deepEqual(select(reflected, { x: 12, y: 29 }, { x: 18, y: 31 }), [part.id]);
  assert.deepEqual(select(reflected, { x: 22, y: 29 }, { x: 28, y: 31 }), []);
});

test('a rotated body excludes empty world-bounding-box corners and contains a window inside its body', () => {
  const doc = circuitWithPart({ x: 0, y: 0, rotation: 45 });
  doc.libraries[part.libId] = parseSExpr(`(symbol "Test:Body"
    (symbol "Body_1_1" (rectangle (start -4 0.25) (end 4 -0.25))))`);
  assert.deepEqual(select(doc, { x: 2.9, y: 2.7 }, { x: 2.7, y: 2.9 }), []);
  assert.deepEqual(select(doc, { x: 0.05, y: -0.05 }, { x: -0.05, y: 0.05 }), [part.id]);
  assert.deepEqual(select(doc, { x: -3.1, y: -3.1 }, { x: 3.1, y: 3.1 }), [part.id]);
});

test('pin-only symbols use visible selected-unit pin geometry without including hidden pins', () => {
  const doc = circuitWithPart({ x: 0, y: 0 });
  doc.libraries[part.libId] = parseSExpr(`(symbol "Test:Body"
    (symbol "Body_1_1"
      (pin passive line (at 2 0 0) (length 3))
      (pin passive line (at 100 0 0) (length 5) hide)
      (pin passive line (at 200 0 0) (length 5) (hide yes)))
    (symbol "Body_2_1" (pin passive line (at 300 0 0) (length 5))))`);
  assert.deepEqual(select(doc, { x: 2, y: -0.1 }, { x: 5, y: 0.1 }), [part.id]);
  assert.deepEqual(select(doc, { x: 101, y: -1 }, { x: 99, y: 1 }), []);
  assert.deepEqual(select(doc, { x: 201, y: -1 }, { x: 199, y: 1 }), []);
  assert.deepEqual(select(doc, { x: 301, y: -1 }, { x: 299, y: 1 }), []);
  doc.parts[0].unit = 2;
  assert.deepEqual(select(doc, { x: 300, y: -0.1 }, { x: 305, y: 0.1 }), [part.id]);
});

test('crossing clips actual diagonal, horizontal, vertical and zero-length wires with inclusive edge contact', () => {
  const doc = emptyCircuit();
  doc.wires = [
    { id: 'diagonal', a: { x: 0, y: 0 }, b: { x: 10, y: 10 } },
    { id: 'horizontal', a: { x: -5, y: 12 }, b: { x: 15, y: 12 } },
    { id: 'vertical', a: { x: 12, y: -5 }, b: { x: 12, y: 15 } },
    { id: 'point', a: { x: 20, y: 20 }, b: { x: 20, y: 20 } },
  ];
  assert.deepEqual(select(doc, { x: 3, y: 7 }, { x: 1, y: 9 }), []);
  assert.deepEqual(select(doc, { x: 6, y: 4 }, { x: 4, y: 6 }), ['diagonal']);
  assert.deepEqual(select(doc, { x: 6, y: 11 }, { x: 4, y: 12 }), ['horizontal']);
  assert.deepEqual(select(doc, { x: 12, y: 4 }, { x: 11, y: 6 }), ['vertical']);
  assert.deepEqual(select(doc, { x: 1, y: 1 }, { x: 9, y: 9 }), []);
  assert.deepEqual(select(doc, { x: 0, y: 0 }, { x: 10, y: 10 }), ['diagonal']);
  assert.deepEqual(select(doc, { x: 21, y: 19 }, { x: 20, y: 20 }), ['point']);
  assert.deepEqual(select(doc, { x: 19, y: 19 }, { x: 20, y: 20 }), ['point']);
});

test('fields, distant labels and multiline notes use measured glyph extents independently of parent bodies', () => {
  const doc = circuitWithPart(),
    reference = fieldId(part.id, 'Reference'),
    value = fieldId(part.id, 'Value'),
    note = 'a0000000-0000-4000-8000-000000000001';
  doc.labels = [{ id: 'label', x: 100, y: 100, text: 'Long rotated label', rotation: 90 }];
  doc.original = parseSExpr(`(kicad_sch
    (text "Multiline\\nNote" (at 150 150 0) (effects (font (size 1.27 1.27))) (uuid "${note}")))`);
  const measured = new Map<string, SchematicSelectionBounds>([
    [part.id, { x: 80, y: 80, width: 100, height: 100 }],
    [reference, { x: 80, y: 80, width: 6, height: 2 }],
    [value, { x: 90, y: 80, width: 12, height: 2 }],
    ['label', { x: 100, y: 70, width: 3, height: 30 }],
    [note, { x: 140, y: 145, width: 20, height: 10 }],
  ]);
  assert.deepEqual(select(doc, { x: 80, y: 80 }, { x: 86, y: 82 }, measured), [reference]);
  assert.deepEqual(select(doc, { x: 91, y: 80 }, { x: 89, y: 82 }, measured), [value]);
  assert.deepEqual(select(doc, { x: 89, y: 79 }, { x: 101, y: 83 }, measured), []);
  assert.deepEqual(select(doc, { x: 99, y: 99 }, { x: 104, y: 101 }, measured), []);
  assert.deepEqual(select(doc, { x: 104, y: 71 }, { x: 99, y: 72 }, measured), ['label']);
  assert.deepEqual(select(doc, { x: 139, y: 144 }, { x: 161, y: 156 }, measured), [note]);
  assert.deepEqual(select(doc, { x: 139, y: 144 }, { x: 151, y: 156 }, measured), []);
  assert.deepEqual(select(doc, { x: 19, y: 28 }, { x: 104, y: 83 }, measured), [
    part.id,
    reference,
    value,
  ]);
  assert.deepEqual(select(doc, { x: 79, y: 79 }, { x: 87, y: 83 }), []);
});

test('hidden layers and redundant junctions never contribute to marquee candidates', () => {
  const doc = circuitWithPart();
  doc.wires = [
    { id: 'a', a: { x: 0, y: 0 }, b: { x: 5, y: 0 } },
    { id: 'b', a: { x: 5, y: 0 }, b: { x: 5, y: 5 } },
  ];
  doc.junctions = [
    { id: 'corner', x: 5, y: 0 },
    { id: 'isolated', x: 10, y: 10 },
  ];
  const reference = fieldId(part.id, 'Reference'),
    bounds = new Map([[reference, { x: 20, y: 20, width: 4, height: 2 }]]),
    visible = visibleSchematicIds(doc, {
      ...defaultSchematicLayers,
      symbols: false,
      values: false,
    });
  assert.deepEqual(
    schematicIdsInRectangle(doc, visible, { x: -1, y: -1 }, { x: 40, y: 40 }, bounds),
    [reference, 'a', 'b', 'isolated'],
  );
  assert.deepEqual(
    schematicIdsInRectangle(doc, new Set(), { x: -1, y: -1 }, { x: 40, y: 40 }, bounds),
    [],
  );
});

test('junction disks and no-connect crosses use actual geometry rather than only anchors or empty bounding corners', () => {
  const doc = emptyCircuit();
  doc.junctions = [{ id: 'junction', x: 0, y: 0 }];
  doc.noConnects = [{ id: 'no-connect', x: 5, y: 0 }];
  assert.deepEqual(select(doc, { x: 0, y: -1 }, { x: 1, y: 1 }), []);
  assert.deepEqual(select(doc, { x: 1, y: -1 }, { x: 0, y: 1 }), ['junction']);
  assert.deepEqual(select(doc, { x: 0.6, y: 0.5 }, { x: 0.5, y: 0.6 }), []);
  assert.deepEqual(select(doc, { x: -0.6, y: -0.6 }, { x: 0.6, y: 0.6 }), ['junction']);
  assert.deepEqual(select(doc, { x: 5.7, y: 0.55 }, { x: 5.55, y: 0.7 }), ['no-connect']);
  assert.deepEqual(select(doc, { x: 5.6, y: -0.05 }, { x: 5.5, y: 0.05 }), []);
  assert.deepEqual(select(doc, { x: 4.35, y: -0.65 }, { x: 5.65, y: 0.65 }), ['no-connect']);
});

test('nonfinite gestures and missing, invalid or empty glyph measurements produce no phantom selection', () => {
  const doc = emptyCircuit(),
    bounds = new Map<string, SchematicSelectionBounds>([
      ['invalid', { x: NaN, y: 0, width: 1, height: 1 }],
      ['negative', { x: 0, y: 0, width: -1, height: 1 }],
      ['empty', { x: 0, y: 0, width: 0, height: 0 }],
    ]),
    visible = new Set(['missing', ...bounds.keys()]);
  assert.deepEqual(
    schematicIdsInRectangle(doc, visible, { x: -1, y: -1 }, { x: 1, y: 1 }, bounds),
    [],
  );
  assert.deepEqual(
    schematicIdsInRectangle(doc, visible, { x: NaN, y: -1 }, { x: 1, y: 1 }, bounds),
    [],
  );
});
