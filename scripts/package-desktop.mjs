import { spawn } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const platform = process.platform;
const arch = process.arch;
const root = fileURLToPath(new URL('../', import.meta.url));

function run(args, executable = process.execPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${args.at(-1)} exited with ${signal ?? code}.`));
    });
  });
}

export async function verifyMacPackage(appPath) {
  if (platform !== 'darwin' || arch !== 'arm64')
    throw new Error('Packaged macOS verification requires macOS arm64.');
  const { sha256File, solverEntryPath } = await import('./solver-release.mjs');
  const { assertSolverPlatforms } = await import('../server/solver-platform.mjs');
  const app = await realpath(appPath);
  const resources = path.join(app, 'Contents', 'Resources');
  for (const solver of ['ngspice', 'thermal']) {
    const lockPath = path.join(root, 'resources', `${solver}-lock.json`);
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    const { files } = assertSolverPlatforms(lock.platforms);
    if (!Number.isSafeInteger(lock.version) || lock.version < 1 || !Object.keys(files ?? {}).length)
      throw new Error(`Invalid ${solver} darwin-arm64 lock.`);
    const directory = path.join(resources, solver, String(lock.version));
    for (const [name, expected] of Object.entries(files)) {
      const file = path.join(directory, solverEntryPath(name));
      if (!(await lstat(file)).isFile() || (await realpath(file)) !== file)
        throw new Error(`Packaged solver file must be a regular file without links: ${file}`);
      if ((await sha256File(file))?.sha256 !== expected)
        throw new Error(`Packaged solver file does not match ${solver}-lock.json: ${name}`);
    }
    console.log(
      `Packaged ${solver} darwin-arm64 hashes verified (${Object.keys(files).length} files).`,
    );
  }
  await run(['--verify', '--deep', '--strict', app], '/usr/bin/codesign');
  console.log(`macOS bundle signature verified: ${app}`);
}

const isDirect =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  const target =
    platform === 'win32' && arch === 'x64'
      ? ['--win', 'dir', 'nsis']
      : platform === 'darwin' && arch === 'arm64'
        ? ['--mac', 'dir', 'dmg']
        : platform === 'linux' && arch === 'x64'
          ? ['--linux', 'dir', 'AppImage', 'deb']
          : null;
  if (!target)
    throw new Error(
      `Unsupported package host ${platform} ${arch}. OpenPE packages Windows x64, macOS arm64 and Linux x64.`,
    );
  if (platform === 'linux') process.umask(0o022);
  process.chdir(root);
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  await run(['scripts/brand-assets.mjs']);
  await run(['scripts/build.mjs']);
  await run(['node_modules/electron-builder/cli.js', ...target, '--publish', 'never']);
  if (platform === 'darwin') {
    const { packagedHost } = await import('./check-packaged-modules.mjs');
    await verifyMacPackage(path.join(packagedHost().resources, '..', '..'));
  }
  await run(['scripts/check-packaged-modules.mjs']);
}
