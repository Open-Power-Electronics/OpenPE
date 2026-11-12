import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw new Error('macOS solver builds run only on darwin-arm64.');

const root = fileURLToPath(new URL('../', import.meta.url));
function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${args.at(-1) ?? command} exited with ${signal ?? code}.`));
    });
  });
}

await run('/bin/bash', ['scripts/build-ngspice-macos.sh']);
await run('/bin/bash', ['scripts/build-thermal-macos.sh']);
await run(process.execPath, ['scripts/pack-solver-archives.mjs']);
