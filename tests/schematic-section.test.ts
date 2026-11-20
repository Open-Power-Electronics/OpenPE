import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createCapabilityHost } from '../api/capabilities';
import { ProjectCore } from '../core/project-core';
import { registerProjectCapabilities } from '../core/register-project';
import {
  createPart,
  emptyCircuit,
  parseCircuit,
  pinPositions,
  serializeCircuit,
  uid,
} from '../lib/circuit';
import { ownProject } from '../lib/immutable-project';
import { partFields } from '../lib/library';
import { createProject, projectFromNativeFiles } from '../lib/project';
import { fieldId, saveAnnotation } from '../lib/schematic-edit';
import { schematicPolylines, schematicTexts } from '../lib/schematic-text';
import {
  partSchematicSection,
  prepareSchematicSection,
  schematicSectionEmphasisIds,
  schematicSectionIds,
} from '../lib/schematic-section';
import { child, parseSExpr, quote, val } from '../lib/sexpr';
import { PCBProjectSync } from '../lib/pcb-project-sync';
import { updatePCBFromSchematic } from '../lib/pcb-sync';

const footprint = {
  id: 'Test:TwoPin',
  footprint: parseSExpr(`(footprint "TwoPin" (layer "F.Cu")
    (pad "1" thru_hole rect (at 0 0) (size 2 2) (drill 1) (layers "*.Cu" "*.Mask"))
    (pad "2" thru_hole circle (at 2.54 0) (size 2 2) (drill 1) (layers "*.Cu" "*.Mask")))`),
};

function drawingFixture() {
  let circuit = emptyCircuit();
  const hardware = createPart(circuit, 'R', 20.32, 20.32);
  hardware.fields = { Footprint: footprint.id };
  hardware.excludeFromSimulation = true;
  const simulation = createPart(circuit, 'R', 71.12, 20.32);
  simulation.ref = 'R2';
  simulation.fields = {
    Footprint: footprint.id,
    'OpenPE.ModelSource': 'basic',
    'Sim.Pins': '1=+ 2=-',
  };
  circuit.parts.push(hardware, simulation);
  circuit = prepareSchematicSection(circuit, [simulation.id], 'simulation');
  const [ha, hb] = pinPositions(hardware, circuit.libraries[hardware.libId]);
  const [sa, sb] = pinPositions(simulation, circuit.libraries[simulation.libId]);
  const hardwareWire = { id: uid(), a: { x: 10.16, y: ha.y }, b: ha };
  const simulationWire = { id: uid(), a: { x: 60.96, y: sa.y }, b: sa };
  const neutralWire = { id: uid(), a: { x: 101.6, y: 101.6 }, b: { x: 111.76, y: 101.6 } };
  circuit.wires = [hardwareWire, simulationWire, neutralWire];
  circuit.labels = [
    { id: uid(), ...hardwareWire.a, text: 'VIN' },
    { id: uid(), ...simulationWire.a, text: 'VIN' },
    { id: uid(), ...neutralWire.a, text: 'FREE' },
  ];
  const ground = createPart(circuit, 'GND', sb.x, sb.y);
  circuit.parts.push(ground);
  const neutralGround = createPart(circuit, 'GND', 142.24, 50.8);
  circuit.parts.push(neutralGround);
  circuit.noConnects = [
    { id: uid(), ...hb },
    { id: uid(), x: 200.66, y: 200.66 },
  ];
  circuit = saveAnnotation(circuit, 'Shared note', { x: 50.8, y: 50.8 }).circuit;
  const outlineId = uid();
  circuit.original!.push([
    'polyline',
    ['pts', ['xy', '100', '100'], ['xy', '120', '100']],
    ['stroke', ['width', '0.1'], ['type', 'default']],
    ['uuid', quote(outlineId)],
  ]);
  return {
    circuit,
    hardware,
    simulation,
    ground,
    neutralGround,
    hardwareWire,
    simulationWire,
    neutralWire,
    outlineId,
  };
}

test('Hardware requires an assigned Footprint and board inclusion independently of library identity and SPICE participation', () => {
  const { circuit, hardware, simulation } = drawingFixture();
  assert.equal(
    partSchematicSection(circuit.parts.find((part) => part.id === hardware.id)!),
    'hardware',
  );
  assert.equal(
    partSchematicSection(circuit.parts.find((part) => part.id === simulation.id)!),
    'simulation',
  );
  const source = createPart(circuit, 'Port', 0, 0);
  source.libId = 'Simulation_SPICE:VDC';
  source.excludeFromSimulation = false;
  assert.equal(
    partSchematicSection(source),
    'simulation',
    'Every unassigned component belongs to Simulation, including native board-included sources.',
  );
  source.fields = { Footprint: '  Fixture:Source  ' };
  assert.equal(
    partSchematicSection(source),
    'hardware',
    'A library namespace does not control membership.',
  );
  source.fields = { Footprint: ' \t ' };
  assert.equal(partSchematicSection(source), 'simulation');
});

test('native inclusion intent is prepared independently of effective Footprint membership', () => {
  const circuit = emptyCircuit();
  const part = createPart(circuit, 'R', 0, 0);
  part.fields = { Footprint: '' };
  circuit.parts.push(part);
  const excluded = prepareSchematicSection(circuit, [part.id], 'simulation');
  assert.equal(val(child(excluded.parts[0].raw!, 'on_board')), 'no');
  assert.equal(partSchematicSection(excluded.parts[0]), 'simulation');
  const included = prepareSchematicSection(excluded, [part.id], 'hardware');
  assert.equal(val(child(included.parts[0].raw!, 'on_board')), 'yes');
  assert.equal(partSchematicSection(included.parts[0]), 'simulation');
  assert.equal(
    partSchematicSection({ ...included.parts[0], fields: { Footprint: footprint.id } }),
    'hardware',
  );
  assert.equal(
    partSchematicSection({ ...excluded.parts[0], fields: { Footprint: footprint.id } }),
    'simulation',
  );
  assert.equal(prepareSchematicSection(included, [part.id], 'hardware'), included);
  assert.equal(
    val(child(parseCircuit(serializeCircuit(excluded)).parts[0].raw!, 'on_board')),
    'no',
  );
  assert.equal(
    val(child(parseCircuit(serializeCircuit(included)).parts[0].raw!, 'on_board')),
    'yes',
  );
});

test('section preparation retains existing records, native fields and shared units without mutating input', () => {
  const { circuit, hardware, simulation } = drawingFixture();
  const before = serializeCircuit(circuit);
  const target = circuit.parts.find((part) => part.id === simulation.id)!;
  const changed = prepareSchematicSection(circuit, [fieldId(target.id, 'Value')], 'hardware');
  assert.equal(serializeCircuit(circuit), before);
  assert.equal(
    changed.parts.find((part) => part.id === hardware.id),
    circuit.parts.find((part) => part.id === hardware.id),
  );
  assert.equal(changed.libraries, circuit.libraries);
  assert.equal(changed.wires, circuit.wires);
  assert.equal(changed.original, circuit.original);
  const edited = changed.parts.find((part) => part.id === simulation.id)!;
  assert.deepEqual(partFields(edited), partFields(target));
  assert.equal(edited.excludeFromSimulation, target.excludeFromSimulation);
  assert.equal(partSchematicSection(edited), 'hardware');
  assert.equal(prepareSchematicSection(changed, [edited.id], 'hardware'), changed);
  assert.equal(prepareSchematicSection(changed, [], 'simulation'), changed);
  assert.throws(() => prepareSchematicSection(changed, [uid()], 'hardware'), /Choose a component/);
  assert.throws(
    () => prepareSchematicSection(changed, [edited.id], 'other' as never),
    /Choose Real or Virtual/,
  );

  const split = emptyCircuit();
  split.libraries['Test:Split'] = parseSExpr(`(symbol "Test:Split"
    (symbol "Split_1_1" (pin passive line (at 0 0 0) (length 1) (name "A") (number "1")))
    (symbol "Split_2_1" (pin passive line (at 0 0 0) (length 1) (name "B") (number "2"))))`);
  split.parts = [1, 2].map((unit) => ({
    id: uid(),
    libId: 'Test:Split',
    ref: 'U1',
    value: 'Split',
    x: unit * 10,
    y: 10,
    rotation: 0,
    unit,
  }));
  const shared = prepareSchematicSection(split, [split.parts[1].id], 'simulation');
  assert.ok(shared.parts.every((part) => partSchematicSection(part) === 'simulation'));
  assert.ok(shared.parts.every((part) => val(child(part.raw!, 'on_board')) === 'no'));
  assert.ok(
    parseCircuit(serializeCircuit(shared)).parts.every(
      (part) => partSchematicSection(part) === 'simulation',
    ),
  );
});

test('Hardware and Simulation project local geometry and shared neutral content without joining remote labels', () => {
  const {
    circuit,
    hardware,
    simulation,
    ground,
    neutralGround,
    hardwareWire,
    simulationWire,
    neutralWire,
    outlineId,
  } = drawingFixture();
  const before = serializeCircuit(circuit);
  const h = schematicSectionIds(circuit, 'hardware');
  const s = schematicSectionIds(circuit, 'simulation');
  const all = schematicSectionIds(circuit, 'all');
  for (const id of [
    hardware.id,
    fieldId(hardware.id, 'Reference'),
    fieldId(hardware.id, 'Value'),
    hardwareWire.id,
    circuit.labels[0].id,
    circuit.noConnects![0].id,
  ]) {
    assert.ok(h.has(id), id);
    assert.ok(!s.has(id), id);
  }
  for (const id of [
    simulation.id,
    fieldId(simulation.id, 'Reference'),
    fieldId(simulation.id, 'Value'),
    simulationWire.id,
    circuit.labels[1].id,
    ground.id,
    neutralGround.id,
  ]) {
    assert.ok(s.has(id), id);
    assert.ok(!h.has(id), id);
  }
  for (const id of [
    neutralWire.id,
    circuit.labels[2].id,
    circuit.noConnects![1].id,
    schematicTexts(circuit.original)[0].id,
    outlineId,
  ]) {
    assert.ok(h.has(id) && s.has(id), id);
  }
  assert.deepEqual(all, new Set([...h, ...s]));
  assert.equal(serializeCircuit(circuit), before);
  assert.equal(schematicPolylines(circuit.original).length, 1);

  const mixed = {
    ...circuit,
    wires: [...circuit.wires, { id: uid(), a: hardwareWire.a, b: simulationWire.a }],
  };
  for (const view of ['hardware', 'simulation'] as const) {
    const ids = schematicSectionIds(mixed, view);
    assert.ok(
      ids.has(hardwareWire.id) && ids.has(simulationWire.id),
      'Actual mixed geometry is visible in both views.',
    );
  }
});

test('unassigned electrical markers belong to Simulation even when connected to Hardware', () => {
  const circuit = emptyCircuit();
  const resistor = createPart(circuit, 'R', 25.4, 25.4);
  resistor.fields = { Footprint: footprint.id };
  circuit.parts.push(resistor);
  const terminal = pinPositions(resistor, circuit.libraries[resistor.libId])[0];
  const ground = createPart(circuit, 'GND', terminal.x - 12.7, terminal.y);
  circuit.parts.push(ground);
  circuit.wires.push({ id: uid(), a: terminal, b: ground });
  const hardware = schematicSectionIds(circuit, 'hardware');
  const simulation = schematicSectionIds(circuit, 'simulation');
  assert.ok(hardware.has(resistor.id) && !simulation.has(resistor.id));
  assert.ok(simulation.has(ground.id) && !hardware.has(ground.id));
  assert.ok(hardware.has(circuit.wires[0].id) && simulation.has(circuit.wires[0].id));
});

test('section emphasis dims mixed conductor islands in both modes while retaining eligibility and label brightness', () => {
  const { circuit, hardware, simulation, hardwareWire, simulationWire, neutralWire } =
    drawingFixture();
  const hardwareJunction = { id: uid(), ...hardwareWire.a };
  const simulationJunction = { id: uid(), ...simulationWire.a };
  const neutralJunction = { id: uid(), ...neutralWire.a };
  circuit.junctions.push(hardwareJunction, simulationJunction, neutralJunction);
  const source = serializeCircuit(circuit);
  const normalHardware = schematicSectionEmphasisIds(circuit, 'hardware');
  const normalSimulation = schematicSectionEmphasisIds(circuit, 'simulation');
  for (const id of [
    hardware.id,
    fieldId(hardware.id, 'Value'),
    hardwareWire.id,
    hardwareJunction.id,
  ]) {
    assert.ok(normalHardware.has(id));
    assert.ok(!normalSimulation.has(id));
  }
  for (const id of [
    simulation.id,
    fieldId(simulation.id, 'Value'),
    simulationWire.id,
    simulationJunction.id,
  ]) {
    assert.ok(normalSimulation.has(id));
    assert.ok(!normalHardware.has(id));
  }
  for (const id of [neutralWire.id, neutralJunction.id])
    assert.ok(normalHardware.has(id) && normalSimulation.has(id));

  const bridge = { id: uid(), a: hardwareWire.a, b: simulationWire.a };
  const mixed = { ...circuit, wires: [...circuit.wires, bridge] };
  const all = schematicSectionEmphasisIds(mixed, 'all');
  assert.deepEqual(all, schematicSectionIds(mixed, 'all'));
  for (const view of ['hardware', 'simulation'] as const) {
    const eligible = schematicSectionIds(mixed, view);
    const normal = schematicSectionEmphasisIds(mixed, view);
    for (const id of [
      hardwareWire.id,
      simulationWire.id,
      bridge.id,
      hardwareJunction.id,
      simulationJunction.id,
    ]) {
      assert.ok(eligible.has(id), 'Mixed conductor geometry remains reachable.');
      assert.ok(!normal.has(id), 'Mixed conductor geometry is dim in either focused mode.');
      assert.ok(all.has(id));
    }
    for (const id of [
      circuit.labels[0].id,
      circuit.labels[1].id,
      neutralWire.id,
      neutralJunction.id,
    ])
      assert.ok(normal.has(id), 'Mixed labels and neutral conductors keep ordinary brightness.');
    assert.ok(normal.has(view === 'hardware' ? hardware.id : simulation.id));
  }
  assert.equal(serializeCircuit(circuit), source);
});

test('owned visibility caches return independent sets while mutable and caller-frozen inputs stay fresh', () => {
  const { circuit, hardware } = drawingFixture();
  const owned = ownProject(createProject(circuit)).schematic;
  schematicSectionIds(owned, 'hardware').clear();
  assert.ok(schematicSectionIds(owned, 'hardware').has(hardware.id));
  schematicSectionEmphasisIds(owned, 'hardware').clear();
  assert.ok(schematicSectionEmphasisIds(owned, 'hardware').has(hardware.id));
  const mutable = parseCircuit(serializeCircuit(circuit));
  Object.freeze(mutable);
  assert.ok(schematicSectionIds(mutable, 'hardware').has(hardware.id));
  assert.ok(schematicSectionEmphasisIds(mutable, 'hardware').has(hardware.id));
  child(mutable.parts.find((part) => part.id === hardware.id)!.raw!, 'on_board')![1] = 'no';
  assert.ok(!schematicSectionIds(mutable, 'hardware').has(hardware.id));
  assert.ok(schematicSectionIds(mutable, 'simulation').has(hardware.id));
  assert.ok(!schematicSectionEmphasisIds(mutable, 'hardware').has(hardware.id));
  assert.ok(schematicSectionEmphasisIds(mutable, 'simulation').has(hardware.id));
});

test('mutable conductor topology refreshes emphasis even on caller-frozen circuits', () => {
  const { circuit, hardwareWire, simulationWire } = drawingFixture();
  Object.freeze(circuit);
  assert.ok(schematicSectionEmphasisIds(circuit, 'hardware').has(hardwareWire.id));
  circuit.wires.push({ id: uid(), a: hardwareWire.a, b: simulationWire.a });
  for (const view of ['hardware', 'simulation'] as const) {
    assert.ok(schematicSectionIds(circuit, view).has(hardwareWire.id));
    assert.ok(!schematicSectionEmphasisIds(circuit, view).has(hardwareWire.id));
    assert.ok(!schematicSectionEmphasisIds(circuit, view).has(simulationWire.id));
  }
});

function physicalFixture() {
  const circuit = emptyCircuit();
  const part = createPart(circuit, 'R', 10.16, 10.16);
  part.excludeFromSimulation = true;
  part.fields = { Footprint: footprint.id, 'OpenPE.ModelSource': 'basic', 'Sim.Pins': '1=+ 2=-' };
  circuit.parts.push(part);
  circuit.labels = pinPositions(part, circuit.libraries[part.libId]).map((point, index) => ({
    id: uid(),
    ...point,
    text: index ? 'OUT' : 'IN',
  }));
  const board = updatePCBFromSchematic(
    circuit,
    undefined,
    new Map([[footprint.id, footprint]]),
  ).board;
  board.tracks.push({
    id: uid(),
    start: { x: 20, y: 20 },
    end: { x: 25, y: 20 },
    width: 0.25,
    layer: 'F.Cu',
    netId: board.nets[0].id,
  });
  board.vias.push({ id: uid(), x: 25, y: 20, diameter: 0.6, drill: 0.3, netId: board.nets[0].id });
  const manual = structuredClone(board.footprints[0]);
  Object.assign(manual, { id: uid(), symbolId: null, reference: 'MH1', value: 'Manual', x: 100 });
  manual.pads = manual.pads.map((pad) => ({ ...pad, id: uid(), netId: null }));
  manual.graphics = [];
  board.footprints.push(manual);
  return { project: { ...createProject(circuit), pcb: board }, part, manual };
}

test('Core section command removes only the linked package in one undo while retaining assignment, copper and model data', () => {
  const { project, part, manual } = physicalFixture();
  const core = new ProjectCore(project);
  const before = core.getSnapshot();
  const native = core.getNativeFiles();
  core.execute('part.section', {
    schematicId: project.schematic.id,
    partId: part.id,
    section: 'simulation',
  });
  const after = core.getSnapshot();
  assert.equal(after.undoDepth, 1);
  assert.deepEqual(
    after.project!.pcb!.footprints.map((footprint) => footprint.id),
    [manual.id],
  );
  assert.deepEqual(after.project!.pcb!.tracks, before.project!.pcb!.tracks);
  assert.deepEqual(after.project!.pcb!.vias, before.project!.pcb!.vias);
  assert.deepEqual(after.project!.pcb!.nets, before.project!.pcb!.nets);
  const edited = after.project!.schematic.parts[0];
  assert.equal(partSchematicSection(edited), 'simulation');
  assert.deepEqual(partFields(edited), partFields(before.project!.schematic.parts[0]));
  assert.equal(edited.excludeFromSimulation, true);
  const reopened = projectFromNativeFiles(core.getNativeFiles());
  assert.equal(partSchematicSection(reopened.schematic.parts[0]), 'simulation');
  core.undo();
  assert.deepEqual(core.getNativeFiles(), native);
  core.redo();
  assert.equal(partSchematicSection(core.getSnapshot().project!.schematic.parts[0]), 'simulation');
  const blocked = core.getSnapshot().source;
  core.updateSource('pending');
  assert.throws(
    () =>
      core.execute('part.section', {
        schematicId: project.schematic.id,
        partId: part.id,
        section: 'hardware',
      }),
    /Apply the Source/,
  );
  core.discardSource();
  core.setEditingBlocked('This project is closing.');
  assert.throws(
    () =>
      core.execute('part.section', {
        schematicId: project.schematic.id,
        partId: part.id,
        section: 'hardware',
      }),
    /closing/,
  );
  assert.equal(core.getSnapshot().source, blocked);
});

test('generic PCB synchronization drops no-board linked packages while retaining manual packages and copper', () => {
  const { project, part, manual } = physicalFixture();
  const next = prepareSchematicSection(project.schematic, [part.id], 'simulation');
  const result = updatePCBFromSchematic(next, project.pcb, new Map());
  assert.deepEqual(
    result.board.footprints.map((footprint) => footprint.id),
    [manual.id],
  );
  assert.deepEqual(result.board.tracks, project.pcb.tracks);
  assert.deepEqual(result.board.vias, project.pcb.vias);
  assert.equal(partFields(next.parts[0]).Footprint, footprint.id);
});

test('new section-aware operations and human/Agent section commands use the same native preparation', async () => {
  const source = createProject(emptyCircuit());
  for (const actor of ['human', 'agent'] as const) {
    const core = new ProjectCore(source);
    const host = createCapabilityHost({ revision: () => String(core.getSnapshot().revision) });
    const unregister = registerProjectCapabilities(host, core);
    try {
      await host.execute(
        'schematic.operations',
        {
          schematicId: source.schematic.id,
          operations: [{ type: 'addPart', kind: 'R', x: 10.16, y: 10.16, section: 'simulation' }],
        },
        { actor },
      );
      const first = core.getSnapshot().project!.schematic.parts[0];
      assert.equal(partSchematicSection(first), 'simulation');
      assert.equal(core.getSnapshot().undoDepth, 1);
      await host.execute(
        'part.section',
        { schematicId: source.schematic.id, partId: first.id, section: 'hardware' },
        { actor },
      );
      const included = core.getSnapshot().project!.schematic.parts[0];
      assert.equal(partSchematicSection(included), 'simulation');
      assert.equal(val(child(included.raw!, 'on_board')), 'yes');
      assert.equal(core.getSnapshot().undoDepth, 2);
      const definition = host.catalog().find((entry) => entry.id === 'part.section')!;
      assert.equal(definition.owner, 'core');
      assert.equal(definition.mutation, 'document');
      assert.equal(definition.level, 'object');
      await assert.rejects(
        host.execute(
          'part.section',
          { schematicId: source.schematic.id, partId: first.id, section: 'all' },
          { actor },
        ),
        /Invalid/,
      );
    } finally {
      unregister();
      host.dispose();
    }
  }
});

test('native footprint-free V1 section changes preserve the complete loaded PCB and request no libraries', () => {
  const stem = 'lm2596-to220-5-buck';
  const project = projectFromNativeFiles({
    entry: stem + '.kicad_pro',
    files: ['kicad_pro', 'kicad_sch', 'kicad_pcb'].map((extension) => ({
      name: stem + '.' + extension,
      source: readFileSync(
        new URL(`../examples/${stem}/${stem}.${extension}`, import.meta.url),
        'utf8',
      ),
    })),
  });
  const sync = new PCBProjectSync(project);
  const core = new ProjectCore(project, {
    prepare: (next, previous) => sync.prepare(next, previous)?.project ?? next,
  });
  const before = core.getSnapshot();
  const native = core.getNativeFiles();
  const source = before.project!.schematic.parts.find((part) => part.ref === 'V1')!;
  assert.equal(partFields(source).Footprint ?? '', '');
  assert.equal(partSchematicSection(source), 'simulation');
  assert.ok(schematicSectionIds(before.project!.schematic, 'simulation').has(source.id));
  assert.ok(!schematicSectionIds(before.project!.schematic, 'hardware').has(source.id));
  const boardBytes = (files: typeof native) =>
    files.files.find((file) => file.name.endsWith('.kicad_pcb'))!.source;
  for (const section of ['simulation', 'hardware'] as const) {
    core.execute('part.section', { schematicId: project.schematic.id, partId: source.id, section });
    assert.equal(core.getSnapshot().project!.pcb, before.project!.pcb);
    assert.equal(boardBytes(core.getNativeFiles()), boardBytes(native));
    assert.equal(sync.sources.size, 0);
    const current = core
      .getSnapshot()
      .project!.schematic.parts.find((part) => part.id === source.id)!;
    assert.equal(partSchematicSection(current), 'simulation');
    assert.equal(val(child(current.raw!, 'on_board')), section === 'simulation' ? 'no' : 'yes');
  }
  core.undo();
  core.undo();
  assert.deepEqual(core.getNativeFiles(), native);
});

test('Simulation visibility does not remove an imported linked package whose source assignment is unspecified', () => {
  const { project, part } = physicalFixture();
  project.schematic.parts[0].fields = { 'OpenPE.ModelSource': 'basic', 'Sim.Pins': '1=+ 2=-' };
  project.schematic = parseCircuit(serializeCircuit(project.schematic));
  assert.ok(!Object.hasOwn(partFields(project.schematic.parts[0]), 'Footprint'));
  assert.equal(partSchematicSection(project.schematic.parts[0]), 'simulation');
  const sync = new PCBProjectSync(project);
  const core = new ProjectCore(project, {
    prepare: (next, previous) => sync.prepare(next, previous)?.project ?? next,
  });
  const before = core.getSnapshot().project!;
  const native = core.getNativeFiles();
  core.execute('part.properties', {
    schematicId: project.schematic.id,
    partId: part.id,
    value: '22k',
  });
  assert.equal(core.getSnapshot().project!.pcb, before.pcb);
  assert.equal(sync.sources.size, 0);
  core.undo();
  assert.deepEqual(core.getNativeFiles(), native);
});

test('returning an assigned component to Hardware restores its package in the same undo edit', () => {
  const { project, part, manual } = physicalFixture();
  project.schematic = parseCircuit(serializeCircuit(project.schematic));
  const sync = new PCBProjectSync(project);
  sync.sources.set(footprint.id, footprint);
  const core = new ProjectCore(project, {
    prepare: (next, previous) => sync.prepare(next, previous)?.project ?? next,
  });
  const before = core.getNativeFiles();
  core.execute('part.section', {
    schematicId: project.schematic.id,
    partId: part.id,
    section: 'simulation',
  });
  const simulation = core.getNativeFiles();
  core.execute('part.section', {
    schematicId: project.schematic.id,
    partId: part.id,
    section: 'hardware',
  });
  const hardware = core.getSnapshot();
  assert.equal(hardware.undoDepth, 2);
  assert.ok(hardware.project!.pcb!.footprints.some((item) => item.symbolId === part.id));
  assert.ok(hardware.project!.pcb!.footprints.some((item) => item.id === manual.id));
  assert.deepEqual(hardware.project!.pcb!.tracks, project.pcb.tracks);
  assert.deepEqual(hardware.project!.pcb!.vias, project.pcb.vias);
  core.undo();
  assert.deepEqual(core.getNativeFiles(), simulation);
  core.undo();
  assert.deepEqual(core.getNativeFiles(), before);
});

test('pending Hardware package materialization survives another accepted edit and keeps the originating undo', async () => {
  const { project, part } = physicalFixture();
  project.schematic = parseCircuit(serializeCircuit(project.schematic));
  const sync = new PCBProjectSync(project);
  const core = new ProjectCore(project, {
    prepare: (next, previous) => sync.prepare(next, previous)?.project ?? next,
  });
  for (const section of ['simulation', 'hardware'] as const)
    core.execute('part.section', { schematicId: project.schematic.id, partId: part.id, section });
  const pending = core.getSnapshot().project!;
  assert.ok(!pending.pcb!.footprints.some((item) => item.symbolId === part.id));
  core.commitProject({
    ...pending,
    schematic: saveAnnotation(pending.schematic, 'Pending package', { x: 50.8, y: 50.8 }).circuit,
  });
  const basis = core.getSnapshot().project!;
  let loads = 0;
  const ready = await sync.resolve(
    basis,
    async (id) => {
      assert.equal(id, footprint.id);
      loads++;
      return footprint;
    },
    new AbortController().signal,
  );
  assert.equal(loads, 1);
  assert.ok(ready.project.pcb!.footprints.some((item) => item.symbolId === part.id));
  assert.equal(core.materialize(basis, ready.project), true);
  assert.equal(core.getSnapshot().undoDepth, 3);
  core.undo();
  assert.equal(core.getSnapshot().project, pending);
  core.undo();
  assert.equal(partSchematicSection(core.getSnapshot().project!.schematic.parts[0]), 'simulation');
});

test('board-only native removal stays authoritative while stale loaded-board caches cannot hide a section package request', () => {
  const { project, part } = physicalFixture();
  project.schematic = parseCircuit(serializeCircuit(project.schematic));
  const initial = ownProject(project);
  const sync = new PCBProjectSync(initial);
  const missing = ownProject(
    {
      ...initial,
      pcb: {
        ...initial.pcb!,
        footprints: initial.pcb!.footprints.filter((item) => item.symbolId !== part.id),
      },
    },
    initial,
  );
  assert.equal(sync.prepare(missing, initial)!.project, missing);
  const simulation = ownProject(
    { ...missing, schematic: prepareSchematicSection(missing.schematic, [part.id], 'simulation') },
    missing,
  );
  assert.equal(
    sync.prepare(missing, simulation),
    null,
    'A cached board-only result cannot satisfy a missing package request.',
  );
  sync.sources.set(footprint.id, footprint);
  const ready = sync.prepare(missing)!;
  assert.ok(ready.project.pcb!.footprints.some((item) => item.symbolId === part.id));
  assert.equal(sync.prepare(missing), ready, 'Resolved package UUIDs are reused.');
});
