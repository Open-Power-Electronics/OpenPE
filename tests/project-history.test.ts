import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ProjectHistory } from '../server/project-history.mjs';
import { compareProjectFiles } from '../lib/project-history';
import type { KiCadProjectFiles } from '../lib/kicad-project';
import {
  appendSchematic,
  serializeProject,
  parseProject,
  projectNativeFiles,
} from '../lib/project';
import { exampleProject } from '../lib/project-example';

const { FileGrants } = createRequire(import.meta.url)('../electron/file-grants.cjs');
async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'openpe-history-'));
  const grants = new FileGrants();
  const file = path.join(dir, 'design.kicad_pro');
  const id = grants.create(file);
  const history = new ProjectHistory(dir, grants);
  return { dir, file, id, history, grants };
}

test('unchanged example seeds verify in two Git processes while preserving private personal history', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'openpe-history-seed-'));
  const grants = new FileGrants();
  const id = grants.create(path.join(dir, 'project', 'emc-flyback', 'emc-flyback.kicad_pro'));
  grants.markLocalExample(id);
  const history = new ProjectHistory(dir, grants);
  t.after(async () => {
    history.close();
    await rm(dir, { recursive: true, force: true });
  });
  const project = exampleProject();
  const source = serializeProject(project);
  await history.ensureExampleInitial(id, source);
  const initial = (await history.list(id)).commits[0].id;
  const commands: string[][] = [];
  const run = history.run.bind(history);
  history.run = async (...args: Parameters<typeof run>) => {
    commands.push(args[1]);
    return run(...args);
  };
  await history.ensureExampleInitial(id, source);
  assert.deepEqual(
    commands.map((command) => command[0]),
    ['for-each-ref', 'ls-tree'],
    'Unchanged seeds verify ref/commit metadata and the actual stored tree.',
  );
  assert.equal((await history.list(id)).commits[0].id, initial);
  assert.equal(await history.read(id, initial), source);

  const repo = await history.withProject(id, async (directory: string) => directory);
  assert.equal(path.dirname(repo), path.join(dir, 'project-history-v1'));
  const tree = (await run(repo, ['rev-parse', `${initial}^{tree}`])).text.trim();
  assert.match(tree, /^[0-9a-f]{40}$/);
  const treeFile = path.join(repo, 'objects', tree.slice(0, 2), tree.slice(2));
  const storedTree = await readFile(treeFile);
  await unlink(treeFile);
  try {
    await assert.rejects(history.ensureExampleInitial(id, source), /Git failed/);
  } finally {
    await writeFile(treeFile, storedTree, { flag: 'wx' });
  }

  project.schematic.parts[0].value = '4.7k';
  const changed = serializeProject(project);
  await run(repo, ['update-ref', 'refs/heads/keep', initial]);
  await history.ensureExampleInitial(id, changed);
  assert.equal(await history.head(repo), initial, 'Extra refs protect an existing history.');
  await run(repo, ['update-ref', '-d', 'refs/heads/keep']);
  await history.ensureExampleInitial(id, changed);
  const refreshed = (await history.list(id)).commits;
  assert.equal(refreshed.length, 1);
  assert.notEqual(refreshed[0].id, initial);
  assert.equal(await history.read(id, refreshed[0].id), changed);

  await history.create(id, source, 'Personal version');
  await history.ensureExampleInitial(id, changed);
  assert.deepEqual(
    (await history.list(id)).commits.map((entry: { message: string }) => entry.message),
    ['Personal version', 'init'],
  );
});

test('example opening preserves a sole version with a retired automatic subject', async (t) => {
  const { dir, id, history, grants } = await setup();
  grants.markLocalExample(id);
  t.after(async () => {
    history.close();
    await rm(dir, { recursive: true, force: true });
  });
  const project = exampleProject();
  const source = serializeProject(project);
  const version = await history.create(id, source, 'Initial example');
  project.schematic.parts[0].value = '4.7k';
  await history.ensureExampleInitial(id, serializeProject(project));
  const { commits } = await history.list(id);
  assert.deepEqual(
    commits.map((entry: { id: string }) => entry.id),
    [version.id],
  );
  assert.equal(await history.read(id, version.id), source);
});

test('real Git snapshots preserve complete projects and restart history without writing design files', async () => {
  const { dir, file, id, history, grants } = await setup();
  const project = appendSchematic(exampleProject()).project;
  project.extensions.historyTest = { note: 'Ω 中文', enabled: true };
  const source = serializeProject(project);
  const native = projectNativeFiles(project, path.basename(file));
  const nativeSource = native.files.find((item) => item.name === native.entry)!.source;
  await writeFile(file, nativeSource);
  const first = await history.create(id, source, 'Initial design');
  project.schematic.parts[0].value = '4.7k';
  project.additionalSchematics![0].title = 'Control';
  project.pcb!.thickness = 2;
  project.extensions.historyTest = { note: 'Updated' };
  const edited = serializeProject(project);
  const second = await history.create(id, edited, 'Tune resistor');
  assert.notEqual(first.id, second.id);
  assert.equal(
    await readFile(file, 'utf8'),
    nativeSource,
    'Version creation never writes the destination.',
  );
  history.close();
  const reopened = new ProjectHistory(dir, grants);
  const page = await reopened.list(id);
  assert.match(page.version, /^git version/);
  assert.deepEqual(
    page.commits.map((entry: { message: string }) => entry.message),
    ['Tune resistor', 'Initial design'],
  );
  assert.equal(await reopened.read(id, first.id), source);
  assert.equal(await reopened.read(id, second.id), edited);
  const restored = parseProject(await reopened.read(id, first.id));
  assert.deepEqual(restored.pcb, parseProject(source).pcb);
  assert.deepEqual(restored.extensions, JSON.parse(source).extensions);
  assert.equal(restored.additionalSchematics?.length, 1);
  await assert.rejects(reopened.create(id, edited, 'Duplicate'), /matches the latest/);
  assert.equal((await reopened.list(id)).commits.length, 2);
  assert.equal((await readdir(dir)).includes('.git'), false);
  reopened.close();
});

test('native grants isolate histories and reject paths, revisions, invalid data and unavailable Git', async () => {
  const { id, history, grants, dir } = await setup();
  const source = serializeProject(exampleProject());
  await assert.rejects(history.list('C:\\arbitrary.kicad_pro'), /grant/);
  assert.equal((await history.list(grants.create())).needsSave, true);
  await assert.rejects(history.create(id, '{', 'Bad source'));
  await assert.rejects(history.create(id, source, 'bad\nname'), /one line/);
  await assert.rejects(history.create(id, ' '.repeat(8_000_001), 'Too large'), /8 MB/);
  await assert.rejects(history.read(id, '--exec=bad'), /Invalid version/);
  const first = await history.create(id, source, 'First');
  const other = grants.create(path.join(dir, 'other.kicad_pro'));
  const project = exampleProject();
  await history.create(other, serializeProject(project), 'Other');
  await assert.rejects(history.read(other, first.id));
  assert.equal((await history.list(other)).commits.length, 1);
  grants.assign(id, path.join(dir, 'saved-as.kicad_pro'));
  assert.equal(
    (await history.list(id)).commits.length,
    0,
    'Save as has an independent destination history.',
  );
  grants.release(other);
  await assert.rejects(history.list(other), /grant/);
  const missing = new ProjectHistory(dir, grants, { executable: path.join(dir, 'missing-git') });
  await assert.rejects(missing.list(id), /Install Git and restart OpenPE/);
  missing.close();
  history.close();
  await assert.rejects(history.create(id, source, 'Shutdown'), /shutting down/);
});

test('history operations reject overlap, preserve prior commits on invalid snapshots and ignore inherited Git configuration', async () => {
  const { history, id, dir } = await setup();
  const oldConfig = process.env.GIT_CONFIG_COUNT;
  process.env.GIT_CONFIG_COUNT = 'invalid';
  try {
    const source = serializeProject(exampleProject());
    const creation = history.create(id, source, 'Initial');
    await assert.rejects(history.create(id, source, 'Overlapping'), /already running/);
    await creation;
    const invalid = JSON.parse(source);
    invalid.schematic.components[0].footprints[0].pads[0].netId =
      '00000000-0000-4000-8000-000000000000';
    await assert.rejects(history.create(id, JSON.stringify(invalid), 'Broken links'));
    assert.equal((await history.list(id)).commits.length, 1);
    const [repo] = (await readdir(path.join(dir, 'project-history-v1'))).filter((name) =>
      name.endsWith('.git'),
    );
    const corrupt = JSON.stringify({ format: 'openpe', version: 99 });
    const repository = path.join(dir, 'project-history-v1', repo);
    const blob = (
      await history.run(repository, ['hash-object', '-w', '--stdin'], corrupt)
    ).text.trim();
    const tree = (
      await history.run(repository, ['mktree'], `100644 blob ${blob}\tproject.openpe.json\n`)
    ).text.trim();
    const parent = await history.head(repository);
    const commit = (
      await history.run(
        repository,
        ['commit-tree', tree, '-p', parent],
        'Invalid historical format\n',
      )
    ).text.trim();
    await history.run(repository, ['update-ref', 'refs/heads/main', commit, parent]);
    await assert.rejects(history.read(id, commit), /version|format|project/i);
  } finally {
    if (oldConfig === undefined) delete process.env.GIT_CONFIG_COUNT;
    else process.env.GIT_CONFIG_COUNT = oldConfig;
    history.close();
  }
});

test('file comparison lists each actual native filename once and ignores packet order', () => {
  const project = exampleProject();
  const before = projectNativeFiles(project, 'design.kicad_pro');
  assert.deepEqual(
    compareProjectFiles(before, { ...before, files: [...before.files].reverse() }),
    [],
  );
  project.schematic.parts[0].value = '4.7k';
  project.pcb!.thickness = 2;
  const after = projectNativeFiles(project, 'design.kicad_pro');
  const settings = after.files.find((file) => file.name === after.entry)!;
  settings.source = JSON.stringify({
    ...JSON.parse(settings.source),
    text_variables: { NOTE: 'Native settings change' },
  });
  const changes = compareProjectFiles(before, after);
  assert.deepEqual(
    changes.map((file) => file.name),
    ['design.kicad_pcb', 'design.kicad_pro', 'design.kicad_sch'],
  );
  assert.ok(changes.every((file) => file.kind === 'changed'));
  for (const file of changes) {
    assert.equal(
      file.before!.source,
      before.files.find((native) => native.name === file.name)!.source,
    );
    assert.equal(
      file.after!.source,
      after.files.find((native) => native.name === file.name)!.source,
    );
  }
});

test('file comparison retains supporting bytes, encodings, empty additions and removals', () => {
  const before: KiCadProjectFiles = {
    entry: 'design.kicad_pro',
    files: [
      { name: 'design.kicad_pro', source: '{}' },
      { name: 'symbols/device.kicad_sym', source: '(kicad_symbol_lib)' },
      { name: 'models/model.lib', source: '.subckt device 1 2\n.ends\n' },
      { name: 'notes.txt', source: 'unchanged', encoding: 'latin1' },
    ],
  };
  const after: KiCadProjectFiles = {
    entry: before.entry,
    files: [
      { name: 'notes.txt', source: 'unchanged' },
      { name: 'design.kicad_pro', source: '{}' },
      {
        name: 'models/model.lib',
        source: '.subckt device 1 2\nR1 1 2 1k\n.ends\n',
      },
      { name: 'empty.txt', source: '' },
    ],
  };
  const changes = compareProjectFiles(before, after);
  assert.deepEqual(
    changes.map(({ name, kind }) => [name, kind]),
    [
      ['empty.txt', 'added'],
      ['models/model.lib', 'changed'],
      ['notes.txt', 'changed'],
      ['symbols/device.kicad_sym', 'removed'],
    ],
  );
  assert.equal(changes[0].before, undefined);
  assert.equal(changes[0].after!.source, '');
  assert.equal(changes[3].after, undefined);
  changes[1].before!.source = 'caller edit';
  assert.notEqual(
    before.files[2].source,
    'caller edit',
    'Public file results do not alias caller containers.',
  );
  assert.equal(
    before.files[0].name,
    'design.kicad_pro',
    'Sorting never mutates the native packet.',
  );
});
