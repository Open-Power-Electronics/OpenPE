import { readFile, writeFile, mkdir, rename, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeGeneratedFile } from './write-generated-file.mjs';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const workspace = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(
  await readFile(path.join(workspace, 'resources/ngspice-lock.json'), 'utf8'),
);
const root = path.join(workspace, 'resources/ngspice', String(lock.version));
const downloads = path.join(workspace, '.openpe/downloads');
const sourceRoot = path.join(workspace, 'resources/third-party-source');
const verify = process.argv.includes('--verify');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const matches = async (file, hash) =>
  digest(await readFile(file).catch(() => Buffer.alloc(0))) === hash;
async function artifact(item, destination) {
  if (await matches(destination, item.sha256)) return;
  if (verify)
    throw new Error(
      `Missing or changed bundled solver artifact: ${item.name}. Run npm run simulation:prepare.`,
    );
  const cache = path.join(downloads, item.name);
  let bytes;
  if (await matches(cache, item.sha256)) bytes = await readFile(cache);
  else {
    console.log(`Downloading ${item.name}`);
    const response = await fetch(item.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok || !response.body)
      throw new Error(`Download failed (${response.status}): ${item.name}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 80_000_000) throw new Error('Solver download exceeded 80 MB.');
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
    if (digest(bytes) !== item.sha256) throw new Error(`SHA-256 mismatch: ${item.name}`);
    await writeFile(cache + '.tmp', bytes);
    await rename(cache + '.tmp', cache);
  }
  if (destination !== cache) {
    await writeFile(destination + '.tmp', bytes);
    await rename(destination + '.tmp', destination);
  }
}
if (!verify) {
  await mkdir(downloads, { recursive: true });
  await mkdir(root, { recursive: true });
  await mkdir(sourceRoot, { recursive: true });
}
let valid = true;
for (const [name, hash] of Object.entries(lock.files))
  valid = (await matches(path.join(root, name), hash)) && valid;
if (!valid) {
  if (verify)
    throw new Error(
      'Bundled ngspice files are missing or changed. Run npm run simulation:prepare.',
    );
  const archive = path.join(downloads, lock.archive.name);
  await artifact(lock.archive, archive);
  const stage = await mkdtemp(path.join(downloads, 'ngspice-extract-'));
  try {
    // Use the project's locked packaging tool; no machine-installed archiver or shell.
    const extractor = require.resolve('electron-winstaller/vendor/7z-x64.exe');
    await exec(extractor, ['x', archive, `-o${stage}`, '-y', ...Object.keys(lock.files)], {
      windowsHide: true,
      timeout: 60000,
      maxBuffer: 1_000_000,
    });
    for (const [name, hash] of Object.entries(lock.files)) {
      const from = path.join(stage, name),
        to = path.join(root, name);
      if (!(await matches(from, hash)))
        throw new Error(`Extracted solver file failed verification: ${name}`);
      await mkdir(path.dirname(to), { recursive: true });
      await writeFile(to + '.tmp', await readFile(from));
      await rename(to + '.tmp', to);
    }
  } finally {
    if (path.dirname(path.resolve(stage)) !== path.resolve(downloads))
      throw new Error('Invalid staging path.');
    await rm(stage, { recursive: true, force: true });
  }
}
for (const item of lock.sources) await artifact(item, path.join(sourceRoot, item.name));
if (!verify) {
  await writeGeneratedFile(path.join(root, 'manifest.json'), JSON.stringify(lock, null, 2) + '\n');
  await writeGeneratedFile(
    path.join(root, 'SOURCE-NOTICE.txt'),
    'OpenPE bundles the unmodified official Windows x64 ngspice 47 console, code models and dependencies.\n' +
      'ngspice licensing and authors: Spice64/docs/COPYING and AUTHORS; combined dependency notices: About OpenPE > Third-party licenses > ngspice.\n' +
      'Complete corresponding source archives: resources/third-party-source/ngspice-47.tar.gz, libsndfile-1.2.2.tar.gz and libsamplerate-0.2.2.tar.gz. Follow their included build instructions; upstream Windows dependency configuration is documented in ngspice README.wavsim.\n' +
      'The solver and DLLs are replaceable under resources/ngspice/47/Spice64. Reverse engineering for debugging modifications to LGPL libraries is permitted. OpenPE never discovers a system solver or accepts renderer-supplied executables.\n',
  );
}
if (process.platform === 'win32' && process.arch === 'x64') {
  const { stdout } = await exec(
    path.join(root, 'Spice64/bin/ngspice_con.exe'),
    ['-n', '--version'],
    { windowsHide: true, timeout: 5000, maxBuffer: 64000 },
  );
  if (!stdout.includes(`ngspice-${lock.version}`))
    throw new Error('Bundled solver version mismatch.');
}
console.log(
  `Bundled ngspice ${lock.version}: runtime hashes, source archives and version verified.`,
);
