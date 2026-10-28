import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exampleProject } from '../lib/project-example';
import { createHomeExample } from '../lib/create-home-example';
import { ProjectCore } from '../core/project-core';
import {
  deletePCBSelection,
  movePCBSelection,
  rotatePCBSelection,
  setPCBTrackProperties,
} from '../lib/pcb-layout';
import { exportKiCad, parseProject, serializeProject, validateProject } from '../lib/project';
import {
  projectFromNativeFiles,
  projectNativeFiles,
  validateNativeSourceFiles,
  type KiCadProjectFiles,
} from '../lib/kicad-project';
import { ownProject } from '../lib/immutable-project';
import { invalidatePCBFill, serializePCB } from '../lib/pcb';
import { child, children, parseSExpr, val, writeSExpr, type SExpr } from '../lib/sexpr';

function fixture(lock?: 'bare' | SExpr): KiCadProjectFiles {
  const project = exampleProject();
  const root = parseSExpr(exportKiCad(project, 'pcb'));
  if (lock) children(root, 'segment')[0].push(lock === 'bare' ? 'locked' : lock);
  return {
    entry: 'Locked.kicad_pro',
    files: [
      { name: 'Locked.kicad_pro', source: '{}\n' },
      { name: 'Locked.kicad_sch', source: exportKiCad(project, 'schematic') },
      { name: 'Locked.kicad_pcb', source: writeSExpr(root) + '\r\n' },
    ],
  };
}

function boardSource(files: KiCadProjectFiles) {
  return files.files.find((file) => file.name.endsWith('.kicad_pcb'))!.source;
}

for (const [name, lock, expected] of [
  ['legacy bare lock', 'bare', true],
  ['explicit lock', ['locked', 'yes'], true],
  ['explicit unlocked default', ['locked', 'no'], undefined],
  ['omitted unlocked default', undefined, undefined],
] as const) {
  test(`${name} survives native, private snapshot and unrelated board edits`, () => {
    const files = fixture(lock as 'bare' | SExpr | undefined);
    const project = projectFromNativeFiles(files);
    assert.equal(project.pcb!.tracks[0].locked, expected);
    assert.equal(Object.hasOwn(project.pcb!.tracks[1], 'locked'), false);
    assert.deepEqual(projectNativeFiles(project), files, 'Unchanged native bytes remain exact.');

    const recovered = parseProject(serializeProject(project));
    assert.equal(recovered.pcb!.tracks[0].locked, expected);
    assert.deepEqual(projectNativeFiles(recovered), files);

    const edited = {
      ...recovered,
      pcb: { ...recovered.pcb!, thickness: recovered.pcb!.thickness + 0.1 },
    };
    const saved = projectNativeFiles(edited);
    const segment = children(parseSExpr(boardSource(saved)), 'segment')[0];
    if (lock === 'bare') {
      assert.equal(segment.filter((item) => item === 'locked').length, 1);
      assert.equal(
        children(segment, 'locked').length,
        0,
        'Never duplicate the retained bare flag.',
      );
    } else if (lock) {
      assert.deepEqual(child(segment, 'locked'), lock, 'Retain the original native lock syntax.');
      assert.equal(segment.includes('locked'), false);
    } else {
      assert.equal(child(segment, 'locked'), undefined);
      assert.equal(segment.includes('locked'), false);
    }
    assert.equal(projectFromNativeFiles(saved).pcb!.tracks[0].locked, expected);
  });
}

test('new canonical locks serialize explicitly without changing unlocked segment bytes', () => {
  const project = exampleProject();
  const before = serializePCB(project.pcb!, project.schematic);
  const board = {
    ...project.pcb!,
    tracks: project.pcb!.tracks.map((track, index) =>
      index === 0 ? { ...track, locked: true as const } : track,
    ),
  };
  const after = serializePCB(board, project.schematic);
  assert.equal(after.replace(' (locked yes)', ''), before);
  assert.equal(children(parseSExpr(after), 'segment')[1].includes('locked'), false);
  assert.equal(val(child(children(parseSExpr(after), 'segment')[0], 'locked')), 'yes');
  assert.deepEqual(parseProject(serializeProject({ ...project, pcb: board })).pcb, board);
});

test('retained native defaults cannot override the canonical track lock state', () => {
  const unlocked = projectFromNativeFiles(fixture(['locked', 'no']));
  const locked = {
    ...unlocked,
    pcb: {
      ...unlocked.pcb!,
      tracks: unlocked.pcb!.tracks.map((track, index) =>
        index === 0 ? { ...track, locked: true as const } : track,
      ),
    },
  };
  const saved = projectNativeFiles(locked);
  const segment = children(parseSExpr(boardSource(saved)), 'segment')[0];
  assert.deepEqual(child(segment, 'locked'), ['locked', 'yes']);
  assert.equal(projectFromNativeFiles(saved).pcb!.tracks[0].locked, true);

  const nativeLocked = projectFromNativeFiles(fixture('bare'));
  const { locked: _locked, ...track } = nativeLocked.pcb!.tracks[0];
  const canonicalUnlocked = {
    ...nativeLocked,
    pcb: { ...nativeLocked.pcb!, tracks: [track, ...nativeLocked.pcb!.tracks.slice(1)] },
  };
  const unlockedFiles = projectNativeFiles(canonicalUnlocked);
  assert.equal(projectFromNativeFiles(unlockedFiles).pcb!.tracks[0].locked, undefined);
  const unlockedSegment = children(parseSExpr(boardSource(unlockedFiles)), 'segment')[0];
  assert.equal(unlockedSegment.includes('locked'), false);
  assert.equal(child(unlockedSegment, 'locked'), undefined);
});

test('track lock metadata alone retains saved copper fills', () => {
  const project = exampleProject();
  const board = project.pcb!;
  board.zones[0].filledPolygons = [{ points: board.zones[0].outline }];
  const next = {
    ...board,
    tracks: board.tracks.map((track, index) =>
      index === 0 ? { ...track, locked: true as const } : track,
    ),
  };
  assert.equal(invalidatePCBFill(board, next), next);
  assert.equal(next.zones[0].filledPolygons, board.zones[0].filledPolygons);
});

test('EMC Home copies expose every retained native track lock in canonical state', () => {
  const project = createHomeExample('emc-flyback-demo');
  const canonical = project
    .pcb!.tracks.filter((track) => track.locked)
    .map((track) => track.id)
    .sort();
  const native = children(parseSExpr(boardSource(projectNativeFiles(project))), 'segment')
    .filter((segment) => segment.includes('locked') || val(child(segment, 'locked')) === 'yes')
    .map((segment) => val(child(segment, 'uuid')))
    .sort();
  assert.equal(canonical.length, 124);
  assert.deepEqual(canonical, native);
});

test('canonical lock schemas accept only true or an omitted field', () => {
  const project = exampleProject();
  for (const value of [false, 'yes', 1, null]) {
    const malformed = structuredClone(project);
    (malformed.pcb!.tracks[0] as unknown as Record<string, unknown>).locked = value;
    assert.throws(() => validateProject(malformed), /locked|schema|match|const/i);
  }
});

test('locked selections reject whole move, rotation and deletion without touching unlocked neighbours', () => {
  const board = projectFromNativeFiles(fixture('bare')).pcb!;
  const original = structuredClone(board);
  const selection = board.tracks.map((track) => ({ kind: 'track' as const, id: track.id }));
  for (const edit of [
    () => movePCBSelection(board, selection, { x: 1, y: 2 }),
    () => rotatePCBSelection(board, selection, 90),
    () => deletePCBSelection(board, selection),
  ]) {
    assert.throws(edit, /Unlock selected tracks/);
    assert.deepEqual(board, original);
  }
  assert.equal(movePCBSelection(board, selection, { x: 0, y: 0 }), board);
  assert.equal(rotatePCBSelection(board, selection, 360), board);
});

test('track properties require explicit unlocking and retain canonical optional lock representation', () => {
  const board = projectFromNativeFiles(fixture('bare')).pcb!;
  const track = board.tracks[0];
  assert.equal(setPCBTrackProperties(board, track.id, { locked: true }), board);
  assert.equal(setPCBTrackProperties(board, track.id, { width: track.width }), board);
  for (const changes of [{ width: track.width + 0.1 }, { layer: 'B.Cu' as const }])
    assert.throws(() => setPCBTrackProperties(board, track.id, changes), /Unlock the track/);
  assert.throws(() => setPCBTrackProperties(board, track.id, { locked: false, width: 0 }), /width/);
  assert.equal(board.tracks[0].locked, true, 'Rejected property changes do not unlock the input.');
  const unlocked = setPCBTrackProperties(board, track.id, { locked: false });
  assert.equal(Object.hasOwn(unlocked.tracks[0], 'locked'), false);
  assert.equal(unlocked.tracks[1], board.tracks[1]);
  const widened = setPCBTrackProperties(unlocked, track.id, { width: track.width + 0.1 });
  assert.equal(widened.tracks[0].width, track.width + 0.1);
  assert.equal(setPCBTrackProperties(widened, track.id, { locked: true }).tracks[0].locked, true);
});

test('Core rejects locked mixed edits atomically and lock changes have whole-project undo and native fidelity', () => {
  const project = projectFromNativeFiles(fixture('bare'));
  project.pcb!.zones[0].filledPolygons = [{ points: project.pcb!.zones[0].outline }];
  const core = new ProjectCore(project);
  const boardId = project.pcb!.id;
  const trackId = project.pcb!.tracks[0].id;
  const selection = project.pcb!.tracks.map((track) => ({ kind: 'track', id: track.id }));
  const original = core.getSnapshot();
  for (const [command, args] of [
    ['layout.move', { selection, delta: { x: 1, y: 0 } }],
    ['layout.rotate', { selection, degrees: 90 }],
    ['layout.delete', { selection }],
    ['layout.track.properties', { trackId, width: project.pcb!.tracks[0].width + 0.1 }],
    ['layout.track.properties', { trackId, locked: 'yes' }],
  ] as const) {
    assert.throws(() => core.execute(command, { boardId, ...args }));
    assert.equal(
      core.getSnapshot(),
      original,
      `${command} cannot create an undo entry or partial edit.`,
    );
  }
  core.execute('layout.track.properties', { boardId, trackId, locked: false });
  const unlocked = core.getSnapshot();
  assert.equal(unlocked.undoDepth, 1);
  assert.equal(Object.hasOwn(unlocked.project!.pcb!.tracks[0], 'locked'), false);
  assert.deepEqual(unlocked.project!.pcb!.zones, original.project!.pcb!.zones);
  const saved = projectNativeFiles(unlocked.project!);
  assert.equal(projectFromNativeFiles(saved).pcb!.tracks[0].locked, undefined);
  assert.equal(parseProject(serializeProject(unlocked.project!)).pcb!.tracks[0].locked, undefined);
  core.execute('layout.track.properties', {
    boardId,
    trackId,
    width: project.pcb!.tracks[0].width + 0.1,
  });
  assert.equal(core.getSnapshot().undoDepth, 2);
  assert.equal(core.getSnapshot().project!.pcb!.zones[0].filledPolygons, undefined);
  core.execute('history.undo');
  assert.deepEqual(core.getSnapshot().project, unlocked.project);
  core.execute('history.undo');
  assert.deepEqual(core.getSnapshot().project, original.project);
  assert.deepEqual(
    projectNativeFiles(core.getSnapshot().project!),
    projectNativeFiles(original.project!),
  );
  core.execute('history.redo');
  assert.deepEqual(core.getSnapshot().project, unlocked.project);
});

test('current snapshots use explicit canonical track locks without recovering omitted fields', () => {
  const project = projectFromNativeFiles(fixture('bare'));
  const document = JSON.parse(serializeProject(project));
  const removeLock = (input: unknown): void => {
    if (!input || typeof input !== 'object') return;
    if ((input as { id?: string }).id === project.pcb!.tracks[0].id)
      delete (input as { locked?: true }).locked;
    for (const value of Object.values(input)) removeLock(value);
  };
  removeLock(document);
  const restored = parseProject(JSON.stringify(document));
  assert.equal(restored.pcb!.tracks[0].locked, undefined);
  assert.equal(
    projectFromNativeFiles(projectNativeFiles(restored)).pcb!.tracks[0].locked,
    undefined,
  );
  assert.equal(parseProject(serializeProject(project)).pcb!.tracks[0].locked, true);
});

test('malformed or duplicate native track locks reject before native content can be rewritten', () => {
  for (const lock of [['locked'], ['locked', 'maybe'], ['locked', 'yes', 'no']])
    assert.throws(() => projectFromNativeFiles(fixture(lock)), /invalid locked setting/);
  const files = fixture('bare');
  const source = parseSExpr(boardSource(files));
  children(source, 'segment')[0].push(['locked', 'yes']);
  files.files.find((file) => file.name.endsWith('.kicad_pcb'))!.source = writeSExpr(source);
  assert.throws(() => projectFromNativeFiles(files), /invalid locked setting/);
  children(source, 'segment')[0].pop();
  children(source, 'segment')[0].push('locked');
  files.files.find((file) => file.name.endsWith('.kicad_pcb'))!.source = writeSExpr(source);
  assert.throws(() => projectFromNativeFiles(files), /invalid locked setting/);
});

test('native validation checks track locks without collecting compatibility metadata', () => {
  const project = ownProject(projectFromNativeFiles(fixture('bare')));
  const files = project.nativeFiles!;
  assert.equal(validateNativeSourceFiles(files, project), undefined);
  assert.equal(validateNativeSourceFiles(files), undefined);
  validateProject(project);
  const invalid = fixture(['locked', 'maybe']);
  assert.throws(() => validateNativeSourceFiles(invalid), /invalid locked setting/);
  const candidate = { ...project, nativeFiles: invalid };
  for (let attempt = 0; attempt < 2; attempt++)
    assert.throws(() => validateProject(candidate), /invalid locked setting/);
  candidate.nativeFiles = structuredClone(files);
  validateProject(candidate);
  assert.equal(validateNativeSourceFiles(candidate.nativeFiles, candidate), undefined);
});

test('validation-only native checks reject changed mutable and caller-frozen file sets', () => {
  for (const frozen of [false, true]) {
    const project = projectFromNativeFiles(fixture('bare'));
    if (frozen) Object.freeze(project.nativeFiles);
    validateProject(project);
    const file = project.nativeFiles!.files.find((file) => file.name.endsWith('.kicad_pcb'))!;
    const source = file.source;
    file.source = source.replace('locked', '(locked maybe)');
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.throws(() => validateProject(project), /invalid locked setting/);
      assert.throws(
        () => validateNativeSourceFiles(project.nativeFiles!, project),
        /invalid locked setting/,
      );
    }
    file.source = source;
    validateProject(project);
    project.nativeFiles!.files[0].name = 'missing.kicad_pro';
    assert.throws(() => validateNativeSourceFiles(project.nativeFiles!, project), /entry/i);
  }
});
