import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { parseProject, serializeProject } from '../lib/project';
import {
  projectFromNativeFiles,
  projectNativeFiles,
  replaceNativeProjectFile,
} from '../lib/kicad-project';
import { simulationModelDefinitions } from '../lib/simulation-models';
import { exampleProject } from '../lib/project-example';
import { atomicWrite } from '../server/atomic-write.mjs';

const require = createRequire(import.meta.url);
const { createNativeSave } = require('../electron/native-save.cjs');
const { FileGrants } = require('../electron/file-grants.cjs');
const { writeNativeProject } = require('../electron/native-project.cjs');

test('Save writes a managed example in place; Save as detaches only after a successful write', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'openpe-native-save-'));
  try {
    const file = path.join(dataDir, 'example-projects', 'circuit', 'project.kicad_pro');
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
      dataDir,
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

test('Save keeps picker destinations and live grants bounded before preparing or writing', async () => {
  const dataDir = path.resolve('test-results', 'native-save-profile');
  const fileGrants = new FileGrants();
  const fileId = fileGrants.create();
  const source = serializeProject(exampleProject());
  let destination = path.join(dataDir, 'example-projects', 'other', 'project.kicad_pro');
  let dialogs = 0;
  let prepared = 0;
  let writes = 0;
  let revoke = false;
  const save = createNativeSave({
    parseProject,
    projectNativeFiles,
    fileGrants,
    dataDir,
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
  await assert.rejects(save({ fileId, source }), /outside the bundled example folders/);
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
  const invalid = JSON.parse(source);
  invalid.format = 'unsupported-format';
  await assert.rejects(
    save({ fileId, source: JSON.stringify(invalid) }),
    /unsupported internal snapshot format/i,
  );
  assert.equal(dialogs, 3, 'Invalid source never opens a picker.');
  assert.equal(prepared, 0);
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
      dataDir,
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
      dataDir,
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
