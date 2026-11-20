// Explicit maintainer operation after rebuilding, never part of preparation.
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packSolverArchive, sha256File, solverEntryPath } from './solver-release.mjs';

if (process.platform !== 'linux' || process.arch !== 'x64')
  throw new Error('Linux solver pins can only be updated on Linux x64.');
const root = fileURLToPath(new URL('../', import.meta.url));
for (const [name, directory] of [
  ['ngspice', 'ngspice/47'],
  ['thermal', 'thermal/1'],
]) {
  const file = path.join(root, `resources/${name}-lock.json`);
  const lock = JSON.parse(await readFile(file, 'utf8'));
  const platform = lock.platforms['linux-x64'];
  // The reviewed file list is retained. Unexpected files do not gain authority.
  for (const relative of Object.keys(platform.files)) {
    const actual = await sha256File(
      path.join(root, 'resources', directory, solverEntryPath(relative)),
    );
    if (!actual) throw new Error(`Missing rebuilt Linux solver file ${relative}.`);
    platform.files[relative] = actual.sha256;
  }
  const packed = await packSolverArchive({
    root: path.join(root, 'resources', directory),
    files: platform.files,
    archive: path.join(root, 'release/solvers', platform.archive.name),
  });
  Object.assign(platform.archive, packed);
  await writeFile(file, JSON.stringify(lock, null, 2) + '\n');
  console.log(
    `Updated ${name} Linux pins: ${packed.size} bytes ${packed.sha256}. Review the lock diff before publishing.`,
  );
}
