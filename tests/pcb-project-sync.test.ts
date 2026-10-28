import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ProjectCore } from '../core/project-core';
import { createPart, emptyCircuit, pinPositions, uid } from '../lib/circuit';
import { ownProject, isOwnedProject } from '../lib/immutable-project';
import { createProject, serializeProject } from '../lib/project';
import { projectFromNativeFiles } from '../lib/kicad-project';
import { displayPartValue, partFields } from '../lib/library';
import { PCBProjectSync, schematicPCBSourceFingerprint } from '../lib/pcb-project-sync';
import { updatePCBFromSchematic } from '../lib/pcb-sync';
import { child, children, parseSExpr, val } from '../lib/sexpr';

const detail = {
  id: 'Test:TwoPin',
  footprint: parseSExpr(`(footprint "TwoPin" (layer "F.Cu")
    (pad "1" thru_hole rect (at 0 0) (size 2 2) (drill 1) (layers "*.Cu" "*.Mask"))
    (pad "2" thru_hole circle (at 2.54 0) (size 2 2) (drill 1) (layers "*.Cu" "*.Mask")))`),
};

function fixture(withBoard = false) {
  const circuit = emptyCircuit();
  const part = createPart(circuit, 'R', 10.16, 10.16);
  part.fields = { Footprint: detail.id };
  circuit.parts.push(part);
  circuit.labels = pinPositions(part, circuit.libraries[part.libId]).map((pin, index) => ({
    ...pin,
    id: uid(),
    text: index ? 'OUT' : 'IN',
  }));
  const project = createProject(circuit);
  if (withBoard)
    project.pcb = updatePCBFromSchematic(circuit, undefined, new Map([[detail.id, detail]])).board;
  return project;
}

test('owned loaded boards reuse preparation while board and other-sheet edits stay authoritative', () => {
  const initial = fixture(true);
  initial.additionalSchematics = [emptyCircuit()];
  const project = ownProject(initial);
  const sync = new PCBProjectSync(project);
  const first = sync.prepare(project)!;
  assert.equal(first.project, project);
  assert.equal(sync.prepare(project), first);
  assert.throws(() => first.warnings.push('poisoned'), TypeError);

  const boardEdit = structuredClone(project);
  boardEdit.pcb!.footprints[0].x += 1.27;
  boardEdit.additionalSchematics![0].title = 'Other sheet';
  const next = ownProject(boardEdit, project);
  assert.equal(next.schematic, project.schematic);
  const prepared = sync.prepare(next)!;
  assert.equal(prepared.project, next);
  assert.equal(prepared.project.pcb, next.pcb);
  assert.equal(sync.prepare(next), prepared);
  assert.equal(sync.sources.size, 0);
});

test('mutable and shallow-frozen projects cannot reuse a stale board-source fingerprint', () => {
  const project = fixture(true);
  const sync = new PCBProjectSync(project);
  assert.equal(sync.prepare(project)!.project, project);
  Object.freeze(project);
  project.schematic.labels[0].text = 'VIN';
  const prepared = sync.prepare(project)!;
  assert.ok(prepared.project.pcb!.nets.some((net) => net.name === 'VIN'));
  assert.ok(project.pcb!.nets.some((net) => net.name === 'IN'));
  project.schematic.parts[0].x = NaN;
  assert.throws(() => sync.prepare(project), /invalid|finite|number/i);
});

test('missing footprint sources retry and materialized cached results cannot be mutated', () => {
  const project = ownProject(fixture());
  const sync = new PCBProjectSync();
  assert.equal(sync.prepare(project), null);
  sync.sources.set(detail.id, detail);
  const prepared = sync.prepare(project)!;
  assert.ok(prepared.project.pcb);
  assert.ok(isOwnedProject(prepared.project));
  assert.equal(sync.prepare(project), prepared);
  assert.equal(sync.prepare(prepared.project), prepared);
  const before = serializeProject(prepared.project);
  assert.throws(() => {
    prepared.project.pcb!.footprints[0].x = 999;
  }, TypeError);
  assert.throws(() => prepared.warnings.push('poisoned'), TypeError);
  assert.equal(sync.prepare(structuredClone(project)), prepared);
  assert.equal(serializeProject(sync.prepare(project)!.project), before);
});

test('owned participation changes preserve a loaded board and package aliases', () => {
  const initial = fixture(true);
  initial.pcb!.footprints[0].libraryId = 'OriginalEmbeddedPackage';
  initial.schematic.parts[0].fields!.Footprint = 'SourceLibrary:OriginalPackage';
  const project = ownProject(initial);
  const sync = new PCBProjectSync(project);
  const changed = structuredClone(project);
  changed.schematic.parts[0].excludeFromSimulation = true;
  const next = ownProject(changed, project);
  const prepared = sync.prepare(next)!;
  assert.equal(prepared.project, next);
  assert.equal(prepared.project.pcb, project.pcb);
  assert.equal(sync.sources.size, 0);
});

function nativeLM2596() {
  const stem = 'lm2596-to220-5-buck';
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

test('native LM2596 Value edits retain source net aliases, copper, fills and packages in one undo', () => {
  const project = nativeLM2596();
  const sync = new PCBProjectSync(project);
  const core = new ProjectCore(project, {
    prepare: (next) => sync.prepare(next)?.project ?? next,
  });
  const before = core.getSnapshot();
  const original = core.getNativeFiles();
  const board = before.project!.pcb!;
  const part = before.project!.schematic.parts.find((part) => part.ref === 'R1')!;
  const footprint = board.footprints.find((footprint) => footprint.symbolId === part.id)!;
  assert.ok(board.nets.some((net) => net.name === '/VIN'));
  assert.ok(board.nets.some((net) => net.name === 'Net-(U1-FB)'));
  assert.ok(board.zones.some((zone) => zone.filledPolygons?.length));

  core.execute('part.properties', {
    schematicId: before.project!.schematic.id,
    partId: part.id,
    value: '22k',
  });
  const after = core.getSnapshot();
  assert.equal(after.project!.pcb, board, 'A caption edit retains the entire authoritative board.');
  assert.equal(after.undoDepth, 1);
  const changed = core.getNativeFiles();
  const boardRoot = (bundle: typeof original) =>
    parseSExpr(bundle.files.find((file) => file.name.endsWith('.kicad_pcb'))!.source);
  const originalBoard = boardRoot(original);
  const editedBoard = boardRoot(changed);
  for (const kind of ['net', 'segment', 'via'])
    assert.deepEqual(children(editedBoard, kind), children(originalBoard, kind), kind);
  const editedFootprint = children(editedBoard, 'footprint').find(
    (node) => val(child(node, 'uuid')) === footprint.id,
  )!;
  assert.equal(
    val(
      children(editedFootprint, 'property').find((node) => val(node) === 'Value'),
      2,
    ),
    '22k',
    'Native PCB captions still follow the accepted schematic Value.',
  );
  const reopened = projectFromNativeFiles(changed).pcb!;
  const originalReopened = projectFromNativeFiles(original).pcb!;
  for (const key of ['nets', 'tracks', 'vias', 'zones'] as const)
    assert.deepEqual(reopened[key], originalReopened[key], key);
  assert.deepEqual(
    reopened.footprints.map((footprint) => footprint.id),
    board.footprints.map((footprint) => footprint.id),
  );
  core.undo();
  assert.deepEqual(core.getNativeFiles(), original);
  assert.equal(core.getSnapshot().canUndo, false);
});

test('linked Sim.Params Value and metadata edits retain a loaded native board', () => {
  const project = nativeLM2596();
  const part = project.schematic.parts.find((part) => part.ref === 'R1')!;
  part.value = '${SIM.PARAMS}';
  part.fields = { ...partFields(part), 'Sim.Params': 'r=10k', Description: 'Original resistor' };
  const sync = new PCBProjectSync(project);
  const core = new ProjectCore(project, {
    prepare: (next) => sync.prepare(next)?.project ?? next,
  });
  const before = core.getSnapshot();
  const original = core.getNativeFiles();
  const ownedPart = before.project!.schematic.parts.find((item) => item.id === part.id)!;
  core.execute('part.properties', {
    schematicId: before.project!.schematic.id,
    partId: part.id,
    value: '22k',
    fields: Object.entries(partFields(ownedPart)).map(([name, value]) => ({
      name,
      value: name === 'Description' ? 'Updated resistor' : value,
    })),
  });
  const after = core.getSnapshot();
  const edited = after.project!.schematic.parts.find((item) => item.id === part.id)!;
  assert.equal(displayPartValue(edited), '22k');
  assert.equal(partFields(edited)['Sim.Params'], 'r=22k');
  assert.equal(partFields(edited).Description, 'Updated resistor');
  assert.equal(after.project!.pcb, before.project!.pcb);
  assert.equal(after.undoDepth, 1);
  assert.equal(sync.sources.size, 0);
  core.undo();
  assert.deepEqual(core.getNativeFiles(), original);
});

test('power Value changes still rename physical rails on a loaded board', () => {
  const initial = fixture();
  const pins = pinPositions(initial.schematic.parts[0], initial.schematic.libraries['Device:R']);
  initial.schematic.labels.shift();
  const power = createPart(initial.schematic, 'GND', pins[0].x, pins[0].y);
  initial.schematic.parts.push(power);
  initial.pcb = updatePCBFromSchematic(
    initial.schematic,
    undefined,
    new Map([[detail.id, detail]]),
  ).board;
  const project = ownProject(initial);
  assert.ok(project.pcb!.nets.some((net) => net.name === 'GND'));
  const sync = new PCBProjectSync(project);
  const changed = structuredClone(project);
  changed.schematic.parts.find((part) => part.id === power.id)!.value = 'PGND';
  const result = sync.prepare(ownProject(changed, project))!;
  assert.notEqual(result.project.pcb, project.pcb);
  assert.ok(result.project.pcb!.nets.some((net) => net.name === 'PGND'));
  assert.ok(!result.project.pcb!.nets.some((net) => net.name === 'GND'));
});

test('caption projection retains footprint, reference, electrical geometry and library guards', () => {
  const project = fixture(true);
  const original = schematicPCBSourceFingerprint(project);
  const changed = (mutate: (next: typeof project) => void) => {
    const next = structuredClone(project);
    mutate(next);
    return schematicPCBSourceFingerprint(next);
  };
  assert.notEqual(
    changed((next) => {
      next.schematic.parts[0].fields!.Footprint = 'Test:Other';
    }),
    original,
  );
  assert.notEqual(
    changed((next) => {
      next.schematic.parts[0].ref = 'R2';
    }),
    original,
  );
  assert.notEqual(
    changed((next) => {
      next.schematic.parts[0].x += 1.27;
    }),
    original,
  );
  assert.notEqual(
    changed((next) => {
      next.schematic.labels[0].text = 'VIN';
    }),
    original,
  );
  assert.notEqual(
    changed((next) => {
      next.schematic.libraries['Device:R'].push(['power']);
    }),
    original,
  );
  assert.equal(
    changed((next) => {
      next.schematic.parts[0].fields!.Footprint = '  Test:TwoPin  ';
    }),
    original,
  );
});

test('replacement notices survive the normalized follow-up snapshot', () => {
  const project = ownProject(fixture(true));
  const sync = new PCBProjectSync(project);
  const replacement = structuredClone(detail);
  replacement.id = 'Test:Replacement';
  replacement.footprint[1] = 'Replacement';
  child(children(replacement.footprint, 'pad')[1], 'at')![1] = '5.08';
  sync.sources.set(replacement.id, replacement);
  const changed = structuredClone(project);
  changed.schematic.parts[0].fields!.Footprint = replacement.id;
  const next = ownProject(changed, project);
  const prepared = sync.prepare(next)!;
  assert.ok(prepared.warnings.some((warning) => warning.includes('alignment')));
  assert.equal(sync.prepare(prepared.project), prepared);
  assert.equal(sync.prepare(structuredClone(prepared.project)), prepared);
});

test('cancelled immutable-source resolution cannot publish a footprint or prepared result', async () => {
  const project = ownProject(fixture());
  const source = serializeProject(project);
  const sync = new PCBProjectSync();
  const controller = new AbortController();
  await assert.rejects(
    sync.resolve(
      project,
      async () => {
        controller.abort();
        return detail;
      },
      controller.signal,
    ),
    /abort/i,
  );
  assert.equal(sync.sources.size, 0);
  assert.equal(sync.prepare(project), null);
  assert.equal(serializeProject(project), source);
});
