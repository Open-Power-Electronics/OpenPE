import { createReadStream, createWriteStream } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { x } from 'tar';

// Optional complete offline library. Keep the archive and original upstream notices.
const lock = JSON.parse(await readFile('resources/kicad.lock.json', 'utf8'));
const { version, models } = lock;
if (
  models.repository !== 'https://gitlab.com/kicad/libraries/kicad-packages3D' ||
  !/^\d+\.\d+\.\d+$/.test(version) ||
  !/^[a-f0-9]{40}$/.test(models.commit) ||
  !/^[a-f0-9]{64}$/.test(models.sha256)
)
  throw new Error('The complete 3D library needs a pinned official commit and archive SHA-256.');
if (process.argv.slice(2).some((arg) => arg !== '--verify'))
  throw new Error('Usage: node scripts/download-kicad-models.mjs [--verify]');
const verifyOnly = process.argv.includes('--verify');
const base = path.resolve('resources/kicad', version);
const destination = path.join(base, 'models');
const archive = path.resolve('resources/third-party-source', `kicad-packages3D-${version}.tar.gz`);
const url = `${models.repository}/-/archive/${models.commit}/kicad-packages3D-${models.commit}.tar.gz`;
const maxArchiveBytes = 4 * 1024 ** 3;
const maxExtractedBytes = 16 * 1024 ** 3;

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
async function inventory(dir) {
  if (!(await lstat(dir)).isDirectory()) throw new Error('Expected a local model directory.');
  const result = { files: 0, step: 0, wrl: 0, bytes: 0 };
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        if (file === path.join(dir, 'openpe-source.json')) continue;
        result.files++;
        result.bytes += (await stat(file)).size;
        if (/\.(step|stp)$/i.test(entry.name)) result.step++;
        if (/\.wrl$/i.test(entry.name)) result.wrl++;
      } else throw new Error(`Unsupported resource entry: ${file}`);
    }
  }
  await walk(dir);
  await readFile(path.join(dir, 'LICENSE.md'));
  if (result.step < 1000 || result.bytes > maxExtractedBytes)
    throw new Error('The official 3D library is incomplete or exceeds its size limit.');
  if (models.inventory && JSON.stringify(result) !== JSON.stringify(models.inventory))
    throw new Error('The complete 3D library does not match the pinned inventory.');
  return result;
}
async function verifyInstalled() {
  const source = JSON.parse(await readFile(path.join(destination, 'openpe-source.json'), 'utf8'));
  if (source.commit !== models.commit || source.sha256 !== models.sha256)
    throw new Error('Installed 3D library revision does not match resources/kicad.lock.json.');
  return inventory(destination);
}

await mkdir(path.dirname(archive), { recursive: true });
if (!(await exists(archive))) {
  if (verifyOnly) throw new Error('The pinned 3D library source archive is missing.');
  const partial = archive + '.part';
  if (!(await exists(partial)) || (await digest(partial)) !== models.sha256) {
    console.log(`Downloading complete KiCad ${version} 3D library…`);
    const response = await fetch(url, { signal: AbortSignal.timeout(3600000), redirect: 'error' });
    if (!response.ok) throw new Error(`3D library download failed (${response.status}).`);
    let bytes = 0,
      lastProgress = 0;
    await pipeline(
      response.body,
      new Transform({
        transform(chunk, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > maxArchiveBytes)
            return callback(new Error('3D library archive exceeds 4 GiB.'));
          if (Date.now() - lastProgress >= 10000) {
            console.log(`Downloaded ${(bytes / 1e6).toFixed(1)} MB`);
            lastProgress = Date.now();
          }
          callback(null, chunk);
        },
      }),
      createWriteStream(partial),
    );
  }
  if ((await digest(partial)) !== models.sha256)
    throw new Error(
      '3D library archive SHA-256 mismatch; the partial download has been preserved.',
    );
  await rename(partial, archive);
}
if ((await stat(archive)).size > maxArchiveBytes || (await digest(archive)) !== models.sha256)
  throw new Error('3D library source archive does not match its pinned SHA-256.');
if (await exists(path.join(destination, 'openpe-source.json'))) {
  console.log('Complete 3D library verified:', await verifyInstalled());
  process.exit(0);
}
if (verifyOnly)
  throw new Error('Complete 3D library is not installed. Run npm run libraries:download-models.');

await mkdir(base, { recursive: true });
const staging = await mkdtemp(path.join(base, 'models.staging-'));
console.log('Extracting the verified official archive…');
let extractedBytes = 0;
const prefix = `kicad-packages3D-${models.commit}`;
await x({
  file: archive,
  cwd: staging,
  strip: 1,
  strict: true,
  filter(name, entry) {
    const segments = name.split('/');
    if (
      segments[0] !== prefix ||
      segments.includes('..') ||
      /[\\:]/.test(name) ||
      !['File', 'Directory'].includes(entry.type)
    )
      throw new Error(`Unsupported 3D library archive entry: ${name}`);
    extractedBytes += entry.size;
    if (extractedBytes > maxExtractedBytes) throw new Error('3D library expands beyond 16 GiB.');
    return true;
  },
});
const files = await inventory(staging);

// Preserve existing resources on conflicts. Starter files must be identical upstream files.
async function verifyExisting(current, relative = '') {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) await verifyExisting(path.join(current, entry.name), name);
    else if (
      !entry.isFile() ||
      !(await exists(path.join(staging, name))) ||
      (await digest(path.join(current, entry.name))) !== (await digest(path.join(staging, name)))
    )
      throw new Error(
        `Existing model resource differs from the official release: ${name}. Preserved unchanged.`,
      );
  }
}
const hadModels = await exists(destination);
if (hadModels) {
  if (!(await lstat(destination)).isDirectory())
    throw new Error('Existing model directory must not be a symlink.');
  await verifyExisting(destination);
}
await writeFile(
  path.join(staging, 'openpe-source.json'),
  JSON.stringify(
    {
      version,
      repository: models.repository,
      url,
      commit: models.commit,
      sha256: models.sha256,
      modified: false,
      inventory: files,
    },
    null,
    2,
  ) + '\n',
);
const backup = staging.replace('models.staging-', 'models.previous-');
if (hadModels) await rename(destination, backup);
try {
  await rename(staging, destination);
} catch (error) {
  if (hadModels) await rename(backup, destination);
  throw error;
}
if (hadModels) {
  // Only remove this run's verified duplicate, within the fixed project resource directory.
  const resolvedBackup = await realpath(backup);
  if (
    path.dirname(resolvedBackup) !== (await realpath(base)) ||
    !/^models\.previous-[\w-]+$/.test(path.basename(resolvedBackup))
  )
    throw new Error('Refusing to remove a resource backup outside the project directory.');
  await rm(resolvedBackup, { recursive: true });
}
console.log('Complete 3D library installed:', files);
console.log(`Models: ${destination}\nOriginal source archive: ${archive}`);
