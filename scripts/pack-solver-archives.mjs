import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLockedRelease, packSolverArchive } from './solver-release.mjs';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const jobs = [
  ['resources/ngspice-lock.json', 'resources/ngspice/47'],
  ['resources/thermal-lock.json', 'resources/thermal/1'],
];
for (const [lockFile, root] of jobs) {
  const lock = JSON.parse(await readFile(path.join(workspace, lockFile), 'utf8'));
  const archive = assertLockedRelease(lock.platforms['darwin-arm64'].archive);
  const packed = await packSolverArchive({
    root: path.join(workspace, root),
    files: lock.platforms['darwin-arm64'].files,
    archive: path.join(workspace, 'release/solvers', archive.name),
  });
  if (packed.sha256 !== archive.sha256 || packed.size !== archive.size)
    throw new Error(
      `Archive ${archive.name} is ${packed.size} bytes ${packed.sha256}; the lock records ${archive.size} bytes ${archive.sha256}.`,
    );
  console.log(`${archive.name} ${packed.size} ${packed.sha256}`);
}
