import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
