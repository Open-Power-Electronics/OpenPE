import { resolveExampleModelRelative } from '../lib/example-model-paths';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
  symlink,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assets from '../resources/example-catalog/footprints/manifest.json';
import { createHomeExample } from '../lib/create-home-example';
import { projectNativeFiles } from '../lib/project';
import { prepareExampleFootprints, cleanupExampleLayout } from '../server/example-footprints.mjs';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'openpe-example-layout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = createHomeExample('reference-lm25017-wson8-flybuck', (id) => id);
  const bundle = projectNativeFiles(project, 'project.kicad_pro');
  const destination = path.join(directory, bundle.entry);
  const put = async (name: string, bytes: string | Buffer) => {
    const target = path.join(directory, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  };
  for (const file of bundle.files)
    await put(file.name, Buffer.from(file.source, file.encoding ?? 'utf8'));
  await prepareExampleFootprints(project, destination);
  await assert.rejects(readFile(path.join(directory, 'NOTICE.txt')), { code: 'ENOENT' });
  return { directory, project, bundle, destination, put };
}

test('example layout removes verified old copies and empty parents, preserving unknown files and results', async (t) => {
  const { directory, project, bundle, destination, put } = await fixture(t);
  const custom = bundle.files.find((file) => file.name.endsWith('.kicad_mod'))!;
  const oldCustom = custom.name.replace('footprints/', '');
  await put(
    oldCustom,
    custom.source.replaceAll('${KIPRJMOD}/models/', '${KIPRJMOD}/footprints/models/'),
  );
  const model = project
    .pcb!.footprints.flatMap((fp) => fp.models ?? [])[0]
    .path.replace('${KIPRJMOD}/', '');
  const relative = resolveExampleModelRelative(Object.keys(assets.models), '${KIPRJMOD}/' + model)!;
  const oldModel = 'models/' + relative;
  const oldFlatModel = 'footprints/' + path.basename(model);
  const oldThreeDModel = '3D/' + path.basename(model);
  await put(oldModel, await readFile(path.join(directory, model)));
  await put('footprints/models/' + relative, await readFile(path.join(directory, model)));
  await put(oldFlatModel, await readFile(path.join(directory, model)));
  await put(oldThreeDModel, await readFile(path.join(directory, model)));
  const legacyAlias = 'footprints/Inductor_SMD_Wurth.pretty/' + path.basename(custom.name);
  await put(legacyAlias, custom.source);
  await put(
    'footprints/LICENSE.md',
    await readFile('resources/example-catalog/footprints/LICENSE.md'),
  );
  await put('footprints/notes.txt', 'personal notes');
  await put('footprints/personal.step', 'personal STEP model');
  await put('3D/personal.step', 'personal transition STEP model');
  await put('models/personal.lib', 'personal SPICE model');
  await put(
    'licenses/footprints/LICENSE.md',
    await readFile('resources/example-catalog/footprints/LICENSE.md'),
  );
  await put('licenses/personal.txt', 'personal license annotation');
  await put('spice/result.txt', 'saved simulation');
  await put('thermal/result.txt', 'saved thermal');
  const legacyDocuments = await Promise.all(
    ['CREDITS.md', 'LICENSE.md', 'NOTICE.txt'].map(
      async (name) =>
        '===== licenses/footprints/' +
        name +
        ' =====\n' +
        (await readFile('resources/example-catalog/footprints/' + name, 'utf8')) +
        '\n\n',
    ),
  );
  await put(
    'NOTICE.txt',
    'OpenPE project asset notices\n\nOriginal license terms, credits and provenance are reproduced below. Section names identify their bundled source documents.\n\n' +
      legacyDocuments.join(''),
  );
  await cleanupExampleLayout(project, destination, bundle);
  for (const name of [
    oldCustom,
    oldModel,
    oldFlatModel,
    oldThreeDModel,
    'footprints/models',
    'project.pretty',
    legacyAlias,
    'footprints/Inductor_SMD_Wurth.pretty',
    'footprints/LICENSE.md',
    'NOTICE.txt',
  ])
    await assert.rejects(readFile(path.join(directory, name)), { code: 'ENOENT' });
  assert.equal(
    await readFile(path.join(directory, 'models/personal.lib'), 'utf8'),
    'personal SPICE model',
  );
  assert.equal(
    await readFile(path.join(directory, 'licenses/personal.txt'), 'utf8'),
    'personal license annotation',
  );
  await assert.rejects(readFile(path.join(directory, 'licenses/footprints/LICENSE.md')), {
    code: 'ENOENT',
  });
  assert.equal(
    await readFile(path.join(directory, 'footprints/notes.txt'), 'utf8'),
    'personal notes',
  );
  assert.equal(
    await readFile(path.join(directory, 'footprints/personal.step'), 'utf8'),
    'personal STEP model',
  );
  assert.equal(
    await readFile(path.join(directory, '3D/personal.step'), 'utf8'),
    'personal transition STEP model',
  );
  assert.equal(
    await readFile(path.join(directory, 'spice/result.txt'), 'utf8'),
    'saved simulation',
  );
  assert.equal(await readFile(path.join(directory, 'thermal/result.txt'), 'utf8'), 'saved thermal');
  await cleanupExampleLayout(project, destination, bundle);
});

test('example cleanup preserves changed copies and waits for the complete published native set', async (t) => {
  const { directory, project, bundle, destination, put } = await fixture(t);
  const custom = bundle.files.find((file) => file.name.endsWith('.kicad_mod'))!;
  const oldName = custom.name.replace('footprints/', '');
  const model = project
    .pcb!.footprints.flatMap((fp) => fp.models ?? [])[0]
    .path.replace('${KIPRJMOD}/', '');
  const modelBytes = await readFile(path.join(directory, model));
  const oldFlatModel = 'footprints/' + path.basename(model);
  const oldThreeDModel = '3D/' + path.basename(model);
  await put(oldName, custom.source + '\n; personal change\n');
  await put(oldFlatModel, 'personal STEP changes');
  await put(oldThreeDModel, 'personal transition STEP changes');
  await put('NOTICE.txt', 'Personal project note');
  await cleanupExampleLayout(project, destination, bundle);
  assert.match(await readFile(path.join(directory, oldName), 'utf8'), /personal change/);
  assert.equal(await readFile(path.join(directory, 'NOTICE.txt'), 'utf8'), 'Personal project note');
  assert.equal(await readFile(path.join(directory, oldFlatModel), 'utf8'), 'personal STEP changes');
  assert.equal(
    await readFile(path.join(directory, oldThreeDModel), 'utf8'),
    'personal transition STEP changes',
  );
  await put(oldFlatModel, modelBytes);
  await put(oldThreeDModel, modelBytes);
  await unlink(path.join(directory, model));
  await cleanupExampleLayout(project, destination, bundle);
  assert.deepEqual(
    await readFile(path.join(directory, oldFlatModel)),
    modelBytes,
    'A matching legacy STEP survives until its replacement has been published.',
  );
  assert.deepEqual(await readFile(path.join(directory, oldThreeDModel)), modelBytes);
  await put(model, modelBytes);
  await put(oldName, custom.source);
  await put('project.kicad_sch', 'unsaved or different native design');
  await cleanupExampleLayout(project, destination, bundle);
  assert.equal(await readFile(path.join(directory, oldName), 'utf8'), custom.source);
  assert.deepEqual(
    await readFile(path.join(directory, oldFlatModel)),
    modelBytes,
    'Native publication must complete before an old flat STEP copy can be removed.',
  );
  assert.deepEqual(await readFile(path.join(directory, oldThreeDModel)), modelBytes);
});

for (const prefix of ['footprints/', '3D/'])
  test(`cleanup retains a still-used ${prefix} STEP path even when a models/ copy exists`, async (t) => {
    const { directory, project, destination, put } = await fixture(t);
    const legacy = structuredClone(project);
    const model = legacy.pcb!.footprints.flatMap((fp) => fp.models ?? [])[0];
    const current = model.path.replace('${KIPRJMOD}/', '');
    const oldFlatModel = prefix + path.basename(current);
    const bytes = await readFile(path.join(directory, current));
    model.path = '${KIPRJMOD}/' + oldFlatModel;
    await prepareExampleFootprints(legacy, destination);
    const bundle = projectNativeFiles(legacy, path.basename(destination));
    for (const file of bundle.files)
      await put(file.name, Buffer.from(file.source, file.encoding ?? 'utf8'));
    await cleanupExampleLayout(legacy, destination, bundle);
    assert.deepEqual(await readFile(path.join(directory, oldFlatModel)), bytes);
    assert.deepEqual(await readFile(path.join(directory, current)), bytes);
  });

test('legacy model references are copied to their original location and cleanup rejects linked paths', async (t) => {
  const { directory, project, bundle, destination } = await fixture(t);
  const legacy = structuredClone(project);
  for (const fp of legacy.pcb!.footprints)
    for (const model of fp.models ?? [])
      model.path =
        '${KIPRJMOD}/footprints/models/' +
        resolveExampleModelRelative(Object.keys(assets.models), model.path)!;
  await prepareExampleFootprints(legacy, destination);
  const model = legacy
    .pcb!.footprints.flatMap((fp) => fp.models ?? [])[0]
    .path.replace('${KIPRJMOD}/', '');
  assert.ok((await readFile(path.join(directory, model))).length);
  const custom = bundle.files.find((file) => file.name.endsWith('.kicad_mod'))!;
  const external = path.join(directory, 'external');
  await mkdir(external);
  await writeFile(path.join(external, path.basename(custom.name)), custom.source);
  await symlink(external, path.join(directory, 'project.pretty'), 'junction');
  await assert.rejects(cleanupExampleLayout(project, destination, bundle), /linked paths/);
  assert.equal((await readdir(external)).length, 1);
});
