import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProjectCore, coreCommandDefinitions, coreQueryDefinitions } from '../core/project-core';
import { createPart, emptyCircuit, pinPositions, uid } from '../lib/circuit';
import {
  createProject,
  serializeProject,
  parseProject,
  projectFromNativeFiles,
} from '../lib/project';
import { updatePCBFromSchematic } from '../lib/pcb-sync';
import { PCBProjectSync } from '../lib/pcb-project-sync';
import { child, children, parseSExpr, val } from '../lib/sexpr';
import { createEmptyPCB } from '../lib/pcb-layout';
import { isOwnedProject } from '../lib/immutable-project';
import { displayPartValue, partFields } from '../lib/library';

function fixture(withBoard = false) {
  const schematic = emptyCircuit();
  schematic.title = 'Resistor';
  const part = createPart(schematic, 'R', 10.16, 10.16);
  schematic.parts.push(part);
  const project = createProject(schematic);
  project.extensions = { 'example.org': { preserved: true } };
  if (withBoard) {
    part.fields = { Footprint: 'Test:TwoPin' };
    const pins = pinPositions(part, schematic.libraries[part.libId]);
    schematic.labels = pins.map((pin, index) => ({
      ...pin,
      id: uid(),
      text: index ? 'OUT' : 'IN',
    }));
    const detail = {
      id: 'Test:TwoPin',
      footprint: parseSExpr(
        '(footprint "TwoPin" (layer "F.Cu") (pad "1" thru_hole rect (at 0 0) (size 2 2) (drill 1) (layers "*.Cu" "*.Mask")) (pad "2" thru_hole circle (at 2.54 0) (size 2 2) (drill 1) (layers "*.Cu" "*.Mask")))',
      ),
    };
    project.pcb = updatePCBFromSchematic(
      schematic,
      undefined,
      new Map([[detail.id, detail]]),
    ).board;
    project.pcb.tracks.push({
      id: uid(),
      start: { x: 1, y: 2 },
      end: { x: 3, y: 4 },
      netId: project.pcb.nets[0].id,
      width: 0.25,
      layer: 'F.Cu',
    });
  }
  return { project, partId: part.id, schematicId: schematic.id };
}

test('copper-only replacement retains exact assignments while validating and undoing the whole board', () => {
  const { project } = fixture(true);
  const core = new ProjectCore(project);
  const before = core.getSnapshot();
  const board = before.project!.pcb!;
  assert.throws(() => core.replaceBoard({ ...board, tracks: [...board.tracks, board.tracks[0]] }));
  assert.equal(
    core.getSnapshot(),
    before,
    'Invalid copper cannot publish through retained footprints.',
  );
  assert.equal(
    core.replaceBoard({
      ...board,
      tracks: board.tracks.map((track, index) =>
        index
          ? track
          : {
              ...track,
              start: { ...track.start, x: track.start.x + 0.5 },
            },
      ),
    }),
    true,
  );
  const changed = core.getSnapshot();
  assert.equal(changed.project!.schematic, before.project!.schematic);
  assert.equal(changed.project!.pcb!.footprints, board.footprints);
  assert.equal(changed.undoDepth, 1);
  core.undo();
  assert.equal(core.getSnapshot().source, before.source);
  assert.equal(core.getSnapshot().project!.pcb, board);
});

test('Core owns immutable stable state and exposes only the canonical document through public queries', () => {
  const { project } = fixture(true);
  const core = new ProjectCore(project);
  const initial = core.getSnapshot();
  assert.equal(core.getSnapshot(), initial);
  project.schematic.parts[0].value = 'external mutation';
  assert.equal(initial.project!.schematic.parts[0].value, '10k');
  assert.throws(() => {
    initial.project!.schematic.parts[0].value = 'illegal mutation';
  });
  const queried = core.query('project.snapshot') as {
    project: Record<string, unknown>;
    revision: string;
  };
  assert.equal(queried.revision, '0');
  assert.equal(serializeProject(parseProject(JSON.stringify(queried.project))), initial.source);
  assert.ok(!('raw' in (queried.project.schematic as object)));
  queried.project.name = 'query copy';
  assert.notEqual(core.getSnapshot().project!.name, 'query copy');
});

test('cloned editor drafts retain unchanged owned sheets, libraries, board and metadata identities', () => {
  const { project } = fixture(true);
  const core = new ProjectCore(project);
  core.execute('schematic.add');
  const before = core.getSnapshot();
  const draft = structuredClone(before.project!);
  draft.schematic.parts[0].value = '22k';
  core.commitProject(draft);
  const after = core.getSnapshot();
  assert.notEqual(after.project, before.project);
  assert.notEqual(after.project!.schematic, before.project!.schematic);
  assert.notEqual(after.project!.schematic.parts[0], before.project!.schematic.parts[0]);
  assert.equal(after.project!.schematic.libraries, before.project!.schematic.libraries);
  assert.equal(after.project!.additionalSchematics, before.project!.additionalSchematics);
  assert.equal(after.project!.pcb, before.project!.pcb);
  assert.equal(after.project!.extensions, before.project!.extensions);
  draft.schematic.parts[0].value = 'caller mutation';
  draft.pcb!.tracks[0].width = 9;
  assert.equal(after.project!.schematic.parts[0].value, '22k');
  assert.equal(after.project!.pcb!.tracks[0].width, 0.25);
  assert.equal(serializeProject(after.project!), after.source);
  core.undo();
  assert.equal(core.getSnapshot().project, before.project);
  assert.equal(core.getSnapshot().source, before.source);
  core.redo();
  assert.equal(core.getSnapshot().project, after.project);
  assert.equal(core.getSnapshot().source, after.source);
  core.commitProject(structuredClone(after.project!));
  assert.equal(core.getSnapshot().project, after.project);
  assert.equal(core.getSnapshot().undoDepth, after.undoDepth);
});

test('shallow-frozen caller projects cannot certify mutable descendants or poison serialized sources', () => {
  const { project } = fixture();
  Object.freeze(project);
  assert.equal(isOwnedProject(project), false);
  const source = serializeProject(project);
  project.schematic.parts[0].value = '22k';
  assert.notEqual(serializeProject(project), source);
  const core = new ProjectCore(project);
  const owned = core.getSnapshot();
  assert.equal(isOwnedProject(owned.project!), true);
  assert.notEqual(owned.project!.schematic, project.schematic);
  project.schematic.parts[0].value = 'caller mutation';
  assert.equal(owned.project!.schematic.parts[0].value, '22k');
  assert.equal(serializeProject(owned.project!), owned.source);
  const invalid = structuredClone(owned.project!);
  invalid.schematic.parts[0].x = Number.NaN;
  assert.throws(() => core.commitProject(Object.freeze(invalid)), /numbers must be finite/);
  assert.equal(core.getSnapshot(), owned);
});

test('schematic pose edits retain the owned PCB while reference and value edits refresh exported captions', () => {
  const { project } = fixture(true);
  const core = new ProjectCore(project);
  const before = core.getSnapshot();
  const native = core.getNativeFiles();
  core.replaceSchematic({
    ...before.project!.schematic,
    parts: before.project!.schematic.parts.map((part) => ({ ...part, x: part.x + 1.27 })),
  });
  const moved = core.getSnapshot();
  assert.equal(moved.project!.pcb, before.project!.pcb);
  const boardBytes = (files: typeof native) =>
    files.files.find((file) => file.name.endsWith('.kicad_pcb'))!.source;
  assert.equal(boardBytes(core.getNativeFiles()), boardBytes(native));
  assert.equal(serializeProject(parseProject(moved.source)), moved.source);
  core.replaceSchematic({
    ...moved.project!.schematic,
    parts: moved.project!.schematic.parts.map((part) => ({ ...part, ref: 'R9', value: '22k' })),
  });
  const edited = core.getSnapshot();
  assert.equal(edited.project!.pcb, before.project!.pcb);
  const editedBoard = boardBytes(core.getNativeFiles());
  assert.notEqual(editedBoard, boardBytes(native));
  assert.match(editedBoard, /"R9"/);
  assert.match(editedBoard, /"22k"/);
  core.undo();
  assert.equal(core.getSnapshot().project, moved.project);
  assert.equal(boardBytes(core.getNativeFiles()), boardBytes(native));
});

test('preparation receives validated immutable input and invalid edits never reach it', () => {
  const { project } = fixture();
  let calls = 0;
  const core = new ProjectCore(project, {
    prepare: (input) => {
      calls++;
      assert.equal(isOwnedProject(input), true);
      assert.ok(Object.isFrozen(input.schematic.parts[0]));
      assert.equal(serializeProject(input), serializeProject(structuredClone(input)));
      input.schematic.parts[0].value = 'illegal preparation mutation';
      return input;
    },
  });
  const before = core.getSnapshot();
  const invalid = structuredClone(project);
  invalid.id = 'invalid UUID';
  assert.throws(() => core.commitProject(invalid), /Invalid OpenPE project/);
  assert.equal(calls, 0);
  assert.equal(core.getSnapshot(), before);
  const edit = structuredClone(project);
  edit.name = 'Edited';
  assert.throws(() => core.commitProject(edit), /read only|readonly|Cannot assign/);
  assert.equal(calls, 1);
  assert.equal(core.getSnapshot(), before);
  assert.equal(edit.schematic.parts[0].value, '10k');
});

test('preparation results stay detached and failed preparation preserves state, Source and history', () => {
  const { project } = fixture(true);
  let mode: 'valid' | 'invalid' | 'throw' = 'valid';
  let retained: typeof project | undefined;
  const core = new ProjectCore(project, {
    prepare: (input) => {
      if (mode === 'throw') throw new Error('Preparation failed');
      retained = structuredClone(input);
      retained.extensions['example.org'] = { prepared: true };
      if (mode === 'invalid') retained.id = 'invalid UUID';
      return retained;
    },
  });
  const edit = structuredClone(project);
  edit.name = 'Prepared edit';
  core.commitProject(edit);
  const before = core.getSnapshot();
  retained!.schematic.parts[0].value = 'retained mutation';
  (retained!.extensions['example.org'] as { prepared: boolean }).prepared = false;
  assert.equal(before.project!.schematic.parts[0].value, '10k');
  assert.deepEqual(before.project!.extensions['example.org'], { prepared: true });
  assert.equal(serializeProject(before.project!), before.source);
  const next = structuredClone(before.project!);
  next.name = 'Next edit';
  mode = 'invalid';
  assert.throws(() => core.commitProject(next), /Invalid OpenPE project/);
  assert.equal(core.getSnapshot(), before);
  mode = 'throw';
  assert.throws(() => core.commitProject(next), /Preparation failed/);
  assert.equal(core.getSnapshot(), before);
  assert.equal(core.getSnapshot().undoDepth, 1);
  core.undo();
  assert.equal(core.getSnapshot().source, serializeProject(project));
});

test('load and materialization preserve ownership and reject invalid replacements atomically', () => {
  const { project } = fixture(true);
  const core = new ProjectCore(project);
  const before = core.getSnapshot();
  const materialized = structuredClone(before.project!);
  materialized.extensions['example.org'] = { materialized: true };
  assert.equal(core.materialize(before.project!, materialized), true);
  const after = core.getSnapshot();
  assert.equal(after.project!.schematic, before.project!.schematic);
  assert.equal(after.project!.pcb, before.project!.pcb);
  materialized.schematic.parts[0].value = 'caller mutation';
  assert.equal(after.project!.schematic.parts[0].value, '10k');
  const invalid = structuredClone(after.project!);
  invalid.id = 'invalid UUID';
  assert.throws(() => core.materialize(after.project!, invalid), /Invalid OpenPE project/);
  assert.equal(core.getSnapshot(), after);
  assert.throws(() => core.load(invalid), /Invalid OpenPE project/);
  assert.equal(core.getSnapshot(), after);
  const loaded = structuredClone(after.project!);
  loaded.name = 'Loaded';
  core.load(loaded);
  loaded.schematic.parts[0].value = 'caller mutation';
  assert.equal(core.getSnapshot().project!.schematic.parts[0].value, '10k');
  assert.equal(core.getSnapshot().project!.pcb, after.project!.pcb);
  assert.equal(core.getSnapshot().undoDepth, 0);
});

test('human replacement and Agent operations use the same whole-project undo history and events', () => {
  const { project, schematicId } = fixture(true);
  const core = new ProjectCore(project);
  const events: string[] = [];
  const unsubscribe = core.subscribe((event) => events.push(`${event.type}:${event.revision}`));
  const firstEdit = core.execute(
    'schematic.operations',
    { schematicId, operations: [{ type: 'setValue', ref: 'R1', value: '22k' }] },
    { expectedRevision: 0 },
  ) as { revision: string };
  assert.equal(firstEdit.revision, '1');
  assert.equal(core.getSnapshot().project!.schematic.parts[0].value, '22k');
  const human = structuredClone(core.getSnapshot().project!.schematic);
  human.parts[0].x += 1.27;
  core.replaceSchematic(human);
  assert.equal(core.getSnapshot().undoDepth, 2);
  assert.deepEqual(core.getSnapshot().project!.pcb!.tracks, project.pcb!.tracks);
  assert.deepEqual(core.getSnapshot().project!.extensions, project.extensions);
  assert.equal(core.undo(), true);
  assert.equal(core.getSnapshot().project!.schematic.parts[0].x, project.schematic.parts[0].x);
  assert.equal(core.getSnapshot().project!.schematic.parts[0].value, '22k');
  assert.equal(core.undo(), true);
  assert.equal(core.getSnapshot().source, serializeProject(project));
  assert.equal(core.redo(), true);
  assert.deepEqual(events, [
    'project.changed:1',
    'project.changed:2',
    'history.changed:3',
    'history.changed:4',
    'history.changed:5',
  ]);
  unsubscribe();
  core.redo();
  assert.equal(events.length, 5);
});

test('invalid or stale commands fail atomically and unknown command inputs are rejected', () => {
  const { project, schematicId } = fixture();
  const core = new ProjectCore(project);
  const initial = core.getSnapshot();
  assert.throws(
    () =>
      core.execute('schematic.operations', {
        schematicId,
        operations: [
          { type: 'setValue', ref: 'R1', value: '22k' },
          { type: 'removePart', ref: 'R99' },
        ],
      }),
    /Cannot find R99/,
  );
  assert.equal(core.getSnapshot(), initial);
  assert.throws(
    () => core.execute('project.replace', { source: JSON.stringify(project) }),
    /Invalid OpenPE project/,
  );
  assert.equal(core.getSnapshot(), initial);
  assert.throws(
    () => core.execute('schematic.delete', { schematicId, ids: [], surprise: true }),
    /additional properties/,
  );
  assert.throws(
    () => core.execute('project.replace', { source: initial.source }, { expectedRevision: 99 }),
    /project changed/,
  );
  assert.throws(() => core.execute('unknown'), /Unknown Core capability/);
  assert.throws(() => core.query('project.get', { path: 'private' }), /additional properties/);
  assert.equal(core.getSnapshot(), initial);
});

test('Source keeps invalid drafts editable and gates all conflicting commands until apply or discard', () => {
  const { project, schematicId } = fixture();
  const core = new ProjectCore(project);
  const valid = core.getSnapshot().source;
  core.updateSource('{ invalid');
  assert.equal(core.applySource(), null);
  assert.ok(core.getSnapshot().sourceError.length);
  assert.equal(core.getSnapshot().sourceDraft, '{ invalid');
  assert.equal(core.getSnapshot().source, valid);
  assert.equal(core.getSnapshot().undoDepth, 0);
  for (const [command, input] of [
    ['schematic.add', {}],
    ['schematic.remove', { schematicId }],
    [
      'schematic.operations',
      { schematicId, operations: [{ type: 'setValue', ref: 'R1', value: '33k' }] },
    ],
    ['project.replace', { source: valid }],
    ['history.undo', {}],
    ['history.redo', {}],
  ] as const)
    assert.throws(() => core.execute(command, input), /Apply the Source/);
  const edited = JSON.parse(valid);
  edited.project.name = 'Edited in Source';
  core.updateSource(JSON.stringify(edited));
  assert.equal(core.applySource()!.name, 'Edited in Source');
  assert.equal(core.getSnapshot().sourceDraft, null);
  assert.equal(core.getSnapshot().sourceError, '');
  assert.equal(core.getSnapshot().undoDepth, 1);
  core.undo();
  assert.equal(core.getSnapshot().source, valid);
  core.updateSource('bad');
  core.discardSource();
  assert.equal(core.getSnapshot().sourceDraft, null);
  assert.equal(core.getSnapshot().undoDepth, 0);
});

test('no-op field, replacement and Source edits preserve cleanliness and do not create undo transactions', () => {
  const { project, schematicId, partId } = fixture();
  const core = new ProjectCore(project);
  const initial = core.getSnapshot();
  core.execute('part.properties', { schematicId, partId, value: '10k' });
  assert.equal(core.getSnapshot(), initial);
  core.commitProject(structuredClone(project));
  assert.equal(core.getSnapshot(), initial);
  core.updateSource(initial.source);
  core.applySource();
  assert.equal(core.getSnapshot().undoDepth, 0);
  assert.equal(core.getSnapshot().source, initial.source);
  assert.equal(core.getSnapshot().sourceDraft, null);
});

test('part commands preserve unrelated owned content, filter removed raw fields and detach caller rows', () => {
  const { project, schematicId, partId } = fixture(true);
  project.schematic.parts[0].fields = {
    ...project.schematic.parts[0].fields,
    Retired: 'remove this field',
    Kept: 'original',
  };
  project.schematic.parts.push(createPart(project.schematic, 'C', 30.48, 10.16));
  const core = new ProjectCore(parseProject(serializeProject(project)));
  const before = core.getSnapshot();
  const sheet = before.project!.schematic;
  const rows = Object.entries(partFields(sheet.parts[0]))
    .filter(([name]) => name !== 'Retired')
    .map(([name, value]) => ({ name, value: name === 'Kept' ? 'accepted' : value }));
  core.execute('part.properties', { schematicId, partId, value: '22k', fields: rows });
  const accepted = core.getSnapshot();
  const changed = accepted.project!.schematic;
  assert.equal(accepted.undoDepth, 1);
  assert.equal(changed.parts[1], sheet.parts[1]);
  assert.equal(changed.libraries, sheet.libraries);
  assert.equal(changed.wires, sheet.wires);
  assert.equal(changed.junctions, sheet.junctions);
  assert.equal(changed.labels, sheet.labels);
  assert.equal(changed.original, sheet.original);
  assert.equal(accepted.project!.pcb, before.project!.pcb);
  assert.equal(accepted.project!.extensions, before.project!.extensions);
  assert.equal(partFields(changed.parts[0]).Kept, 'accepted');
  assert.equal(partFields(changed.parts[0]).Retired, undefined);
  assert.ok(!children(changed.parts[0].raw!, 'property').some((node) => val(node) === 'Retired'));
  assert.equal(
    children(changed.parts[0].raw!, 'property').find((node) => val(node) === 'Reference'),
    children(sheet.parts[0].raw!, 'property').find((node) => val(node) === 'Reference'),
  );
  rows.find((row) => row.name === 'Kept')!.value = 'caller mutation';
  assert.equal(partFields(changed.parts[0]).Kept, 'accepted');
  assert.equal(partFields(sheet.parts[0]).Kept, 'original');
  assert.equal(partFields(sheet.parts[0]).Retired, 'remove this field');
  assert.equal(serializeProject(before.project!), before.source);
  assert.throws(() =>
    core.execute('part.properties', {
      schematicId,
      partId,
      fields: [{ name: 'Reference', value: 'invalid' }],
    }),
  );
  assert.equal(core.getSnapshot(), accepted);
  core.execute('part.participation', { schematicId, partId, included: false });
  const excluded = core.getSnapshot();
  assert.equal(excluded.project!.schematic.parts[0].raw, changed.parts[0].raw);
  assert.equal(excluded.project!.schematic.parts[1], changed.parts[1]);
  assert.equal(excluded.project!.pcb, accepted.project!.pcb);
  core.execute('part.participation', { schematicId, partId, included: false });
  assert.equal(core.getSnapshot(), excluded);
  core.undo();
  assert.equal(core.getSnapshot().project, accepted.project);
  core.undo();
  assert.equal(core.getSnapshot().project, before.project);
  core.redo();
  assert.equal(core.getSnapshot().project, accepted.project);
});

test('shared-unit part commands retain value bindings and move only the selected unit atomically', () => {
  const { project, schematicId, partId } = fixture();
  const first = project.schematic.parts[0];
  first.value = '${SIM.PARAMS}';
  first.fields = { 'Sim.Params': ' r = 10k ', Retained: 'shared field' };
  const library = project.schematic.libraries[first.libId];
  const secondUnit = structuredClone(
    children(library, 'symbol').find((node) => /_1_1"$/.test(String(node[1])))!,
  );
  secondUnit[1] = String(secondUnit[1]).replace('_1_1"', '_2_1"');
  library.push(secondUnit);
  project.schematic.parts.push({ ...first, id: uid(), unit: 2, x: first.x + 20.32 });
  project.schematic.parts.push(createPart(project.schematic, 'C', 40.64, 10.16));
  const core = new ProjectCore(parseProject(serializeProject(project)));
  const before = core.getSnapshot();
  const units = before.project!.schematic.parts;
  core.execute('part.properties', {
    schematicId,
    partId,
    reference: 'R7',
    value: '22k',
    position: { x: 15.24, y: 17.78 },
    rotation: -90,
  });
  const edited = core.getSnapshot();
  const parts = edited.project!.schematic.parts;
  for (const unit of parts.slice(0, 2)) {
    assert.equal(unit.ref, 'R7');
    assert.equal(unit.value, '${SIM.PARAMS}');
    assert.equal(displayPartValue(unit), '22k');
    assert.equal(partFields(unit)['Sim.Params'], ' r = 22k ');
    assert.equal(partFields(unit).Retained, 'shared field');
  }
  assert.deepEqual([parts[0].x, parts[0].y, parts[0].rotation], [15.24, 17.78, 270]);
  assert.deepEqual(
    [parts[1].x, parts[1].y, parts[1].rotation],
    [units[1].x, units[1].y, units[1].rotation],
  );
  assert.equal(parts[2], units[2]);
  assert.equal(edited.project!.schematic.libraries, before.project!.schematic.libraries);
  assert.equal(child(parts[1].raw!, 'at'), child(units[1].raw!, 'at'));
  assert.equal(edited.undoDepth, 1);
  assert.throws(
    () => core.execute('part.properties', { schematicId, partId, value: 'r=33k' }),
    /only the component value/,
  );
  assert.equal(core.getSnapshot(), edited);
  core.execute('part.participation', { schematicId, partId, included: false });
  assert.ok(
    core
      .getSnapshot()
      .project!.schematic.parts.slice(0, 2)
      .every((unit) => unit.excludeFromSimulation),
  );
  assert.equal(core.getSnapshot().undoDepth, 2);
  core.undo();
  assert.equal(core.getSnapshot().project, edited.project);
  core.undo();
  assert.equal(core.getSnapshot().project, before.project);
});

test('whole-project Source transactions preserve PCB, extensions and independent files through undo', () => {
  const { project } = fixture(true);
  const core = new ProjectCore(project);
  core.execute('schematic.add');
  const source = core.getSnapshot().source;
  const replacement = JSON.parse(source);
  replacement.extensions['example.org'].preserved = false;
  replacement.project.name = 'Complete container';
  core.updateSource(JSON.stringify(replacement));
  core.applySource();
  assert.equal(core.getSnapshot().undoDepth, 2);
  assert.equal(core.getSnapshot().project!.additionalSchematics!.length, 1);
  assert.deepEqual(core.getSnapshot().project!.pcb, project.pcb);
  core.undo();
  assert.equal(core.getSnapshot().source, source);
  const primary = core.query('schematic.get', { schematicId: project.schematic.id });
  assert.deepEqual(parseProject(JSON.stringify(primary)).pcb, project.pcb);
  const secondaryId = core.getSnapshot().project!.additionalSchematics![0].id;
  const secondary = core.query('schematic.get', { schematicId: secondaryId });
  assert.equal(parseProject(JSON.stringify(secondary)).schematic.id, secondaryId);
  assert.equal(parseProject(JSON.stringify(secondary)).pcb, null);
});

test('clearing a footprint assignment removes its linked package in the same undo edit while retaining copper', () => {
  const { project, schematicId, partId } = fixture(true);
  const core = new ProjectCore(project);
  core.execute('part.properties', {
    schematicId,
    partId,
    fields: [{ name: 'Footprint', value: '' }],
  });
  assert.equal(core.getSnapshot().project!.pcb!.footprints.length, 0);
  assert.deepEqual(core.getSnapshot().project!.pcb!.tracks, project.pcb!.tracks);
  assert.equal(core.getSnapshot().undoDepth, 1);
  core.undo();
  assert.equal(core.getSnapshot().source, serializeProject(project));
  const board = structuredClone(core.getSnapshot().project!.pcb!);
  board.footprints = [];
  core.replaceBoard(board);
  assert.equal(core.getSnapshot().project!.schematic.parts[0].fields!.Footprint, '');
  assert.deepEqual(core.getSnapshot().project!.pcb!.tracks, project.pcb!.tracks);
  core.undo();
  assert.equal(core.getSnapshot().source, serializeProject(project));
});

test('library materialization retains one originating edit and rejects stale or pending-Source results', () => {
  const { project, schematicId } = fixture();
  const core = new ProjectCore(project);
  core.execute('schematic.operations', {
    schematicId,
    operations: [{ type: 'setValue', ref: 'R1', value: '22k' }],
  });
  const basis = core.getSnapshot().project!;
  const result = structuredClone(basis);
  result.extensions['example.org'] = { materialized: true };
  assert.equal(core.materialize(basis, result), true);
  assert.equal(core.getSnapshot().undoDepth, 1);
  assert.equal(core.materialize(basis, result), false);
  core.undo();
  assert.equal(core.getSnapshot().source, serializeProject(project));
  core.redo();
  assert.deepEqual(core.getSnapshot().project!.extensions, result.extensions);
  const current = core.getSnapshot().project!;
  core.updateSource('pending');
  assert.equal(core.materialize(current, result), false);
});

test('loaded PCB remains authoritative and simulation participation does not normalize it', () => {
  const { project, schematicId, partId } = fixture(true);
  const sync = new PCBProjectSync(project);
  const core = new ProjectCore(project, { prepare: (next) => sync.prepare(next)?.project ?? next });
  core.execute('part.participation', { schematicId, partId, included: false });
  assert.deepEqual(core.getSnapshot().project!.pcb, project.pcb);
  assert.equal(core.getSnapshot().project!.schematic.parts[0].excludeFromSimulation, true);
  core.undo();
  assert.equal(core.getSnapshot().source, serializeProject(project));
});

test('bounded history, load reset and advertised command/query schemas stay coherent', () => {
  const { project, schematicId } = fixture();
  const core = new ProjectCore(project);
  for (let index = 0; index < 65; index++)
    core.execute('schematic.operations', {
      schematicId,
      operations: [{ type: 'setValue', ref: 'R1', value: `${index + 1}k` }],
    });
  assert.equal(core.getSnapshot().undoDepth, 60);
  for (let index = 0; index < 60; index++) assert.equal(core.undo(), true);
  assert.equal(core.undo(), false);
  assert.equal(core.getSnapshot().redoDepth, 60);
  core.load(project, 'recovered pending Source');
  assert.equal(core.getSnapshot().undoDepth, 0);
  assert.equal(core.getSnapshot().redoDepth, 0);
  assert.equal(core.getSnapshot().sourceDraft, 'recovered pending Source');
  assert.equal(
    new Set(coreCommandDefinitions.map((item) => item.id)).size,
    coreCommandDefinitions.length,
  );
  assert.equal(
    new Set(coreQueryDefinitions.map((item) => item.id)).size,
    coreQueryDefinitions.length,
  );
  assert.ok(
    [...coreCommandDefinitions, ...coreQueryDefinitions].every(
      (item) => item.inputSchema.additionalProperties === false,
    ),
  );
  core.load(null);
  assert.equal(core.getSnapshot().project, null);
  assert.equal(core.query('project.get'), null);
  assert.throws(() => core.execute('schematic.add'), /Open a project/);
});

function layoutFixture() {
  const project = createProject();
  const board = createEmptyPCB();
  board.nets = [
    { id: uid(), name: 'OUT' },
    { id: uid(), name: 'GND' },
  ];
  board.graphics = [
    [
      { x: -20, y: -20 },
      { x: 20, y: -20 },
    ],
    [
      { x: 20, y: -20 },
      { x: 20, y: 20 },
    ],
    [
      { x: 20, y: 20 },
      { x: -20, y: 20 },
    ],
    [
      { x: -20, y: 20 },
      { x: -20, y: -20 },
    ],
  ].map(([start, end]) => ({ id: uid(), start, end, width: 0.05, layer: 'Edge.Cuts' as const }));
  project.pcb = board;
  return { project, boardId: board.id, netId: board.nets[0].id, foreignNetId: board.nets[1].id };
}

test('Layout route planning and commits share full obstacle checks and preserve exact anchors', () => {
  const { project, boardId, netId, foreignNetId } = layoutFixture();
  project.pcb!.tracks.push({
    id: uid(),
    start: { x: 0, y: -3 },
    end: { x: 0, y: 3 },
    width: 1,
    layer: 'F.Cu',
    netId: foreignNetId,
  });
  const core = new ProjectCore(project);
  const basis = core.getSnapshot();
  const input = {
    boardId,
    netId,
    layer: 'F.Cu',
    width: 0.25,
    clearance: 0.25,
    start: { x: -10.123456, y: 0.654321 },
    end: { x: 10.234567, y: 0.654321 },
  };
  const preview = core.query('layout.route.preview', input) as {
    points: { x: number; y: number }[];
    blocked: boolean;
    message: string;
  };
  assert.equal(preview.blocked, false, preview.message);
  assert.ok(preview.points.length > 2);
  assert.equal(core.getSnapshot(), basis, 'Route planning is read-only.');
  assert.deepEqual(preview.points[0], input.start);
  assert.deepEqual(preview.points.at(-1), input.end);
  assert.throws(
    () =>
      core.execute('layout.route', {
        boardId,
        netId,
        width: 0.25,
        clearance: 0.25,
        legs: [{ layer: 'F.Cu', points: [input.start, input.end] }],
      }),
    /Route blocked/,
  );
  assert.equal(core.getSnapshot(), basis, 'Blocked routes do not partially commit.');
  core.execute('layout.route', {
    boardId,
    netId,
    width: 0.25,
    clearance: 0.25,
    legs: [{ layer: 'F.Cu', points: preview.points }],
  });
  assert.equal(core.getSnapshot().undoDepth, 1);
  assert.deepEqual(core.getSnapshot().project!.pcb!.tracks[0], project.pcb!.tracks[0]);
  assert.equal(core.getSnapshot().project!.pcb!.tracks.length, preview.points.length);
  core.undo();
  assert.equal(core.getSnapshot().source, basis.source);
});

test('Layout route queries and commits share concave keepouts and dimension strokes', () => {
  for (const obstacle of ['concave keepout', 'dimension strokes']) {
    const { project, boardId, netId, foreignNetId } = layoutFixture();
    const board = project.pcb!;
    if (obstacle === 'concave keepout') {
      board.zones.push({
        id: uid(),
        netId: foreignNetId,
        layer: 'F.Cu',
        outline: [
          { x: -3, y: -3 },
          { x: 3, y: -3 },
          { x: 3, y: 3 },
          { x: 2, y: 3 },
          { x: 2, y: -2 },
          { x: -2, y: -2 },
          { x: -2, y: 3 },
          { x: -3, y: 3 },
        ],
        clearance: 0.25,
        minThickness: 0.2,
        thermalGap: 0.3,
        thermalBridge: 0.3,
        keepout: { tracks: true, vias: false, pads: false, copperpour: false, footprints: false },
      });
    } else {
      board.graphics.push({
        id: uid(),
        kind: 'dimension',
        layer: 'F.Cu',
        start: { x: 4, y: -2 },
        end: { x: 6, y: -2 },
        width: 0.2,
        dimension: {
          type: 'aligned',
          height: 2,
          format: { prefix: '', suffix: '', units: 0, unitsFormat: 0, precision: 0 },
          style: { arrowLength: 1, textPositionMode: 0, extensionOffset: 0 },
          caption: { x: 5, y: 0, value: '', rotation: 0, size: { x: 1, y: 1 }, thickness: 0.1 },
        },
      });
    }
    const core = new ProjectCore(project);
    const basis = core.getSnapshot();
    const input = {
      boardId,
      netId,
      layer: 'F.Cu',
      width: 0.4,
      clearance: 0.25,
      start: { x: 0, y: 0 },
      end: { x: obstacle === 'concave keepout' ? 5 : 10, y: 0 },
    };
    const preview = core.query('layout.route.preview', input) as {
      points: { x: number; y: number }[];
      blocked: boolean;
      message: string;
    };
    assert.equal(preview.blocked, false, `${obstacle}: ${preview.message}`);
    assert.ok(preview.points.length > 2, `${obstacle} needs a checked detour.`);
    assert.equal(core.getSnapshot(), basis, 'The query does not change Source or undo.');
    const command = { boardId, netId, width: input.width, clearance: input.clearance };
    assert.throws(
      () =>
        core.execute('layout.route', {
          ...command,
          legs: [{ layer: input.layer, points: [input.start, input.end] }],
        }),
      /Route blocked/,
    );
    assert.equal(core.getSnapshot(), basis, 'A collision rejects the complete command.');
    core.execute('layout.route', {
      ...command,
      legs: [{ layer: input.layer, points: preview.points }],
    });
    const committed = core.getSnapshot();
    assert.equal(committed.undoDepth, 1);
    assert.deepEqual(
      committed.project!.pcb!.tracks.map(({ start, end }) => ({ start, end })),
      preview.points.slice(1).map((end, i) => ({ start: preview.points[i], end })),
    );
    assert.deepEqual(committed.project!.pcb!.graphics, board.graphics);
    assert.deepEqual(committed.project!.pcb!.zones, board.zones);
    core.undo();
    assert.equal(core.getSnapshot().source, basis.source);
  }
});

test('Layout diagonal drag slides joints in one undo transaction and rejects collapsed placement', () => {
  const { project, boardId, netId } = layoutFixture();
  const points = [
    { x: -8, y: -4 },
    { x: -4, y: -4 },
    { x: 0, y: 0 },
    { x: 0, y: 4 },
  ];
  project.pcb!.tracks = points.slice(1).map((end, index) => ({
    id: uid(),
    start: points[index],
    end,
    width: 0.4,
    layer: 'F.Cu',
    netId,
  }));
  const core = new ProjectCore(project);
  const basis = core.getSnapshot();
  const args = {
    boardId,
    selection: [{ kind: 'track', id: project.pcb!.tracks[1].id }],
    delta: { x: 1, y: -1 },
    clearance: 0.25,
  };
  core.execute('layout.drag', args);
  const after = core.getSnapshot();
  assert.equal(after.undoDepth, 1);
  assert.deepEqual(after.project!.pcb!.tracks, [
    { ...project.pcb!.tracks[0], end: { x: -2, y: -4 } },
    { ...project.pcb!.tracks[1], start: { x: -2, y: -4 }, end: { x: 0, y: -2 } },
    { ...project.pcb!.tracks[2], start: { x: 0, y: -2 } },
  ]);
  assert.deepEqual(parseProject(after.source).pcb, after.project!.pcb);
  core.undo();
  assert.equal(core.getSnapshot().source, basis.source);
  assert.throws(() => core.execute('layout.drag', { ...args, delta: { x: 2, y: -2 } }), /collapse/);
  assert.equal(core.getSnapshot().source, basis.source);
  assert.equal(core.getSnapshot().undoDepth, 0);
});

test('Layout drag consumes a zero-length simple neighbour in the same complete undo edit', () => {
  const { project, boardId, netId } = layoutFixture();
  const points = [
    { x: 0, y: -4 },
    { x: 4, y: 0 },
    { x: 8, y: 0 },
    { x: 8, y: 8 },
  ];
  project.pcb!.tracks = points.slice(1).map((end, index) => ({
    id: uid(),
    start: points[index],
    end,
    width: 0.4,
    layer: 'F.Cu',
    netId,
  }));
  const original = project.pcb!.tracks,
    core = new ProjectCore(project),
    basis = core.getSnapshot();
  const result = core.execute('layout.drag', {
    boardId,
    selection: [{ kind: 'track', id: original[1].id }],
    delta: { x: 0, y: -4 },
    clearance: 0.25,
  }) as { changedIds: string[] };
  const after = core.getSnapshot();
  assert.equal(after.undoDepth, 1);
  assert.deepEqual(after.project!.pcb!.tracks, [
    { ...original[1], start: { x: 0, y: -4 }, end: { x: 8, y: -4 } },
    { ...original[2], start: { x: 8, y: -4 } },
  ]);
  assert.ok(result.changedIds.includes(original[0].id));
  assert.deepEqual(parseProject(after.source).pcb, after.project!.pcb);
  core.undo();
  assert.equal(core.getSnapshot().source, basis.source);
  core.redo();
  assert.equal(core.getSnapshot().source, after.source);
});

test('Layout shove drag commits displaced neighbours in one whole-project undo and rejects fixed-obstacle placement', () => {
  const { project, boardId, netId, foreignNetId } = layoutFixture();
  const selected = {
    id: uid(),
    start: { x: -3, y: 0 },
    end: { x: 3, y: 0 },
    width: 0.4,
    layer: 'F.Cu' as const,
    netId,
  };
  const neighbour = {
    ...selected,
    id: uid(),
    netId: foreignNetId,
    start: { x: -10, y: 2 },
    end: { x: 10, y: 2 },
  };
  project.pcb!.tracks = [selected, neighbour];
  const core = new ProjectCore(project);
  const basis = core.getSnapshot();
  const args = {
    boardId,
    selection: [{ kind: 'track', id: selected.id }],
    delta: { x: 0, y: 2 },
    clearance: 0.25,
  };
  assert.throws(
    () => core.execute('layout.drag', { ...args, obstacleMode: 'walk-around' }),
    /blocked/i,
  );
  assert.equal(core.getSnapshot(), basis);
  core.execute('layout.drag', { ...args, obstacleMode: 'shove' });
  const after = core.getSnapshot();
  assert.equal(after.undoDepth, 1);
  assert.equal(after.project!.pcb!.tracks[0].start.y, 2);
  assert.notDeepEqual(after.project!.pcb!.tracks[1], neighbour);
  assert.deepEqual(
    after.project!.pcb!.tracks.slice(0, 2).map((item) => item.id),
    [selected.id, neighbour.id],
  );
  core.undo();
  assert.equal(core.getSnapshot().source, basis.source);
  assert.throws(() => core.execute('layout.drag', { ...args, delta: { x: 0, y: 20 } }), /blocked/i);
  assert.equal(core.getSnapshot().source, basis.source);
  assert.equal(core.getSnapshot().undoDepth, 0);
});

test('Layout route through-via transitions commit all layers in one edit and reject blocked holes atomically', () => {
  const { project, boardId, netId } = layoutFixture();
  const core = new ProjectCore(project);
  const route = {
    boardId,
    netId,
    width: 0.25,
    clearance: 0.25,
    legs: [
      {
        layer: 'F.Cu',
        points: [
          { x: -10, y: 0 },
          { x: 0, y: 0 },
        ],
        via: { diameter: 0.8, drill: 0.4 },
      },
      {
        layer: 'B.Cu',
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
      },
    ],
  };
  core.execute('layout.route', route);
  assert.equal(core.getSnapshot().undoDepth, 1);
  assert.equal(core.getSnapshot().project!.pcb!.tracks.length, 2);
  assert.equal(core.getSnapshot().project!.pcb!.vias.length, 1);
  assert.equal(core.getSnapshot().project!.pcb!.tracks[1].layer, 'B.Cu');
  const basis = core.getSnapshot();
  assert.throws(() => core.execute('layout.route', route), /hole|Via|via/);
  assert.equal(core.getSnapshot(), basis);
  core.undo();
  assert.equal(core.getSnapshot().source, serializeProject(project));
  assert.throws(
    () =>
      core.execute('layout.route', {
        ...route,
        legs: [
          {
            layer: 'F.Cu',
            points: [
              { x: 0, y: 0 },
              { x: 1, y: 0 },
            ],
            via: { diameter: 0.8, drill: 0.4 },
          },
        ],
      }),
    /unfinished layer transition/,
  );
  assert.equal(core.getSnapshot().undoDepth, 0);
});

test('Layout selection commands preserve identities, assign fresh copies, clear linked packages and reject stale IDs', () => {
  const { project, boardId, netId } = layoutFixture();
  const track = {
    id: uid(),
    start: { x: -5, y: 0 },
    end: { x: 5, y: 0 },
    width: 0.25,
    layer: 'F.Cu' as const,
    netId,
  };
  project.pcb!.tracks.push(track);
  const core = new ProjectCore(project);
  const selection = [{ kind: 'track', id: track.id }];
  core.execute('layout.move', { boardId, selection, delta: { x: 0, y: 1 } });
  assert.equal(core.getSnapshot().project!.pcb!.tracks[0].id, track.id);
  assert.equal(core.getSnapshot().project!.pcb!.tracks[0].start.y, 1);
  core.execute('layout.rotate', { boardId, selection, degrees: 45, pivot: { x: 0, y: 1 } });
  assert.equal(core.getSnapshot().undoDepth, 2);
  core.execute('layout.duplicate', { boardId, selection, delta: { x: 0, y: 5 } });
  assert.equal(core.getSnapshot().project!.pcb!.tracks.length, 2);
  assert.notEqual(core.getSnapshot().project!.pcb!.tracks[1].id, track.id);
  const before = core.getSnapshot();
  assert.throws(
    () => core.execute('layout.delete', { boardId, selection: [{ kind: 'track', id: uid() }] }),
    /no longer exists/,
  );
  assert.equal(core.getSnapshot(), before);
  assert.throws(
    () => core.execute('layout.delete', { boardId: uid(), selection }),
    /board is no longer/,
  );
  core.execute('layout.delete', { boardId, selection });
  assert.equal(core.getSnapshot().project!.pcb!.tracks.length, 1);
  const linked = fixture(true);
  const linkedCore = new ProjectCore(linked.project);
  const linkedSelection = [{ kind: 'footprint', id: linked.project.pcb!.footprints[0].id }];
  assert.throws(
    () =>
      linkedCore.execute('layout.duplicate', {
        boardId: linked.project.pcb!.id,
        selection: linkedSelection,
        delta: { x: 10, y: 10 },
      }),
    /Assigned physical packages/,
  );
  linkedCore.execute('layout.flip', {
    boardId: linked.project.pcb!.id,
    selection: linkedSelection,
  });
  assert.equal(linkedCore.getSnapshot().project!.pcb!.footprints[0].side, 'back');
  linkedCore.execute('layout.delete', {
    boardId: linked.project.pcb!.id,
    selection: linkedSelection,
  });
  assert.equal(linkedCore.getSnapshot().project!.schematic.parts[0].fields!.Footprint, '');
  assert.deepEqual(linkedCore.getSnapshot().project!.pcb!.tracks, linked.project.pcb!.tracks);
});

test('Layout zone filling is a complete undo edit and copper edits invalidate saved fills in that same edit', () => {
  const { project, boardId, netId } = layoutFixture();
  const core = new ProjectCore(project);
  const result = core.execute('layout.zone', {
    boardId,
    netId,
    layer: 'F.Cu',
    outline: [
      { x: -15, y: -15 },
      { x: 15, y: -15 },
      { x: 15, y: 15 },
      { x: -15, y: 15 },
    ],
  }) as { zoneId: string };
  assert.equal(core.getSnapshot().project!.pcb!.zones[0].id, result.zoneId);
  core.execute('layout.fill', { boardId });
  assert.equal(core.getSnapshot().undoDepth, 2);
  assert.ok(core.getSnapshot().project!.pcb!.zones[0].filledPolygons!.length > 0);
  const filled = core.getSnapshot().source;
  core.execute('layout.via', {
    boardId,
    netId,
    position: { x: 1, y: 1 },
    diameter: 0.8,
    drill: 0.4,
    clearance: 0.25,
  });
  assert.equal(core.getSnapshot().undoDepth, 3);
  assert.equal(core.getSnapshot().project!.pcb!.zones[0].filledPolygons, undefined);
  core.undo();
  assert.equal(core.getSnapshot().source, filled);
  const snapshot = core.query('layout.get', { boardId }) as {
    boardId: string;
    project: object;
    counts: { zones: number };
  };
  assert.equal(snapshot.boardId, boardId);
  assert.equal(snapshot.counts.zones, 1);
  assert.equal(serializeProject(parseProject(JSON.stringify(snapshot.project))), filled);
  core.updateSource('pending');
  assert.throws(() => core.execute('layout.fill', { boardId }), /Apply the Source/);
});

test('Layout fill commits effective clearance and contours together, with undo and Source guards', () => {
  const { project, boardId, netId } = layoutFixture();
  project.pcb!.zones = [
    {
      id: uid(),
      netId,
      layer: 'F.Cu',
      outline: [
        { x: -10, y: -10 },
        { x: 10, y: -10 },
        { x: 10, y: 10 },
        { x: -10, y: 10 },
      ],
      clearance: 0,
      minThickness: 0.1,
      thermalGap: 0.3,
      thermalBridge: 0.3,
    },
  ];
  const core = new ProjectCore(project);
  const before = core.getSnapshot().source;
  for (const clearance of [0, -1, 1001, NaN]) {
    assert.throws(() => core.execute('layout.fill', { boardId, clearance }));
    assert.equal(core.getSnapshot().source, before);
  }
  core.execute('layout.fill', { boardId, clearance: 0.6 });
  const filled = core.getSnapshot();
  assert.equal(filled.undoDepth, 1);
  assert.equal(filled.project!.pcb!.zones[0].clearance, 0.6);
  assert.ok(filled.project!.pcb!.zones[0].filledPolygons!.length > 0);
  core.undo();
  assert.equal(core.getSnapshot().source, before);
  core.redo();
  assert.equal(core.getSnapshot().source, filled.source);
  core.updateSource('pending');
  assert.throws(() => core.execute('layout.fill', { boardId, clearance: 0.8 }), /Apply the Source/);
  assert.equal(core.getSnapshot().source, filled.source);
});

test('drawing an inactive zone through Core or renderer retains existing native pours through undo and reopening', () => {
  for (const origin of ['command', 'renderer']) {
    const { project, boardId, netId } = layoutFixture();
    const core = new ProjectCore(project);
    const { zoneId: existingId } = core.execute('layout.zone', {
      boardId,
      netId,
      layer: 'F.Cu',
      outline: [
        { x: -15, y: -15 },
        { x: 15, y: -15 },
        { x: 15, y: 15 },
        { x: -15, y: 15 },
      ],
    }) as { zoneId: string };
    core.execute('layout.fill', { boardId, zoneId: existingId });
    const before = core.getSnapshot();
    const saved = before.project!.pcb!.zones.find((zone) => zone.id === existingId)!;
    assert.ok(saved.filledPolygons!.length);
    const outline = [
      { x: -5, y: -5 },
      { x: 5, y: -5 },
      { x: 5, y: 5 },
      { x: -5, y: 5 },
    ];
    if (origin === 'command')
      core.execute('layout.zone', {
        boardId,
        netId: null,
        layer: 'F.Cu',
        outline,
        fillEnabled: false,
      });
    else {
      const inactive = { ...saved, id: uid(), netId: null, outline, fillEnabled: false };
      delete inactive.filledPolygons;
      core.replaceBoard({
        ...before.project!.pcb!,
        zones: [...before.project!.pcb!.zones, inactive],
      });
    }
    const after = core.getSnapshot();
    assert.equal(after.undoDepth, before.undoDepth + 1);
    assert.deepEqual(
      after.project!.pcb!.zones.find((zone) => zone.id === existingId),
      saved,
    );
    const reopened = projectFromNativeFiles(core.getNativeFiles());
    assert.deepEqual(
      reopened.pcb!.zones.find((zone) => zone.id === existingId)!.filledPolygons,
      saved.filledPolygons,
    );
    const inactive = reopened.pcb!.zones.find((zone) => zone.id !== existingId)!;
    assert.equal(inactive.fillEnabled, false);
    assert.equal(inactive.netId, null);
    core.undo();
    assert.equal(core.getSnapshot().source, before.source);
    core.redo();
    assert.equal(core.getSnapshot().source, after.source);
  }
});

test('selected zone fill is one native, undoable transaction behind Source barriers', () => {
  const { project, boardId, netId } = layoutFixture();
  const zoneId = uid();
  project.pcb!.zones = [
    {
      id: zoneId,
      netId,
      layer: 'F.Cu',
      outline: [
        { x: -10, y: -10 },
        { x: 10, y: -10 },
        { x: 10, y: 10 },
        { x: -10, y: 10 },
      ],
      clearance: 0.4,
      minThickness: 0.1,
      thermalGap: 0.3,
      thermalBridge: 0.3,
      fillEnabled: false,
    },
  ];
  const core = new ProjectCore(project);
  const before = core.getSnapshot().source;
  assert.throws(
    () => core.execute('layout.fill', { boardId, zoneId: uid() }),
    /existing board copper zone/,
  );
  core.execute('layout.fill', { boardId, zoneId });
  const filled = core.getSnapshot();
  assert.equal(filled.undoDepth, 1);
  assert.equal(filled.project!.pcb!.zones[0].fillEnabled, true);
  assert.equal(filled.project!.pcb!.zones[0].clearance, 0.4);
  assert.ok(filled.project!.pcb!.zones[0].filledPolygons!.length);
  const reopened = projectFromNativeFiles(core.getNativeFiles());
  const zoneNames = (board: NonNullable<typeof project.pcb>) =>
    board.zones.map(({ netId, ...zone }) => ({
      ...zone,
      net: board.nets.find((net) => net.id === netId)?.name ?? null,
    }));
  assert.deepEqual(zoneNames(reopened.pcb!), zoneNames(filled.project!.pcb!));
  core.undo();
  assert.equal(core.getSnapshot().source, before);
  core.redo();
  assert.equal(core.getSnapshot().source, filled.source);
  core.updateSource('pending');
  assert.throws(() => core.execute('layout.fill', { boardId, zoneId }), /Apply the Source/);
  assert.equal(core.getSnapshot().source, filled.source);
});

test('Source equal to validated JSON never blocks editing, and property rotation retains arbitrary valid angles', () => {
  const { project, schematicId, partId } = fixture();
  const source = serializeProject(project);
  const core = new ProjectCore(project, { draft: source });
  assert.equal(core.getSnapshot().sourceDraft, null);
  core.updateSource(source);
  assert.equal(core.getSnapshot().sourceDraft, null);
  core.execute('part.properties', {
    schematicId,
    partId,
    rotation: 37.5,
    fields: [{ name: '', value: '', fresh: true }],
  });
  assert.equal(core.getSnapshot().project!.schematic.parts[0].rotation, 37.5);
  assert.equal(core.getSnapshot().undoDepth, 1);
  core.load(project, source);
  assert.equal(core.getSnapshot().sourceDraft, null);
});

test('an asynchronous close lifecycle barrier rejects every write until a failed close resumes editing', async () => {
  const { project, schematicId } = fixture(true);
  const core = new ProjectCore(project);
  core.execute('schematic.operations', {
    schematicId,
    operations: [{ type: 'setValue', ref: 'R1', value: '22k' }],
  });
  const beforeClose = core.getSnapshot();
  let finishClose!: (success: boolean) => void;
  const persistAndRelease = new Promise<boolean>((resolve) => {
    finishClose = resolve;
  });
  const events: string[] = [];
  core.subscribe((event) => events.push(event.type));
  const closing = (async () => {
    core.setEditingBlocked('This project is closing. Wait for closing to finish.');
    const savedSnapshot = core.getSnapshot().source;
    const success = await persistAndRelease;
    if (!success) core.setEditingBlocked(null);
    return savedSnapshot;
  })();
  const blocked = core.getSnapshot();
  assert.equal(blocked.canUndo, false);
  assert.equal(blocked.undoDepth, beforeClose.undoDepth);
  assert.equal(blocked.source, beforeClose.source);
  assert.match(blocked.editingBlocked!, /project is closing/);
  assert.equal(
    (core.query('core.state') as { editingBlocked: string }).editingBlocked,
    blocked.editingBlocked,
  );
  assert.equal(
    core.query('project.source'),
    beforeClose.source,
    'Queries stay usable during close.',
  );
  for (const definition of coreCommandDefinitions)
    assert.throws(() => core.execute(definition.id, {}), /project is closing/, definition.id);
  for (const edit of [
    () => core.commitProject(project),
    () => core.replaceSchematic(project.schematic),
    () => core.replaceBoard(project.pcb!),
    () => core.updateSource('pending draft'),
    () => core.discardSource(),
    () => core.applySource(),
    () => core.undo(),
    () => core.redo(),
    () => core.load(project),
    () => core.load(null),
  ])
    assert.throws(edit, /project is closing/);
  const materialized = structuredClone(blocked.project!);
  materialized.extensions['example.org'] = { shouldNotPersist: true };
  assert.equal(core.materialize(blocked.project!, materialized), false);
  assert.equal(core.getSnapshot(), blocked, 'Rejected writes do not change even runtime state.');
  finishClose(false);
  assert.equal(await closing, beforeClose.source);
  assert.equal(core.getSnapshot().editingBlocked, null);
  assert.equal(core.getSnapshot().canUndo, true);
  assert.equal(core.getSnapshot().undoDepth, 1);
  assert.deepEqual(events, ['core.availability', 'core.availability']);
  core.execute('schematic.operations', {
    schematicId,
    operations: [{ type: 'setValue', ref: 'R1', value: '33k' }],
  });
  assert.equal(core.getSnapshot().project!.schematic.parts[0].value, '33k');
  core.undo();
  assert.equal(core.getSnapshot().source, beforeClose.source);
});

test('a close barrier retains a pending invalid Source draft and resumes it without an undo edit', () => {
  const { project } = fixture();
  const core = new ProjectCore(project, { draft: '{ invalid' });
  assert.equal(core.applySource(), null);
  const sourceError = core.getSnapshot().sourceError;
  core.setEditingBlocked('This project is closing.');
  assert.throws(() => core.applySource(), /project is closing/);
  assert.throws(() => core.updateSource(core.getSnapshot().source), /project is closing/);
  assert.equal(core.getSnapshot().sourceDraft, '{ invalid');
  assert.equal(core.getSnapshot().sourceError, sourceError);
  core.setEditingBlocked(null);
  assert.equal(core.getSnapshot().sourceDraft, '{ invalid');
  assert.equal(core.getSnapshot().sourceError, sourceError);
  assert.equal(core.getSnapshot().undoDepth, 0);
  core.discardSource();
  assert.equal(core.getSnapshot().sourceDraft, null);
  assert.equal(core.getSnapshot().sourceError, '');
  assert.equal(core.getSnapshot().source, serializeProject(project));
});
