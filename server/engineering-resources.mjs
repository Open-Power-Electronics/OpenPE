import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryResources = fileURLToPath(new URL('../resources/', import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const checkAbort = (signal) => {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException('Engineering resource lookup cancelled.', 'AbortError');
};

async function regularFile(root, relative, expectedHash) {
  const parts = relative.split('/');
  if (parts.some((part) => !part || part === '..' || part === '.'))
    throw new Error('Invalid engineering resource manifest.');
  let file = root;
  for (let i = 0; i < parts.length; i++) {
    file = path.join(file, parts[i]);
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile()))
      throw new Error('Bundled engineering resources cannot contain links or special files.');
  }
  const bytes = await readFile(file);
  if (expectedHash && digest(bytes) !== expectedHash)
    throw new Error(`Bundled engineering resource changed: ${relative}.`);
  return bytes;
}

export async function engineeringResources(signal, resourceRoot = repositoryResources) {
  checkAbort(signal);
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error(
      'Bundled engineering tools currently require Windows x64 Gmsh and Elmer resources.',
    );
  const root = path.join(resourceRoot, 'thermal', '1');
  const parentInfo = await lstat(path.join(resourceRoot, 'thermal'));
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink())
    throw new Error('Invalid bundled engineering resource parent.');
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('Invalid bundled engineering resource directory.');
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  // The build-controlled lock is the runtime authority; a request cannot choose
  // executables, versions, environment overrides, or a different resource root.
  const lockPath =
    resourceRoot === repositoryResources
      ? path.join(resourceRoot, 'thermal-lock.json')
      : path.join(root, 'thermal-lock.json');
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  if (
    JSON.stringify(manifest) !== JSON.stringify(lock) ||
    lock.version !== 1 ||
    lock.platform !== 'win32-x64'
  )
    throw new Error('Bundled engineering resource manifest does not match the pinned lock.');
  for (const [relative, hash] of Object.entries(lock.files)) {
    checkAbort(signal);
    await regularFile(root, relative, hash);
  }
  return {
    root,
    lock,
    gmsh: path.join(root, lock.executables.gmsh),
    elmerGrid: path.join(root, lock.executables.elmerGrid),
    elmer: path.join(root, lock.executables.elmer),
  };
}
