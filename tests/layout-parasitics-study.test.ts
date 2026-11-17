import test from 'node:test';
import assert from 'node:assert/strict';
import { createPart, emptyCircuit, parseCircuit, serializeCircuit, uid } from '../lib/circuit';
import {
  partFields,
  partFootprint,
  symbolAnnotation,
  extraSymbolAnnotations,
} from '../lib/library';
import { createEmptyPCB } from '../lib/pcb-layout';
import type { Footprint } from '../lib/pcb';
import {
  appendSchematic,
  createProject,
  findSchematic,
  parseProject,
  projectFromNativeFiles,
  projectNativeFiles,
  projectSchematics,
  serializeProject,
} from '../lib/project';
import { child, children, quote, val } from '../lib/sexpr';
import { schematicTexts } from '../lib/schematic-text';
import { saveAnnotation } from '../lib/schematic-edit';
import { ProjectCore } from '../core/project-core';
import { analyzeLayoutParasitics } from '../plugins/layout-parasitics/domain/analysis';
import {
  parasiticsStudyValues,
  parasiticsComponentValue,
  prepareParasiticsStudy,
} from '../plugins/layout-parasitics/domain/study';
import {
  buildSpiceDeck,
  defaultTransient,
  passiveValue,
  spiceNets,
  simulationSupportError,
} from '../plugins/spice-simulation/domain/spice';
import { participatesInSimulation } from '../lib/simulation-participation';
import { basicSimulationKind } from '../lib/simulation-model-source';

function fixture() {
  const schematic = emptyCircuit();
  schematic.title = 'Original design';
  schematic.parts.push(createPart(schematic, 'R', 40.64, 20.32));
  schematic.parts.push(createPart(schematic, 'L', 60.96, 20.32));
  schematic.labels.push({ id: uid(), x: 0, y: 0, text: 'LP_Signal_1' });
  const project = createProject(schematic);
  const board = createEmptyPCB();
  const netId = uid();
  const terminal = (x: number, reference: string): Footprint => ({
    id: uid(),
    symbolId: null,
    libraryId: 'Study:Terminal',
    reference,
    value: 'Terminal',
    x,
    y: 5,
    side: 'front',
    rotation: 0,
    graphics: [],
    pads: [
      {
        id: uid(),
        number: '1',
        x: 0,
        y: 0,
        rotation: 0,
        layers: ['F.Cu'],
        netId,
        size: { x: 0.8, y: 0.8 },
        type: 'smd',
        shape: 'circle',
      },
    ],
  });
  board.nets = [{ id: netId, name: 'Signal' }];
  board.footprints = [terminal(5, 'J1'), terminal(25, 'J2')];
  board.tracks = [
    { id: uid(), netId, start: { x: 5, y: 5 }, end: { x: 25, y: 5 }, width: 0.35, layer: 'F.Cu' },
  ];
  project.pcb = board;
  return {
    project,
    input: {
      boardId: board.id,
      schematicId: schematic.id,
      startId: board.footprints[0].pads[0].id,
      endId: board.footprints[1].pads[0].id,
      copperThicknessMm: 0.067123,
      viaPlatingMm: 0.025,
    },
  };
}

test('a study retains measured results with two-decimal native Values, independent labels and manufacturing exclusions', () => {
  const { project, input } = fixture();
  const before = serializeProject(project);
  const beforeNative = projectNativeFiles(project, 'design.kicad_pro');
  const measurement = analyzeLayoutParasitics(project.pcb!, input);
  const result = prepareParasiticsStudy(project, input);
  const study = findSchematic(result.project, result.schematicId)!;
  assert.equal(serializeProject(project), before, 'Preparation must not mutate any source data.');
  assert.equal(result.schematicId, project.schematic.id);
  assert.equal(projectSchematics(result.project).length, 1);
  assert.deepEqual(study.parts.slice(0, project.schematic.parts.length), project.schematic.parts);
  assert.ok(
    study.parts.slice(0, 2).every((part, index) => part === project.schematic.parts[index]),
  );
  assert.equal(result.project.pcb, project.pcb);
  assert.equal(study.title, project.schematic.title);
  assert.deepEqual(result.values, {
    resistanceOhm: measurement.equivalentResistanceOhm,
    partialInductanceNh: measurement.shortestPartialInductanceNh,
  });
  assert.equal(result.references.resistor, 'R2');
  assert.equal(result.references.inductor, 'L2');
  assert.equal(result.omittedInductance, false);
  assert.notEqual(result.labels.start, result.labels.end);
  assert.notEqual(result.labels.start, project.schematic.labels[0].text);
  assert.deepEqual(result.labels, { start: 'LP_J1.1', end: 'LP_J2.1' });
  assert.equal(study.labels.length, 3);
  assert.ok(study.labels.every((label) => label.scope === undefined));
  assert.deepEqual(
    new Set(study.labels.slice(1).map((label) => label.text)),
    new Set(Object.values(result.labels)),
  );
  const resistor = study.parts.find((part) => part.ref === result.references.resistor)!;
  const inductor = study.parts.find((part) => part.ref === result.references.inductor)!;
  assert.match(resistor.value, /^\d+\.\d{2}[fpnµmkMG]?Ω$/);
  assert.match(inductor.value, /^\d+\.\d{2}[fpnµmkMG]?H$/);
  assert.ok(
    Math.abs(passiveValue(resistor.value, 'R') / measurement.equivalentResistanceOhm - 1) < 0.005,
  );
  assert.ok(
    Math.abs(
      passiveValue(inductor.value, 'L') / (measurement.shortestPartialInductanceNh! * 1e-9) - 1,
    ) < 0.005,
  );
  for (const part of study.parts.slice(2)) {
    assert.equal(partFootprint(part), '');
    assert.equal(participatesInSimulation(part), true);
    assert.equal(val(child(part.raw!, 'in_bom')), 'no');
    assert.equal(val(child(part.raw!, 'on_board')), 'no');
    const reference = symbolAnnotation(part, study.libraries[part.libId], 'Reference')!;
    const value = symbolAnnotation(part, study.libraries[part.libId], 'Value')!;
    assert.ok(reference.y < part.y && value.y > part.y);
    assert.ok(study.labels.slice(1).every((label) => label.y === part.y));
  }
  assert.deepEqual(schematicTexts(study.original), schematicTexts(project.schematic.original));
  assert.equal(
    study.original,
    project.schematic.original,
    'Existing native notes and outlines retain their owner.',
  );
  const addedWires = study.wires.slice(project.schematic.wires.length);
  assert.equal(addedWires.length, 3);
  assert.ok(addedWires.every((wire) => wire.a.y === resistor.y && wire.b.y === resistor.y));
  const [start, end] = study.labels.slice(1).sort((a, b) => a.x - b.x);
  assert.ok(end.x - start.x < 42, 'The series chain uses compact horizontal leads.');
  const native = projectNativeFiles(result.project, 'design.kicad_pro');
  const boardFile = beforeNative.files.find((file) => file.name.endsWith('.kicad_pcb'))!;
  assert.deepEqual(
    native.files.find((file) => file.name === boardFile.name),
    boardFile,
  );
  const reopened = projectFromNativeFiles(native);
  const reopenedStudy = findSchematic(reopened, study.id)!;
  assert.equal(reopenedStudy.parts.length, 4);
  assert.equal(reopenedStudy.labels.length, 3);
  for (const part of reopenedStudy.parts.slice(2)) {
    assert.equal(val(child(part.raw!, 'in_bom')), 'no');
    assert.equal(val(child(part.raw!, 'on_board')), 'no');
    const metadata = {
      'OpenPE.Parasitics.BoardId': project.pcb!.id,
      'OpenPE.Parasitics.StartId': input.startId,
      'OpenPE.Parasitics.EndId': input.endId,
      'OpenPE.Parasitics.Start': 'J1.1',
      'OpenPE.Parasitics.End': 'J2.1',
    };
    for (const [key, value] of Object.entries(metadata)) {
      assert.equal(partFields(part)[key], value);
      const property = children(part.raw!, 'property').find((field) => val(field) === key)!;
      const effects = child(property, 'effects')!;
      assert.ok(
        property.includes('hide') ||
          val(child(property, 'hide')) === 'yes' ||
          effects.includes('hide') ||
          val(child(effects, 'hide')) === 'yes',
      );
    }
    assert.ok(
      extraSymbolAnnotations(part).every((field) => !field.name.startsWith('OpenPE.Parasitics.')),
    );
  }
  assert.doesNotThrow(() => parseProject(serializeProject(result.project)));
});

test('two-decimal component Values preserve SI scaling and existing simulator bounds', () => {
  for (const [value, unit, expected] of [
    [0.0071416161691368836, 'Ω', '7.14mΩ'],
    [0.000000123456789012345, 'Ω', '123.46nΩ'],
    [1.2, 'Ω', '1.20Ω'],
    [999.999, 'Ω', '1.00kΩ'],
    [3.8879392274416755e-9, 'H', '3.89nH'],
    [6.399322514643627e-9, 'H', '6.40nH'],
    [0.00000321, 'H', '3.21µH'],
    [1e-20, 'Ω', '1.00e-20Ω'],
    [1e15, 'Ω', '1.00e+15Ω'],
  ] as const) {
    const formatted = parasiticsComponentValue(value, unit);
    assert.equal(formatted, expected);
    const kind = unit === 'Ω' ? 'R' : 'L';
    if (value >= 1e-15 && value <= 1e12)
      assert.ok(Math.abs(passiveValue(formatted, kind) / value - 1) < 0.005);
    else assert.throws(() => passiveValue(formatted, kind), /between/);
  }
  for (const invalid of [0, -1, NaN, Infinity, Number.MAX_VALUE])
    assert.throws(() => parasiticsComponentValue(invalid, 'Ω'), /positive and finite/);
});

test('endpoint labels use primary schematic references and retain the captured pair after later reference edits', () => {
  const { project, input } = fixture();
  const primaryPart = project.schematic.parts[0];
  project.pcb!.footprints[0].symbolId = primaryPart.id;
  delete project.pcb!.footprints[0].reference;
  delete project.pcb!.footprints[0].value;
  const { project: multi, schematic: target } = appendSchematic(project);
  const prepared = prepareParasiticsStudy(multi, { ...input, schematicId: target.id });
  assert.deepEqual(prepared.labels, { start: `LP_${primaryPart.ref}.1`, end: 'LP_J2.1' });
  const study = findSchematic(prepared.project, target.id)!;
  for (const part of study.parts) {
    assert.equal(partFields(part)['OpenPE.Parasitics.Start'], `${primaryPart.ref}.1`);
    assert.equal(partFields(part)['OpenPE.Parasitics.StartId'], input.startId);
  }
  const later = structuredClone(prepared.project);
  later.schematic.parts[0].ref = 'R99';
  const native = projectFromNativeFiles(projectNativeFiles(later, 'design.kicad_pro'));
  const retained = findSchematic(native, target.id)!;
  assert.deepEqual(
    retained.labels.map((label) => label.text),
    Object.values(prepared.labels),
  );
  assert.equal(partFields(retained.parts[0])['OpenPE.Parasitics.Start'], `${primaryPart.ref}.1`);
});

test('repeated pad numbers and references identify distinct physical terminals by unique UUID prefixes', () => {
  const { project, input } = fixture();
  const [start, end] = project.pcb!.footprints;
  const firstId = '12345678-0000-4000-8000-000000000001';
  const secondId = '12345678-1000-4000-8000-000000000002';
  start.pads[0].id = firstId;
  end.pads[0].id = secondId;
  end.reference = start.reference;
  const prepared = prepareParasiticsStudy(project, { ...input, startId: firstId, endId: secondId });
  assert.deepEqual(prepared.labels, { start: 'LP_J1.1_123456780', end: 'LP_J1.1_123456781' });
  const duplicatePad = structuredClone(project);
  duplicatePad.pcb!.footprints[0].pads.push({ ...end.pads[0], x: 20, y: 0 });
  duplicatePad.pcb!.footprints.pop();
  const samePackage = prepareParasiticsStudy(duplicatePad, {
    ...input,
    startId: firstId,
    endId: secondId,
  });
  assert.deepEqual(samePackage.labels, prepared.labels);
});

test('via endpoints show exact native coordinates and retain their exact ID after native reopening', () => {
  const { project, input } = fixture();
  const viaId = uid();
  project.pcb!.footprints.shift();
  project.pcb!.vias.push({
    id: viaId,
    x: 5,
    y: 5,
    diameter: 0.6,
    drill: 0.3,
    netId: project.pcb!.nets[0].id,
  });
  const prepared = prepareParasiticsStudy(project, { ...input, startId: viaId });
  assert.deepEqual(prepared.labels, { start: 'LP_Via(5,5)mm', end: 'LP_J2.1' });
  const reopened = projectFromNativeFiles(projectNativeFiles(prepared.project, 'design.kicad_pro'));
  const resistor = reopened.schematic.parts.find(
    (part) => part.ref === prepared.references.resistor,
  )!;
  assert.equal(partFields(resistor)['OpenPE.Parasitics.StartId'], viaId);
  assert.equal(partFields(resistor)['OpenPE.Parasitics.Start'], 'Via(5,5)mm');
});

test('unnumbered pads and normalized references retain explicit UUID-qualified endpoint identities', () => {
  for (const change of ['unnumbered', 'reference whitespace'] as const) {
    const { project, input } = fixture();
    const footprint = project.pcb!.footprints[0];
    if (change === 'unnumbered') footprint.pads[0].number = '';
    else footprint.reference = 'J 1';
    const prepared = prepareParasiticsStudy(project, input);
    const tag = input.startId.replaceAll('-', '').slice(0, 8);
    assert.equal(
      prepared.labels.start,
      change === 'unnumbered' ? `LP_J1.unnumbered_${tag}` : `LP_J_1.1_${tag}`,
    );
    const resistor = prepared.project.schematic.parts.find(
      (part) => part.ref === prepared.references.resistor,
    )!;
    assert.equal(partFields(resistor)['OpenPE.Parasitics.StartId'], input.startId);
    assert.equal(
      partFields(resistor)['OpenPE.Parasitics.Start'],
      change === 'unnumbered' ? 'J1.(unnumbered pad)' : 'J 1.1',
    );
  }
});

test('study geometry forms a series R/L chain with two distinct labelled terminals and no ideal bypass', () => {
  const { project, input } = fixture();
  const prepared = prepareParasiticsStudy(project, input);
  const study = structuredClone(findSchematic(prepared.project, prepared.schematicId)!);
  // A separate reference permits read-only node inspection, without making this
  // deliberately incomplete extracted model into a fabricated source/testbench.
  study.parts.push(createPart(study, 'GND', 0, 80.01));
  const { node, probeNodes } = spiceNets(study);
  const resistor = study.parts.find((part) => part.ref === prepared.references.resistor)!;
  const inductor = study.parts.find((part) => part.ref === prepared.references.inductor)!;
  const r = [node(resistor, '1'), node(resistor, '2')];
  const l = [node(inductor, '1'), node(inductor, '2')];
  assert.equal(new Set(r).size, 2);
  assert.equal(new Set(l).size, 2);
  const common = r.filter((value) => l.includes(value));
  assert.equal(common.length, 1, 'The two elements must join at exactly one series node.');
  const labelNode = (name: string) => probeNodes().find((probe) => probe.label === name)!.node;
  const start = labelNode(prepared.labels.start);
  const end = labelNode(prepared.labels.end);
  assert.notEqual(start, end);
  assert.ok(r.includes(start) && !l.includes(start));
  assert.ok(l.includes(end) && !r.includes(end));
  assert.ok(!common.includes(start) && !common.includes(end));
});

test('repeated studies append below earlier blocks on the same sheet with unique labels, references and identities', () => {
  const { project, input } = fixture();
  const first = prepareParasiticsStudy(project, input);
  const firstStudy = findSchematic(first.project, first.schematicId)!;
  const second = prepareParasiticsStudy(first.project, input);
  const secondStudy = findSchematic(second.project, second.schematicId)!;
  assert.equal(second.schematicId, first.schematicId);
  assert.equal(secondStudy.title, project.schematic.title);
  assert.ok(firstStudy.parts.every((part, index) => part === secondStudy.parts[index]));
  assert.ok(firstStudy.wires.every((wire, index) => wire === secondStudy.wires[index]));
  const firstValueBottom = Math.max(
    ...firstStudy.parts.map(
      (part) => symbolAnnotation(part, firstStudy.libraries[part.libId], 'Value')!.y,
    ),
  );
  const laterParts = secondStudy.parts.filter((part) =>
    [second.references.resistor, second.references.inductor].includes(part.ref),
  );
  assert.ok(
    laterParts.every(
      (part) =>
        symbolAnnotation(part, secondStudy.libraries[part.libId], 'Reference')!.y >
        firstValueBottom + 2.54,
    ),
  );
  const allIds = [
    ...secondStudy.parts,
    ...secondStudy.wires,
    ...secondStudy.labels,
    ...schematicTexts(secondStudy.original),
  ].map((object) => object.id);
  assert.equal(new Set(allIds).size, allIds.length);
  assert.equal(second.project.pcb, project.pcb);
  assert.equal(second.references.resistor, 'R3');
  assert.equal(second.references.inductor, 'L3');
  assert.ok(
    Object.values(second.labels).every((name) => !Object.values(first.labels).includes(name)),
  );
  assert.equal(projectSchematics(second.project).length, 1);
  assert.doesNotThrow(() => parseProject(serializeProject(second.project)));
});

test('appending to a chosen existing secondary sheet preserves other native schematic and PCB bytes', () => {
  const { project } = fixture();
  const { project: multi, schematic: target } = appendSchematic(project);
  const { project: three } = appendSchematic(multi);
  const native = projectNativeFiles(three, 'design.kicad_pro');
  for (const file of native.files)
    if (/\.kicad_(?:pcb|sch)$/.test(file.name)) file.source = `\n\n${file.source}\n`;
  const loaded = projectFromNativeFiles(native);
  const board = loaded.pcb!;
  const result = prepareParasiticsStudy(loaded, {
    boardId: board.id,
    schematicId: target.id,
    startId: board.footprints[0].pads[0].id,
    endId: board.footprints[1].pads[0].id,
  });
  const saved = projectNativeFiles(result.project, 'design.kicad_pro');
  const targetFile = projectNativeFiles(multi, 'design.kicad_pro').files.find(
    (file) => file.name.endsWith('.kicad_sch') && file.name !== 'design.kicad_sch',
  )!;
  for (const original of native.files.filter(
    (file) => /\.kicad_(?:pcb|sch)$/.test(file.name) && file.name !== targetFile.name,
  ))
    assert.deepEqual(
      saved.files.find((file) => file.name === original.name),
      original,
    );
  assert.equal(result.project.pcb, board);
  assert.equal(result.project.schematic, loaded.schematic);
  assert.equal(projectSchematics(result.project).length, 3);
  assert.equal(findSchematic(result.project, target.id)!.parts.length, 2);
});

test('Core appends a study as exactly one whole-project undo preserving prior objects and PCB state', () => {
  const { project, input } = fixture();
  const core = new ProjectCore(project);
  const before = core.getSnapshot();
  const prepared = prepareParasiticsStudy(before.project!, input);
  core.commitProject(prepared.project);
  const after = core.getSnapshot();
  assert.equal(after.undoDepth, before.undoDepth + 1);
  assert.equal(after.project!.schematic.id, before.project!.schematic.id);
  assert.deepEqual(after.project!.schematic.parts.slice(0, 2), before.project!.schematic.parts);
  assert.equal(after.project!.pcb, before.project!.pcb);
  core.undo();
  assert.equal(core.getSnapshot().source, before.source);
  core.redo();
  assert.ok(findSchematic(core.getSnapshot().project!, prepared.schematicId));
  core.updateSource('pending native source');
  assert.throws(() => core.commitProject(prepared.project), /Apply the Source edits/);
  core.discardSource();
  core.setEditingBlocked('This project is closing.');
  assert.throws(() => core.commitProject(prepared.project), /closing/);
});

test('study value preparation retains tiny positive resistance and omits unavailable inductance rather than inventing zero', () => {
  assert.deepEqual(
    parasiticsStudyValues({
      equivalentResistanceOhm: 0.000000123456789012345,
      shortestPartialInductanceNh: null,
    }),
    {
      resistanceOhm: 0.000000123456789012345,
      partialInductanceNh: null,
    },
  );
  for (const resistance of [0, -1, NaN, Infinity])
    assert.throws(
      () =>
        parasiticsStudyValues({
          equivalentResistanceOhm: resistance,
          shortestPartialInductanceNh: 1,
        }),
      /resistance/,
    );
  for (const inductance of [0, -1, NaN, Infinity, Number.MIN_VALUE])
    assert.throws(
      () =>
        parasiticsStudyValues({
          equivalentResistanceOhm: 1,
          shortestPartialInductanceNh: inductance,
        }),
      /inductance/,
    );
});

test('a route outside the partial-inductance model reports omission and adds only the resistor without a note', () => {
  const { project, input } = fixture();
  const board = project.pcb!;
  board.thickness = 0.2;
  board.footprints[0].x = -5000;
  board.footprints[0].y = 0;
  board.footprints[1].x = -5000;
  board.footprints[1].y = 1.27;
  board.footprints[1].side = 'back';
  board.footprints[1].pads[0].layers = ['B.Cu'];
  const netId = board.nets[0].id;
  board.vias = [{ id: uid(), x: 5000, y: 0, diameter: 0.6, drill: 0.3, netId }];
  board.tracks = [
    {
      id: uid(),
      netId,
      start: { x: -5000, y: 0 },
      end: { x: 5000, y: 0 },
      width: 0.001,
      layer: 'F.Cu',
    },
    {
      id: uid(),
      netId,
      start: { x: 5000, y: 0 },
      end: { x: -5000, y: 1.27 },
      width: 0.001,
      layer: 'B.Cu',
    },
  ];
  const request = { ...input, copperThicknessMm: 0.001 };
  // Long opposing thin routes exhaust the bounded integral refinement rather
  // than yielding a reliable partial-L estimate; DC resistance remains valid.
  assert.equal(analyzeLayoutParasitics(board, request).shortestPartialInductanceNh, null);
  const result = prepareParasiticsStudy(project, request);
  const study = findSchematic(result.project, result.schematicId)!;
  assert.equal(result.omittedInductance, true);
  assert.equal(result.references.inductor, null);
  assert.equal(result.values.partialInductanceNh, null);
  assert.deepEqual(
    study.parts.slice(2).map((part) => part.libId),
    ['Device:R'],
  );
  assert.equal(study.labels.length, 3);
  assert.deepEqual(schematicTexts(study.original), schematicTexts(project.schematic.original));
});

test('preparation rejects stale PCB/schematic/terminal identities and disconnected copper without mutation', () => {
  const { project, input } = fixture();
  const before = serializeProject(project);
  assert.throws(() => prepareParasiticsStudy(project, { ...input, boardId: uid() }), /no longer/);
  assert.throws(
    () => prepareParasiticsStudy(project, { ...input, schematicId: uid() }),
    /no longer/,
  );
  assert.throws(
    () => prepareParasiticsStudy(project, { ...input, endId: uid() }),
    /terminal|pad|via/i,
  );
  assert.equal(serializeProject(project), before);
  const disconnected = { ...project, pcb: { ...project.pcb!, tracks: [] } };
  assert.throws(() => prepareParasiticsStudy(disconnected, input), /connect|path/i);
  let full = project;
  for (let index = 1; index < 12; index++) full = appendSchematic(full).project;
  const fullBefore = serializeProject(full);
  assert.equal(projectSchematics(prepareParasiticsStudy(full, input).project).length, 12);
  assert.equal(serializeProject(full), fullBefore);
});

test('compatible customized embedded passive definitions are reused without replacing existing metadata', () => {
  const { project, input } = fixture();
  const library = project.schematic.libraries['Device:R'];
  library.push(['property', quote('Custom provenance'), quote('Retain native definition')]);
  const before = serializeProject(project);
  const prepared = prepareParasiticsStudy(project, input);
  const sheet = prepared.project.schematic;
  assert.equal(sheet.libraries['Device:R'], library);
  assert.equal(sheet.libraries['Device:L'], project.schematic.libraries['Device:L']);
  assert.equal(serializeProject(project), before);
  const resistor = sheet.parts.find((part) => part.ref === prepared.references.resistor)!;
  const inductor = sheet.parts.find((part) => part.ref === prepared.references.inductor)!;
  assert.equal(basicSimulationKind(resistor), 'R');
  assert.equal(basicSimulationKind(inductor), 'L');
  assert.equal(simulationSupportError(sheet), '');
  assert.throws(
    () => buildSpiceDeck(sheet, defaultTransient(sheet)),
    /Choose a DC input terminal/,
    'Both study elements pass compiler symbol validation; the incomplete circuit still needs a source.',
  );
});

test('incompatible custom passive symbols reject preparation without replacing libraries or modifying the project', () => {
  for (const change of ['power', 'terminal', 'pin geometry', 'body'] as const) {
    const { project, input } = fixture();
    const library = project.schematic.libraries['Device:R'];
    if (change === 'power') library.push(['power']);
    if (change === 'terminal') {
      const pin = children(library, 'symbol').flatMap((unit) => children(unit, 'pin'))[0];
      child(pin, 'number')![1] = quote('3');
    }
    if (change === 'pin geometry') {
      const pin = children(library, 'symbol').flatMap((unit) => children(unit, 'pin'))[0];
      child(pin, 'length')![1] = '1.5';
    }
    if (change === 'body') {
      const body = children(library, 'symbol').flatMap((unit) => children(unit, 'rectangle'))[0];
      child(body, 'end')![2] = '50';
    }
    const before = serializeProject(project);
    assert.throws(() => prepareParasiticsStudy(project, input), /supported study geometry/);
    assert.equal(serializeProject(project), before);
  }
});

test('custom library simulation defaults cannot silently change measured study primitives', () => {
  for (const [name, value] of [
    ['Sim.Params', 'R=100'],
    ['Sim.Library', 'models/custom.lib'],
    ['OpenPE.ModelSource', 'external'],
    ['OpenPE.PassiveModel', 'C'],
    ['OpenPE.InitialCurrent', '3'],
  ]) {
    const { project, input } = fixture();
    const library = project.schematic.libraries['Device:R'];
    library.push(['property', quote(name), quote(value)]);
    const before = serializeProject(project);
    assert.throws(
      () => prepareParasiticsStudy(project, input),
      /unsupported study simulation defaults/,
    );
    assert.equal(serializeProject(project), before);
    assert.equal(project.schematic.libraries['Device:R'], library);
  }
});

test('new study labels avoid existing power-symbol Values and hidden power-input names across sheets', () => {
  const { project, input } = fixture();
  project.schematic.labels[0].text = 'LP_J1.1';
  const { project: multi, schematic: other } = appendSchematic(project);
  const power = createPart(other, 'GND', 20.32, 20.32);
  power.value = 'LP_J1.1_S2';
  other.parts.push(power);
  const hiddenPower = createPart(other, 'C', 40.64, 20.32);
  other.parts.push(hiddenPower);
  const pin = children(other.libraries['Device:C'], 'symbol').flatMap((unit) =>
    children(unit, 'pin'),
  )[0];
  pin[1] = 'power_in';
  pin.push('hide');
  child(pin, 'name')![1] = quote('LP_J2.1_S3');
  const before = serializeProject(multi);
  const prepared = prepareParasiticsStudy(multi, input);
  assert.deepEqual(prepared.labels, { start: 'LP_J1.1_S4', end: 'LP_J2.1_S4' });
  assert.equal(findSchematic(prepared.project, other.id), other);
  assert.equal(serializeProject(multi), before);
});

test('study placement clears existing notes, outlines, labels and hidden fields, and rejects the coordinate bound', () => {
  const { project, input } = fixture();
  project.schematic = parseCircuit(serializeCircuit(project.schematic));
  project.schematic = saveAnnotation(project.schematic, 'Existing note\nSecond line', {
    x: 12.7,
    y: 300.99,
  }).circuit;
  project.schematic.original!.push([
    'polyline',
    ['pts', ['xy', '0', '400'], ['xy', '100', '400']],
    ['stroke', ['width', '2'], ['type', 'default']],
    ['uuid', quote(uid())],
  ]);
  const field = children(project.schematic.parts[0].raw!, 'property')[0];
  child(field, 'at')![2] = '500';
  project.schematic.labels.push({ id: uid(), text: 'Vertical label', x: 0, y: 550, rotation: 90 });
  const before = serializeProject(project);
  const prepared = prepareParasiticsStudy(project, input);
  const added = prepared.project.schematic.parts.slice(2);
  assert.ok(added.every((part) => part.y > 580));
  assert.ok(added.every((part) => Math.abs(part.y / 1.27 - Math.round(part.y / 1.27)) < 1e-8));
  assert.equal(serializeProject(project), before);
  assert.deepEqual(
    schematicTexts(prepared.project.schematic.original),
    schematicTexts(project.schematic.original),
  );
  project.schematic.labels.push({ id: uid(), text: 'Boundary', x: 0, y: 99990 });
  const boundaryBefore = serializeProject(project);
  assert.throws(() => prepareParasiticsStudy(project, input), /no supported space/);
  assert.equal(serializeProject(project), boundaryBefore);
});

test('study placement clears rotated mirrored custom bodies and embedded text outside original component anchors', () => {
  const { project, input } = fixture();
  const giant = createPart(project.schematic, 'C', 200.66, 30.48);
  giant.rotation = 90;
  giant.mirror = 'x';
  project.schematic.parts.push(giant);
  const library = project.schematic.libraries['Device:C'];
  const unit = children(library, 'symbol')[0];
  unit.push([
    'rectangle',
    ['start', '-1500', '-1'],
    ['end', '1000', '1'],
    ['stroke', ['width', '0'], ['type', 'default']],
    ['fill', ['type', 'none']],
  ]);
  unit.push([
    'text',
    quote('Far text'),
    ['at', '0', '-2000', '0'],
    ['effects', ['font', ['size', '1.27', '1.27']]],
  ]);
  const before = serializeProject(project);
  const prepared = prepareParasiticsStudy(project, input);
  assert.ok(prepared.project.schematic.parts.slice(3).every((part) => part.y > 2040));
  assert.equal(serializeProject(project), before);
});
