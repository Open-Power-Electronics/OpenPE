import test from 'node:test';
import assert from 'node:assert/strict';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { writeGeneratedFile } from '../scripts/write-generated-file.mjs';

test('generated files retain identity only when complete bytes match', async (t) => {
  const parent = path.resolve('test-results');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, 'generated-file-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith('generated-file-test-'));
    assert.ok(!(await lstat(root)).isSymbolicLink());
    await rm(root, { recursive: true });
  });
  const file = path.join(root, 'format.mjs');
  const contents = 'export const value = "Ω";\n';
  assert.equal(await writeGeneratedFile(file, contents), true);
  await utimes(file, new Date(0), new Date(0));
  const before = await stat(file);
  assert.equal(await writeGeneratedFile(file, Buffer.from(contents)), false);
  const unchanged = await stat(file);
  assert.equal(unchanged.ino, before.ino);
  assert.equal(unchanged.mtimeMs, before.mtimeMs);
  assert.equal(unchanged.ctimeMs, before.ctimeMs);

  // A same-length edit with the original mtime still needs replacement.
  await writeFile(file, contents.replace('value', 'other'));
  await utimes(file, before.atime, before.mtime);
  assert.equal((await stat(file)).size, before.size);
  assert.equal(await writeGeneratedFile(file, new Uint8Array(Buffer.from(contents))), true);
  assert.equal(await readFile(file, 'utf8'), contents);
  assert.deepEqual(await readdir(root), ['format.mjs']);
});
