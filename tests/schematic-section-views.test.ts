import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SchematicDrawing from '../components/SchematicDrawing';
import { createPart, emptyCircuit, pinPositions, snap, uid } from '../lib/circuit';
import { fieldId, saveAnnotation } from '../lib/schematic-edit';
import { createProject, serializeProject } from '../lib/project';
import { ownProject } from '../lib/immutable-project';
import { defaultSchematicLayers, type SchematicLayers } from '../lib/schematic-layers';
import {
  defaultSchematicSelectionFilters,
  selectableSchematicIds,
} from '../lib/schematic-selection-filters';
import { visibleSchematicIds, visibleSchematicWireTargetIds } from '../lib/schematic-view';
import {
  prepareSchematicSection,
  schematicSectionEmphasisIds,
  type SchematicSectionView,
} from '../lib/schematic-section';
import { createSchematicWireTargetResolver } from '../lib/schematic-wire-target';
import { schematicTexts } from '../lib/schematic-text';

function fixture() {
  let circuit = emptyCircuit();
  const hardware = createPart(circuit, 'R', 10.16, 10.16);
  hardware.fields = { Footprint: 'Resistor_SMD:R_0805_2012Metric' };
  const simulation = createPart(circuit, 'L', 30.48, 30.48);
  simulation.x += 0.23;
  circuit.parts.push(hardware, simulation);
  circuit = prepareSchematicSection(circuit, [simulation.id], 'simulation');
  const [hardwarePin, hardwareOther] = pinPositions(hardware, circuit.libraries[hardware.libId]);
  const [simulationPin, simulationOther] = pinPositions(
    simulation,
    circuit.libraries[simulation.libId],
  );
  const hardwareWire = {
    id: uid(),
    a: hardwarePin,
    b: { x: hardwarePin.x - 6.35, y: hardwarePin.y },
  };
  const simulationWire = {
    id: uid(),
    a: simulationPin,
    b: { x: simulationPin.x + 6.35, y: simulationPin.y },
  };
  circuit.wires.push(hardwareWire, simulationWire);
  const hardwareJunction = { id: uid(), ...hardwareWire.b };
  const simulationJunction = { id: uid(), ...simulationWire.b };
  circuit.junctions.push(hardwareJunction, simulationJunction);
  const hardwareLabel = { id: uid(), ...hardwareWire.b, text: 'HARDWARE' };
  const simulationLabel = { id: uid(), ...simulationWire.b, text: 'SIMULATION' };
  circuit.labels.push(hardwareLabel, simulationLabel);
  const hardwareNoConnect = { id: uid(), ...hardwareOther };
  const simulationNoConnect = { id: uid(), ...simulationOther };
  circuit.noConnects = [hardwareNoConnect, simulationNoConnect];
  circuit = saveAnnotation(circuit, 'Shared design note', { x: 0, y: 50.8 }).circuit;
  return {
    circuit,
    hardware,
    simulation,
    hardwareWire,
    simulationWire,
    hardwareJunction,
    simulationJunction,
    hardwareLabel,
    simulationLabel,
    hardwareNoConnect,
    simulationNoConnect,
    simulationPin,
  };
}

test('section interaction eligibility retains only primary parts, fields and local drawing islands', () => {
  const {
    circuit,
    hardware,
    simulation,
    hardwareWire,
    simulationWire,
    hardwareLabel,
    simulationLabel,
    hardwareNoConnect,
    simulationNoConnect,
  } = fixture();
  const project = createProject(circuit);
  const before = serializeProject(project);
  const hardwareIds = visibleSchematicIds(circuit, defaultSchematicLayers, 'hardware');
  const simulationIds = visibleSchematicIds(circuit, defaultSchematicLayers, 'simulation');
  const allIds = visibleSchematicIds(circuit, defaultSchematicLayers, 'all');
  for (const [ids, included, excluded] of [
    [
      hardwareIds,
      [
        hardware.id,
        fieldId(hardware.id, 'Reference'),
        fieldId(hardware.id, 'Value'),
        hardwareWire.id,
        hardwareLabel.id,
        hardwareNoConnect.id,
      ],
      [
        simulation.id,
        fieldId(simulation.id, 'Reference'),
        fieldId(simulation.id, 'Value'),
        simulationWire.id,
        simulationLabel.id,
        simulationNoConnect.id,
      ],
    ],
    [
      simulationIds,
      [
        simulation.id,
        fieldId(simulation.id, 'Reference'),
        fieldId(simulation.id, 'Value'),
        simulationWire.id,
        simulationLabel.id,
        simulationNoConnect.id,
      ],
      [
        hardware.id,
        fieldId(hardware.id, 'Reference'),
        fieldId(hardware.id, 'Value'),
        hardwareWire.id,
        hardwareLabel.id,
        hardwareNoConnect.id,
      ],
    ],
  ] as const) {
    for (const id of included) assert.ok(ids.has(id), id);
    for (const id of excluded) assert.equal(ids.has(id), false, id);
    assert.ok(ids.has(schematicTexts(circuit.original)[0].id));
  }
  assert.deepEqual(allIds, new Set([...hardwareIds, ...simulationIds]));
  assert.deepEqual(
    selectableSchematicIds(
      circuit,
      defaultSchematicLayers,
      defaultSchematicSelectionFilters,
      'hardware',
    ),
    hardwareIds,
  );
  assert.deepEqual(
    visibleSchematicIds(circuit, defaultSchematicLayers),
    allIds,
    'Existing standalone consumers retain All by default.',
  );
  assert.equal(serializeProject(project), before, 'Viewing never edits native content.');
});

test('section wire targets exclude inactive-section pins and wires independently of annotation and selection eligibility', () => {
  const {
    circuit,
    hardware,
    simulation,
    hardwareWire,
    simulationWire,
    hardwareLabel,
    simulationLabel,
    simulationPin,
  } = fixture();
  const hardwareTargets = visibleSchematicWireTargetIds(
    circuit,
    defaultSchematicLayers,
    'hardware',
  );
  const simulationTargets = visibleSchematicWireTargetIds(
    circuit,
    defaultSchematicLayers,
    'simulation',
  );
  for (const id of [hardware.id, hardwareWire.id, hardwareLabel.id])
    assert.ok(hardwareTargets.has(id));
  for (const id of [simulation.id, simulationWire.id, simulationLabel.id])
    assert.equal(hardwareTargets.has(id), false);
  const hiddenAnnotations: SchematicLayers = {
    ...defaultSchematicLayers,
    references: false,
    values: false,
  };
  assert.deepEqual(
    visibleSchematicWireTargetIds(circuit, hiddenAnnotations, 'hardware'),
    hardwareTargets,
  );
  const raw = { x: simulationPin.x - 0.05, y: simulationPin.y + 0.05 };
  const hardwareSnap = createSchematicWireTargetResolver(circuit, hardwareTargets)(raw, 0.5, true);
  const simulationSnap = createSchematicWireTargetResolver(circuit, simulationTargets)(
    raw,
    0.5,
    true,
  );
  assert.deepEqual(hardwareSnap, { x: snap(raw.x), y: snap(raw.y) });
  assert.deepEqual(
    simulationSnap,
    simulationPin,
    'A visible exact imported pin remains a magnetic target.',
  );
  assert.notEqual(
    hardwareSnap.x,
    simulationSnap.x,
    'Dimmed off-grid pins cannot attract the cursor.',
  );
});

test('section drawing retains all objects and dims only the other section without changing native data', () => {
  const {
    circuit,
    hardware,
    simulation,
    hardwareWire,
    simulationWire,
    hardwareJunction,
    simulationJunction,
    hardwareLabel,
    simulationLabel,
    hardwareNoConnect,
    simulationNoConnect,
  } = fixture();
  const project = createProject(circuit);
  const native = serializeProject(project);
  const render = (view: SchematicSectionView, layers = defaultSchematicLayers, drawing = circuit) =>
    renderToStaticMarkup(
      createElement(
        'svg',
        null,
        createElement(SchematicDrawing, {
          drawing,
          libraries: drawing.libraries,
          junctions: drawing.junctions,
          selection: [],
          layers,
          sectionIds: view === 'all' ? undefined : schematicSectionEmphasisIds(drawing, view),
          hitPadding: 0.5,
          offset: () => ({ x: 0, y: 0 }),
          onPointerDown: () => {},
          onPinPointerDown: () => {},
        }),
      ),
    );
  const primary = [hardware, hardwareWire, hardwareJunction, hardwareLabel, hardwareNoConnect];
  const other = [
    simulation,
    simulationWire,
    simulationJunction,
    simulationLabel,
    simulationNoConnect,
  ];
  const opacity = (html: string, id: string) => {
    const object = html.match(new RegExp(`<[^>]+data-selection-id="${id}"[^>]*>`));
    assert.ok(object, `Object ${id} remains rendered.`);
    return object[0].match(/opacity="([\d.]+)"/)?.[1];
  };
  for (const [view, primaryOpacity, otherOpacity] of [
    ['hardware', '1', '0.25'],
    ['simulation', '0.25', '1'],
    ['all', '1', '1'],
  ] as const) {
    const html = render(view);
    for (const item of primary) assert.equal(opacity(html, item.id), primaryOpacity);
    for (const item of other) assert.equal(opacity(html, item.id), otherOpacity);
    for (const [part, value] of [
      [hardware, primaryOpacity],
      [simulation, otherOpacity],
    ] as const)
      assert.match(
        html,
        new RegExp(
          `<g opacity="${value}"><g data-selection-id="${part.id}" class="part-annotations`,
        ),
      );
    assert.match(html, /Shared design note/);
  }
  const hidden = render('hardware', {
    ...defaultSchematicLayers,
    symbols: false,
    wires: false,
    labels: false,
    noConnects: false,
    notes: false,
  });
  assert.doesNotMatch(hidden, /data-testid="part-|class="net-annotation|Shared design note/);
  assert.doesNotMatch(hidden, new RegExp(`data-selection-id="${simulationWire.id}"`));
  const mixed = structuredClone(circuit);
  const joiningWire = { id: uid(), a: hardwareWire.b, b: simulationWire.b };
  const hardwareBranch = {
    id: uid(),
    a: hardwareWire.b,
    b: { ...hardwareWire.b, y: hardwareWire.b.y + 6.35 },
  };
  const simulationBranch = {
    id: uid(),
    a: simulationWire.b,
    b: { ...simulationWire.b, y: simulationWire.b.y + 6.35 },
  };
  mixed.wires.push(joiningWire, hardwareBranch, simulationBranch);
  for (const view of ['hardware', 'simulation'] as const) {
    const html = render(view, defaultSchematicLayers, mixed);
    for (const item of [
      hardwareWire,
      simulationWire,
      joiningWire,
      hardwareBranch,
      simulationBranch,
      hardwareJunction,
      simulationJunction,
    ]) {
      assert.equal(
        opacity(html, item.id),
        '0.25',
        'Mixed wires and junctions dim in both sections.',
      );
      assert.ok(visibleSchematicWireTargetIds(mixed, defaultSchematicLayers, view).has(item.id));
    }
    for (const item of [hardwareLabel, simulationLabel]) assert.equal(opacity(html, item.id), '1');
  }
  const all = render('all', defaultSchematicLayers, mixed);
  for (const item of [
    hardwareWire,
    simulationWire,
    joiningWire,
    hardwareBranch,
    simulationBranch,
    hardwareJunction,
    simulationJunction,
  ])
    assert.equal(opacity(all, item.id), '1');
  assert.equal(serializeProject(project), native);
});

test('section-aware filters and owned caches cannot expose a different section or return poisoned IDs', () => {
  const { circuit, hardware, simulation } = fixture();
  const project = ownProject(createProject(circuit));
  const doc = project.schematic;
  const first = visibleSchematicIds(doc, defaultSchematicLayers, 'hardware');
  first.add(simulation.id);
  assert.equal(
    visibleSchematicIds(doc, defaultSchematicLayers, 'hardware').has(simulation.id),
    false,
  );
  assert.ok(visibleSchematicIds(doc, defaultSchematicLayers, 'simulation').has(simulation.id));
  assert.ok(visibleSchematicIds(doc, defaultSchematicLayers, 'all').has(hardware.id));
  const fieldsOnly = selectableSchematicIds(
    doc,
    { ...defaultSchematicLayers, symbols: false },
    { ...defaultSchematicSelectionFilters, wires: false },
    'hardware',
  );
  assert.equal(fieldsOnly.has(hardware.id), false);
  assert.ok(fieldsOnly.has(fieldId(hardware.id, 'Reference')));
  assert.equal(fieldsOnly.has(fieldId(simulation.id, 'Reference')), false);
  const mutable = structuredClone(doc);
  const next = prepareSchematicSection(mutable, [hardware.id], 'simulation');
  assert.equal(
    visibleSchematicIds(next, defaultSchematicLayers, 'hardware').has(hardware.id),
    false,
  );
  assert.ok(visibleSchematicIds(next, defaultSchematicLayers, 'simulation').has(hardware.id));
});
