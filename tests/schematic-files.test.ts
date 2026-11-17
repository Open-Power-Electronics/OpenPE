import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendSchematic,
  createProject,
  exportKiCad,
  findSchematic,
  MAX_SCHEMATIC_FILES,
  parseProject,
  projectSchematics,
  replaceSchematic,
  removeSchematic,
  schematicSnapshot,
  schematicFileFingerprint,
  serializeProject,
} from '../lib/project';
import { emptyCircuit, parseCircuit } from '../lib/circuit';
import { applyProposal } from '../lib/proposals';
import { exampleProject } from '../lib/project-example';
import { defaultAgentPreferences, restoreWorkspace } from '../lib/workspace-state';
import { createSession } from '../lib/chat-sessions';
import { ownProject } from '../lib/immutable-project';

test('deleting a file preserves siblings, board, metadata and an undoable original snapshot', () => {
  const added = appendSchematic(exampleProject());
  added.project.extensions['test.delete'] = { keep: true };
  const original = serializeProject(added.project);
  const removed = removeSchematic(added.project, added.schematic.id);
  assert.equal(projectSchematics(removed).length, 1);
  assert.equal(removed.schematic, added.project.schematic);
  assert.deepEqual(removed.pcb, added.project.pcb);
  assert.deepEqual(removed.extensions, added.project.extensions);
  assert.equal(serializeProject(added.project), original);
  assert.equal(projectSchematics(parseProject(original)).length, 2);
  assert.equal(
    serializeProject(parseProject(serializeProject(removed))),
    serializeProject(removed),
  );
  assert.throws(
    () => removeSchematic(added.project, added.project.schematic.id),
    /associated.*PCB/,
  );
  assert.throws(() => removeSchematic(added.project, crypto.randomUUID()), /no longer/);
});

test('deleting the primary file promotes its neighbour; deleting the last file creates a valid blank', () => {
  const initial = createProject();
  const added = appendSchematic(initial);
  const removed = removeSchematic(added.project, initial.schematic.id);
  assert.equal(removed.schematic.id, added.schematic.id);
  assert.equal(removed.id, initial.id);
  assert.equal(removed.name, initial.name ?? initial.schematic.title);
  const blank = removeSchematic(removed, removed.schematic.id);
  assert.notEqual(blank.schematic.id, removed.schematic.id);
  assert.equal(blank.schematic.title, 'Schematic 1');
  assert.equal(blank.schematic.parts.length, 0);
  assert.deepEqual(blank.schematic.libraries, {});
  assert.equal(blank.id, initial.id);
  assert.equal(blank.additionalSchematics, undefined);
  assert.doesNotThrow(() => parseProject(serializeProject(blank)));
});

test('adding files keeps the project identity, primary circuit, PCB and metadata', () => {
  const original = exampleProject();
  original.extensions['test.files'] = { note: 'Keep me' };
  const before = serializeProject(original);
  const added = appendSchematic(original);
  assert.equal(added.project.id, original.id);
  assert.equal(added.project.schematic, original.schematic);
  assert.equal(added.project.pcb, original.pcb);
  assert.equal(added.project.extensions, original.extensions);
  assert.equal(serializeProject(original), before);
  assert.equal(added.schematic.title, 'Schematic 2');
  assert.deepEqual(added.schematic.libraries, {});
  assert.equal(added.schematic.parts.length, 0);
  assert.notEqual(added.schematic.id, original.schematic.id);
  const third = appendSchematic(added.project);
  assert.equal(third.schematic.title, 'Schematic 3');
  assert.equal(new Set(projectSchematics(third.project).map((file) => file.id)).size, 3);
  const source = serializeProject(third.project);
  assert.equal(serializeProject(parseProject(source)), source);
  assert.deepEqual(parseProject(source).pcb, original.pcb);
});

test('edits and native exports target the selected file, with independent references and libraries', () => {
  const original = exampleProject();
  const added = appendSchematic(original);
  const changed = applyProposal(added.schematic, [
    { type: 'addPart', kind: 'R', x: 12.7, y: 25.4, value: '22k' },
  ]);
  const edited = replaceSchematic(added.project, changed);
  assert.equal(edited.schematic, original.schematic);
  assert.equal(changed.parts[0].ref, 'R1');
  assert.equal(edited.pcb, original.pcb);
  const source = serializeProject(edited);
  const restored = parseProject(source);
  assert.equal(serializeProject(restored), source);
  assert.equal(findSchematic(restored, changed.id)?.parts[0].value, '22k');
  const exported = parseCircuit(exportKiCad(restored, 'schematic', changed.id));
  assert.equal(exported.id, changed.id);
  assert.equal(exported.parts.length, 1);
  assert.equal(exported.parts[0].value, '22k');
  assert.equal(parseCircuit(exportKiCad(restored, 'schematic')).id, original.schematic.id);
  assert.equal(exportKiCad(restored, 'pcb'), exportKiCad(original, 'pcb'));
  assert.throws(() => exportKiCad(restored, 'schematic', crypto.randomUUID()), /no longer/);
  assert.throws(() => replaceSchematic(restored, emptyCircuit()), /no longer/);
});

test('simulation snapshots isolate the selected circuit and keep the board with its primary file', () => {
  const original = exampleProject();
  const added = appendSchematic(original);
  const selected = schematicSnapshot(added.project, added.schematic.id);
  assert.equal(selected.schematic.id, added.schematic.id);
  assert.equal(selected.pcb, null);
  assert.equal(selected.additionalSchematics, undefined);
  assert.equal(schematicSnapshot(added.project, original.schematic.id).pcb, original.pcb);
  assert.doesNotThrow(() => serializeProject(selected));
  assert.equal(added.project.additionalSchematics?.length, 1);
});

test('all files are validated before serialization, including global UUID uniqueness', () => {
  const added = appendSchematic(exampleProject());
  const duplicate = structuredClone(added.project);
  duplicate.additionalSchematics![0].id = duplicate.schematic.id;
  assert.throws(() => serializeProject(duplicate), /duplicate UUID/);
  const broken = structuredClone(added.project);
  broken.additionalSchematics![0] = applyProposal(broken.additionalSchematics![0], [
    { type: 'addPart', kind: 'C', x: 0, y: 0 },
  ]);
  broken.additionalSchematics![0].libraries = {};
  assert.throws(() => serializeProject(broken), /missing embedded symbol/);
  const invalid = structuredClone(added.project);
  Object.assign(invalid.additionalSchematics![0], { unknown: true });
  assert.throws(() => serializeProject(invalid), /Invalid OpenPE/);
});

test('file limits reject an extra file without mutating the project', () => {
  let project = createProject();
  for (let i = 1; i < MAX_SCHEMATIC_FILES; i++) project = appendSchematic(project).project;
  const source = serializeProject(project);
  assert.throws(() => appendSchematic(project), /12 schematic files/);
  assert.equal(serializeProject(project), source);
});

test('file dirty baselines compare canonical file data independently of project names and native materialization', () => {
  const added = appendSchematic(exampleProject());
  const source = serializeProject(added.project);
  const saved = parseProject(source);
  for (const file of projectSchematics(added.project))
    assert.equal(
      schematicFileFingerprint(added.project, file.id),
      schematicFileFingerprint(saved, file.id),
    );
  const renamed = { ...saved, name: 'Renamed folder' };
  assert.equal(
    schematicFileFingerprint(renamed, added.schematic.id),
    schematicFileFingerprint(saved, added.schematic.id),
  );
  const edited = replaceSchematic(saved, {
    ...findSchematic(saved, added.schematic.id)!,
    title: 'Renamed file',
  });
  assert.notEqual(
    schematicFileFingerprint(edited, added.schematic.id),
    schematicFileFingerprint(saved, added.schematic.id),
  );
  assert.equal(
    schematicFileFingerprint(edited, saved.schematic.id),
    schematicFileFingerprint(saved, saved.schematic.id),
  );
});

test('owned file fingerprints follow shared sheets while caller freezing cannot hide sheet edits', () => {
  const mutable = appendSchematic(exampleProject()).project;
  Object.freeze(mutable);
  const original = schematicFileFingerprint(mutable, mutable.schematic.id);
  mutable.schematic.title = 'Changed mutable file';
  assert.notEqual(schematicFileFingerprint(mutable, mutable.schematic.id), original);

  const owned = ownProject(mutable);
  const fingerprint = schematicFileFingerprint(owned, owned.schematic.id);
  const secondary = owned.additionalSchematics![0];
  const secondaryFingerprint = schematicFileFingerprint(owned, secondary.id);
  const switched = ownProject(
    {
      ...owned,
      name: 'Different project context',
      schematic: secondary,
      additionalSchematics: [owned.schematic],
      pcb: null,
      extensions: { 'test.fingerprint': { ignored: true } },
    },
    owned,
  );
  assert.equal(switched.additionalSchematics![0], owned.schematic);
  assert.equal(schematicFileFingerprint(switched, owned.schematic.id), fingerprint);
  assert.equal(schematicFileFingerprint(switched, secondary.id), secondaryFingerprint);

  const draft = structuredClone(owned);
  draft.schematic.parts[0].value = '47k';
  const changed = ownProject(draft, owned);
  assert.notEqual(schematicFileFingerprint(changed, changed.schematic.id), fingerprint);
  assert.equal(schematicFileFingerprint(changed, secondary.id), secondaryFingerprint);
  assert.equal(schematicFileFingerprint(owned, owned.schematic.id), fingerprint);
});

test('recovery retains active file and pending project Source while rejecting missing selections', () => {
  const added = appendSchematic(exampleProject());
  const session = createSession();
  const document = {
    id: crypto.randomUUID(),
    source: serializeProject(added.project),
    sourceDraft: '{unfinished',
    dirty: true,
    filename: 'files.kicad_pro',
    sessions: [session],
    activeSessionId: session.id,
    activeSchematicId: added.schematic.id,
  };
  const state = {
    version: 2,
    documents: [document],
    activeDocumentId: document.id,
    ...defaultAgentPreferences,
  };
  const recovered = restoreWorkspace(state);
  assert.deepEqual(recovered, state);
  assert.equal(projectSchematics(parseProject(recovered.documents[0].source)).length, 2);
  assert.throws(
    () =>
      restoreWorkspace({
        ...state,
        documents: [{ ...document, activeSchematicId: crypto.randomUUID() }],
      }),
    /active schematic/,
  );
  const { activeSchematicId: _selection, ...withoutSelection } = document;
  assert.equal(
    restoreWorkspace({ ...state, documents: [withoutSelection] }).documents[0].activeSchematicId,
    undefined,
    'The current optional selection remains unset rather than being reconstructed.',
  );
});
