import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertLockedRelease, sha256File } from './solver-release.mjs';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const repo = 'fleaxiao/OpenPE';
const releases = [
  ['resources/ngspice-lock.json', 'OpenPE darwin-arm64 ngspice 47 console.'],
  [
    'resources/thermal-lock.json',
    'OpenPE darwin-arm64 Gmsh 4.15.2, Elmer 26.1 and OpenBLAS 0.3.13.',
  ],
];

function gh(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { cwd: workspace, stdio: 'inherit' });
    child.once('error', (error) => {
      if (error.code === 'ENOENT') reject(new Error('gh is required to publish solver releases.'));
      else reject(error);
    });
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`gh ${args.slice(0, 2).join(' ')} exited with ${signal ?? code}.`));
    });
  });
}

for (const [lockFile, summary] of releases) {
  const lock = JSON.parse(await readFile(path.join(workspace, lockFile), 'utf8'));
  const archive = assertLockedRelease(lock.platforms['darwin-arm64'].archive);
  const file = path.join(workspace, 'release/solvers', archive.name);
  const packed = await sha256File(file);
  if (!packed || packed.sha256 !== archive.sha256 || packed.size !== archive.size)
    throw new Error(`Refusing to publish ${archive.name}: the archive does not match the lock.`);
  const notes = [
    summary,
    '',
    `Asset: ${archive.name}`,
    `SHA-256: ${archive.sha256}`,
    `Bytes: ${archive.size}`,
    '',
  ].join('\n');
  await gh([
    'release',
    'create',
    archive.tag,
    '--repo',
    repo,
    '--title',
    archive.tag,
    '--notes',
    notes,
    '--latest=false',
    '--prerelease',
  ]);
  await gh(['release', 'upload', archive.tag, file, '--repo', repo]);
}
