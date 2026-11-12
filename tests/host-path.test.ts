import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { canonicalGrantPath, logicalSuffixOfCanonical } = createRequire(import.meta.url)(
  '../server/host-path.cjs',
);

test('canonical suffix accepts an ancestor prefix and follows the volume case probe', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openpe-host-path-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'openpe-host-path-outside-'));
  t.after(() =>
    Promise.all([directory, outside].map((folder) => rm(folder, { recursive: true, force: true }))),
  );
  const file = path.join(directory, 'Enclosure.step');
  await writeFile(file, 'ISO-10303-21;');
  const canonical = await realpath(file);
  assert.equal(logicalSuffixOfCanonical(path.resolve(file), canonical), true);
  const target = path.join(outside, 'real.step');
  await writeFile(target, 'ISO-10303-21;');
  const link = path.join(directory, 'linked.step');
  await symlink(target, link);
  assert.equal(logicalSuffixOfCanonical(path.resolve(link), await realpath(link)), false);
  const toggled = path.join(path.dirname(file), 'enclosure.STEP');
  const folds = canonicalGrantPath(file) === canonicalGrantPath(toggled);
  assert.equal(logicalSuffixOfCanonical(path.resolve(toggled), canonical), folds);
});
