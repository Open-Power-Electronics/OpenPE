import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { homeExampleCatalog, homeExampleNativePath } from '../lib/home-examples';
import { projectFromNativeFiles } from '../lib/project';
import { verifyExampleFootprints } from '../server/example-footprints.mjs';
import footprintManifest from '../resources/example-catalog/footprints/manifest.json';
const { readNativeProject } = createRequire(import.meta.url)('../electron/native-project.cjs');

async function temporary(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'openpe-prepared-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('all ten original examples retain their actual native filenames and parse as current projects', async () => {
  assert.equal(homeExampleCatalog.length, 10);
  for (const entry of homeExampleCatalog) {
    const native = await readNativeProject(path.resolve(homeExampleNativePath(entry.id)));
    assert.equal(native.entry, `${entry.file}.kicad_pro`);
    const project = projectFromNativeFiles(native);
    assert.equal(project.nativeFiles!.entry, native.entry);
    assert.ok(
      native.files.some((file: { name: string }) => file.name === `${entry.file}.kicad_sch`),
    );
    assert.ok(
      native.files.some((file: { name: string }) => file.name === `${entry.file}.kicad_pcb`),
    );
    assert.ok(
      native.files.every(
        (file: { name: string }) => !file.name.endsWith('.scad') && !file.name.endsWith('.pdf'),
      ),
    );
  }
  await assert.rejects(readFile('emc-flyback/emc-flyback.scad'), { code: 'ENOENT' });
  const reference = homeExampleCatalog.find((entry) => entry.id !== 'emc-flyback-demo')!;
  await assert.rejects(readFile(`examples/${reference.file}/datasheets/parameters.json`), {
    code: 'ENOENT',
  });
});

test('packaging retains the original examples tree including documents and optional PDF files', async () => {
  const configuration = JSON.parse(await readFile('package.json', 'utf8'));
  const examples = configuration.build.extraResources.find(
    (entry: { from: string; to: string }) =>
      entry.from === 'examples' && entry.to === 'examples-native',
  );
  assert.ok(
    examples,
    'Desktop packaging includes the same examples directory used in development.',
  );
  const recent = configuration.build.extraResources.find(
    (entry: { from: string; to: string }) =>
      entry.from === 'recent' && entry.to === 'recent-native',
  );
  assert.ok(recent);
  assert.deepEqual(recent.filter, examples.filter);
  const includes = (file: string) =>
    examples.filter
      .filter((pattern: string) => !pattern.startsWith('!'))
      .some((pattern: string) => path.matchesGlob(file, pattern)) &&
    !examples.filter
      .filter((pattern: string) => pattern.startsWith('!'))
      .some((pattern: string) => path.matchesGlob(file, pattern.slice(1)));
  for (const file of [
    'emc-flyback/emc-flyback.kicad_pro',
    'emc-flyback/emc-flyback.kicad_sch',
    'emc-flyback/emc-flyback.kicad_pcb',
    'emc-flyback/emc-flyback.kicad_dru',
    'emc-flyback/footprints/EMC_Demo.pretty/device.kicad_mod',
    'emc-flyback/models/device.step',
    'lm2596-to220-5-buck/datasheets/controller.pdf',
  ])
    assert.ok(includes(file), file);
  for (const file of [
    'emc-flyback/spice/emc-flyback.raw',
    'emc-flyback/thermal/emc-flyback.vtu',
    'emc-flyback/.git/config',
    'emc-flyback/history.git/config',
    'emc-flyback/emc-flyback.kicad_prl',
  ])
    assert.equal(includes(file), false, file);
  assert.equal(
    configuration.build.extraResources.some(
      (entry: { from: string }) => entry.from === 'resources/examples/1',
    ),
    false,
  );
  assert.ok(configuration.build.files.includes('resources/example-catalog/manifest.json'));
  assert.ok(configuration.build.files.includes('server/**/*'));
  assert.ok(
    configuration.build.extraResources.some(
      (entry: { from: string; to: string }) =>
        entry.from === 'public/licenses/ti-models.txt' &&
        entry.to === 'simulation-examples/NOTICE.txt',
    ),
  );
});

test('packaging keeps pinned manufacturer models and notices beside their shared catalog sources', async () => {
  const configuration = JSON.parse(await readFile('package.json', 'utf8'));
  const footprintResources = 'resources/example-catalog/footprints/**/*';
  assert.ok(configuration.build.files.includes(footprintResources));
  const manufacturerRoot = 'resources/example-catalog/footprints/emc-flyback';
  const supplements: { models: Record<string, { file: string }>; licenses: { file: string }[] } =
    JSON.parse(await readFile(`${manufacturerRoot}/manifest.json`, 'utf8'));
  assert.ok(Object.keys(supplements.models).length > 0);
  assert.ok(supplements.licenses.length > 0);
  for (const file of [
    'manifest.json',
    ...Object.values(supplements.models).map((model) => model.file),
    ...supplements.licenses.map((notice) => notice.file),
  ])
    assert.ok(path.matchesGlob(path.posix.join(manufacturerRoot, file), footprintResources), file);
  assert.ok(
    configuration.build.files.includes(
      'resources/example-catalog/sources/emc-flyback/design/EMC_Demo.pretty/**/*',
    ),
  );
  assert.ok(
    configuration.build.extraResources.some(
      (entry: { from: string; to: string; filter: string[] }) =>
        entry.from === 'resources/example-catalog/simulation/models' &&
        entry.to === 'simulation-examples/models' &&
        entry.filter.length === 1 &&
        entry.filter[0] === '*.lib',
    ),
  );
});

test('build verification requires every pinned footprint/model asset and matching hashes', async (t) => {
  assert.equal(await verifyExampleFootprints(), 50);
  const directory = await temporary(t);
  await assert.rejects(verifyExampleFootprints(directory), /ENOENT/);
  const first = footprintManifest.footprints.find((entry) => entry.file)!;
  const file = path.join(directory, first.file!);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'changed pinned package');
  await assert.rejects(verifyExampleFootprints(directory), /checksum mismatch/);
});
