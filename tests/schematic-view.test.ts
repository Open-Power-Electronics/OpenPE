import { emptyCircuit, pinPositions } from '../lib/circuit';
import test from 'node:test';
import assert from 'node:assert/strict';
import { exampleProject } from '../lib/project-example';
import { fieldId, objectPosition, moveSelection } from '../lib/schematic-edit';
import { resizeDrawingView, type CanvasBounds } from '../lib/drawing-viewport';
import {
  defaultSchematicLayers,
  validateSchematicLayers,
  schematicTextColors,
} from '../lib/schematic-layers';
import {
  fieldDragLinks,
  visibleSchematicIds,
  visibleSchematicWireTargetIds,
  visibleJunctions,
} from '../lib/schematic-view';
import { defaultAppearance, validateAppearance, appearanceVariables } from '../lib/appearance';
import { serializeProject, exportKiCad } from '../lib/project';
import { ownProject, ownProjectData } from '../lib/immutable-project';

test('canvas expansion preserves screen positions and scale through collapse, resize and restore', () => {
  const original = { x: -21.4, y: 18.7, width: 143.2 };
  const expandedPanel = { left: 450, top: 162, width: 1018, height: 710 };
  const worldPoints = [
    { x: 30, y: 40 },
    { x: 91.44, y: 72.39 },
  ];
  const screen = (view: typeof original, bounds: CanvasBounds, p: { x: number; y: number }) => ({
    x: bounds.left + ((p.x - view.x) * bounds.width) / view.width,
    y: bounds.top + ((p.y - view.y) * bounds.width) / view.width,
  });
  let view = original;
  let bounds = expandedPanel;
  for (const next of [
    { left: 12, top: 162, width: 1456, height: 710 },
    { left: 12, top: 202, width: 1096.5, height: 510.5 },
    { left: 398.5, top: 202, width: 710, height: 510.5 },
    expandedPanel,
  ]) {
    const resized = resizeDrawingView(view, bounds, next);
    assert.ok(Math.abs(resized.width / next.width - original.width / expandedPanel.width) < 1e-10);
    for (const point of worldPoints) {
      const before = screen(view, bounds, point);
      const after = screen(resized, next, point);
      assert.ok(Math.abs(after.x - before.x) < 1e-8);
      assert.ok(Math.abs(after.y - before.y) < 1e-8);
    }
    view = resized;
    bounds = next;
  }
  for (const key of ['x', 'y', 'width'] as const)
    assert.ok(Math.abs(view[key] - original[key]) < 1e-10);
  const hidden = { left: 0, top: 0, width: 0, height: 0 };
  assert.equal(resizeDrawingView(original, expandedPanel, hidden), original);
  assert.equal(resizeDrawingView(original, hidden, expandedPanel), original);
});

test('layer visibility excludes hidden geometry from selection without changing project or exports', () => {
  const project = exampleProject(),
    doc = project.schematic,
    part = doc.parts[0];
  const json = serializeProject(project),
    native = exportKiCad(project, 'schematic');
  const layers = { ...defaultSchematicLayers, symbols: false, values: false, wires: false };
  const visible = visibleSchematicIds(doc, layers);
  assert.equal(visible.has(part.id), false);
  assert.equal(visible.has(fieldId(part.id, 'Value')), false);
  assert.equal(visible.has(fieldId(part.id, 'Reference')), !part.ref.startsWith('#'));
  assert.ok(doc.wires.every((wire) => !visible.has(wire.id)));
  assert.ok(doc.junctions.every((junction) => !visible.has(junction.id)));
  const none = Object.fromEntries(Object.keys(layers).map((key) => [key, false]));
  assert.equal(visibleSchematicIds(doc, validateSchematicLayers(none)).size, 0);
  assert.equal(serializeProject(project), json);
  assert.equal(exportKiCad(project, 'schematic'), native);
});

test('wire target eligibility follows electrical visibility and retains displayed junction filtering', () => {
  const doc = exampleProject().schematic;
  doc.wires = [
    { id: 'a', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } },
    { id: 'b', a: { x: 10, y: 0 }, b: { x: 10, y: 10 } },
  ];
  doc.junctions = [
    { id: 'corner', x: 10, y: 0 },
    { id: 'isolated', x: 40, y: 40 },
  ];
  doc.labels = [{ id: 'label', x: 10, y: 10, text: 'OUT' }];
  const before = structuredClone(doc);
  const eligible = visibleSchematicWireTargetIds(doc, defaultSchematicLayers);
  const electricalIds = new Set(
    [...doc.parts, ...doc.wires, ...doc.junctions, ...doc.labels].map((item) => item.id),
  );
  for (const layers of [
    defaultSchematicLayers,
    { ...defaultSchematicLayers, pinNames: false, pinNumbers: false },
    { ...defaultSchematicLayers, references: false, values: false, fields: false, notes: false },
  ]) {
    assert.deepEqual(visibleSchematicWireTargetIds(doc, layers), eligible);
    assert.deepEqual(
      visibleSchematicWireTargetIds(doc, layers),
      new Set([...visibleSchematicIds(doc, layers)].filter((id) => electricalIds.has(id))),
    );
  }
  assert.equal(eligible.has('corner'), false, 'Redundant two-way junctions remain hidden.');
  assert.equal(eligible.has('isolated'), true);
  for (const layer of ['symbols', 'wires', 'labels'] as const) {
    const layers = { ...defaultSchematicLayers, [layer]: false };
    assert.deepEqual(
      visibleSchematicWireTargetIds(doc, layers),
      new Set([...visibleSchematicIds(doc, layers)].filter((id) => electricalIds.has(id))),
    );
  }
  doc.wires.push({ id: 'branch', a: { x: 10, y: 0 }, b: { x: 20, y: 0 } });
  assert.equal(visibleSchematicWireTargetIds(doc, defaultSchematicLayers).has('corner'), true);
  assert.deepEqual({ ...doc, wires: doc.wires.slice(0, -1) }, before);
});

test('field drag guides follow the owner and field preview in both ordinary and connected drag', () => {
  const doc = exampleProject().schematic,
    part = doc.parts[0];
  const id = fieldId(part.id, 'Value'),
    at = objectPosition(doc, id)!;
  const before = structuredClone(doc),
    delta = { x: 2.54, y: -1.27 };
  const [link] = fieldDragLinks(doc, [id, part.id, 'unattached-note'], (key) =>
    key === id ? delta : { x: 0, y: 0 },
  );
  assert.deepEqual(link.from, { x: part.x, y: part.y });
  assert.deepEqual(link.to, { x: at.x + delta.x, y: at.y + delta.y });
  const [together] = fieldDragLinks(doc, [id, part.id], (key) =>
    key === part.id ? delta : { x: 0, y: 0 },
  );
  assert.deepEqual(together.from, { x: part.x + delta.x, y: part.y + delta.y });
  assert.deepEqual(together.to, link.to);
  const moved = moveSelection(doc, [id], delta, true);
  const movedAt = objectPosition(moved, id)!;
  assert.deepEqual(fieldDragLinks(moved, [id], () => ({ x: 0, y: 0 }))[0].to, {
    x: movedAt.x,
    y: movedAt.y,
  });
  assert.deepEqual(doc, before);
});

test('layer preferences require current fields and text roles follow actual canvas brightness', () => {
  const { schematicLayers: _layers, ...legacy } = defaultAppearance;
  assert.throws(() => validateAppearance(legacy), /appearance/i);
  const restored = validateAppearance(defaultAppearance);
  assert.deepEqual(restored.schematicLayers, defaultSchematicLayers);
  restored.schematicLayers.references = false;
  assert.equal(defaultSchematicLayers.references, true);
  assert.throws(() => validateSchematicLayers({ values: 0 }));
  assert.throws(() => validateSchematicLayers({ unexpected: false }));
  const darkCanvas = structuredClone(defaultAppearance);
  darkCanvas.profiles.shared.background = '#151515';
  const variables = appearanceVariables(darkCanvas, 'light');
  for (const [token, color] of Object.entries(schematicTextColors.dark))
    assert.equal(variables[token], color);
  for (const palette of Object.values(schematicTextColors)) {
    assert.equal(palette['--schematic-pin-name'], palette['--schematic-reference']);
    assert.equal(palette['--schematic-pin-number'], palette['--schematic-reference']);
    assert.equal(palette['--schematic-net-label'], palette['--wire']);
    assert.equal(palette['--schematic-global-label'], palette['--wire']);
    assert.equal(palette['--schematic-field'], palette['--schematic-note']);
    assert.equal(palette['--schematic-guide'], palette['--schematic-note']);
    assert.equal(new Set(Object.values(palette)).size, 4);
  }
  darkCanvas.profiles.shared.accent = '#ff0000';
  assert.equal(appearanceVariables(darkCanvas, 'light')['--wire'], variables['--wire']);
});

test('owned visibility caches return independent containers and invalidate for layers, branches and pin poses', () => {
  const source = exampleProject();
  const pin = pinPositions(
    source.schematic.parts[0],
    source.schematic.libraries[source.schematic.parts[0].libId],
  )[0];
  source.schematic.wires = [
    { id: 'wire-a', a: pin, b: { x: pin.x + 5, y: pin.y } },
    { id: 'wire-b', a: pin, b: { x: pin.x, y: pin.y + 5 } },
  ];
  source.schematic.junctions = [{ id: 'at-pin', ...pin }];
  const project = ownProject(source);
  const doc = project.schematic;
  const visible = visibleSchematicIds(doc, defaultSchematicLayers);
  assert.ok(visible.has('at-pin'));
  visible.clear();
  assert.ok(visibleSchematicIds(doc, defaultSchematicLayers).has('at-pin'));
  const junctions = visibleJunctions(doc);
  junctions[0].x = 999;
  junctions.length = 0;
  assert.equal(visibleJunctions(doc)[0].x, pin.x);
  const layers = { ...defaultSchematicLayers };
  for (const key of ['wires', 'symbols', 'values', 'references', 'notes', 'wires'] as const) {
    layers[key] = !layers[key];
    assert.deepEqual(
      visibleSchematicIds(doc, layers),
      visibleSchematicIds(structuredClone(doc), layers),
    );
  }
  const moved = ownProject(
    {
      ...project,
      schematic: {
        ...doc,
        parts: doc.parts.map((part, index) => (index ? part : { ...part, x: part.x + 1.27 })),
      },
    },
    project,
  );
  assert.equal(moved.schematic.wires, doc.wires);
  assert.equal(moved.schematic.junctions, doc.junctions);
  assert.equal(visibleJunctions(moved.schematic).length, 0);
  const branch = ownProject(
    {
      ...moved,
      schematic: {
        ...moved.schematic,
        wires: [...doc.wires, { id: 'wire-c', a: pin, b: { x: pin.x - 5, y: pin.y } }],
      },
    },
    moved,
  );
  assert.ok(visibleSchematicIds(branch.schematic, defaultSchematicLayers).has('at-pin'));
  const caller = structuredClone(moved.schematic);
  Object.freeze(caller);
  assert.equal(visibleJunctions(caller).length, 0);
  caller.wires.push({ id: 'wire-c', a: pin, b: { x: pin.x - 5, y: pin.y } });
  assert.equal(visibleJunctions(caller).length, 1);
  assert.deepEqual(
    visibleSchematicIds(ownProjectData(doc), layers),
    visibleSchematicIds(doc, layers),
  );
});

test('two-way wire corners omit dots while T branches, explicit crossings and pin connections retain them', () => {
  const doc = emptyCircuit();
  doc.wires = [
    { id: 'a', a: { x: 0, y: 0 }, b: { x: 10, y: 0 } },
    { id: 'b', a: { x: 10, y: 0 }, b: { x: 10, y: 10 } },
  ];
  doc.junctions = [
    { id: 'corner', x: 10, y: 0 },
    { id: 'isolated', x: 40, y: 40 },
  ];
  const before = structuredClone(doc);
  assert.deepEqual(
    visibleJunctions(doc).map((j) => j.id),
    ['isolated'],
  );
  assert.equal(visibleSchematicIds(doc, defaultSchematicLayers).has('corner'), false);
  assert.deepEqual(doc, before);
  doc.wires.push({ id: 'c', a: { x: 10, y: 0 }, b: { x: 20, y: 0 } });
  assert.equal(
    visibleJunctions(doc).some((j) => j.id === 'corner'),
    true,
  );
  doc.wires = [
    { id: 'x', a: { x: 0, y: 0 }, b: { x: 20, y: 0 } },
    { id: 'y', a: { x: 10, y: -10 }, b: { x: 10, y: 10 } },
  ];
  assert.equal(
    visibleJunctions(doc).some((j) => j.id === 'corner'),
    true,
  );
  const circuit = exampleProject().schematic;
  const pin = pinPositions(circuit.parts[0], circuit.libraries[circuit.parts[0].libId])[0];
  circuit.wires = [
    { id: 'p1', a: pin, b: { x: pin.x + 5, y: pin.y } },
    { id: 'p2', a: pin, b: { x: pin.x, y: pin.y + 5 } },
  ];
  circuit.junctions = [{ id: 'pin', ...pin }];
  assert.equal(visibleJunctions(circuit).length, 1);
});
