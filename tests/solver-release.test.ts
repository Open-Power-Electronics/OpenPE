import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { create } from 'tar';
import {
  approvedReleaseRedirect,
  assertPinnedLocalArchive,
  downloadReleaseAsset,
  extractVerifiedArchive,
  packSolverArchive,
  parseSolverPrepareArgs,
  sha256File,
  solverEntryPath,
  SOLVER_ARCHIVE_EPOCH,
} from '../scripts/solver-release.mjs';

const tag = 'solvers-fixture-1';
const name = 'fixture-1.tar.gz';

test('solver release redirects allow GitHub asset hosts and reject every other host', () => {
  const release = `https://github.com/fleaxiao/OpenPE/releases/download/${tag}/${name}`;
  assert.equal(
    approvedReleaseRedirect(release, 'https://objects.githubusercontent.com/github-production-release-asset/1'),
    true,
  );
  assert.equal(
    approvedReleaseRedirect(release, 'https://release-assets.githubusercontent.com/github-production-release-asset/1'),
    true,
  );
  assert.equal(approvedReleaseRedirect(release, 'https://github.com/fleaxiao/OpenPE/releases/download/x/y'), true);
  assert.equal(approvedReleaseRedirect(release, 'https://codeload.github.com/fleaxiao/OpenPE/tar.gz/x'), false);
  assert.equal(approvedReleaseRedirect(release, 'https://example.com/archive.tar.gz'), false);
  assert.equal(approvedReleaseRedirect(release, 'http://objects.githubusercontent.com/archive'), false);
  assert.equal(approvedReleaseRedirect('http://127.0.0.1:9/a/b', 'https://objects.githubusercontent.com/a'), false);
  assert.throws(() => solverEntryPath('../secret'), /Invalid solver archive entry/);
});

async function listen(handler: (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server has no port.');
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

test('solver release download verifies a local archive and follows only the approved redirect', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openpe-solver-release-'));
  try {
    await mkdir(path.join(root, 'bin'));
    await writeFile(path.join(root, 'bin', 'tool'), 'solver');
    const fileHash = (await sha256File(path.join(root, 'bin', 'tool')))!;
    const files = { 'bin/tool': fileHash.sha256 };
    const first = path.join(root, 'first.tar.gz');
    const second = path.join(root, 'second.tar.gz');
    const packed = await packSolverArchive({ root, files, archive: first });
    const again = await packSolverArchive({ root, files, archive: second });
    if (!packed || !again) throw new Error('Solver archive packing did not return a digest.');
    assert.equal(again.sha256, packed.sha256);
    assert.equal(again.size, packed.size);
    assert.equal(SOLVER_ARCHIVE_EPOCH, 1786424074);
    const bytes = await readFile(first);
    const served = await listen((request, response) => {
      if (request.url === `/${tag}/${name}`) {
        response.writeHead(302, { Location: '/payload' });
        response.end();
        return;
      }
      if (request.url === '/payload') {
        response.writeHead(200, { 'Content-Length': String(bytes.length) });
        response.end(bytes);
        return;
      }
      if (request.url === '/missing/absent.tar.gz') {
        response.writeHead(404);
        response.end('missing');
        return;
      }
      if (request.url === '/bad/redirect.tar.gz') {
        response.writeHead(302, { Location: 'https://example.com/archive.tar.gz' });
        response.end();
        return;
      }
      response.writeHead(500);
      response.end('unexpected');
    });
    try {
      const destination = path.join(root, 'cache.tar.gz');
      await downloadReleaseAsset({
        url: `${served.origin}/${tag}/${name}`,
        sha256: packed.sha256,
        size: packed.size,
        file: destination,
      });
      const staged = path.join(root, 'staged');
      await mkdir(staged);
      await extractVerifiedArchive({ archive: destination, destination: staged, files });
      assert.equal(await readFile(path.join(staged, 'bin/tool'), 'utf8'), 'solver');
      await assert.rejects(
        downloadReleaseAsset({
          url: `${served.origin}/missing/absent.tar.gz`,
          sha256: packed.sha256,
          size: packed.size,
          file: path.join(root, 'missing.tar.gz'),
        }),
        /Missing GitHub release asset absent\.tar\.gz from tag missing\./,
      );
      await assert.rejects(
        downloadReleaseAsset({
          url: `${served.origin}/bad/redirect.tar.gz`,
          sha256: packed.sha256,
          size: packed.size,
          file: path.join(root, 'redirect.tar.gz'),
        }),
        /Unapproved solver release redirect/,
      );
    } finally {
      await served.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('solver archive extraction rejects an extra entry and a symlink', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'openpe-solver-entry-'));
  try {
    await mkdir(path.join(root, 'bin'));
    await writeFile(path.join(root, 'bin', 'tool'), 'solver');
    await writeFile(path.join(root, 'extra.txt'), 'extra');
    const hash = (await sha256File(path.join(root, 'bin', 'tool')))!.sha256;
    const archive = path.join(root, 'extra.tar.gz');
    await create(
      {
        cwd: root,
        file: archive,
        portable: true,
        gzip: true,
        mtime: new Date(SOLVER_ARCHIVE_EPOCH * 1000),
      },
      ['bin/tool', 'extra.txt'],
    );
    await assert.rejects(
      extractVerifiedArchive({
        archive,
        destination: path.join(root, 'out'),
        files: { 'bin/tool': hash },
      }),
      /Unexpected solver archive entry extra\.txt/,
    );
    const linkRoot = path.join(root, 'linked');
    await mkdir(linkRoot);
    await symlink(path.join(root, 'bin', 'tool'), path.join(linkRoot, 'tool'));
    const linked = path.join(root, 'link.tar.gz');
    await create(
      {
        cwd: linkRoot,
        file: linked,
        portable: true,
        gzip: true,
        mtime: new Date(SOLVER_ARCHIVE_EPOCH * 1000),
      },
      ['tool'],
    );
    await assert.rejects(
      extractVerifiedArchive({
        archive: linked,
        destination: path.join(root, 'linked-out'),
        files: { tool: hash },
      }),
      /Unexpected solver archive entry tool|not a regular file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a local solver archive must match the pin and must be a regular file', async () => {
  const usage = 'Usage: node scripts/prepare-ngspice.mjs [--verify | --archive <path>]';
  assert.deepEqual(parseSolverPrepareArgs(['node', 'prepare', '--verify'], usage), {
    verify: true,
    archive: null,
  });
  assert.deepEqual(parseSolverPrepareArgs(['node', 'prepare', '--archive', 'solver.tar.gz'], usage), {
    verify: false,
    archive: 'solver.tar.gz',
  });
  assert.throws(
    () => parseSolverPrepareArgs(['node', 'prepare', '--verify', '--archive', 'a'], usage),
    /Usage/,
  );
  assert.throws(() => parseSolverPrepareArgs(['node', 'prepare', '--other'], usage), /Usage/);
  const root = await mkdtemp(path.join(tmpdir(), 'openpe-solver-local-'));
  try {
    const file = path.join(root, 'solver.tar.gz');
    await writeFile(file, 'pinned-archive');
    const pinned = await sha256File(file);
    if (!pinned) throw new Error('Local archive hash was not read.');
    assert.equal(
      await assertPinnedLocalArchive(file, { sha256: pinned.sha256, size: pinned.size }),
      path.resolve(file),
    );
    const link = path.join(root, 'solver-link.tar.gz');
    await symlink(file, link);
    await assert.rejects(
      assertPinnedLocalArchive(link, { sha256: pinned.sha256, size: pinned.size }),
      /regular file/,
    );
    await assert.rejects(
      assertPinnedLocalArchive(file, { sha256: '0'.repeat(64), size: pinned.size }),
      /SHA-256/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
