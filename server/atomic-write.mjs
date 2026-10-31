import { randomBytes } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

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

// Callers own destination validation; replace only after the complete write.
export async function atomicWrite(file, content, check = async () => {}) {
  await check();
  const temp = file + '.' + randomBytes(6).toString('hex') + '.tmp';
  const handle = await open(temp, 'wx');
  try {
    try {
      await handle.writeFile(content, 'utf8');
    } finally {
      await handle.close();
    }
    await check();
    await rename(temp, file);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
