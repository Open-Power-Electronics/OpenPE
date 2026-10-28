import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { homeExampleCatalog, homeExampleNativePath } from '../lib/home-examples';
import { referenceExamples } from '../lib/reference-catalog';
import { projectFromNativeFiles, projectNativeFiles } from '../lib/kicad-project';

const require = createRequire(import.meta.url);
const {
  readNativeProject,
  writeNativeProject,
  validateNativeFiles,
} = require('../electron/native-project.cjs');
const { FileGrants } = require('../electron/file-grants.cjs');
const atomicWrite = async (file: string, source: string | Buffer) => {
  const temporary = `${file}.tmp`;
  await writeFile(temporary, source);
  await (await import('node:fs/promises')).rename(temporary, file);
};
const bundle = (value = 'original') => ({
  entry: 'circuit.kicad_pro',
  files: [
    {
      name: 'circuit.kicad_pro',
      source: JSON.stringify({ meta: { filename: 'circuit.kicad_pro' }, value }),
    },
    { name: 'circuit.kicad_sch', source: `(kicad_sch (${value}))` },
    { name: 'circuit.kicad_pcb', source: `(kicad_pcb (${value}))` },
    { name: 'fp-lib-table', source: '(fp_lib_table)' },
  ],
});

test('native project reads bounded sibling sources and resolves a schematic to its project entry', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openpe-native-files-'));
  try {
    const expected = bundle();
    await writeNativeProject(path.join(directory, expected.entry), expected, atomicWrite);
    await writeFile(path.join(directory, 'circuit.kicad_prl'), '{"private":"settings"}');
    await writeFile(path.join(directory, 'other.kicad_pro'), '{}');
    await writeFile(path.join(directory, 'readme.md'), 'not project source');
    await mkdir(path.join(directory, 'models'));
    await writeFile(
      path.join(directory, 'models', 'amplifier.lib'),
      '.subckt amplifier 1 2\n.ends\n',
    );
    await writeFile(path.join(directory, 'models', 'body.step'), 'binary model is not text source');
    await mkdir(path.join(directory, 'history.git'));
    await writeFile(path.join(directory, 'history.git', 'ignored.lib'), 'private');
    const savedRun = path.join(directory, 'spice', 'circuit', 'a'.repeat(64));
    await mkdir(savedRun, { recursive: true });
    await writeFile(path.join(savedRun, 'circuit.cir'), '* private execution deck');
    await writeFile(path.join(savedRun, 'example-model-0.lib'), '.subckt private 1 2\n.ends\n');
    await writeFile(path.join(savedRun, 'waveforms.raw'), Buffer.from([0, 1, 2]));
    const savedThermal = path.join(directory, 'thermal', 'circuit', 'b'.repeat(64));
    await mkdir(savedThermal, { recursive: true });
    await writeFile(path.join(savedThermal, 'process.cir'), '* private thermal execution artifact');
    await writeFile(path.join(savedThermal, 'input.json'), '{"private":"thermal model"}');
    await writeFile(path.join(savedThermal, 'field.vtu'), '<VTKFile/>');
    expected.files.push({ name: 'models/amplifier.lib', source: '.subckt amplifier 1 2\n.ends\n' });
    const loaded = await readNativeProject(path.join(directory, 'circuit.kicad_sch'));
    assert.equal(loaded.entry, expected.entry);
    assert.deepEqual(
      loaded.files.sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name)),
      expected.files.sort((a, b) => a.name.localeCompare(b.name)),
    );
    await assert.rejects(readNativeProject(path.join(directory, 'readme.md')), /Choose a KiCad/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('native source names reject traversal, aliases, duplicate case and non-engineering files before writes', () => {
  for (const name of [
    '../circuit.kicad_sch',
    'C:/circuit.kicad_sch',
    'folder\\circuit.kicad_sch',
    'folder/../circuit.kicad_sch',
    'con.kicad_sch',
    'circuit.openpe.json',
    '.git/circuit.kicad_sch',
    'spice/circuit/circuit.cir',
    'upstream/input.kicad_sch',
  ]) {
    assert.throws(
      () => validateNativeFiles({ entry: name, files: [{ name, source: '' }] }),
      /Invalid/,
    );
  }
  assert.throws(
    () =>
      validateNativeFiles({
        entry: 'a.kicad_pro',
        files: [
          { name: 'a.kicad_pro', source: '{}' },
          { name: 'A.kicad_pro', source: '{}' },
        ],
      }),
    /duplicate/,
  );
});

test('same-folder KiCad project pairs open independently and schematic aliases select their owning grant', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openpe-native-neighbours-'));
  try {
    const entries = referenceExamples.slice(0, 2);
    for (const entry of entries)
      for (const extension of ['kicad_pro', 'kicad_sch', 'kicad_pcb']) {
        const name = `${entry.file}.${extension}`;
        await writeFile(
          path.join(directory, name),
          await readFile(path.resolve('examples', entry.file, name)),
        );
      }
    const grants = new FileGrants();
    const boards = new Set<string>();
    for (const entry of entries) {
      const filename = `${entry.file}.kicad_pro`,
        file = path.join(directory, filename);
      const loaded = await readNativeProject(file);
      assert.equal(loaded.entry, filename);
      assert.deepEqual(
        loaded.files.map((item: { name: string }) => item.name).sort(),
        ['kicad_pro', 'kicad_sch', 'kicad_pcb']
          .map((extension) => `${entry.file}.${extension}`)
          .sort(),
      );
      const project = projectFromNativeFiles(loaded);
      assert.ok(project.pcb);
      boards.add(project.pcb.id);
      assert.deepEqual(
        projectNativeFiles(project)
          .files.map((item) => item.name)
          .sort(),
        loaded.files.map((item: { name: string }) => item.name).sort(),
      );
      const fileId = grants.create(file);
      grants.setProjectFiles(
        fileId,
        loaded.files.map((item: { name: string }) => path.join(directory, item.name)),
      );
      const schematic = path.join(directory, `${entry.file}.kicad_sch`);
      assert.equal(grants.findOpen(schematic), fileId);
      assert.equal((await readNativeProject(schematic)).entry, filename);
    }
    assert.equal(boards.size, 2, 'Each project retains its own board.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('every checked-in Home project opens its own native design without collecting pinned upstream circuits', async () => {
  const grants = new FileGrants();
  for (const entry of homeExampleCatalog) {
    const destination = path.resolve(homeExampleNativePath(entry.id));
    const loaded = await readNativeProject(destination);
    assert.deepEqual(
      loaded.files
        .filter((item: { name: string }) => /\.kicad_(?:pro|sch|pcb)$/i.test(item.name))
        .map((item: { name: string }) => item.name)
        .sort(),
      ['kicad_pro', 'kicad_sch', 'kicad_pcb']
        .map((extension) => `${entry.file}.${extension}`)
        .sort(),
    );
    const project = projectFromNativeFiles(loaded);
    assert.ok(project.pcb);
    assert.ok(!loaded.files.some((item: { name: string }) => item.name.startsWith('upstream/')));
    assert.equal(projectNativeFiles(project).entry, loaded.entry);
    assert.equal(loaded.entry, `${entry.file}.kicad_pro`);
    assert.equal(
      JSON.parse(loaded.files.find((item: { name: string }) => item.name === loaded.entry).source)
        .meta.filename,
      loaded.entry,
    );
    const fileId = grants.create(destination);
    grants.setProjectFiles(
      fileId,
      loaded.files.map((item: { name: string }) =>
        path.resolve(path.dirname(destination), item.name),
      ),
    );
  }
});

test('nested circuit files require explicit Sheetfile ownership while nested auxiliary sources remain visible', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openpe-native-sheet-ownership-'));
  try {
    const root = bundle();
    root.files.find((item) => item.name === 'circuit.kicad_sch')!.source =
      '(kicad_sch (sheet (property "Sheetfile" "sheets/child.kicad_sch")))';
    await writeNativeProject(path.join(directory, root.entry), root, atomicWrite);
    await mkdir(path.join(directory, 'sheets'));
    for (const name of [
      'child.kicad_sch',
      'unrelated.kicad_sch',
      'unrelated.kicad_pcb',
      'library.kicad_sym',
    ])
      await writeFile(path.join(directory, 'sheets', name), `(source "${name}")`);
    const loaded = await readNativeProject(path.join(directory, root.entry));
    assert.ok(
      loaded.files.some((item: { name: string }) => item.name === 'sheets/child.kicad_sch'),
    );
    assert.ok(
      loaded.files.some((item: { name: string }) => item.name === 'sheets/library.kicad_sym'),
    );
    assert.ok(
      !loaded.files.some((item: { name: string }) => item.name.startsWith('sheets/unrelated')),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Latin-1 auxiliary model source retains original bytes through open, save and Save as', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openpe-native-encoding-'));
  try {
    const original = path.join(directory, 'original'),
      copy = path.join(directory, 'copy');
    await mkdir(original);
    await mkdir(copy);
    await writeNativeProject(path.join(original, 'circuit.kicad_pro'), bundle(), atomicWrite);
    const bytes = Buffer.from(
      '* Vendor model \u00b5 \u00a9\r\n.subckt device 1 2\r\n.ends\r\n',
      'latin1',
    );
    await writeFile(path.join(original, 'device.lib'), bytes);
    const loaded = await readNativeProject(path.join(original, 'circuit.kicad_pro'));
    const model = loaded.files.find((item: { name: string }) => item.name === 'device.lib');
    assert.equal(model.encoding, 'latin1');
    assert.equal(model.source, bytes.toString('latin1'));
    await writeNativeProject(path.join(original, 'circuit.kicad_pro'), loaded, atomicWrite);
    await writeNativeProject(path.join(copy, 'circuit.kicad_pro'), loaded, atomicWrite);
    assert.deepEqual(await readFile(path.join(original, 'device.lib')), bytes);
    assert.deepEqual(await readFile(path.join(copy, 'device.lib')), bytes);
    assert.throws(
      () =>
        validateNativeFiles({
          ...loaded,
          files: loaded.files.map((item: { name: string }) =>
            item.name === 'device.lib' ? { ...item, source: '\u03a9' } : item,
          ),
        }),
      /Invalid/,
    );
    assert.throws(
      () =>
        validateNativeFiles({
          entry: 'circuit.kicad_pro',
          files: [{ name: 'circuit.kicad_pro', source: '{}', encoding: 'latin1' }],
        }),
      /Invalid/,
    );
    await writeFile(path.join(original, 'circuit.kicad_sch'), Buffer.from([0x28, 0xb5, 0x29]));
    await assert.rejects(readNativeProject(path.join(original, 'circuit.kicad_pro')), /UTF-8/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('native project grants reserve every source file and release or replace that scope independently', () => {
  const grants = new FileGrants();
  const root = path.resolve('test-results', 'native-grants');
  const first = grants.create(path.join(root, 'a.kicad_pro'));
  grants.setProjectFiles(first, [
    path.join(root, 'a.kicad_pro'),
    path.join(root, 'shared.kicad_sch'),
  ]);
  assert.equal(grants.findOpen(path.join(root, 'shared.kicad_sch')), first);
  const second = grants.create(path.join(root, 'b.kicad_pro'));
  assert.throws(
    () => grants.setProjectFiles(second, [path.join(root, 'shared.kicad_sch')]),
    /another open project/,
  );
  grants.assign(first, path.join(root, 'copy.kicad_pro'));
  assert.equal(grants.findOpen(path.join(root, 'shared.kicad_sch')), undefined);
  grants.setProjectFiles(second, [path.join(root, 'shared.kicad_sch')]);
  grants.release(first);
  assert.equal(grants.findOpen(path.join(root, 'shared.kicad_sch')), second);
  grants.clear();
  assert.equal(grants.findOpen(path.join(root, 'shared.kicad_sch')), undefined);
});

test('a failed native project write restores every written sibling and leaves the entry untouched', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openpe-native-rollback-'));
  try {
    const file = path.join(directory, 'circuit.kicad_pro');
    await writeNativeProject(file, bundle(), atomicWrite);
    const changed = bundle('changed');
    let writes = 0;
    await assert.rejects(
      writeNativeProject(file, changed, async (target: string, source: string | Buffer) => {
        if (++writes === 2) throw new Error('Fixture write failure');
        await atomicWrite(target, source);
      }),
      /Fixture write failure/,
    );
    for (const item of bundle().files)
      assert.equal(await readFile(path.join(directory, item.name), 'utf8'), item.source);
    assert.ok(!(await readdir(directory)).some((name) => name.endsWith('.tmp')));
    await mkdir(path.join(directory, 'blocked.kicad_sch'));
    const invalid = {
      ...changed,
      files: [...changed.files, { name: 'blocked.kicad_sch', source: '' }],
    };
    writes = 0;
    await assert.rejects(
      writeNativeProject(file, invalid, async () => {
        writes++;
      }),
      /regular bounded/,
    );
    assert.equal(writes, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('revoked save grants roll back native writes without publishing the project entry', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openpe-native-revocation-'));
  try {
    let valid = true;
    await assert.rejects(
      writeNativeProject(
        path.join(directory, 'circuit.kicad_pro'),
        bundle(),
        async (target: string, source: string | Buffer) => {
          await atomicWrite(target, source);
          valid = false;
        },
        () => {
          if (!valid) throw new Error('Grant revoked');
        },
      ),
      /Grant revoked/,
    );
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('linked source folders are rejected for reads and writes before touching their targets', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openpe-native-links-'));
  try {
    const project = path.join(directory, 'project'),
      outside = path.join(directory, 'outside');
    await mkdir(project);
    await mkdir(outside);
    const entry = path.join(project, 'circuit.kicad_pro');
    await writeNativeProject(entry, bundle(), atomicWrite);
    await writeFile(path.join(outside, 'library.kicad_sym'), 'preserve external file');
    await symlink(outside, path.join(project, 'linked'), 'junction');
    await assert.rejects(readNativeProject(entry), /Linked|regular folder/);
    let writes = 0;
    await assert.rejects(
      writeNativeProject(
        entry,
        {
          ...bundle(),
          files: [...bundle().files, { name: 'linked/library.kicad_sym', source: 'replacement' }],
        },
        async () => {
          writes++;
        },
      ),
      /Linked|regular folder/,
    );
    assert.equal(writes, 0);
    assert.equal(
      await readFile(path.join(outside, 'library.kicad_sym'), 'utf8'),
      'preserve external file',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
