import { randomBytes } from 'node:crypto';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertCanonicalParent, containedCreateFlags } from './host-path.cjs';

/** Retry brief sharing locks, rechecking caller-owned paths and grants each time.
 * Persistent permissions and all other failures still fail without a fallback write.
 * @param {string} source
 * @param {string} target
 * @param {() => Promise<void>} check
 * @param {AbortSignal} [signal]
 */
export async function renameWithRetry(source, target, check, signal = undefined) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    await check();
    signal?.throwIfAborted();
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt === 4) throw error;
      await delay(100, undefined, { signal });
    }
  }
}

async function recheckParent(file, options) {
  const parent = path.dirname(file);
  await assertCanonicalParent(parent, options.parentCanonical, options.message);
  const info = await lstat(parent);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(options.message);
}

// Callers own destination validation; replace only after the complete write.
// A contained missing file is opened with O_NOFOLLOW|O_CREAT|O_EXCL on POSIX
// after the parent is lstat'd again. An existing contained file is replaced
// only when that parent and a regular final lstat still match.
export async function atomicWrite(file, content, check = async () => {}, options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options))
    throw new Error('atomicWrite options must be an object.');
  const contained = Object.hasOwn(options, 'parentCanonical');
  if (contained) {
    const keys = Object.keys(options);
    if (keys.length !== 2 || !keys.includes('parentCanonical') || !keys.includes('message'))
      throw new Error('A contained write accepts only a canonical parent and message.');
    if (typeof options.parentCanonical !== 'string' || !options.parentCanonical)
      throw new Error('A contained write requires a canonical parent.');
    if (typeof options.message !== 'string' || !options.message)
      throw new Error('A contained write requires a message.');
  } else if (Object.keys(options).length) {
    throw new Error('atomicWrite options are not supported.');
  }
  await check();
  if (contained) await recheckParent(file, options);
  let existing = null;
  if (contained) {
    try {
      existing = await lstat(file);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (existing?.isSymbolicLink()) throw new Error(options.message);
    if (!existing) {
      await recheckParent(file, options);
      const handle = await open(file, containedCreateFlags());
      try {
        await handle.writeFile(content, 'utf8');
      } catch (writeError) {
        await handle.close();
        try {
          await unlink(file);
        } catch (unlinkError) {
          if (unlinkError.code !== 'ENOENT') throw unlinkError;
        }
        throw writeError;
      }
      await handle.close();
      return;
    }
  }
  const temp = file + '.' + randomBytes(6).toString('hex') + '.tmp';
  const handle = await open(temp, contained ? containedCreateFlags() : 'wx');
  try {
    try {
      await handle.writeFile(content, 'utf8');
    } finally {
      await handle.close();
    }
    await check();
    if (contained) {
      await recheckParent(file, options);
      const current = await lstat(file);
      if (current.isSymbolicLink() || !current.isFile()) throw new Error(options.message);
    }
    await rename(temp, file);
  } finally {
    await unlink(temp).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
