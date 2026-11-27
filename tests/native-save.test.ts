import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ProjectCore } from '../core/project-core';
import { createProject, parseProject, serializeProject } from '../lib/project';
import {
  projectFromNativeFiles,
  projectNativeFiles,
  replaceNativeProjectFile,
} from '../lib/kicad-project';
import { KICAD_PCB_VERSION } from '../lib/kicad-version';
import { nativeProjectDirty } from '../lib/native-project-dirty';
import { pcbFillRuleContext, readPCBDesignRuleSources } from '../lib/pcb-clearance-sources';
import { simulationModelDefinitions } from '../lib/simulation-models';
import { exampleProject } from '../lib/project-example';
import { child, parseSExpr, val } from '../lib/sexpr';
import { atomicWrite } from '../server/atomic-write.mjs';

const require = createRequire(import.meta.url);
const { createNativeSave } = require('../electron/native-save.cjs');
const { FileGrants } = require('../electron/file-grants.cjs');
const { readNativeProject, writeNativeProject } = require('../electron/native-project.cjs');

test('saving again accepts an existing native PCB over the ordinary source size limit', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openpe-native-large-pcb-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entry = 'Large.kicad_pcb';
  const destination = path.join(directory, entry);
  const source = '(kicad_pcb (version 20260206))\n' + ' '.repeat(8_000_000);
  const bundle = { entry, files: [{ name: entry, source }] };
  await writeNativeProject(destination, bundle, atomicWrite);
  await writeNativeProject(destination, bundle, atomicWrite);
  assert.deepEqual(await readNativeProject(destination), bundle);
});

test('a clean KiCad 10 board retains exact bytes across native Save and Save as', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'openpe-native-save-board-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const entry = 'Filter.kicad_pro';
  const boardName = 'Filter.kicad_pcb';
  const originalFile = path.join(dataDir, entry);
  const originalBoard = path.join(dataDir, boardName);
  const copy = path.join(dataDir, 'copy', 'Personal.kicad_pro');
  const boardSource = `(kicad_pcb
  (version 20260206)
  (generator "pcbnew")
  (generator_version "10.0")
  (general (thickness 1.6) (legacy_teardrops no))
  (paper "A4")
  (layers (0 "F.Cu" signal) (31 "B.Cu" signal))
  (setup (pad_to_mask_clearance 0))
  (net 0 "")
  (net 1 "GND")
  (segment (start 10 12) (end 17 12) (width 0.25) (layer "F.Cu") (net "GND")
    (uuid "7dcef6a4-3444-4dde-8929-3976717dd55a"))
)\n`;
  const original = projectNativeFiles(createProject(), entry);
  original.files.push({ name: boardName, source: boardSource });
  await writeNativeProject(originalFile, original, atomicWrite);
  const selected = await readNativeProject(originalBoard);
  assert.equal(selected.entry, entry);
  const imported = projectFromNativeFiles(selected);
  const core = new ProjectCore(imported, { nativeEntryName: entry });
  const opened = core.getSnapshot();
  assert.equal(
    core.getNativeFiles().files.find((file) => file.name === boardName)?.source,
    boardSource,
  );
  assert.equal(nativeProjectDirty(opened.project, opened.source, entry), false);

  const fileGrants = new FileGrants();
  const fileId = fileGrants.create(originalFile);
  let cancelled = true;
  let failPreparation = false;
  const save = createNativeSave({
    parseProject,
    projectNativeFiles,
    fileGrants,
    showSaveDialog: async () => ({ canceled: cancelled, filePath: copy }),
    prepareProjectFiles: async () => {
      if (failPreparation) throw new Error('Model preparation failed');
    },
    atomicWrite,
  });
  const snapshot = opened.project!;
  const packet = { ...snapshot, nativeFiles: projectNativeFiles(snapshot, entry) };
  assert.equal(await save({ fileId, source: serializeProject(packet), saveAs: true }), null);
  assert.equal(await readFile(originalBoard, 'utf8'), boardSource);
  assert.equal(core.getSnapshot().project, snapshot);

  failPreparation = true;
  await assert.rejects(save({ fileId, source: opened.source }), /Model preparation failed/);
  assert.equal(await readFile(originalBoard, 'utf8'), boardSource);
  failPreparation = false;
  cancelled = false;
  await mkdir(path.dirname(copy));
  await save({ fileId, source: opened.source, saveAs: true });
  assert.equal(await readFile(originalBoard, 'utf8'), boardSource);
  const renamed = projectNativeFiles(packet, path.basename(copy));
  const copyBoard = renamed.files.find((file) => file.name === 'Personal.kicad_pcb')!;
  assert.equal(
    await readFile(path.join(path.dirname(copy), copyBoard.name), 'utf8'),
    copyBoard.source,
  );
  const savedBoard = parseSExpr(copyBoard.source);
  assert.equal(val(child(savedBoard, 'version')), KICAD_PCB_VERSION);
  assert.equal(val(child(child(savedBoard, 'segment')!, 'net')), 'GND');
  assert.deepEqual(projectFromNativeFiles(await readNativeProject(copy)).pcb, snapshot.pcb);

  assert.equal(core.materialize(snapshot, { ...snapshot, nativeFiles: renamed }), true);
  core.setNativeEntryName(path.basename(copy));
  const saved = core.getSnapshot();
  assert.equal(saved.undoDepth, opened.undoDepth);
  assert.equal(nativeProjectDirty(saved.project, saved.source, path.basename(copy)), false);
  assert.deepEqual(core.getNativeFiles(), renamed);

  const originalGrant = fileGrants.create(originalFile);
  await save({ fileId: originalGrant, source: opened.source });
  assert.equal(await readFile(originalBoard, 'utf8'), copyBoard.source);

  const standalone = path.join(dataDir, 'standalone', 'Board.kicad_pcb');
  await mkdir(path.dirname(standalone));
  await writeFile(standalone, boardSource);
  const rulesSource = '(version 1)\n(rule "Board clearance" (constraint clearance (min 0.3mm)))\n';
  await writeFile(path.join(path.dirname(standalone), 'Board.kicad_dru'), rulesSource);
  const boardOnly = await readNativeProject(standalone);
  assert.deepEqual(boardOnly, {
    entry: 'Board.kicad_pcb',
    files: [
      { name: 'Board.kicad_dru', source: rulesSource },
      { name: 'Board.kicad_pcb', source: boardSource },
    ],
  });
  const standaloneProject = projectFromNativeFiles(boardOnly);
  assert.equal(standaloneProject.schematic.parts.length, 0);
  const track = standaloneProject.pcb!.tracks[0];
  assert.equal(track.id, snapshot.pcb!.tracks[0].id);
  assert.equal(track.netId, standaloneProject.pcb!.nets[0].id);
  assert.deepEqual(pcbFillRuleContext(standaloneProject), { rulesSource });
  const rules = readPCBDesignRuleSources(standaloneProject);
  assert.deepEqual(rules.notes, []);
  assert.equal(rules.rules[0].clearance, 0.3);
  const standaloneCore = new ProjectCore(standaloneProject);
  standaloneCore.execute('layout.delete', {
    boardId: standaloneProject.pcb!.id,
    selection: [{ kind: 'track', id: track.id }],
  });
  assert.deepEqual(standaloneCore.getSnapshot().project!.pcb!.tracks, []);
});

test('Save writes a managed example in place; Save as detaches only after a successful write', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'openpe-native-save-'));
  try {
    const examplesRoot = path.join(dataDir, 'examples');
    const file = path.join(examplesRoot, 'project', 'circuit', 'project.kicad_pro');
    const copy = path.join(dataDir, 'personal.kicad_pro');
    const source = serializeProject(exampleProject());
    await mkdir(path.dirname(file), { recursive: true });
    await writeNativeProject(
      file,
      projectNativeFiles(parseProject(source), path.basename(file)),
      atomicWrite,
    );
    const fileGrants = new FileGrants();
    const fileId = fileGrants.create(file);
    fileGrants.markLocalExample(fileId);
    let dialogs = 0;
    let cancelled = false;
    let failPreparation = false;
    const prepared: string[][] = [];
    const save = createNativeSave({
      parseProject,
      projectNativeFiles,
      fileGrants,
      exampleRoots: [examplesRoot, path.join(examplesRoot, 'project')],
      showSaveDialog: async () => {
        dialogs++;
        return { canceled: cancelled, filePath: copy };
      },
      prepareProjectFiles: async (
        project: ReturnType<typeof parseProject>,
        destination: string,
        prior: string,
      ) => {
        assert.equal(project.name, 'Edited example');
        prepared.push([destination, prior]);
        if (failPreparation) throw new Error('Model preparation failed');
      },
      atomicWrite,
    });
    const project = parseProject(source);
    project.name = 'Edited example';
    project.extensions = { ...project.extensions, savedExample: { retained: true } };
    const edited = serializeProject(project);
    const result = await save({ fileId, source: edited, saveAs: false });
    assert.equal(dialogs, 0);
    assert.equal(result.path, file);
    assert.equal(result.localExample, true);
    const expected = projectNativeFiles(project, path.basename(file));
    for (const item of expected.files)
      assert.equal(await readFile(path.join(path.dirname(file), item.name), 'utf8'), item.source);
    assert.deepEqual(prepared, [[file, file]]);
    assert.equal(fileGrants.get(fileId), file);

    cancelled = true;
    assert.equal(await save({ fileId, source: edited, saveAs: true }), null);
    assert.equal(fileGrants.isLocalExample(fileId), true);
    assert.equal(prepared.length, 1);
    cancelled = false;
    failPreparation = true;
    await assert.rejects(
      save({ fileId, source: edited, saveAs: true }),
      /Model preparation failed/,
    );
    assert.equal(fileGrants.get(fileId), file);
    await assert.rejects(readFile(copy), { code: 'ENOENT' });
    failPreparation = false;
    const savedCopy = await save({ fileId, source: edited, saveAs: true });
    assert.equal(dialogs, 3);
    assert.equal(savedCopy.localExample, false);
    assert.equal(fileGrants.get(fileId), copy);
    const expectedCopy = projectNativeFiles(project, path.basename(copy));
    for (const item of expectedCopy.files)
      assert.equal(await readFile(path.join(path.dirname(copy), item.name), 'utf8'), item.source);
    assert.equal(
      await readFile(file, 'utf8'),
      expected.files.find((item) => item.name === expected.entry)!.source,
    );
    assert.deepEqual(prepared.at(-1), [copy, file]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Save keeps picker destinations and live grants bounded before preparing or writing', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'openpe-native-save-preflight-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const fileGrants = new FileGrants();
  const fileId = fileGrants.create();
  const source = serializeProject(exampleProject());
  const exampleRoots = ['examples-native', 'project-native'].map((name) =>
    path.join(dataDir, name),
  );
  let destination = '';
  let dialogs = 0;
  let prepared = 0;
  let writes = 0;
  let revoke = false;
  const save = createNativeSave({
    parseProject,
    projectNativeFiles,
    fileGrants,
    exampleRoots,
    showSaveDialog: async () => {
      dialogs++;
      return { canceled: false, filePath: destination };
    },
    prepareProjectFiles: async () => {
      prepared++;
      if (revoke) fileGrants.release(fileId);
    },
    atomicWrite: async () => {
      writes++;
    },
  });
  for (const root of exampleRoots) {
    destination = path.join(root, 'other', 'project.kicad_pro');
    await assert.rejects(save({ fileId, source }), /outside the bundled example folders/);
  }
  assert.equal(prepared, 0);
  assert.equal(writes, 0);
  destination = path.join(dataDir, 'personal.kicad_pro');
  const other = fileGrants.create(destination);
  await assert.rejects(save({ fileId, source }), /open in another project/);
  fileGrants.release(other);
  const sibling = fileGrants.create(path.join(dataDir, 'another.kicad_pro'));
  fileGrants.setProjectFiles(sibling, [path.join(dataDir, 'personal.kicad_sch')]);
  await assert.rejects(save({ fileId, source }), /project file is open in another project/);
  fileGrants.release(sibling);
  await mkdir(path.join(dataDir, 'blocked.kicad_sch'));
  destination = path.join(dataDir, 'blocked.kicad_pro');
  await assert.rejects(save({ fileId, source }), /not a regular bounded file/);
  const invalid = JSON.parse(source);
  invalid.format = 'unsupported-format';
  await assert.rejects(
    save({ fileId, source: JSON.stringify(invalid) }),
    /unsupported internal snapshot format/i,
  );
  assert.equal(dialogs, 5, 'Invalid source never opens a picker.');
  assert.equal(prepared, 0);
  destination = path.join(dataDir, 'personal.kicad_pro');
  revoke = true;
  await assert.rejects(save({ fileId, source }), /no file access grant/);
  assert.equal(writes, 0);
});

test('shared auxiliary sources allow two open projects and unchanged saves while rejecting conflicting edits', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'openpe-native-shared-'));
  try {
    const fileGrants = new FileGrants();
    const shared = { name: 'shared.kicad_sym', source: '(kicad_symbol_lib (version 20241209))\n' };
    const opened = [];
    for (const name of ['first', 'second']) {
      const bundle = projectNativeFiles(exampleProject(), `${name}.kicad_pro`);
      bundle.files.push(shared);
      const project = projectFromNativeFiles(bundle),
        file = path.join(dataDir, bundle.entry);
      await writeNativeProject(file, bundle, atomicWrite);
      const fileId = fileGrants.create(file);
      fileGrants.setProjectFiles(
        fileId,
        bundle.files.map((item) => path.join(dataDir, item.name)),
      );
      opened.push({ project, file, fileId });
    }
    const [first, second] = opened;
    assert.equal(fileGrants.owners(path.join(dataDir, shared.name)).length, 2);
    let prepared = 0,
      writes = 0;
    const save = createNativeSave({
      parseProject,
      projectNativeFiles,
      fileGrants,
      showSaveDialog: async () => {
        throw new Error('Existing project does not need a picker.');
      },
      prepareProjectFiles: async () => {
        prepared++;
      },
      atomicWrite: async (file: string, content: Buffer | string) => {
        writes++;
        await atomicWrite(file, content);
      },
    });
    await save({ fileId: first.fileId, source: serializeProject(first.project) });
    assert.equal(prepared, 1);
    assert.equal(writes, 0);
    const changed = replaceNativeProjectFile(first.project, shared.name, shared.source + '\n');
    await assert.rejects(
      save({ fileId: first.fileId, source: serializeProject(changed) }),
      /shared KiCad source file/,
    );
    assert.equal(prepared, 1, 'A conflicting shared source fails before asset preparation.');
    assert.equal(writes, 0);
    assert.equal(await readFile(path.join(dataDir, shared.name), 'utf8'), shared.source);
    fileGrants.release(second.fileId);
    await save({ fileId: first.fileId, source: serializeProject(changed) });
    assert.equal(await readFile(path.join(dataDir, shared.name), 'utf8'), shared.source + '\n');
    assert.equal(writes, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('edited pinned model source is rejected before assets or destination files are touched', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'openpe-native-pinned-source-'));
  try {
    const model = simulationModelDefinitions[0],
      project = exampleProject();
    project.simulationModels = [model];
    const bundle = projectNativeFiles(project, 'circuit.kicad_pro');
    bundle.files.push({
      name: model.file,
      source: '* altered vendor model \u00b5\n',
      encoding: 'latin1',
    });
    const edited = projectFromNativeFiles(bundle);
    const file = path.join(dataDir, bundle.entry),
      modelFile = path.join(dataDir, model.file);
    await mkdir(path.dirname(modelFile), { recursive: true });
    await writeFile(file, 'preserve native project');
    await writeFile(modelFile, 'preserve model bytes');
    const fileGrants = new FileGrants(),
      fileId = fileGrants.create(file);
    let prepared = 0,
      writes = 0;
    const save = createNativeSave({
      parseProject,
      projectNativeFiles,
      fileGrants,
      showSaveDialog: async () => {
        throw new Error('Existing project does not need a picker.');
      },
      prepareProjectFiles: async () => {
        prepared++;
      },
      atomicWrite: async () => {
        writes++;
      },
    });
    await assert.rejects(
      save({ fileId, source: serializeProject(edited) }),
      /pinned simulation model.*SHA-256/,
    );
    assert.equal(prepared, 0);
    assert.equal(writes, 0);
    assert.equal(await readFile(file, 'utf8'), 'preserve native project');
    assert.equal(await readFile(modelFile, 'utf8'), 'preserve model bytes');
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
