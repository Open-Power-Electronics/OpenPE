import path from 'node:path';
import { readFile, stat, unlink } from 'node:fs/promises';
import { restoreWorkspace } from './workspace-format.mjs';
import { atomicWrite } from './atomic-write.mjs';

export const workspaceFilename = 'openpe-workspace-v2.json';
export const maxWorkspaceRecoveryBytes = 96 * 1024 * 1024;

async function readRecovery(file) {
  try {
    if ((await stat(file)).size > maxWorkspaceRecoveryBytes)
      throw new Error('The recovery file exceeds 96 MB.');
    return await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function readWorkspaceRecovery(dataDir) {
  // The retired recovery cache is deliberately discarded, without import or backup.
  // Current recovery has a separate name so a former app process cannot restore it.
  try {
    await unlink(path.join(dataDir, 'workspace.json'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const file = path.join(dataDir, workspaceFilename);
  const current = await readRecovery(file);
  if (current === null) return null;
  return JSON.parse(current);
}

/** One host-owned queue for HTTP and native IPC recovery. Limits and writes are
 * injectable only at construction, so focused host tests need no large files. */
export function createWorkspaceRecoveryStore(
  dataDir,
  { maxBytes = maxWorkspaceRecoveryBytes, write = atomicWrite } = {},
) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > maxWorkspaceRecoveryBytes)
    throw new Error('Invalid recovery size limit.');
  const file = path.join(dataDir, workspaceFilename);
  let queue = Promise.resolve();
  const enqueue = (operation) => {
    const result = queue.catch(() => {}).then(operation);
    // Retain completion rather than a read's complete recovered document.
    queue = result.then(() => {});
    void queue.catch(() => {});
    return result;
  };
  const checkEncoded = (content) => {
    if (typeof content !== 'string') throw new Error('Recovery data must be encoded JSON.');
    if (content.length > maxBytes || Buffer.byteLength(content, 'utf8') > maxBytes)
      throw new Error('The recovery envelope exceeds its size limit.');
  };
  const writeParsed = (value) => {
    // Keep the existing POST ordering: validate and encode before accepting a
    // queue entry, then acknowledge only the completed atomic replacement.
    restoreWorkspace(value);
    const content = JSON.stringify(value);
    checkEncoded(content);
    return enqueue(async () => {
      await write(file, content);
    });
  };
  return {
    read: () => enqueue(() => readWorkspaceRecovery(dataDir)),
    writeParsed,
    writeEncoded(content) {
      checkEncoded(content);
      return writeParsed(JSON.parse(content));
    },
    clear() {
      checkEncoded('null');
      return enqueue(async () => {
        await write(file, 'null');
      });
    },
    settle: () => queue,
  };
}
