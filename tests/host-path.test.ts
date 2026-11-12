import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, open, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const {
  assertCanonicalParent,
  assertContainedPath,
  canonicalDirectory,
  canonicalGrantPath,
  containedCreateFlags,
  logicalSuffixOfCanonical,
} = createRequire(import.meta.url)('../server/host-path.cjs');

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

test('a missing contained file rechecks its parent and exclusive create does not follow a symlink', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'openpe-host-path-create-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'openpe-host-path-create-out-'));
  t.after(() =>
    Promise.all([root, outside].map((folder) => rm(folder, { recursive: true, force: true }))),
  );
  const rooted = await canonicalDirectory(root, { message: 'linked' });
  const missing = path.join(root, 'fresh.csv');
  assert.equal(
    await assertContainedPath(rooted, missing, { message: 'linked', kind: 'file', allowMissing: true }),
    path.join(rooted.canonical, 'fresh.csv'),
  );
  await assertCanonicalParent(rooted.canonical, rooted.canonical, 'linked');
  await assert.rejects(assertCanonicalParent(rooted.canonical, path.join(rooted.canonical, 'other'), 'linked'), /linked/);
  const jump = path.join(root, 'jump');
  await symlink(outside, jump);
  await assert.rejects(
    assertContainedPath(rooted, path.join(jump, 'out.csv'), {
      message: 'linked',
      kind: 'file',
      allowMissing: true,
    }),
    /linked/,
  );
  const link = path.join(root, 'link.csv');
  await symlink('missing.csv', link);
  await assert.rejects(open(link, containedCreateFlags()));
  await assert.rejects(stat(path.join(root, 'missing.csv')), { code: 'ENOENT' });
});
