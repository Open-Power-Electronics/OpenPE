import test from 'node:test';
import assert from 'node:assert/strict';
import { createPart, emptyCircuit, pinPositions, uid } from '../lib/circuit';
import { exampleProject } from '../lib/project-example';
import { createReferenceExample } from '../lib/reference-examples';
import { createExample } from '../lib/examples';
import {
  createProject,
  exportKiCad,
  parseProject,
  serializeProject,
  schematicDocumentItems,
} from '../lib/project';
import {
  parseProject as serviceParse,
  serializeProject as serviceSerialize,
} from '../server/project-format.mjs';
import type { ProjectDocument } from '../lib/project-document';
import { ungroupProjectDocument } from '../lib/project-objects';
import { partFields } from '../lib/library';
import { isSimulationField } from '../lib/simulation-fields';

test('component simulation owns source resistance, initial voltage and magnetic coupling', () => {
  const circuit = emptyCircuit();
  circuit.parts.push(createPart(circuit, 'C', 0, 0));
  // Resolve the documented native instance defaults before comparing export bytes.
  const project = parseProject(serializeProject(createProject(circuit)));
  const part = project.schematic.parts[0];
  part.fields = {
    ...partFields(part),
    'OpenPE.SeriesResistance': '50m',
    'OpenPE.Custom': 'Design note',
    'Sim.Device': 'C',
    'OpenPE.InitialVoltage': '5',
    'Sim.Custom': 'Native option',
    'OpenPE.Coupling': '0.98',
  };
  const native = exportKiCad(project, 'schematic');
  const source = serializeProject(project);
  const document: ProjectDocument = JSON.parse(source);
  const component = document.schematic.components![0];
  assert.deepEqual(component.simulation, {
    seriesResistance: '50m',
    device: 'C',
    initialVoltage: '5',
    fields: { 'Sim.Custom': 'Native option' },
    coupling: '0.98',
  });
  assert.equal(component.fields!['OpenPE.Custom'], 'Design note');
  for (const name of ['OpenPE.SeriesResistance', 'OpenPE.InitialVoltage', 'OpenPE.Coupling']) {
    assert.ok(!Object.hasOwn(component.fields!, name));
    assert.equal(isSimulationField(name), true);
  }
  assert.equal(isSimulationField('Sim.Custom'), true);
  assert.equal(isSimulationField('sim.Custom'), true);
  assert.equal(isSimulationField('OpenPE.Custom'), false);
  const reopened = parseProject(source);
  assert.deepEqual(partFields(reopened.schematic.parts[0]), partFields(part));
  assert.equal(exportKiCad(reopened, 'schematic'), native);
  assert.equal(serializeProject(reopened), source);
  assert.equal(serviceSerialize(serviceParse(source)), source);

  component.simulation!.seriesResistance = '100m';
  component.simulation!.initialVoltage = '2.5';
  component.simulation!.coupling = '0.9';
  for (const parse of [parseProject, serviceParse]) {
    const changed = partFields(parse(JSON.stringify(document)).schematic.parts[0]);
    assert.equal(changed['OpenPE.SeriesResistance'], '100m');
    assert.equal(changed['OpenPE.InitialVoltage'], '2.5');
    assert.equal(changed['OpenPE.Coupling'], '0.9');
  }
});

test('simulation settings reject retired canonical fields and duplicate sources before reads', () => {
  const circuit = emptyCircuit();
  circuit.parts.push(createPart(circuit, 'C', 0, 0));
  const source = serializeProject(createProject(circuit));
  const settings = [
    ['seriesResistance', 'OpenPE.SeriesResistance'],
    ['initialVoltage', 'OpenPE.InitialVoltage'],
    ['initialCurrent', 'OpenPE.InitialCurrent'],
    ['coupling', 'OpenPE.Coupling'],
  ] as const;
  for (const [key, name] of settings) {
    for (const duplicate of [false, true]) {
      const document = JSON.parse(source);
      const component = document.schematic.components[0];
      component.fields = { ...component.fields, [name]: '1' };
      if (duplicate) component.simulation = { [key]: '1' };
      for (const parse of [parseProject, serviceParse])
        assert.throws(() => parse(JSON.stringify(document)), /Invalid OpenPE project/);
    }
    for (const simulation of [{ fields: { [name]: '1' } }, { [key]: 1 }]) {
      const document = JSON.parse(source);
      document.schematic.components[0].simulation = simulation;
      for (const parse of [parseProject, serviceParse])
        assert.throws(() => parse(JSON.stringify(document)), /Invalid OpenPE project/);
    }
  }
});

test('components without simulation settings keep their canonical source free of empty defaults', () => {
  const circuit = emptyCircuit();
  circuit.parts.push(createPart(circuit, 'C', 0, 0));
  const source = serializeProject(createProject(circuit));
  const document: ProjectDocument = JSON.parse(source);
  assert.equal(document.schematic.components![0].simulation, undefined);
  document.schematic.components![0].simulation = { fields: {} };
  assert.equal(serializeProject(parseProject(JSON.stringify(document))), source);
  assert.equal(serviceSerialize(serviceParse(JSON.stringify(document))), source);
});

test('components own simulation and complete embedded packages, with default 3D transforms derived once', () => {
  const project = createReferenceExample('reference-lm25017-wson8-flybuck');
  const before = structuredClone(project);
  const source = serializeProject(project);
  const document: ProjectDocument = JSON.parse(source);
  assert.equal(document.version, 1);
  assert.equal(document.pcb?.footprints, undefined);
  for (const footprint of project.pcb!.footprints) {
    const component = document.schematic.components!.find(
      (part) => part.id === footprint.symbolId,
    )!;
    const embedded = component.footprints!.find((part) => part.id === footprint.id)!;
    assert.equal(embedded.libraryId, footprint.libraryId);
    assert.ok(!('symbolId' in embedded));
    assert.ok(embedded.models?.length);
    for (const model of embedded.models!) {
      if (!model.offset)
        assert.deepEqual(footprint.models!.find((item) => item.path === model.path)!.offset, {
          x: 0,
          y: 0,
          z: 0,
        });
    }
    assert.ok(!Object.keys(component.fields ?? {}).some((key) => key.startsWith('Sim.')));
  }
  const controller = document.schematic.components!.find((part) => part.reference === 'U1')!;
  assert.ok(controller.simulation?.library?.startsWith('TI:'));
  assert.ok(controller.simulation?.pins);
  const reopened = parseProject(source);
  assert.deepEqual(reopened.pcb, before.pcb);
  assert.equal(exportKiCad(reopened, 'pcb'), exportKiCad(before, 'pcb'));
  assert.deepEqual(project, before, 'Writing the object format cannot mutate the editor.');
  assert.equal(serviceSerialize(serviceParse(source)), source);
});

test('each network owns its copper and drawing geometry without repeating parent net IDs', () => {
  const project = exampleProject();
  const source = serializeProject(project);
  const document: ProjectDocument = JSON.parse(source);
  for (const key of ['nets', 'tracks', 'vias'] as const) assert.ok(!(key in document.pcb!));
  assert.ok(!('wires' in document.schematic));
  assert.equal(
    schematicDocumentItems(document.schematic, 'wires').length,
    project.schematic.wires.length,
  );
  for (const net of document.schematic.nets ?? []) {
    for (const item of [
      ...(net.pcb?.tracks ?? []),
      ...(net.pcb?.vias ?? []),
      ...(net.pcb?.zones ?? []),
    ])
      assert.ok(!('netId' in item));
  }
  const net = document.schematic.nets!.find((item) => item.pcb?.tracks?.length)!;
  net.pcb!.tracks![0].width = 0.762;
  const reopened = parseProject(JSON.stringify(document));
  assert.equal(
    reopened.pcb!.tracks.find((item) => item.id === net.pcb!.tracks![0].id)!.width,
    0.762,
  );
  assert.deepEqual(
    reopened.pcb!.tracks.map((item) => item.id),
    project.pcb!.tracks.map((item) => item.id),
  );
  assert.deepEqual(reopened.pcb!.footprints, project.pcb!.footprints);
});

test('network grouping retains explicit crossing, named-rail and excluded-pin anchor semantics', () => {
  const circuit = emptyCircuit();
  circuit.wires.push(
    { id: uid(), a: { x: -5, y: 0 }, b: { x: 5, y: 0 } },
    { id: uid(), a: { x: 0, y: -5 }, b: { x: 0, y: 5 } },
  );
  const count = () => JSON.parse(serializeProject(createProject(circuit))).schematic.nets.length;
  assert.equal(count(), 2, 'Crossing lines have no implicit connection.');
  circuit.junctions.push({ id: uid(), x: 0, y: 0 });
  assert.equal(count(), 1);
  circuit.junctions = [];
  circuit.labels.push(
    { id: uid(), text: 'RAIL', x: -5, y: 0 },
    { id: uid(), text: 'RAIL', x: 0, y: -5 },
  );
  assert.equal(count(), 1, 'Named rails organize disconnected geometry together.');
  circuit.labels = [
    { id: uid(), text: 'GLOBAL', x: -5, y: 0, scope: 'global', shape: 'input' },
    { id: uid(), text: 'LOCAL', x: 0, y: -5 },
  ];
  const mixed = JSON.parse(serializeProject(createProject(circuit))).schematic.nets;
  for (const [index, name] of ['GLOBAL', 'LOCAL'].entries()) {
    const net = mixed.find((item: any) =>
      item.schematic.wires?.some((wire: any) => wire.id === circuit.wires[index].id),
    );
    assert.deepEqual(
      net.schematic.labels.map((label: any) => label.text),
      [name],
    );
  }
  circuit.labels = [];
  const resistor = createPart(circuit, 'R', 0, 0);
  const anchor = pinPositions(resistor, circuit.libraries[resistor.libId])[0];
  resistor.x -= anchor.x;
  resistor.y -= anchor.y;
  resistor.excludeFromSimulation = true;
  circuit.parts.push(resistor);
  assert.equal(count(), 1, 'An excluded device pin remains a physical crossing anchor.');
});

test('Source changes to embedded 3D transforms and component deletion stay in the whole project', () => {
  const project = createReferenceExample('reference-lm25017-wson8-flybuck');
  const document: ProjectDocument = JSON.parse(serializeProject(project));
  const component = document.schematic.components!.find((part) => part.footprints?.length)!;
  const footprint = component.footprints![0];
  footprint.models![0].offset = { x: 1.27, y: 0, z: 2.54 };
  footprint.models![0].rotation = { x: 0, y: 90, z: 180 };
  const reopened = parseProject(JSON.stringify(document));
  const model = reopened.pcb!.footprints.find((item) => item.id === footprint.id)!.models![0];
  assert.deepEqual(model.offset, { x: 1.27, y: 0, z: 2.54 });
  assert.deepEqual(model.rotation, { x: 0, y: 90, z: 180 });
  document.schematic.components = document.schematic.components!.filter(
    (part) => part.id !== component.id,
  );
  const deleted = parseProject(JSON.stringify(document));
  assert.ok(!deleted.pcb!.footprints.some((item) => item.id === footprint.id));
  assert.deepEqual(
    deleted.pcb!.tracks,
    project.pcb!.tracks,
    'Deleting a package keeps copper geometry.',
  );
});

test('ambiguous duplicate ownership, parent links and obsolete layouts fail before reads or writes', () => {
  const source = serializeProject(exampleProject());
  const flat = ungroupProjectDocument(JSON.parse(source));
  assert.equal(flat.version, 1);
  assert.throws(() => parseProject(JSON.stringify(flat)), /Invalid OpenPE project/);
  assert.throws(() => serviceParse(JSON.stringify(flat)), /Invalid OpenPE project/);
  const mutations: ((document: any) => void)[] = [
    (document) => {
      document.version = 2;
    },
    (document) => {
      document.pcb.tracks = [];
    },
    (document) => {
      document.schematic.wires = [];
    },
    (document) => {
      document.schematic.nets.push(structuredClone(document.schematic.nets[0]));
    },
    (document) => {
      document.schematic.components[0].footprints[0].symbolId = document.project.id;
    },
    (document) => {
      document.schematic.components[1].footprints[0].order =
        document.schematic.components[0].footprints[0].order;
    },
    (document) => {
      document.schematic.components[0].fields['Sim.Device'] = 'R';
    },
    (document) => {
      document.additionalSchematics = [
        { schematic: { ...document.schematic, id: uid() }, libraries: document.libraries },
      ];
    },
  ];
  for (const mutate of mutations) {
    const document = JSON.parse(source);
    mutate(document);
    assert.throws(() => parseProject(JSON.stringify(document)), /Invalid OpenPE project/);
    assert.throws(() => serviceParse(JSON.stringify(document)), /Invalid OpenPE project/);
  }
  const simulation = JSON.parse(serializeProject(createExample('kicad-buck')));
  const part = simulation.schematic.components.find((item: any) => item.reference === 'R101');
  part.simulation.parameters = 'r=99';
  assert.throws(() => parseProject(JSON.stringify(simulation)), /replaces Sim.Params/);
});
