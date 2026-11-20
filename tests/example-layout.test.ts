import { resolveExampleModelRelative } from '../lib/example-model-paths';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assets from '../resources/example-catalog/footprints/manifest.json';
import { createHomeExample } from '../lib/create-home-example';
import { projectNativeFiles } from '../lib/project';
import { prepareExampleFootprints } from '../server/example-footprints.mjs';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'openpe-example-layout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = createHomeExample('reference-lm25017-wson8-flybuck', (id) => id);
  const bundle = projectNativeFiles(project, 'project.kicad_pro');
  const destination = path.join(directory, bundle.entry);
  for (const file of bundle.files) {
    const target = path.join(directory, file.name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(file.source, file.encoding ?? 'utf8'));
  }
  return { directory, project, destination };
}

test('example preparation copies pinned models beside the project without notices or licenses', async (t) => {
  const { directory, project, destination } = await fixture(t);
  await prepareExampleFootprints(project, destination);
  const model = project
    .pcb!.footprints.flatMap((fp) => fp.models ?? [])[0]
    .path.replace('${KIPRJMOD}/', '');
  assert.match(model, /^models\/[^/]+\.step$/);
  assert.ok((await readFile(path.join(directory, model))).length);
  await assert.rejects(readFile(path.join(directory, 'NOTICE.txt')), { code: 'ENOENT' });
  assert.equal((await readdir(directory)).includes('licenses'), false);
  await prepareExampleFootprints(project, destination);
});

test('example preparation keeps a pinned footprints/models/ reference at its native path', async (t) => {
  const { directory, project, destination } = await fixture(t);
  const pinned = structuredClone(project);
  for (const fp of pinned.pcb!.footprints)
    for (const model of fp.models ?? [])
      model.path =
        '${KIPRJMOD}/footprints/models/' +
        resolveExampleModelRelative(Object.keys(assets.models), model.path)!;
  await prepareExampleFootprints(pinned, destination);
  const model = pinned
    .pcb!.footprints.flatMap((fp) => fp.models ?? [])[0]
    .path.replace('${KIPRJMOD}/', '');
  assert.ok((await readFile(path.join(directory, model))).length);
});

test('example preparation preserves a differing existing asset', async (t) => {
  const { directory, project, destination } = await fixture(t);
  const model = project
    .pcb!.footprints.flatMap((fp) => fp.models ?? [])[0]
    .path.replace('${KIPRJMOD}/', '');
  await mkdir(path.dirname(path.join(directory, model)), { recursive: true });
  await writeFile(path.join(directory, model), 'personal STEP model');
  await assert.rejects(prepareExampleFootprints(project, destination), /differs/);
  assert.equal(await readFile(path.join(directory, model), 'utf8'), 'personal STEP model');
});
