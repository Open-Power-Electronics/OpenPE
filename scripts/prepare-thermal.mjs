import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { t as listTar } from 'tar';
import {
  assertSolverPlatforms,
  hostSolverPlatform,
  solverPlatforms,
} from '../server/solver-platform.mjs';
import {
  assertLockedRelease,
  assertPinnedLocalArchive,
  downloadReleaseAsset,
  extractVerifiedArchive,
  parseSolverPrepareArgs,
} from './solver-release.mjs';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const unzip = require('yauzl');
const workspace = fileURLToPath(new URL('../', import.meta.url));
const root = path.join(workspace, 'resources/thermal/1');
const downloads = path.join(workspace, '.openpe/downloads');
const publicNotice = path.join(workspace, 'public/licenses/thermal.txt');
const prepareArgs = parseSolverPrepareArgs(
  process.argv,
  'Usage: node scripts/prepare-thermal.mjs [--verify | --archive <path>]',
);
const verify = prepareArgs.verify;
const archivePath = prepareArgs.archive;
const lock = JSON.parse(
  await readFile(path.join(workspace, 'resources/thermal-lock.json'), 'utf8'),
);
const platformId = hostSolverPlatform();
const platform = assertSolverPlatforms(lock.platforms);
const runtimeFiles = platform.files;
const runtimeArchives = platform.archives ?? [];
const sources = [...(lock.sources ?? []), ...(platform.sources ?? [])];
const sourceFiles = platform.sourceFiles ?? [];
const sourceNotices = [...(lock.sourceNotices ?? []), ...(platform.sourceNotices ?? [])];
const hashPattern = /^[0-9a-f]{64}$/;
if (
  lock.version !== 1 ||
  lock.gmshVersion !== '4.15.2' ||
  lock.elmerVersion !== '26.1' ||
  !runtimeFiles ||
  !Object.keys(runtimeFiles).length ||
  sources.length < 2
)
  throw new Error(`Invalid pinned thermal resource lock for ${platformId}.`);
if (platformId === 'win32-x64' && runtimeArchives.length !== 2)
  throw new Error('Windows thermal lock does not contain its two runtime archives.');
if (platformId !== 'win32-x64') assertLockedRelease(platform.archive);

function relative(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\\') ||
    value.split('/').some((part) => !part || part === '.' || part === '..') ||
    path.isAbsolute(value) ||
    value.includes(':')
  )
    throw new Error('Invalid path in the thermal resource lock.');
  return value;
}
function contained(base, file) {
  const local = path.relative(path.resolve(base), path.resolve(file));
  if (!local || local.startsWith('..') || path.isAbsolute(local))
    throw new Error('Invalid thermal resource destination.');
  return file;
}
async function inspect(file) {
  contained(workspace, file);
  const parts = path.relative(workspace, file).split(path.sep);
  let current = workspace;
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const info = await lstat(current).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!info) return null;
    if (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile()))
      throw new Error(
        `Thermal resources must be regular files in real directories: ${path.relative(workspace, file)}.`,
      );
  }
  return lstat(file);
}
async function directory(file) {
  contained(workspace, file);
  let current = workspace;
  for (const part of path.relative(workspace, file).split(path.sep)) {
    current = path.join(current, part);
    await mkdir(current).catch((error) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Thermal resource directories cannot be links.');
  }
}
async function matches(file, hash, size) {
  if (!hashPattern.test(hash)) throw new Error('Invalid SHA-256 in the thermal resource lock.');
  const info = await inspect(file);
  if (!info || (size !== undefined && info.size !== size)) return false;
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest('hex') === hash;
}
async function atomic(file, bytes) {
  await inspect(file);
  await directory(path.dirname(file));
  const temp = contained(workspace, `${file}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, bytes, { flag: 'wx' });
    await rename(temp, file);
  } finally {
    await unlink(temp).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
async function copy(from, to) {
  await inspect(from);
  await inspect(to);
  await directory(path.dirname(to));
  const temp = contained(workspace, `${to}.${randomUUID()}.tmp`);
  try {
    await copyFile(from, temp);
    await rename(temp, to);
  } finally {
    await unlink(temp).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
async function windowsDownload(item, temporary, cache) {
  const curl = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'curl.exe');
  const options = [
    '--silent',
    '--show-error',
    '--fail',
    '--location',
    '--max-redirs',
    '5',
    '--proto',
    '=https',
    '--proto-redir',
    '=https',
    '--ssl-revoke-best-effort',
    '--retry',
    '2',
    '--max-time',
    '240',
  ];
  if (item.userAgent) options.push('--user-agent', item.userAgent);
  const request = (file, size, range) =>
    exec(
      curl,
      [
        ...options,
        '--max-filesize',
        String(size),
        ...(range ? ['--range', range] : []),
        '--output',
        file,
        item.url,
      ],
      { windowsHide: true, maxBuffer: 1000000 },
    );
  if (!item.ranges || item.size <= 2097152) {
    await request(temporary, item.size);
    return;
  }
  const partRoot = cache + '.parts';
  await directory(partRoot);
  const jobs = [];
  for (let start = 0; start < item.size; start += 1048576)
    jobs.push([start, Math.min(start + 1048576, item.size) - 1]);
  const fetchPart = async ([start, end]) => {
    const file = path.join(partRoot, String(start));
    const info = await inspect(file);
    if (!info || info.size !== end - start + 1)
      await request(file, end - start + 1, `${start}-${end}`);
    if ((await inspect(file))?.size !== end - start + 1)
      throw new Error('Thermal HTTP range length mismatch.');
  };
  // Probe before concurrency: a server ignoring Range must not create many full downloads.
  await fetchPart(jobs[0]);
  let next = 1,
    finished = 1;
  await Promise.all(
    Array.from({ length: Math.min(40, jobs.length - 1) }, async () => {
      for (;;) {
        const job = jobs[next++];
        if (!job) return;
        await fetchPart(job);
        if (++finished % 20 === 0 || finished === jobs.length)
          console.log(`${item.name}: ${finished}/${jobs.length} verified-size ranges.`);
      }
    }),
  );
  async function* contents() {
    for (const [start] of jobs) yield await readFile(path.join(partRoot, String(start)));
  }
  await pipeline(Readable.from(contents()), createWriteStream(temporary, { flags: 'wx' }));
}
async function download(item, file) {
  const url = new URL(item.url);
  if (
    url.protocol !== 'https:' ||
    !Number.isSafeInteger(item.size) ||
    item.size <= 0 ||
    item.size > 256000000 ||
    !hashPattern.test(item.sha256)
  )
    throw new Error('Invalid pinned thermal download.');
  if (verify)
    throw new Error(
      `Missing or changed thermal artifact ${item.name}. Run npm run thermal:prepare.`,
    );
  const cache = path.join(downloads, relative(item.name));
  if (!(await matches(cache, item.sha256, item.size))) {
    console.log(`Downloading pinned thermal artifact ${item.name} (${item.size} bytes).`);
    await directory(path.dirname(cache));
    const temporary = `${cache}.${randomUUID()}.tmp`;
    try {
      if (process.platform === 'win32') {
        // Native curl follows the system proxy. TLS verification remains enabled.
        await windowsDownload(item, temporary, cache);
      } else {
        let current = url,
          response;
        const allowed = (host) =>
          host === url.hostname ||
          host === 'release-assets.githubusercontent.com' ||
          host === 'objects.githubusercontent.com' ||
          host === 'codeload.github.com';
        for (let hop = 0; hop <= 5; hop++) {
          response = await fetch(current, {
            redirect: 'manual',
            signal: AbortSignal.timeout(240000),
            ...(item.userAgent ? { headers: { 'User-Agent': item.userAgent } } : {}),
          });
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const destination = new URL(response.headers.get('location') ?? '', current);
          await response.body?.cancel();
          if (hop === 5 || destination.protocol !== 'https:' || !allowed(destination.hostname))
            throw new Error('Unapproved thermal download redirect.');
          current = destination;
        }
        if (!response?.ok || !response.body)
          throw new Error(`Thermal download failed (${response?.status}).`);
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > item.size) throw new Error('Thermal download exceeds its pinned size.');
          chunks.push(chunk);
        }
        await writeFile(temporary, Buffer.concat(chunks), { flag: 'wx' });
      }
      if (!(await matches(temporary, item.sha256, item.size)))
        throw new Error(`Thermal download failed SHA-256/size verification: ${item.name}.`);
      await inspect(cache);
      await rename(temporary, cache);
    } finally {
      await unlink(temporary).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
  if (file !== cache) await copy(cache, file);
}

async function extractArchive(archive, wanted, stage) {
  const zip = await new Promise((resolve, reject) =>
    unzip.open(
      archive,
      {
        lazyEntries: true,
        autoClose: true,
        validateEntrySizes: true,
        strictFileNames: true,
      },
      (error, file) => (error ? reject(error) : resolve(file)),
    ),
  );
  await new Promise((resolve, reject) => {
    const found = new Set();
    let ended = false;
    const fail = (error) => {
      if (!ended) {
        ended = true;
        zip.close();
        reject(error);
      }
    };
    zip.on('error', fail);
    zip.on('entry', (entry) => {
      (async () => {
        const name = wanted.get(entry.fileName);
        if (name) {
          if (
            found.has(name) ||
            entry.uncompressedSize > 256000000 ||
            ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000
          )
            throw new Error('Invalid or duplicate pinned thermal ZIP entry.');
          const destination = contained(stage, path.join(stage, name));
          await directory(path.dirname(destination));
          const stream = await new Promise((yes, no) =>
            zip.openReadStream(entry, (error, input) => (error ? no(error) : yes(input))),
          );
          await pipeline(stream, createWriteStream(destination, { flags: 'wx' }));
          found.add(name);
        }
        zip.readEntry();
      })().catch(fail);
    });
    zip.on('end', () => {
      if (!ended) {
        ended = true;
        if (found.size !== wanted.size)
          reject(new Error('The pinned thermal archive is missing required runtime entries.'));
        else resolve();
      }
    });
    zip.readEntry();
  });
}

if (!verify) {
  await directory(downloads);
  await directory(root);
}
let runtimeValid = true;
for (const [name, hash] of Object.entries(runtimeFiles))
  runtimeValid = (await matches(path.join(root, relative(name)), hash)) && runtimeValid;
if (archivePath) {
  if (!platform.archive)
    throw new Error('This platform has no single pinned thermal release archive.');
  await assertPinnedLocalArchive(archivePath, platform.archive);
}
if (!runtimeValid) {
  if (verify)
    throw new Error(
      'Bundled thermal runtime files are missing or changed. Run npm run thermal:prepare.',
    );
  if (platformId === 'darwin-arm64' || platformId === 'linux-x64') {
    const archive = platform.archive;
    const cached = archivePath ?? path.join(downloads, relative(archive.name));
    if (!archivePath)
      await downloadReleaseAsset({
        url: archive.url,
        sha256: archive.sha256,
        size: archive.size,
        file: cached,
      });
    await extractVerifiedArchive({ archive: cached, destination: root, files: runtimeFiles });
  } else if (platformId === 'win32-x64') {
    for (const archive of runtimeArchives) {
      const namespace = archive.name.startsWith('gmsh-')
        ? 'gmsh'
        : archive.name.startsWith('ElmerFEM-')
          ? 'elmer'
          : null;
      if (!namespace || !archive.prefix?.endsWith('/'))
        throw new Error('Invalid thermal runtime archive mapping.');
      relative(archive.prefix.slice(0, -1));
      const files = Object.keys(runtimeFiles).filter((name) => name.startsWith(namespace + '/'));
      const archiveEntry = (name) =>
        archive.prefix +
        (name.startsWith('elmer/licenses/gcc/')
          ? 'stripped_gfortran/licenses/' + name.slice('elmer/licenses/gcc/'.length)
          : name.slice(namespace.length + 1));
      const cache = path.join(downloads, relative(archive.name));
      await download(archive, cache);
      const stage = await mkdtemp(path.join(downloads, 'thermal-extract-'));
      try {
        // The workspace's locked Node ZIP reader streams only allowlisted entries.
        await extractArchive(
          cache,
          new Map(files.map((name) => [archiveEntry(name), name])),
          stage,
        );
        for (const name of files) {
          const extracted = path.join(stage, name);
          if (!(await matches(extracted, runtimeFiles[name])))
            throw new Error(`Extracted thermal runtime file failed verification: ${name}.`);
          await copy(extracted, path.join(root, name));
        }
      } finally {
        if (
          path.dirname(path.resolve(stage)) !== path.resolve(downloads) ||
          !path.basename(stage).startsWith('thermal-extract-')
        )
          throw new Error('Refusing to remove an invalid thermal extraction directory.');
        await rm(stage, { recursive: true, force: true });
      }
    }
  } else {
    throw new Error(`Unsupported OpenPE solver platform ${platformId}.`);
  }
}
for (const item of [...sources, ...sourceFiles]) {
  const destination = path.join(root, 'sources', relative(item.name));
  if (!(await matches(destination, item.sha256, item.size))) await download(item, destination);
}

for (const item of sourceNotices) {
  relative(item.name);
  relative(item.archive);
  relative(item.entry);
  if (!sources.some((source) => source.name === item.archive))
    throw new Error('Unknown thermal source notice archive.');
  const file = path.join(root, 'licenses', item.name);
  if (!(await matches(file, item.sha256, item.size))) {
    if (verify)
      throw new Error(
        `Missing or changed thermal source notice ${item.name}. Run npm run thermal:prepare.`,
      );
    let found = false,
      failure = '',
      size = 0;
    const chunks = [];
    await listTar({
      file: path.join(root, 'sources', item.archive),
      onentry(entry) {
        if (entry.path !== item.entry) return;
        if (found || entry.type !== 'File' || item.size > 1000000) {
          failure = 'Invalid thermal source notice entry.';
          return;
        }
        found = true;
        entry.on('data', (chunk) => {
          size += chunk.length;
          if (size <= item.size) chunks.push(chunk);
        });
      },
    });
    const bytes = Buffer.concat(chunks);
    if (
      failure ||
      !found ||
      size !== item.size ||
      createHash('sha256').update(bytes).digest('hex') !== item.sha256
    )
      throw new Error(`Thermal source notice failed verification: ${item.name}. ${failure}`);
    await atomic(file, bytes);
  }
}

const noticeHeader =
  (platformId === 'win32-x64'
    ? `OpenPE Layout Thermal: bundled Gmsh ${lock.gmshVersion} and Elmer ${lock.elmerVersion} (Windows x64)\n\n` +
      'OpenPE invokes the unmodified, hash-pinned official executables as separate local processes.\n' +
      'The Elmer archive is the official rel26.1 release; its solver banner retains the upstream 9.0 (Rev: Release) label compiled on 2026-01-20.\n'
    : platformId === 'linux-x64'
      ? `OpenPE Layout Thermal: bundled Gmsh ${lock.gmshVersion} and Elmer ${lock.elmerVersion} (Linux x64, glibc 2.41+)\n\n` +
        'Maintainer build: npm run solvers:build-linux, with GCC/GFortran 14.2.0 and CMake 4.4.5.\n' +
        'Gmsh uses its official hash-pinned PyPI native library with the small scripts/gmsh-linux.c batch entry; the packaged application does not require Python.\n' +
        'Elmer uses -DWITH_MPI=OFF -DWITH_ELMERGUI=OFF -DWITH_OpenMP=OFF -DWITH_Mumps=OFF -DWITH_UMFPACK=ON and pinned OpenBLAS 0.3.13.\n' +
        'Solver, math and compiler ELF dependencies use relative $ORIGIN runpaths. glibc and graphics/font libraries are system prerequisites. Corresponding Debian GCC original sources and Debian patches are included.\n'
      : `OpenPE Layout Thermal: bundled Gmsh ${lock.gmshVersion} and Elmer ${lock.elmerVersion} (darwin-arm64)\n\n` +
        'npm run thermal:prepare downloads the pinned GitHub release archive, checks its SHA-256 and size, then checks every file hash. It does not compile.\n' +
        'Maintainers rebuild that archive with npm run solvers:build-macos. scripts/build-thermal-macos.sh requires Apple clang 17.0.0, macOS SDK 26.2, CMake 4.4.5 and Homebrew GCC 16.2.0. That command is not part of ordinary setup.\n' +
        'The Elmer configuration is -DWITH_MPI=OFF -DWITH_ELMERGUI=OFF -DWITH_OpenMP=OFF -DWITH_Mumps=OFF -DWITH_UMFPACK=ON. OpenBLAS 0.3.13 is built from the pinned tarball; Homebrew OpenBLAS is not linked.\n' +
        'Gmsh is the official 4.15.2 MacOSARM SDK. Its gmsh -info output reports OpenCASCADE 7.8.1. Absolute toolchain rpaths are removed; Mach-O dependencies stay inside the bundle or in the macOS system libraries.\n') +
  'Runtime files, upstream solver and identified dependency source archives, build materials and license notices ship under resources/thermal/1.\n' +
  'The source archives remain unmodified; the source hash and original HTTPS URL are recorded in thermal-lock.json and manifest.json.\n' +
  'Gmsh is GPL version 2 or later with its upstream linking exception. Elmer modules retain their GPL/LGPL and individual dependency licenses.\n' +
  'libgfortran is covered by the GCC Runtime Library Exception in COPYING.RUNTIME. The tools and libraries can be replaced and rebuilt; reverse engineering for debugging modifications to LGPL libraries is permitted.\n\n' +
  sources.map((item) => `${item.name}\n${item.url}\nSHA-256: ${item.sha256}\n`).join('\n') +
  (sourceFiles.length
    ? `\nThe ${sourceFiles.length} immutable MSYS2 GCC build-recipe and patch files are included individually under sources/${sourceFiles[0].name.split('/')[0]}. Their original commit URLs, Git blob identities and SHA-256 hashes are in the manifest.\n`
    : '');
let notice = noticeHeader;
for (const name of Object.keys(runtimeFiles).filter((name) =>
  /(?:LICENSE|COPYING|CREDITS)/.test(name),
))
  notice += `\n---------------- ${name} ----------------\n\n${await readFile(path.join(root, name), 'utf8')}\n`;
for (const item of sourceNotices)
  notice += `\n---------------- ${item.name} ----------------\n\n${await readFile(path.join(root, 'licenses', item.name), 'utf8')}\n`;
const sourceNotice =
  noticeHeader +
  (platformId === 'win32-x64'
    ? '\nBuild instructions (paths inside the source archives):\n' +
      'sources/gmsh-4.15.2-source.tgz: gmsh-4.15.2-source/README.txt, gmsh-4.15.2-source/CMakeLists.txt, gmsh-4.15.2-source/doc/texinfo/gmsh.texi.\n' +
      'sources/elmerfem-release-26.1.tar.gz: elmerfem-release-26.1/README.adoc, elmerfem-release-26.1/CMakeLists.txt, elmerfem-release-26.1/.github/workflows/build-windows-mingw.yaml.\n' +
      'Additional library source archives retain their upstream build scripts; the MSYS2 GCC source recipe and patches retain the fixed upstream commit. No archive scripts are executed by preparation.\n' +
      'The upstream packages use additional libraries under their own licenses. Original build configuration and third-party notices are retained in the source archives and runtime notice files.\n'
    : platformId === 'linux-x64'
      ? '\nLinux maintainer build: npm run solvers:build-linux runs scripts/build-thermal-linux.sh, then packs the release archive. GCC/GFortran 14.2.0, glibc 2.41, CMake 4.4.5 and SOURCE_DATE_EPOCH=1786424074. See the scripts and their source pins for rebuild instructions.\n'
      : '\nmacOS maintainer build: npm run solvers:build-macos runs scripts/build-thermal-macos.sh, then packs the release archive. Toolchain pins are Apple clang 17.0.0, macOS SDK 26.2, CMake 4.4.5 and Homebrew GCC 16.2.0. Deployment target is 26.0. SOURCE_DATE_EPOCH is 1786424074.\n' +
        'Gmsh is unpacked from the official SDK and is not rebuilt. Elmer and OpenBLAS build instructions also remain inside their source archives.\n');
const metadata = JSON.stringify(lock, null, 2) + '\n';
const noticeDirectory = path.join(workspace, 'resources/notices');
await directory(noticeDirectory);
const fragment = path.join(noticeDirectory, `thermal-${platformId}.txt`);
const fragments = await Promise.all(
  solverPlatforms.map(async (id) => {
    if (id === platformId) return notice;
    return readFile(path.join(noticeDirectory, `thermal-${id}.txt`), 'utf8');
  }),
);
const combined =
  `OpenPE Layout Thermal bundles Gmsh ${lock.gmshVersion} and Elmer ${lock.elmerVersion} for ${solverPlatforms.join(', ')}.\n` +
  'Each platform has its own hash manifest. An unknown or missing platform is an error.\n\n' +
  solverPlatforms.map((id, i) => `===== ${id} =====\n\n${fragments[i]}`).join('\n');
for (const [file, contents] of [
  [fragment, notice],
  [publicNotice, combined],
  [path.join(root, 'LICENSE-NOTICE.txt'), notice],
  [path.join(root, 'SOURCE-NOTICE.txt'), sourceNotice],
  [path.join(root, 'manifest.json'), metadata],
  [path.join(root, 'thermal-lock.json'), metadata],
]) {
  // Unchanged notices and manifests retain their file identities and timestamps.
  if ((await inspect(file)) && (await readFile(file, 'utf8')) === contents) continue;
  if (verify)
    throw new Error(
      `Missing or changed thermal notice/manifest: ${path.relative(workspace, file)}. Run npm run thermal:prepare.`,
    );
  await atomic(file, contents);
}
console.log(
  `Bundled Gmsh ${lock.gmshVersion} and Elmer ${lock.elmerVersion}: runtime hashes, source archives, notices and manifests verified${verify ? ' offline' : ''}.`,
);
