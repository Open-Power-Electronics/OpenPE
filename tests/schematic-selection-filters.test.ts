import assert from 'node:assert/strict';
import test from 'node:test';
import { createPart, emptyCircuit } from '../lib/circuit';
import { fieldId } from '../lib/schematic-edit';
import { defaultSchematicLayers } from '../lib/schematic-layers';
import { visibleSchematicIds } from '../lib/schematic-view';
import {
  defaultSchematicSelectionFilters,
  schematicSelectionFilterOptions,
  selectableSchematicIds,
} from '../lib/schematic-selection-filters';
import { snapSchematicWireTarget } from '../lib/schematic-wire-target';

const noteId = 'a0000000-0000-4000-8000-000000000001';

function fixture() {
  const doc = emptyCircuit();
  const part = createPart(doc, 'R', 25.4, 25.4);
  doc.parts.push(part);
  doc.wires = [{ id: 'wire', a: { x: 10, y: 40 }, b: { x: 30, y: 40 } }];
  doc.junctions = [{ id: 'junction', x: 35, y: 40 }];
  doc.labels = [{ id: 'label', x: 10, y: 40, text: 'SIGNAL' }];
  doc.noConnects = [{ id: 'no-connect', x: 40, y: 40 }];
  doc.original = [
    'kicad_sch',
    [
      'text',
      '"Note"',
      ['at', '50', '50', '0'],
      ['effects', ['font', ['size', '1.27', '1.27']]],
      ['uuid', JSON.stringify(noteId)],
    ],
  ];
  return { doc, part };
}

test('default selection filters retain every visible schematic selection target', () => {
  const { doc } = fixture();
  assert.deepEqual(
    selectableSchematicIds(doc, defaultSchematicLayers),
    visibleSchematicIds(doc, defaultSchematicLayers),
  );
  assert.equal(schematicSelectionFilterOptions.length, 5);
});

test('each filter excludes its objects independently without changing visibility or design data', () => {
  const { doc, part } = fixture();
  const original = structuredClone(doc);
  const visible = visibleSchematicIds(doc, defaultSchematicLayers);
  const groups = {
    symbols: [part.id],
    wires: ['wire', 'junction'],
    labels: ['label'],
    text: [fieldId(part.id, 'Reference'), fieldId(part.id, 'Value'), noteId],
    noConnects: ['no-connect'],
  };
  for (const { id } of schematicSelectionFilterOptions) {
    const selectable = selectableSchematicIds(doc, defaultSchematicLayers, {
      ...defaultSchematicSelectionFilters,
      [id]: false,
    });
    assert.deepEqual(
      selectable,
      new Set([...visible].filter((target) => !groups[id].includes(target))),
    );
    assert.deepEqual(visibleSchematicIds(doc, defaultSchematicLayers), visible);
  }
  assert.deepEqual(doc, original);
});

test('selection filters intersect visibility while fields remain independent of symbol selection', () => {
  const { doc, part } = fixture();
  const fields = selectableSchematicIds(
    doc,
    { ...defaultSchematicLayers, references: false, notes: false },
    { symbols: false, wires: false, labels: false, text: true, noConnects: false },
  );
  assert.deepEqual(fields, new Set([fieldId(part.id, 'Value')]));
  const none = Object.fromEntries(schematicSelectionFilterOptions.map(({ id }) => [id, false]));
  assert.equal(
    selectableSchematicIds(doc, defaultSchematicLayers, {
      ...defaultSchematicSelectionFilters,
      ...none,
    }).size,
    0,
  );
});

test('wire snapping still resolves visible electrical targets excluded from selection', () => {
  const { doc } = fixture();
  assert.equal(
    selectableSchematicIds(doc, defaultSchematicLayers, {
      ...defaultSchematicSelectionFilters,
      wires: false,
    }).has('wire'),
    false,
  );
  assert.deepEqual(
    snapSchematicWireTarget(
      doc,
      visibleSchematicIds(doc, defaultSchematicLayers),
      { x: 20.32, y: 40.2 },
      0.5,
    ),
    { x: 20.32, y: 40 },
  );
});
