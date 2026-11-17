import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { x } from 'tar';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

// Reproducible, independent resources. No installed KiCad directories are consulted.
const version = '10.0.0';
const lock = JSON.parse(await readFile('resources/kicad.lock.json', 'utf8'));
const base = path.resolve('resources/kicad', version);
await mkdir(base, { recursive: true });
for (const [kind, repo] of [
  ['symbols', 'kicad-symbols'],
  ['footprints', 'kicad-footprints'],
]) {
  const destination = path.join(base, kind);
  try {
    await readFile(path.join(destination, 'LICENSE.md'));
    const metadata = JSON.parse(
      await readFile(path.join(destination, 'openpe-source.json'), 'utf8'),
    );
    if (metadata.commit !== lock[kind].commit)
      throw new Error('The downloaded library revision does not match resources/kicad.lock.json.');
    console.log(`${kind}: already installed`);
    continue;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const revision = lock[kind].commit;
  const url = `https://gitlab.com/kicad/libraries/${repo}/-/archive/${revision}/${repo}-${revision}.tar.gz`;
  console.log(`Downloading ${repo} ${version}…`);
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) {
    console.log(`Archive returned ${response.status}; fetching the same release with Git.`);
    await exec(
      'git',
      [
        'clone',
        '--depth',
        '1',
        '--branch',
        version,
        '--single-branch',
        `https://gitlab.com/kicad/libraries/${repo}.git`,
        destination,
      ],
      { windowsHide: true, timeout: 600000, maxBuffer: 4_000_000 },
    );
    const { stdout } = await exec('git', ['-C', destination, 'rev-parse', 'HEAD'], {
      windowsHide: true,
    });
    if (stdout.trim() !== revision)
      throw new Error('Official release tag does not match the pinned library commit.');
    await readFile(path.join(destination, 'LICENSE.md'));
    await writeFile(
      path.join(destination, 'openpe-source.json'),
      JSON.stringify({ version, url, commit: stdout.trim(), modified: false }, null, 2),
    );
    console.log(`${kind}: installed`);
    continue;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 200_000_000) throw new Error('Library archive exceeds 200 MB.');
  const archive = path.join(base, `${kind}.tar.gz`);
  const staging = path.join(base, `${kind}.staging`);
  await mkdir(staging, { recursive: true });
  await writeFile(archive, bytes);
  await x({
    file: archive,
    cwd: staging,
    strip: 1,
    strict: true,
    filter: (name, entry) =>
      !name.split('/').includes('..') && ['File', 'Directory'].includes(entry.type),
  });
  await readFile(path.join(staging, 'LICENSE.md'));
  await writeFile(
    path.join(staging, 'openpe-source.json'),
    JSON.stringify(
      {
        version,
        url,
        commit: revision,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        modified: false,
      },
      null,
      2,
    ),
  );
  await rename(staging, destination);
  await rm(archive);
  console.log(`${kind}: installed (${(bytes.length / 1e6).toFixed(1)} MB archive)`);
}
await mkdir(path.join(base, 'models'), { recursive: true });
const modelRepo = 'https://gitlab.com/kicad/libraries/kicad-packages3D';
try {
  await readFile(path.join(base, 'models', 'LICENSE.md'));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
  const license = await fetch(`${modelRepo}/-/raw/${version}/LICENSE.md`, {
    signal: AbortSignal.timeout(30000),
  });
  if (!license.ok) throw new Error('Could not download the 3D library license.');
  await writeFile(path.join(base, 'models', 'LICENSE.md'), await license.text());
}
// Seed models corresponding to common power-electronics footprints; other models are cached on demand.
const models = [
  'Resistor_SMD.3dshapes/R_0805_2012Metric.step',
  'Capacitor_SMD.3dshapes/C_0805_2012Metric.step',
  'Package_TO_SOT_SMD.3dshapes/SOT-23.step',
];
for (const model of models) {
  const dest = path.join(base, 'models', model);
  try {
    await readFile(dest);
    continue;
  } catch {}
  const response = await fetch(`${modelRepo}/-/raw/${version}/${model}`, {
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`Model download failed: ${model} (${response.status})`);
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, Buffer.from(await response.arrayBuffer()));
  console.log(`Installed model: ${model}`);
}
await import('./index-libraries.mjs');
await import('./build-starter-symbols.mjs');
