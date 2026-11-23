import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { create, extract, list } from 'tar';

// Source date shared by the maintainer builds. Archive bytes must not depend on the clock.
export const SOLVER_ARCHIVE_EPOCH = 1786424074;
const SOLVER_ARCHIVE_MTIME = new Date(SOLVER_ARCHIVE_EPOCH * 1000);
const HASH = /^[0-9a-f]{64}$/;
export const SOLVER_RELEASE_REPO = 'Open-Power-Electronics/OpenPE';
const RELEASE_PATH = `/${SOLVER_RELEASE_REPO}/releases/download/`;
const RELEASE_ASSET_HOSTS = new Set([
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

export function solverEntryPath(entry) {
  if (
    typeof entry !== 'string' ||
    !entry ||
    entry.includes('\\') ||
    entry.startsWith('/') ||
    entry.includes(':')
  )
    throw new Error(`Invalid solver archive entry ${entry}.`);
  if (entry.split('/').some((part) => !part || part === '.' || part === '..'))
    throw new Error(`Invalid solver archive entry ${entry}.`);
  return entry;
}

function releaseIdentity(url) {
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error(`Invalid solver release URL ${url}.`);
  // 127.0.0.1 HTTP is the in-test server. Lock URLs stay on github.com.
  if (parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.port) {
    const local = /^\/([^/]+)\/([^/]+)$/.exec(parsed.pathname);
    if (!local) throw new Error(`Invalid solver release URL ${url}.`);
    return { tag: local[1], name: local[2] };
  }
  if (parsed.protocol === 'https:' && parsed.hostname === 'github.com' && !parsed.port) {
    const release =
      parsed.pathname.startsWith(RELEASE_PATH) &&
      /^([^/]+)\/([^/]+)$/.exec(parsed.pathname.slice(RELEASE_PATH.length));
    if (!release) throw new Error(`Invalid solver release URL ${url}.`);
    return { tag: release[1], name: release[2] };
  }
  throw new Error(`Unapproved solver release host ${parsed.hostname}.`);
}

export function parseSolverPrepareArgs(argv, usage) {
  const args = argv.slice(2);
  let verify = false;
  let archive = null;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--verify') {
      if (verify) throw new Error(usage);
      verify = true;
      continue;
    }
    if (argument === '--archive') {
      if (archive) throw new Error(usage);
      const value = args[++index];
      if (!value || value.startsWith('-')) throw new Error(usage);
      archive = value;
      continue;
    }
    throw new Error(usage);
  }
  if (verify && archive) throw new Error(usage);
  return { verify, archive };
}

export async function assertPinnedLocalArchive(file, pin) {
  if (typeof file !== 'string' || !file.trim() || !HASH.test(pin?.sha256))
    throw new Error('Solver archive pin is incomplete.');
  const info = await lstat(file).catch((error) => {
    if (error.code === 'ENOENT') throw new Error(`Solver archive was not found: ${file}.`);
    throw error;
  });
  if (!info.isFile() || info.isSymbolicLink())
    throw new Error(`Solver archive must be a regular file: ${file}.`);
  const actual = await sha256File(file);
  if (
    !actual ||
    actual.sha256 !== pin.sha256 ||
    (pin.size !== undefined && actual.size !== pin.size)
  )
    throw new Error(
      `Solver archive ${path.basename(file)} failed its pinned SHA-256${pin.size === undefined ? '' : ' and size'}.`,
    );
  return path.resolve(file);
}

export function assertLockedRelease(archive) {
  if (
    !archive ||
    typeof archive.tag !== 'string' ||
    typeof archive.name !== 'string' ||
    typeof archive.url !== 'string'
  )
    throw new Error('Solver release lock is missing tag, name, or url.');
  const expected = `https://github.com${RELEASE_PATH}${archive.tag}/${archive.name}`;
  if (archive.url !== expected) throw new Error(`Solver release URL must be ${expected}.`);
  releaseIdentity(archive.url);
  if (!Number.isSafeInteger(archive.size) || archive.size <= 0 || archive.size > 512_000_000)
    throw new Error(`Invalid solver release size for ${archive.name}.`);
  if (!HASH.test(archive.sha256)) throw new Error(`Invalid solver release SHA-256 for ${archive.name}.`);
  return archive;
}

export function approvedReleaseRedirect(initial, next) {
  let start;
  let dest;
  try {
    start = new URL(initial);
    dest = new URL(next, initial);
  } catch {
    return false;
  }
  if (dest.username || dest.password || dest.hash) return false;
  if (start.protocol === 'http:' && start.hostname === '127.0.0.1')
    return (
      dest.protocol === 'http:' &&
      dest.hostname === '127.0.0.1' &&
      dest.port === start.port &&
      !dest.search
    );
  if (start.protocol !== 'https:' || start.hostname !== 'github.com' || start.port) return false;
  if (dest.protocol !== 'https:' || dest.port) return false;
  // GitHub signs its asset CDN URLs with query parameters.
  return (dest.hostname === 'github.com' && !dest.search) || RELEASE_ASSET_HOSTS.has(dest.hostname);
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  let size = 0;
  try {
    for await (const chunk of createReadStream(file)) {
      size += chunk.length;
      hash.update(chunk);
    }
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  return { size, sha256: hash.digest('hex') };
}

export async function downloadReleaseAsset({ url, sha256, size, file }) {
  const identity = releaseIdentity(url);
  if (!Number.isSafeInteger(size) || size <= 0 || size > 512_000_000 || !HASH.test(sha256))
    throw new Error(`Invalid solver release pin for ${identity.name}.`);
  const present = await sha256File(file);
  if (present?.sha256 === sha256 && present.size === size) return present;
  let current = new URL(url);
  let response;
  for (let hop = 0; hop <= 5; hop++) {
    response = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(240000) });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new Error(`Solver release redirect for ${identity.name} has no location.`);
    const next = new URL(location, current);
    if (hop === 5 || !approvedReleaseRedirect(url, next))
      throw new Error(`Unapproved solver release redirect for ${identity.name} to ${next.origin}.`);
    current = next;
  }
  if (response.status === 404)
    throw new Error(`Missing GitHub release asset ${identity.name} from tag ${identity.tag}.`);
  if (!response?.ok || !response.body)
    throw new Error(`Solver release download failed (${response?.status}) for ${identity.name}.`);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.partial`;
  const digest = createHash('sha256');
  let received = 0;
  try {
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, _encoding, callback) {
          received += chunk.length;
          if (received > size) {
            callback(new Error(`Solver release ${identity.name} exceeds its pinned size.`));
            return;
          }
          digest.update(chunk);
          callback(null, chunk);
        },
      }),
      createWriteStream(temporary, { flags: 'wx' }),
    );
    if (received !== size || digest.digest('hex') !== sha256)
      throw new Error(`Solver release ${identity.name} failed SHA-256/size verification.`);
    await rename(temporary, file);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
  return { size, sha256 };
}

async function regularFile(file, label) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Solver file is not a regular file: ${label}.`);
  return info;
}

export async function packSolverArchive({ root, files, archive }) {
  const names = Object.keys(files).sort();
  if (!names.length) throw new Error('Solver archive manifest is empty.');
  for (const name of names) {
    solverEntryPath(name);
    const full = path.join(root, ...name.split('/'));
    await regularFile(full, name);
    const actual = await sha256File(full);
    if (actual?.sha256 !== files[name]) throw new Error(`Solver file does not match the lock: ${name}.`);
  }
  await mkdir(path.dirname(archive), { recursive: true });
  const temporary = `${archive}.${randomUUID()}.partial`;
  try {
    await create(
      {
        cwd: root,
        file: temporary,
        portable: true,
        mtime: SOLVER_ARCHIVE_MTIME,
        gzip: { level: 9, mtime: SOLVER_ARCHIVE_EPOCH },
      },
      names,
    );
    const packed = await sha256File(temporary);
    await rename(temporary, archive);
    return packed;
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

export async function extractVerifiedArchive({ archive, destination, files }) {
  const names = Object.keys(files);
  if (!names.length) throw new Error('Solver archive manifest is empty.');
  const wanted = new Set(names.map(solverEntryPath));
  const directories = new Set();
  for (const name of wanted) {
    const parts = name.split('/');
    for (let index = 1; index < parts.length; index++) directories.add(parts.slice(0, index).join('/'));
  }
  const found = new Set();
  let listingError;
  await list({
    file: archive,
    strict: true,
    onentry(entry) {
      if (listingError) return;
      try {
        const name = solverEntryPath(entry.path.replace(/\/$/, ''));
        if (found.has(name)) throw new Error(`Duplicate solver archive entry ${name}.`);
        found.add(name);
        if (entry.type === 'Directory') {
          if (!directories.has(name)) throw new Error(`Unexpected solver archive entry ${name}.`);
          return;
        }
        if (entry.type !== 'File' || !wanted.has(name))
          throw new Error(`Unexpected solver archive entry ${name}.`);
      } catch (error) {
        listingError = error;
      }
    },
  });
  if (listingError) throw listingError;
  for (const name of wanted)
    if (!found.has(name)) throw new Error(`Solver archive is missing ${name}.`);
  const stageParent = path.dirname(path.resolve(archive));
  const stage = await mkdtemp(path.join(stageParent, 'solver-extract-'));
  try {
    if (path.dirname(path.resolve(stage)) !== stageParent)
      throw new Error('Refusing to use an invalid solver extraction directory.');
    await extract({
      file: archive,
      cwd: stage,
      strict: true,
      filter(entryPath) {
        const name = solverEntryPath(String(entryPath).replace(/\/$/, ''));
        if (!wanted.has(name) && !directories.has(name))
          throw new Error(`Unexpected solver archive entry ${name}.`);
        return true;
      },
    });
    const verified = [];
    for (const name of names) {
      const extracted = path.join(stage, ...name.split('/'));
      const info = await regularFile(extracted, name);
      const actual = await sha256File(extracted);
      if (actual?.sha256 !== files[name])
        throw new Error(`Extracted solver file failed verification: ${name}.`);
      verified.push({ name, extracted, mode: info.mode & 0o777 });
    }
    for (const item of verified) {
      const target = path.join(destination, ...item.name.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${randomUUID()}.partial`;
      try {
        await copyFile(item.extracted, temporary);
        await chmod(temporary, item.mode);
        await rename(temporary, target);
      } finally {
        await unlink(temporary).catch((error) => {
          if (error.code !== 'ENOENT') throw error;
        });
      }
    }
  } finally {
    if (
      path.dirname(path.resolve(stage)) !== stageParent ||
      !path.basename(stage).startsWith('solver-extract-')
    )
      throw new Error('Refusing to remove an invalid solver extraction directory.');
    await rm(stage, { recursive: true, force: true });
  }
}
