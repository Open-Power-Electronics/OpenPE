const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

// macOS APFS can be case-sensitive. Cache the probed device; do not assume a platform default.
const caseFoldByDevice = new Map();

function foldPath(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function samePath(left, right) {
  return foldPath(left) === foldPath(right);
}

// Probe the canonical path itself when it is a directory; otherwise probe its parent.
function caseProbeDirectory(target) {
  try {
    if (fs.lstatSync(target).isDirectory()) return target;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const parent = path.dirname(target);
  if (parent === target) throw new Error(`Cannot determine volume case sensitivity for ${target}.`);
  return parent;
}

// A logical path may only differ from its realpath by a canonical prefix
// (/var -> /private/var). A replaced component means a symlink was followed.
// Windows paths always fold. Every other volume uses the same case probe as grant identity.
function logicalSuffixOfCanonical(logical, canonical) {
  const foldCase = process.platform === 'win32' || volumeFoldsCase(caseProbeDirectory(canonical));
  const fold = (value) => (foldCase ? value.toLowerCase() : value);
  const logicalParts = fold(logical).split(path.sep).filter(Boolean);
  const canonicalParts = fold(canonical).split(path.sep).filter(Boolean);
  if (!logicalParts.length || logicalParts.length > canonicalParts.length) return false;
  return logicalParts.every(
    (part, index) => part === canonicalParts[canonicalParts.length - logicalParts.length + index],
  );
}

function containedRelative(root, target) {
  const relative = path.relative(root, target);
  if (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
    return relative;
  return null;
}

function toggleCase(name) {
  return name.replace(/[A-Za-z]/, (character) =>
    character === character.toLowerCase() ? character.toUpperCase() : character.toLowerCase(),
  );
}

function volumeFoldsCase(directory) {
  const stat = fs.lstatSync(directory);
  const cached = caseFoldByDevice.get(stat.dev);
  if (cached !== undefined) return cached;
  const base = path.basename(directory);
  const toggled = toggleCase(base);
  let folds;
  if (toggled === base) {
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error('Cannot determine volume case sensitivity.');
    folds = volumeFoldsCase(parent);
  } else {
    try {
      const other = fs.lstatSync(path.join(path.dirname(directory), toggled));
      folds = other.dev === stat.dev && other.ino === stat.ino;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      folds = false;
    }
  }
  caseFoldByDevice.set(stat.dev, folds);
  return folds;
}

/**
 * Identity for an existing path is the native canonical realpath (stored case and
 * ancestor symlinks). A missing final component keeps its spelling under the
 * canonical parent. Case-insensitive volumes fold that key; case-sensitive ones do not.
 * Windows grant identity stays path.resolve + lowercase.
 */
function canonicalGrantPath(file) {
  if (process.platform === 'win32') return path.resolve(file).toLowerCase();
  const resolved = path.resolve(file);
  try {
    const canonical = fs.realpathSync.native(resolved);
    return volumeFoldsCase(path.dirname(canonical)) ? canonical.toLowerCase() : canonical;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Keep the missing suffix under the nearest existing ancestor's native path.
  const missing = [];
  let existing = resolved;
  while (true) {
    const parent = path.dirname(existing);
    if (parent === existing) throw new Error(`Cannot canonicalize ${resolved}.`);
    missing.push(path.basename(existing));
    existing = parent;
    try {
      const canonicalParent = fs.realpathSync.native(existing);
      const canonical = path.join(canonicalParent, ...missing.reverse());
      return volumeFoldsCase(canonicalParent) ? canonical.toLowerCase() : canonical;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

/**
 * Host-established directory. The final component must be a real directory.
 * Ancestor symlinks such as macOS /var -> /private/var are resolved, not rejected.
 * @param {string} directory
 * @param {{ message: string }} options
 */
async function canonicalDirectory(directory, options) {
  if (!options || typeof options.message !== 'string')
    throw new Error('canonicalDirectory requires a message.');
  const info = await fsp.lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(options.message);
  const logical = path.resolve(directory);
  const canonical = await fsp.realpath(directory);
  if (!logicalSuffixOfCanonical(logical, canonical)) throw new Error(options.message);
  return { logical, canonical };
}

/**
 * Reject symbolic links strictly inside a canonical host directory.
 * @param {{ logical: string, canonical: string }} root
 * @param {string} target
 * @param {{ message: string, kind?: 'directory' | 'file' | 'any', allowMissing?: boolean }} options
 */
async function assertContainedPath(root, target, options) {
  if (!options || typeof options.message !== 'string')
    throw new Error('assertContainedPath requires a message.');
  const kind = options.kind ?? 'any';
  const resolved = path.resolve(target);
  const base =
    containedRelative(root.logical, resolved) !== null
      ? root.logical
      : containedRelative(root.canonical, resolved) !== null
        ? root.canonical
        : null;
  if (base === null) throw new Error(options.message);
  const relative = containedRelative(base, resolved);
  let current = root.canonical;
  if (relative) {
    const parts = relative.split(path.sep);
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      const last = index === parts.length - 1;
      let info;
      try {
        info = await fsp.lstat(current);
      } catch (error) {
        if (options.allowMissing && last && error.code === 'ENOENT') return current;
        throw error;
      }
      if (info.isSymbolicLink()) throw new Error(options.message);
      if (!last && !info.isDirectory()) throw new Error(options.message);
      if (last && kind === 'directory' && !info.isDirectory()) throw new Error(options.message);
      if (last && kind === 'file' && !info.isFile()) throw new Error(options.message);
    }
  } else if (kind === 'file') throw new Error(options.message);
  const real = await fsp.realpath(current);
  if (containedRelative(root.canonical, real) === null || !samePath(real, current))
    throw new Error(options.message);
  return current;
}

module.exports = {
  assertContainedPath,
  canonicalDirectory,
  canonicalGrantPath,
  logicalSuffixOfCanonical,
  samePath,
};
