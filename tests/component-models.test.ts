import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createComponentModelStore } from '../server/component-models.mjs';
const data = Buffer.from('ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n');
async function fixtureDirectory(t: TestContext) {
  // The store verifies every ancestor. Keep fixtures within the readable workspace.
  const parent = path.resolve('test-results');
  await mkdir(parent, { recursive: true });
  assert.equal(path.relative(parent, await realpath(parent)), '');
  const root = await mkdtemp(path.join(parent, 'component-model-'));
  t.after(async () => {
    assert.equal(path.relative(root, await realpath(root)), '');
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

test('component STEP selection is content-addressed, portable through Save as and integrity checked', async (t) => {
  const root = await fixtureDirectory(t);
  const file = path.join(root, 'part.step');
  await writeFile(file, data);
  let conversions = 0;
  const store = createComponentModelStore(path.join(root, 'private'), async () => {
    conversions++;
    return { meshes: [] };
  });
  const selected = await store.importFile(file, new AbortController().signal);
  assert.match(selected.path, /^\$\{KIPRJMOD\}\/models\/[a-f0-9]{64}\.step$/);
  assert.equal(conversions, 1);
  const folder = path.join(root, 'project');
  await mkdir(folder);
  const target = path.join(folder, 'design.kicad_pro');
  const project = { pcb: { footprints: [{ models: [{ path: selected.path }] }] } };
  await store.prepare(project, target, undefined);
  assert.deepEqual(await store.read(selected.path, target), data);
  const second = path.join(root, 'copy');
  await mkdir(second);
  const dest = path.join(second, 'copy.kicad_pro');
  const reopened = createComponentModelStore(path.join(root, 'fresh-private'), async () =>
    assert.fail('Reading must not parse or import.'),
  );
  await reopened.prepare(project, dest, target);
  assert.deepEqual(await reopened.read(selected.path, dest), data);
  const stored = path.join(second, selected.path.slice('${KIPRJMOD}/'.length));
  await writeFile(stored, Buffer.from('ISO-10303-21; changed'));
  await assert.rejects(reopened.read(selected.path, dest), /integrity/);
  await assert.rejects(reopened.prepare(project, dest, target), /changed/);
  assert.equal((await readFile(stored)).toString(), 'ISO-10303-21; changed');
  for (const value of [
    '${KIPRJMOD}/../part.step',
    'C:/private.step',
    '${KIPRJMOD}/.private/part.step',
    'https://example.com/model.step',
  ])
    await assert.rejects(store.read(value, target));
});
test('component model selection rejects parser failures, binary files and linked sources', async (t) => {
  const root = await fixtureDirectory(t);
  const file = path.join(root, 'part.step');
  await writeFile(file, data);
  const store = createComponentModelStore(path.join(root, 'private'), async () => {
    throw new Error('Invalid STEP geometry');
  });
  await assert.rejects(store.importFile(file, new AbortController().signal), /Invalid STEP/);
  await writeFile(file, 'not STEP');
  await assert.rejects(store.importFile(file, new AbortController().signal), /not STEP/);
  await writeFile(file, data);
  const link = path.join(root, 'linked.step');
  try {
    await symlink(file, link);
  } catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code!)) {
      t.diagnostic('File links unavailable');
      return;
    }
    throw error;
  }
  await assert.rejects(store.importFile(link, new AbortController().signal), /without links/);
});

test('component model import allows a /var ancestor and rejects a replaced directory', async (t) => {
  const storeDir = await mkdtemp(path.join(os.tmpdir(), 'openpe-model-store-'));
  t.after(() => rm(storeDir, { recursive: true, force: true }));
  const file = path.join(storeDir, 'part.step');
  await writeFile(file, data);
  if (process.platform === 'darwin') {
    const canonical = await realpath(file);
    assert.notEqual(path.resolve(file), canonical);
    assert.match(path.resolve(file), /^\/var\//);
    assert.match(canonical, /^\/private\/var\//);
  }
  const store = createComponentModelStore(path.join(storeDir, 'private'), async () => ({ meshes: [] }));
  const selected = await store.importFile(file, new AbortController().signal);
  assert.match(selected.path, /^\$\{KIPRJMOD\}\/models\/[a-f0-9]{64}\.step$/);
  const real = path.join(storeDir, 'real');
  await mkdir(real);
  await writeFile(path.join(real, 'linked.step'), data);
  const link = path.join(storeDir, 'link');
  try {
    await symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code!)) return;
    throw error;
  }
  await assert.rejects(
    store.importFile(path.join(link, 'linked.step'), new AbortController().signal),
    /without links/,
  );
});
