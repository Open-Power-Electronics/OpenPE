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
  await assert.rejects(readFile('examples/project/emc-flyback/emc-flyback.scad'), {
    code: 'ENOENT',
  });
  const reference = homeExampleCatalog.find((entry) => entry.id !== 'emc-flyback-demo')!;
  await assert.rejects(readFile(`examples/${reference.file}/datasheets/parameters.json`), {
    code: 'ENOENT',
  });
});

test('packaging keeps original designs and excludes vendor documents and model libraries', async () => {
  const configuration = JSON.parse(await readFile('package.json', 'utf8'));
  const examples = configuration.build.extraResources.find(
    (entry: { from: string; to: string }) =>
      entry.from === 'examples' && entry.to === 'examples-native',
  );
  assert.ok(
    examples,
    'Desktop packaging includes the same examples directory used in development.',
  );
  const projectResources = configuration.build.extraResources.find(
    (entry: { from: string; to: string }) =>
      entry.from === 'examples/project' && entry.to === 'project-native',
  );
  assert.ok(projectResources);
  const includes = (filter: string[], file: string) =>
    filter
      .filter((pattern: string) => !pattern.startsWith('!'))
      .some((pattern: string) => path.matchesGlob(file, pattern)) &&
    !filter
      .filter((pattern: string) => pattern.startsWith('!'))
      .some((pattern: string) => path.matchesGlob(file, pattern.slice(1)));
  for (const file of [
    'lm2596-to220-5-buck/datasheets/controller.pdf',
    'lm2596-to220-5-buck/models/LM2596.lib',
    'lm2596-to220-5-buck/models/ti/hash/controller.lib',
    'lm2596-to220-5-buck/attachments/LM2596-5.lib',
  ])
    assert.equal(includes(examples.filter, file), false, file);
  assert.equal(includes(projectResources.filter, 'emc-flyback/datasheets/controller.pdf'), false);
  assert.equal(includes(projectResources.filter, 'emc-flyback/models/ti/hash/controller.lib'), false);
  assert.equal(includes(examples.filter, 'project'), false);
  for (const file of [
    'emc-flyback/emc-flyback.kicad_pro',
    'emc-flyback/emc-flyback.kicad_sch',
    'emc-flyback/emc-flyback.kicad_pcb',
    'emc-flyback/emc-flyback.kicad_dru',
    'emc-flyback/footprints/EMC_Demo.pretty/device.kicad_mod',
    'emc-flyback/models/device.step',
    'emc-flyback/models/control.lib',
  ]) {
    assert.ok(includes(projectResources.filter, file), file);
    assert.equal(includes(examples.filter, 'project/' + file), false, file);
  }
  for (const file of [
    'spice-simulation/circuit.raw',
    'layout-thermal/circuit.vtu',
    'spice-simulation/circuit.example-model-0.lib',
    'spice-simulation/other-results/circuit.cir',
    '.git/config',
    'history.git/config',
    'circuit.kicad_prl',
  ]) {
    assert.equal(includes(projectResources.filter, `emc-flyback/${file}`), false, file);
    assert.equal(includes(examples.filter, `lm2596-to220-5-buck/${file}`), false, file);
  }
  assert.equal(
    configuration.build.extraResources.some(
      (entry: { from: string }) => entry.from === 'resources/examples/1',
    ),
    false,
  );
  assert.ok(configuration.build.files.includes('resources/example-catalog/manifest.json'));
  assert.ok(configuration.build.files.includes('server/**/*'));
  assert.equal(
    configuration.build.extraResources.some(
      (entry: { from: string; to: string }) =>
        entry.from === 'resources/example-catalog/simulation/models' ||
        entry.to.startsWith('simulation-examples/'),
    ),
    false,
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
});

test('packaging includes KiCad symbols, footprints and only the three starter STEP files', async () => {
  const configuration = JSON.parse(await readFile('package.json', 'utf8'));
  const { filter } = configuration.build.extraResources.find(
    (entry: { from: string }) => entry.from === 'resources/kicad/10.0.0',
  );
  const includes = (file: string) =>
    filter.some((pattern: string) => !pattern.startsWith('!') && path.matchesGlob(file, pattern));
  for (const file of [
    'library-index.json',
    'symbols/Device.kicad_sym',
    'footprints/Resistor_SMD.pretty/R_0805_2012Metric.kicad_mod',
    'models/LICENSE.md',
    'models/Resistor_SMD.3dshapes/R_0805_2012Metric.step',
    'models/Capacitor_SMD.3dshapes/C_0805_2012Metric.step',
    'models/Package_TO_SOT_SMD.3dshapes/SOT-23.step',
  ])
    assert.ok(includes(file), file);
  assert.equal(includes('models/Package_SO.3dshapes/SOIC-8.step'), false);
  assert.equal(includes('models/openpe-source.json'), false);
});

test('ngspice packaging matches each platform lock and keeps Windows files on win', async () => {
  const configuration = JSON.parse(await readFile('package.json', 'utf8'));
  const lock = JSON.parse(await readFile('resources/ngspice-lock.json', 'utf8'));
  const ngspiceFilter = (entries: { from: string; to: string; filter: string[] }[]) =>
    entries.find((entry) => entry.from === 'resources/ngspice/47' && entry.to === 'ngspice/47')!
      .filter;
  assert.deepEqual(
    ngspiceFilter(configuration.build.win.extraResources),
    Object.keys(lock.platforms['win32-x64'].files),
  );
  assert.deepEqual(
    ngspiceFilter(configuration.build.mac.extraResources),
    Object.keys(lock.platforms['darwin-arm64'].files),
  );
  assert.deepEqual(
    ngspiceFilter(configuration.build.linux.extraResources),
    Object.keys(lock.platforms['linux-x64'].files),
  );
  assert.deepEqual(ngspiceFilter(configuration.build.extraResources), [
    'manifest.json',
    'SOURCE-NOTICE.txt',
  ]);
  assert.equal(
    configuration.build.extraResources.some((entry: { filter?: string[] }) =>
      entry.filter?.includes('Spice64/bin/ngspice_con.exe'),
    ),
    false,
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
