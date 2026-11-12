import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { atomicWrite } from '../server/atomic-write.mjs';

async function directory(t: test.TestContext) {
  const parent = path.resolve('test-results');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'atomic-write-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('atomic writes replace text and binary content without leaving temporary siblings', async (t) => {
  const root = await directory(t);
  const file = path.join(root, 'project');
  await writeFile(file, 'previous revision');
  await atomicWrite(file, 'Schematic · 电路');
  assert.equal(await readFile(file, 'utf8'), 'Schematic · 电路');
  const bytes = Buffer.from([0, 255, 128, 10, 13]);
  await atomicWrite(file, bytes);
  assert.deepEqual(await readFile(file), bytes);
  assert.deepEqual(await readdir(root), ['project']);
});

test('failed replacement preserves the destination and removes the temporary file', async (t) => {
  const root = await directory(t);
  const destination = path.join(root, 'existing');
  await mkdir(destination);
  await writeFile(path.join(destination, 'retained'), 'original');
  await assert.rejects(atomicWrite(destination, 'replacement'));
  assert.equal(await readFile(path.join(destination, 'retained'), 'utf8'), 'original');
  assert.deepEqual(await readdir(root), ['existing']);
});

test('a temporary-name collision preserves the file owned by another write', async (t) => {
  const root = await directory(t);
  const file = path.join(root, 'project');
  const temporary = file + '.000000000000.tmp';
  await writeFile(file, 'accepted revision');
  await writeFile(temporary, 'another writer');
  const random = t.mock.method(crypto, 'randomBytes', () => Buffer.alloc(6));
  syncBuiltinESMExports();
  try {
    await assert.rejects(atomicWrite(file, 'replacement'), { code: 'EEXIST' });
    assert.equal(await readFile(file, 'utf8'), 'accepted revision');
    assert.equal(await readFile(temporary, 'utf8'), 'another writer');
  } finally {
    random.mock.restore();
    syncBuiltinESMExports();
  }
});

test('a contained missing file is created without following a symlink', async (t) => {
  const root = await directory(t);
  const canonical = await realpath(root);
  const file = path.join(root, 'fresh.csv');
  await atomicWrite(file, 'created', async () => {}, {
    parentCanonical: canonical,
    message: 'linked',
  });
  assert.equal(await readFile(file, 'utf8'), 'created');
  const target = path.join(root, 'kept.csv');
  await writeFile(target, 'kept');
  const link = path.join(root, 'link.csv');
  await symlink(target, link);
  await assert.rejects(
    atomicWrite(link, 'changed', async () => {}, { parentCanonical: canonical, message: 'linked' }),
    /linked/,
  );
  assert.equal(await readFile(target, 'utf8'), 'kept');
  const outside = await mkdtemp(path.join(path.dirname(root), 'atomic-write-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const jump = path.join(root, 'jump');
  await symlink(outside, jump);
  await assert.rejects(
    atomicWrite(path.join(jump, 'out.csv'), 'nope', async () => {}, {
      parentCanonical: canonical,
      message: 'linked',
    }),
    /linked/,
  );
  assert.deepEqual(await readdir(outside), []);
});
