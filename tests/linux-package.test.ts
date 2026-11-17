import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const afterPack = createRequire(import.meta.url)('../build/after-pack.cjs');

test(
  'Linux packages stay readable after root-owned installation with a restrictive build umask',
  { skip: process.platform === 'win32' },
  async (context) => {
    const previousUmask = process.umask(0o077);
    context.after(() => process.umask(previousUmask));
    const root = await mkdtemp(path.join(os.tmpdir(), 'openpe-linux-package-'));
    context.after(() => rm(root, { recursive: true, force: true }));
    const resources = path.join(root, 'resources');
    await mkdir(resources, { mode: 0o700 });
    const manifest = path.join(resources, 'manifest.json');
    const executable = path.join(root, 'openpe');
    await writeFile(manifest, '{}', { mode: 0o600 });
    await writeFile(executable, 'native executable fixture', { mode: 0o700 });
    await afterPack({ electronPlatformName: 'darwin', appOutDir: root });
    assert.equal(process.umask(), 0o077);
    assert.equal((await stat(manifest)).mode & 0o777, 0o600);
    await afterPack({ electronPlatformName: 'linux', appOutDir: root });
    assert.equal(process.umask(), 0o022);
    const desktopEntry = path.join(root, 'openpe.desktop');
    await writeFile(desktopEntry, '[Desktop Entry]');
    assert.equal((await stat(desktopEntry)).mode & 0o777, 0o644);
    assert.equal((await stat(resources)).mode & 0o777, 0o755);
    assert.equal((await stat(manifest)).mode & 0o777, 0o644);
    assert.equal((await stat(executable)).mode & 0o777, 0o755);
    const outside = path.join(root, 'outside');
    await writeFile(outside, 'outside fixture');
    await chmod(outside, 0o600);
    await symlink(outside, path.join(resources, 'linked-resource'));
    await assert.rejects(
      afterPack({ electronPlatformName: 'linux', appOutDir: resources }),
      /link or special file/,
    );
    assert.equal(
      (await stat(outside)).mode & 0o777,
      0o600,
      'A package link cannot chmod its target.',
    );
  },
);
