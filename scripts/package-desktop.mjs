import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const platform = process.platform;
const arch = process.arch;
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

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${args.at(-1)} exited with ${signal ?? code}.`));
    });
  });
}

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
await run(['scripts/brand-assets.mjs']);
await run(['scripts/build.mjs']);
await run(['node_modules/electron-builder/cli.js', ...target]);
await run(['scripts/check-packaged-modules.mjs']);
