import { isPluginProjectDirectory } from './plugin-project-format.cjs';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { renameWithRetry } from './atomic-write.mjs';
import { logicalSuffixOfCanonical } from './host-path.cjs';

const queues = new Map();
const normalize = (file) => (process.platform === 'win32' ? file.toLowerCase() : file);
const safeName = (name) =>
  typeof name === 'string' &&
  name.length > 0 &&
  name.length <= 240 &&
  name !== '.' &&
  name !== '..' &&
  !/[<>:"/\\|?*\x00-\x1f]/.test(name) &&
  !/[. ]$/.test(name) &&
  !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name);
const sameFile = (a, b) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;
const missing = (file) =>
  lstat(file).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });

export function analysisFilename(stem, logicalName) {
  if (!safeName(stem) || typeof logicalName !== 'string' || !logicalName.split('/').every(safeName))
    throw new Error('Invalid analysis artifact filename.');
  const file = `${stem}.${path.posix.basename(logicalName)}`;
  if (!safeName(file)) throw new Error('The analysis artifact filename is too long.');
  return file;
}

/** Every store instance sharing a directory observes complete host transactions. */
export function withAnalysisFiles(directory, operation) {
  const key = normalize(path.resolve(directory));
  const pending = (queues.get(key) ?? Promise.resolve()).then(operation);
  const settled = pending.then(
    () => {},
    () => {},
  );
  queues.set(key, settled);
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key);
  });
  return pending;
}

async function regularDirectory(directory) {
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !logicalSuffixOfCanonical(path.resolve(directory), await realpath(directory))
  )
    throw new Error('Analysis folders must be real directories without links.');
}

async function regularFile(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    throw new Error('Analysis artifacts must be regular files without links.');
  return info;
}

async function privateDirectory(directory, type) {
  const kind = path.basename(directory);
  if (!isPluginProjectDirectory(kind)) throw new Error('Invalid analysis directory.');
  await regularDirectory(directory);
  const temporary = path.join(directory, `.${type}-${randomUUID()}-backups`);
  await mkdir(temporary);
  await regularDirectory(temporary);
  return temporary;
}

export const createAnalysisStaging = (directory) => privateDirectory(directory, 'pending');

/** Only named files in this operation's private, flat folder are disposable. */
export async function discardAnalysisStaging(directory, allowedNames) {
  if (!(await missing(directory))) return;
  if (
    !/^\.(?:pending|previous)-[a-f0-9-]{36}-backups$/.test(path.basename(directory)) ||
    !isPluginProjectDirectory(path.basename(path.dirname(directory)))
  )
    throw new Error('Invalid private analysis folder.');
  if (!Array.isArray(allowedNames) || !allowedNames.every(safeName))
    throw new Error('Invalid private analysis artifacts.');
  await regularDirectory(path.dirname(directory));
  await regularDirectory(directory);
  const allowed = new Set(allowedNames);
  const entries = await readdir(directory);
  const expected = new Map();
  for (const name of entries) {
    if (!allowed.has(name))
      throw new Error('Preserve unknown files in the private analysis folder.');
    expected.set(name, await regularFile(path.join(directory, name)));
  }
  for (const [name, before] of expected) {
    const file = path.join(directory, name);
    if (!sameFile(before, await regularFile(file)))
      throw new Error('A private analysis artifact changed before cleanup.');
    await unlink(file);
  }
  await rmdir(directory);
}

/** Per-file atomic replacement with a manifest commit point and failure rollback.
 * The caller validates the previous manifest and owns the shared directory lock.
 * Unlisted sidecars and other projects' artifacts stay at their original paths.
 * @param {{ directory: string, staging: string, previousNames: string[], previousIdentities?: ReadonlyMap<string, import('node:fs').Stats>, nextNames: string[], manifestName: string, check: () => void | Promise<void>, signal: AbortSignal }} options
 */
export async function publishAnalysisFiles({
  directory,
  staging,
  previousNames,
  previousIdentities = undefined,
  nextNames,
  manifestName,
  check,
  signal,
}) {
  const named = (names) =>
    Array.isArray(names) && names.every(safeName) && new Set(names).size === names.length;
  if (
    !named(previousNames) ||
    !named(nextNames) ||
    !nextNames.includes(manifestName) ||
    path.dirname(staging) !== directory ||
    !/^\.pending-[a-f0-9-]{36}-backups$/.test(path.basename(staging))
  )
    throw new Error('Invalid flat analysis publication.');
  const inspect = async () => {
    signal.throwIfAborted();
    await check();
    await regularDirectory(directory);
    await regularDirectory(staging);
    signal.throwIfAborted();
  };
  await inspect();
  const old = new Map();
  const prepared = new Map();
  for (const name of previousNames) {
    const info = await regularFile(path.join(directory, name));
    if (previousIdentities && !sameFile(previousIdentities.get(name) ?? {}, info))
      throw new Error('A saved analysis artifact changed while preparing publication.');
    old.set(name, info);
  }
  for (const name of nextNames) {
    prepared.set(name, await regularFile(path.join(staging, name)));
    if (!old.has(name) && (await missing(path.join(directory, name))))
      throw new Error(
        `An unknown analysis file already exists: ${name}. Preserve or move it and retry.`,
      );
  }
  const previous = await privateDirectory(directory, 'previous');
  const backedUp = new Map();
  const installed = new Map();
  let completed = false;
  const protect = async (name) => {
    if (!old.has(name)) return;
    const file = path.join(directory, name);
    await renameWithRetry(
      file,
      path.join(previous, name),
      async () => {
        await inspect();
        await regularDirectory(previous);
        if (!sameFile(old.get(name), await regularFile(file)))
          throw new Error('A saved analysis artifact changed before replacement.');
      },
      signal,
    );
    backedUp.set(name, await regularFile(path.join(previous, name)));
  };
  const install = async (name) => {
    await protect(name);
    const source = path.join(staging, name);
    const target = path.join(directory, name);
    await renameWithRetry(
      source,
      target,
      async () => {
        await inspect();
        if ((await missing(target)) || !sameFile(prepared.get(name), await regularFile(source)))
          throw new Error(
            'An analysis artifact changed before publication. Preserve it and retry.',
          );
      },
      signal,
    );
    installed.set(name, await regularFile(target));
  };
  try {
    for (const name of nextNames.filter((name) => name !== manifestName)) await install(name);
    for (const name of previousNames.filter((name) => !nextNames.includes(name)))
      await protect(name);
    await install(manifestName);
    await check();
    signal.throwIfAborted();
    completed = true;
  } catch (error) {
    const failures = [];
    // Cancellation/grant revocation must not prevent compensating the host's
    // own writes. Identity checks still protect any new external file changes.
    for (const [name, expected] of [...installed].reverse()) {
      try {
        await regularDirectory(directory);
        const target = path.join(directory, name);
        if (!sameFile(expected, await regularFile(target)))
          throw new Error(`The published analysis file changed: ${name}.`);
        await unlink(target);
      } catch (failure) {
        failures.push(failure);
      }
    }
    for (const [name, expected] of [...backedUp].reverse()) {
      try {
        const source = path.join(previous, name);
        const target = path.join(directory, name);
        await renameWithRetry(source, target, async () => {
          await regularDirectory(directory);
          await regularDirectory(previous);
          if ((await missing(target)) || !sameFile(expected, await regularFile(source)))
            throw new Error(`Preserve the previous analysis artifact: ${name}.`);
        });
      } catch (failure) {
        failures.push(failure);
      }
    }
    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        `Analysis publication failed and some previous artifacts could not be restored. Preserve ${previous} and retry.`,
      );
    throw error;
  } finally {
    if (completed || backedUp.size === 0)
      await discardAnalysisStaging(previous, [...backedUp.keys()]).catch(() => {});
    else if (!(await readdir(previous)).length) await rmdir(previous);
  }
}
