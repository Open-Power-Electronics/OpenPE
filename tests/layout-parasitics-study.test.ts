import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createPart,
  emptyCircuit,
  parseCircuit,
  pinPositions,
  serializeCircuit,
  uid,
  type Circuit,
  type Part,
} from '../lib/circuit';
import {
  partFields,
  partFootprint,
  symbolAnnotation,
  extraSymbolAnnotations,
  unitGraphics,
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
import { child, children, parseSExpr, quote, val } from '../lib/sexpr';
import { schematicTexts } from '../lib/schematic-text';
import { saveAnnotation } from '../lib/schematic-edit';
import { ProjectCore } from '../core/project-core';
import { documentPinKey, projectNetGroups } from '../lib/project-net-groups';
import { parasiticPhysicalModels } from '../lib/parasitic-model';
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
} from '../plugins/spice-simulation/domain/spice';
import { participatesInSimulation } from '../lib/simulation-participation';
import { basicSimulationKind } from '../lib/simulation-model-source';
import { switchingStageFixture } from './fixtures/switching-stage';

function pin(circuit: Circuit, part: Part, number: string) {
  const definitions = unitGraphics(circuit.libraries[part.libId], part.unit || 1).flatMap((unit) =>
    children(unit, 'pin'),
  );
  return pinPositions(part, circuit.libraries[part.libId])[
    definitions.findIndex((pin) => val(child(pin, 'number')) === number)
  ];
}

function fixture(schematic?: Circuit, pair: [string, string] = ['R1', 'L1']) {
  if (!schematic) {
    schematic = emptyCircuit();
    schematic.title = 'Original design';
    schematic.parts.push(createPart(schematic, 'R', 40.64, 20.32));
    schematic.parts.push(createPart(schematic, 'L', 60.96, 20.32));
    schematic.wires.push({
      id: uid(),
      a: pin(schematic, schematic.parts[0], '1'),
      b: pin(schematic, schematic.parts[1], '1'),
    });
    schematic.labels.push({ id: uid(), x: 0, y: 0, text: 'LP_Signal_1' });
  }
  const project = createProject(schematic);
  const board = createEmptyPCB(),
    netId = uid();
  const terminal = (x: number, reference: string): Footprint => ({
    id: uid(),
    symbolId: schematic.parts.find((part) => part.ref === reference)!.id,
    libraryId: 'Study:Terminal',
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
  board.footprints = [terminal(5, pair[0]), terminal(25, pair[1])];
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

function group(circuit: Circuit, key: string) {
  return projectNetGroups(circuit).findIndex((group) => group.pins.includes(key));
}

function nativeExample(stem: string) {
  return projectFromNativeFiles({
    entry: stem + '.kicad_pro',
    files: ['kicad_pro', 'kicad_sch', 'kicad_pcb'].map((extension) => ({
      name: stem + '.' + extension,
      source: readFileSync(
        new URL(`../examples/${stem}/${stem}.${extension}`, import.meta.url),
        'utf8',
      ),
    })),
  });
}

function assertSeries(
  original: Circuit,
  current: Circuit,
  result: ReturnType<typeof prepareParasiticsStudy>,
  start: Part,
  end: Part,
  startNumber = '1',
  endNumber = '1',
) {
  const resistor = current.parts.find((part) => part.ref === result.references.resistor)!;
  const inductor = current.parts.find((part) => part.ref === result.references.inductor);
  const first = group(current, documentPinKey(start.id, startNumber));
  const last = group(current, documentPinKey(end.id, endNumber));
  assert.notEqual(first, last, 'The original ideal network is actually split.');
  assert.equal(group(current, documentPinKey(resistor.id, '1')), first);
  assert.equal(group(current, documentPinKey((inductor ?? resistor).id, '2')), last);
  if (inductor) {
    const middle = group(current, documentPinKey(resistor.id, '2'));
    assert.equal(middle, group(current, documentPinKey(inductor.id, '1')));
    assert.ok(middle !== first && middle !== last);
  }
  const changed = current.wires.filter((wire) => {
    const previous = original.wires.find((before) => before.id === wire.id);
    return previous && JSON.stringify(previous) !== JSON.stringify(wire);
  });
  assert.equal(changed.length, 1);
  assert.ok(
    Math.abs(
      Math.hypot(changed[0].a.x - changed[0].b.x, changed[0].a.y - changed[0].b.y) -
        (Math.hypot(
          original.wires.find((wire) => wire.id === changed[0].id)!.a.x -
            original.wires.find((wire) => wire.id === changed[0].id)!.b.x,
          original.wires.find((wire) => wire.id === changed[0].id)!.a.y -
            original.wires.find((wire) => wire.id === changed[0].id)!.b.y,
        ) -
          1.27),
    ) < 1e-8,
  );
  assert.deepEqual(current.parts.slice(0, original.parts.length), original.parts);
  assert.ok(original.parts.every((part, index) => current.parts[index] === part));
}

test('one native series insertion splits only the selected End leaf, retains compact values and declares exact physical equivalence', () => {
  const { project, input } = fixture();
  const before = serializeProject(project),
    nativeBefore = projectNativeFiles(project, 'design.kicad_pro');
  const measurement = analyzeLayoutParasitics(project.pcb!, input);
  const result = prepareParasiticsStudy(project, input),
    sheet = result.project.schematic;
  assert.equal(serializeProject(project), before);
  assert.equal(result.project.pcb, project.pcb);
  assert.equal(projectSchematics(result.project).length, 1);
  assert.equal(result.schematicId, project.schematic.id);
  assertSeries(
    project.schematic,
    sheet,
    result,
    project.schematic.parts[0],
    project.schematic.parts[1],
  );
  assert.deepEqual(result.values, {
    resistanceOhm: measurement.equivalentResistanceOhm,
    partialInductanceNh: measurement.shortestPartialInductanceNh,
  });
  assert.deepEqual(result.labels, { start: 'LP_R1.1', end: 'LP_L1.1' });
  assert.equal(result.references.resistor, 'R2');
  assert.equal(result.references.inductor, 'L2');
  assert.equal(result.blockIds.length, 7);
  const block = new Set(result.blockIds),
    blockLabels = sheet.labels.filter((label) => block.has(label.id));
  assert.equal(blockLabels.length, 2);
  assert.ok(blockLabels[1].x - blockLabels[0].x < 42);
  const anchored = sheet.labels.filter(
    (label) => !block.has(label.id) && Object.values(result.labels).includes(label.text),
  );
  assert.equal(
    anchored.length,
    3,
    'Start pin, shortened lead and End pin retain separate exact anchored labels.',
  );
  assert.ok(anchored.some((label) => label.rotation === 180));
  assert.ok(
    anchored.some(
      (label) =>
        label.text === result.labels.start &&
        label.x === pin(project.schematic, project.schematic.parts[0], '1').x &&
        label.y === pin(project.schematic, project.schematic.parts[0], '1').y,
    ),
  );
  assert.ok(
    anchored.some(
      (label) =>
        label.text === result.labels.end &&
        label.x === pin(project.schematic, project.schematic.parts[1], '1').x &&
        label.y === pin(project.schematic, project.schematic.parts[1], '1').y,
    ),
  );
  const models = parasiticPhysicalModels(sheet);
  assert.equal(models.length, 1);
  const groupIds = new Set<string>();
  for (const part of sheet.parts.slice(2)) {
    assert.equal(partFootprint(part), '');
    assert.equal(participatesInSimulation(part), true);
    assert.equal(val(child(part.raw!, 'on_board')), 'no');
    assert.equal(val(child(part.raw!, 'in_bom')), 'no');
    const fields = partFields(part);
    groupIds.add(fields['OpenPE.Parasitics.GroupId']);
    for (const [name, value] of Object.entries({
      'OpenPE.Parasitics.Connection': 'series',
      'OpenPE.Parasitics.BoardId': input.boardId,
      'OpenPE.Parasitics.StartId': input.startId,
      'OpenPE.Parasitics.EndId': input.endId,
      'OpenPE.Parasitics.StartLabel': result.labels.start,
      'OpenPE.Parasitics.EndLabel': result.labels.end,
    }))
      assert.equal(fields[name], value);
    assert.equal(
      fields['OpenPE.Parasitics.Role'],
      part.libId === 'Device:R' ? 'resistor' : 'inductor',
    );
    assert.ok(
      extraSymbolAnnotations(part).every((field) => !field.name.startsWith('OpenPE.Parasitics.')),
    );
    assert.ok(symbolAnnotation(part, sheet.libraries[part.libId], 'Reference')!.y < part.y);
    assert.ok(symbolAnnotation(part, sheet.libraries[part.libId], 'Value')!.y > part.y);
    assert.match(
      part.value,
      part.libId === 'Device:R' ? /^\d+\.\d{2}[fpnµmkMG]?Ω$/ : /^\d+\.\d{2}[fpnµmkMG]?H$/,
    );
  }
  assert.equal(groupIds.size, 1);
  const native = projectNativeFiles(result.project, 'design.kicad_pro');
  assert.deepEqual(
    native.files.find((file) => file.name.endsWith('.kicad_pcb')),
    nativeBefore.files.find((file) => file.name.endsWith('.kicad_pcb')),
  );
  const reopened = projectFromNativeFiles(native);
  assert.equal(parasiticPhysicalModels(reopened.schematic).length, 1);
  assert.equal(reopened.schematic.labels.length, 6);
  assert.doesNotThrow(() => parseProject(serializeProject(result.project)));
});

test('native LM2596 and LM25017 series models compile through their existing profiles and preserve PCB native bytes', () => {
  for (const [stem, pair] of [
    [
      'lm2596-to220-5-buck',
      [
        ['U1', '2'],
        ['L1', '1'],
      ],
    ],
    [
      'lm25017-wson8-flybuck',
      [
        ['D1', '2'],
        ['C8', '1'],
      ],
    ],
  ] as const) {
    const project = nativeExample(stem);
    const pad = (reference: string, number: string) =>
      project
        .pcb!.footprints.find(
          (footprint) =>
            footprint.symbolId ===
            project.schematic.parts.find((part) => part.ref === reference)!.id,
        )!
        .pads.find((pad) => pad.number === number)!.id;
    const input = {
      boardId: project.pcb!.id,
      schematicId: project.schematic.id,
      startId: pad(pair[0][0], pair[0][1]),
      endId: pad(pair[1][0], pair[1][1]),
    };
    const before = projectNativeFiles(project, 'design.kicad_pro');
    const result = prepareParasiticsStudy(project, input);
    assertSeries(
      project.schematic,
      result.project.schematic,
      result,
      project.schematic.parts.find((part) => part.ref === pair[0][0])!,
      project.schematic.parts.find((part) => part.ref === pair[1][0])!,
      pair[0][1],
      pair[1][1],
    );
    const deck = buildSpiceDeck(
      result.project.schematic,
      defaultTransient(result.project.schematic),
    );
    for (const reference of [result.references.resistor, result.references.inductor])
      assert.ok(deck.traces.some((trace) => trace.label.startsWith(`I(${reference})`)));
    assert.equal(
      deck.traces.filter((trace) => trace.label.startsWith('I(' + result.references.resistor + ')'))
        .length,
      1,
    );
    assert.equal(result.project.pcb, project.pcb);
    assert.deepEqual(
      projectNativeFiles(result.project, 'design.kicad_pro').files.find((file) =>
        file.name.endsWith('.kicad_pcb'),
      ),
      before.files.find((file) => file.name.endsWith('.kicad_pcb')),
    );
    const added = result.project.schematic.parts.filter((part) =>
      result.blockIds.includes(part.id),
    );
    const a = pin(
      project.schematic,
      project.schematic.parts.find((part) => part.ref === pair[0][0])!,
      pair[0][1],
    );
    const b = pin(
      project.schematic,
      project.schematic.parts.find((part) => part.ref === pair[1][0])!,
      pair[1][1],
    );
    const center = { x: (added[0].x + added[1].x) / 2, y: added[0].y };
    assert.ok(Math.hypot(center.x - (a.x + b.x) / 2, center.y - (a.y + b.y) / 2) < 70);
  }
});

test('the existing ideal switching stage compiles with actual series parasitics and no invented source or ground', () => {
  const { project, input } = fixture(switchingStageFixture(), ['C2', 'R1']);
  const before = buildSpiceDeck(project.schematic, defaultTransient(project.schematic));
  const result = prepareParasiticsStudy(project, input);
  const after = buildSpiceDeck(
    result.project.schematic,
    defaultTransient(result.project.schematic),
  );
  assert.equal(
    after.netlist.match(/^VINPUT /gm)!.length,
    before.netlist.match(/^VINPUT /gm)!.length,
  );
  assert.equal(after.netlist.match(/^VPWM /gm)!.length, before.netlist.match(/^VPWM /gm)!.length);
  assert.equal(result.project.schematic.parts.length - project.schematic.parts.length, 2);
  assertSeries(
    project.schematic,
    result.project.schematic,
    result,
    project.schematic.parts.find((part) => part.ref === 'C2')!,
    project.schematic.parts.find((part) => part.ref === 'R1')!,
  );
});

test('series preparation and its five labels are exactly one Core undo and survive Source, Save and reopen', () => {
  const { project, input } = fixture();
  const core = new ProjectCore(project);
  const before = core.getNativeFiles();
  const result = prepareParasiticsStudy(core.getSnapshot().project!, input);
  core.commitProject(result.project);
  const accepted = core.getNativeFiles();
  assert.equal(core.getSnapshot().undoDepth, 1);
  assert.equal(parasiticPhysicalModels(projectFromNativeFiles(accepted).schematic).length, 1);
  core.undo();
  assert.deepEqual(core.getNativeFiles(), before);
  core.redo();
  assert.deepEqual(core.getNativeFiles(), accepted);
  core.updateSource('pending native text');
  assert.throws(() => core.commitProject(result.project), /Apply the Source/);
  core.discardSource();
  core.setEditingBlocked('This project is closing.');
  assert.throws(() => core.commitProject(result.project), /closing/);
});

test('repeated pairs, reversed pairs and old isolated pair metadata reject atomically instead of stacking or migrating', () => {
  const { project, input } = fixture();
  const result = prepareParasiticsStudy(project, input);
  const before = serializeProject(result.project);
  for (const request of [input, { ...input, startId: input.endId, endId: input.startId }])
    assert.throws(
      () => prepareParasiticsStudy(result.project, request),
      /already has parasitic|already has a series/,
    );
  assert.equal(serializeProject(result.project), before);
  project.schematic.parts[0].fields = {
    ...project.schematic.parts[0].fields,
    'OpenPE.Parasitics.BoardId': input.boardId,
    'OpenPE.Parasitics.StartId': input.startId,
    'OpenPE.Parasitics.EndId': input.endId,
  };
  const old = serializeProject(project);
  assert.throws(() => prepareParasiticsStudy(project, input), /already has parasitic/);
  assert.equal(serializeProject(project), old);
});

test('distinct leaf branches may share an untouched Start pin while preserving the other branch topology', () => {
  const { project, input } = fixture();
  const circuit = project.schematic;
  const cap = createPart(circuit, 'C', 50.8, 40.64);
  circuit.parts.push(cap);
  circuit.wires.push({ id: uid(), a: pin(circuit, cap, '1'), b: { x: 50.8, y: 16.51 } });
  const board = project.pcb!,
    template = board.footprints[0];
  const third = structuredClone(template);
  third.id = uid();
  third.symbolId = cap.id;
  third.x = 15;
  third.y = 15;
  third.pads[0].id = uid();
  board.footprints.push(third);
  const original = board.tracks[0];
  board.tracks = [
    { ...original, end: { x: 15, y: 5 } },
    { ...original, id: uid(), start: { x: 15, y: 5 } },
    { ...original, id: uid(), start: { x: 15, y: 5 }, end: { x: 15, y: 15 } },
  ];
  const first = prepareParasiticsStudy(project, input);
  const second = prepareParasiticsStudy(first.project, { ...input, endId: third.pads[0].id });
  assert.equal(parasiticPhysicalModels(second.project.schematic).length, 2);
  assert.equal(second.project.pcb, board);
  assert.ok(
    first.project.schematic.parts.every(
      (part, index) => second.project.schematic.parts[index] === part,
    ),
  );
  assert.notEqual(first.labels.start, second.labels.start);
  assert.throws(
    () =>
      prepareParasiticsStudy(second.project, {
        ...input,
        startId: input.endId,
        endId: third.pads[0].id,
      }),
    /already has a series/,
  );
});

test('via, unmapped, independent-sheet and ambiguous pin requests fail without a partial edit', () => {
  for (const kind of ['via', 'unmapped', 'secondary', 'duplicate pin', 'duplicate land'] as const) {
    const f = fixture();
    let input = f.input;
    if (kind === 'via') {
      const end = f.project.pcb!.footprints.pop()!;
      const id = uid();
      f.project.pcb!.vias.push({
        id,
        x: end.x,
        y: end.y,
        diameter: 0.6,
        drill: 0.3,
        netId: f.project.pcb!.nets[0].id,
      });
      input = { ...input, endId: id };
    }
    if (kind === 'unmapped') {
      const end = f.project.pcb!.footprints[1];
      end.symbolId = null;
      end.reference = 'J2';
      end.value = 'Terminal';
    }
    if (kind === 'secondary') {
      const appended = appendSchematic(f.project);
      f.project = appended.project;
      appended.schematic.parts.push(createPart(appended.schematic, 'L', 0, 0));
      input = { ...input, schematicId: appended.schematic.id };
    }
    if (kind === 'duplicate pin') {
      const library = f.project.schematic.libraries['Device:L'];
      const definition = unitGraphics(library, 1).flatMap((unit) => children(unit, 'pin'))[0];
      children(library, 'symbol')
        .find((unit) => children(unit, 'pin').length)!
        .push(structuredClone(definition));
    }
    if (kind === 'duplicate land') {
      const footprint = f.project.pcb!.footprints[1];
      footprint.pads.push({ ...footprint.pads[0], id: uid(), x: 5 });
    }
    const before = JSON.stringify(f.project);
    assert.throws(
      () => prepareParasiticsStudy(f.project, input),
      /requires two PCB pads|unambiguous schematic pin|several PCB lands/,
    );
    assert.equal(JSON.stringify(f.project), before);
  }
});

test('branch points, wire interiors, labels, crossings and hidden power aliases cannot be detached silently', () => {
  for (const kind of [
    'branch',
    'interior',
    'label',
    'junction',
    'co-located pin',
    'gap pin',
    'gap crossing',
    'diagonal',
    'hidden power',
  ] as const) {
    const { project, input } = fixture();
    const circuit = project.schematic,
      end = circuit.parts[1],
      point = pin(circuit, end, '1');
    if (kind === 'branch')
      circuit.wires.push({ id: uid(), a: point, b: { x: point.x, y: point.y + 10 } });
    if (kind === 'interior') circuit.wires[0].b = { x: point.x + 10, y: point.y };
    if (kind === 'label') circuit.labels.push({ id: uid(), ...point, text: 'EndAlias' });
    if (kind === 'junction') circuit.junctions.push({ id: uid(), ...point });
    if (kind === 'co-located pin' || kind === 'gap pin') {
      const p = createPart(circuit, 'C', point.x, 20.32);
      if (kind === 'gap pin') p.x = point.x - 0.635;
      circuit.parts.push(p);
    }
    if (kind === 'gap crossing')
      circuit.wires.push({
        id: uid(),
        a: { x: point.x - 1.27, y: point.y - 5 },
        b: { x: point.x - 1.27, y: point.y + 5 },
      });
    if (kind === 'diagonal') {
      end.y += 0.635;
      circuit.wires[0].b = pin(circuit, end, '1');
    }
    if (kind === 'hidden power') {
      const definition = unitGraphics(circuit.libraries[end.libId], 1).flatMap((unit) =>
        children(unit, 'pin'),
      )[0];
      definition[1] = 'power_in';
      definition.push('hide');
    }
    const before = JSON.stringify(project);
    assert.throws(() => prepareParasiticsStudy(project, input), /End pin|End lead|global power/);
    assert.equal(JSON.stringify(project), before);
  }
});

test('a shared-unit pin number is resolved through the exact linked owner before choosing the target leaf', () => {
  const { project, input } = fixture();
  project.schematic.libraries['Fixture:Split'] = parseSExpr(`(symbol "Fixture:Split"
    (symbol "Split_1_1" (pin passive line (at 0 0 0) (length 1) (name "A") (number "1")))
    (symbol "Split_2_1" (pin passive line (at 0 0 0) (length 1) (name "B") (number "2"))))`);
  const units = [1, 2].map((unit) => ({
    id: uid(),
    libId: 'Fixture:Split',
    ref: 'U1',
    value: 'Split',
    x: unit === 1 ? 1000 : 200.66,
    y: unit === 1 ? 1000 : 200.66,
    rotation: 0,
    unit,
  }));
  project.schematic.parts.push(...units);
  project.pcb!.footprints[0].symbolId = units[0].id;
  project.pcb!.footprints[0].pads[0].number = '2';
  const end = pin(project.schematic, project.schematic.parts[1], '1'),
    middle = { x: 200.66, y: end.y };
  project.schematic.wires = [
    { id: uid(), a: pin(project.schematic, units[1], '2'), b: middle },
    { id: uid(), a: middle, b: end },
  ];
  const result = prepareParasiticsStudy(project, input);
  assertSeries(
    project.schematic,
    result.project.schematic,
    result,
    units[1],
    project.schematic.parts[1],
    '2',
    '1',
  );
  assert.equal(
    partFields(
      result.project.schematic.parts.find((part) => part.ref === result.references.resistor)!,
    )['OpenPE.Parasitics.Start'],
    'U1.2',
  );
});

test('endpoint copies retain exact off-grid native pin anchors and the cut wire keeps its original UUID and style', () => {
  const { project, input } = fixture();
  project.schematic = parseCircuit(serializeCircuit(project.schematic));
  for (const part of project.schematic.parts) part.x += 0.125;
  project.schematic.wires = project.schematic.wires.map((wire) => ({
    ...wire,
    a: { x: wire.a.x + 0.125, y: wire.a.y },
    b: { x: wire.b.x + 0.125, y: wire.b.y },
  }));
  const oldWire = project.schematic.wires[0];
  const result = prepareParasiticsStudy(project, input);
  const changed = result.project.schematic.wires.find((wire) => wire.id === oldWire.id)!;
  assert.equal(changed.raw, oldWire.raw);
  for (const [part, label] of [
    [project.schematic.parts[0], result.labels.start],
    [project.schematic.parts[1], result.labels.end],
  ] as const) {
    const at = pin(project.schematic, part, '1');
    assert.ok(
      result.project.schematic.labels.some(
        (item) =>
          !result.blockIds.includes(item.id) &&
          item.text === label &&
          item.x === at.x &&
          item.y === at.y,
      ),
    );
  }
});

test('two-decimal native Values retain SI scaling and reject unrepresentable values', () => {
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
    if (value >= 1e-15 && value <= 1e12)
      assert.ok(Math.abs(passiveValue(formatted, unit === 'Ω' ? 'R' : 'L') / value - 1) < 0.005);
  }
  for (const invalid of [0, -1, NaN, Infinity, Number.MAX_VALUE])
    assert.throws(() => parasiticsComponentValue(invalid, 'Ω'), /positive and finite/);
  assert.deepEqual(
    parasiticsStudyValues({
      equivalentResistanceOhm: 0.000000123456789012345,
      shortestPartialInductanceNh: null,
    }),
    { resistanceOhm: 0.000000123456789012345, partialInductanceNh: null },
  );
  for (const r of [0, -1, NaN, Infinity])
    assert.throws(
      () => parasiticsStudyValues({ equivalentResistanceOhm: r, shortestPartialInductanceNh: 1 }),
      /resistance/,
    );
  for (const l of [0, -1, NaN, Infinity, Number.MIN_VALUE])
    assert.throws(
      () => parasiticsStudyValues({ equivalentResistanceOhm: 1, shortestPartialInductanceNh: l }),
      /inductance/,
    );
});

test('outside-model partial inductance inserts a real resistor-only series connection, without inventing zero inductance', () => {
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
  const result = prepareParasiticsStudy(project, { ...input, copperThicknessMm: 0.001 });
  assert.equal(result.omittedInductance, true);
  assert.equal(result.references.inductor, null);
  assert.equal(result.values.partialInductanceNh, null);
  assert.equal(parasiticPhysicalModels(result.project.schematic)[0].parts.length, 1);
  assertSeries(
    project.schematic,
    result.project.schematic,
    result,
    project.schematic.parts[0],
    project.schematic.parts[1],
  );
});

test('nearby placement ignores remote geometry and protects visible obstacles without moving original components', () => {
  const { project, input } = fixture();
  project.schematic = saveAnnotation(project.schematic, 'Remote note\nSecond line', {
    x: 2000,
    y: 2000,
  }).circuit;
  project.schematic.original!.push([
    'polyline',
    ['pts', ['xy', '0', '400'], ['xy', '100', '400']],
    ['stroke', ['width', '2'], ['type', 'default']],
    ['uuid', quote(uid())],
  ]);
  const before = serializeProject(project);
  const result = prepareParasiticsStudy(project, input);
  const added = result.project.schematic.parts.slice(2);
  assert.ok(added.every((part) => Math.hypot(part.x - 50.8, part.y - 16.51) < 90));
  assert.equal(serializeProject(project), before);
  assert.deepEqual(
    schematicTexts(result.project.schematic.original),
    schematicTexts(project.schematic.original),
  );
  for (const kind of ['hidden anchor', 'global shield', 'primitive text'] as const) {
    const next = fixture(),
      pose = prepareParasiticsStudy(next.project, next.input).project.schematic.parts[2];
    if (kind === 'hidden anchor') {
      next.project.schematic = parseCircuit(serializeCircuit(next.project.schematic));
      next.project.schematic.parts[0].raw!.push([
        'property',
        quote('Hidden anchor'),
        quote('x'.repeat(200)),
        ['at', String(pose.x), String(pose.y), '0'],
        ['effects', ['font', ['size', '1.27', '1.27']], ['hide', 'yes']],
      ]);
    }
    if (kind === 'global shield')
      next.project.schematic.labels.push({
        id: uid(),
        text: 'G',
        scope: 'global',
        shape: 'bidirectional',
        x: pose.x - 10,
        y: pose.y + 4,
      });
    if (kind === 'primitive text') {
      const part = createPart(next.project.schematic, 'C', pose.x + 200, pose.y + 5.08);
      part.rotation = 90;
      part.mirror = 'x';
      next.project.schematic.parts.push(part);
      children(next.project.schematic.libraries[part.libId], 'symbol')[0].push([
        'text',
        quote('Far upright text '.repeat(4)),
        ['at', '0', '220', '90'],
        ['effects', ['font', ['size', '.01', '.01']]],
      ]);
    }
    const changed = prepareParasiticsStudy(next.project, next.input).project.schematic.parts.find(
      (part) => part.ref === 'R2',
    )!;
    assert.ok(changed.x !== pose.x || changed.y !== pose.y, kind);
  }
});

test('all block coordinates stay bounded and snapped, while a full local region fails atomically', () => {
  const { project, input } = fixture();
  const shift = { x: 99900, y: -99900 };
  project.schematic.parts.forEach((part) => {
    part.x += shift.x;
    part.y += shift.y;
  });
  project.schematic.wires = project.schematic.wires.map((wire) => ({
    ...wire,
    a: { x: wire.a.x + shift.x, y: wire.a.y + shift.y },
    b: { x: wire.b.x + shift.x, y: wire.b.y + shift.y },
  }));
  const result = prepareParasiticsStudy(project, input);
  for (const object of [
    ...result.project.schematic.parts,
    ...result.project.schematic.labels,
    ...result.project.schematic.wires.flatMap((wire) => [
      { id: wire.id, ...wire.a },
      { id: wire.id, ...wire.b },
    ]),
  ].filter((item) => result.blockIds.includes(item.id))) {
    assert.ok(Math.abs(object.x) <= 100000 && Math.abs(object.y) <= 100000);
    assert.ok(Math.abs(object.x / 1.27 - Math.round(object.x / 1.27)) < 1e-8);
    assert.ok(Math.abs(object.y / 1.27 - Math.round(object.y / 1.27)) < 1e-8);
  }
  const blocked = fixture();
  const part = createPart(blocked.project.schematic, 'C', 50.8, 20.32);
  blocked.project.schematic.parts.push(part);
  children(blocked.project.schematic.libraries[part.libId], 'symbol')[0].push([
    'rectangle',
    ['start', '-200', '-200'],
    ['end', '200', '200'],
    ['stroke', ['width', '0'], ['type', 'default']],
    ['fill', ['type', 'background']],
  ]);
  const before = serializeProject(blocked.project);
  assert.throws(
    () => prepareParasiticsStudy(blocked.project, blocked.input),
    /no supported nearby free space/,
  );
  assert.equal(serializeProject(blocked.project), before);
});

test('secondary native files and PCB bytes survive a primary-sheet insertion', () => {
  const { project } = fixture();
  const two = appendSchematic(project).project;
  const three = appendSchematic(two).project;
  const packet = projectNativeFiles(three, 'design.kicad_pro');
  for (const file of packet.files)
    if (/\.kicad_(?:sch|pcb)$/.test(file.name)) file.source = `\n\n${file.source}\n`;
  const loaded = projectFromNativeFiles(packet);
  const board = loaded.pcb!;
  const result = prepareParasiticsStudy(loaded, {
    boardId: board.id,
    schematicId: loaded.schematic.id,
    startId: board.footprints[0].pads[0].id,
    endId: board.footprints[1].pads[0].id,
  });
  const saved = projectNativeFiles(result.project, 'design.kicad_pro');
  for (const file of packet.files.filter(
    (file) => /\.kicad_(?:sch|pcb)$/.test(file.name) && file.name !== 'design.kicad_sch',
  ))
    assert.deepEqual(
      saved.files.find((candidate) => candidate.name === file.name),
      file,
    );
  assert.equal(projectSchematics(result.project).length, 3);
});

test('captured endpoint labels and exact IDs survive later reference edits without changing group identity', () => {
  const { project, input } = fixture();
  const result = prepareParasiticsStudy(project, input),
    later = structuredClone(result.project);
  later.schematic.parts[0].ref = 'R99';
  const reopened = projectFromNativeFiles(projectNativeFiles(later, 'design.kicad_pro'));
  const resistor = reopened.schematic.parts.find(
    (part) => part.ref === result.references.resistor,
  )!;
  assert.equal(partFields(resistor)['OpenPE.Parasitics.Start'], 'R1.1');
  assert.equal(partFields(resistor)['OpenPE.Parasitics.StartId'], input.startId);
  assert.equal(parasiticPhysicalModels(reopened.schematic)[0].startLabel, result.labels.start);
});

test('fresh study labels avoid prior labels and implicit power names across sheets', () => {
  const { project, input } = fixture();
  project.schematic.labels[0].text = 'LP_R1.1';
  const { project: multi, schematic: other } = appendSchematic(project);
  const power = createPart(other, 'GND', 20.32, 20.32);
  power.value = 'LP_R1.1_S2';
  other.parts.push(power);
  const hidden = createPart(other, 'C', 40.64, 20.32);
  other.parts.push(hidden);
  const definition = unitGraphics(other.libraries[hidden.libId], 1).flatMap((unit) =>
    children(unit, 'pin'),
  )[0];
  definition[1] = 'power_in';
  definition.push('hide');
  child(definition, 'name')![1] = quote('LP_L1.1_S3');
  const result = prepareParasiticsStudy(multi, input);
  assert.deepEqual(result.labels, { start: 'LP_R1.1_S4', end: 'LP_L1.1_S4' });
  assert.equal(findSchematic(result.project, other.id), other);
});

test('compatible embedded passives retain metadata, while incompatible geometry or simulation defaults reject the entire insertion', () => {
  const f = fixture();
  const library = f.project.schematic.libraries['Device:R'];
  library.push(['property', quote('Custom provenance'), quote('Retain this definition')]);
  const result = prepareParasiticsStudy(f.project, f.input);
  assert.equal(result.project.schematic.libraries['Device:R'], library);
  assert.equal(
    basicSimulationKind(
      result.project.schematic.parts.find((part) => part.ref === result.references.resistor)!,
    ),
    'R',
  );
  for (const kind of ['power', 'pin', 'body', 'Sim.Library', 'OpenPE.PassiveModel'] as const) {
    const { project, input } = fixture();
    const symbol = project.schematic.libraries['Device:R'];
    if (kind === 'power') symbol.push(['power']);
    else if (kind === 'pin')
      child(unitGraphics(symbol, 1).flatMap((unit) => children(unit, 'pin'))[0], 'length')![1] =
        '1.5';
    else if (kind === 'body') {
      const rectangle = children(symbol, 'symbol').flatMap((unit) =>
        children(unit, 'rectangle'),
      )[0];
      child(rectangle, 'start')!.splice(1, 2, '-100', '-100');
    } else symbol.push(['property', quote(kind), quote('custom')]);
    const before = JSON.stringify(project);
    assert.throws(
      () => prepareParasiticsStudy(project, input),
      /unsupported|supported study geometry|original schematic network/,
    );
    assert.equal(JSON.stringify(project), before);
  }
});

test('stale identities and disconnected board copper reject before any native edit', () => {
  const { project, input } = fixture();
  const before = serializeProject(project);
  for (const change of [{ boardId: uid() }, { schematicId: uid() }, { endId: uid() }])
    assert.throws(
      () => prepareParasiticsStudy(project, { ...input, ...change }),
      /no longer|same assigned|terminal/,
    );
  assert.throws(
    () => prepareParasiticsStudy({ ...project, pcb: { ...project.pcb!, tracks: [] } }, input),
    /disconnected/,
  );
  assert.equal(serializeProject(project), before);
});
