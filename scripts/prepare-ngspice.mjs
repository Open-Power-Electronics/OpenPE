import { readFile, writeFile, mkdir, rename, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeGeneratedFile } from './write-generated-file.mjs';
import { assertSolverPlatforms, hostSolverPlatform } from '../server/solver-platform.mjs';
import {
  assertLockedRelease,
  assertPinnedLocalArchive,
  downloadReleaseAsset,
  extractVerifiedArchive,
  parseSolverPrepareArgs,
} from './solver-release.mjs';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const workspace = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(
  await readFile(path.join(workspace, 'resources/ngspice-lock.json'), 'utf8'),
);
const platformId = hostSolverPlatform();
const platform = assertSolverPlatforms(lock.platforms);
if (lock.version !== 47 || typeof platform.executable !== 'string' || !platform.files)
  throw new Error(`Invalid ngspice lock for ${platformId}.`);
if (platformId === 'darwin-arm64') assertLockedRelease(platform.archive);
if (!Object.keys(platform.files).length)
  throw new Error(`ngspice lock has no ${platformId} file manifest.`);
const root = path.join(workspace, 'resources/ngspice', String(lock.version));
const downloads = path.join(workspace, '.openpe/downloads');
const sourceRoot = path.join(workspace, 'resources/third-party-source');
const prepareArgs = parseSolverPrepareArgs(
  process.argv,
  'Usage: node scripts/prepare-ngspice.mjs [--verify | --archive <path>]',
);
const verify = prepareArgs.verify;
const archivePath = prepareArgs.archive;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const matches = async (file, hash) =>
  digest(await readFile(file).catch(() => Buffer.alloc(0))) === hash;
const sources = [...lock.sources, ...(platform.sources ?? [])];
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
for (const item of sources) await artifact(item, path.join(sourceRoot, item.name));
let valid = true;
for (const [name, hash] of Object.entries(platform.files))
  valid = (await matches(path.join(root, name), hash)) && valid;
if (archivePath) {
  if (!platform.archive) throw new Error('This platform has no single pinned ngspice release archive.');
  await assertPinnedLocalArchive(archivePath, platform.archive);
}
if (!valid) {
  if (verify)
    throw new Error(
      'Bundled ngspice files are missing or changed. Run npm run simulation:prepare.',
    );
  if (platformId === 'win32-x64') {
    if (!platform.archive) throw new Error('Windows ngspice lock is missing its archive.');
    const archive = archivePath ?? path.join(downloads, platform.archive.name);
    if (!archivePath) await artifact(platform.archive, archive);
    const stage = await mkdtemp(path.join(downloads, 'ngspice-extract-'));
    try {
      // Use the project's locked packaging tool; no machine-installed archiver or shell.
      const extractor = require.resolve('electron-winstaller/vendor/7z-x64.exe');
      await exec(extractor, ['x', archive, `-o${stage}`, '-y', ...Object.keys(platform.files)], {
        windowsHide: true,
        timeout: 60000,
        maxBuffer: 1_000_000,
      });
      for (const [name, hash] of Object.entries(platform.files)) {
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
  } else if (platformId === 'darwin-arm64') {
    const archive = platform.archive;
    const cached = archivePath ?? path.join(downloads, archive.name);
    if (!archivePath)
      await downloadReleaseAsset({
        url: archive.url,
        sha256: archive.sha256,
        size: archive.size,
        file: cached,
      });
    await extractVerifiedArchive({ archive: cached, destination: root, files: platform.files });
  } else {
    throw new Error(`Unsupported OpenPE solver platform ${platformId}.`);
  }
}
if (!verify) {
  const notice =
    platformId === 'win32-x64'
      ? 'OpenPE bundles the unmodified official Windows x64 ngspice 47 console, code models and dependencies.\n' +
        'ngspice licensing and authors: Spice64/docs/COPYING and AUTHORS; combined dependency notices: About OpenPE > Third-party licenses > ngspice.\n' +
        'Complete corresponding source archives: resources/third-party-source/ngspice-47.tar.gz, libsndfile-1.2.2.tar.gz and libsamplerate-0.2.2.tar.gz. Follow their included build instructions; upstream Windows dependency configuration is documented in ngspice README.wavsim.\n' +
        'The solver and DLLs are replaceable under resources/ngspice/47/Spice64. Reverse engineering for debugging modifications to LGPL libraries is permitted. OpenPE never discovers a system solver or accepts renderer-supplied executables.\n'
      : 'OpenPE stages the ngspice 47 darwin-arm64 console from the pinned GitHub release archive.\n' +
        'npm run simulation:prepare downloads that archive, checks its SHA-256 and size, then checks every file hash. --archive installs the same pinned archive from a local file and does not download it. It does not compile.\n' +
        'Maintainers rebuild the archive with npm run solvers:build-macos. scripts/build-ngspice-macos.sh requires Apple clang 17.0.0, macOS SDK 26.2, deployment target 26.0 and the pinned ngspice 47, libsndfile 1.2.2, libsamplerate 0.2.2 and LLVM OpenMP 14.0.6 sources. That command is not part of ordinary setup.\n' +
        'The console matches the Windows feature set recorded from ngspice 47 visualc/config.h and vngspice.vcxproj: XSPICE code models, OSDI, OpenMP, CIDER, KLU, libsndfile and libsamplerate, without X11, readline or the separate fftw archive.\n' +
        'Code-model paths use the same Windows spinit (visualc/spinit_all). A pinned source patch resolves those paths from the executable directory because the process working directory is the job directory.\n' +
        'ngspice licensing and authors: Spice64/docs/COPYING and AUTHORS. Corresponding sources: resources/third-party-source/ngspice-47.tar.gz, libsndfile-1.2.2.tar.gz and libsamplerate-0.2.2.tar.gz. The OpenMP 14.0.6 source pin is in scripts/build-ngspice-macos.sh.\n' +
        'The solver and libraries are replaceable under resources/ngspice/47/Spice64. OpenPE never discovers a system solver or accepts renderer-supplied executables.\n';
  await writeGeneratedFile(path.join(root, 'manifest.json'), JSON.stringify(lock, null, 2) + '\n');
  await writeGeneratedFile(path.join(root, 'SOURCE-NOTICE.txt'), notice);
}
const executable = path.join(root, platform.executable);
if (platformId === 'win32-x64' || platformId === 'darwin-arm64') {
  const { stdout } = await exec(executable, ['-n', '--version'], {
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 64000,
  });
  if (!stdout.includes(`ngspice-${lock.version}`))
    throw new Error('Bundled solver version mismatch.');
}
console.log(
  `Bundled ngspice ${lock.version} (${platformId}): runtime hashes, source archives and version verified.`,
);
