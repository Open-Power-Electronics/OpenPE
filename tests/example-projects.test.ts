import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  readdir,
  readFile,
  writeFile,
  mkdir,
  rm,
  unlink,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ExampleProjects } from '../server/example-projects.mjs';
import { ProjectHistory } from '../server/project-history.mjs';
import {
  createProject,
  parseProject,
  projectFromNativeFiles,
  projectNativeFiles,
  serializeProject,
} from '../lib/project';
import { switchingStageFixture } from './fixtures/switching-stage';
import { buildSpiceDeck, defaultTransient } from '../lib/spice';
import { validExampleKey } from '../lib/workspace-example';
import { defaultExamples } from '../lib/default-examples';
import { homeExampleCatalog, homeExampleNativePath } from '../lib/home-examples';
const { FileGrants } = createRequire(import.meta.url)('../electron/file-grants.cjs');
const { readNativeProject } = createRequire(import.meta.url)('../electron/native-project.cjs');
const { createProjectDirectoryReader } = createRequire(import.meta.url)(
  '../electron/project-directory.cjs',
);

const noHistory = () => ({ ensureExampleInitial: async () => {} });

test('same-named projects in nested roots retain distinct keys when packaged separately', async (t) => {
  const { root, temporary, grants } = await fixture(t, []);
  const projectRoot = path.join(root, 'project');
  const bundle = projectNativeFiles(createProject(switchingStageFixture()), 'Twin.kicad_pro');
  const writeTwin = async (parent: string) => {
    await mkdir(path.join(parent, 'Twin'), { recursive: true });
    for (const file of bundle.files)
      await writeFile(path.join(parent, 'Twin', file.name), file.source);
  };
  await writeTwin(root);
  await writeTwin(projectRoot);
  const examples = new ExampleProjects(root, grants, noHistory(), projectRoot);
  const entries = (await examples.list()).entries;
  assert.equal(entries.length, 2);
  assert.equal(new Set(entries.map((entry: { id: string }) => entry.id)).size, 2);
  for (const entry of entries) {
    const opened = await examples.openDefault(`example:${entry.id}`);
    assert.equal(
      grants.get(opened.fileId),
      path.join(entry.section === 'project' ? projectRoot : root, 'Twin', bundle.entry),
    );
    grants.release(opened.fileId);
  }
  const packagedProject = path.join(temporary, 'project-native');
  const packagedExamples = path.join(temporary, 'examples-native');
  await writeTwin(packagedProject);
  await writeTwin(packagedExamples);
  const packaged = new ExampleProjects(packagedExamples, grants, noHistory(), packagedProject);
  assert.deepEqual((await packaged.list()).entries, entries);
  for (const entry of entries) {
    const opened = await packaged.openDefault(`example:${entry.id}`);
    assert.equal(
      grants.get(opened.fileId),
      path.join(temporary, entry.section + '-native', 'Twin', bundle.entry),
    );
  }
});

test('the reserved project group cannot duplicate a native entry in either resource layout', async (t) => {
  const { root, temporary, grants } = await fixture(t, []);
  const projectRoot = path.join(root, 'project');
  const bundle = projectNativeFiles(createProject(switchingStageFixture()), 'Direct.kicad_pro');
  for (const file of bundle.files) await writeFile(path.join(projectRoot, file.name), file.source);
  const examples = new ExampleProjects(root, grants, noHistory());
  const { entries, warnings } = await examples.list();
  assert.deepEqual(warnings, []);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].section, 'project');
  assert.equal(entries[0].title, 'Direct');
  const opened = await examples.openDefault(`example:${entries[0].id}`);
  assert.equal(grants.get(opened.fileId), path.join(projectRoot, bundle.entry));
  grants.release(opened.fileId);

  const packagedRoot = path.join(temporary, 'project-native');
  await mkdir(packagedRoot);
  for (const file of bundle.files) await writeFile(path.join(packagedRoot, file.name), file.source);
  const packaged = new ExampleProjects(root, grants, noHistory(), packagedRoot);
  assert.deepEqual(await packaged.list(), { entries, warnings });
  const packagedOpen = await packaged.openDefault(`example:${entries[0].id}`);
  assert.equal(grants.get(packagedOpen.fileId), path.join(packagedRoot, bundle.entry));

  const partial = new ExampleProjects(
    path.join(temporary, 'missing-examples'),
    grants,
    noHistory(),
    packagedRoot,
  );
  const listed = await partial.list();
  assert.deepEqual(listed.entries, entries);
  assert.match(listed.warnings.join('\n'), /Could not inspect examples resources/);
  assert.equal((await partial.openDefault(`example:${entries[0].id}`)).fileId, packagedOpen.fileId);
});

test('an oversized root reports a limit warning without publishing a partial project list', async (t) => {
  const { root, grants } = await fixture(t, []);
  for (let index = 0; index < 256; index++)
    await writeFile(path.join(root, `test-${index}.kicad_pro`), '');
  const extra = path.join(root, 'Extra');
  await mkdir(extra);
  await writeFile(path.join(extra, 'extra.kicad_pro'), '');
  await writeFile(path.join(root, 'project', 'available.kicad_pro'), '');
  const { entries, warnings } = await new ExampleProjects(root, grants, noHistory()).list();
  assert.deepEqual(
    entries.map((entry: { title: string }) => entry.title),
    ['available'],
  );
  assert.match(warnings.join('\n'), /Example discovery exceeds 256 projects/);
});

test('Default Recent projects retain their catalog identity inside the dedicated project directory', async (t) => {
  const { root, files, grants } = await fixture(t, defaultExamples().slice(0, 1));
  const examples = new ExampleProjects(root, grants, noHistory());
  const listed = await examples.list();
  assert.equal(listed.entries.length, 1);
  assert.equal(listed.entries[0].id, 'emc-flyback-demo');
  assert.equal(listed.entries[0].section, 'project');
  const opened = await examples.openDefault('example:emc-flyback-demo');
  assert.equal(
    grants.get(opened.fileId),
    path.join(root, 'project', 'emc-flyback', 'emc-flyback.kicad_pro'),
  );
  assert.equal(grants.get(opened.fileId), files.get('example:emc-flyback-demo'));
});

test('dropped projects are discovered without catalog registration and use ordinary native import and simulation', async (t) => {
  const { root, grants } = await fixture(t);
  let histories = 0;
  const history = {
    ensureExampleInitial: async () => {
      histories++;
    },
  };
  const examples = new ExampleProjects(root, grants, history);
  const before = await examples.list();
  const directory = path.join(root, 'Customer 电源');
  await mkdir(directory);
  const project = createProject(switchingStageFixture());
  const bundle = projectNativeFiles(project, 'Power supply.kicad_pro');
  for (const file of bundle.files) await writeFile(path.join(directory, file.name), file.source);
  const listed = await examples.list();
  const added = listed.entries.filter(
    (entry: { id: string }) => !before.entries.some((old: { id: string }) => old.id === entry.id),
  );
  assert.equal(added.length, 1);
  assert.equal(added[0].title, 'Power supply');
  assert.match(added[0].id, /^local-[a-f0-9]{64}$/);
  assert.equal(histories, 0, 'Discovery does not create histories or grants.');
  const key = `example:${added[0].id}`;
  assert.equal(validExampleKey(key), true);
  assert.deepEqual(await examples.list(), listed);
  // Clean recovery resolves the stable opaque identity without a prior list call.
  const recovered = new ExampleProjects(root, grants, history);
  const opened = await recovered.openDefault(key);
  const direct = projectFromNativeFiles(
    await readNativeProject(path.join(directory, bundle.entry)),
  );
  const imported = parseProject(opened.source);
  assert.equal(serializeProject(imported), serializeProject(direct));
  assert.deepEqual(
    buildSpiceDeck(imported.schematic, defaultTransient(imported.schematic)),
    buildSpiceDeck(direct.schematic, defaultTransient(direct.schematic)),
  );
  assert.equal(histories, 1);
  await unlink(path.join(directory, bundle.entry));
  assert.equal(
    (await examples.list()).entries.some((entry: { id: string }) => entry.id === added[0].id),
    false,
  );
  await assert.rejects(recovered.openDefault(key), /unavailable/);
});

test('discovery rejects linked roots, ignores linked projects and does not turn renderer keys into paths', async (t) => {
  const { root, temporary, grants } = await fixture(t);
  const link = path.join(temporary, 'linked-examples');
  try {
    await symlink(root, link, 'junction');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code!)) {
      t.skip('Directory links are unavailable.');
      return;
    }
    throw error;
  }
  await assert.rejects(new ExampleProjects(link, grants, noHistory()).list(), /regular|unlinked/);
  const nested = path.join(root, 'linked-project');
  await symlink(temporary, nested, 'junction');
  const examples = new ExampleProjects(root, grants, noHistory());
  assert.ok(
    (await examples.list()).warnings.some((warning: string) => warning.includes('linked-project')),
  );
  assert.throws(() => examples.openDefault('example:local-../../escape'), /Unknown/);
  await assert.rejects(examples.openDefault(`example:local-${'0'.repeat(64)}`), /unavailable/);
});
async function fixture(t: TestContext, entries = defaultExamples().slice(0, 1)) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'openpe-original-examples-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, 'examples');
  await mkdir(root);
  await mkdir(path.join(root, 'project'));
  const files = new Map<string, string>();
  for (const entry of entries) {
    const fixed = homeExampleCatalog.find((item) => `example:${item.id}` === entry.key)!;
    const directory = path.dirname(path.join(temporary, homeExampleNativePath(fixed.id)));
    const bundle = projectNativeFiles(
      parseProject(entry.createSource()),
      `${fixed.file}.kicad_pro`,
    );
    for (const file of bundle.files) {
      const target = path.join(directory, ...file.name.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.source, file.encoding ?? 'utf8');
    }
    files.set(entry.key, path.join(directory, bundle.entry));
  }
  return { root, temporary, files, entries, grants: new FileGrants() };
}

test('overlapping example opens share original native reads, history and grants', async (t) => {
  const { root, files, entries, grants } = await fixture(t);
  let began!: () => void, resume!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let histories = 0;
  const examples = new ExampleProjects(root, grants, {
    ensureExampleInitial: async () => {
      histories++;
      began();
      await gate;
    },
  });
  const first = examples.openDefault(entries[0].key);
  await started;
  const second = examples.openDefault(entries[0].key);
  assert.equal(first, second);
  resume();
  const [opened, repeated] = await Promise.all([first, second]);
  assert.deepEqual(repeated, opened);
  assert.equal(histories, 1);
  assert.equal(examples.busy.size, 0);
  assert.equal(grants.get(opened.fileId), files.get(entries[0].key));
  assert.equal(opened.filename, 'emc-flyback.kicad_pro');
  assert.equal(grants.isLocalExample(opened.fileId), true);
  assert.equal(
    grants.findOpen(files.get(entries[0].key)!.replace(/\.kicad_pro$/, '.kicad_sch')),
    opened.fileId,
  );
});

test('Source lists original example names, nested documents, PDF, SCAD and empty folders', async (t) => {
  const { root, files, entries, grants } = await fixture(t);
  const file = files.get(entries[0].key)!;
  const directory = path.dirname(file);
  const nativeBefore = await readFile(file);
  await mkdir(path.join(directory, 'datasheets'));
  await mkdir(path.join(directory, 'notes/empty'), { recursive: true });
  const scad = '// Original editable source\ncube([12, 20, 30]);\n';
  await writeFile(path.join(directory, 'emc-flyback.scad'), scad);
  await writeFile(path.join(directory, 'datasheets/controller.pdf'), '%PDF-1.7\n%%EOF\n');
  await writeFile(path.join(directory, 'datasheets/user-notes.json'), '{"voltage":24}');
  const examples = new ExampleProjects(root, grants, noHistory());
  const opened = await examples.openDefault(entries[0].key);
  assert.equal(grants.get(opened.fileId), file);
  const reader = createProjectDirectoryReader(grants);
  const listing = await reader.list(opened.fileId);
  for (const name of [
    'emc-flyback.kicad_pro',
    'emc-flyback.kicad_sch',
    'emc-flyback.kicad_pcb',
    'emc-flyback.scad',
    'datasheets/controller.pdf',
    'datasheets/user-notes.json',
    'notes/empty',
  ])
    assert.ok(
      listing.entries.some((entry: { name: string }) => entry.name === name),
      name,
    );
  assert.ok(
    !listing.entries.some((entry: { name: string }) =>
      /^(?:project\.|Generations\/)/.test(entry.name),
    ),
  );
  const source = listing.entries.find(
    (entry: { name: string }) => entry.name === 'emc-flyback.scad',
  );
  assert.equal((await reader.read(opened.fileId, source.id)).source, scad);
  assert.equal((await reader.read(opened.fileId, source.id)).readOnly, false);
  assert.deepEqual(await readFile(file), nativeBefore);
  assert.equal(await readFile(path.join(directory, 'emc-flyback.scad'), 'utf8'), scad);
  assert.ok(!(await readdir(directory)).includes('history.git'));
});

test('reopening an example reads current disk edits instead of restoring a template', async (t) => {
  const { root, files, entries, grants } = await fixture(t);
  const examples = new ExampleProjects(root, grants, noHistory());
  const first = await examples.openDefault(entries[0].key);
  const schematic = files.get(entries[0].key)!.replace(/\.kicad_pro$/, '.kicad_sch');
  const original = await readFile(schematic, 'utf8');
  await writeFile(schematic, original + '\n');
  const second = await examples.openDefault(entries[0].key);
  assert.equal(first.fileId, second.fileId);
  assert.equal(first.id, second.id);
  assert.notEqual(first.source, second.source);
  assert.equal(
    parseProject(second.source).nativeFiles!.files.find(
      (file) => file.name === path.basename(schematic),
    )!.source,
    original + '\n',
  );
  assert.equal(await readFile(schematic, 'utf8'), original + '\n');
});

test('invalid or missing original example files remain untouched and opening retries after repair', async (t) => {
  const { root, files, entries, grants } = await fixture(t);
  const examples = new ExampleProjects(root, grants, noHistory());
  const file = files.get(entries[0].key)!;
  const correct = await readFile(file);
  await writeFile(file, '{broken');
  await assert.rejects(examples.openDefault(entries[0].key));
  assert.equal(grants.find(file), undefined);
  assert.equal(await readFile(file, 'utf8'), '{broken');
  await writeFile(file, correct);
  assert.equal((await examples.openDefault(entries[0].key)).filename, path.basename(file));
  await assert.rejects(
    examples.openDefault(defaultExamples()[1].key),
    /ENOENT|unavailable|missing/i,
  );
  for (const key of ['../escape', 'C:\\arbitrary', { key: entries[0].key }])
    assert.throws(() => examples.openDefault(key), /Unknown default example/);
});

test('preparation bounds original-project work and unrelated missing examples do not block a usable selection', async (t) => {
  const { root, files, entries, grants } = await fixture(t, defaultExamples().slice(0, 5));
  const added = projectNativeFiles(createProject(switchingStageFixture()), 'Added.kicad_pro');
  for (const file of added.files) await writeFile(path.join(root, file.name), file.source);
  const existing = grants.create(files.get(entries[0].key));
  let active = 0,
    maximum = 0,
    histories = 0,
    began!: () => void,
    resume!: () => void;
  const firstWave = new Promise<void>((resolve) => {
    began = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const examples = new ExampleProjects(root, grants, {
    ensureExampleInitial: async () => {
      histories++;
      maximum = Math.max(maximum, ++active);
      if (active === 3) began();
      try {
        await gate;
      } finally {
        active--;
      }
    },
  });
  const discover = examples.list.bind(examples);
  let discoveryCalls = 0;
  examples.list = () => {
    discoveryCalls++;
    return discover();
  };
  const preparation = examples.prepare();
  await firstWave;
  resume();
  const warnings = await preparation;
  assert.equal(discoveryCalls, 1);
  assert.equal(maximum, 3);
  assert.equal(histories, entries.length + 1);
  assert.equal(warnings.length, 10 - entries.length);
  assert.equal(grants.find(files.get(entries[0].key)), existing);
  for (const entry of entries.slice(1)) assert.equal(grants.find(files.get(entry.key)), undefined);
  const opened = await examples.openDefault(entries[0].key);
  assert.equal(opened.fileId, existing);
});

test('example history stays private and destination-bound while original files retain edits', async (t) => {
  const { root, temporary, files, entries, grants } = await fixture(t);
  const data = path.join(temporary, 'profile');
  const history = new ProjectHistory(data, grants);
  t.after(() => history.close());
  const examples = new ExampleProjects(root, grants, history);
  const opened = await examples.openDefault(entries[0].key);
  const versions = await history.list(opened.fileId);
  assert.equal(versions.commits.length, 1);
  const modified = parseProject(opened.source);
  modified.name = 'Personal version';
  await history.create(opened.fileId, serializeProject(modified), 'Personal version');
  await examples.openDefault(entries[0].key);
  assert.equal((await history.list(opened.fileId)).commits.length, 2);
  assert.ok(
    (await readdir(path.join(data, 'project-history-v1'))).some((name) => name.endsWith('.git')),
  );
  assert.ok(!(await readdir(path.dirname(files.get(entries[0].key)!))).includes('history.git'));
  grants.assign(opened.fileId, path.join(temporary, 'personal.kicad_pro'));
  assert.equal(grants.isLocalExample(opened.fileId), false);
  assert.equal((await history.list(opened.fileId)).commits.length, 0);
});

test('unavailable Git reports a warning without replacing or losing original project files', async (t) => {
  const { root, files, entries, grants } = await fixture(t);
  const file = files.get(entries[0].key)!;
  const before = await readFile(file);
  const examples = new ExampleProjects(root, grants, {
    ensureExampleInitial: async () => {
      throw new Error('Git unavailable');
    },
  });
  const opened = await examples.openDefault(entries[0].key);
  assert.match(opened.warning ?? '', /Git.*unavailable/i);
  assert.equal(grants.get(opened.fileId), file);
  assert.deepEqual(await readFile(file), before);
});
